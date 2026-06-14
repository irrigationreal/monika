import { ref } from 'vue';
import { FORUM_THEME_KEYS, type ForumThemeKey } from '@irrigationreal/codex-forum-contracts';
import { themeTone } from '../themes/forumThemes';

const STORAGE_KEY = 'forum-theme';
const theme = ref<ForumThemeKey>('system');
const resolvedTheme = ref<ForumThemeKey>('classic-light');
const resolvedTone = ref<'light' | 'dark'>('light');

function getSystemTheme(): ForumThemeKey {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'classic-dark' : 'classic-light';
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
    const order: ForumThemeKey[] = ['system', 'classic-light', 'classic-dark'];
    const currentIndex = order.indexOf(theme.value);
    const nextIndex = (currentIndex === -1 ? 0 : currentIndex + 1) % order.length;
    const next = order[nextIndex] ?? 'system';
    setTheme(next);
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
