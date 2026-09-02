export const DISPATCH_NOT_ACCEPTED = 'not_accepted';
export const DISPATCH_SAFE_RETRY = 'safe';

export class DispatchNotAcceptedError extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'DispatchNotAcceptedError';
  }
}

export function notAcceptedBody(body, { safeRetry = false } = {}) {
  return {
    ...body,
    dispatch_acceptance: DISPATCH_NOT_ACCEPTED,
    ...(safeRetry ? { dispatch_retry: DISPATCH_SAFE_RETRY } : {}),
  };
}
