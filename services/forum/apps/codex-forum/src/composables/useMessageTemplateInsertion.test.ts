import { defineComponent, ref } from 'vue';

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { applyTemplateToTextarea, insertTemplateText } from './useMessageTemplateInsertion';

describe('insertTemplateText', () => {
  it('fills an empty draft exactly', () => {
    expect(insertTemplateText('', '  hello\n', 0, 0)).toEqual({ value: '  hello\n', caret: 8 });
  });
  it('inserts at the cursor without deleting selected text', () => {
    expect(insertTemplateText('alpha beta', '[x]', 6, 10)).toEqual({ value: 'alpha [x]beta', caret: 9 });
  });
  it('uses JavaScript textarea offsets for unicode content', () => {
    expect(insertTemplateText('🙂 ok', 'yes ', 3, 3)).toEqual({ value: '🙂 yes ok', caret: 7 });
  });
  it('updates a mounted textarea and restores the caret for a nonempty draft', async () => {
    const body = ref('alpha beta');
    const textarea = ref<HTMLTextAreaElement | null>(null);
    const wrapper = mount(
      defineComponent({
        setup: () => ({ body, textarea }),
        template: '<textarea ref="textarea" v-model="body"></textarea>',
      }),
      { attachTo: document.body }
    );
    const element = wrapper.get('textarea').element as HTMLTextAreaElement;
    element.focus();
    element.setSelectionRange(6, 10);

    await applyTemplateToTextarea({ body, textarea, templateBody: '[x]' });

    expect(body.value).toBe('alpha [x]beta');
    expect(element.value).toBe('alpha [x]beta');
    expect(element.selectionStart).toBe(9);
    expect(document.activeElement).toBe(element);
    wrapper.unmount();
  });
});
