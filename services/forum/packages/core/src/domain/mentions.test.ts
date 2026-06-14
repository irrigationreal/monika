import { describe, expect, it } from 'vitest';
import { hasRobotMention } from './mentions';

describe('hasRobotMention', () => {
  it('matches @robot case-insensitively with punctuation boundaries', () => {
    expect(hasRobotMention('Hello @robot')).toBe(true);
    expect(hasRobotMention('Hello (@RoBoT)')).toBe(true);
    expect(hasRobotMention('hello,@robot')).toBe(true);
  });

  it('avoids matching inside words or email-like strings', () => {
    expect(hasRobotMention('hello@robot')).toBe(false);
    expect(hasRobotMention('robot@robot.com')).toBe(false);
    expect(hasRobotMention('ping @robotic')).toBe(false);
  });

  it('matches username and normalized display name tokens', () => {
    const identity = { username: 'unit.bot', displayName: 'robot_bot' };
    expect(hasRobotMention('(@unit.bot)', identity)).toBe(true);
    expect(hasRobotMention('hey @robot_bot', identity)).toBe(true);
  });

  it('ignores display names with unsupported characters', () => {
    const identity = { username: null, displayName: 'Robot Bot' };
    expect(hasRobotMention('@Robot_Bot', identity)).toBe(false);
    expect(hasRobotMention('@robot', identity)).toBe(true);
  });
});
