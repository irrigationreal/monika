import type { ForkOperationStatus } from './forks';
import type { IdentityId, TopicId } from './ids';

export interface CloneOperation {
  id: string;
  sourceTopicId: TopicId;
  expectedLeafId: string;
  initiatedBy: IdentityId;
  title: string;
  status: ForkOperationStatus;
  childTopicId: TopicId | null;
  childSessionId: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
