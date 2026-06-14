import type { RobotMode } from './entities';

export interface DispatchDecisionInput {
  robotMode: RobotMode;
  hasRobotMention: boolean;
  silent?: boolean;
  attachmentsPending?: boolean;
}

export type DispatchDecisionReason =
  | 'dispatch'
  | 'silent'
  | 'attachmentsPending'
  | 'robotModeOff'
  | 'mentionRequired';

export interface DispatchDecision {
  shouldDispatch: boolean;
  deferRobot: boolean;
  shouldStoreSilent: boolean;
  reason: DispatchDecisionReason;
}

export function evaluateDispatchDecision(input: DispatchDecisionInput): DispatchDecision {
  const silent = Boolean(input.silent);
  const deferRobot = Boolean(input.attachmentsPending) && !silent;
  const shouldDispatch =
    !silent &&
    !deferRobot &&
    input.robotMode !== 'off' &&
    (input.robotMode !== 'mention' || input.hasRobotMention);
  const reason: DispatchDecisionReason = silent
    ? 'silent'
    : deferRobot
      ? 'attachmentsPending'
      : input.robotMode === 'off'
        ? 'robotModeOff'
        : input.robotMode === 'mention' && !input.hasRobotMention
          ? 'mentionRequired'
          : 'dispatch';

  return {
    shouldDispatch,
    deferRobot,
    shouldStoreSilent: silent || deferRobot,
    reason
  };
}
