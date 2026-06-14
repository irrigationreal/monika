import { describe, expect, it } from 'vitest';
import { evaluateDispatchDecision } from './dispatchPolicy';

describe('evaluateDispatchDecision', () => {
  it('dispatches for auto mode when not silent or deferred', () => {
    const decision = evaluateDispatchDecision({
      robotMode: 'auto',
      hasRobotMention: false
    });
    expect(decision.shouldDispatch).toBe(true);
    expect(decision.deferRobot).toBe(false);
    expect(decision.shouldStoreSilent).toBe(false);
    expect(decision.reason).toBe('dispatch');
  });

  it('requires mention when robotMode is mention', () => {
    const noMention = evaluateDispatchDecision({
      robotMode: 'mention',
      hasRobotMention: false
    });
    expect(noMention.shouldDispatch).toBe(false);
    expect(noMention.reason).toBe('mentionRequired');

    const mention = evaluateDispatchDecision({
      robotMode: 'mention',
      hasRobotMention: true
    });
    expect(mention.shouldDispatch).toBe(true);
    expect(mention.reason).toBe('dispatch');
  });

  it('defers when attachments are pending unless silent', () => {
    const deferred = evaluateDispatchDecision({
      robotMode: 'auto',
      hasRobotMention: true,
      attachmentsPending: true
    });
    expect(deferred.shouldDispatch).toBe(false);
    expect(deferred.deferRobot).toBe(true);
    expect(deferred.shouldStoreSilent).toBe(true);
    expect(deferred.reason).toBe('attachmentsPending');

    const silent = evaluateDispatchDecision({
      robotMode: 'auto',
      hasRobotMention: true,
      attachmentsPending: true,
      silent: true
    });
    expect(silent.shouldDispatch).toBe(false);
    expect(silent.deferRobot).toBe(false);
    expect(silent.shouldStoreSilent).toBe(true);
    expect(silent.reason).toBe('silent');
  });

  it('blocks dispatch when robotMode is off', () => {
    const decision = evaluateDispatchDecision({
      robotMode: 'off',
      hasRobotMention: true
    });
    expect(decision.shouldDispatch).toBe(false);
    expect(decision.reason).toBe('robotModeOff');
  });
});
