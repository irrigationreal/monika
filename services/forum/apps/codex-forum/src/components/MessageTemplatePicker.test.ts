import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MessageTemplatePicker from './MessageTemplatePicker.vue';

import type { MessageTemplateDto } from '../lib/apiClient';

const apiMocks = vi.hoisted(() => ({
  listEffectiveMessageTemplates: vi.fn(),
  createMessageTemplate: vi.fn(),
}));

vi.mock('../lib/apiClient', () => ({ api: apiMocks }));
vi.mock('../composables/useMarkdown', () => ({
  useMarkdown: () => ({ renderContent: (text: string) => `<p>${text}</p>` }),
}));

const templates: MessageTemplateDto[] = [
  {
    id: 'personal-1',
    scope: 'personal',
    name: 'Approve',
    category: 'Review',
    body: 'Approved after review.',
    threadTitle: null,
    forumScope: 'all',
    forumIds: [],
    contexts: ['reply'],
    enabled: true,
    sortOrder: 0,
    revision: 1,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
  },
  {
    id: 'system-1',
    scope: 'system',
    name: 'Request changes',
    category: 'Review',
    body: 'Please address the review notes.',
    threadTitle: null,
    forumScope: 'all',
    forumIds: [],
    contexts: ['reply'],
    enabled: true,
    sortOrder: 1,
    revision: 1,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
  },
];

describe('MessageTemplatePicker', () => {
  beforeEach(() => {
    apiMocks.listEffectiveMessageTemplates.mockReset();
    apiMocks.createMessageTemplate.mockReset();
    apiMocks.listEffectiveMessageTemplates.mockResolvedValue({ templates });
  });

  it('loads, searches, labels, previews, and emits a selected effective template', async () => {
    const wrapper = mount(MessageTemplatePicker, {
      props: { context: 'reply', forumId: 'forum-1', hasDraft: false },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    });
    await flushPromises();

    expect(apiMocks.listEffectiveMessageTemplates).toHaveBeenCalledWith('reply', 'forum-1');
    expect(wrapper.findAll('optgroup')).toHaveLength(1);
    expect(wrapper.text()).toContain('Approve · Personal');
    expect(wrapper.text()).toContain('Request changes · System');

    await wrapper.get('[data-testid="message-template-search"]').setValue('approve');
    expect(wrapper.findAll('option')).toHaveLength(2);
    await wrapper.get('[data-testid="message-template-select"]').setValue('personal-1');
    expect(wrapper.get('[data-testid="message-template-preview"]').html()).toContain('Approved after review.');
    await wrapper.get('[data-testid="message-template-insert"]').trigger('click');

    expect(wrapper.emitted('apply')).toEqual([[templates[0], false]]);
  });

  it('ignores a stale response after the forum changes', async () => {
    let resolveFirst!: (value: { templates: MessageTemplateDto[] }) => void;
    let resolveSecond!: (value: { templates: MessageTemplateDto[] }) => void;
    apiMocks.listEffectiveMessageTemplates
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise<{ templates: MessageTemplateDto[] }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ templates: MessageTemplateDto[] }>((resolve) => {
            resolveSecond = resolve;
          })
      );
    const wrapper = mount(MessageTemplatePicker, {
      props: { context: 'reply', forumId: 'forum-1', hasDraft: false },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    });
    await wrapper.setProps({ forumId: 'forum-2' });
    resolveSecond({ templates: templates.slice(1, 2) });
    await flushPromises();
    resolveFirst({ templates: templates.slice(0, 1) });
    await flushPromises();

    expect(wrapper.text()).toContain('Request changes · System');
    expect(wrapper.text()).not.toContain('Approve · Personal');
  });

  it('clears a selection that search filtering hides', async () => {
    const wrapper = mount(MessageTemplatePicker, {
      props: { context: 'reply', forumId: 'forum-1', hasDraft: false },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    });
    await flushPromises();
    await wrapper.get('[data-testid="message-template-select"]').setValue('personal-1');
    await wrapper.get('[data-testid="message-template-search"]').setValue('request');

    expect((wrapper.get('[data-testid="message-template-select"]').element as HTMLSelectElement).value).toBe('');
    expect(wrapper.get('[data-testid="message-template-insert"]').attributes('disabled')).toBeDefined();
  });

  it('cannot apply a previous-forum template while the next forum is loading', async () => {
    const wrapper = mount(MessageTemplatePicker, {
      props: { context: 'reply', forumId: 'forum-1', hasDraft: true },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    });
    await flushPromises();
    await wrapper.get('[data-testid="message-template-select"]').setValue('personal-1');

    apiMocks.listEffectiveMessageTemplates.mockImplementationOnce(() => new Promise(() => undefined));
    await wrapper.setProps({ forumId: 'forum-2' });

    expect(wrapper.get('[data-testid="message-template-insert"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="message-template-replace"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="message-template-insert"]').trigger('click');
    expect(wrapper.emitted('apply')).toBeUndefined();
    expect(wrapper.find('[data-testid="message-template-preview"]').exists()).toBe(false);
  });
});
