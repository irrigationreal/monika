import { createApp, type Component } from 'vue';

import App from './App.vue';
import { router } from './router';

// Import CSS in correct order: theme variables, base styles, components, posts, responsive
import './styles/theme.css';
import 'highlight.js/styles/github-dark-dimmed.css';
import './styles/base.css';
import './styles/components.css';
import './styles/posts.css';
import './styles/timeline.css';
import './styles/chat.css';
import './styles/analytics.css';
import './styles/responsive.css';

// Global event delegation for actions in rendered (v-html) content.
// This keeps the rendering pipeline simple (string → HTML) while still enabling
// small interactive widgets like a "copy" button in code blocks.
document.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;

  const button = target.closest?.('button.vb-code-copy') as HTMLButtonElement | null;
  if (!button) return;

  const block = button.closest?.('.vb-code-block') as HTMLElement | null;
  const codeEl = block?.querySelector?.('pre.vb-code code') as HTMLElement | null;
  const text = codeEl?.textContent ?? '';
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const previous = button.textContent;
    button.textContent = 'Copied';
    window.setTimeout(() => {
      button.textContent = previous || 'Copy';
    }, 1200);
  } catch {
    // Best-effort fallback when clipboard API is blocked (e.g. non-HTTPS).
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
      const previous = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = previous || 'Copy';
      }, 1200);
    } finally {
      document.body.removeChild(textarea);
    }
  }
});

createApp(App as unknown as Component).use(router).mount('#app');
