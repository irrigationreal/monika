import type { SessionContextDto } from '../lib/apiClient';

/**
 * Context usage changes much less frequently than live robot activity. Missing
 * or failed refreshes must retain the last snapshot for the active topic.
 */
export function retainSessionContext(
  current: SessionContextDto | null,
  incoming: SessionContextDto | null | undefined
): SessionContextDto | null {
  return incoming ?? current;
}
