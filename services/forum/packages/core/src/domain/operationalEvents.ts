import type { IdentityId, PostId, TopicId } from './ids';

export const TopicOperationalEventTypeValues = ['turn_error', 'compaction'] as const;
export type TopicOperationalEventType = (typeof TopicOperationalEventTypeValues)[number];

export const TopicOperationalEventCategoryValues = ['assistant', 'maintenance'] as const;
export type TopicOperationalEventCategory = (typeof TopicOperationalEventCategoryValues)[number];

export const TopicOperationalEventStatusValues = ['failed', 'succeeded'] as const;
export type TopicOperationalEventStatus = (typeof TopicOperationalEventStatusValues)[number];

export const OperationalEventSourceKindValues = ['echs_turn', 'compaction_operation'] as const;
export type OperationalEventSourceKind = (typeof OperationalEventSourceKindValues)[number];

export interface TopicOperationalEvent {
  id: string;
  topicId: TopicId;
  anchorPostId: PostId | null;
  type: TopicOperationalEventType;
  category: TopicOperationalEventCategory;
  status: TopicOperationalEventStatus;
  summary: string;
  detail: Record<string, unknown> | null;
  sourceKind: OperationalEventSourceKind;
  sourceId: string;
  createdAt: string;
}

export const CompactionOperationStatusValues = ['pending', 'running', 'succeeded', 'failed'] as const;
export type CompactionOperationStatus = (typeof CompactionOperationStatusValues)[number];

export interface CompactionOperation {
  id: string;
  topicId: TopicId;
  sessionId: string;
  initiatedBy: IdentityId;
  expectedLeafId: string;
  customInstructions: string | null;
  recoveryPrompt: string;
  status: CompactionOperationStatus;
  eventId: string | null;
  recoveryPostId: PostId | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
