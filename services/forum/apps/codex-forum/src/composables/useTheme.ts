import { ref } from 'vue';
import { FORUM_THEME_KEYS, type ForumThemeKey } from '@irrigationreal/codex-forum-contracts';
import { themeTone } from '../themes/forumThemes';

const STORAGE_KEY = 'forum-theme';
const theme = ref<ForumThemeKey>('vmonika');
const resolvedTheme = ref<ForumThemeKey>('vmonika');
const resolvedTone = ref<'light' | 'dark'>('dark');

function getSystemTheme(): ForumThemeKey {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vmonika' : 'vmonika-light';
}

function applyTheme(t: ForumThemeKey): void {
  document.documentElement.setAttribute('data-theme', t);
  resolvedTheme.value = t;
  resolvedTone.value = themeTone(t);
}

export function useTheme() {
  function setTheme(newTheme: ForumThemeKey): void {
    theme.value = newTheme;
    localStorage.setItem(STORAGE_KEY, newTheme);
    const resolved = newTheme === 'system' ? getSystemTheme() : newTheme;
    applyTheme(resolved);
  }

  function cycleTheme(): void {
    const pairs: Partial<Record<ForumThemeKey, ForumThemeKey>> = {
      vmonika: 'vmonika-light',
      'vmonika-light': 'vmonika',
      'classic-dark': 'classic-light',
      'classic-light': 'classic-dark',
      system: 'vmonika-light'
    };
    setTheme(pairs[theme.value] ?? 'vmonika');
  }

  function initTheme(): void {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light') {
      theme.value = 'classic-light';
    } else if (saved === 'dark') {
      theme.value = 'classic-dark';
    } else if (saved && FORUM_THEME_KEYS.includes(saved as ForumThemeKey)) {
      theme.value = saved as ForumThemeKey;
    }
    const resolved = theme.value === 'system' ? getSystemTheme() : theme.value;
    applyTheme(resolved);

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => {
        if (theme.value === 'system') {
          applyTheme(getSystemTheme());
        }
      });
  }

  return { theme, resolvedTheme, resolvedTone, setTheme, cycleTheme, initTheme };
}
