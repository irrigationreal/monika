// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderContent } from '../composables/useMarkdown';
import {
  accessibleTitleForMermaidSvg,
  enhanceMermaidDirective,
  mermaidConfigForCurrentTheme,
  parseSandboxedMermaidResult,
  sanitizeMermaidSvgForExport,
} from './mermaidEnhancement';

function sandboxMarkup(svg: string, height = 480): string {
  const encoded = window.btoa(`<body style="margin:0">${svg}</body>`);
  return `<iframe style="width:100%;height:${String(height)}px;border:0" src="data:text/html;charset=UTF-8;base64,${encoded}" sandbox="allow-top-navigation-by-user-activation allow-popups"></iframe>`;
}

describe('Mermaid enhancement boundary', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--bg-surface', '#101820');
    document.documentElement.style.setProperty('--bg-surface-alt', '#182631');
    document.documentElement.style.setProperty('--text-primary', '#f2f6f8');
    document.documentElement.style.setProperty('--brand-primary', '#2dbf9f');
    document.documentElement.style.setProperty('--brand-secondary', '#78a99d');
  });

  it('builds a sandboxed, bounded, website-themed Mermaid configuration', () => {
    const config = mermaidConfigForCurrentTheme();
    expect(config.securityLevel).toBe('sandbox');
    expect(config.startOnLoad).toBe(false);
    expect(config.htmlLabels).toBe(false);
    expect(config.maxTextSize).toBe(20_000);
    expect(config.maxEdges).toBe(200);
    expect(config.theme).toBe('base');
    expect(config.themeVariables).toMatchObject({
      background: '#101820',
      primaryColor: '#182631',
      primaryTextColor: '#f2f6f8',
      primaryBorderColor: '#2dbf9f',
      lineColor: '#78a99d',
    });
    expect(config.secure).toEqual(expect.arrayContaining(['securityLevel', 'themeCSS', 'htmlLabels', 'maxEdges']));
  });

  it('extracts SVG only from Mermaid sandbox output and caps display height', () => {
    const result = parseSandboxedMermaidResult(
      sandboxMarkup('<svg xmlns="http://www.w3.org/2000/svg"><text>Safe</text></svg>', 5000)
    );
    expect(result.svg).toContain('<text>Safe</text>');
    expect(result.heightPx).toBe(900);
    expect(result.sourceUrl).toMatch(/^data:text\/html;charset=UTF-8;base64,/);
  });

  it('rejects output that is not isolated in a permissionless sandbox', () => {
    const encoded = window.btoa('<body><svg></svg></body>');
    expect(() =>
      parseSandboxedMermaidResult(
        `<iframe sandbox="allow-scripts" src="data:text/html;charset=UTF-8;base64,${encoded}"></iframe>`
      )
    ).toThrow(/unexpected sandbox permissions/);
    expect(() => parseSandboxedMermaidResult('<svg></svg>')).toThrow(/isolated sandbox/);
  });

  it('unobserves replaced v-html nodes and enforces the per-section diagram limit', async () => {
    const observed = new Set<Element>();
    const unobserved = new Set<Element>();
    class FakeIntersectionObserver {
      observe(element: Element): void {
        observed.add(element);
      }
      unobserve(element: Element): void {
        observed.delete(element);
        unobserved.add(element);
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    const hooks = enhanceMermaidDirective as {
      mounted(element: HTMLElement): void;
      updated(element: HTMLElement): void;
      beforeUnmount(element: HTMLElement): void;
    };
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = Array.from({ length: 11 }, (_, index) =>
      renderContent(['```mermaid', `flowchart LR\nA${String(index)} --> B${String(index)}`, '```'].join('\n'))
    ).join('');
    hooks.mounted(root);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(observed.size).toBe(10);
    expect(root.querySelectorAll('[data-mermaid-state="rejected"]')).toHaveLength(1);
    const previous = Array.from(observed);

    root.innerHTML = renderContent(['```mermaid', 'flowchart LR\nNew --> Diagram', '```'].join('\n'));
    hooks.updated(root);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(previous.every((element) => unobserved.has(element))).toBe(true);
    expect(observed.size).toBe(1);

    const replacement = Array.from(observed)[0];
    hooks.beforeUnmount(root);
    expect(replacement && unobserved.has(replacement)).toBe(true);
    root.remove();
    vi.unstubAllGlobals();
  });

  it('uses sanitized SVG accessibility metadata for the frame title', () => {
    expect(
      accessibleTitleForMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><title>  Forum   pipeline </title><desc>Details</desc></svg>'
      )
    ).toBe('Forum pipeline');
    expect(
      accessibleTitleForMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><desc>A request travels through the forum.</desc></svg>'
      )
    ).toBe('A request travels through the forum.');
    expect(accessibleTitleForMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe('Mermaid diagram');
  });

  it('removes active content and external links from exported SVG', () => {
    const dirty = [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
      '<style>@import url(https://evil.example/theme.css); .node { fill: #fff; filter: url(#shadow); background: url(https://evil.example/pixel); }</style>',
      '<script>alert(1)</script>',
      '<a href="javascript:alert(2)"><text>link</text></a>',
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>',
      '<rect class="node" width="10" height="10"/>',
      '</svg>',
    ].join('');
    const clean = sanitizeMermaidSvgForExport(dirty);
    expect(clean).toContain('<svg');
    expect(clean).toContain('<rect');
    expect(clean).not.toMatch(/<script|<foreignObject|<a\b/i);
    expect(clean).toContain('url(#shadow)');
    expect(clean).not.toMatch(/onload|javascript:|href=|evil\.example|@import/i);
  });
});
