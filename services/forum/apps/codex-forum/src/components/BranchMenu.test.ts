import { nextTick } from 'vue';

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import BranchMenu from './BranchMenu.vue';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('BranchMenu', () => {
  it('opens an accessible menu and emits both distinct branch actions', async () => {
    const wrapper = mount(BranchMenu, { attachTo: document.body });
    const trigger = wrapper.get<HTMLButtonElement>('.vb-branch-trigger');
    expect(trigger.attributes('aria-haspopup')).toBe('menu');
    expect(trigger.attributes('aria-expanded')).toBe('false');

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[role="menu"]').attributes('id')).toBe(trigger.attributes('aria-controls'));
    const items = wrapper.findAll('[role="menuitem"]');
    expect(items.map((item) => item.text())).toEqual(['Duplicate current thread', 'Fork from an earlier message']);
    await items[0]!.trigger('click');
    expect(wrapper.emitted('duplicate')).toHaveLength(1);

    await trigger.trigger('click');
    await wrapper.findAll('[role="menuitem"]')[1]!.trigger('click');
    expect(wrapper.emitted('fork')).toHaveLength(1);
    wrapper.unmount();
  });

  it('supports arrow navigation, Escape focus restoration, disabled actions, and outside click', async () => {
    const wrapper = mount(BranchMenu, {
      attachTo: document.body,
      props: { duplicateDisabled: true },
    });
    const trigger = wrapper.get<HTMLButtonElement>('.vb-branch-trigger');
    trigger.element.focus();
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    const items = wrapper.findAll<HTMLButtonElement>('[role="menuitem"]');
    expect(items[0]!.attributes()).toHaveProperty('disabled');
    expect(document.activeElement).toBe(items[1]!.element);

    await items[1]!.trigger('keydown', { key: 'Escape' });
    await nextTick();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);

    await wrapper.get('.vb-branch-trigger').trigger('click');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
