import type { CompactionOperation } from '@irrigationreal/codex-forum-core';

import type { PostDispatchRow } from '../db';
import type { ForumStore } from '../store';

const DEFAULT_INTERVAL_MS = 2_000;
const UNCERTAIN_RETRY_MS = 10_000;

function isDefinitiveCompactionRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const typed = error as { status?: unknown; details?: unknown };
  if (typed.status === 408 || typed.status === 425 || typed.status === 429) return false;
  const details = typed.details;
  const code = typeof details === 'object' && details !== null ? (details as { error?: unknown }).error : null;
  if (code === 'conversation_busy') return false;
  return typeof typed.status === 'number' && typed.status >= 400 && typed.status < 500;
}

export class CompactionConflictError extends Error {}
export class CompactionNotFoundError extends Error {}

export interface TopicCompactionState {
  active: CompactionOperation | null;
  latest: CompactionOperation | null;
  checkpointDispatch: PostDispatchRow | null;
}

export class CompactionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing: Promise<void> | null = null;
  private stopped = true;
  private wakeRequested = false;

  constructor(
    private readonly store: ForumStore,
    private readonly agent: {
      getTopicCompactionLeaf(topicId: string): Promise<string | null>;
      compactTopicConversation(
        topicId: string,
        opts: { operationId: string; expectedLeafId: string; customInstructions?: string | null }
      ): Promise<Record<string, unknown>>;
    },
    private readonly dispatcher: { wake(): void },
    private readonly opts: { intervalMs?: number } = {}
  ) {}

  start(): number {
    if (this.timer) return 0;
    this.stopped = false;
    const recovered = this.store.requeueRunningCompactionOperations();
    this.timer = setInterval(() => this.wake(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
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

  wake(): void {
    if (this.stopped || !this.timer) return;
    if (this.processing) {
      this.wakeRequested = true;
      return;
    }
    this.wakeRequested = false;
    this.processing = this.processDue()
      .catch((error) => {
        console.error('Compaction worker failed; pending work will retry on the next interval.', error);
      })
      .finally(() => {
        this.processing = null;
        if (this.wakeRequested && !this.stopped) queueMicrotask(() => this.wake());
      });
  }

  async enqueue(input: {
    operationId: string;
    topicId: string;
    initiatedBy: string;
    customInstructions?: string | null;
    recoveryPrompt: string;
  }): Promise<CompactionOperation> {
    const customInstructions = input.customInstructions?.trim() || null;
    const recoveryPrompt = input.recoveryPrompt.trim();
    const prior = this.store.getCompactionOperation(input.operationId);
    if (prior) {
      this.assertSameRequest(prior, { ...input, customInstructions, recoveryPrompt });
      if (prior.status === 'pending' || prior.status === 'running') this.wake();
      return prior;
    }

    const topic = this.store.getTopic(input.topicId);
    if (!topic || topic.status !== 'open') {
      throw new CompactionConflictError('Topic must be open before compaction');
    }
    const session = this.store.getSessionByTopic(input.topicId);
    const link = this.store.getPiSessionLinkByTopic(input.topicId);
    if (!session || link?.session_id !== session.id) {
      throw new CompactionConflictError('Topic does not have a linked Pi conversation');
    }
    const state = this.store.getRobotState(input.topicId);
    const autoRun = this.store.getTopicAutoRun(input.topicId);
    if (
      (state?.activity !== 'idle' && state?.activity !== 'stopped') ||
      autoRun?.status === 'running' ||
      this.store.countActionablePostDispatches(input.topicId) > 0 ||
      this.store.hasCompactionFence(input.topicId)
    ) {
      throw new CompactionConflictError('Topic must be idle with no pending dispatch or compaction before compaction');
    }
    const expectedLeafId = this.store.getPiSessionHead(link.pi_session_id);
    if (!expectedLeafId) {
      throw new CompactionConflictError('The linked Pi session head is unavailable; sync it before compaction');
    }

    const queued = this.store.enqueueCompactionOperationIfIdle({
      id: input.operationId,
      topicId: input.topicId,
      sessionId: session.id,
      initiatedBy: input.initiatedBy,
      expectedLeafId,
      customInstructions,
      recoveryPrompt,
    });
    if (!queued) {
      const concurrent = this.store.getCompactionOperation(input.operationId);
      if (concurrent) {
        this.assertSameRequest(concurrent, { ...input, customInstructions, recoveryPrompt });
        if (concurrent.status === 'pending' || concurrent.status === 'running') this.wake();
        return concurrent;
      }
      throw new CompactionConflictError('Topic stopped being idle before compaction could be accepted');
    }
    this.wake();
    return queued;
  }

  get(topicId: string, operationId: string): CompactionOperation {
    const operation = this.store.getCompactionOperation(operationId);
    if (operation?.topicId !== topicId) throw new CompactionNotFoundError('Compaction operation not found');
    return operation;
  }

  getState(topicId: string): TopicCompactionState {
    const active = this.store.getActiveCompactionOperation(topicId);
    const latest = this.store.getLatestCompactionOperation(topicId);
    const checkpointDispatch = latest?.recoveryPostId
      ? this.store.getPostDispatchByPost(latest.recoveryPostId)
      : null;
    return { active, latest, checkpointDispatch };
  }

  retryCheckpoint(topicId: string, operationId: string): TopicCompactionState {
    const operation = this.get(topicId, operationId);
    if (operation.status !== 'succeeded' || !operation.recoveryPostId) {
      throw new CompactionConflictError('Compaction does not have a recovery checkpoint to retry');
    }
    const dispatch = this.store.getPostDispatchByPost(operation.recoveryPostId);
    if (!dispatch) throw new CompactionConflictError('Recovery checkpoint dispatch is unavailable');
    if (dispatch.status === 'pending' || dispatch.status === 'dispatching' || dispatch.status === 'dispatched') {
      return this.getState(topicId);
    }
    if (!['failed', 'superseded', 'abandoned'].includes(dispatch.status)) {
      throw new CompactionConflictError('Recovery checkpoint dispatch is not retryable');
    }
    if (!this.store.retryTerminalPostDispatch(dispatch.id)) {
      const current = this.store.getPostDispatch(dispatch.id);
      if (current?.status === 'pending' || current?.status === 'dispatching' || current?.status === 'dispatched') {
        return this.getState(topicId);
      }
      throw new CompactionConflictError('Recovery checkpoint dispatch could not be retried');
    }
    this.dispatcher.wake();
    return this.getState(topicId);
  }

  private assertSameRequest(
    prior: CompactionOperation,
    input: {
      topicId: string;
      initiatedBy: string;
      customInstructions: string | null;
      recoveryPrompt: string;
    }
  ): void {
    if (
      prior.topicId !== input.topicId ||
      prior.initiatedBy !== input.initiatedBy ||
      prior.recoveryPrompt !== input.recoveryPrompt ||
      prior.customInstructions !== input.customInstructions
    ) {
      throw new CompactionConflictError('operationId is already used by a different compaction request');
    }
  }

  private async processDue(): Promise<void> {
    while (!this.stopped) {
      const pending = this.store.listPendingCompactionOperations(1)[0];
      if (!pending) return;
      const claimed = this.store.claimCompactionOperation(pending.id);
      if (!claimed) continue;
      try {
        await this.execute(claimed);
      } catch (error) {
        this.store.requeueCompactionOperation(claimed.id);
        throw error;
      }
    }
  }

  private async execute(operation: CompactionOperation): Promise<void> {
    const compact = () =>
      this.agent.compactTopicConversation(operation.topicId, {
        operationId: operation.id,
        expectedLeafId: operation.expectedLeafId,
        customInstructions: operation.customInstructions,
      });
    try {
      await compact();
      this.store.finishCompactionSuccess(operation.id);
      this.dispatcher.wake();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDefinitiveCompactionRejection(error)) {
        this.store.finishCompactionFailure(operation.id, message);
      } else {
        // Do not issue an immediate duplicate while the first agentd request may
        // still be running. Persist uncertainty and reconcile the same expected
        // leaf after backoff; canonical child evidence prevents double compaction.
        this.store.requeueUncertainCompaction(
          operation.id,
          message,
          new Date(Date.now() + UNCERTAIN_RETRY_MS).toISOString()
        );
      }
    }
  }
}
