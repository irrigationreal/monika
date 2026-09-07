import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_ATTACHMENT_BYTES, UPLOADS_DIR } from '../runtimeConfig';

import type { ForkBoundary, ForkOperation } from '@irrigationreal/codex-forum-core';

import type { ForumStore } from '../store';

const RETRY_MS = 10_000;
const ORPHAN_PRESTAGE_MIN_AGE_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_PRESTAGE_SCAN_LIMIT = 100;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function agentErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const code = (details as { error?: unknown }).error;
  return typeof code === 'string' ? code : null;
}

function definitive(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown };
  if (value.status === 408 || value.status === 425 || value.status === 429) return false;
  const code = agentErrorCode(error);
  if (code === 'conversation_busy' || code === 'fork_in_progress' || code === 'fork_manual_recovery') return false;
  return typeof value.status === 'number' && value.status >= 400 && value.status < 500;
}

function forkFailureMessage(error: unknown): string {
  switch (agentErrorCode(error)) {
    case 'stale_leaf':
      return 'The source conversation changed after this fork was accepted. Reopen Fork and submit a new request.';
    case 'invalid_boundary':
      return 'The selected post is no longer an eligible canonical fork point. Reopen Fork and choose again.';
    case 'operation_mismatch':
      return 'This fork request identifier is already bound to different canonical source data.';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

export class ForkBoundariesUnavailableError extends Error {}
export class ForkConflictError extends Error {}
export class ForkNotFoundError extends Error {}

export class ForkService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing: Promise<void> | null = null;
  private stopped = true;
  private cleanupPending = true;

  constructor(
    private readonly store: ForumStore,
    private readonly agent: {
      getTopicForkBoundarySnapshot(topicId: string): Promise<{
        leaf_entry_id: string | null;
        active_entry_ids: string[];
        eligible_boundary_entry_ids: string[];
      }>;
      forkTopicConversation(
        topicId: string,
        input: { operationId: string; expectedLeafId: string; boundaryEntryId: string }
      ): Promise<{
        child_session_id: string;
        child_session_path: string;
        inherited_generation: number;
        active_entry_ids: string[];
      }>;
      acknowledgeFork(operationId: string, childSessionId: string): Promise<void>;
    },
    private readonly dispatcher: { wake(): void },
    private readonly opts: {
      intervalMs?: number;
      uploadsDir?: string;
      refreshBoundaries?: (topicId: string) => Promise<void>;
    } = {}
  ) {}

  start(): number {
    if (this.timer) return 0;
    this.stopped = false;
    const recovered = this.store.requeueRunningForkOperations();
    this.timer = setInterval(() => this.wake(), this.opts.intervalMs ?? 2_000);
    this.timer.unref?.();
    this.wake();
    return recovered;
  }

  async waitForIdle(): Promise<void> {
    await this.processing;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.processing;
  }

  wake(): void {
    if (this.stopped || !this.timer || this.processing) return;
    this.processing = this.processDue().finally(() => {
      this.processing = null;
    });
  }

  private async canonicalBoundarySnapshot(
    topicId: string
  ): Promise<{ leafEntryId: string | null; boundaries: ForkBoundary[] }> {
    try {
      if (this.opts.refreshBoundaries) await this.opts.refreshBoundaries(topicId);
      const snapshot = await this.agent.getTopicForkBoundarySnapshot(topicId);
      if (
        !Array.isArray(snapshot.active_entry_ids) ||
        !snapshot.active_entry_ids.every((entryId) => typeof entryId === 'string') ||
        !Array.isArray(snapshot.eligible_boundary_entry_ids) ||
        !snapshot.eligible_boundary_entry_ids.every((entryId) => typeof entryId === 'string') ||
        !(
          (typeof snapshot.leaf_entry_id === 'string' && snapshot.leaf_entry_id) ||
          (snapshot.leaf_entry_id === null &&
            snapshot.active_entry_ids.length === 0 &&
            snapshot.eligible_boundary_entry_ids.length === 0)
        )
      )
        throw new Error('Agent runtime returned an invalid fork-boundary snapshot');
      return {
        leafEntryId: snapshot.leaf_entry_id,
        boundaries: this.store.listEligibleForkBoundaries(topicId, {
          activeEntryIds: snapshot.active_entry_ids,
          eligibleBoundaryEntryIds: new Set(snapshot.eligible_boundary_entry_ids),
        }),
      };
    } catch (error) {
      console.warn(
        `[fork] canonical boundary snapshot unavailable for topic ${topicId}:`,
        error instanceof Error ? error.message : error
      );
      throw new ForkBoundariesUnavailableError(
        'Canonical fork boundaries are temporarily unavailable. Try reopening Fork.'
      );
    }
  }

  async boundaries(topicId: string): Promise<ForkBoundary[]> {
    return (await this.canonicalBoundarySnapshot(topicId)).boundaries;
  }
  get(topicId: string, operationId: string): ForkOperation {
    const operation = this.store.getForkOperation(operationId);
    if (!operation || operation.sourceTopicId !== topicId) throw new ForkNotFoundError('Fork operation not found');
    return operation;
  }

  state(topicId: string): { active: ForkOperation | null; latest: ForkOperation | null } {
    return {
      active: this.store.getActiveForkOperation(topicId),
      latest: this.store.getLatestForkOperation(topicId),
    };
  }

  private prestageRoot(): string {
    return join(this.opts.uploadsDir ?? UPLOADS_DIR, 'fork-prestage');
  }

  private async cleanupOrphanPrestages(): Promise<void> {
    const root = this.prestageRoot();
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const now = Date.now();
    for (const name of names.slice(0, ORPHAN_PRESTAGE_SCAN_LIMIT)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(name) || this.store.getForkOperation(name)) continue;
      const candidate = join(root, name);
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < ORPHAN_PRESTAGE_MIN_AGE_MS) continue;
      await rm(candidate, { recursive: true, force: true });
    }
  }

  private async finalizePrestagedAttachments(operationId: string): Promise<void> {
    const stageRoot = join(this.prestageRoot(), operationId);
    const finalRoot = join(this.opts.uploadsDir ?? UPLOADS_DIR, 'fork-attachments', operationId);
    let stageExists = true;
    try {
      await lstat(stageRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') stageExists = false;
      else throw error;
    }
    if (stageExists) {
      await mkdir(join(this.opts.uploadsDir ?? UPLOADS_DIR, 'fork-attachments'), { recursive: true });
      try {
        await rename(stageRoot, finalRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new Error('Fork attachment finalization found conflicting durable storage');
      }
    } else {
      // A crash may have happened after the atomic directory rename but before
      // SQLite paths were updated. Only this operation's deterministic target
      // is eligible for adoption.
      await lstat(finalRoot);
    }
    this.store.finalizeForkAttachmentPaths(operationId, stageRoot, finalRoot);
    await rm(stageRoot, { recursive: true, force: true });
  }

  async enqueue(input: {
    operationId: string;
    topicId: string;
    boundaryPostId: string;
    initiatedBy: string;
    title: string;
    openingBody: string;
  }): Promise<ForkOperation> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)) throw new ForkConflictError('Invalid fork operation id');
    const existing = this.store.getForkOperation(input.operationId);
    if (existing) {
      if (
        existing.sourceTopicId !== input.topicId ||
        existing.boundaryPostId !== input.boundaryPostId ||
        existing.initiatedBy !== input.initiatedBy ||
        existing.title !== input.title.trim() ||
        existing.openingBody !== input.openingBody.trim()
      )
        throw new ForkConflictError('operationId is already used by another fork request');
      if (existing.status === 'pending' || existing.status === 'running') this.wake();
      return existing;
    }

    const releaseAdmission = this.store.beginRobotWork();
    try {
      const canonicalSnapshot = await this.canonicalBoundarySnapshot(input.topicId);
      const boundary = canonicalSnapshot.boundaries.find((candidate) => candidate.postId === input.boundaryPostId);
      if (!boundary) throw new ForkConflictError('Selected post is not an eligible canonical fork boundary');
      const session = this.store.getSessionByTopic(input.topicId);
      const link = this.store.getPiSessionLinkByTopic(input.topicId);
      if (!session || !link) throw new ForkConflictError('Linked canonical Pi session is unavailable');
      // Eligibility and the optimistic leaf come from one canonical agentd
      // snapshot, so acceptance cannot combine a candidate list with a leaf
      // observed from a different source state.
      const expectedLeafId = canonicalSnapshot.leafEntryId;
      if (!expectedLeafId) throw new ForkConflictError('Linked canonical Pi session leaf is unavailable');

      const stageRoot = join(this.prestageRoot(), input.operationId);
      const sourcePosts = this.store.listPosts(input.topicId, 1, 100_000);
      const boundaryIndex = sourcePosts.findIndex((post) => post.id === input.boundaryPostId);
      const inheritedSourcePosts = sourcePosts.slice(0, boundaryIndex + 1);
      const sourceSnapshot = JSON.stringify(
        inheritedSourcePosts.map((post) => ({
          id: post.id,
          parentPostId: post.parent_post_id,
          body: post.body,
          editedAt: post.edited_at,
          deletedAt: post.deleted_at,
          attachments: this.store
            .listAttachmentsByPost(post.id)
            .filter((attachment) => !attachment.deleted_at)
            .map((attachment) => ({
              id: attachment.id,
              sizeBytes: attachment.size_bytes,
              storagePath: attachment.storage_path,
              sha256: attachment.sha256,
            })),
        }))
      );
      const prestaged: Array<{
        sourcePostId: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
        storagePath: string;
        sha256: string | null;
      }> = [];
      try {
        await mkdir(stageRoot, { recursive: true });
        const stageInfo = await lstat(stageRoot);
        if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink())
          throw new ForkConflictError('Fork attachment prestage path is unsafe');
        for (const post of inheritedSourcePosts) {
          for (const attachment of this.store.listAttachmentsByPost(post.id)) {
            if (attachment.deleted_at) continue;
            const destination = join(
              stageRoot,
              `${attachment.id}-${attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
            );
            const sourceStat = await stat(attachment.storage_path);
            if (!sourceStat.isFile()) throw new ForkConflictError('Fork attachments must be regular files');
            if (
              sourceStat.size !== attachment.size_bytes ||
              sourceStat.size < 0 ||
              sourceStat.size > MAX_ATTACHMENT_BYTES
            )
              throw new ForkConflictError('Fork attachment size validation failed');
            const sourceSha256 = await sha256File(attachment.storage_path);
            if (attachment.sha256 && attachment.sha256 !== sourceSha256)
              throw new ForkConflictError('Fork attachment source hash validation failed');
            await copyFile(attachment.storage_path, destination);
            const copiedStat = await stat(destination);
            const sha256 = await sha256File(destination);
            if (copiedStat.size !== attachment.size_bytes || sha256 !== sourceSha256)
              throw new ForkConflictError('Fork attachment integrity validation failed');
            prestaged.push({
              sourcePostId: post.id,
              filename: attachment.filename,
              mimeType: attachment.mime_type,
              sizeBytes: copiedStat.size,
              storagePath: destination,
              sha256,
            });
          }
        }
        const currentPosts = this.store.listPosts(input.topicId, 1, 100_000);
        const currentBoundaryIndex = currentPosts.findIndex((post) => post.id === input.boundaryPostId);
        const currentSnapshot = JSON.stringify(
          currentPosts.slice(0, currentBoundaryIndex + 1).map((post) => ({
            id: post.id,
            parentPostId: post.parent_post_id,
            body: post.body,
            editedAt: post.edited_at,
            deletedAt: post.deleted_at,
            attachments: this.store
              .listAttachmentsByPost(post.id)
              .filter((attachment) => !attachment.deleted_at)
              .map((attachment) => ({
                id: attachment.id,
                sizeBytes: attachment.size_bytes,
                storagePath: attachment.storage_path,
                sha256: attachment.sha256,
              })),
          }))
        );
        if (currentBoundaryIndex !== boundaryIndex || currentSnapshot !== sourceSnapshot)
          throw new ForkConflictError('Source topic changed while fork attachments were being prestaged');
        const operation = this.store.enqueueForkOperation({
          id: input.operationId,
          sourceTopicId: input.topicId,
          sourceSessionId: session.id,
          sourcePiSessionId: link.pi_session_id,
          sourcePiSessionPath: link.pi_session_path,
          boundaryPostId: boundary.postId,
          boundaryPiMessageId: boundary.piMessageId,
          boundaryEntryId: boundary.entryId,
          expectedLeafId,
          initiatedBy: input.initiatedBy,
          title: input.title.trim(),
          openingBody: input.openingBody.trim(),
          prestagedAttachments: prestaged,
        });
        this.wake();
        return operation;
      } catch (error) {
        await rm(stageRoot, { recursive: true, force: true });
        if (error instanceof Error && error.message === 'fork_conflict')
          throw new ForkConflictError('Topic must be idle with no unresolved operation or dispatch');
        throw error;
      }
    } finally {
      releaseAdmission();
    }
  }

  private async processDue(): Promise<void> {
    if (this.cleanupPending) {
      this.cleanupPending = false;
      await this.cleanupOrphanPrestages();
    }
    while (!this.stopped) {
      const row = this.store.listPendingForkOperationRows(1)[0];
      if (!row) return;
      const claimed = this.store.claimForkOperation(row.id);
      if (!claimed) continue;
      try {
        const result = claimed.agent_result_json
          ? (JSON.parse(claimed.agent_result_json) as {
              child_session_id: string;
              child_session_path: string;
              inherited_generation: number;
              active_entry_ids: string[];
            })
          : await this.agent.forkTopicConversation(claimed.source_topic_id, {
              operationId: claimed.id,
              expectedLeafId: claimed.expected_leaf_id,
              boundaryEntryId: claimed.boundary_entry_id,
            });
        this.store.materializeForkOperation(claimed.id, result);
        await this.finalizePrestagedAttachments(claimed.id);
        await this.agent.acknowledgeFork(claimed.id, result.child_session_id);
        this.store.completeForkOperation(claimed.id);
        this.dispatcher.wake();
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = forkFailureMessage(error);
        if (message !== rawMessage) console.warn(`[fork] ${claimed.id}: ${rawMessage}`);
        // Once the child is materialized, only a successful agentd acknowledgement
        // can release either side's fence. Never terminalize an acknowledgement error.
        const childMaterialized = Boolean(this.store.getForkOperation(claimed.id)?.childTopicId);
        if (agentErrorCode(error) === 'fork_manual_recovery') {
          // Agentd cannot prove whether an unmarked child was created. Keep the
          // source durably fenced and require an operator decision; replaying the
          // fork would risk creating or adopting the wrong canonical child.
          this.store.markForkNeedsManualReview(claimed.id, message);
        } else if (!childMaterialized && definitive(error)) {
          await rm(join(this.prestageRoot(), claimed.id), { recursive: true, force: true });
          this.store.failForkOperation(claimed.id, message);
        } else this.store.requeueForkOperation(claimed.id, message, new Date(Date.now() + RETRY_MS).toISOString());
      }
    }
  }
}
