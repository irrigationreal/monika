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
  const wrappers: { unmount(): void }[] = [];
  let focused = true;
  let visibilityState: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    focused = true;
    visibilityState = 'visible';
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    api.getReplyDraft.mockResolvedValue({ draft: null });
    api.getDraft.mockResolvedValue({ draft: null });
    api.saveReplyDraft.mockResolvedValue({ draft });
  });
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
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
    wrappers.push(wrapper);
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

  it('flushes once when hidden, pauses, and adopts the latest saved draft when active again', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    const { wrapper, body, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('final hidden text');

    visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(api.saveReplyDraft).toHaveBeenCalledWith('topic-1', {
      expectedRevision: draft.revision,
      body: 'final hidden text',
    });

    await wrapper.find('textarea').setValue('programmatic hidden change');
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.saveReplyDraft).toHaveBeenCalledTimes(1);

    const latest = { ...draft, body: 'newest saved text', revision: 2 };
    api.getDraft.mockResolvedValue({ draft: latest });
    body.value = 'final hidden text';
    visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(body.value).toBe('newest saved text');
    expect(state().draft.value).toEqual(latest);
    expect(state().status.value).toBe('saved');
  });

  it('clears a clean editor when its saved draft was removed while inactive', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    const { body, state } = subject();
    await state().load();

    focused = false;
    window.dispatchEvent(new Event('blur'));
    await settle();
    api.getDraft.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await settle();

    expect(body.value).toBe('');
    expect(state().draft.value).toBeNull();
    expect(state().remoteDraft.value).toBeNull();
    expect(state().status.value).toBe('idle');
  });

  it('preserves dirty local text and reports a conflict when focus returns to a changed remote base', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    api.saveReplyDraft.mockRejectedValueOnce(new Error('network failed'));
    const { wrapper, body, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('unsaved local text');

    focused = false;
    window.dispatchEvent(new Event('blur'));
    await settle();
    expect(state().dirty.value).toBe(true);

    const latest = { ...draft, body: 'saved elsewhere', revision: 2 };
    api.getDraft.mockResolvedValue({ draft: latest });
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await settle();

    expect(body.value).toBe('unsaved local text');
    expect(state().remoteDraft.value).toEqual(latest);
    expect(state().status.value).toBe('conflict');
  });

  it('ignores a stale revalidation response after a newer local save completes', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    let resolveRevalidation!: (value: unknown) => void;
    api.getDraft.mockReturnValue(
      new Promise((resolve) => {
        resolveRevalidation = resolve;
      })
    );
    const { wrapper, state } = subject();
    await state().load();

    window.dispatchEvent(new Event('focus'));
    await settle();
    await wrapper.find('textarea').setValue('new local save');
    const locallySaved = { ...draft, body: 'new local save', revision: 2 };
    api.saveReplyDraft.mockResolvedValue({ draft: locallySaved });
    await state().flush();
    resolveRevalidation({ draft });
    await settle();

    expect(state().draft.value).toEqual(locallySaved);
    expect(state().remoteDraft.value).toBeNull();
    expect(state().status.value).toBe('saved');
  });

  it('forces a final save when focus is lost during pending reconciliation', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    let resolveRevalidation!: (value: unknown) => void;
    api.getDraft.mockReturnValue(
      new Promise((resolve) => {
        resolveRevalidation = resolve;
      })
    );
    const { wrapper, body, state } = subject();
    await state().load();

    window.dispatchEvent(new Event('focus'));
    await settle();
    await wrapper.find('textarea').setValue('typed during reconciliation');
    const locallySaved = { ...draft, body: 'typed during reconciliation', revision: 2 };
    api.saveReplyDraft.mockResolvedValue({ draft: locallySaved });

    focused = false;
    window.dispatchEvent(new Event('blur'));
    await settle();
    expect(api.saveReplyDraft).toHaveBeenCalledWith('topic-1', {
      expectedRevision: draft.revision,
      body: 'typed during reconciliation',
    });

    resolveRevalidation({ draft });
    await settle();
    expect(body.value).toBe('typed during reconciliation');
    expect(state().draft.value).toEqual(locallySaved);
    expect(state().remoteDraft.value).toBeNull();
    expect(state().status.value).toBe('saved');
  });

  it('starts a fresh autosave for text preserved during publication reset', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    const { wrapper, state } = subject();
    await state().load();
    state().pause();
    await wrapper.find('textarea').setValue('late second quick reply');
    state().resetAfterPublication();
    await vi.advanceTimersByTimeAsync(1500);

    expect(api.saveReplyDraft).toHaveBeenCalledWith('topic-1', {
      expectedRevision: 0,
      body: 'late second quick reply',
    });
    expect(state().status.value).toBe('saved');
  });

  it('rejects a publication flush before initial draft hydration completes', async () => {
    const { state } = subject();
    await expect(state().flush()).rejects.toThrow('Draft is still loading.');
    expect(api.saveReplyDraft).not.toHaveBeenCalled();
  });

  it('ignores a stale load failure after the draft context changes', async () => {
    let rejectLoad!: (error: unknown) => void;
    api.getReplyDraft.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectLoad = reject;
      })
    );
    const { wrapper, contextId, state } = subject();
    const loading = state().load();
    contextId.value = 'topic-2';
    await wrapper.vm.$nextTick();
    rejectLoad(new Error('stale load failure'));
    await loading;

    expect(state().loadError.value).toBeNull();
    expect(state().status.value).toBe('idle');
    expect(state().hydrated.value).toBe(false);
  });

  it('ignores a stale conflict-refresh failure after the draft context changes', async () => {
    api.getReplyDraft.mockResolvedValue({ draft });
    api.saveReplyDraft.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    let rejectRefresh!: (error: unknown) => void;
    api.getDraft.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      })
    );
    const { wrapper, contextId, state } = subject();
    await state().load();
    await wrapper.find('textarea').setValue('conflicting local text');
    const flushing = state().flush();
    await settle();

    contextId.value = 'topic-2';
    await wrapper.vm.$nextTick();
    rejectRefresh(new Error('stale refresh failure'));
    await flushing;

    expect(state().remoteDraft.value).toBeNull();
    expect(state().status.value).toBe('idle');
    expect(state().hydrated.value).toBe(false);
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
    const wrapper = mount(
      defineComponent({
        setup() {
          exposed = useAutosavedDraft({ context: 'new_thread', contextId, body, title, initialDraftId: draftId });
          return {};
        },
        template: '<div />',
      })
    );
    wrappers.push(wrapper);
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
