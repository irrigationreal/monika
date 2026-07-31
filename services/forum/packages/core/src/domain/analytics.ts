export const AnalyticsBucketValues = ['day', 'week'] as const;
export type AnalyticsBucket = (typeof AnalyticsBucketValues)[number];

export const AnalyticsAudienceValues = ['human', 'assistant'] as const;
export type AnalyticsAudience = (typeof AnalyticsAudienceValues)[number];

export interface AnalyticsWindow {
  from: string;
  to: string;
  bucket: AnalyticsBucket;
}

export interface AnalyticsForumOption {
  id: string;
  name: string;
}

export interface AnalyticsVocabularyTerm {
  term: string;
  score: number;
  count: number;
  documentCount: number;
}

export interface AnalyticsVocabularyGroup {
  forumId: string;
  forumName: string;
  audience: AnalyticsAudience;
  postCount: number;
  terms: AnalyticsVocabularyTerm[];
}

export interface ForumAnalyticsScope {
  forums: AnalyticsForumOption[];
  piSessionIds: string[];
  vocabulary: AnalyticsVocabularyGroup[];
}

export interface ForumAnalyticsQuery {
  window: AnalyticsWindow;
  forumId?: string | null;
}

export interface ForumAnalyticsReadModel {
  getAnalyticsScope(query: ForumAnalyticsQuery): Promise<ForumAnalyticsScope>;
}
