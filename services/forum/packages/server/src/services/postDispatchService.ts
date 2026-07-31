import type { AgentBridge } from '../agentBridge';
import type { ForumStore } from '../store';
import type { PostDispatchRow } from '../db';

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_MAX_CONCURRENT = 5;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [10_000, 30_000, 2 * 60_000, 5 * 60_000];
const DISPATCHING_STALE_MS = 5 * 60_000;

function retryAtForAttempt(attemptCount: number): string | null {
  if (attemptCount >= MAX_ATTEMPTS) return null;
  const delayMs = RETRY_DELAYS_MS[Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attemptCount - 1))] ?? 5 * 60_000;
  return new Date(Date.now() + delayMs).toISOString();
}

function isStaleDispatching(row: PostDispatchRow): boolean {
  if (row.status !== 'dispatching') return false;
  const at = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : 0;
  return at > 0 && Date.now() - at > DISPATCHING_STALE_MS;
}

export class PostDispatchService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly activeTopics = new Set<string>();

  constructor(
    private readonly store: ForumStore,
    private readonly agent: AgentBridge,
    private readonly opts: { intervalMs?: number; maxConcurrent?: number } = {}
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.processDue(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
    void this.processDue();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  wake(): void {
    void this.processDue();
  }

  private async processDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const maxConcurrent = Math.max(1, Math.trunc(this.opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
      const due = this.store.listDuePostDispatches(maxConcurrent * 4);
      const selected: PostDispatchRow[] = [];
      const seenTopics = new Set<string>();
      for (const row of due) {
        if (selected.length >= maxConcurrent) break;
        if (this.activeTopics.has(row.topic_id) || seenTopics.has(row.topic_id)) continue;
        if (row.status === 'dispatching' && !isStaleDispatching(row)) continue;
        const pendingForTopic = this.store.listPendingPostDispatchesForTopic(row.topic_id);
        const latest = pendingForTopic.at(-1) ?? row;
        if (latest.status === 'dispatching' && !isStaleDispatching(latest)) continue;
        if (this.activeTopics.has(latest.topic_id) || seenTopics.has(latest.topic_id)) continue;
        selected.push(latest);
        seenTopics.add(latest.topic_id);
      }
      await Promise.all(selected.map((row) => this.dispatch(row)));
    } finally {
      this.running = false;
    }
  }

  private async dispatch(row: PostDispatchRow): Promise<void> {
    this.activeTopics.add(row.topic_id);
    let claimToken: string | null = null;
    try {
      const post = this.store.getPost(row.post_id);
      const topic = this.store.getTopic(row.topic_id);
      if (!post || post.deleted_at) {
        this.store.markPostDispatchAbandoned(row.id, 'Post was deleted before dispatch.');
        return;
      }
      if (!topic || topic.status === 'locked' || topic.status === 'archived') {
        this.store.markPostDispatchAbandoned(row.id, 'Topic is no longer dispatchable.');
        return;
      }

      const pendingForTopic = this.store.listPendingPostDispatchesForTopic(row.topic_id);
      for (const pending of pendingForTopic) {
        if (pending.id !== row.id && pending.created_at <= row.created_at) {
          this.store.markPostDispatchSuperseded(pending.id);
        }
      }

      const claimed = this.store.claimPostDispatch(row.id, row);
      claimToken = claimed?.claim_token ?? null;
      if (!claimed || !claimToken || !this.store.isPostDispatchClaimCurrent(row.id, claimToken)) return;
      const robotState = this.store.getRobotState(row.topic_id);
      const mode = row.mode === 'steer' || (row.mode === 'auto' && robotState && robotState.activity !== 'idle' && robotState.activity !== 'error')
        ? 'steer'
        : 'queue';

      // Re-check immediately before crossing the agentd boundary. An interrupt
      // advances the durable topic generation, making this claim ineligible.
      if (!this.store.isPostDispatchClaimCurrent(row.id, claimToken)) return;
      await this.agent.dispatchPostToAgent(row.topic_id, row.post_id, {
        mode,
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        dispatchId: row.id,
        generation: row.generation,
      });
      this.store.markPostDispatchDispatched(row.id, claimToken);
      this.store.clearRobotTurnError(row.topic_id);
    } catch (err) {
      const latest = this.store.getPostDispatch(row.id) ?? row;
      const message = err instanceof Error ? err.message : String(err);
      const retryAt = retryAtForAttempt(latest.attempt_count);
      if (claimToken) this.store.markPostDispatchFailed(row.id, claimToken, message, { retryAt });
    } finally {
      this.activeTopics.delete(row.topic_id);
    }
  }
}
