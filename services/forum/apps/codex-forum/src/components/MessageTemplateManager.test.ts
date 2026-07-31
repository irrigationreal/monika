import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MessageTemplateManager from './MessageTemplateManager.vue';

import type { MessageTemplateDto } from '../lib/apiClient';

const apiMocks = vi.hoisted(() => ({
  listMyMessageTemplates: vi.fn(),
  listSystemMessageTemplates: vi.fn(),
  listForums: vi.fn(),
  listAdminForums: vi.fn(),
  createMessageTemplate: vi.fn(),
  createSystemMessageTemplate: vi.fn(),
  updateMessageTemplate: vi.fn(),
  updateSystemMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(),
  deleteSystemMessageTemplate: vi.fn(),
  reorderMessageTemplates: vi.fn(),
  reorderSystemMessageTemplates: vi.fn(),
}));

vi.mock('../lib/apiClient', () => ({ api: apiMocks }));
vi.mock('../composables/useMarkdown', () => ({
  useMarkdown: () => ({ renderContent: (text: string) => `<p>${text}</p>` }),
}));
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }));

const template = (revision: number): MessageTemplateDto => ({
  id: 'template-1',
  scope: 'personal',
  name: 'Approval',
  category: 'Review',
  body: revision === 1 ? 'Original body.' : 'Concurrent body.',
  threadTitle: null,
  forumScope: 'all',
  forumIds: [],
  contexts: ['reply'],
  enabled: true,
  sortOrder: 0,
  revision,
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
});
const conflict = () => Object.assign(new Error('Message template changed in another session'), { status: 409 });

describe('MessageTemplateManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listForums.mockResolvedValue([]);
    apiMocks.listAdminForums.mockResolvedValue({ items: [] });
    apiMocks.listSystemMessageTemplates.mockResolvedValue({ templates: [] });
  });

  it('preserves the form and reports a refresh failure after a successful create', async () => {
    apiMocks.listMyMessageTemplates
      .mockResolvedValueOnce({ templates: [] })
      .mockRejectedValueOnce(new Error('refresh unavailable'));
    apiMocks.createMessageTemplate.mockResolvedValue({ id: 'created' });
    const wrapper = mount(MessageTemplateManager);
    await flushPromises();
    await wrapper.get('[data-testid="message-template-name"]').setValue('Approval');
    await wrapper.get('[data-testid="message-template-body"]').setValue('Approved after review.');
    await wrapper.get('[data-testid="message-template-save"]').trigger('click');
    await flushPromises();

    expect(apiMocks.createMessageTemplate).toHaveBeenCalledOnce();
    expect(wrapper.get('[role="alert"]').text()).toContain('saved, but the latest template list could not be loaded');
    expect((wrapper.get('[data-testid="message-template-name"]').element as HTMLInputElement).value).toBe('Approval');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('keeps ordinary save disabled after a conflict and generic list reload', async () => {
    apiMocks.listMyMessageTemplates
      .mockResolvedValueOnce({ templates: [template(1)] })
      .mockResolvedValueOnce({ templates: [template(2)] });
    apiMocks.updateMessageTemplate.mockRejectedValue(conflict());
    const wrapper = mount(MessageTemplateManager);
    await flushPromises();
    await wrapper.get('.vb-template-name').trigger('click');
    await wrapper.get('[data-testid="message-template-body"]').setValue('My preserved draft.');
    await wrapper.get('[data-testid="message-template-save"]').trigger('click');
    await flushPromises();

    const reload = wrapper.findAll('button').find((button) => button.text() === 'Reload templates');
    expect(reload).toBeDefined();
    if (!reload) throw new Error('Reload templates button not found');
    await reload.trigger('click');
    await flushPromises();

    const save = wrapper.get('[data-testid="message-template-save"]');
    expect(save.attributes('disabled')).toBeDefined();
    expect((wrapper.get('[data-testid="message-template-body"]').element as HTMLTextAreaElement).value).toBe(
      'My preserved draft.'
    );
    await save.trigger('click');
    expect(apiMocks.updateMessageTemplate).toHaveBeenCalledOnce();
  });

  it('preserves the draft and conflict state when reload latest fails', async () => {
    apiMocks.listMyMessageTemplates
      .mockResolvedValueOnce({ templates: [template(1)] })
      .mockRejectedValueOnce(new Error('refresh unavailable'));
    apiMocks.updateMessageTemplate.mockRejectedValue(conflict());
    const wrapper = mount(MessageTemplateManager);
    await flushPromises();
    await wrapper.get('.vb-template-name').trigger('click');
    await wrapper.get('[data-testid="message-template-body"]').setValue('My preserved draft.');
    await wrapper.get('[data-testid="message-template-save"]').trigger('click');
    await flushPromises();

    const reloadLatest = wrapper.findAll('button').find((button) => button.text() === 'Reload latest');
    expect(reloadLatest).toBeDefined();
    if (!reloadLatest) throw new Error('Reload latest button not found');
    await reloadLatest.trigger('click');
    await flushPromises();

    expect((wrapper.get('[data-testid="message-template-body"]').element as HTMLTextAreaElement).value).toBe(
      'My preserved draft.'
    );
    expect(wrapper.text()).toContain('Your draft is preserved');
    expect(wrapper.get('[data-testid="message-template-save"]').attributes('disabled')).toBeDefined();
  });
});
