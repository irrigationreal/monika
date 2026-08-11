import type { UtteranceOrigin } from '@irrigationreal/codex-forum-core';

import type { AgentBridge } from '../agentBridge';
import type { PostDispatchRow } from '../db';
import type { ForumStore } from '../store';

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
  private stopped = true;
  private readonly stopWaiters: (() => void)[] = [];
  private readonly activeTopics = new Set<string>();

  constructor(
    private readonly store: ForumStore,
    private readonly agent: AgentBridge,
    private readonly opts: { intervalMs?: number; maxConcurrent?: number } = {}
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.runProcessDue('timer');
    }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref();
    this.runProcessDue('startup');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.running) return;
    await new Promise<void>((resolve) => this.stopWaiters.push(resolve));
  }

  wake(): void {
    if (this.stopped) return;
    this.runProcessDue('wake');
  }

  private runProcessDue(trigger: 'startup' | 'timer' | 'wake'): void {
    void this.processDue().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Post dispatch ${trigger} processing failed: ${message}`);
    });
  }

  private async processDue(): Promise<void> {
    if (this.stopped || this.running) return;
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
        const now = Date.now();
        const recoveryCheckpoint = pendingForTopic.find(
          (pending) =>
            this.store.isCompactionRecoveryPost(pending.post_id) &&
            (!pending.next_attempt_at || new Date(pending.next_attempt_at).getTime() <= now)
        );
        if (this.store.hasCompactionFence(row.topic_id) && !recoveryCheckpoint) continue;
        const earliest = recoveryCheckpoint ?? pendingForTopic[0] ?? row;
        if (earliest.status === 'dispatching' && !isStaleDispatching(earliest)) continue;
        if (this.activeTopics.has(earliest.topic_id) || seenTopics.has(earliest.topic_id)) continue;
        selected.push(earliest);
        seenTopics.add(earliest.topic_id);
      }
      await Promise.all(selected.map((row) => this.dispatch(row)));
    } finally {
      this.running = false;
      for (const resolve of this.stopWaiters.splice(0)) resolve();
    }
  }

  private async dispatch(row: PostDispatchRow): Promise<void> {
    this.activeTopics.add(row.topic_id);
    let claimToken: string | null = null;
    try {
      const post = this.store.getPost(row.post_id);
      const topic = this.store.getTopic(row.topic_id);
      if (this.store.hasCompactionFence(row.topic_id) && !this.store.isCompactionRecoveryPost(row.post_id)) return;
      if (!post || post.deleted_at) {
        this.store.markPostDispatchAbandoned(row.id, 'Post was deleted before dispatch.');
        return;
      }
      if (!topic || topic.status === 'locked' || topic.status === 'archived') {
        this.store.markPostDispatchAbandoned(row.id, 'Topic is no longer dispatchable.');
        return;
      }
      const cancellationActivity = this.store.getRobotState(row.topic_id)?.activity;
      if (cancellationActivity === 'stopping' || cancellationActivity === 'uncertain') {
        // Human content remains durable and pending; do not claim or cross the
        // robot boundary until canonical cancellation is resolved.
        return;
      }

      const pendingForTopic = this.store.listPendingPostDispatchesForTopic(row.topic_id);
      const dispatchingRecoveryCheckpoint = this.store.isCompactionRecoveryPost(row.post_id);
      const startIndex = pendingForTopic.findIndex((pending) => pending.id === row.id);
      if (startIndex < 0) return;
      const candidates = pendingForTopic.slice(startIndex);
      const boundary = candidates.findIndex((pending) => pending.origin_key !== row.origin_key);
      const group = dispatchingRecoveryCheckpoint ? [row] : candidates.slice(0, boundary < 0 ? undefined : boundary);
      const trigger = group.at(-1) ?? row;
      const claimed = this.store.claimPostDispatchGroup(group);
      claimToken = claimed?.claim_token ?? null;
      if (!claimed || !claimToken || !this.store.isPostDispatchClaimCurrent(trigger.id, claimToken)) return;
      const robotState = this.store.getRobotState(trigger.topic_id);
      const activeOrigin = this.store.getActiveTurnOrigin(trigger.topic_id);
      const sameActiveOrigin = activeOrigin?.generation === trigger.generation
        && activeOrigin.origin_key === trigger.origin_key;
      // A durable dispatch may alter an active Pi turn only when it belongs to
      // exactly the same normalized causal origin. Other surfaces are accepted
      // as follow-ups and settle in a later Pi turn.
      const mode = sameActiveOrigin && (
        trigger.mode === 'steer' ||
        (trigger.mode === 'auto' && robotState && !['idle', 'stopped', 'error'].includes(robotState.activity))
      ) ? 'steer' : 'queue';

      // Re-check the same claimed trigger immediately before crossing agentd.
      // An interrupt advances its durable topic generation and fences the group.
      if (!this.store.isPostDispatchClaimCurrent(trigger.id, claimToken)) return;
      const contributorPostIds = JSON.parse(claimed.contributor_post_ids_json) as string[];
      await this.agent.dispatchPostToAgent(trigger.topic_id, trigger.post_id, {
        mode,
        model: trigger.model,
        reasoningEffort: trigger.reasoning_effort,
        dispatchId: trigger.id,
        generation: trigger.generation,
        contributorPostIds,
        origin: JSON.parse(claimed.origin_json) as UtteranceOrigin,
      });
      this.store.markPostDispatchDispatched(trigger.id, claimToken);
      this.store.clearRobotTurnError(trigger.topic_id);
    } catch (err) {
      const pending = this.store.listPendingPostDispatchesForTopic(row.topic_id);
      const claimed = pending.find((item) => item.claim_token === claimToken) ?? row;
      const latest = this.store.getPostDispatch(claimed.id) ?? claimed;
      const message = err instanceof Error ? err.message : String(err);
      const retryAt = retryAtForAttempt(latest.attempt_count);
      if (claimToken) this.store.markPostDispatchFailed(latest.id, claimToken, message, { retryAt });
    } finally {
      this.activeTopics.delete(row.topic_id);
    }
  }
}
