import { watch } from 'vue';

import DOMPurify from 'dompurify';

import { MERMAID_MAX_SOURCE_CHARS } from '../composables/useMarkdown';
import { useTheme } from '../composables/useTheme';

import type { Mermaid, MermaidConfig } from 'mermaid';
import type { Directive } from 'vue';

const MAX_DIAGRAMS_PER_ROOT = 10;
const MAX_EDGES = 200;
const roots = new Set<HTMLElement>();
const exportSvgByBlock = new WeakMap<HTMLElement, string>();
const observedBlocks = new WeakSet<HTMLElement>();
const blocksByRoot = new WeakMap<HTMLElement, Set<HTMLElement>>();
let mermaidPromise: Promise<Mermaid> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let renderSequence = 0;
let observer: IntersectionObserver | null = null;
let actionsInstalled = false;
let themeWatchInstalled = false;
let themeRevision = 0;

const SECURE_CONFIG_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'theme',
  'themeVariables',
  'themeCSS',
  'fontFamily',
  'altFontFamily',
  'darkMode',
  'look',
  'layout',
];

function cssVariable(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

export function mermaidConfigForCurrentTheme(): MermaidConfig {
  const styles = getComputedStyle(document.documentElement);
  const { resolvedTone } = useTheme();
  const darkMode = resolvedTone.value === 'dark';

  return {
    startOnLoad: false,
    securityLevel: 'sandbox',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MERMAID_MAX_SOURCE_CHARS,
    maxEdges: MAX_EDGES,
    secure: SECURE_CONFIG_KEYS,
    theme: 'base',
    darkMode,
    fontFamily: cssVariable(styles, '--font-body', 'Verdana, sans-serif'),
    themeVariables: {
      darkMode,
      background: cssVariable(styles, '--bg-surface', darkMode ? '#171717' : '#ffffff'),
      primaryColor: cssVariable(styles, '--bg-surface-alt', darkMode ? '#242424' : '#f5f5ff'),
      primaryTextColor: cssVariable(styles, '--text-primary', darkMode ? '#f5f5f5' : '#111111'),
      primaryBorderColor: cssVariable(styles, '--brand-primary', darkMode ? '#60a5fa' : '#0b198c'),
      secondaryColor: cssVariable(styles, '--bg-surface-muted', darkMode ? '#303030' : '#e1e4f2'),
      tertiaryColor: cssVariable(styles, '--bg-quote', darkMode ? '#202830' : '#f0f4f8'),
      lineColor: cssVariable(styles, '--brand-secondary', darkMode ? '#9ca3af' : '#5c7099'),
      textColor: cssVariable(styles, '--text-primary', darkMode ? '#f5f5f5' : '#111111'),
      noteBkgColor: cssVariable(styles, '--bg-highlight', darkMode ? '#4a3f16' : '#fff59d'),
      noteTextColor: cssVariable(styles, '--text-primary', darkMode ? '#f5f5f5' : '#111111'),
      noteBorderColor: cssVariable(styles, '--brand-secondary', darkMode ? '#9ca3af' : '#5c7099'),
    },
  };
}

function sourceForBlock(block: HTMLElement): string {
  return block.querySelector<HTMLElement>('.vb-mermaid-source code')?.textContent ?? '';
}

function setStatus(block: HTMLElement, message: string): void {
  const status = block.querySelector<HTMLElement>('.vb-mermaid-status');
  if (status) status.textContent = message;
}

function rejectUnsafeConfiguration(source: string): string | null {
  if (/^\s*---\s*(?:\r?\n|$)/.test(source)) {
    return 'Diagram configuration front matter is disabled in forum posts.';
  }
  if (/%%\s*\{/i.test(source)) {
    return 'Mermaid initialization directives are disabled in forum posts.';
  }
  return null;
}

function decodeBase64Utf8(encoded: string): string {
  const binary = window.atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface SandboxedMermaidResult {
  heightPx: number;
  sourceUrl: string;
  svg: string;
}

export function parseSandboxedMermaidResult(markup: string): SandboxedMermaidResult {
  const documentResult = new DOMParser().parseFromString(markup, 'text/html');
  const iframe = documentResult.querySelector('iframe');
  if (!iframe?.hasAttribute('sandbox')) {
    throw new Error('Mermaid did not return an isolated sandbox frame.');
  }
  const sandboxTokens = (iframe.getAttribute('sandbox') ?? '').trim().split(/\s+/).filter(Boolean);
  const expectedMermaidTokens = new Set(['allow-popups', 'allow-top-navigation-by-user-activation']);
  if (sandboxTokens.some((token) => !expectedMermaidTokens.has(token))) {
    throw new Error('Mermaid requested unexpected sandbox permissions.');
  }

  const sourceUrl = iframe.getAttribute('src') ?? '';
  const prefix = 'data:text/html;charset=UTF-8;base64,';
  if (!sourceUrl.startsWith(prefix)) {
    throw new Error('Mermaid returned an unexpected sandbox document URL.');
  }

  const sandboxHtml = decodeBase64Utf8(sourceUrl.slice(prefix.length));
  const sandboxDocument = new DOMParser().parseFromString(sandboxHtml, 'text/html');
  const svg = sandboxDocument.querySelector('svg');
  if (!svg) throw new Error('Mermaid sandbox output did not contain an SVG diagram.');

  const style = iframe.getAttribute('style') ?? '';
  const heightMatch = /(?:^|;)\s*height:\s*([0-9.]+)px(?:;|$)/i.exec(style);
  const requestedHeight = Number(heightMatch?.[1] ?? 420);

  return {
    heightPx: Number.isFinite(requestedHeight) ? Math.min(Math.max(requestedHeight, 240), 900) : 420,
    sourceUrl,
    svg: new XMLSerializer().serializeToString(svg),
  };
}

export function sanitizeMermaidSvgForExport(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'a'],
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset', 'onload', 'onclick', 'onerror', 'onmouseover'],
    ALLOW_DATA_ATTR: false,
  });
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  if (parsed.documentElement.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) return '';

  const removeExternalCssUrls = (value: string): string =>
    value.replace(/@import\s+[^;]+;?/gi, '').replace(/url\(\s*(['"]?)(?!#)[^)]+\1\s*\)/gi, 'none');
  parsed.querySelectorAll('style').forEach((style) => {
    style.textContent = removeExternalCssUrls(style.textContent);
  });
  parsed.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    element.setAttribute('style', removeExternalCssUrls(element.getAttribute('style') ?? ''));
  });

  return new XMLSerializer().serializeToString(parsed.documentElement);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function controlledSandboxUrl(svg: string): string {
  const html = [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">`,
    '<meta name="color-scheme" content="light dark">',
    '<style>html,body{margin:0;overflow:auto}svg{display:block;max-width:100%;height:auto;margin:auto}</style>',
    '</head><body>',
    svg,
    '</body></html>',
  ].join('');
  return `data:text/html;charset=UTF-8;base64,${encodeBase64Utf8(html)}`;
}

function mountSandboxFrame(block: HTMLElement, result: SandboxedMermaidResult, exportSvg: string): void {
  const target = block.querySelector<HTMLElement>('.vb-mermaid-render');
  if (!target) throw new Error('Mermaid rendering target is missing.');

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.src = controlledSandboxUrl(exportSvg);
  iframe.title = 'Mermaid diagram';
  iframe.style.height = `${String(result.heightPx)}px`;
  target.replaceChildren(iframe);
}

async function loadMermaid(): Promise<Mermaid> {
  // Mermaid is intentionally kept out of the initial forum bundle.
  // eslint-disable-next-line dollarwise/no-dynamic-imports
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
}

async function renderBlock(block: HTMLElement): Promise<void> {
  if (!block.isConnected || block.dataset['mermaidState'] !== 'queued') return;

  const source = sourceForBlock(block);
  const configurationError = rejectUnsafeConfiguration(source);
  if (configurationError) {
    block.dataset['mermaidState'] = 'rejected';
    setStatus(block, configurationError);
    block.querySelector<HTMLDetailsElement>('.vb-mermaid-source')?.setAttribute('open', '');
    return;
  }

  if (source.length > MERMAID_MAX_SOURCE_CHARS) {
    block.dataset['mermaidState'] = 'rejected';
    setStatus(
      block,
      `Diagram source exceeds the ${MERMAID_MAX_SOURCE_CHARS.toLocaleString()} character rendering limit.`
    );
    return;
  }

  const sourceAtStart = source;
  const themeRevisionAtStart = themeRevision;
  block.dataset['mermaidState'] = 'rendering';
  setStatus(block, 'Rendering diagram…');

  try {
    const mermaid = await loadMermaid();
    mermaid.initialize(mermaidConfigForCurrentTheme());
    const renderId = `forum-mermaid-${Date.now().toString(36)}-${String(renderSequence++)}`;
    const rendered = await mermaid.render(renderId, sourceAtStart);
    const parsed = parseSandboxedMermaidResult(rendered.svg);
    const exportSvg = sanitizeMermaidSvgForExport(parsed.svg);
    if (!exportSvg.includes('<svg')) throw new Error('Sanitization removed the exported diagram.');

    // Vue may replace a v-html subtree while Mermaid's asynchronous render is running.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!block.isConnected || sourceForBlock(block) !== sourceAtStart) return;
    if (themeRevisionAtStart !== themeRevision) {
      block.dataset['mermaidState'] = 'pending';
      queueBlock(block);
      return;
    }
    mountSandboxFrame(block, parsed, exportSvg);
    exportSvgByBlock.set(block, exportSvg);
    block.dataset['mermaidState'] = 'rendered';
    setStatus(block, 'Diagram rendered.');
    block.querySelectorAll<HTMLButtonElement>('.vb-mermaid-open, .vb-mermaid-download').forEach((button) => {
      button.disabled = false;
    });
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!block.isConnected || sourceForBlock(block) !== sourceAtStart) return;
    block.dataset['mermaidState'] = 'error';
    const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
    setStatus(block, `Diagram could not be rendered.${detail}`);
    block.querySelector<HTMLDetailsElement>('.vb-mermaid-source')?.setAttribute('open', '');
  }
}

function queueBlock(block: HTMLElement): void {
  if (block.dataset['mermaidState'] !== 'pending') return;
  block.dataset['mermaidState'] = 'queued';
  renderQueue = renderQueue.then(() => renderBlock(block));
}

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        observedBlocks.delete(entry.target as HTMLElement);
        queueBlock(entry.target as HTMLElement);
      }
    },
    { rootMargin: '300px 0px' }
  );
  return observer;
}

function enhanceRoot(root: HTMLElement): void {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.vb-mermaid-block[data-mermaid-state="pending"]'));
  const registered = blocksByRoot.get(root) ?? new Set<HTMLElement>();
  blocksByRoot.set(root, registered);
  blocks.forEach((block, index) => {
    registered.add(block);
    if (index >= MAX_DIAGRAMS_PER_ROOT) {
      block.dataset['mermaidState'] = 'rejected';
      setStatus(
        block,
        `Only the first ${String(MAX_DIAGRAMS_PER_ROOT)} diagrams in this rendered section are displayed.`
      );
      block.querySelector<HTMLDetailsElement>('.vb-mermaid-source')?.setAttribute('open', '');
      return;
    }
    if (observedBlocks.has(block)) return;
    observedBlocks.add(block);
    const intersectionObserver = getObserver();
    if (intersectionObserver) intersectionObserver.observe(block);
    else queueBlock(block);
  });
}

function unobserveRootBlocks(root: HTMLElement): void {
  const blocks = blocksByRoot.get(root);
  if (!blocks) return;
  for (const block of blocks) {
    observer?.unobserve(block);
    observedBlocks.delete(block);
  }
  blocks.clear();
}

function scheduleEnhancement(root: HTMLElement): void {
  queueMicrotask(() => {
    if (root.isConnected) enhanceRoot(root);
  });
}

function resetForTheme(block: HTMLElement): void {
  if (block.dataset['mermaidState'] !== 'rendered') return;
  block.querySelector('.vb-mermaid-render')?.replaceChildren();
  block.querySelectorAll<HTMLButtonElement>('.vb-mermaid-open, .vb-mermaid-download').forEach((button) => {
    button.disabled = true;
  });
  exportSvgByBlock.delete(block);
  block.dataset['mermaidState'] = 'pending';
  queueBlock(block);
}

function installThemeWatch(): void {
  if (themeWatchInstalled) return;
  themeWatchInstalled = true;
  const { resolvedTheme } = useTheme();
  watch(resolvedTheme, () => {
    themeRevision += 1;
    for (const root of roots) {
      root.querySelectorAll<HTMLElement>('.vb-mermaid-block').forEach(resetForTheme);
    }
  });
}

function svgBlob(block: HTMLElement): Blob | null {
  const svg = exportSvgByBlock.get(block);
  return svg ? new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }) : null;
}

async function handleMermaidAction(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement | null;
  const block = target?.closest<HTMLElement>('.vb-mermaid-block');
  if (!target || !block) return;

  if (target.closest('.vb-mermaid-copy')) {
    const source = sourceForBlock(block);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
    } catch {
      setStatus(block, 'Copy failed. Select the diagram source and copy it manually.');
      block.querySelector<HTMLDetailsElement>('.vb-mermaid-source')?.setAttribute('open', '');
      return;
    }
    const button = target.closest<HTMLButtonElement>('.vb-mermaid-copy');
    if (button) {
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = 'Copy source';
      }, 1200);
    }
    return;
  }

  const openRequested = Boolean(target.closest('.vb-mermaid-open'));
  const downloadRequested = Boolean(target.closest('.vb-mermaid-download'));
  if (!openRequested && !downloadRequested) return;

  const blob = svgBlob(block);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);

  if (openRequested) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (downloadRequested) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mermaid-diagram.svg';
    anchor.click();
  }
}

function installActions(): void {
  if (actionsInstalled) return;
  actionsInstalled = true;
  document.addEventListener('click', (event) => {
    void handleMermaidAction(event);
  });
}

export const enhanceMermaidDirective: Directive<HTMLElement> = {
  mounted(element) {
    roots.add(element);
    installThemeWatch();
    installActions();
    scheduleEnhancement(element);
  },
  updated(element) {
    roots.add(element);
    unobserveRootBlocks(element);
    scheduleEnhancement(element);
  },
  beforeUnmount(element) {
    unobserveRootBlocks(element);
    roots.delete(element);
  },
};
