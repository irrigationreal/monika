import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUICK_REPLY_DESKTOP_MODE,
  DEFAULT_QUICK_REPLY_MOBILE_MODE,
  QUICK_REPLY_MOBILE_MEDIA_QUERY,
  resolveQuickReplyMode,
  resolveQuickReplyPreferences,
} from './quickReplyPreferences';

describe('Quick Reply device preferences', () => {
  it('defaults desktop to inline and mobile to docked at the shared compact breakpoint', () => {
    expect(QUICK_REPLY_MOBILE_MEDIA_QUERY).toBe('(max-width: 600px)');
    expect(DEFAULT_QUICK_REPLY_DESKTOP_MODE).toBe('inline');
    expect(DEFAULT_QUICK_REPLY_MOBILE_MODE).toBe('docked');
    expect(resolveQuickReplyPreferences(null)).toEqual({ desktopMode: 'inline', mobileMode: 'docked' });
  });

  it('resolves explicit desktop and mobile modes independently', () => {
    const identity = { quickReplyDesktopMode: 'docked', quickReplyMobileMode: 'inline' } as const;
    expect(resolveQuickReplyMode(identity, false)).toBe('docked');
    expect(resolveQuickReplyMode(identity, true)).toBe('inline');
  });
});
