import { mapPostDispatchAttemptRowToDomain } from '../mappers/db';

import type { TopicPostDispatchProjection } from '@irrigationreal/codex-forum-core';

import type { ForumStore } from '../store';

export class PostDispatchProjectionService {
  constructor(private readonly store: ForumStore) {}

  getTopicProjection(topicId: string, historyLimit = 100): TopicPostDispatchProjection {
    const rows = this.store.listPostDispatchesForTopic(topicId);
    const current = rows
      .filter(
        (row) =>
          row.status === 'failed' ||
          (row.status === 'pending' && row.attempt_count > 0) ||
          (row.status === 'dispatching' && row.attempt_count > 1)
      )
      .map((row) => ({
        dispatchId: row.id,
        postId: row.post_id,
        status: row.status as 'pending' | 'dispatching' | 'failed',
        attemptCount: row.attempt_count,
        nextAttemptAt: row.next_attempt_at,
        updatedAt: row.updated_at,
      }));
    const attempts = this.store
      .listPostDispatchAttempts(
        rows.map((row) => row.id),
        historyLimit
      )
      .map(mapPostDispatchAttemptRowToDomain);
    const polling = rows.some((row) => row.status === 'pending' || row.status === 'dispatching');
    return { topicId, polling, current, attempts };
  }
}
