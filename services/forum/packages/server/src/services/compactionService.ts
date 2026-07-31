import type { CompactionOperation } from '@irrigationreal/codex-forum-core';

import type { ForumStore } from '../store';

export class CompactionConflictError extends Error {}
export class CompactionNotFoundError extends Error {}

export class CompactionService {
  constructor(
    private readonly store: ForumStore,
    private readonly agent: {
      getTopicCompactionLeaf(topicId: string): Promise<string | null>;
      compactTopicConversation(
        topicId: string,
        opts: { operationId: string; expectedLeafId: string; customInstructions?: string | null }
      ): Promise<Record<string, unknown>>;
    },
    private readonly dispatcher: { wake(): void }
  ) {}

  async compact(input: {
    operationId: string;
    topicId: string;
    initiatedBy: string;
    customInstructions?: string | null;
    recoveryPrompt: string;
  }): Promise<CompactionOperation> {
    const customInstructions = input.customInstructions?.trim() ?? null;
    const prior = this.store.getCompactionOperation(input.operationId);
    if (prior) {
      if (
        prior.topicId !== input.topicId ||
        prior.initiatedBy !== input.initiatedBy ||
        prior.recoveryPrompt !== input.recoveryPrompt.trim() ||
        prior.customInstructions !== customInstructions
      ) {
        throw new CompactionConflictError('operationId is already used by a different compaction request');
      }
      return prior;
    }

    const session = this.store.getSessionByTopic(input.topicId);
    const link = this.store.getPiSessionLinkByTopic(input.topicId);
    if (!session || link?.session_id !== session.id) {
      throw new CompactionConflictError('Topic does not have a linked Pi conversation');
    }
    const state = this.store.getRobotState(input.topicId);
    if (
      state?.activity !== 'idle' ||
      this.store.countActionablePostDispatches(input.topicId) > 0 ||
      this.store.hasRunningCompactionOperation(input.topicId)
    ) {
      throw new CompactionConflictError('Topic must be idle with no pending dispatch or compaction before compaction');
    }
    const expectedLeafId =
      (await this.agent.getTopicCompactionLeaf(input.topicId)) ?? this.store.getPiSessionHead(link.pi_session_id);
    if (!expectedLeafId) {
      throw new CompactionConflictError('The linked Pi session head is unavailable; sync it before compaction');
    }

    const claimed = this.store.startCompactionOperation({
      id: input.operationId,
      topicId: input.topicId,
      sessionId: session.id,
      initiatedBy: input.initiatedBy,
      expectedLeafId,
      customInstructions,
      recoveryPrompt: input.recoveryPrompt.trim(),
    });
    if (!claimed) {
      throw new CompactionConflictError('Topic already has a running compaction');
    }

    const compact = () =>
      this.agent.compactTopicConversation(input.topicId, {
        operationId: claimed.id,
        expectedLeafId: claimed.expectedLeafId,
        customInstructions: claimed.customInstructions,
      });
    try {
      await compact();
      const completed = this.store.finishCompactionSuccess(claimed.id);
      this.dispatcher.wake();
      return completed;
    } catch (firstError) {
      // A dropped response can happen after Pi has already appended the
      // compaction entry. Retry the same optimistic operation once: agentd
      // recognizes that child entry and returns it without compacting twice.
      try {
        await compact();
        const completed = this.store.finishCompactionSuccess(claimed.id);
        this.dispatcher.wake();
        return completed;
      } catch (retryError) {
        const first = firstError instanceof Error ? firstError.message : String(firstError);
        const retry = retryError instanceof Error ? retryError.message : String(retryError);
        return this.store.finishCompactionFailure(
          claimed.id,
          retry === first ? retry : `${first}; retry failed: ${retry}`
        );
      }
    }
  }

  get(topicId: string, operationId: string): CompactionOperation {
    const operation = this.store.getCompactionOperation(operationId);
    if (operation?.topicId !== topicId) throw new CompactionNotFoundError('Compaction operation not found');
    return operation;
  }
}
