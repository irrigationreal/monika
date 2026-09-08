import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_ATTACHMENT_BYTES, UPLOADS_DIR } from '../runtimeConfig';

import type { CloneOperation } from '@irrigationreal/codex-forum-core';

import type { ForumStore } from '../store';

const RETRY_MS = 10_000;
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1_000;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function agentErrorCode(error: unknown): string | null {
  const details = error && typeof error === 'object' ? (error as { details?: unknown }).details : null;
  const code = details && typeof details === 'object' ? (details as { error?: unknown }).error : null;
  return typeof code === 'string' ? code : null;
}

function definitive(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  if (status === 408 || status === 425 || status === 429) return false;
  const code = agentErrorCode(error);
  if (code === 'conversation_busy' || code === 'clone_in_progress' || code === 'clone_manual_recovery') return false;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export class CloneConflictError extends Error {}
export class CloneNotFoundError extends Error {}
export class CloneUnavailableError extends Error {}

export class CloneService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing: Promise<void> | null = null;
  private stopped = true;
  private cleanupPending = true;
  private readonly enqueueing = new Map<string, Promise<CloneOperation>>();

  constructor(
    private readonly store: ForumStore,
    private readonly agent: {
      getTopicCloneSnapshot(topicId: string): Promise<{ leaf_entry_id: string | null; active_entry_ids: string[] }>;
      cloneTopicConversation(
        topicId: string,
        input: { operationId: string; expectedLeafId: string }
      ): Promise<{
        child_session_id: string;
        child_session_path: string;
        inherited_generation: number;
        active_entry_ids: string[];
      }>;
      acknowledgeClone(operationId: string, childSessionId: string): Promise<void>;
    },
    private readonly opts: {
      intervalMs?: number;
      uploadsDir?: string;
      refresh?: (topicId: string) => Promise<void>;
    } = {}
  ) {}

  start(): number {
    if (this.timer) return 0;
    this.stopped = false;
    const recovered = this.store.requeueRunningCloneOperations();
    this.timer = setInterval(() => this.wake(), this.opts.intervalMs ?? 2_000);
    this.timer.unref?.();
    this.wake();
    return recovered;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.processing;
  }
  async waitForIdle(): Promise<void> {
    await this.processing;
  }
  wake(): void {
    if (this.stopped || !this.timer || this.processing) return;
    this.processing = this.processDue().finally(() => {
      this.processing = null;
    });
  }
  state(topicId: string): { active: CloneOperation | null; latest: CloneOperation | null } {
    return { active: this.store.getActiveCloneOperation(topicId), latest: this.store.getLatestCloneOperation(topicId) };
  }
  get(topicId: string, operationId: string): CloneOperation {
    const operation = this.store.getCloneOperation(operationId);
    if (!operation || operation.sourceTopicId !== topicId) throw new CloneNotFoundError('Clone operation not found');
    return operation;
  }
  private prestageRoot(): string {
    return join(this.opts.uploadsDir ?? UPLOADS_DIR, 'clone-prestage');
  }

  private async snapshot(topicId: string) {
    try {
      if (this.opts.refresh) await this.opts.refresh(topicId);
      const canonical = await this.agent.getTopicCloneSnapshot(topicId);
      if (
        !canonical.leaf_entry_id ||
        !Array.isArray(canonical.active_entry_ids) ||
        !canonical.active_entry_ids.every((id) => typeof id === 'string') ||
        canonical.active_entry_ids.at(-1) !== canonical.leaf_entry_id
      )
        throw new Error('Agent runtime returned an invalid clone snapshot');
      return { canonical, projection: this.store.buildCloneProjectionSnapshot(topicId, canonical.active_entry_ids) };
    } catch (error) {
      if (error instanceof CloneConflictError) throw error;
      throw new CloneUnavailableError(
        error instanceof Error ? error.message : 'Canonical clone snapshot is unavailable'
      );
    }
  }

  async enqueue(input: {
    operationId: string;
    topicId: string;
    initiatedBy: string;
    title: string;
  }): Promise<CloneOperation> {
    const active = this.enqueueing.get(input.operationId);
    if (active) {
      await active.catch(() => undefined);
      return this.enqueue(input);
    }
    const operation = this.enqueueOnce(input);
    this.enqueueing.set(input.operationId, operation);
    try {
      return await operation;
    } finally {
      if (this.enqueueing.get(input.operationId) === operation) this.enqueueing.delete(input.operationId);
    }
  }

  private async enqueueOnce(input: {
    operationId: string;
    topicId: string;
    initiatedBy: string;
    title: string;
  }): Promise<CloneOperation> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)) throw new CloneConflictError('Invalid clone operation id');
    const title = input.title.trim();
    const existing = this.store.getCloneOperation(input.operationId);
    if (existing) {
      if (
        existing.sourceTopicId !== input.topicId ||
        existing.initiatedBy !== input.initiatedBy ||
        existing.title !== title
      )
        throw new CloneConflictError('operationId is already used by another clone request');
      if (existing.status === 'pending' || existing.status === 'running') this.wake();
      return existing;
    }
    const releaseAdmission = this.store.beginRobotWork();
    try {
      const { canonical, projection } = await this.snapshot(input.topicId);
      const expectedLeafId = canonical.leaf_entry_id;
      if (!expectedLeafId) throw new CloneConflictError('Linked canonical Pi session leaf is unavailable');
      const session = this.store.getSessionByTopic(input.topicId);
      const link = this.store.getPiSessionLinkByTopic(input.topicId);
      if (!session || !link) throw new CloneConflictError('Linked canonical Pi session is unavailable');
      const stageRoot = join(this.prestageRoot(), input.operationId);
      const prestaged = [] as Array<{
        sourcePostId: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
        storagePath: string;
        sha256: string | null;
      }>;
      try {
        await mkdir(stageRoot, { recursive: true });
        const info = await lstat(stageRoot);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new CloneConflictError('Clone attachment prestage path is unsafe');
        for (const sourcePost of projection.posts) {
          for (const attachment of sourcePost.attachments) {
            const source = await stat(attachment.storagePath);
            if (
              !source.isFile() ||
              source.size !== attachment.sizeBytes ||
              source.size < 0 ||
              source.size > MAX_ATTACHMENT_BYTES
            )
              throw new CloneConflictError('Clone attachment size validation failed');
            const sourceSha = await sha256File(attachment.storagePath);
            if (attachment.sha256 && attachment.sha256 !== sourceSha)
              throw new CloneConflictError('Clone attachment source hash validation failed');
            const destination = join(
              stageRoot,
              `${attachment.id}-${attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
            );
            await copyFile(attachment.storagePath, destination);
            const copied = await stat(destination);
            if (copied.size !== source.size || (await sha256File(destination)) !== sourceSha)
              throw new CloneConflictError('Clone attachment integrity validation failed');
            prestaged.push({
              sourcePostId: sourcePost.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              sizeBytes: copied.size,
              storagePath: destination,
              sha256: sourceSha,
            });
          }
        }
        const current = this.store.buildCloneProjectionSnapshot(input.topicId, canonical.active_entry_ids);
        if (JSON.stringify(current) !== JSON.stringify(projection))
          throw new CloneConflictError('Source topic changed while clone attachments were being prestaged');
        const operation = this.store.enqueueCloneOperation({
          id: input.operationId,
          sourceTopicId: input.topicId,
          sourceSessionId: session.id,
          sourcePiSessionId: link.pi_session_id,
          sourcePiSessionPath: link.pi_session_path,
          expectedLeafId,
          initiatedBy: input.initiatedBy,
          title,
          sourceSnapshot: projection,
          prestagedAttachments: prestaged,
        });
        this.wake();
        return operation;
      } catch (error) {
        await rm(stageRoot, { recursive: true, force: true });
        if (error instanceof Error && error.message === 'clone_conflict')
          throw new CloneConflictError('Topic must be open and idle with no unresolved operation or dispatch');
        if (error instanceof Error && error.message === 'clone_operation_mismatch')
          throw new CloneConflictError('operationId is already used by another clone request');
        throw error;
      }
    } finally {
      releaseAdmission();
    }
  }

  private async finalizeAttachments(id: string): Promise<void> {
    const stageRoot = join(this.prestageRoot(), id);
    const finalRoot = join(this.opts.uploadsDir ?? UPLOADS_DIR, 'clone-attachments', id);
    let staged = true;
    try {
      await lstat(stageRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') staged = false;
      else throw error;
    }
    if (staged) {
      await mkdir(join(this.opts.uploadsDir ?? UPLOADS_DIR, 'clone-attachments'), { recursive: true });
      await rename(stageRoot, finalRoot);
    } else await lstat(finalRoot);
    this.store.finalizeCloneAttachmentPaths(id, stageRoot, finalRoot);
    await rm(stageRoot, { recursive: true, force: true });
  }

  private async cleanup(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.prestageRoot());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names.slice(0, 100)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(name) || this.store.getCloneOperation(name)) continue;
      const candidate = join(this.prestageRoot(), name);
      const info = await lstat(candidate);
      if (info.isDirectory() && !info.isSymbolicLink() && Date.now() - info.mtimeMs >= ORPHAN_MIN_AGE_MS)
        await rm(candidate, { recursive: true, force: true });
    }
  }

  private async processDue(): Promise<void> {
    if (this.cleanupPending) {
      this.cleanupPending = false;
      await this.cleanup();
    }
    while (!this.stopped) {
      const row = this.store.listPendingCloneOperationRows(1)[0];
      if (!row) return;
      const claimed = this.store.claimCloneOperation(row.id);
      if (!claimed) continue;
      try {
        const result = claimed.agent_result_json
          ? (JSON.parse(claimed.agent_result_json) as {
              child_session_id: string;
              child_session_path: string;
              inherited_generation: number;
              active_entry_ids: string[];
            })
          : await this.agent.cloneTopicConversation(claimed.source_topic_id, {
              operationId: claimed.id,
              expectedLeafId: claimed.expected_leaf_id,
            });
        this.store.materializeCloneOperation(claimed.id, result);
        await this.finalizeAttachments(claimed.id);
        await this.agent.acknowledgeClone(claimed.id, result.child_session_id);
        this.store.completeCloneOperation(claimed.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const materialized = Boolean(this.store.getCloneOperation(claimed.id)?.childTopicId);
        if (agentErrorCode(error) === 'clone_manual_recovery')
          this.store.markCloneNeedsManualReview(claimed.id, message);
        else if (!materialized && definitive(error)) {
          await rm(join(this.prestageRoot(), claimed.id), { recursive: true, force: true });
          this.store.failCloneOperation(claimed.id, message);
        } else this.store.requeueCloneOperation(claimed.id, message, new Date(Date.now() + RETRY_MS).toISOString());
      }
    }
  }
}
