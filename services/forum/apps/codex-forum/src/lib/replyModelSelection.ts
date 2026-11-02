import type { RobotStateDto } from './apiClient';

export interface ReplyModelSelection {
  model: string | null;
  reasoningEffort: string | null;
}

/**
 * Resolve the composer defaults for an existing topic without changing the
 * browser-wide default used by the new-topic composer.
 */
export function resolveTopicReplySelection(
  robotState: Pick<RobotStateDto, 'model' | 'reasoningEffort'> | null | undefined,
  fallback: ReplyModelSelection
): ReplyModelSelection {
  return {
    model: robotState?.model ?? fallback.model,
    reasoningEffort: robotState?.reasoningEffort ?? fallback.reasoningEffort,
  };
}
