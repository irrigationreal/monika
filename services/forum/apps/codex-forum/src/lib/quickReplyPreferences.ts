import type { AuthIdentityDto, QuickReplyMode } from '@irrigationreal/codex-forum-contracts';

export const QUICK_REPLY_MOBILE_MEDIA_QUERY = '(max-width: 600px)';
export const DEFAULT_QUICK_REPLY_DESKTOP_MODE: QuickReplyMode = 'inline';
export const DEFAULT_QUICK_REPLY_MOBILE_MODE: QuickReplyMode = 'docked';

export function resolveQuickReplyPreferences(
  identity: Pick<AuthIdentityDto, 'quickReplyDesktopMode' | 'quickReplyMobileMode'> | null | undefined
): { desktopMode: QuickReplyMode; mobileMode: QuickReplyMode } {
  return {
    desktopMode: identity?.quickReplyDesktopMode ?? DEFAULT_QUICK_REPLY_DESKTOP_MODE,
    mobileMode: identity?.quickReplyMobileMode ?? DEFAULT_QUICK_REPLY_MOBILE_MODE,
  };
}

export function resolveQuickReplyMode(
  identity: Pick<AuthIdentityDto, 'quickReplyDesktopMode' | 'quickReplyMobileMode'> | null | undefined,
  mobileViewport: boolean
): QuickReplyMode {
  const preferences = resolveQuickReplyPreferences(identity);
  return mobileViewport ? preferences.mobileMode : preferences.desktopMode;
}

export function isMobileQuickReplyViewport(): boolean {
  return window.matchMedia(QUICK_REPLY_MOBILE_MEDIA_QUERY).matches;
}
