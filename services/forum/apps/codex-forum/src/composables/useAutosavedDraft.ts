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
  const publicationSuspended = ref(false);
  const loadError = ref<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  let inFlight: Promise<void> | null = null;
  let inactiveFlush: Promise<void> | null = null;
  let inactiveFlushPending = false;
  let pending = false;
  let generation = 0;
  let lifecycleGeneration = 0;
  let activeContextId: string | null = input.contextId.value;
  let activeDraftId: string | null = input.initialDraftId?.value ?? null;
  let inactive = document.visibilityState !== 'visible' || !document.hasFocus();
  let reconciling = false;
  const acknowledged = ref('');

  const snapshot = (): DraftSnapshot => ({ title: input.title?.value ?? null, body: input.body.value });
  const signature = (value = snapshot()) => JSON.stringify(value);
  const isBlank = (value = snapshot()) => !value.body.trim() && !value.title?.trim();
  const expiresAt = computed(() => draft.value?.expiresAt ?? null);
  const reference = computed(() => (draft.value ? { id: draft.value.id, revision: draft.value.revision } : undefined));
  const dirty = computed(() => hydrated.value && signature() !== acknowledged.value);
  const pageIsActive = () => document.visibilityState === 'visible' && document.hasFocus();
  const publicationIsSuspended = () => publicationSuspended.value;

  function clearTimers(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = maxTimer = retryTimer = null;
  }
  function schedule(): void {
    if (!hydrated.value || publicationSuspended.value || inactive || reconciling || !dirty.value) return;
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
      if (myGeneration !== generation || activeContextId !== contextId) return;
      loadError.value = error instanceof Error ? error.message : 'The requested draft could not be loaded.';
      classify(error);
    } finally {
      if (myGeneration === generation && activeContextId === contextId) {
        hydrated.value = true;
        schedule();
      }
    }
  }
  async function save(allowInactive = false): Promise<void> {
    clearTimers();
    if (!hydrated.value || publicationSuspended.value) return;
    pending = true;
    if (allowInactive) inactiveFlushPending = true;
    if (inFlight) return inFlight;
    const operation = (async () => {
      while (pending && !publicationSuspended.value) {
        if ((inactive || reconciling) && !inactiveFlushPending) break;
        pending = false;
        inactiveFlushPending = false;
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
    const baseDraftId = draft.value?.id ?? null;
    const baseDraftRevision = draft.value?.revision ?? null;
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
        expectedRevision: baseDraftRevision ?? 0,
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
        const conflictBaseIsCurrent = () =>
          myGeneration === generation &&
          activeContextId === contextId &&
          (draft.value?.id ?? null) === baseDraftId &&
          (draft.value?.revision ?? null) === baseDraftRevision;
        try {
          const latest = baseDraftId
            ? (await api.getDraft(baseDraftId)).draft
            : input.context === 'reply'
              ? (await api.getReplyDraft(contextId)).draft
              : null;
          if (!conflictBaseIsCurrent()) return;
          remoteDraft.value = latest;
        } catch {
          if (!conflictBaseIsCurrent()) return;
          remoteDraft.value = null;
        }
      } else classify(error);
    }
  }
  async function flush(): Promise<{ id: string; revision: number } | undefined> {
    if (!hydrated.value) throw new Error('Draft is still loading.');
    clearTimers();
    await save(true);
    return reference.value;
  }
  async function flushForNavigation(): Promise<boolean> {
    if (!hydrated.value || !dirty.value) return true;
    // Publication pauses autosave before clearing the editor and navigating.
    if (publicationSuspended.value) return true;
    await flush();
    return !dirty.value;
  }
  async function discard(): Promise<void> {
    publicationSuspended.value = true;
    reconciling = false;
    ++lifecycleGeneration;
    clearTimers();
    pending = false;
    inactiveFlushPending = false;
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
      publicationSuspended.value = false;
      inactive = !pageIsActive();
      schedule();
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
    await save(true);
  }
  async function copyMyText(): Promise<void> {
    await navigator.clipboard.writeText([input.title?.value, input.body.value].filter(Boolean).join('\n\n'));
  }
  function pause(): void {
    publicationSuspended.value = true;
    reconciling = false;
    ++lifecycleGeneration;
    clearTimers();
    pending = false;
    inactiveFlushPending = false;
  }
  function resume(): void {
    publicationSuspended.value = false;
    if (pageIsActive() && inactive) void activate();
    else schedule();
  }
  function resetAfterPublication(): void {
    ++generation;
    ++lifecycleGeneration;
    clearTimers();
    pending = false;
    inactiveFlushPending = false;
    inactiveFlush = null;
    retryCount = 0;
    draft.value = null;
    remoteDraft.value = null;
    if (input.context === 'new_thread') activeDraftId = null;
    acknowledged.value = signature({ title: input.title ? '' : null, body: '' });
    status.value = 'idle';
    loadError.value = null;
    publicationSuspended.value = false;
    inactive = !pageIsActive();
    reconciling = false;
    schedule();
  }
  function scheduleRetry(): void {
    if (retryCount >= 3 || publicationSuspended.value || inactive || reconciling) return;
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
  async function revalidate(allowInactive = false): Promise<void> {
    const contextId = activeContextId;
    if (
      !contextId ||
      !hydrated.value ||
      publicationSuspended.value ||
      (!allowInactive && inactive) ||
      status.value === 'saving'
    )
      return;
    if (input.context === 'new_thread' && !draft.value) return;
    const myGeneration = generation;
    const baseId = draft.value?.id ?? null;
    const baseRevision = draft.value?.revision ?? null;
    const baseAcknowledged = acknowledged.value;
    let latest: MessageDraftDto | null;
    try {
      latest = baseId
        ? (await api.getDraft(baseId)).draft
        : input.context === 'reply'
          ? (await api.getReplyDraft(contextId)).draft
          : null;
    } catch (error) {
      const code = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (code !== 404) return;
      latest = null;
    }
    if (
      myGeneration !== generation ||
      activeContextId !== contextId ||
      publicationIsSuspended() ||
      draft.value?.id !== (baseId ?? undefined) ||
      draft.value?.revision !== (baseRevision ?? undefined) ||
      acknowledged.value !== baseAcknowledged
    )
      return;
    const latestRevision = latest?.revision ?? null;
    const latestId = latest?.id ?? null;
    if (latestRevision === baseRevision && latestId === baseId) return;
    if (dirty.value) {
      remoteDraft.value = latest;
      status.value = 'conflict';
      return;
    }
    draft.value = latest;
    remoteDraft.value = null;
    input.body.value = latest?.body ?? '';
    if (input.title) input.title.value = latest?.title ?? '';
    acknowledged.value = signature();
    status.value = latest ? 'saved' : 'idle';
  }

  function deactivate(): void {
    if (inactive) return;
    inactive = true;
    reconciling = false;
    ++lifecycleGeneration;
    clearTimers();
    const finalSave = save(true);
    inactiveFlush = finalSave;
    void finalSave.finally(() => {
      if (inactiveFlush === finalSave) inactiveFlush = null;
    });
  }
  function activationIsInvalid(expectedGeneration: number): boolean {
    return expectedGeneration !== lifecycleGeneration || !pageIsActive() || publicationSuspended.value;
  }
  function finishInvalidActivation(expectedGeneration: number): void {
    if (expectedGeneration === lifecycleGeneration) reconciling = false;
  }
  async function activate(): Promise<void> {
    if (!pageIsActive() || reconciling) return;
    inactive = false;
    reconciling = true;
    const myLifecycleGeneration = ++lifecycleGeneration;
    const finalSave = inactiveFlush;
    if (finalSave) await finalSave;
    if (activationIsInvalid(myLifecycleGeneration)) {
      finishInvalidActivation(myLifecycleGeneration);
      return;
    }
    await revalidate(true);
    if (activationIsInvalid(myLifecycleGeneration)) {
      finishInvalidActivation(myLifecycleGeneration);
      return;
    }
    reconciling = false;
    schedule();
  }

  watch(input.contextId, (nextContextId) => {
    // Start the old-context save synchronously so its snapshot and destination are captured
    // before sibling route watchers clear or hydrate the editor.
    if (dirty.value && !publicationSuspended.value) void save(true);
    ++generation;
    ++lifecycleGeneration;
    reconciling = false;
    clearTimers();
    pending = false;
    inactiveFlushPending = false;
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
  const visibility = () => {
    if (pageIsActive()) void activate();
    else deactivate();
  };
  const online = () => {
    if (pageIsActive()) void activate();
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty.value) return;
    event.preventDefault();
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', deactivate);
  window.addEventListener('focus', visibility);
  window.addEventListener('online', online);
  window.addEventListener('pageshow', visibility);
  window.addEventListener('beforeunload', beforeUnload);
  onBeforeUnmount(() => {
    ++generation;
    ++lifecycleGeneration;
    clearTimers();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('blur', deactivate);
    window.removeEventListener('focus', visibility);
    window.removeEventListener('online', online);
    window.removeEventListener('pageshow', visibility);
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
    resetAfterPublication,
    useSavedVersion,
    keepMyVersion,
    copyMyText,
  };
}
