import { defineComponent, ref } from 'vue';

import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutosavedDraft } from './useAutosavedDraft';

const api = vi.hoisted(() => ({
  getReplyDraft: vi.fn(),
  getDraft: vi.fn(),
  saveReplyDraft: vi.fn(),
  createNewThreadDraft: vi.fn(),
  updateDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));
vi.mock('../lib/apiClient', () => ({ api }));

const draft = {
  id: '00000000-0000-4000-8000-000000000001',
  context: 'reply' as const,
  forumId: null,
  topicId: 'topic-1',
  title: null,
  body: 'saved',
  revision: 1,
  createdAt: '2026-08-02T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  expiresAt: '2026-09-01T00:00:00Z',
  destinationName: 'Topic',
  canContinue: true,
};

describe('useAutosavedDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.getReplyDraft.mockResolvedValue({ draft: null });
    api.getDraft.mockResolvedValue({ draft: null });
    api.saveReplyDraft.mockResolvedValue({ draft });
  });
  afterEach(() => vi.useRealTimers());
  function subject() {
    let exposed: ReturnType<typeof useAutosavedDraft> | undefined;
    const body = ref('');
    const contextId = ref<string | null>('topic-1');
    const wrapper = mount(
      defineComponent({
        setup() {
          exposed = useAutosavedDraft({ context: 'reply', contextId, body });
          return { body };
        },
        template: '<textarea v-model="body" />',
      })
    );
    return {
      wrapper,
      body,
      contextId,
      state: () => {
        if (!exposed) throw new Error('composable not initialized');
        return exposed;
      },
    };
  }
  it('hydrates without overwriting text typed before the response', async () => {
    let resolve!: (value: unknown) => void;
    api.getReplyDraft.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { wrapper, body, state } = subject();
    const loading = state().load();
    await wrapper.find('textarea').setValue('typed locally');
    resolve({ draft });
    await loading;
    expect(body.value).toBe('typed locally');
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.saveReplyDraft).toHaveBeenCalledWith('topic-1', {
      expectedRevision: draft.revision,
      body: 'typed locally',
    });
  });
  it('debounces and coalesces saves, then exposes the acknowledged reference', async () => {
    const { wrapper, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('first');
    await vi.advanceTimersByTimeAsync(1499);
    expect(api.saveReplyDraft).not.toHaveBeenCalled();
    await wrapper.find('textarea').setValue('second');
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.saveReplyDraft).toHaveBeenCalledTimes(1);
    const savedInput = api.saveReplyDraft.mock.calls[0]?.[1] as { body: string } | undefined;
    expect(savedInput?.body).toBe('second');
    expect(state().reference.value).toEqual({ id: draft.id, revision: 1 });
  });
  it('deletes an acknowledged draft when the editor becomes empty', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    const { wrapper, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('');
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.deleteDraft).toHaveBeenCalledWith(draft.id, draft.revision);
  });
  it('flushes edits before the debounce window when navigation is requested', async () => {
    const { wrapper, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('leave safely');
    const navigable = await state().flushForNavigation();
    expect({ navigable, dirty: state().dirty.value, status: state().status.value }).toEqual({
      navigable: true,
      dirty: false,
      status: 'saved',
    });
    expect(api.saveReplyDraft).toHaveBeenCalledWith('topic-1', {
      expectedRevision: 0,
      body: 'leave safely',
    });
  });
  it('never saves an old-context snapshot under the next topic', async () => {
    let resolveSave!: (value: unknown) => void;
    api.saveReplyDraft.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    const { wrapper, contextId, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('topic one text');
    contextId.value = 'topic-2';
    await wrapper.vm.$nextTick();
    expect(api.saveReplyDraft).toHaveBeenCalledWith('topic-1', {
      expectedRevision: 0,
      body: 'topic one text',
    });
    expect(api.saveReplyDraft).not.toHaveBeenCalledWith('topic-2', expect.anything());
    resolveSave({ draft });
    await Promise.resolve();
  });
  it('waits for an in-flight create and deletes its acknowledged revision during discard', async () => {
    let resolveSave!: (value: unknown) => void;
    api.saveReplyDraft.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    const { wrapper, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('discard me');
    await vi.advanceTimersByTimeAsync(1500);
    const discarding = state().discard();
    expect(api.deleteDraft).not.toHaveBeenCalled();
    resolveSave({ draft });
    await discarding;
    expect(api.deleteDraft).toHaveBeenCalledWith(draft.id, draft.revision);
    expect(state().draft.value).toBeNull();
    expect(state().dirty.value).toBe(false);
  });
  it('restores autosave scheduling when discard deletion conflicts', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    api.deleteDraft.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    const { wrapper, state } = subject();
    await state().load();
    await expect(state().discard()).rejects.toThrow('conflict');
    await wrapper.find('textarea').setValue('still editable');
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.saveReplyDraft).toHaveBeenCalled();
  });

  it('detaches the prior new-thread draft before an invalid draft URL load', async () => {
    const firstDraft = {
      ...draft,
      id: '00000000-0000-4000-8000-000000000010',
      context: 'new_thread' as const,
      forumId: 'forum-1',
      topicId: null,
      title: 'First draft',
    };
    api.getDraft
      .mockResolvedValueOnce({ draft: firstDraft })
      .mockRejectedValueOnce(Object.assign(new Error('Draft not found'), { status: 404 }));
    let exposed: ReturnType<typeof useAutosavedDraft> | undefined;
    const body = ref('');
    const title = ref('');
    const contextId = ref<string | null>('forum-1');
    const draftId = ref<string | null>(firstDraft.id);
    mount(
      defineComponent({
        setup() {
          exposed = useAutosavedDraft({ context: 'new_thread', contextId, body, title, initialDraftId: draftId });
          return {};
        },
        template: '<div />',
      })
    );
    if (!exposed) throw new Error('composable not initialized');
    await exposed.load();
    expect(exposed.draft.value?.id).toBe(firstDraft.id);

    draftId.value = '00000000-0000-4000-8000-000000000011';
    body.value = '';
    title.value = '';
    await exposed.load();
    expect(exposed.draft.value).toBeNull();
    expect(exposed.loadError.value).toContain('Draft not found');
    await exposed.flush();
    expect(api.deleteDraft).not.toHaveBeenCalled();
    expect(api.updateDraft).not.toHaveBeenCalled();
  });
});
