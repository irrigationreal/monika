import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/views/NotepadView.vue'), 'utf8');

describe('Notepad draft safety', () => {
  it('freezes every capture input while publication is in flight', () => {
    expect(source.match(/:disabled="publishing"/g)).toHaveLength(4);
    expect(source).toContain('v-if="!publishing"');
  });

  it('routes draft discard through the shared accessible confirmation dialog', () => {
    expect(source).toContain('@discard="confirmation = { kind: \'discard-draft\' }"');
    expect(source).toContain("pending.kind === 'discard-draft'");
    expect(source).toContain('await autosavedDraft.discard()');
  });

  it('uses the shared forum styles for note controls', () => {
    expect(source).toContain('class="vb-modal-textarea vb-note-textarea"');
    expect(source).toContain('class="vb-option-select"');
    expect(source).toContain('class="vb-btn vb-note-post"');
    expect(source).not.toMatch(/class="vb-(?:textarea|select|button)(?:\s|\")/);
  });
});
