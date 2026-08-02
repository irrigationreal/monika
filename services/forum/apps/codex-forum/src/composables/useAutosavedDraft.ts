import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { api } from '../lib/apiClient';

import type { Ref } from 'vue';

import type { MessageDraftDto } from '../lib/apiClient';

export type DraftSaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'failed' | 'conflict' | 'auth' | 'too_large';

interface DraftSnapshot {
  title: string | null;
  body: string;
}

export function useAutosavedDraft(input: {
  context: 'reply' | 'new_thread';
  contextId: Ref<string | null>;
  body: Ref<string>;
  title?: Ref<string>;
  initialDraftId?: Ref<string | null>;
  onDraftCreated?: (id: string) => void;
}) {
  const draft = ref<MessageDraftDto | null>(null);
  const remoteDraft = ref<MessageDraftDto | null>(null);
  const status = ref<DraftSaveStatus>('idle');
  const hydrated = ref(false);
  const suspended = ref(false);
  const loadError = ref<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let generation = 0;
  let activeContextId: string | null = input.contextId.value;
  let activeDraftId: string | null = input.initialDraftId?.value ?? null;
  const acknowledged = ref('');

  const snapshot = (): DraftSnapshot => ({ title: input.title?.value ?? null, body: input.body.value });
  const signature = (value = snapshot()) => JSON.stringify(value);
  const isBlank = (value = snapshot()) => !value.body.trim() && !value.title?.trim();
  const expiresAt = computed(() => draft.value?.expiresAt ?? null);
  const reference = computed(() => (draft.value ? { id: draft.value.id, revision: draft.value.revision } : undefined));
  const dirty = computed(() => hydrated.value && signature() !== acknowledged.value);

  function clearTimers(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = maxTimer = retryTimer = null;
  }
  function schedule(): void {
    if (!hydrated.value || suspended.value || !dirty.value) return;
    pending = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void save(), 1500);
    maxTimer ??= setTimeout(() => void save(), 5000);
  }
  async function load(): Promise<void> {
    const contextId = input.contextId.value;
    if (!contextId) return;
    const requestedDraftId = input.context === 'new_thread' ? (input.initialDraftId?.value ?? null) : null;
    if (input.context === 'new_thread' && requestedDraftId !== activeDraftId) {
      clearTimers();
      pending = false;
      retryCount = 0;
      activeDraftId = requestedDraftId;
      draft.value = null;
      remoteDraft.value = null;
      hydrated.value = false;
      acknowledged.value = signature();
      status.value = 'idle';
    }
    activeContextId = contextId;
    const localBefore = signature();
    const myGeneration = ++generation;
    loadError.value = null;
    try {
      const response =
        input.context === 'reply'
          ? await api.getReplyDraft(contextId)
          : requestedDraftId
            ? await api.getDraft(requestedDraftId)
            : { draft: null };
      if (myGeneration !== generation || activeContextId !== contextId) return;
      if (
        input.context === 'new_thread' &&
        response.draft &&
        (response.draft.context !== 'new_thread' || response.draft.forumId !== contextId)
      ) {
        throw new Error('This draft does not belong to the selected forum. Remove the draft parameter to start fresh.');
      }
      draft.value = response.draft;
      remoteDraft.value = null;
      if (signature() === localBefore && response.draft) {
        input.body.value = response.draft.body;
        if (input.title) input.title.value = response.draft.title ?? '';
      }
      acknowledged.value = response.draft
        ? signature({ title: input.title ? (response.draft.title ?? '') : null, body: response.draft.body })
        : signature({ title: input.title ? '' : null, body: '' });
      status.value = response.draft ? 'saved' : 'idle';
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'The requested draft could not be loaded.';
      classify(error);
    } finally {
      if (myGeneration === generation && activeContextId === contextId) {
        hydrated.value = true;
        schedule();
      }
    }
  }
  async function save(): Promise<void> {
    clearTimers();
    if (!hydrated.value || suspended.value) return;
    pending = true;
    if (inFlight) return inFlight;
    const operation = (async () => {
      while (pending && !suspended.value) {
        pending = false;
        await performSave();
        if (['conflict', 'auth', 'too_large'].includes(status.value)) pending = false;
      }
    })();
    inFlight = operation;
    try {
      await operation;
    } finally {
      if (inFlight === operation) inFlight = null;
    }
  }
  async function performSave(): Promise<void> {
    const contextId = activeContextId;
    if (!contextId) return;
    const myGeneration = generation;
    const value = snapshot();
    const valueSignature = signature(value);
    if (valueSignature === acknowledged.value) return;
    status.value = 'saving';
    try {
      if (isBlank(value)) {
        if (draft.value) await api.deleteDraft(draft.value.id, draft.value.revision);
        if (myGeneration !== generation || activeContextId !== contextId) return;
        draft.value = null;
        acknowledged.value = valueSignature;
        status.value = 'idle';
        return;
      }
      const payload = {
        expectedRevision: draft.value?.revision ?? 0,
        title: value.title,
        body: value.body,
      };
      const response =
        input.context === 'reply'
          ? await api.saveReplyDraft(contextId, { expectedRevision: payload.expectedRevision, body: payload.body })
          : draft.value
            ? await api.updateDraft(draft.value.id, payload)
            : await api.createNewThreadDraft(contextId, payload);
      if (myGeneration !== generation || activeContextId !== contextId) return;
      if (!response.draft) throw new Error('Draft save returned no draft');
      const created = !draft.value;
      draft.value = response.draft;
      if (input.context === 'new_thread') activeDraftId = response.draft.id;
      acknowledged.value = valueSignature;
      status.value = 'saved';
      loadError.value = null;
      retryCount = 0;
      if (created) input.onDraftCreated?.(response.draft.id);
    } catch (error) {
      if (myGeneration !== generation || activeContextId !== contextId) return;
      if (isConflict(error)) {
        status.value = 'conflict';
        try {
          const latest = draft.value
            ? (await api.getDraft(draft.value.id)).draft
            : input.context === 'reply'
              ? (await api.getReplyDraft(contextId)).draft
              : null;
          if (myGeneration !== generation || activeContextId !== contextId) return;
          remoteDraft.value = latest;
        } catch {
          remoteDraft.value = null;
        }
      } else classify(error);
    }
  }
  async function flush(): Promise<{ id: string; revision: number } | undefined> {
    clearTimers();
    await save();
    return reference.value;
  }
  async function flushForNavigation(): Promise<boolean> {
    if (!hydrated.value || !dirty.value) return true;
    // Publication pauses autosave before clearing the editor and navigating.
    if (suspended.value) return true;
    await flush();
    return !dirty.value;
  }
  async function discard(): Promise<void> {
    suspended.value = true;
    clearTimers();
    pending = false;
    try {
      if (inFlight) await inFlight;
      ++generation;
      const current = draft.value;
      if (current) await api.deleteDraft(current.id, current.revision);
      draft.value = null;
      remoteDraft.value = null;
      input.body.value = '';
      if (input.title) input.title.value = '';
      acknowledged.value = signature();
      status.value = 'idle';
      loadError.value = null;
    } finally {
      suspended.value = false;
    }
  }
  function useSavedVersion(): void {
    if (!remoteDraft.value) return;
    draft.value = remoteDraft.value;
    input.body.value = remoteDraft.value.body;
    if (input.title) input.title.value = remoteDraft.value.title ?? '';
    acknowledged.value = signature();
    remoteDraft.value = null;
    status.value = 'saved';
  }
  async function keepMyVersion(): Promise<void> {
    draft.value = remoteDraft.value;
    remoteDraft.value = null;
    acknowledged.value = '__conflict__';
    status.value = 'idle';
    await save();
  }
  async function copyMyText(): Promise<void> {
    await navigator.clipboard.writeText([input.title?.value, input.body.value].filter(Boolean).join('\n\n'));
  }
  function pause(): void {
    suspended.value = true;
    clearTimers();
  }
  function resume(): void {
    suspended.value = false;
    schedule();
  }
  function scheduleRetry(): void {
    if (retryCount >= 3 || suspended.value) return;
    const delays = [2000, 5000, 15000];
    const delay = delays[retryCount] ?? 15000;
    retryCount += 1;
    retryTimer = setTimeout(() => void save(), delay);
  }
  function classify(error: unknown): void {
    const code = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    if (code === 401 || code === 403) status.value = 'auth';
    else if (code === 413 || (code === 400 && error instanceof Error && /64 KiB|too large/i.test(error.message)))
      status.value = 'too_large';
    else if (!navigator.onLine) status.value = 'offline';
    else status.value = 'failed';
    if (status.value === 'offline' || status.value === 'failed') scheduleRetry();
  }
  function isConflict(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409);
  }
  async function revalidate(): Promise<void> {
    const contextId = activeContextId;
    if (!contextId || !hydrated.value || suspended.value || status.value === 'saving') return;
    if (input.context === 'new_thread' && !draft.value) return;
    const myGeneration = generation;
    try {
      const latest = draft.value
        ? (await api.getDraft(draft.value.id)).draft
        : input.context === 'reply'
          ? (await api.getReplyDraft(contextId)).draft
          : null;
      if (myGeneration !== generation || activeContextId !== contextId) return;
      if (latest?.revision !== draft.value?.revision || latest?.id !== draft.value?.id) {
        remoteDraft.value = latest;
        status.value = 'conflict';
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (code === 404 && myGeneration === generation && activeContextId === contextId) {
        remoteDraft.value = null;
        status.value = 'conflict';
      }
    }
  }

  watch(input.contextId, (nextContextId) => {
    // Start the old-context save synchronously so its snapshot and destination are captured
    // before sibling route watchers clear or hydrate the editor.
    if (dirty.value && !suspended.value) void save();
    ++generation;
    clearTimers();
    pending = false;
    retryCount = 0;
    activeContextId = nextContextId;
    activeDraftId = input.initialDraftId?.value ?? null;
    draft.value = null;
    remoteDraft.value = null;
    hydrated.value = false;
    acknowledged.value = '';
    loadError.value = null;
    status.value = 'idle';
  });
  watch([input.body, ...(input.title ? [input.title] : [])], schedule);
  const focus = () => {
    if (status.value === 'offline' || status.value === 'failed') void save();
    else void revalidate();
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty.value) return;
    event.preventDefault();
  };
  window.addEventListener('online', focus);
  window.addEventListener('focus', focus);
  window.addEventListener('beforeunload', beforeUnload);
  onBeforeUnmount(() => {
    ++generation;
    clearTimers();
    window.removeEventListener('online', focus);
    window.removeEventListener('focus', focus);
    window.removeEventListener('beforeunload', beforeUnload);
  });

  return {
    draft,
    remoteDraft,
    status,
    expiresAt,
    reference,
    dirty,
    hydrated,
    loadError,
    load,
    flush,
    flushForNavigation,
    discard,
    pause,
    resume,
    useSavedVersion,
    keepMyVersion,
    copyMyText,
  };
}
