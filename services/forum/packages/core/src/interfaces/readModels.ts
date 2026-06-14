import type { ForumStats, TopicStats } from '../domain/entities';
import type { ForumId, TopicId } from '../domain/ids';

export interface ForumStatsReadModel {
  getForumStats(forumId: ForumId): Promise<ForumStats>;
  getForumStatsForForums(forumIds: ForumId[]): Promise<Map<ForumId, ForumStats>>;
}

export interface TopicStatsReadModel {
  getTopicStats(topicId: TopicId): Promise<TopicStats>;
  getTopicStatsForTopics(topicIds: TopicId[]): Promise<Map<TopicId, TopicStats>>;
}
