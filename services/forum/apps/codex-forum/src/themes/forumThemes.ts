import type { ForumThemeKey } from '@irrigationreal/codex-forum-contracts';

export type ThemeEra =
  | 'Classic'
  | 'Seasonal'
  | 'China 2000s'
  | '1990s computing'
  | '2000–2004 internet'
  | '2004–2008'
  | '2008–2014'
  | '2016+';

export interface ForumThemeDefinition {
  key: ForumThemeKey;
  label: string;
  era: ThemeEra;
  /**
   * Short, user-facing description of the inspiration / design intent.
   * Keep it readable in a single paragraph.
   */
  description: string;
  /**
   * Used for UI affordances (sun/moon icon), not for CSS.
   * Note: `system` is dynamic; we treat it as "light" for metadata purposes.
   */
  tone: 'light' | 'dark';
}

export const FORUM_THEMES: readonly ForumThemeDefinition[] = [
  {
    key: 'system',
    label: 'System (Auto)',
    era: 'Classic',
    description: 'Follows your OS light/dark preference using the vMonika palette pair.',
    tone: 'light'
  },
  {
    key: 'classic-light',
    label: 'Classic RoboBB (Light)',
    era: 'Classic',
    description: 'A crisp vBulletin-inspired blue-and-slate theme with high legibility and strong hierarchy.',
    tone: 'light'
  },
  {
    key: 'classic-dark',
    label: 'Classic RoboBB (Dark)',
    era: 'Classic',
    description: 'Warm black-and-gold “night mode” that keeps contrast high without going neon.',
    tone: 'dark'
  },
  {
    key: 'vmonika',
    label: 'vMonika',
    era: 'Classic',
    description: 'Classic RoboBB Dark hue-shifted into a vivid blue-green palette — familiar forum chrome, but tuned for Monika.',
    tone: 'dark'
  },
  {
    key: 'vmonika-light',
    label: 'vMonika Light',
    era: 'Classic',
    description: 'The Classic RoboBB Light palette paired with vMonika so the quick theme toggle has a bright counterpart.',
    tone: 'light'
  },
  {
    key: 'lunar-horse',
    label: 'Lunar New Year (Horse)',
    era: 'Seasonal',
    description:
      'A festive red-and-gold palette inspired by Lunar New Year posters and mid‑2000s Chinese portal aesthetics — glossy chrome, brocade-like textures, and intentionally “over‑3D” skeuomorphic buttons.',
    tone: 'light'
  },
  {
    key: 'cn-portal-2000s',
    label: 'China Portal (2000s)',
    era: 'China 2000s',
    description:
      'An homage to mid‑2000s “portal” homepages: glossy blue nav chrome, yellow callouts, and dense box layouts (Sina/NetEase energy, but forum-friendly).',
    tone: 'light'
  },
  {
    key: 'cn-im-2000s',
    label: 'China IM (2000s)',
    era: 'China 2000s',
    description:
      'A candy-blue instant messenger vibe: bubbly gradients, rounded surfaces, and neon-friendly accents — inspired by the era of “cute” client UIs.',
    tone: 'light'
  },
  {
    key: 'cn-commerce-2000s',
    label: 'China E‑Commerce (2000s)',
    era: 'China 2000s',
    description:
      'Orange-and-red retail chrome with loud call-to-action contrast — a nod to early marketplace design where everything was a deal and every pixel wanted your attention.',
    tone: 'light'
  },

  // 1990s computing
  {
    key: 'win95',
    label: 'Windows 95 Classic',
    era: '1990s computing',
    description: 'Neutral grays, hard edges, and a teal taskbar vibe — designed to feel like a 640×480 control panel.',
    tone: 'light'
  },
  {
    key: 'mac-platinum',
    label: 'Mac OS 8 Platinum',
    era: '1990s computing',
    description: 'Soft “platinum” grays with subtle blue accents, evoking System 8/9 dialogs and list views.',
    tone: 'light'
  },
  {
    key: 'crt-green',
    label: 'CRT Green Phosphor',
    era: '1990s computing',
    description: 'Dark glass, scanline greens, and just enough contrast for long reading sessions — like a terminal that became a forum.',
    tone: 'dark'
  },

  // 2000–2004 internet
  {
    key: 'winxp-luna',
    label: 'Windows XP Luna',
    era: '2000–2004 internet',
    description: 'Sky blues and friendly rounded highlights, tuned to feel like XP-era forums and installers.',
    tone: 'light'
  },
  {
    key: 'aqua',
    label: 'Aqua (OS X Panther)',
    era: '2000–2004 internet',
    description: 'Glossy blues, watery gradients, and bright chrome — the “lickable button” era, tastefully restrained.',
    tone: 'light'
  },
  {
    key: 'netscape',
    label: 'Netscape Navigator',
    era: '2000–2004 internet',
    description: 'A throwback browser-chrome palette: gentle grays, purple visited links energy, and clean page whites.',
    tone: 'light'
  },
  {
    key: 'y2k-gel',
    label: 'Y2K Gel Buttons',
    era: '2000–2004 internet',
    description: 'Bright gradients, candy accents, and playful contrast — a Web 1.0/early Web 2.0 crossover moment.',
    tone: 'light'
  },

  // 2004–2008
  {
    key: 'vista-aero',
    label: 'Vista Aero Glass',
    era: '2004–2008',
    description: 'Icy glass blues with crisp borders and airy depth — the optimistic “translucent UI” era.',
    tone: 'light'
  },
  {
    key: 'ubuntu-human',
    label: 'Ubuntu Human',
    era: '2004–2008',
    description: 'Warm aubergine + orange highlights with paper-like surfaces; cozy but still high contrast.',
    tone: 'dark'
  },
  {
    key: 'web20',
    label: 'Web 2.0 (Digg-ish)',
    era: '2004–2008',
    description: 'Bold blues, clean whites, and punchy orange hover states — optimized for links, lists, and “front page” browsing.',
    tone: 'light'
  },

  // 2008–2014
  {
    key: 'github-2012',
    label: 'GitHub 2012',
    era: '2008–2014',
    description: 'Off-whites and neutral grays with “green means go” accents — calm, tool-like, and content-forward.',
    tone: 'light'
  },
  {
    key: 'metro',
    label: 'Metro (Windows 8)',
    era: '2008–2014',
    description: 'Flat surfaces, bold accent color, and minimal gradients — a UI that wants typography to do the talking.',
    tone: 'dark'
  },
  {
    key: 'solarized-dark',
    label: 'Solarized (Dark)',
    era: '2008–2014',
    description: 'Balanced contrast with blue/teal/yellow accents; ideal for reading code blocks and long threads.',
    tone: 'dark'
  },

  // 2016+
  {
    key: 'notion',
    label: 'Notion (Paper)',
    era: '2016+',
    description:
      'A calm, content-first palette inspired by Notion: warm paper backgrounds, subtle dividers, and a restrained blue accent.',
    tone: 'light'
  },
  {
    key: 'nord',
    label: 'Nord (Frost)',
    era: '2016+',
    description: 'Cool arctic blues on deep slate backgrounds — modern, subdued, and low-glare.',
    tone: 'dark'
  },
  {
    key: 'material-dark',
    label: 'Material Dark',
    era: '2016+',
    description: 'Ink surfaces with bright cyan highlights and elevated panels — a pragmatic “app UI” take on forum chrome.',
    tone: 'dark'
  }
] as const;

export const FORUM_THEME_BY_KEY: Readonly<Record<ForumThemeKey, ForumThemeDefinition>> =
  FORUM_THEMES.reduce((acc, theme) => {
    acc[theme.key] = theme;
    return acc;
  }, {} as Record<ForumThemeKey, ForumThemeDefinition>);

export function themeLabel(key: ForumThemeKey): string {
  return FORUM_THEME_BY_KEY[key]?.label ?? key;
}

export function themeTone(key: ForumThemeKey): 'light' | 'dark' {
  return FORUM_THEME_BY_KEY[key]?.tone ?? 'light';
}
