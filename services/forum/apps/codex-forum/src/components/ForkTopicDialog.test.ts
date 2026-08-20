import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import ForkTopicDialog from './ForkTopicDialog.vue';

const boundary = {
  postId: 'post-2',
  postNumber: 2,
  excerpt: 'Choose this request',
  body: 'Choose this request in full',
};

function mountDialog(overrides: Record<string, unknown> = {}) {
  return mount(ForkTopicDialog, {
    attachTo: document.body,
    props: {
      boundaries: [boundary],
      boundaryPostId: boundary.postId,
      title: 'Fork: Parent',
      openingBody: boundary.body,
      loading: false,
      submitting: false,
      operationStatus: null,
      error: '',
      canSubmit: true,
      ...overrides,
    },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('ForkTopicDialog', () => {
  it('renders styled canonical-boundary fields and emits stable values', async () => {
    const wrapper = mountDialog();

    expect(wrapper.get('[role="dialog"]').attributes('aria-describedby')).toBe('fork-modal-description');
    expect(wrapper.get('#fork-boundary').classes()).toContain('vb-modal-select');
    expect(wrapper.get('#fork-title').classes()).toContain('vb-modal-input');
    expect(wrapper.get('#fork-opening').classes()).toContain('vb-modal-textarea');
    expect(wrapper.get('#fork-boundary option').text()).toContain('#2');

    await wrapper.get('#fork-title').setValue('Fork: Edited');
    await wrapper.get('#fork-opening').setValue('Edited replay');
    expect(wrapper.emitted('update:title')?.at(-1)).toEqual(['Fork: Edited']);
    expect(wrapper.emitted('update:openingBody')?.at(-1)).toEqual(['Edited replay']);
    wrapper.unmount();
  });

  it('disables stale submission while canonical boundaries are loading or absent', () => {
    {
      const wrapper = mountDialog({ boundaries: [], boundaryPostId: '', loading: true, canSubmit: false });
      expect(wrapper.get('[role="status"]').text()).toContain('Refreshing canonical fork boundaries');
      expect(wrapper.get('#fork-boundary').attributes()).toHaveProperty('disabled');
      expect(wrapper.get('.vb-fork-modal-actions .vb-btn').attributes()).toHaveProperty('disabled');
      wrapper.unmount();
    }

    {
      const wrapper = mountDialog({ boundaries: [], boundaryPostId: '', canSubmit: false, error: 'No stable boundary.' });
      expect(wrapper.get('[role="alert"]').text()).toBe('No stable boundary.');
      expect(wrapper.get('#fork-boundary').text()).toContain('No eligible boundary');
      expect(wrapper.get('.vb-fork-modal-actions .vb-btn').attributes()).toHaveProperty('disabled');
      wrapper.unmount();
    }
  });

  it('shows a disabled pending state and restores document state on close', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    document.body.style.overflow = 'auto';
    const wrapper = mountDialog();

    expect(document.body.style.overflow).toBe('hidden');
    const submit = wrapper.get<HTMLButtonElement>('.vb-fork-modal-actions .vb-btn');
    submit.element.focus();
    await wrapper.setProps({ submitting: true, operationStatus: 'pending', canSubmit: false });
    expect(submit.text()).toBe('Forking…');
    expect(submit.attributes()).toHaveProperty('disabled');
    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element);

    await wrapper.setProps({ submitting: false });
    await wrapper.get('.vb-btn-secondary').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);

    wrapper.unmount();
    expect(document.body.style.overflow).toBe('auto');
    expect(document.activeElement).toBe(opener);
  });
});
