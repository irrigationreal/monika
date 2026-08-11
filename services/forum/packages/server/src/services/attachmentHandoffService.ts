import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

import { MAX_ATTACHMENT_BYTES } from '../runtimeConfig';

import type { AssistantProjectionRow, AttachmentHandoffRow, PendingAttachmentRow } from '../db';
import type { ForumStore } from '../store';

const RETRY_MS = [10_000, 30_000, 120_000, 300_000];
const DEFAULT_LEASE_MS = 5 * 60_000;

// Multiple service instances can exist in tests or during in-process rewiring.
// Fence their active claims from lease recovery just as activeWork fences
// overlapping due passes within one instance.
const activeAttachmentClaimTokens = new Set<string>();
const activeCompletionClaimTokens = new Set<string>();

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function noFollowBytes(file: string): Buffer {
  const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error('terminal: legacy artifact source is not a regular file');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class AttachmentHandoffService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeWork: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly store: ForumStore,
    private readonly opts: {
      intervalMs?: number;
      leaseMs?: number;
      uploadsDir?: string;
      onProjectionFinalized?: (projection: AssistantProjectionRow, payload: Record<string, unknown>) => Promise<void>;
      resolveArtifact?: (input: { path: string; filename?: string | null; mimeType?: string | null }) => Promise<{
        filename: string; mimeType: string; sizeBytes: number; sha256: string; dataBase64: string;
      }>;
    } = {}
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const run = () => void this.processDue().catch((error: unknown) => {
      console.error('[attachments] background handoff recovery failed:', error instanceof Error ? error.message : error);
    });
    this.timer = setInterval(run, this.opts.intervalMs ?? 2_000);
    this.timer.unref();
    run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activeWork) await this.activeWork;
  }

  async recover(): Promise<void> {
    for (const projection of this.store.listIncompleteAssistantProjections()) {
      try {
        await this.processProjection(projection.id);
      } catch (error) {
        console.error(
          `[attachments] projection recovery failed projectionId=${projection.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    try {
      await this.processDue();
    } catch (error) {
      console.error('[attachments] due recovery pass failed:', error instanceof Error ? error.message : error);
    }
  }

  async processProjection(projectionId: string): Promise<void> {
    const rows = this.store.listAttachmentHandoffsForProjection(projectionId);
    for (const row of rows) {
      if (row.status === 'linked' || row.status === 'needs_manual_review') continue;
      const claimed = this.store.claimAttachmentHandoff(row.id);
      if (claimed) await this.processClaim(claimed);
    }
    await this.finalizeReadyProjections();
    await this.deliverPendingCompletions();
  }

  async processDue(): Promise<void> {
    if (this.activeWork) return this.activeWork;
    const work = this.runDue();
    this.activeWork = work;
    try {
      await work;
    } finally {
      if (this.activeWork === work) this.activeWork = null;
    }
  }

  private async runDue(): Promise<void> {
    if (this.stopping) return;
    const staleBefore = new Date(Date.now() - (this.opts.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
    this.store.reclaimStaleAttachmentHandoffs(staleBefore, [...activeAttachmentClaimTokens]);
    this.store.reclaimStaleAssistantProjectionCompletions(staleBefore, [...activeCompletionClaimTokens]);
    for (const row of this.store.listDueAttachmentHandoffs()) {
      const claimed = this.store.claimAttachmentHandoff(row.id);
      if (claimed) await this.processClaim(claimed);
    }
    await this.finalizeReadyProjections();
    await this.deliverPendingCompletions();
  }

  /**
   * Drains ready projections in durable rowid order. finalizeAssistantProjection
   * repeats the predecessor check in its write transaction, so concurrent live
   * and recovery calls cannot publish a later post around an earlier retry.
   */
  private async finalizeReadyProjections(): Promise<void> {
    for (const projection of this.store.listIncompleteAssistantProjections()) {
      this.store.finalizeAssistantProjection(projection.id);
    }
  }

  private async deliverPendingCompletions(): Promise<void> {
    if (!this.opts.onProjectionFinalized) return;
    // Re-scan after every awaited callback so a projection created concurrently
    // with that callback is picked up by the same drain. The transactional claim
    // refuses to pass an earlier pending/in-flight callback in the same session.
    while (true) {
      const pending = this.store.listPendingAssistantProjectionCompletions();
      let delivered = false;
      for (const projection of pending) {
        if (await this.deliverCompletion(projection)) {
          delivered = true;
          break;
        }
      }
      if (!delivered) return;
    }
  }

  private async deliverCompletion(projection: AssistantProjectionRow): Promise<boolean> {
    if (!this.opts.onProjectionFinalized || !projection.completion_payload_json) return false;
    const claimed = this.store.claimAssistantProjectionCompletion(projection.id);
    const token = claimed?.completion_claim_token;
    if (!claimed || !token || !claimed.completion_payload_json) return false;
    activeCompletionClaimTokens.add(token);
    try {
      const payload = object(JSON.parse(claimed.completion_payload_json));
      await this.opts.onProjectionFinalized(claimed, payload);
      this.store.completeAssistantProjectionCompletion(claimed.id, token);
      return true;
    } catch (error) {
      this.store.releaseAssistantProjectionCompletion(claimed.id, token);
      throw error;
    } finally {
      activeCompletionClaimTokens.delete(token);
    }
  }

  private async processClaim(handoff: AttachmentHandoffRow): Promise<void> {
    const token = handoff.claim_token;
    if (!token) return;
    activeAttachmentClaimTokens.add(token);
    try {
      try {
        const projection = this.store.getAssistantProjectionById(handoff.projection_id);
        if (!projection) throw new Error('terminal: assistant projection is missing');
        const ref = object(JSON.parse(handoff.source_ref_json));
        let pending: PendingAttachmentRow | null;
        if (handoff.source_kind === 'legacy-artifact') {
          pending = await this.stageLegacyArtifact(ref, projection.topic_id);
        } else {
          const pendingId = string(ref['pendingAttachmentId'] ?? ref['pending_attachment_id'] ?? ref['id']);
          if (!pendingId) throw new Error('terminal: pending attachment reference is malformed');
          pending = this.store.getPendingAttachment(pendingId);
        }
        if (!pending) throw new Error('terminal: pending attachment source is missing');
        if (pending.topic_id !== projection.topic_id) throw new Error('terminal: attachment topic does not match projection');
        if (Date.parse(pending.expires_at) <= Date.now()) throw new Error('terminal: pending attachment has expired');
        if (pending.size_bytes <= 0 || pending.size_bytes > MAX_ATTACHMENT_BYTES) throw new Error('terminal: attachment size is outside configured limits');
        if (!existsSync(pending.storage_path)) throw new Error('terminal: pending attachment bytes are missing');
        const bytes = noFollowBytes(pending.storage_path);
        const actualSize = bytes.length;
        if (actualSize !== pending.size_bytes || (handoff.expected_size_bytes != null && actualSize !== handoff.expected_size_bytes)) {
          throw new Error('terminal: attachment size mismatch');
        }
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        const expectedHash = handoff.expected_sha256 ?? pending.sha256;
        if (!expectedHash || actualHash !== expectedHash) throw new Error('terminal: attachment SHA-256 mismatch');
        this.store.completeAttachmentHandoff(handoff.id, token, { ...pending, sha256: actualHash });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const terminal = message.startsWith('terminal:') || handoff.attempt_count >= RETRY_MS.length + 1;
        const delay = RETRY_MS[Math.min(Math.max(handoff.attempt_count - 1, 0), RETRY_MS.length - 1)] ?? 300_000;
        this.store.failAttachmentHandoff(handoff.id, token, message, {
          terminal,
          retryAt: terminal ? null : new Date(Date.now() + delay).toISOString(),
        });
      }
    } finally {
      activeAttachmentClaimTokens.delete(token);
    }
  }

  private async stageLegacyArtifact(ref: Record<string, unknown>, topicId: string): Promise<PendingAttachmentRow> {
    const source = string(ref['path']);
    if (!source) throw new Error('terminal: legacy artifact path is missing');
    const uploadsDir = this.opts.uploadsDir;
    if (!uploadsDir || !this.opts.resolveArtifact) throw new Error('legacy artifact staging is not configured');

    // Forum never opens a model-supplied artifact pathname. Agentd owns path
    // confinement and returns bytes read from its validated descriptor.
    const requestedFilename = string(ref['filename']) ?? basename(source);
    const requestedMimeType = string(ref['mimeType'] ?? ref['mime_type']) ?? 'application/octet-stream';
    const resolvedArtifact = await this.opts.resolveArtifact({
      path: source,
      filename: requestedFilename,
      mimeType: requestedMimeType,
    });
    const filename = resolvedArtifact.filename.replace(/[\r\n"]/g, '');
    const mimeType = resolvedArtifact.mimeType;
    const ext = extname(filename);
    const storagePath = join(uploadsDir, `artifact_${randomUUID()}${ext}`);
    const resolvedBytes = Buffer.from(resolvedArtifact.dataBase64, 'base64');
    writeFileSync(storagePath, resolvedBytes, { flag: 'wx' });
    const bytes = noFollowBytes(storagePath);
    if (bytes.length !== resolvedArtifact.sizeBytes) throw new Error('terminal: resolved legacy artifact size mismatch');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (resolvedArtifact.sha256 !== sha256) throw new Error('terminal: resolved legacy artifact SHA-256 mismatch');
    return this.store.createPendingAttachment({
      topicId,
      filename,
      mimeType,
      sizeBytes: bytes.length,
      storagePath,
      sha256,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });
  }
}
