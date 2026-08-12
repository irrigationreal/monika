import type { IdentityId, PostId, TopicId } from './ids';

export const ForkOperationStatusValues = ['pending', 'running', 'needs_manual_review', 'succeeded', 'failed'] as const;
export type ForkOperationStatus = (typeof ForkOperationStatusValues)[number];

export interface ForkBoundary {
  postId: PostId;
  postNumber: number;
  piMessageId: string;
  entryId: string;
  excerpt: string;
  body: string;
}

export interface ForkOperation {
  id: string;
  sourceTopicId: TopicId;
  boundaryPostId: PostId;
  boundaryEntryId: string;
  expectedLeafId: string;
  initiatedBy: IdentityId;
  title: string;
  openingBody: string;
  status: ForkOperationStatus;
  childTopicId: TopicId | null;
  childSessionId: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
