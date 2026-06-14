import { describe, expect, it } from 'vitest';

import { renderPersonaGuideMarkdown, renderPersonaIndexMarkdown, safePersonaKey } from './personaPrompt';

describe('personaPrompt', () => {
  it('sanitizes persona keys for filenames', () => {
    expect(safePersonaKey('gamer')).toBe('gamer');
    expect(safePersonaKey('gamer/../../oops')).toBe('gamer_______oops');
    expect(safePersonaKey('A B C')).toBe('A_B_C');
  });

  it('renders full soul docs (or truncates with instruction)', () => {
    const soul = ['RULE 1: do the thing', 'RULE 2: never do the other thing', 'RULE 3: be loud'].join('\n');
    const out = renderPersonaIndexMarkdown(
      [
        {
          key: 'gamer',
          displayName: 'xX_Gamer_Xx',
          description: 'High-energy gamer persona',
          soul
        }
      ],
      { maxSoulChars: 100, maxTotalSoulChars: 100 }
    );

    expect(out).toContain('Available personas (admin-defined):');
    expect(out).toContain('- gamer: xX_Gamer_Xx — High-energy gamer persona');
    expect(out).toContain('Soul (authoritative):');
    expect(out).toContain('RULE 1: do the thing');
    expect(out).toContain('Soul file: open .codex-forum/personas/gamer.md');
    expect(out).not.toContain('[TRUNCATED]');

    const longSoul = `${soul}\n${'x'.repeat(500)}`;
    const out2 = renderPersonaIndexMarkdown(
      [
        {
          key: 'gamer',
          displayName: 'xX_Gamer_Xx',
          description: null,
          soul: longSoul
        }
      ],
      { maxSoulChars: 50, maxTotalSoulChars: 50 }
    );
    expect(out2).toContain('[TRUNCATED]');
    expect(out2).toContain('Soul file: open .codex-forum/personas/gamer.md');
  });

  it('renders a persona guide preface with soul file locations', () => {
    const out = renderPersonaGuideMarkdown([
      {
        key: 'gamer',
        displayName: 'xX_Gamer_Xx',
        description: 'High-energy gamer persona',
        soul: 'RULES'
      }
    ]);

    expect(out).toContain('[persona context]');
    expect(out).toContain('Personality (persona) files live under .codex-forum/personas/<key>.md.');
    expect(out).toContain('Default persona: gamer');
    expect(out).toContain('- gamer: xX_Gamer_Xx - High-energy gamer persona');
    expect(out).toContain('Soul file: open .codex-forum/personas/gamer.md');
  });
});
