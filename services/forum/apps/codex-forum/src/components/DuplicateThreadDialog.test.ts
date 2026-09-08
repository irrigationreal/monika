import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextTick } from 'vue';

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import DuplicateThreadDialog from './DuplicateThreadDialog.vue';

function mountDialog(overrides: Record<string, unknown> = {}) {
  return mount(DuplicateThreadDialog, {
    attachTo: document.body,
    props: {
      title: 'Copy of Parent',
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

describe('DuplicateThreadDialog', () => {
  it('participates in the dynamic viewport, safe-area, scrolling, and mobile target style contracts', () => {
    const posts = readFileSync(resolve(process.cwd(), 'src/styles/posts.css'), 'utf8');
    const responsive = readFileSync(resolve(process.cwd(), 'src/styles/responsive.css'), 'utf8');

    expect(posts).toMatch(/\.vb-confirmation-modal-overlay,\s*\.vb-duplicate-modal-overlay \{[\s\S]*height: 100dvh;/);
    expect(posts).toMatch(/\.vb-fork-modal,\s*\.vb-duplicate-modal \{[\s\S]*max-height: 100%;/);
    expect(posts).toMatch(
      /\.vb-fork-modal \.vb-modal-body,\s*\.vb-duplicate-modal \.vb-modal-body \{[\s\S]*overflow-y: auto;/
    );
    expect(responsive).toMatch(
      /\.vb-confirmation-modal-overlay,\s*\.vb-duplicate-modal-overlay \{[\s\S]*env\(safe-area-inset-top\)/
    );
    expect(responsive).toMatch(
      /\.vb-confirmation-modal-actions,\s*\.vb-duplicate-modal-actions \{\s*flex-direction: column;/
    );
    expect(responsive).toMatch(/\.vb-duplicate-modal \.vb-modal-input \{[\s\S]*min-height: 44px;/);
    expect(responsive).toContain('.vb-duplicate-modal-actions .vb-btn,');
    expect(responsive).toContain('.vb-duplicate-modal .vb-modal-close {');
  });

  it('is concise, accessible, editable, and explicit that no message is sent', async () => {
    const wrapper = mountDialog();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-describedby')).toBe('duplicate-modal-description');
    expect(wrapper.get('#duplicate-modal-description').text()).toContain('No message will be sent');
    expect(wrapper.get<HTMLInputElement>('#duplicate-title').element.value).toBe('Copy of Parent');
    await wrapper.get('#duplicate-title').setValue('Independent title');
    expect(wrapper.emitted('update:title')?.at(-1)).toEqual(['Independent title']);
    await wrapper.get('.vb-duplicate-modal-actions .vb-btn').trigger('click');
    expect(wrapper.emitted('submit')).toHaveLength(1);
    wrapper.unmount();
  });

  it('traps focus, blocks dismissal while submitting, and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    document.body.style.overflow = 'auto';
    const wrapper = mountDialog();
    await nextTick();
    await nextTick();
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).toBe(wrapper.get('#duplicate-title').element);

    await wrapper.setProps({ submitting: true, operationStatus: 'running', canSubmit: false });
    expect(wrapper.get('.vb-duplicate-modal-actions .vb-btn').text()).toBe('Duplicating…');
    await wrapper.get('.vb-modal-close').trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined();

    await wrapper.setProps({ submitting: false });
    await wrapper.get('.vb-modal-close').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
    expect(document.body.style.overflow).toBe('auto');
    expect(document.activeElement).toBe(opener);
  });
});
