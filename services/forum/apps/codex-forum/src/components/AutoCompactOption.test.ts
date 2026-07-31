import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AutoCompactOption from './AutoCompactOption.vue';

describe('AutoCompactOption', () => {
  it('explains lossiness and emits changes for administrators', async () => {
    const wrapper = mount(AutoCompactOption, {
      props: { modelValue: false, canEdit: true },
    });

    expect(wrapper.text()).toContain('Auto-compact this thread');
    expect(wrapper.text()).toContain('Compaction can lose detail');
    await wrapper.get('input').setValue(true);
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]]);
  });

  it('is read-only for non-admins and while a response is active', () => {
    const member = mount(AutoCompactOption, {
      props: { modelValue: true, canEdit: false },
    });
    expect(member.get('input').attributes('disabled')).toBeDefined();
    expect(member.text()).toContain('Only administrators');

    const busy = mount(AutoCompactOption, {
      props: { modelValue: true, canEdit: true, busy: true },
    });
    expect(busy.get('input').attributes('disabled')).toBeDefined();
    expect(busy.text()).toContain('Wait for the current response');
  });
});
