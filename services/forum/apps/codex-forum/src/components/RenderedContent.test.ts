import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import RenderedContent from './RenderedContent.vue';

describe('RenderedContent', () => {
  it('applies the shared rendering contract and Mermaid enhancement', async () => {
    const mounted = vi.fn();
    const updated = vi.fn();
    const wrapper = mount(RenderedContent, {
      props: { html: '<p>First</p>' },
      attrs: { class: 'vb-post-text' },
      global: {
        directives: {
          'enhance-mermaid': { mounted, updated },
        },
      },
    });

    expect(wrapper.classes()).toEqual(expect.arrayContaining(['vb-rendered-content', 'vb-post-text']));
    expect(wrapper.html()).toContain('<p>First</p>');
    expect(mounted).toHaveBeenCalledOnce();

    await wrapper.setProps({ html: '<p>Second</p>' });
    expect(wrapper.text()).toBe('Second');
    expect(updated).toHaveBeenCalled();
  });
});
