import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASELINES = {
  'classic-light': {
    'text-primary on bg-surface': 21,
    'text-secondary on bg-surface': 12.63465434445799,
    'text-muted on bg-surface': 5.74183648145415,
    'text-primary on bg-surface-alt': 19.387458582678686,
    'text-secondary on bg-surface-alt': 11.664468467125744,
    'text-muted on bg-surface-alt': 5.300934141557422,
    'text-primary on bg-surface-muted': 16.581032298765866,
    'text-secondary on bg-surface-muted': 9.975981512819068,
    'text-muted on bg-surface-muted': 4.5335988644392105,
    'text-primary on bg-input': 21,
    'text-secondary on bg-input': 12.63465434445799,
    'text-muted on bg-input': 5.74183648145415,
    'text-inverse on grad-nav-start': 4.961358142433098,
    'text-inverse on grad-nav-end': 8.183304486755565,
    'text-inverse on grad-btn-start': 3.3138711783261927,
    'text-inverse on grad-btn-end': 10.408439813116559,
    'text-inverse on grad-header-start': 4.961358142433098,
    'text-inverse on grad-header-end': 6.284270024934525,
    'brand-primary-light on table-section-bg': 7.833077899281293
  },
  'classic-dark': {
    'text-primary on bg-surface': 15.254283779202403,
    'text-secondary on bg-surface': 11.024840496612779,
    'text-muted on bg-surface': 6.7151431502840655,
    'text-primary on bg-surface-alt': 14.059720067017706,
    'text-secondary on bg-surface-alt': 10.161484695678114,
    'text-muted on bg-surface-alt': 6.1892799602736845,
    'text-primary on bg-surface-muted': 14.751907873016092,
    'text-secondary on bg-surface-muted': 10.661754670020468,
    'text-muted on bg-surface-muted': 6.4939904449768395,
    'text-primary on bg-input': 14.059720067017706,
    'text-secondary on bg-input': 10.161484695678114,
    'text-muted on bg-input': 6.1892799602736845,
    'text-inverse on grad-nav-start': 15.174154071293794,
    'text-inverse on grad-nav-end': 18.124218130072293,
    'text-inverse on grad-btn-start': 11.997660634393652,
    'text-inverse on grad-btn-end': 18.124218130072293,
    'text-inverse on grad-header-start': 15.174154071293794,
    'text-inverse on grad-header-end': 18.124218130072293,
    'brand-primary-light on table-section-bg': 10.186811806779842
  }
} as const;

const CONTRAST_PAIRS = [
  ['text-primary', 'bg-surface'],
  ['text-secondary', 'bg-surface'],
  ['text-muted', 'bg-surface'],
  ['text-primary', 'bg-surface-alt'],
  ['text-secondary', 'bg-surface-alt'],
  ['text-muted', 'bg-surface-alt'],
  ['text-primary', 'bg-surface-muted'],
  ['text-secondary', 'bg-surface-muted'],
  ['text-muted', 'bg-surface-muted'],
  ['text-primary', 'bg-input'],
  ['text-secondary', 'bg-input'],
  ['text-muted', 'bg-input'],
  ['text-inverse', 'grad-nav-start'],
  ['text-inverse', 'grad-nav-end'],
  ['text-inverse', 'grad-btn-start'],
  ['text-inverse', 'grad-btn-end'],
  ['text-inverse', 'grad-header-start'],
  ['text-inverse', 'grad-header-end'],
  ['brand-primary-light', 'table-section-bg']
] as const;

const EPSILON = 0.0005;

function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseVarsFromBlock(css: string, selector: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const blockRegex = new RegExp(`${escapeRegex(selector)}\\s*\\{([\\s\\S]*?)\\}`, 'g');
  const varRegex = /(--[\w-]+)\s*:\s*([^;]+);/g;

  for (const match of css.matchAll(blockRegex)) {
    const block = match[1] ?? '';
    let varMatch: RegExpExecArray | null;
    while ((varMatch = varRegex.exec(block))) {
      vars[varMatch[1]] = varMatch[2].trim();
    }
  }

  return vars;
}

function resolveVarValue(vars: Record<string, string>, name: string, chain = new Set<string>()): string {
  if (chain.has(name)) throw new Error(`Circular var reference detected: ${[...chain, name].join(' -> ')}`);
  const raw = vars[name];
  if (!raw) throw new Error(`Missing CSS variable ${name}`);
  const trimmed = raw.trim();
  const match = trimmed.match(/^var\((--[\w-]+)\)$/);
  if (!match) return trimmed;
  chain.add(name);
  const resolved = resolveVarValue(vars, match[1], chain);
  chain.delete(name);
  return resolved;
}

function parseHexColor(value: string): { r: number; g: number; b: number } {
  const normalized = value.trim();
  if (!normalized.startsWith('#')) throw new Error(`Expected hex color, got: ${value}`);
  const hex = normalized.slice(1);
  if (hex.length !== 3 && hex.length !== 6) throw new Error(`Invalid hex color: ${value}`);
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const int = Number.parseInt(full, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channels = [r, g, b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(colorA: string, colorB: string): number {
  const luminanceA = relativeLuminance(parseHexColor(colorA));
  const luminanceB = relativeLuminance(parseHexColor(colorB));
  const [bright, dark] = luminanceA >= luminanceB ? [luminanceA, luminanceB] : [luminanceB, luminanceA];
  return (bright + 0.05) / (dark + 0.05);
}

type ThemeUnderTest = 'classic-light' | 'classic-dark' | 'vmonika';

async function loadThemeVars(theme: ThemeUnderTest): Promise<Record<string, string>> {
  const css = await readFile(path.join(__dirname, 'theme.css'), 'utf8');
  const rootVars = parseVarsFromBlock(css, ':root');
  const themeSelector = theme === 'classic-light' ? '[data-theme="classic-light"]' : `[data-theme="${theme}"]`;
  const themeVars = parseVarsFromBlock(css, themeSelector);
  return { ...rootVars, ...themeVars };
}

describe('theme contrast baselines', () => {
  it('keeps classic-light contrast at or above the current baseline', async () => {
    const vars = await loadThemeVars('classic-light');

    for (const [textKey, bgKey] of CONTRAST_PAIRS) {
      const pairKey = `${textKey} on ${bgKey}` as const;
      const baseline = BASELINES['classic-light'][pairKey];
      const text = resolveVarValue(vars, `--${textKey}`);
      const background = resolveVarValue(vars, `--${bgKey}`);
      const ratio = contrastRatio(text, background);

      expect(ratio, `classic-light ${pairKey} contrast`).toBeGreaterThanOrEqual(baseline - EPSILON);
    }
  });

  it('keeps classic-dark contrast at or above the current baseline', async () => {
    const vars = await loadThemeVars('classic-dark');

    for (const [textKey, bgKey] of CONTRAST_PAIRS) {
      const pairKey = `${textKey} on ${bgKey}` as const;
      const baseline = BASELINES['classic-dark'][pairKey];
      const text = resolveVarValue(vars, `--${textKey}`);
      const background = resolveVarValue(vars, `--${bgKey}`);
      const ratio = contrastRatio(text, background);

      expect(ratio, `classic-dark ${pairKey} contrast`).toBeGreaterThanOrEqual(baseline - EPSILON);
    }
  });

  it('keeps vMonika core contrast comfortably above WCAG AA text thresholds', async () => {
    const vars = await loadThemeVars('vmonika');

    for (const [textKey, bgKey] of CONTRAST_PAIRS) {
      const pairKey = `${textKey} on ${bgKey}`;
      const text = resolveVarValue(vars, `--${textKey}`);
      const background = resolveVarValue(vars, `--${bgKey}`);
      const ratio = contrastRatio(text, background);

      expect(ratio, `vMonika ${pairKey} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
