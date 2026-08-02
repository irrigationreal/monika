import { describe, expect, it } from 'vitest';

import { fencedCodeBlock } from './editorFormatting';

describe('fencedCodeBlock', () => {
  it('uses a triple-backtick fence for ordinary code', () => {
    expect(fencedCodeBlock('const answer = 42;')).toBe('```\nconst answer = 42;\n```');
  });

  it('uses a fence longer than every backtick run in the content', () => {
    const content = ['Outer Markdown example:', '```ts', 'const answer = 42;', '```'].join('\n');
    expect(fencedCodeBlock(content)).toBe(['````', content, '````'].join('\n'));
  });

  it('also avoids longer inline backtick delimiters', () => {
    expect(fencedCodeBlock('Use ````this```` literally.')).toBe('`````\nUse ````this```` literally.\n`````');
  });

  it('adds line boundaries when inserted inside surrounding prose', () => {
    expect(fencedCodeBlock('value', 'prefix ', ' suffix')).toBe('\n```\nvalue\n```\n');
    expect(`prefix ${fencedCodeBlock('value', 'prefix ', ' suffix')} suffix`).toBe(
      ['prefix ', '```', 'value', '```', ' suffix'].join('\n')
    );
  });

  it('does not duplicate existing line boundaries', () => {
    expect(fencedCodeBlock('value', 'before\n', '\nafter')).toBe('```\nvalue\n```');
  });
});
