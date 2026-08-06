import { marked } from 'marked';

const renderer = new marked.Renderer();

renderer.link = ({ href, title, text }) => {
  const safeUrl = sanitizeUrl(href ?? '');
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
};

renderer.image = ({ href, title, text }) => {
  const safeUrl = sanitizeImgSrc(href ?? '');
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  const altText = escapeHtml(text ?? '');
  return `<img src="${safeUrl}" alt="${altText}" class="vb-user-image" loading="lazy"${titleAttr} />`;
};

renderer.codespan = ({ text }) => {
  // Inline code should always be literal text (no HTML rendering).
  return `<code>${escapeHtml(text)}</code>`;
};

// Configure marked for safe rendering
marked.setOptions({
  gfm: true,
  breaks: true,
  renderer
});

// BBCode patterns and their HTML replacements
const bbcodePatterns: Array<{
  pattern: RegExp;
  replacement: string | ((match: string, ...args: string[]) => string);
}> = [
  // Bold: [b]text[/b] or [B]text[/B]
  { pattern: /\[b\]([\s\S]*?)\[\/b\]/gi, replacement: '<strong>$1</strong>' },

  // Italic: [i]text[/i] or [I]text[/I]
  { pattern: /\[i\]([\s\S]*?)\[\/i\]/gi, replacement: '<em>$1</em>' },

  // Underline: [u]text[/u]
  { pattern: /\[u\]([\s\S]*?)\[\/u\]/gi, replacement: '<u>$1</u>' },

  // Strikethrough: [s]text[/s]
  { pattern: /\[s\]([\s\S]*?)\[\/s\]/gi, replacement: '<del>$1</del>' },

  // URL with text: [url=http://...]text[/url]
  {
    pattern: /\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi,
    replacement: (_match: string, url: string, text: string) => {
      const safeUrl = sanitizeUrl(url);
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
    }
  },

  // URL without text: [url]http://...[/url]
  {
    pattern: /\[url\]([\s\S]*?)\[\/url\]/gi,
    replacement: (_match: string, url: string) => {
      const safeUrl = sanitizeUrl(url);
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    }
  },

  // Image: [img]url[/img]
  {
    pattern: /\[img\]([\s\S]*?)\[\/img\]/gi,
    replacement: (_match: string, url: string) => {
      const safeUrl = sanitizeUrl(url);
      return `<img src="${safeUrl}" alt="User image" class="vb-user-image" loading="lazy" />`;
    }
  },

  // Quote with author: [quote=Author]text[/quote]
  {
    pattern: /\[quote=([^\]]+)\]([\s\S]*?)\[\/quote\]/gi,
    replacement: '<blockquote class="vb-quote"><cite>$1 wrote:</cite><p>$2</p></blockquote>'
  },

  // Quote without author: [quote]text[/quote]
  { pattern: /\[quote\]([\s\S]*?)\[\/quote\]/gi, replacement: '<blockquote class="vb-quote"><p>$1</p></blockquote>' },

  // Code block: [code]text[/code]
  { pattern: /\[code\]([\s\S]*?)\[\/code\]/gi, replacement: '<pre class="vb-code"><code>$1</code></pre>' },

  // Inline code: [c]text[/c] or [inline]text[/inline]
  { pattern: /\[c\]([\s\S]*?)\[\/c\]/gi, replacement: '<code class="vb-inline-code">$1</code>' },
  { pattern: /\[inline\]([\s\S]*?)\[\/inline\]/gi, replacement: '<code class="vb-inline-code">$1</code>' },

  // Color: [color=red]text[/color]
  {
    pattern: /\[color=([^\]]+)\]([\s\S]*?)\[\/color\]/gi,
    replacement: (_match: string, color: string, text: string) => {
      // Only allow safe color values
      const safeColor = sanitizeColor(color);
      return `<span style="color: ${safeColor}">${text}</span>`;
    }
  },

  // Size: [size=3]text[/size] (1-7 scale like HTML font size)
  {
    pattern: /\[size=([^\]]+)\]([\s\S]*?)\[\/size\]/gi,
    replacement: (_match: string, size: string, text: string) => {
      const sizeMap: Record<string, string> = {
        '1': '0.7em', '2': '0.85em', '3': '1em', '4': '1.2em',
        '5': '1.4em', '6': '1.6em', '7': '2em',
        'small': '0.85em', 'medium': '1em', 'large': '1.4em'
      };
      const safeSize = sizeMap[size.toLowerCase()] ?? '1em';
      return `<span style="font-size: ${safeSize}">${text}</span>`;
    }
  },

  // List: [list][*]item[/list]
  {
    pattern: /\[list\]([\s\S]*?)\[\/list\]/gi,
    replacement: (_match: string, content: string) => {
      const items = content.split(/\[\*\]/).filter(item => item.trim());
      const listItems = items.map(item => `<li>${item.trim()}</li>`).join('');
      return `<ul class="vb-list">${listItems}</ul>`;
    }
  },

  // Ordered list: [list=1][*]item[/list]
  {
    pattern: /\[list=\d\]([\s\S]*?)\[\/list\]/gi,
    replacement: (_match: string, content: string) => {
      const items = content.split(/\[\*\]/).filter(item => item.trim());
      const listItems = items.map(item => `<li>${item.trim()}</li>`).join('');
      return `<ol class="vb-list">${listItems}</ol>`;
    }
  },

  // Center: [center]text[/center]
  { pattern: /\[center\]([\s\S]*?)\[\/center\]/gi, replacement: '<div style="text-align: center">$1</div>' },

  // Spoiler: [spoiler]text[/spoiler]
  {
    pattern: /\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi,
    replacement: '<details class="vb-spoiler"><summary>Spoiler (click to reveal)</summary><div>$1</div></details>'
  },

  // Spoiler with title: [spoiler=Title]text[/spoiler]
  {
    pattern: /\[spoiler=([^\]]+)\]([\s\S]*?)\[\/spoiler\]/gi,
    replacement: '<details class="vb-spoiler"><summary>$1 (click to reveal)</summary><div>$2</div></details>'
  },

  // HR: [hr]
  { pattern: /\[hr\]/gi, replacement: '<hr class="vb-hr" />' }
];

type CodeBlockReplacement = {
  html: string;
  token: string;
};

export const MERMAID_MAX_SOURCE_CHARS = 20_000;

function renderMermaidBlockHtml(rawSource: string): string {
  const source = escapeHtml(rawSource);
  const oversized = rawSource.length > MERMAID_MAX_SOURCE_CHARS;
  const state = oversized ? 'rejected' : 'pending';
  const status = oversized
    ? `Diagram source exceeds the ${MERMAID_MAX_SOURCE_CHARS.toLocaleString()} character rendering limit.`
    : 'Diagram waiting to render…';

  return [
    `<figure class="vb-mermaid-block" data-mermaid-state="${state}">`,
    '  <figcaption class="vb-mermaid-toolbar">',
    '    <span class="vb-mermaid-label">Mermaid</span>',
    '    <button class="vb-mermaid-open" type="button" disabled>Open full size</button>',
    '    <button class="vb-mermaid-download" type="button" disabled>Download SVG</button>',
    '    <button class="vb-mermaid-copy" type="button">Copy source</button>',
    '  </figcaption>',
    '  <div class="vb-mermaid-render" aria-label="Mermaid diagram"></div>',
    `  <p class="vb-mermaid-status" role="status">${escapeHtml(status)}</p>`,
    `  <details class="vb-mermaid-source"${oversized ? ' open' : ''}>`,
    '    <summary>Diagram source</summary>',
    `    <pre class="vb-code"><code>${source}</code></pre>`,
    '  </details>',
    '</figure>'
  ].join('');
}

type InlineCodeReplacement = {
  html: string;
  token: string;
};

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (m) => map[m] ?? m);
}

function normalizeCodeLanguage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Markdown info strings and forum-style tags sometimes include extra tokens
  // (e.g. "ts linenums", "ts title=..."). We only treat the first token as the
  // language hint.
  const cleaned = raw.trim().toLowerCase().split(/[\s{,]/)[0] ?? '';
  if (!cleaned) return undefined;

  // Common GitHub / Markdown / CLI aliases → highlight.js language keys.
  // (highlight.js supports many languages, but not every GitHub Linguist entry.)
  const aliasMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    node: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    yml: 'yaml',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    ps1: 'powershell',
    csharp: 'cs',
    'c#': 'cs',
    'f#': 'fsharp',
    'c++': 'cpp',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    h: 'c',
    golang: 'go',
    md: 'markdown'
  };

  return aliasMap[cleaned] ?? cleaned;
}

function stripSingleSurroundingNewline(text: string): string {
  let result = text;
  if (result.startsWith('\r\n')) result = result.slice(2);
  else if (result.startsWith('\n')) result = result.slice(1);

  if (result.endsWith('\r\n')) result = result.slice(0, -2);
  else if (result.endsWith('\n')) result = result.slice(0, -1);

  return result;
}

function renderCodeBlockHtml(rawCode: string, rawLanguage: string | undefined): string {
  const isLanguageExplicit = !!rawLanguage?.trim();
  const language = normalizeCodeLanguage(rawLanguage);

  // Code blocks should always be literal text (no HTML rendering).
  const resolvedLanguage = isLanguageExplicit ? language : (language ?? 'markdown');
  const languageClass = resolvedLanguage ? ` language-${escapeHtml(resolvedLanguage)}` : '';
  const languageLabel = isLanguageExplicit && resolvedLanguage
    ? `<span class="vb-code-lang">${escapeHtml(resolvedLanguage)}</span>`
    : '';

  return [
    '<div class="vb-code-block">',
    '  <div class="vb-code-toolbar">',
    languageLabel,
    '    <button class="vb-code-copy" type="button">Copy</button>',
    '  </div>',
    `  <pre class="vb-code"><code class="vb-code-content${languageClass}">${escapeHtml(rawCode)}</code></pre>`,
    '</div>'
  ].join('');
}

interface SourceLine {
  content: string;
  contentEnd: number;
  end: number;
  start: number;
}

function readSourceLine(text: string, start: number): SourceLine {
  const newline = text.indexOf('\n', start);
  const end = newline === -1 ? text.length : newline + 1;
  let contentEnd = newline === -1 ? text.length : newline;
  if (contentEnd > start && text[contentEnd - 1] === '\r') contentEnd -= 1;
  return { start, contentEnd, end, content: text.slice(start, contentEnd) };
}

function makePlaceholderPrefix(text: string, label: string): string {
  let prefix = `VB${label}PLACEHOLDER`;
  while (text.includes(prefix)) prefix += 'X';
  return prefix;
}

function compatibleFenceIndent(opening: string, closing: string): boolean {
  if (opening === closing) return true;
  // At the document level CommonMark permits up to three leading spaces on
  // either line. Deeper/list indentation is preserved by requiring an exact
  // match, which avoids pulling a closing fence out of its container.
  return /^ {0,3}$/.test(opening) && /^ {0,3}$/.test(closing);
}

interface MarkdownFenceBlock {
  closed: boolean;
  code: string;
  end: number;
  indent: string;
  info: string;
  resumeAt: number;
  start: number;
}

interface BbCodeBlock {
  code: string;
  end: number;
  language: string | undefined;
  start: number;
}

function findNextMarkdownFence(text: string, from: number): MarkdownFenceBlock | null {
  let position = from;
  if (position > 0 && text[position - 1] !== '\n') {
    const nextLine = text.indexOf('\n', position);
    if (nextLine === -1) return null;
    position = nextLine + 1;
  }

  while (position < text.length) {
    const openingLine = readSourceLine(text, position);
    const opening = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)$/.exec(openingLine.content);
    if (!opening || (opening[2]?.startsWith('`') && opening[3]?.includes('`'))) {
      position = openingLine.end;
      continue;
    }

    const indent = opening[1] ?? '';
    const markerRun = opening[2] ?? '';
    const marker = markerRun.charAt(0);
    const info = opening[3] ?? '';
    let closingLine: SourceLine | null = null;
    let searchPosition = openingLine.end;

    while (searchPosition < text.length) {
      const candidateLine = readSourceLine(text, searchPosition);
      const candidate = /^([ \t]*)(`+|~+)[ \t]*$/.exec(candidateLine.content);
      const candidateRun = candidate?.[2] ?? '';
      if (
        candidate &&
        candidateRun.startsWith(marker) &&
        candidateRun.length >= markerRun.length &&
        compatibleFenceIndent(indent, candidate[1] ?? '')
      ) {
        closingLine = candidateLine;
        break;
      }
      searchPosition = candidateLine.end;
    }

    const codeStart = openingLine.end;
    let codeEnd = closingLine?.start ?? text.length;
    if (closingLine) {
      if (codeEnd >= 2 && text.slice(codeEnd - 2, codeEnd) === '\r\n') codeEnd -= 2;
      else if (codeEnd > codeStart && (text[codeEnd - 1] === '\n' || text[codeEnd - 1] === '\r')) codeEnd -= 1;
    }

    return {
      closed: closingLine !== null,
      code: text.slice(codeStart, codeEnd),
      end: closingLine?.contentEnd ?? text.length,
      indent,
      info,
      resumeAt: closingLine?.end ?? text.length,
      start: openingLine.start
    };
  }

  return null;
}

function findNextBbCodeBlock(text: string, from: number): BbCodeBlock | null {
  const openingPattern = /\[code(?:=([^\]]+))?\]/gi;
  openingPattern.lastIndex = from;

  for (let opening = openingPattern.exec(text); opening; opening = openingPattern.exec(text)) {
    const closingPattern = /\[\/code\]/gi;
    closingPattern.lastIndex = openingPattern.lastIndex;
    const closing = closingPattern.exec(text);
    if (!closing) return null;

    return {
      code: text.slice(openingPattern.lastIndex, closing.index),
      end: closing.index + closing[0].length,
      language: opening[1],
      start: opening.index
    };
  }

  return null;
}

function appendBlockPlaceholder(result: string, indent: string, token: string): string {
  let next = result;
  if (next && !/(?:\r?\n){2}$/.test(next)) next += /\r?\n$/.test(next) ? '\n' : '\n\n';
  return `${next}${indent}${token}\n\n`;
}

function replaceCodeBlocksWithPlaceholders(text: string): { text: string; replacements: CodeBlockReplacement[] } {
  const replacements: CodeBlockReplacement[] = [];
  const tokenPrefix = makePlaceholderPrefix(text, 'CODEBLOCK');
  let result = '';
  let copiedThrough = 0;
  let position = 0;

  // Markdown and BBCode blocks share one source-ordered scanner. Whichever
  // valid opener occurs first owns its contents, so delimiter-like text inside
  // either block remains literal and cannot pair with a closer outside it.
  while (position < text.length) {
    const markdown = findNextMarkdownFence(text, position);
    const bbcode = findNextBbCodeBlock(text, position);
    const markdownFirst = Boolean(markdown && (!bbcode || markdown.start < bbcode.start));
    const block = markdownFirst ? markdown : bbcode;
    if (!block) break;

    result += text.slice(copiedThrough, block.start);
    const token = `${tokenPrefix}${String(replacements.length)}TOKEN`;
    if (markdownFirst && markdown) {
      const language = normalizeCodeLanguage(markdown.info);
      const html = language === 'mermaid' && markdown.closed
        ? renderMermaidBlockHtml(markdown.code)
        : renderCodeBlockHtml(markdown.code, markdown.info);
      replacements.push({ token, html });
      result = appendBlockPlaceholder(result, markdown.indent, token);
      copiedThrough = markdown.end;
      position = markdown.resumeAt;
    } else if (bbcode) {
      const normalizedCode = stripSingleSurroundingNewline(bbcode.code);
      replacements.push({ token, html: renderCodeBlockHtml(normalizedCode, bbcode.language) });
      result = appendBlockPlaceholder(result, '', token);
      copiedThrough = bbcode.end;
      position = bbcode.end;
    }
  }

  return { text: result + text.slice(copiedThrough), replacements };
}

function replaceInlineCodeWithPlaceholders(text: string): { text: string; replacements: InlineCodeReplacement[] } {
  const replacements: InlineCodeReplacement[] = [];
  let result = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char !== '`') {
      result += char;
      index += 1;
      continue;
    }

    let tickCount = 1;
    while (index + tickCount < text.length && text[index + tickCount] === '`') {
      tickCount += 1;
    }

    const delimiter = '`'.repeat(tickCount);
    const start = index + tickCount;
    const end = text.indexOf(delimiter, start);
    if (end === -1) {
      result += delimiter;
      index = start;
      continue;
    }

    let code = text.slice(start, end);
    if (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
      code = code.slice(1, -1);
    }

    const token = `@@INLINE_CODE_TOKEN_${replacements.length}@@`;
    replacements.push({ token, html: `<code>${escapeHtml(code)}</code>` });
    result += token;
    index = end + tickCount;
  }

  return { text: result, replacements };
}

function replaceLigatures(text: string): string {
  return text
    .replace(/\.\.\./g, '…')
    .replace(/--/g, '—')
    .replace(/\(tm\)/gi, '™')
    .replace(/\(r\)/gi, '®')
    .replace(/\(c\)/gi, '©')
    .replace(/<->/g, '↔')
    .replace(/<-/g, '←')
    .replace(/->/g, '→')
    .replace(/=>/g, '⇒')
    .replace(/<=/g, '≤')
    .replace(/>=/g, '≥')
    .replace(/!=/g, '≠')
    .replace(/\b3\/4\b/g, '¾')
    .replace(/\b1\/2\b/g, '½')
    .replace(/\b1\/3\b/g, '⅓')
    .replace(/\b1\/4\b/g, '¼');
}

function decodeHtmlEntities(value: string): string {
  if (typeof document === 'undefined') {
    return value
      .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#0?39;/g, "'");
  }

  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizeUrlCandidate(url: string): string {
  const decoded = decodeHtmlEntities(url);
  // Remove whitespace and ASCII control chars to prevent scheme smuggling like:
  // "java\nscript:" or "java&#x0D;script:".
  return decoded.replace(/[\u0000-\u001f\u007f\s]+/g, '').trim();
}

function isLocalhostHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
}

function sanitizeUrl(url: string): string {
  const normalized = normalizeUrlCandidate(url);
  const lower = normalized.toLowerCase();

  // Disallow dangerous schemes outright (even if they somehow sneak past other checks).
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:') || lower.startsWith('file:')) {
    return '#';
  }

  // Only allow http, https, and site-relative URLs.
  if (normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('/')) {
    return normalized;
  }

  // Disallow protocol-relative URLs (//example.com)
  if (normalized.startsWith('//')) {
    return '#';
  }

  // Assume https if no protocol
  if (normalized.match(/^[\w.-]+\.\w+/)) {
    return `https://${normalized}`;
  }

  return '#';
}

function sanitizeImgSrc(src: string): string {
  const safe = sanitizeUrl(src);
  if (safe === '#') return '#';

  // Block localhost / loopback image sources (covers common "local file" bypass attempts).
  if (safe.startsWith('http://') || safe.startsWith('https://')) {
    try {
      const parsed = new URL(safe);
      if (isLocalhostHostname(parsed.hostname)) return '#';
    } catch {
      return '#';
    }
  }

  return safe;
}

function sanitizeColor(color: string): string {
  // Allow named colors, hex colors, rgb/rgba
  const trimmed = color.trim().toLowerCase();
  // Named colors
  const namedColors = [
    'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
    'pink', 'brown', 'gray', 'grey', 'cyan', 'magenta', 'lime', 'navy',
    'teal', 'maroon', 'olive', 'silver', 'aqua', 'fuchsia'
  ];
  if (namedColors.includes(trimmed)) {
    return trimmed;
  }
  // Hex colors
  if (/^#[0-9a-f]{3,6}$/i.test(trimmed)) {
    return trimmed;
  }
  // RGB/RGBA
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/i.test(trimmed)) {
    return trimmed;
  }
  return 'inherit';
}

function parseBBCode(text: string): string {
  let result = text;
  for (const { pattern, replacement } of bbcodePatterns) {
    if (typeof replacement === 'string') {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement as (...args: string[]) => string);
    }
  }
  return result;
}

const allowedHtmlTags = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'div', 'span', 'button',
  'ul', 'ol', 'li',
  'blockquote', 'hr',
  'pre', 'code',
  'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td'
]);

const forbiddenHtmlTags = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'form',
  'input',
  'textarea',
  'select',
  'svg',
  'math'
]);

const alwaysStripAttributes = new Set(['style', 'srcdoc', 'formaction', 'xlink:href']);

function sanitizeElementAttributes(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (alwaysStripAttributes.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
  }

  const tag = el.tagName.toLowerCase();

  if (tag === 'a') {
    const hrefRaw = el.getAttribute('href') ?? '';
    const safeHref = sanitizeUrl(hrefRaw);
    el.setAttribute('href', safeHref);
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!['href', 'title', 'target', 'rel', 'class'].includes(name)) {
        el.removeAttribute(attr.name);
      }
    }

    return;
  }

  if (tag === 'img') {
    const srcRaw = el.getAttribute('src') ?? '';
    const safeSrc = sanitizeImgSrc(srcRaw);
    el.setAttribute('src', safeSrc);
    if (!el.getAttribute('loading')) {
      el.setAttribute('loading', 'lazy');
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!['src', 'alt', 'title', 'loading', 'class'].includes(name)) {
        el.removeAttribute(attr.name);
      }
    }

    return;
  }

  const tableAllowedAttrsByTag: Record<string, string[]> = {
    table: ['class'],
    thead: ['class'],
    tbody: ['class'],
    tr: ['class'],
    th: ['class', 'colspan', 'rowspan', 'scope'],
    td: ['class', 'colspan', 'rowspan']
  };

  const codeBlockAllowedAttrsByTag: Record<string, string[]> = {
    div: ['class'],
    span: ['class'],
    button: ['class', 'type']
  };

  const allowed = tableAllowedAttrsByTag[tag];
  if (allowed) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!allowed.includes(name)) {
        el.removeAttribute(attr.name);
      }
    }
    return;
  }

  const codeBlockAllowed = codeBlockAllowedAttrsByTag[tag];
  if (codeBlockAllowed) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!codeBlockAllowed.includes(name)) {
        el.removeAttribute(attr.name);
      }
    }
    return;
  }

  // Default: only keep class, drop everything else.
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name !== 'class') {
      el.removeAttribute(attr.name);
    }
  }
}

function sanitizeRenderedHtml(html: string): string {
  if (typeof document === 'undefined') {
    // Fallback: no DOM available. Keep the previous behavior (escape all) to
    // avoid accidental unsafe rendering in non-browser environments.
    return escapeHtml(html);
  }

  const template = document.createElement('template');
  template.innerHTML = html;

  const sanitizeNode = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();

        // <code> / <pre> should always display literal text.
        // If they contain actual HTML elements, convert the raw markup to text so
        // nothing inside renders or executes.
        //
        // Important: do this before sanitizing children so we don't drop tags
        // like <script> inside code blocks (they should display as text).
        if (tag === 'code') {
          const rawInnerHtml = el.innerHTML;
          if (rawInnerHtml.includes('<')) {
            el.textContent = rawInnerHtml;
          }
          sanitizeElementAttributes(el);
          continue;
        }

        if (tag === 'pre') {
          // Our renderer uses <pre><code>...</code></pre>. Keep that structure
          // intact so code blocks render normally.
          const hasCodeChild = Boolean(el.querySelector('code'));
          const hasNonCodeElementChild = Array.from(el.children).some(
            (childEl) => childEl.tagName.toLowerCase() !== 'code'
          );
          // If a <pre> contains any non-<code> element children, treat the whole
          // thing as literal so tags like <img> can't render inside a code block.
          if (!hasCodeChild || hasNonCodeElementChild) {
            const rawInnerHtml = el.innerHTML;
            if (rawInnerHtml.includes('<')) {
              el.textContent = rawInnerHtml;
            }
            sanitizeElementAttributes(el);
            continue;
          }
        }

        if (forbiddenHtmlTags.has(tag)) {
          el.remove();
          continue;
        }

        // First sanitize children, then decide whether to keep/unwrap the element.
        sanitizeNode(el);

        if (!allowedHtmlTags.has(tag)) {
          const parent = el.parentNode;
          if (!parent) continue;

          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          el.remove();
          continue;
        }

        sanitizeElementAttributes(el);
        continue;
      }

      // Text nodes are safe, but apply ligatures outside code/pre blocks.
      if (child.nodeType === Node.TEXT_NODE) {
        child.textContent = replaceLigatures(child.textContent ?? '');
        continue;
      }

      // Drop comments, processing instructions, etc.
      child.remove();
    }
  };

  sanitizeNode(template.content);
  return template.innerHTML;
}

/**
 * Render text with BBCode and Markdown support
 * BBCode is processed first, then Markdown
 */
export function renderContent(text: string, _ctx?: { topicId?: string | null } | null): string {
  if (!text) return '';

  // Code blocks must be "verbatim":
  // - no BBCode parsing inside them
  // - no Markdown parsing inside them
  const withCodeBlocks = replaceCodeBlocksWithPlaceholders(text);

  // Inline code spans should be verbatim as well.
  const withInlineCode = replaceInlineCodeWithPlaceholders(withCodeBlocks.text);

  // Do not pre-escape: we intentionally allow a small, sanitized subset of HTML.
  let result = withInlineCode.text;

  // First, parse BBCode
  result = parseBBCode(result);

  // Then parse Markdown
  result = marked.parse(result) as string;

  // Sanitize only the non-code HTML. Code spans/blocks are restored afterward.
  result = sanitizeRenderedHtml(result);

  for (const { token, html } of withInlineCode.replacements) {
    result = result.replaceAll(token, html);
  }

  // Restore code blocks. Handle the common case where marked wrapped the token
  // in a paragraph because it looked like plain text.
  for (const { token, html } of withCodeBlocks.replacements) {
    result = result.replaceAll(`<p>${token}</p>`, html);
    result = result.replaceAll(token, html);
  }

  return result;
}

/**
 * Render text with only BBCode support (no Markdown)
 * Use this for contexts where Markdown might cause issues
 */
export function renderBBCode(text: string, _ctx?: { topicId?: string | null } | null): string {
  if (!text) return '';

  const withInlineCode = replaceInlineCodeWithPlaceholders(text);

  // Do not pre-escape: we intentionally allow a small, sanitized subset of HTML.
  let result = withInlineCode.text;
  // Then parse BBCode
  result = parseBBCode(result);

  // Convert newlines to <br>
  result = result.replace(/\n/g, '<br>');

  result = sanitizeRenderedHtml(result);

  for (const { token, html } of withInlineCode.replacements) {
    result = result.replaceAll(token, html);
  }

  return result;
}

/**
 * Strip all formatting and return plain text
 */
export function stripFormatting(text: string): string {
  if (!text) return '';

  // Remove BBCode tags
  let result = text.replace(/\[[^\]]+\]/g, '');

  // Remove Markdown formatting
  result = result.replace(/[*_~`#]/g, '');
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  return result.trim();
}

/**
 * Composable for markdown/BBCode rendering
 */
export function useMarkdown() {
  return {
    renderContent,
    renderBBCode,
    stripFormatting,
    escapeHtml
  };
}
