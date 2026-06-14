import { z } from 'zod';

export const FORUM_THEME_KEYS = [
  'system',
  'classic-light',
  'classic-dark',
  // seasonal / special
  'lunar-horse',
  // china internet (2000s)
  'cn-portal-2000s',
  'cn-im-2000s',
  'cn-commerce-2000s',
  // 1990s computing
  'win95',
  'mac-platinum',
  'crt-green',
  // 2000-2004 internet
  'winxp-luna',
  'aqua',
  'netscape',
  'y2k-gel',
  // 2004-2008
  'vista-aero',
  'ubuntu-human',
  'web20',
  // 2008-2014
  'github-2012',
  'metro',
  'solarized-dark',
  // 2016+
  'notion',
  'nord',
  'material-dark'
 ] as const;

export const ForumThemeKeySchema = z.enum(FORUM_THEME_KEYS);

export type ForumThemeKey = z.infer<typeof ForumThemeKeySchema>;

export function isForumThemeKey(value: unknown): value is ForumThemeKey {
  return ForumThemeKeySchema.safeParse(value).success;
}
