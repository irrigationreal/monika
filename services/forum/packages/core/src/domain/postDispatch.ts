export type PostDispatchVisibleStatus = 'pending' | 'dispatching' | 'failed';
export type PostDispatchAttemptEvent =
  'claimed' | 'dispatched' | 'retry_scheduled' | 'terminal_failure' | 'abandoned' | 'superseded';

export interface PostDispatchAttemptAudit {
  id: string;
  dispatchId: string;
  attemptNumber: number;
  event: PostDispatchAttemptEvent;
  classification: 'transport' | 'application' | 'lifecycle' | null;
  retryAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface TopicPostDispatchProjection {
  topicId: string;
  polling: boolean;
  current: {
    dispatchId: string;
    postId: string;
    status: PostDispatchVisibleStatus;
    attemptCount: number;
    nextAttemptAt: string | null;
    updatedAt: string;
  }[];
  attempts: PostDispatchAttemptAudit[];
}
