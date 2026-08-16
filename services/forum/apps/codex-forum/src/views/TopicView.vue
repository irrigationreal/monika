<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

import AutoCompactOption from '../components/AutoCompactOption.vue';
import ConfirmationDialog from '../components/ConfirmationDialog.vue';
import DecryptText from '../components/DecryptText.vue';
import DraftStatus from '../components/DraftStatus.vue';
import LiveAssistantTurn from '../components/LiveAssistantTurn.vue';
import MessageTemplatePicker from '../components/MessageTemplatePicker.vue';
import OperationalEventBar from '../components/OperationalEventBar.vue';
import PostTracePanel from '../components/PostTracePanel.vue';
import ToolMiniView from '../components/ToolMiniView.vue';
import { useAutosavedDraft } from '../composables/useAutosavedDraft';
import { useForumState } from '../composables/useForumState';
import { useMarkdown } from '../composables/useMarkdown';
import { applyTemplateToTextarea } from '../composables/useMessageTemplateInsertion';
import { api } from '../lib/apiClient';
import { createClientOperationId } from '../lib/clientOperationId';
import { copyTextToClipboard } from '../lib/clipboard';
import { parseReasoningSteps } from '../lib/reasoning';
import { getToolMiniModel, toolKindIcon, traceToneForKind } from '../lib/toolMiniView';
import { toolHumanTitle } from '../lib/toolTimeline';
import { buildLiveTraceItems, buildPersistedTraceItems } from '../lib/unifiedTrace';

import type { RobotActivityEvent } from '../composables/useForumState';
import type {
  AttachmentDto,
  CompactionOperationDto,
  ForkBoundaryDto,
  ForkOperationDto,
  ForumDto,
  MessageTemplateDto,
  PostDto,
  RobotPersonaDto,
  SessionInspectorDto,
  ToolRunDto,
  TopicCompactionStateDto,
  TopicForkStateDto,
  TopicOperationalEventDto,
} from '../lib/apiClient';
import type { ReasoningStep } from '../lib/reasoning';
import type { UnifiedTraceItem } from '../lib/unifiedTrace';

type LiveTurnItem = {
  id: string;
  type: 'status' | 'reasoning' | 'tool' | 'assistant_text' | 'error';
  title: string;
  status: 'running' | 'success' | 'error' | 'done';
  meta?: string | null;
  detail?: string | null;
  markdown?: string | null;
  text?: string | null;
  startedAt?: string | null;
  timeoutMs?: number | null;
  finished?: boolean;
};

const { renderContent, renderBBCode } = useMarkdown();
const apiAny = api as any;
const compactionApi = api;

const route = useRoute();
const router = useRouter();
const state = useForumState();

const replyBody = ref('');
const quickReplyTextareaRef = ref<HTMLTextAreaElement | null>(null);
const quickReplyContainerRef = ref<HTMLElement | null>(null);
const quickReplyExpandButtonRef = ref<HTMLButtonElement | null>(null);
const quickReplyKeepVisibleButtonRef = ref<HTMLButtonElement | null>(null);
const quickReplyPresentation = ref<'inline' | 'docked-expanded' | 'docked-collapsed'>('inline');
const quickReplyPresentationReady = ref(false);
const quickReplyOptionsOpen = ref(false);
let quickReplyPresentationTouched = false;
const quickReplyDocked = computed(() => quickReplyPresentation.value !== 'inline');
const quickReplyExpanded = computed(() => quickReplyPresentation.value === 'docked-expanded');
const editingPost = ref<PostDto | null>(null);
const editBody = ref('');
const showDeleteConfirm = ref<string | null>(null);
const showAllTools = ref(false);
const toolUsageReasoningStorageKey = 'codex-forum:tool-usage:show-reasoning';
const toolUsageResponseLimit = 20;
const showToolReasoning = ref(readToolUsageReasoningPreference());
const expandedReasoning = ref(new Set<string>());
const showAdminPanel = ref(false);
const editingTitle = ref(false);
const newTitle = ref('');
const showDeleteTopicConfirm = ref(false);
const showMoveTopicModal = ref(false);
const moveForumOptions = ref<ForumDto[]>([]);
const selectedMoveForumId = ref('');
const moveConfirmChecked = ref(false);
const moveSilentChecked = ref(false);
const moveError = ref('');
const moveLoading = ref(false);
const expandedTools = ref(new Set<string>());
const showInspectorTools = ref(false);
const expandedInspectorTools = ref(new Set<string>());
const showInspectorMessages = ref(false);
const showScrollTop = ref(false);
const isReplying = ref(false);
const isPublishingReply = ref(false);
const isUploadingReply = ref(false);
const allowQuickReplyNavigation = ref(false);
const replyFiles = ref<File[]>([]);
const publishedReplyPostId = ref<string | null>(null);
const publishedReplyNeedsDispatch = ref(false);
const replyFileInputRef = ref<HTMLInputElement | null>(null);
const deletingByAttachment = ref<Record<string, boolean>>({});
const ttsLoadingByPost = ref<Record<string, boolean>>({});
const ttsErrorsByPost = ref<Record<string, string>>({});
const threadSearchOpen = ref(false);
const threadSearchQuery = ref('');
const selectedModel = ref(state.lastReplyModel.value ?? '');
const selectedReasoning = ref(state.lastReplyReasoning.value ?? 'medium');
const replyModels = computed(() => state.allModelOptions.value);
const effectiveSelectedModel = computed(
  () => selectedModel.value || (state.robotState.value as any)?.model || state.defaultModel.value || ''
);
const supportsReasoning = computed(() => state.modelSupportsReasoning(effectiveSelectedModel.value));
const replyReasoningOptions = computed(() => state.modelReasoningOptions(effectiveSelectedModel.value));
const canModerate = computed(() => state.canModerate.value);
const isAdmin = computed(() => state.currentUser.value?.kind === 'admin');
const isRobotBusy = computed(() => state.isRobotBusy.value);
const showStopRobotConfirm = ref(false);
const showDiscardDraftConfirm = ref(false);
const discardDraftPending = ref(false);
const discardDraftError = ref('');
const topicRobotMode = computed(() => state.selectedTopic.value?.robotMode ?? null);
const autoCompactEnabled = ref(false);
const robotControlPending = computed(() => state.robotControlPending.value);
const isSticky = computed(() => state.selectedTopic.value?.tags?.includes('sticky') ?? false);
const copiedPostSourceId = ref<string | null>(null);
const copiedLinkPostId = ref<string | null>(null);
const DEFAULT_HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. States the user's goal for the next thread
4. Gives the next assistant enough context to continue smoothly without re-reading the entire previous conversation

Write in the user's voice as an instruction to the next assistant. Be concise but preserve important technical details.`;

const showHandoffModal = ref(false);
const handoffStage = ref<'generate' | 'edit'>('generate');
const handoffGoal = ref('');
const handoffDraft = ref('');
const handoffTitle = ref('');
const handoffError = ref('');
const handoffLoading = ref(false);
const handoffPanelRef = ref<HTMLElement | null>(null);
const handoffSystemPrompt = ref('');
const showHandoffAdvancedPrompt = ref(false);
const showHandoffDraftModelAdvanced = ref(false);
const showHandoffLaunchAdvanced = ref(false);
const handoffDraftModel = ref('');
const handoffDraftReasoning = ref('medium');
const handoffLaunchModel = ref('');
const handoffLaunchReasoning = ref('medium');
const handoffDestinationForumId = ref('');
const handoffCwdOverride = ref('');
const handoffOverrideCwd = ref(false);

const DEFAULT_RECOVERY_PROMPT = `This session was manually compacted before this message. Before doing any further work, restate:

1. the current goal,
2. work already completed,
3. work currently in progress,
4. remaining steps,
5. blockers, uncertainties, or details that may have been lost.

Do not perform additional work in this response. This is a context-recovery checkpoint.`;
const showCompactionModal = ref(false);
const showCompactionAdvanced = ref(false);
const compactionRecoveryPrompt = ref(DEFAULT_RECOVERY_PROMPT);
const compactionInstructions = ref('');
const compactionConfirmed = ref(false);
const compactionOperation = ref<CompactionOperationDto | null>(null);
const compactionState = ref<TopicCompactionStateDto>({ active: null, latest: null, checkpointDispatch: null });
const compactionError = ref('');
const compactionSubmitting = ref(false);
const compactionRetryingCheckpoint = ref(false);
const compactionModalRef = ref<HTMLElement | null>(null);
const showForkModal = ref(false);
const forkBoundaries = ref<ForkBoundaryDto[]>([]);
const forkBoundaryPostId = ref('');
const forkTitle = ref('');
const forkOpeningBody = ref('');
const forkOperation = ref<ForkOperationDto | null>(null);
const forkState = ref<TopicForkStateDto>({ active: null, latest: null });
const forkError = ref('');
const forkSubmitting = ref(false);
const forkModalRef = ref<HTMLElement | null>(null);
let forkPollTimer: number | null = null;
let forkFocusOrigin: HTMLElement | null = null;
let bodyOverflowBeforeForkModal = '';
interface ForkIntent {
  operationId: string;
  topicId: string;
  boundaryPostId: string;
  title: string;
  openingBody: string;
  createdAt: string;
  status: 'submitting' | ForkOperationDto['status'];
}
const COMPACTION_INTENT_GRACE_MS = 60_000;
let compactionPollTimer: number | null = null;
let compactionFocusOrigin: HTMLElement | null = null;
let bodyOverflowBeforeCompactionModal = '';
let compactionRequestGeneration = 0;
const compactionActive = computed(() => {
  const operation = compactionState.value.active ?? compactionOperation.value;
  return operation?.status === 'pending' || operation?.status === 'running';
});
const checkpointDispatchPending = computed(
  () =>
    compactionState.value.checkpointDispatch?.status === 'pending' ||
    compactionState.value.checkpointDispatch?.status === 'dispatching'
);
const checkpointNeedsRecovery = computed(
  () =>
    compactionState.value.latest?.status === 'succeeded' &&
    compactionState.value.checkpointDispatch?.status === 'failed'
);
const forkFence = computed(() => {
  const operation = forkState.value.active ?? forkOperation.value;
  return (
    operation?.status === 'pending' || operation?.status === 'running' || operation?.status === 'needs_manual_review'
  );
});
const forkNeedsManualReview = computed(
  () => (forkState.value.active ?? forkOperation.value)?.status === 'needs_manual_review'
);
const compactionFence = computed(
  () => compactionActive.value || checkpointDispatchPending.value || checkpointNeedsRecovery.value || forkFence.value
);
const canFork = computed(
  () =>
    isAdmin.value &&
    !isRobotBusy.value &&
    !state.isTopicLocked() &&
    !compactionFence.value &&
    !forkSubmitting.value &&
    forkOperation.value?.status !== 'pending' &&
    forkOperation.value?.status !== 'running'
);
const canCompact = computed(
  () =>
    isAdmin.value &&
    !isRobotBusy.value &&
    !state.isTopicLocked() &&
    !compactionSubmitting.value &&
    !compactionFence.value
);

const autoRun = computed(() => state.topicAutoRun.value);
const showAutoRunPanel = computed(() => isAdmin.value && showAdminPanel.value && Boolean(routeTopicId.value));
const showRobotStatePanel = computed(() => isAdmin.value && topicRobotMode.value && topicRobotMode.value !== 'off');
const showSessionInspectorPanel = computed(
  () => isAdmin.value && topicRobotMode.value && topicRobotMode.value !== 'off'
);
const autoRunEnabled = ref(false);
const autoRunContext = ref('');
const autoRunWorker = ref<'echs'>('echs');
const autoRunModel = ref('');
const autoRunReasoning = ref('');
const autoRunMaxReplies = ref(20);
const autoRunSteerMessage = ref('');
const autoRunModelOptions = computed(() => {
  return [{ value: '', label: 'Default' }, ...replyModels.value.map((model) => ({ value: model, label: model }))];
});
const showAutoRunReasoning = computed(() => state.modelSupportsReasoning(autoRunModel.value));
const autoRunReasoningOptions = computed(() => state.modelReasoningOptions(autoRunModel.value));

function readToolUsageReasoningPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(toolUsageReasoningStorageKey) !== 'false';
  } catch {
    return true;
  }
}

watch(showToolReasoning, (showReasoning) => {
  try {
    window.localStorage.setItem(toolUsageReasoningStorageKey, String(showReasoning));
  } catch {
    // The in-memory preference still applies when browser storage is unavailable.
  }
});

function operationalEventsAfter(postId: string): TopicOperationalEventDto[] {
  return state.operationalEvents.value
    .filter((event) => event.anchorPostId === postId)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const unanchoredOperationalEvents = computed(() =>
  state.operationalEvents.value
    .filter((event) => !event.anchorPostId)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
);

function isRecoveryCheckpoint(postId: string): boolean {
  return state.operationalEvents.value.some(
    (event) =>
      event.type === 'compaction' && event.status === 'succeeded' && event.detail?.['recoveryPostId'] === postId
  );
}

function compactionIntentKey(topicId: string): string {
  return `codex-forum:compaction-intent:${topicId}`;
}

function persistCompactionIntent(operation: CompactionOperationDto): void {
  try {
    window.localStorage.setItem(compactionIntentKey(operation.topicId), JSON.stringify(operation));
  } catch {
    // Runtime state and the server-side fence remain authoritative when storage is unavailable.
  }
}

function loadCompactionIntent(topicId: string): CompactionOperationDto | null {
  try {
    const raw = window.localStorage.getItem(compactionIntentKey(topicId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CompactionOperationDto;
    return parsed.topicId === topicId && (parsed.status === 'pending' || parsed.status === 'running') ? parsed : null;
  } catch {
    return null;
  }
}

function clearCompactionIntent(topicId: string): void {
  try {
    window.localStorage.removeItem(compactionIntentKey(topicId));
  } catch {
    // Nothing else is required; a successful state read has already reconciled the operation.
  }
}

function stopCompactionPolling(): void {
  if (compactionPollTimer !== null) window.clearTimeout(compactionPollTimer);
  compactionPollTimer = null;
}

function scheduleCompactionPolling(): void {
  stopCompactionPolling();
  const topicId = routeTopicId.value;
  if ((!compactionActive.value && !checkpointDispatchPending.value) || !topicId) return;
  compactionPollTimer = window.setTimeout(() => void refreshCompactionState(topicId), 2000);
}

async function refreshCompactionDependentState(topicId: string): Promise<void> {
  await Promise.all([
    state.loadPosts(topicId),
    state.loadOperationalEvents(topicId),
    state.loadState(topicId, { reconstructTrace: false }),
  ]);
  await Promise.all([
    state.loadAttachmentsForPosts(state.posts.value.map((post) => post.id)),
    state.loadSessionInspector(),
  ]);
}

async function refreshCompactionState(topicId: string, refreshTopic = false): Promise<boolean> {
  const generation = ++compactionRequestGeneration;
  try {
    const previousStatus = compactionState.value.active?.status ?? compactionOperation.value?.status ?? null;
    const next = await compactionApi.getCompactionState(topicId);
    if (generation !== compactionRequestGeneration || routeTopicId.value !== topicId) return false;
    const intent = loadCompactionIntent(topicId);
    const intentAge = intent ? Date.now() - new Date(intent.createdAt).getTime() : Infinity;
    if (intent && !next.active && next.latest?.id !== intent.id && intentAge < COMPACTION_INTENT_GRACE_MS) {
      compactionState.value = { ...next, active: intent };
      compactionOperation.value = intent;
      return true;
    }
    if (next.active) persistCompactionIntent(next.active);
    else if (intent) clearCompactionIntent(topicId);
    compactionState.value = next;
    compactionOperation.value = next.active ?? next.latest;
    if (refreshTopic || (previousStatus !== null && previousStatus !== next.active?.status && !next.active)) {
      await refreshCompactionDependentState(topicId);
    }
    return true;
  } catch (err) {
    if (generation === compactionRequestGeneration && routeTopicId.value === topicId && isAdmin.value) {
      compactionError.value = err instanceof Error ? err.message : 'Could not refresh compaction status.';
    }
    return false;
  } finally {
    if (generation === compactionRequestGeneration && routeTopicId.value === topicId) scheduleCompactionPolling();
  }
}

function restoreCompactionModalEnvironment(): void {
  document.body.style.overflow = bodyOverflowBeforeCompactionModal;
  const focusTarget = compactionFocusOrigin;
  compactionFocusOrigin = null;
  void nextTick(() => focusTarget?.focus());
}

function openCompactionModal(): void {
  if (!canCompact.value) return;
  compactionFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  bodyOverflowBeforeCompactionModal = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  showCompactionModal.value = true;
  showCompactionAdvanced.value = false;
  compactionRecoveryPrompt.value = DEFAULT_RECOVERY_PROMPT;
  compactionInstructions.value = '';
  compactionConfirmed.value = false;
  compactionError.value = '';
  void nextTick(() => compactionModalRef.value?.querySelector<HTMLElement>('.vb-modal-close')?.focus());
}

function closeCompactionModal(): void {
  if (compactionSubmitting.value) return;
  showCompactionModal.value = false;
  restoreCompactionModalEnvironment();
}

function handleCompactionKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !compactionSubmitting.value) {
    event.preventDefault();
    closeCompactionModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    compactionModalRef.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
    ) ?? []
  ).filter((element) => element.offsetParent !== null);
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function submitCompaction(): Promise<void> {
  const topicId = routeTopicId.value;
  if (!topicId || !canCompact.value) return;
  if (!compactionConfirmed.value) {
    compactionError.value = 'Confirm that you understand this permanently replaces older context with a summary.';
    return;
  }
  if (!compactionRecoveryPrompt.value.trim()) {
    compactionError.value = 'Recovery prompt is required.';
    return;
  }

  compactionError.value = '';
  compactionSubmitting.value = true;
  let operationId: string | null = null;
  try {
    operationId = createClientOperationId();
    const customInstructions = compactionInstructions.value.trim();
    const pendingIntent: CompactionOperationDto = {
      id: operationId,
      topicId,
      sessionId: '',
      initiatedBy: state.currentUser.value?.id ?? '',
      expectedLeafId: '',
      customInstructions: customInstructions ? customInstructions : null,
      recoveryPrompt: compactionRecoveryPrompt.value.trim(),
      status: 'pending',
      eventId: null,
      recoveryPostId: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    compactionOperation.value = pendingIntent;
    compactionState.value = { ...compactionState.value, active: pendingIntent };
    persistCompactionIntent(pendingIntent);
    const accepted = await compactionApi.compactTopic(topicId, {
      operationId,
      confirmation: 'COMPACT',
      customInstructions: customInstructions ? customInstructions : null,
      recoveryPrompt: compactionRecoveryPrompt.value.trim(),
    });
    if (routeTopicId.value !== topicId) return;
    compactionOperation.value = accepted;
    compactionState.value = { ...compactionState.value, active: accepted };
    persistCompactionIntent(accepted);
    compactionSubmitting.value = false;
    closeCompactionModal();
    await refreshCompactionState(topicId, accepted.status === 'succeeded' || accepted.status === 'failed');
  } catch (err) {
    const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : null;
    if (typeof status === 'number' && [400, 401, 403, 404, 409, 422].includes(status)) {
      if (routeTopicId.value !== topicId) return;
      if (status === 409) {
        const refreshed = await refreshCompactionState(topicId);
        if (routeTopicId.value !== topicId) return;
        if (refreshed) clearCompactionIntent(topicId);
        compactionError.value =
          refreshed && compactionFence.value
            ? ''
            : refreshed
              ? err instanceof Error
                ? err.message
                : 'Compaction request conflicted with current topic state.'
              : 'Compaction request conflicted; checking the authoritative server status.';
      } else {
        clearCompactionIntent(topicId);
        compactionOperation.value = null;
        compactionState.value = { ...compactionState.value, active: null };
        compactionError.value = err instanceof Error ? err.message : 'Compaction request was rejected.';
      }
      return;
    }
    if (!operationId) {
      if (routeTopicId.value !== topicId) return;
      compactionError.value = err instanceof Error ? err.message : 'Compaction request failed.';
      return;
    }
    // The acceptance response can be lost after the durable row is written. Query
    // the client-owned operation ID before presenting the transport error as final.
    try {
      const reconciled = await compactionApi.getCompaction(topicId, operationId);
      if (routeTopicId.value !== topicId) return;
      compactionOperation.value = reconciled;
      await refreshCompactionState(topicId, reconciled.status === 'succeeded' || reconciled.status === 'failed');
      if (reconciled.status === 'pending' || reconciled.status === 'running') {
        compactionSubmitting.value = false;
        closeCompactionModal();
      } else if (reconciled.status === 'failed') {
        compactionError.value = reconciled.errorMessage ?? 'Compaction failed.';
      } else {
        compactionSubmitting.value = false;
        closeCompactionModal();
      }
    } catch {
      if (routeTopicId.value !== topicId) return;
      compactionError.value = `${err instanceof Error ? err.message : 'Compaction request failed.'} The outcome is unknown; do not retry while the forum checks the durable operation.`;
      compactionSubmitting.value = false;
      closeCompactionModal();
      scheduleCompactionPolling();
    }
  } finally {
    if (routeTopicId.value === topicId) compactionSubmitting.value = false;
  }
}

async function retryCompactionCheckpoint(): Promise<void> {
  const topicId = routeTopicId.value;
  const operationId = compactionState.value.latest?.id;
  if (!topicId || !operationId || !checkpointNeedsRecovery.value || compactionRetryingCheckpoint.value) return;
  compactionRetryingCheckpoint.value = true;
  compactionError.value = '';
  try {
    const next = await compactionApi.retryCompactionCheckpoint(topicId, operationId);
    if (routeTopicId.value !== topicId) return;
    compactionState.value = next;
    scheduleCompactionPolling();
  } catch (err) {
    await refreshCompactionState(topicId);
    if (routeTopicId.value !== topicId) return;
    if (checkpointNeedsRecovery.value) {
      compactionError.value = err instanceof Error ? err.message : 'Could not retry the recovery checkpoint.';
    }
  } finally {
    if (routeTopicId.value === topicId) compactionRetryingCheckpoint.value = false;
  }
}

function forkIntentKey(topicId: string): string {
  return `codex-forum:fork-intent:${topicId}`;
}

function persistForkIntent(intent: ForkIntent): void {
  try {
    window.localStorage.setItem(forkIntentKey(intent.topicId), JSON.stringify(intent));
  } catch {
    // The durable server operation remains authoritative when storage is unavailable.
  }
}

function loadForkIntent(topicId: string): ForkIntent | null {
  try {
    const raw = window.localStorage.getItem(forkIntentKey(topicId));
    if (!raw) return null;
    const intent = JSON.parse(raw) as ForkIntent;
    return intent.topicId === topicId && /^[A-Za-z0-9_-]{1,128}$/.test(intent.operationId) ? intent : null;
  } catch {
    return null;
  }
}

function persistForkOperationState(topicId: string, operation: ForkOperationDto): void {
  const intent = loadForkIntent(topicId);
  if (intent?.operationId === operation.id) persistForkIntent({ ...intent, status: operation.status });
}

function clearForkIntent(topicId: string): void {
  try {
    window.localStorage.removeItem(forkIntentKey(topicId));
  } catch {
    // A terminal server response has already reconciled the operation.
  }
}

function restoreForkModalEnvironment(): void {
  document.body.style.overflow = bodyOverflowBeforeForkModal;
  const focusTarget = forkFocusOrigin;
  forkFocusOrigin = null;
  void nextTick(() => focusTarget?.focus());
}

function handleForkKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !forkSubmitting.value) {
    event.preventDefault();
    closeForkModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    forkModalRef.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
    ) ?? []
  ).filter((element) => element.offsetParent !== null);
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function openForkModal(): Promise<void> {
  const topicId = routeTopicId.value;
  if (!topicId || !canFork.value) return;
  forkFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  bodyOverflowBeforeForkModal = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  forkError.value = '';
  forkBoundaries.value = [];
  showForkModal.value = true;
  void nextTick(() => forkModalRef.value?.querySelector<HTMLElement>('.vb-modal-close')?.focus());
  try {
    const response = await api.listForkBoundaries(topicId);
    if (routeTopicId.value !== topicId) return;
    forkBoundaries.value = response.items;
    const boundary = response.items.at(-1);
    if (!boundary) {
      forkError.value = 'No stable completed user-message boundary is available.';
      return;
    }
    const intent = loadForkIntent(topicId);
    forkBoundaryPostId.value = intent?.boundaryPostId ?? boundary.postId;
    forkOpeningBody.value = intent?.openingBody ?? boundary.body;
    forkTitle.value = intent?.title ?? `Fork: ${state.selectedTopic.value?.title ?? 'Topic'}`;
  } catch (error) {
    forkError.value = error instanceof Error ? error.message : 'Could not load fork boundaries.';
  }
}

function closeForkModal(): void {
  if (forkSubmitting.value) return;
  showForkModal.value = false;
  restoreForkModalEnvironment();
}

function selectForkBoundary(): void {
  const boundary = forkBoundaries.value.find((item) => item.postId === forkBoundaryPostId.value);
  if (boundary) forkOpeningBody.value = boundary.body;
}

async function pollFork(topicId: string, operationId: string): Promise<void> {
  try {
    const operation = await api.getFork(topicId, operationId);
    if (routeTopicId.value !== topicId) return;
    forkOperation.value = operation;
    persistForkOperationState(topicId, operation);
    forkState.value = {
      active:
        operation.status === 'pending' || operation.status === 'running' || operation.status === 'needs_manual_review'
          ? operation
          : null,
      latest: operation,
    };
    const intent = loadForkIntent(topicId);
    if (operation.status === 'succeeded' && operation.childTopicId) {
      if (intent?.operationId === operation.id) {
        clearForkIntent(topicId);
        if (showForkModal.value) {
          showForkModal.value = false;
          restoreForkModalEnvironment();
        }
        await router.push({ name: 'topic.view', params: { topicId: operation.childTopicId } });
      }
    } else if (operation.status === 'needs_manual_review') {
      if (intent?.operationId === operation.id) clearForkIntent(topicId);
      forkError.value = operation.errorMessage ?? 'Fork needs operator review; the source remains fenced.';
    } else if (operation.status === 'failed') {
      if (intent?.operationId === operation.id) clearForkIntent(topicId);
      forkError.value = operation.errorMessage ?? 'Fork failed.';
    } else scheduleForkPoll(topicId, operationId);
  } catch {
    if (routeTopicId.value !== topicId) return;
    await refreshForkState(topicId);
    if (routeTopicId.value === topicId && loadForkIntent(topicId)?.operationId === operationId)
      scheduleForkPoll(topicId, operationId);
  }
}

async function refreshForkState(topicId: string): Promise<void> {
  try {
    const next = await api.getForkState(topicId);
    if (routeTopicId.value !== topicId) return;
    forkState.value = next;
    const intent = loadForkIntent(topicId);
    const matching = intent
      ? ([next.active, next.latest].find((operation) => operation?.id === intent.operationId) ?? null)
      : null;
    if (matching) {
      forkOperation.value = matching;
      persistForkOperationState(topicId, matching);
      if (matching.status === 'pending' || matching.status === 'running') scheduleForkPoll(topicId, matching.id);
      else if (matching.status === 'succeeded' && matching.childTopicId) {
        clearForkIntent(topicId);
        await router.push({ name: 'topic.view', params: { topicId: matching.childTopicId } });
      } else if (matching.status === 'needs_manual_review') {
        clearForkIntent(topicId);
        forkError.value = matching.errorMessage ?? 'Fork needs operator review; the source remains fenced.';
      } else if (matching.status === 'failed') {
        clearForkIntent(topicId);
        forkError.value = matching.errorMessage ?? 'Fork failed.';
      }
      return;
    }
    if (next.active) {
      forkOperation.value = next.active;
      if (next.active.status === 'pending' || next.active.status === 'running')
        scheduleForkPoll(topicId, next.active.id);
      else forkError.value = next.active.errorMessage ?? 'Fork needs operator review; the source remains fenced.';
      return;
    }
    if (intent) {
      // The original response was ambiguous. Re-submit the exact durable id and
      // payload; server idempotency prevents a duplicate fork if it was accepted.
      const operation = await api.createFork(topicId, {
        operationId: intent.operationId,
        boundaryPostId: intent.boundaryPostId,
        title: intent.title,
        openingBody: intent.openingBody,
      });
      if (routeTopicId.value !== topicId) return;
      forkOperation.value = operation;
      persistForkOperationState(topicId, operation);
      if (operation.status === 'pending' || operation.status === 'running') scheduleForkPoll(topicId, operation.id);
      else if (operation.status === 'needs_manual_review') {
        clearForkIntent(topicId);
        forkError.value = operation.errorMessage ?? 'Fork needs operator review; the source remains fenced.';
      }
      return;
    }
    forkOperation.value = next.latest;
  } catch (error) {
    if (routeTopicId.value === topicId) {
      forkError.value = error instanceof Error ? error.message : 'Could not refresh fork status.';
      const intent = loadForkIntent(topicId);
      if (intent) scheduleForkPoll(topicId, intent.operationId);
    }
  }
}

function scheduleForkPoll(topicId: string, operationId: string): void {
  if (forkPollTimer !== null) window.clearTimeout(forkPollTimer);
  forkPollTimer = window.setTimeout(() => {
    void pollFork(topicId, operationId);
  }, 1000);
}

async function submitFork(): Promise<void> {
  const topicId = routeTopicId.value;
  if (!topicId || !forkBoundaryPostId.value || !canFork.value) return;
  forkSubmitting.value = true;
  forkError.value = '';
  const intent = loadForkIntent(topicId) ?? {
    operationId: createClientOperationId(),
    topicId,
    boundaryPostId: forkBoundaryPostId.value,
    title: forkTitle.value.trim(),
    openingBody: forkOpeningBody.value.trim(),
    createdAt: new Date().toISOString(),
    status: 'submitting' as const,
  };
  persistForkIntent(intent);
  const operationId = intent.operationId;
  try {
    const operation = await api.createFork(topicId, {
      operationId,
      boundaryPostId: intent.boundaryPostId,
      title: intent.title,
      openingBody: intent.openingBody,
    });
    if (routeTopicId.value !== topicId) return;
    forkOperation.value = operation;
    persistForkOperationState(topicId, operation);
    if (operation.status === 'pending' || operation.status === 'running') scheduleForkPoll(topicId, operation.id);
    else if (operation.status === 'needs_manual_review') {
      clearForkIntent(topicId);
      forkError.value = operation.errorMessage ?? 'Fork needs operator review; the source remains fenced.';
    }
  } catch (error) {
    try {
      const operation = await api.getFork(topicId, operationId);
      if (routeTopicId.value !== topicId) return;
      forkOperation.value = operation;
      persistForkOperationState(topicId, operation);
      if (operation.status === 'pending' || operation.status === 'running') scheduleForkPoll(topicId, operation.id);
      else if (operation.status === 'needs_manual_review') {
        clearForkIntent(topicId);
        forkError.value = operation.errorMessage ?? 'Fork needs operator review; the source remains fenced.';
      }
    } catch {
      forkError.value = `${error instanceof Error ? error.message : 'Fork request failed.'} The outcome is unknown; the same durable operation will be reconciled automatically.`;
      scheduleForkPoll(topicId, operationId);
    }
  } finally {
    if (routeTopicId.value === topicId) forkSubmitting.value = false;
  }
}

function normalizeReasoning(model: string, reasoning: string): string {
  const options = state.modelReasoningOptions(model);
  if (options.includes(reasoning)) return reasoning;
  if (options.includes('medium')) return 'medium';
  return options[0] ?? 'medium';
}
const autoRunStatusLabel = computed(() => {
  const current = autoRun.value;
  if (!current || !current.enabled) return 'Disabled';
  if (current.status === 'running') return 'Running';
  if (current.status === 'error') return 'Error';
  if (current.status === 'stopped') return 'Stopped';
  return 'Enabled';
});
const canEditAutoRun = computed(() => isAdmin.value);
const autoRunBusy = computed(() => state.autoRunLoading.value);

const showRobotDraft = computed(() => state.hasPendingAssistantTurn.value);
const canViewLiveTrace = computed(() => state.isLoggedIn.value);

const liveTurnPostNumber = computed(() => state.sortedPosts.value.length + 1);
const liveTurnPage = computed(() => pageForPostNumber(liveTurnPostNumber.value));
const showRobotDraftOnCurrentPage = computed(
  () => showRobotDraft.value && state.currentPage.value === liveTurnPage.value
);
const showDetailedLiveTraceOnCurrentPage = computed(() => showRobotDraftOnCurrentPage.value && canViewLiveTrace.value);
const showPublicRobotPlaceholderOnCurrentPage = computed(
  () => showRobotDraftOnCurrentPage.value && !canViewLiveTrace.value
);

const liveActivityEvents = computed<RobotActivityEvent[]>(() => state.activityLog.value);

const isRobotThinking = computed(() => {
  if (!topicRobotMode.value) return false;
  if (topicRobotMode.value === 'off') return false;
  const activity = state.robotState.value?.activity ?? 'idle';
  return activity !== 'idle';
});

const showRobotBusyNotice = computed(() => {
  if (!topicRobotMode.value) return false;
  return isRobotBusy.value && topicRobotMode.value !== 'off';
});

const quickReplyWillDispatchRobot = computed(() => {
  if (!topicRobotMode.value) return false;
  const mode = topicRobotMode.value;
  if (mode === 'off') return false;
  if (mode === 'auto') return true;
  return /@robot\b/i.test(replyBody.value);
});

const quickReplyWillSteerRobot = computed(() => showRobotBusyNotice.value && quickReplyWillDispatchRobot.value);
const sessionContext = computed(() => state.sessionContext.value);
const topicLineage = computed(() => state.selectedTopic.value?.lineage ?? null);
const piSessionDiagnostics = computed(() => state.sessionInfo.value?.piSession ?? null);
const topicLineageLabel = computed(() => {
  const kind = topicLineage.value?.kind;
  if (!kind) return null;
  if (kind === 'handoff') return 'Handoff from parent session';
  if (kind === 'fork') return 'Forked from parent session';
  if (kind === 'delegate') return 'Delegate fork from parent session';
  if (kind === 'sleep') return 'Sleep fork from parent session';
  return 'Parent session';
});
const handoffDestinationForum = computed(
  () => moveForumOptions.value.find((forum) => forum.id === handoffDestinationForumId.value) ?? null
);
const handoffEffectiveCwd = computed(() =>
  handoffOverrideCwd.value
    ? handoffCwdOverride.value.trim()
    : (((handoffDestinationForum.value as any)?.cwd as string | undefined) ?? '')
);
const handoffDraftModelEffective = computed(
  () => handoffDraftModel.value || effectiveSelectedModel.value || state.defaultModel.value || ''
);
const handoffLaunchModelEffective = computed(
  () => handoffLaunchModel.value || effectiveSelectedModel.value || state.defaultModel.value || ''
);
const handoffDraftSupportsReasoning = computed(() => state.modelSupportsReasoning(handoffDraftModelEffective.value));
const handoffLaunchSupportsReasoning = computed(() => state.modelSupportsReasoning(handoffLaunchModelEffective.value));
const handoffDraftReasoningOptions = computed(() => state.modelReasoningOptions(handoffDraftModelEffective.value));
const handoffLaunchReasoningOptions = computed(() => state.modelReasoningOptions(handoffLaunchModelEffective.value));

const robotModeNotice = computed(() => {
  if (topicRobotMode.value === 'off') return 'Robot replies are disabled for this thread.';
  if (topicRobotMode.value === 'mention') return 'Robot replies only when @robot is mentioned.';
  return null;
});

const liveReasoningSteps = computed(() => {
  return liveActivityEvents.value.filter(
    (e): e is Extract<RobotActivityEvent, { type: 'reasoning_step' }> => e.type === 'reasoning_step'
  );
});

const latestReasoningStep = computed(() => {
  const steps = liveReasoningSteps.value;
  return steps.length > 0 ? steps[steps.length - 1] : null;
});

const previousReasoningSteps = computed(() => {
  const steps = liveReasoningSteps.value;
  return steps.length > 1 ? steps.slice(0, -1).reverse() : [];
});

const liveToolRuns = computed(() => {
  return liveActivityEvents.value.filter(
    (e): e is Extract<RobotActivityEvent, { type: 'tool_run' }> => e.type === 'tool_run'
  );
});

const liveToolRunDtos = computed(() => liveToolRuns.value.map((e) => e.toolRun));

function compact(value: string | null | undefined, max = 400): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function liveToolTitle(tool: ToolRunDto): string {
  const mini = toolMini(tool);
  return toolHumanTitle(tool, mini) || mini.name || tool.tool || 'tool';
}

function liveToolDetail(tool: ToolRunDto): string | null {
  const mini = toolMini(tool);
  const detail = mini.detail?.lines?.length ? mini.detail.lines.join('\n') : null;
  const output = compact(mini.output, 900);
  const parts = [detail, output ? `Output:\n${output}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function liveToolDurationLabel(tool: ToolRunDto): string | null {
  if (!tool.startedAt || !tool.finishedAt) return null;
  const start = new Date(tool.startedAt).getTime();
  const end = new Date(tool.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const liveTurnItems = computed<LiveTurnItem[]>(() => {
  const items: LiveTurnItem[] = [];
  const activity = state.robotState.value?.activity ?? 'idle';
  const isIdle = activity === 'idle';

  // 1. Status item
  if (!isIdle) {
    const statusTitle =
      activity === 'running_tools'
        ? 'Running tools'
        : activity === 'waiting'
          ? 'Waiting'
          : activity === 'error'
            ? 'Error'
            : 'Thinking';
    items.push({
      id: 'status:activity',
      type: 'status',
      title: statusTitle,
      status: activity === 'error' ? 'error' : 'running',
    });
  }

  // Helper to push parsed reasoning steps from a text segment
  function pushReasoningSegment(text: string, segId: string, isLive: boolean): void {
    const steps = parseReasoningSteps(text);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      items.push({
        id: `${segId}:${i}`,
        type: 'reasoning',
        title: step.title || 'Thinking',
        status: i === steps.length - 1 && isLive && !isIdle ? 'running' : 'done',
        markdown: step.detail ?? null,
      });
    }
  }

  // Helper to look up a tool run from activityLog by toolRunId
  const toolRunIndex = new Map<string, Extract<RobotActivityEvent, { type: 'tool_run' }>>();
  for (const event of state.activityLog.value) {
    if (event.type === 'tool_run') {
      // The activityLog id is `tool:${run.id}`, but we match on the toolRun.id
      toolRunIndex.set(event.toolRun.id, event);
    }
  }

  // 2. Iterate committed segments (frozen, append-only)
  const segments = state.committedSegments.value;
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (seg.kind === 'reasoning') {
      pushReasoningSegment(seg.text, `seg:r:${s}`, false);
    } else if (seg.kind === 'assistant_text') {
      const text = seg.text.trim();
      if (text) {
        items.push({ id: `seg:a:${s}`, type: 'assistant_text', title: '', status: 'done', text });
      }
    } else if (seg.kind === 'tool') {
      const toolEvent = toolRunIndex.get(seg.toolRunId);
      if (toolEvent) {
        const tool = toolEvent.toolRun;
        const status = !tool.finishedAt ? 'running' : (toolExitCodeValue(tool) ?? 0) === 0 ? 'success' : 'error';
        const mini = toolMini(tool);
        const toolTimeoutMs =
          typeof mini.meta.timeoutMs === 'number' && Number.isFinite(mini.meta.timeoutMs)
            ? (mini.meta.timeoutMs as number)
            : null;
        const finishedTimeoutLabel =
          tool.finishedAt && toolTimeoutMs ? `timeout ${formatDuration(toolTimeoutMs)}` : null;
        items.push({
          id: toolEvent.id,
          type: 'tool',
          title: liveToolTitle(tool),
          status,
          meta: [tool.tool, toolStatusLabel(tool), liveToolDurationLabel(tool), finishedTimeoutLabel]
            .filter(Boolean)
            .join(' \u00b7 '),
          detail: liveToolDetail(tool),
          startedAt: tool.startedAt ?? null,
          timeoutMs: !tool.finishedAt ? toolTimeoutMs : null,
          finished: Boolean(tool.finishedAt),
        });
      } else {
        // Tool segment committed but state event hasn't arrived yet.
        // Show a placeholder so the trace doesn't appear to hang.
        // Use tool:${id} format so Vue transitions smoothly when real data arrives.
        items.push({
          id: `tool:${seg.toolRunId}`,
          type: 'tool',
          title: 'Running tool\u2026',
          status: 'running',
          meta: 'starting',
          detail: null,
          startedAt: null,
          timeoutMs: null,
          finished: false,
        });
      }
    }
  }

  // 3. Pending reasoning tail (live, growing)
  const pendingReasoning = state.reasoningDraft.value.trim();
  if (pendingReasoning) {
    pushReasoningSegment(pendingReasoning, 'reasoning:tail', true);
  }

  // 4. Error
  const lastError = state.robotState.value?.lastTurnError?.message ?? null;
  if (lastError && activity === 'error') {
    items.push({ id: 'error:last-turn', type: 'error', title: 'Turn error', status: 'error', detail: lastError });
  }

  // 5. Pending assistant text tail (live, growing)
  const pendingAssistant = state.assistantDraft.value.trim();
  if (pendingAssistant) {
    items.push({ id: 'assistant:live', type: 'assistant_text', title: '', status: 'running', text: pendingAssistant });
  }

  if (typeof window !== 'undefined' && items.length > 0) {
  }
  return items;
});

function toolExitCodeValue(tool: { exitCode?: number | null; outputSummary?: string | null }): number | null {
  if (tool.exitCode !== null && tool.exitCode !== undefined) return tool.exitCode;
  const summary = tool.outputSummary ?? '';
  if (!summary) return null;
  const match = summary.match(/Process exited with code\s+(-?\d+)/i) || summary.match(/Exit:\s*(-?\d+)/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

function toolStatusLabel(tool: {
  finishedAt?: string | null;
  exitCode?: number | null;
  outputSummary?: string | null;
}): string {
  if (!tool.finishedAt) return 'running';
  const exitCode = toolExitCodeValue(tool);
  if (exitCode === null || exitCode === undefined) return 'done';
  return `exit ${exitCode}`;
}

function toolStatusClass(tool: {
  finishedAt?: string | null;
  exitCode?: number | null;
  outputSummary?: string | null;
}): string {
  if (!tool.finishedAt) return 'vb-trace-tool-status--running';
  const exitCode = toolExitCodeValue(tool);
  if (exitCode === null || exitCode === undefined || exitCode === 0) return 'vb-trace-tool-status--ok';
  return 'vb-trace-tool-status--error';
}

function toolMini(tool: ToolRunDto) {
  return getToolMiniModel(tool);
}

function toolMiniName(tool: ToolRunDto): string {
  return toolMini(tool).name;
}

function toolMiniSummary(tool: ToolRunDto): string | null {
  return toolMini(tool).summary;
}

function toolMiniKind(tool: ToolRunDto) {
  return toolMini(tool).kind;
}

function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'k';
  return String(value);
}
function toolDurationLabel(tool: { startedAt?: string | null; finishedAt?: string | null }): string | null {
  if (!tool.startedAt || !tool.finishedAt) return null;
  const start = new Date(tool.startedAt).getTime();
  const end = new Date(tool.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const durationMs = Math.max(0, end - start);
  return formatDuration(durationMs);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function handleScroll(): void {
  showScrollTop.value = window.scrollY > 300;
}

function openThreadSearch(): void {
  threadSearchOpen.value = true;
  threadSearchQuery.value = '';
}

function closeThreadSearch(): void {
  threadSearchOpen.value = false;
  threadSearchQuery.value = '';
}

function forumOptionLabel(forum: ForumDto): string {
  if (!forum.parentForumId) return forum.name;
  const parent = moveForumOptions.value.find((item) => item.id === forum.parentForumId);
  return parent ? `${parent.name} / ${forum.name}` : forum.name;
}

function defaultHandoffTitle(): string {
  const base = state.selectedTopic.value?.title?.trim() || 'Handoff';
  return base.toLowerCase().startsWith('handoff:') ? base : `Handoff: ${base}`;
}

async function ensureHandoffForumOptions(): Promise<void> {
  if (moveForumOptions.value.length === 0) {
    moveForumOptions.value = await apiAny.listForums({ includeArchived: true });
  }
}

async function openHandoffModal(): Promise<void> {
  showHandoffModal.value = true;
  handoffStage.value = 'generate';
  handoffError.value = '';
  handoffSystemPrompt.value = DEFAULT_HANDOFF_SYSTEM_PROMPT;
  handoffGoal.value = '';
  handoffDraft.value = '';
  handoffTitle.value = defaultHandoffTitle();
  handoffDraftModel.value = effectiveSelectedModel.value || state.defaultModel.value || '';
  handoffLaunchModel.value = handoffDraftModel.value;
  handoffDraftReasoning.value = normalizeReasoning(handoffDraftModel.value, selectedReasoning.value);
  handoffLaunchReasoning.value = handoffDraftReasoning.value;
  handoffDestinationForumId.value = state.selectedTopic.value?.forumId ?? '';
  handoffCwdOverride.value = '';
  handoffOverrideCwd.value = false;
  await nextTick();
  handoffPanelRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    await ensureHandoffForumOptions();
  } catch (err) {
    handoffError.value = err instanceof Error ? err.message : 'Failed to load forums.';
  }
}

function closeHandoffModal(): void {
  if (handoffLoading.value) return;
  showHandoffModal.value = false;
  handoffError.value = '';
}

function resetHandoffSystemPrompt(): void {
  handoffSystemPrompt.value = DEFAULT_HANDOFF_SYSTEM_PROMPT;
}

async function generateHandoffDraft(): Promise<void> {
  if (!routeTopicId.value || !handoffGoal.value.trim()) {
    handoffError.value = 'Enter a goal for the handoff.';
    return;
  }
  handoffLoading.value = true;
  handoffError.value = '';
  try {
    const result = await apiAny.generateHandoffDraft(routeTopicId.value, {
      goal: handoffGoal.value.trim(),
      model: handoffDraftModelEffective.value || null,
      reasoningEffort: handoffDraftSupportsReasoning.value ? handoffDraftReasoning.value : null,
      systemPrompt: handoffSystemPrompt.value.trim() || null,
    });
    handoffDraft.value = result.draft || '';
    if (!handoffDraft.value.trim()) throw new Error('Handoff draft came back empty.');
    handoffTitle.value = defaultHandoffTitle();
    handoffStage.value = 'edit';
  } catch (err) {
    handoffError.value = err instanceof Error ? err.message : 'Failed to generate handoff draft.';
  } finally {
    handoffLoading.value = false;
  }
}

async function createHandoffThread(): Promise<void> {
  if (!routeTopicId.value) return;
  if (!handoffTitle.value.trim() || !handoffDraft.value.trim()) {
    handoffError.value = 'Title and draft are required.';
    return;
  }
  handoffLoading.value = true;
  handoffError.value = '';
  try {
    const result = await apiAny.createHandoff(routeTopicId.value, {
      title: handoffTitle.value.trim(),
      draft: handoffDraft.value.trim(),
      forumId: handoffDestinationForumId.value || state.selectedTopic.value?.forumId || undefined,
      cwd: handoffOverrideCwd.value ? handoffCwdOverride.value.trim() || null : null,
      model: handoffLaunchModelEffective.value || null,
      reasoningEffort: handoffLaunchSupportsReasoning.value ? handoffLaunchReasoning.value : null,
    });
    showHandoffModal.value = false;
    await router.push({ name: 'topic.view', params: { topicId: result.topic.id } });
  } catch (err) {
    handoffError.value = err instanceof Error ? err.message : 'Failed to create handoff thread.';
  } finally {
    handoffLoading.value = false;
  }
}

async function openMoveTopicModal(): Promise<void> {
  showMoveTopicModal.value = true;
  moveError.value = '';
  moveConfirmChecked.value = false;
  moveSilentChecked.value = false;
  selectedMoveForumId.value = state.selectedTopic.value?.forumId ?? '';
  if (moveForumOptions.value.length === 0) {
    try {
      moveForumOptions.value = await apiAny.listForums({ includeArchived: true });
    } catch (err) {
      moveError.value = err instanceof Error ? err.message : 'Failed to load forums.';
    }
  }
}

function closeMoveTopicModal(): void {
  showMoveTopicModal.value = false;
  moveError.value = '';
  moveConfirmChecked.value = false;
  moveSilentChecked.value = false;
}

async function confirmMoveTopic(): Promise<void> {
  if (!selectedMoveForumId.value || selectedMoveForumId.value === state.selectedTopic.value?.forumId) {
    moveError.value = 'Select a different destination forum.';
    return;
  }
  if (!moveConfirmChecked.value) {
    moveError.value = 'Please confirm that you understand the move impacts.';
    return;
  }
  moveLoading.value = true;
  moveError.value = '';
  try {
    await state.moveTopicToForum(selectedMoveForumId.value, { silent: moveSilentChecked.value });
    showMoveTopicModal.value = false;
  } catch (err) {
    moveError.value = err instanceof Error ? err.message : 'Failed to move thread.';
  } finally {
    moveLoading.value = false;
  }
}

watch(canModerate, (value) => {
  if (!value) {
    showAdminPanel.value = false;
  }
});

watch(
  () => state.selectedTopic.value?.autoCompactEnabled,
  (enabled) => {
    autoCompactEnabled.value = Boolean(enabled);
  },
  { immediate: true }
);

watch(
  () => state.lastReplyModel.value,
  (value) => {
    if (value) {
      selectedModel.value = value;
    }
  }
);

watch(
  () => state.lastReplyReasoning.value,
  (value) => {
    if (value) {
      selectedReasoning.value = value;
    }
  }
);

watch([selectedModel, () => state.defaultModel.value], ([model]) => {
  const effective = model || state.defaultModel.value || '';
  selectedReasoning.value = normalizeReasoning(effective, selectedReasoning.value);
  if (!selectedModel.value && state.defaultModel.value) selectedModel.value = state.defaultModel.value;
});

watch(
  autoRun,
  (value) => {
    autoRunEnabled.value = value?.enabled ?? false;
    autoRunContext.value = value?.context ?? '';
    autoRunWorker.value = (value?.worker as 'echs') ?? 'echs';
    autoRunModel.value = value?.model ?? '';
    autoRunReasoning.value = value?.reasoningEffort ?? '';
    autoRunMaxReplies.value = value?.maxReplies ?? 20;
  },
  { immediate: true }
);

watch(autoRunModel, (model) => {
  if (autoRunReasoning.value) {
    autoRunReasoning.value = normalizeReasoning(model, autoRunReasoning.value);
  }
});

watch(handoffDraftModel, (model) => {
  handoffDraftReasoning.value = normalizeReasoning(
    model || state.defaultModel.value || '',
    handoffDraftReasoning.value
  );
});

watch(handoffLaunchModel, (model) => {
  handoffLaunchReasoning.value = normalizeReasoning(
    model || state.defaultModel.value || '',
    handoffLaunchReasoning.value
  );
});

watch(handoffDestinationForumId, () => {
  if (!handoffOverrideCwd.value) handoffCwdOverride.value = '';
});

const filteredPosts = computed(() => {
  const posts = state.currentPosts.value;
  if (!threadSearchQuery.value.trim()) return posts;
  const query = threadSearchQuery.value.toLowerCase();
  return posts.filter(
    (post) => post.body.toLowerCase().includes(query) || state.identityName(post.authorId).toLowerCase().includes(query)
  );
});

function renderPost(body: string): string {
  const rendered = renderContent(body, { topicId: routeTopicId.value });
  if (!threadSearchQuery.value.trim()) return rendered;
  // Highlight matches in the rendered content (but not inside HTML tags)
  const query = threadSearchQuery.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${query})`, 'gi');
  // Split by HTML tags, highlight text parts, rejoin
  return rendered.replace(/>([^<]+)</g, (_match, text) => {
    return '>' + text.replace(regex, '<mark>$1</mark>') + '<';
  });
}

function renderSignature(signature: string | null): string {
  if (!signature) return '';
  return renderBBCode(signature, { topicId: routeTopicId.value });
}

type MultipostSegment = { personaKey: string | null; body: string };

function parseMultipostSegments(text: string): MultipostSegment[] {
  const segments: MultipostSegment[] = [];
  if (!text) return segments;

  const regex = /\[\[persona:([^\]\n]+)\]\]([\s\S]*?)\[\[\/persona\]\]/gi;
  let match: RegExpExecArray | null;
  let cursor = 0;
  let outside = '';

  while ((match = regex.exec(text)) !== null) {
    const start = match.index ?? 0;
    const end = regex.lastIndex;
    if (start > cursor) {
      outside += text.slice(cursor, start);
    }
    cursor = end;

    const raw = (match[1] ?? '').trim();
    const personaKey = raw ? raw.split(/\s+/)[0] : '';
    const body = (match[2] ?? '').trim();
    if (personaKey && body) {
      segments.push({ personaKey, body });
    }
  }

  if (segments.length === 0) return [];

  if (cursor < text.length) {
    outside += text.slice(cursor);
  }
  const outsideTrimmed = outside.trim();
  if (outsideTrimmed) {
    segments.unshift({ personaKey: null, body: outsideTrimmed });
  }

  return segments;
}

function isRobotOrSystemPost(post: PostDto): boolean {
  const kind = state.identities.value[post.authorId]?.kind;
  return kind === 'robot' || kind === 'system';
}

function hasMultipostSegments(body: string): boolean {
  return parseMultipostSegments(body).length > 0;
}

function personaForKey(key: string | null): RobotPersonaDto | null {
  if (!key) return null;
  return state.robotPersonas.value[key] ?? null;
}

function personaDisplayName(key: string | null): string {
  if (!key) return 'Narration';
  return personaForKey(key)?.displayName ?? `Unknown persona: ${key}`;
}

function personaTitle(key: string | null): string {
  if (!key) return 'Narration';
  return personaForKey(key)?.description ?? '';
}

function personaAvatar(key: string | null): string {
  if (!key) return '/avatars/monika.png';
  return personaForKey(key)?.avatarUrl ?? '/avatars/user.svg';
}

function personaSignature(key: string | null): string | null {
  if (!key) return null;
  return personaForKey(key)?.signature ?? null;
}

function personaNameStyle(key: string | null): Record<string, string> {
  if (!key) return {};
  const color = personaForKey(key)?.accentColor?.trim();
  return color ? { color } : {};
}

function segmentAnchorId(postId: string, segmentIndex: number): string {
  return `p${postId}-s${segmentIndex}`;
}

function isPostOwner(post: PostDto): boolean {
  return state.currentUser.value?.id === post.authorId;
}

function canEditPost(post: PostDto): boolean {
  // Only the post author can edit. (Even admins should not edit other users' posts.)
  return isPostOwner(post);
}

function canDeletePost(post: PostDto): boolean {
  // Authors can delete their own posts; admins can delete any post.
  return isPostOwner(post) || isAdmin.value;
}

function attachmentsForPost(postId: string) {
  return state.attachmentsByPost.value[postId] ?? [];
}

function visibleAttachmentsForPost(postId: string) {
  return attachmentsForPost(postId).filter((attachment) => !isTtsAttachment(attachment));
}

function isTtsAttachment(attachment: AttachmentDto): boolean {
  return attachment.mimeType.startsWith('audio/') && attachment.filename.startsWith('tts_');
}

function ttsAttachmentForPost(postId: string): AttachmentDto | null {
  return attachmentsForPost(postId).find(isTtsAttachment) ?? null;
}

function ttsUrlForPost(postId: string): string | null {
  const attachment = ttsAttachmentForPost(postId);
  return attachment ? `/api/attachments/${attachment.id}` : null;
}

async function playRobotVoice(post: PostDto): Promise<void> {
  const existing = ttsAttachmentForPost(post.id);
  if (existing) {
    await nextTick();
    const audio = document.getElementById(`tts-audio-${post.id}`) as HTMLAudioElement | null;
    if (audio) {
      audio.currentTime = 0;
      await audio.play().catch(() => {});
    }
    return;
  }

  ttsLoadingByPost.value = { ...ttsLoadingByPost.value, [post.id]: true };
  ttsErrorsByPost.value = { ...ttsErrorsByPost.value, [post.id]: '' };
  try {
    await state.generatePostTts(post.id);
    await nextTick();
    const audio = document.getElementById(`tts-audio-${post.id}`) as HTMLAudioElement | null;
    if (audio) {
      audio.currentTime = 0;
      await audio.play().catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate TTS';
    ttsErrorsByPost.value = { ...ttsErrorsByPost.value, [post.id]: message };
  } finally {
    ttsLoadingByPost.value = { ...ttsLoadingByPost.value, [post.id]: false };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function formatReasoningLabel(value: string): string {
  if (value === 'xhigh') return 'X-High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatAutoRunError(value: string | null): string {
  if (!value) return '';
  if (value === 'aborted_on_restart') return 'Aborted due to a server restart.';
  if (value === 'stale_timeout') return 'Aborted after exceeding the max runtime.';
  if (value === 'max_replies_reached') return 'Stopped after reaching the max reply limit.';
  return value;
}

function buildPageQuery(page: number): Record<string, string | string[] | null | undefined> {
  const nextQuery = { ...route.query } as Record<string, string | string[] | null | undefined>;
  nextQuery.page = String(page);
  delete nextQuery.postId;
  return nextQuery;
}

function scrollToTop(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const routeTopicId = computed(() => (route.params['topicId'] as string | undefined) ?? null);
const autosavedReply = useAutosavedDraft({ context: 'reply', contextId: routeTopicId, body: replyBody });
const canDockQuickReply = computed(() => {
  const topic = state.selectedTopic.value;
  return Boolean(state.isLoggedIn.value && topic && topic.id === routeTopicId.value && topic.status === 'open');
});
const quickReplyHasAttachmentRecovery = computed(() => Boolean(publishedReplyPostId.value));
const quickReplyCompactStatus = computed(() => {
  if (isUploadingReply.value) return 'Uploading attachments…';
  if (quickReplyHasAttachmentRecovery.value) return 'Reply posted — attachment recovery required';
  const labels = {
    idle: replyBody.value.trim() ? 'Draft not saved' : 'No draft',
    saving: 'Saving draft…',
    saved: 'Draft saved',
    offline: 'Offline — draft remains in this tab',
    failed: 'Draft save failed',
    conflict: 'Draft conflict — expand to resolve',
    auth: 'Sign in again to save this draft',
    too_large: 'Draft is too large to save',
  } as const;
  const parts: string[] = [];
  if (quickReplyWillSteerRobot.value) parts.push('Robot active — posting will steer');
  if (replyFiles.value.length > 0) {
    parts.push(`${replyFiles.value.length} attachment${replyFiles.value.length === 1 ? '' : 's'} selected`);
  }
  parts.push(labels[autosavedReply.status.value]);
  return parts.join(' · ');
});
const quickReplyCompactStatusIsProblem = computed(
  () =>
    quickReplyHasAttachmentRecovery.value ||
    quickReplyWillSteerRobot.value ||
    ['offline', 'failed', 'conflict', 'auth', 'too_large'].includes(autosavedReply.status.value)
);
const routePage = computed(() => {
  const raw = route.query['page'];
  if (Array.isArray(raw)) return Number(raw[0] ?? 1);
  return Number(raw ?? 1);
});

const routeAnchor = computed(() => {
  const hash = route.hash ?? '';
  return hash.startsWith('#') ? hash.slice(1) : hash;
});

const routePostId = computed(() => {
  const raw = route.query['postId'];
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return String(raw);
});

type ToolUsagePlan = SessionInspectorDto['plans'][number];

interface ToolUsageTraceGroup {
  id: string;
  parentPostId: string | null;
  latestAt: string;
  live: boolean;
  items: UnifiedTraceItem[];
}

interface MutableToolUsageGroup {
  id: string;
  parentPostId: string | null;
  latestAt: string;
  plan: ToolUsagePlan | null;
  tools: ToolRunDto[];
}

function laterTimestamp(current: string, candidate: string | null | undefined): string {
  return candidate && candidate > current ? candidate : current;
}

const toolUsageTraceGroups = computed<ToolUsageTraceGroup[]>(() => {
  const planById = new Map<string, ToolUsagePlan>();
  for (const plan of state.sessionInspector.value?.plans ?? []) planById.set(plan.id, plan);
  const currentPlan = state.robotState.value?.currentPlan ?? null;
  if (currentPlan) {
    const persistedPlan = planById.get(currentPlan.id);
    planById.set(currentPlan.id, {
      ...persistedPlan,
      ...currentPlan,
      parentPostId: currentPlan.parentPostId ?? persistedPlan?.parentPostId ?? null
    });
  }

  const toolById = new Map<string, ToolRunDto>();
  for (const tool of state.sessionInspector.value?.toolRuns ?? []) toolById.set(tool.id, tool);
  for (const tool of state.robotState.value?.recentToolRuns ?? []) toolById.set(tool.id, tool);

  const groups = new Map<string, MutableToolUsageGroup>();
  for (const plan of planById.values()) {
    const parentPostId = plan.parentPostId ?? null;
    const id = parentPostId ? `response:${parentPostId}` : `plan:${plan.id}`;
    const existing = groups.get(id);
    if (!existing) {
      groups.set(id, {
        id,
        parentPostId,
        latestAt: plan.updatedAt,
        plan,
        tools: []
      });
    } else {
      existing.latestAt = laterTimestamp(existing.latestAt, plan.updatedAt);
      if (!existing.plan || plan.updatedAt > existing.plan.updatedAt) existing.plan = plan;
    }
  }

  for (const tool of toolById.values()) {
    const parentPostId = tool.parentPostId ?? null;
    const id = parentPostId ? `response:${parentPostId}` : `tool:${tool.id}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        parentPostId,
        latestAt: tool.finishedAt ?? tool.startedAt,
        plan: null,
        tools: []
      };
      groups.set(id, group);
    }
    group.tools.push(tool);
    group.latestAt = laterTimestamp(group.latestAt, tool.finishedAt ?? tool.startedAt);
  }

  const active = Boolean(state.robotState.value && state.robotState.value.activity !== 'idle');
  const activeParentPostId = currentPlan?.parentPostId ?? null;
  return [...groups.values()]
    .map((group): ToolUsageTraceGroup => {
      const isLive = Boolean(
        active &&
          currentPlan &&
          (activeParentPostId
            ? group.parentPostId === activeParentPostId
            : group.plan?.id === currentPlan.id)
      );
      let items = isLive
        ? buildLiveTraceItems({
            segments: state.committedSegments.value,
            reasoningDraft: state.reasoningDraft.value,
            tools: group.tools
          })
        : [];
      if (items.length === 0) {
        items = buildPersistedTraceItems({
          reasoningText: group.plan?.summary ?? group.plan?.content ?? null,
          reasoningCheckpoints: group.plan?.reasoningCheckpoints ?? null,
          tools: group.tools
        });
      }
      return {
        id: group.id,
        parentPostId: group.parentPostId,
        latestAt: group.latestAt,
        live: isLive,
        items
      };
    })
    .filter((group) => group.items.length > 0)
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt))
    .slice(0, toolUsageResponseLimit);
});

function filteredToolUsageItems(group: ToolUsageTraceGroup): UnifiedTraceItem[] {
  return showToolReasoning.value ? group.items : group.items.filter((item) => item.type === 'tool');
}

const expandedToolUsageGroups = computed(() =>
  toolUsageTraceGroups.value
    .map((group) => ({
      ...group,
      items: filteredToolUsageItems(group)
    }))
    .filter((group) => group.items.length > 0)
);

const expandedToolUsageEntryCount = computed(() =>
  expandedToolUsageGroups.value.reduce(
    (count, group) =>
      count +
      group.items.reduce(
        (groupCount, item) => groupCount + (item.type === 'reasoning' ? item.steps.length : 1),
        0
      ),
    0
  )
);

const latestToolUsageSelection = computed(() => {
  const newestToolId =
    state.robotState.value?.recentToolRuns[0]?.id ?? state.sessionInspector.value?.toolRuns[0]?.id ?? null;
  if (newestToolId) {
    for (const group of toolUsageTraceGroups.value) {
      const item = group.items.find((candidate) => candidate.type === 'tool' && candidate.tool.id === newestToolId);
      if (item?.type === 'tool') return { group, item };
    }
  }

  const tools = toolUsageTraceGroups.value.flatMap((group) =>
    group.items
      .filter((item): item is Extract<UnifiedTraceItem, { type: 'tool' }> => item.type === 'tool')
      .map((item) => ({ group, item }))
  );
  return tools.sort((a, b) => b.item.tool.startedAt.localeCompare(a.item.tool.startedAt))[0] ?? null;
});

const canExpandToolUsage = computed(
  () => expandedToolUsageEntryCount.value > (latestToolUsageSelection.value ? 1 : 0)
);
const showingAllToolUsageGroups = computed(() => showAllTools.value && canExpandToolUsage.value);

watch(canExpandToolUsage, (canExpand) => {
  if (!canExpand) showAllTools.value = false;
});

const visibleToolUsageGroups = computed(() => {
  if (showingAllToolUsageGroups.value) return expandedToolUsageGroups.value;
  const selection = latestToolUsageSelection.value;
  if (!selection) return [];
  return [{ ...selection.group, items: [selection.item] }];
});

const visibleToolUsageEntryCount = computed(() =>
  visibleToolUsageGroups.value.reduce(
    (count, group) =>
      count +
      group.items.reduce(
        (groupCount, item) => groupCount + (item.type === 'reasoning' ? item.steps.length : 1),
        0
      ),
    0
  )
);

function toolUsageReasoningKey(
  group: ToolUsageTraceGroup,
  item: Extract<UnifiedTraceItem, { type: 'reasoning' }>,
  stepIndex: number
): string {
  return `${group.id}:reasoning:${item.segmentIndex}:${stepIndex}`;
}

function toggleToolUsageReasoning(key: string): void {
  const next = new Set(expandedReasoning.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedReasoning.value = next;
}

function toolUsageReasoningExpanded(key: string): boolean {
  return expandedReasoning.value.has(key);
}

function toolUsageReasoningPreview(detail: string | null): string | null {
  return compact(detail, 140);
}

function toolUsageReasoningStatus(
  group: ToolUsageTraceGroup,
  item: Extract<UnifiedTraceItem, { type: 'reasoning' }>,
  stepIndex: number
): 'thinking' | 'done' {
  const isLiveTail = group.items.at(-1) === item && stepIndex === item.steps.length - 1;
  return group.live && isLiveTail ? 'thinking' : 'done';
}

function toolUsageReasoningStatusClass(
  group: ToolUsageTraceGroup,
  item: Extract<UnifiedTraceItem, { type: 'reasoning' }>,
  stepIndex: number
): string {
  return toolUsageReasoningStatus(group, item, stepIndex) === 'thinking'
    ? 'vb-trace-tool-status--running'
    : 'vb-trace-tool-status--ok';
}

function renderToolUsageReasoning(detail: string): string {
  return renderContent(detail, { topicId: routeTopicId.value });
}

function toggleTool(tool: ToolRunDto): void {
  const next = new Set(expandedTools.value);
  if (next.has(tool.id)) {
    next.delete(tool.id);
  } else {
    next.add(tool.id);
  }
  expandedTools.value = next;
}

function toolExpanded(tool: ToolRunDto): boolean {
  return expandedTools.value.has(tool.id);
}

function postNumberForIndex(idx: number): number {
  return (state.currentPage.value - 1) * state.POSTS_PER_PAGE + idx + 1;
}

function postNumberForPostId(postId: string): number | null {
  const idx = state.sortedPosts.value.findIndex((post) => post.id === postId);
  if (idx < 0) return null;
  return idx + 1;
}

function parseAnchorPostNumber(anchor: string | null): number | null {
  if (!anchor) return null;
  if (!/^\d+$/.test(anchor)) return null;
  const value = Number(anchor);
  if (!Number.isFinite(value) || value < 1) return null;
  return value;
}

function pageForPostNumber(postNumber: number): number {
  return Math.floor((postNumber - 1) / state.POSTS_PER_PAGE) + 1;
}

function scrollToAnchor(behavior: ScrollBehavior = 'auto'): void {
  const anchor = routeAnchor.value;
  if (!anchor) return;
  const element = document.getElementById(anchor);
  if (!element) return;
  element.scrollIntoView({ behavior, block: 'start' });
}

async function scrollToAnchorWhenReady(behavior: ScrollBehavior = 'auto'): Promise<void> {
  const anchor = routeAnchor.value;
  if (!anchor) return;

  // When navigating to a new page with a hash, the route can update before the target post
  // is actually in the DOM (async loading + render). Keep checking until it exists or timeout.
  const timeoutMs = 5000;
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    await nextTick();
    const element = document.getElementById(anchor);
    if (element) {
      // Run on the next frame to avoid racing router scroll behavior / layout.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      element.scrollIntoView({ behavior, block: 'start' });
      return;
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

function buildPostPermalink(postNumber: number): string {
  const topicId = routeTopicId.value;
  const page = pageForPostNumber(postNumber);
  const nextQuery = buildPageQuery(page);
  const resolved = router.resolve({
    name: 'topic.view',
    params: topicId ? { topicId } : {},
    query: nextQuery,
    hash: `#${postNumber}`,
  });
  return new URL(resolved.href, window.location.origin).toString();
}

async function copyPostSource(post: PostDto): Promise<void> {
  if (post.deletedAt) return;
  try {
    await copyTextToClipboard(post.body);
    copiedPostSourceId.value = post.id;
    window.setTimeout(() => {
      if (copiedPostSourceId.value === post.id) copiedPostSourceId.value = null;
    }, 1200);
  } catch {
    state.setError('Could not copy the post. Your browser denied clipboard access.');
  }
}

async function copyPostLink(post: PostDto): Promise<void> {
  const postNumber = postNumberForPostId(post.id);
  if (!postNumber) return;
  try {
    await copyTextToClipboard(buildPostPermalink(postNumber));
    copiedLinkPostId.value = post.id;
    window.setTimeout(() => {
      if (copiedLinkPostId.value === post.id) copiedLinkPostId.value = null;
    }, 1200);
  } catch {
    state.setError('Could not copy the post link. Your browser denied clipboard access.');
  }
}

function toolRunsForPost(post: PostDto): ToolRunDto[] {
  if (!state.sessionInspector.value) return [];
  const parentId = post.parentPostId ?? post.id;
  return state.sessionInspector.value.toolRuns.filter((run) => run.parentPostId === parentId);
}

function latestToolRunForPost(post: PostDto): ToolRunDto | null {
  const runs = toolRunsForPost(post);
  return runs.at(-1) ?? null;
}

function planForPost(post: PostDto): SessionInspectorDto['plans'][number] | null {
  if (!state.sessionInspector.value) return null;
  const parentId = post.parentPostId ?? post.id;
  const matches = state.sessionInspector.value.plans.filter((plan) => plan.parentPostId === parentId);
  return matches[0] ?? null;
}

function planStepsForPost(post: PostDto): ReasoningStep[] {
  const plan = planForPost(post);
  return parseReasoningSteps(plan?.summary ?? plan?.content ?? '');
}

function hasTraceForPost(post: PostDto): boolean {
  if (!state.sessionInspector.value) return false;
  return Boolean(planForPost(post)) || toolRunsForPost(post).length > 0;
}

function getIdentity(authorId: string) {
  return state.identities.value[authorId];
}

function getUserRank(authorId: string): string {
  const identity = getIdentity(authorId);
  return identity?.rank || 'Member';
}

function getUserPostCount(authorId: string): string {
  const identity = getIdentity(authorId);
  const count = identity?.postCount ?? 0;
  return count.toLocaleString();
}

function getUserLocation(authorId: string): string {
  const identity = getIdentity(authorId);
  return identity?.location || 'Unknown';
}

function getUserJoinDate(authorId: string): string {
  const identity = getIdentity(authorId);
  if (!identity?.joinDate && !identity?.createdAt) return 'Unknown';
  const date = new Date(identity.joinDate || identity.createdAt);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function getUserSignature(authorId: string): string | null {
  const identity = getIdentity(authorId);
  return identity?.signature || null;
}

function toggleInspectorTool(id: string): void {
  const next = new Set(expandedInspectorTools.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedInspectorTools.value = next;
}

function inspectorToolExpanded(id: string): boolean {
  return expandedInspectorTools.value.has(id);
}

function openEditModal(post: PostDto): void {
  if (state.isTopicLocked()) {
    state.setError('Cannot edit posts in a locked or archived topic.');
    return;
  }
  if (!canEditPost(post)) {
    state.setError('You do not have permission to edit this post.');
    return;
  }
  editingPost.value = post;
  editBody.value = post.body;
}

function closeEditModal(): void {
  editingPost.value = null;
  editBody.value = '';
}

async function saveEdit(): Promise<void> {
  if (!editingPost.value || !editBody.value.trim()) return;
  try {
    await state.updatePost(editingPost.value.id, editBody.value.trim());
    closeEditModal();
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to edit post.');
  }
}

async function activateQuickReply(focus = true): Promise<void> {
  if (!canDockQuickReply.value) return;
  quickReplyPresentationTouched = true;
  quickReplyPresentation.value = 'docked-expanded';
  await nextTick();
  if (focus) quickReplyTextareaRef.value?.focus();
}

async function collapseQuickReply(): Promise<void> {
  quickReplyPresentationTouched = true;
  quickReplyPresentation.value = 'docked-collapsed';
  await nextTick();
  quickReplyExpandButtonRef.value?.focus();
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function scrollInlineQuickReply(): Promise<void> {
  await nextTick();
  quickReplyContainerRef.value?.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'center',
  });
}

async function focusInlineQuickReply(): Promise<void> {
  await scrollInlineQuickReply();
  quickReplyTextareaRef.value?.focus({ preventScroll: true });
}

async function undockQuickReply(): Promise<void> {
  quickReplyPresentationTouched = true;
  quickReplyPresentation.value = 'inline';
  await scrollInlineQuickReply();
  quickReplyKeepVisibleButtonRef.value?.focus({ preventScroll: true });
}

function resetQuickReplyPresentation(): void {
  quickReplyPresentationTouched = false;
  quickReplyOptionsOpen.value = false;
  quickReplyPresentation.value = 'inline';
}

function applyQuickReplyDefault(): void {
  if (quickReplyPresentationTouched || !canDockQuickReply.value) return;
  quickReplyPresentation.value = state.currentUser.value?.quickReplyDockedByDefault
    ? 'docked-collapsed'
    : 'inline';
}

async function quotePost(post: PostDto): Promise<void> {
  if (isPublishingReply.value) return;
  if (state.isTopicLocked()) {
    state.setError('Cannot reply to a locked or archived topic.');
    return;
  }
  const authorName = state.identityName(post.authorId);
  const quoted = `[QUOTE=${authorName}]\n${post.body}\n[/QUOTE]\n\n`;
  replyBody.value = quoted + replyBody.value;
  if (quickReplyPresentation.value === 'inline') {
    await focusInlineQuickReply();
  } else if (quickReplyPresentation.value === 'docked-collapsed') {
    await activateQuickReply(true);
  } else {
    await nextTick();
    quickReplyTextareaRef.value?.focus();
  }
}

function confirmDelete(post: PostDto): void {
  if (state.isTopicLocked()) {
    state.setError('Cannot delete posts in a locked or archived topic.');
    return;
  }
  if (!canDeletePost(post)) {
    state.setError('You do not have permission to delete this post.');
    return;
  }
  showDeleteConfirm.value = post.id;
}

function cancelDelete(): void {
  showDeleteConfirm.value = null;
}

async function handleDelete(postId: string): Promise<void> {
  try {
    await state.deletePost(postId);
    showDeleteConfirm.value = null;
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to delete post.');
  }
}

async function applyQuickReplyTemplate(template: MessageTemplateDto, replace: boolean): Promise<void> {
  if (isPublishingReply.value) return;
  await applyTemplateToTextarea({
    body: replyBody,
    textarea: quickReplyTextareaRef,
    templateBody: template.body,
    replace,
  });
}

async function finishQuickReplyAttachments(): Promise<void> {
  const postId = publishedReplyPostId.value;
  if (!postId) return;
  isUploadingReply.value = true;
  for (const file of [...replyFiles.value]) {
    await state.uploadAttachment(postId, file);
    replyFiles.value = replyFiles.value.filter((item) => item !== file);
  }
  if (publishedReplyNeedsDispatch.value) {
    await state.dispatchPost(postId, {
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
    });
  }
  publishedReplyNeedsDispatch.value = false;
  publishedReplyPostId.value = null;
  clearReplyFiles();
}

async function retryQuickReplyAttachments(): Promise<void> {
  state.setError('');
  try {
    await finishQuickReplyAttachments();
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Attachment retry failed.');
  } finally {
    isUploadingReply.value = false;
  }
}

async function abandonQuickReplyAttachments(): Promise<void> {
  const postId = publishedReplyPostId.value;
  if (!postId) return;
  if (publishedReplyNeedsDispatch.value) {
    await state.dispatchPost(postId, {
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
    });
  }
  publishedReplyNeedsDispatch.value = false;
  publishedReplyPostId.value = null;
  clearReplyFiles();
}

function requestDiscardQuickDraft(): void {
  if (isPublishingReply.value) return;
  discardDraftError.value = '';
  showDiscardDraftConfirm.value = true;
}

async function confirmDiscardQuickDraft(): Promise<void> {
  if (isPublishingReply.value || discardDraftPending.value) return;
  discardDraftPending.value = true;
  discardDraftError.value = '';
  try {
    await autosavedReply.discard();
    showDiscardDraftConfirm.value = false;
  } catch (err) {
    discardDraftError.value = err instanceof Error ? err.message : 'Failed to discard draft.';
    showDiscardDraftConfirm.value = false;
  } finally {
    discardDraftPending.value = false;
  }
}

async function reply(): Promise<void> {
  if (isReplying.value || !autosavedReply.hydrated.value || !replyBody.value.trim() || compactionFence.value) return;
  const wasSteeringRobot = quickReplyWillSteerRobot.value;
  isReplying.value = true;
  isPublishingReply.value = true;
  let postCreated = false;
  try {
    const draftReference = await autosavedReply.flush();
    if (autosavedReply.status.value === 'conflict') {
      throw new Error('Resolve the draft conflict before posting.');
    }
    const submittedBody = replyBody.value;
    autosavedReply.pause();
    const attachmentsPending = replyFiles.value.length > 0;
    const post = await state.createPost(submittedBody.trim(), {
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
      ...(isAdmin.value
        ? {
            autoCompactEnabled: autoCompactEnabled.value,
            autoCompactRevision: state.selectedTopic.value?.autoCompactRevision ?? 0,
          }
        : {}),
      attachmentsPending,
      ...(draftReference ? { draft: draftReference } : {}),
    });
    postCreated = true;
    if (replyBody.value === submittedBody) replyBody.value = '';
    autosavedReply.resetAfterPublication();
    isPublishingReply.value = false;
    publishedReplyPostId.value = post.id;
    publishedReplyNeedsDispatch.value = attachmentsPending;
    if (replyFiles.value.length > 0) await finishQuickReplyAttachments();
    else publishedReplyPostId.value = null;

    // UX: when replying from an earlier page in a multi-page thread, your post lands on the last page.
    // Jump to the last page and set the URL hash to the new post number.
    const lastPage = state.totalPages.value;
    const lastIndex = state.sortedPosts.value.length;
    const nextQuery = buildPageQuery(lastPage);
    state.setPage(lastPage);
    allowQuickReplyNavigation.value = true;
    await router.push({ query: nextQuery, hash: `#${lastIndex}` });
    await nextTick();
    scrollToAnchor('smooth');

    quickReplyOptionsOpen.value = false;
    if (quickReplyDocked.value && !wasSteeringRobot) await collapseQuickReply();
  } catch (err) {
    if (!postCreated) autosavedReply.resume();
    state.setError(
      postCreated
        ? 'Reply posted, but one or more attachments did not finish. Do not resubmit the reply; the selected files remain in this tab.'
        : err instanceof Error
          ? err.message
          : 'Failed to post reply.'
    );
  } finally {
    allowQuickReplyNavigation.value = false;
    isPublishingReply.value = false;
    isReplying.value = false;
    isUploadingReply.value = false;
  }
}

function requestStopRobot(): void {
  if (!isRobotBusy.value || robotControlPending.value) return;
  showStopRobotConfirm.value = true;
}

async function confirmStopRobot(): Promise<void> {
  if (!isRobotBusy.value || robotControlPending.value) {
    showStopRobotConfirm.value = false;
    return;
  }
  showStopRobotConfirm.value = false;
  await state.interruptRobot();
}

watch(isRobotBusy, (busy) => {
  if (!busy) showStopRobotConfirm.value = false;
});

async function saveAutoRun(): Promise<void> {
  await state.updateAutoRun({
    enabled: autoRunEnabled.value,
    context: autoRunContext.value.trim() || null,
    worker: autoRunWorker.value,
    model: autoRunModel.value.trim() || null,
    reasoningEffort: showAutoRunReasoning.value ? autoRunReasoning.value.trim() || null : null,
    maxReplies: autoRunMaxReplies.value,
  });
}

async function resetAutoRunCount(): Promise<void> {
  await state.updateAutoRun({ resetCount: true });
}

async function runAutoRunDirector(): Promise<void> {
  const topicId = routeTopicId.value;
  const message = autoRunSteerMessage.value.trim() || null;
  await state.runAutoRun(message);
  autoRunSteerMessage.value = '';
  if (!topicId) return;
  await state.loadPosts(topicId);
  await state.loadIdentities(topicId);
  await state.loadAttachmentsForPosts(state.sortedPosts.value.map((post) => post.id));
  await nextTick();
  await goToLatest();
}

function openReplyPage(): void {
  if (!state.selectedTopic.value || compactionFence.value) return;
  void router.push({
    name: 'topic.reply',
    params: { topicId: state.selectedTopic.value.id },
    query: { model: effectiveSelectedModel.value, reasoning: selectedReasoning.value },
  });
}

function handleReplyFiles(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  const files = input?.files ? Array.from(input.files) : [];
  replyFiles.value = files;
}

function clearReplyFiles(): void {
  replyFiles.value = [];
  if (replyFileInputRef.value) {
    replyFileInputRef.value.value = '';
  }
}

async function removeAttachment(postId: string, attachmentId: string): Promise<void> {
  deletingByAttachment.value = { ...deletingByAttachment.value, [attachmentId]: true };
  try {
    await state.deleteAttachment(attachmentId, postId);
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to delete attachment.');
  } finally {
    deletingByAttachment.value = { ...deletingByAttachment.value, [attachmentId]: false };
  }
}

async function goHome(): Promise<void> {
  // Prefer returning to the forum this topic belongs to (vBulletin-style),
  // but fall back to the forum home if we don't have that context yet.
  const forumId = state.selectedTopic.value?.forumId;
  if (forumId) {
    await router.push({ name: 'forum.view', params: { forumId } });
    return;
  }

  await router.push({ name: 'forum.home' });
}

function openEditTitle(): void {
  newTitle.value = state.selectedTopic.value?.title ?? '';
  editingTitle.value = true;
}

function closeEditTitle(): void {
  editingTitle.value = false;
  newTitle.value = '';
}

async function saveTitle(): Promise<void> {
  if (!newTitle.value.trim()) return;
  try {
    await state.updateTopicTitle(newTitle.value.trim());
    closeEditTitle();
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to update title.');
  }
}

async function handleLockTopic(): Promise<void> {
  try {
    await state.updateTopicStatus('locked');
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to lock topic.');
  }
}

async function handleUnlockTopic(): Promise<void> {
  try {
    await state.updateTopicStatus('open');
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to unlock topic.');
  }
}

async function handleArchiveTopic(): Promise<void> {
  try {
    await state.updateTopicStatus('archived');
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to archive topic.');
  }
}

async function handleToggleSticky(): Promise<void> {
  try {
    await state.updateTopicSticky(!isSticky.value);
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to update sticky status.');
  }
}

async function handleDeleteTopic(): Promise<void> {
  try {
    await state.deleteTopic();
    showDeleteTopicConfirm.value = false;
    await goHome();
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to delete topic.');
  }
}

async function loadTopic(topicId: string): Promise<void> {
  try {
    await state.selectTopicById(topicId);
    if (routeTopicId.value !== topicId || state.selectedTopic.value?.id !== topicId) return;
    if (isAdmin.value) {
      const intent = loadCompactionIntent(topicId);
      if (intent) {
        compactionOperation.value = intent;
        compactionState.value = { ...compactionState.value, active: intent };
      }
      await refreshCompactionState(topicId);
      await refreshForkState(topicId);
    }
    const page = Number.isFinite(routePage.value) && routePage.value > 0 ? routePage.value : 1;
    state.setPage(page);
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to load topic.');
    await goHome();
  }
}

const pageNumbers = computed(() => {
  const total = state.totalPages.value;
  const current = state.currentPage.value;
  const pages: (number | '...')[] = [];

  if (total <= 7) {
    for (let i = 1; i <= total; i++) pages.push(i);
  } else {
    pages.push(1);
    if (current > 3) pages.push('...');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
      pages.push(i);
    }
    if (current < total - 2) pages.push('...');
    pages.push(total);
  }
  return pages;
});

function goToPage(page: number): void {
  if (page >= 1 && page <= state.totalPages.value) {
    state.setPage(page);
    const nextQuery = buildPageQuery(page);
    void router.push({ query: nextQuery, hash: '' });
    window.scrollTo(0, 0);
  }
}

function prevPage(): void {
  if (state.currentPage.value > 1) {
    goToPage(state.currentPage.value - 1);
  }
}

function nextPage(): void {
  if (state.currentPage.value < state.totalPages.value) {
    goToPage(state.currentPage.value + 1);
  }
}

async function goToLatest(): Promise<void> {
  const lastPage = state.totalPages.value;
  const lastIndex = state.sortedPosts.value.length;
  if (lastPage < 1) return;
  if (lastIndex <= 0) {
    goToPage(lastPage);
    return;
  }
  state.setPage(lastPage);
  const nextQuery = buildPageQuery(lastPage);
  await router.push({ query: nextQuery, hash: `#${lastIndex}` });
  await scrollToAnchorWhenReady('auto');
}

watch(
  routePage,
  (value) => {
    const page = Number.isFinite(value) && value > 0 ? value : 1;
    state.setPage(page);
  },
  { immediate: true }
);

watch(
  [routeAnchor, () => state.sortedPosts.value.length, routePage],
  async ([anchor, totalPosts, page]) => {
    if (!anchor) return;
    if (totalPosts === 0) return;

    const postNumber = parseAnchorPostNumber(anchor);
    if (postNumber) {
      const clamped = Math.min(postNumber, totalPosts);
      const targetPage = pageForPostNumber(clamped);
      if (page !== targetPage) {
        await router.replace({ query: { ...route.query, page: String(targetPage) }, hash: `#${clamped}` });
        return;
      }
    }

    await scrollToAnchorWhenReady('auto');
  },
  { immediate: true }
);

watch(
  [routePostId, () => state.sortedPosts.value.length],
  async ([postId, totalPosts]) => {
    if (!postId) return;
    if (totalPosts === 0) return;
    // Convert a postId into the numeric hash/page scheme used by TopicView,
    // then remove postId from the query to avoid repeated work.
    const postNumber = postNumberForPostId(postId);
    if (!postNumber) return;
    const targetPage = pageForPostNumber(postNumber);
    const nextQuery = { ...route.query } as Record<string, unknown>;
    delete nextQuery['postId'];
    await router.replace({ query: { ...nextQuery, page: String(targetPage) }, hash: `#${postNumber}` });
  },
  { immediate: true }
);

async function guardQuickDraftNavigation(): Promise<boolean> {
  if (isPublishingReply.value && !allowQuickReplyNavigation.value) {
    state.setError('Wait for the reply to finish posting before leaving this topic.');
    return false;
  }
  if (publishedReplyPostId.value) {
    state.setError('Finish or abandon the published reply’s attachment recovery before leaving this topic.');
    return false;
  }
  const saved = await autosavedReply.flushForNavigation();
  if (!saved) state.setError('This draft could not be saved. Resolve the draft status before leaving.');
  return saved;
}

function confirmReplyFileNavigation(): boolean {
  if (replyFiles.value.length === 0) return true;
  if (!window.confirm('Selected files are not saved with drafts. Leave this page and clear those files?')) return false;
  clearReplyFiles();
  return true;
}

onBeforeRouteLeave(async () => {
  if (!(await guardQuickDraftNavigation())) return false;
  return confirmReplyFileNavigation();
});
onBeforeRouteUpdate(async (to, from) => {
  if (isPublishingReply.value && !allowQuickReplyNavigation.value) {
    state.setError('Wait for the reply to finish posting before leaving this topic.');
    return false;
  }
  if (to.params['topicId'] === from.params['topicId']) return true;
  if (!(await guardQuickDraftNavigation())) return false;
  return confirmReplyFileNavigation();
});

watch(
  routeTopicId,
  async (topicId) => {
    quickReplyPresentationReady.value = false;
    resetQuickReplyPresentation();
    showStopRobotConfirm.value = false;
    showDiscardDraftConfirm.value = false;
    discardDraftError.value = '';
    stopCompactionPolling();
    compactionRequestGeneration += 1;
    if (showCompactionModal.value) {
      showCompactionModal.value = false;
      restoreCompactionModalEnvironment();
    }
    compactionOperation.value = null;
    compactionSubmitting.value = false;
    compactionRetryingCheckpoint.value = false;
    compactionState.value = { active: null, latest: null, checkpointDispatch: null };
    compactionError.value = '';
    if (forkPollTimer !== null) window.clearTimeout(forkPollTimer);
    forkPollTimer = null;
    if (showForkModal.value) {
      showForkModal.value = false;
      restoreForkModalEnvironment();
    }
    forkBoundaries.value = [];
    forkOperation.value = null;
    forkState.value = { active: null, latest: null };
    forkError.value = '';
    forkSubmitting.value = false;
    replyBody.value = '';
    if (topicId) {
      await loadTopic(topicId);
      if (routeTopicId.value !== topicId) return;
      applyQuickReplyDefault();
      quickReplyPresentationReady.value = true;
      if (state.isLoggedIn.value) await autosavedReply.load();
    }
  },
  { immediate: true }
);

watch(
  [() => state.isLoggedIn.value, () => state.selectedTopic.value?.id, () => state.selectedTopic.value?.status],
  ([loggedIn]) => {
    if (!canDockQuickReply.value && quickReplyDocked.value) resetQuickReplyPresentation();
    if (loggedIn && routeTopicId.value && !autosavedReply.hydrated.value) void autosavedReply.load();
  }
);

onMounted(() => {
  window.addEventListener('scroll', handleScroll);
});

onUnmounted(() => {
  state.closeStream();
  stopCompactionPolling();
  if (forkPollTimer !== null) window.clearTimeout(forkPollTimer);
  if (showForkModal.value) document.body.style.overflow = bodyOverflowBeforeForkModal;
  else if (showCompactionModal.value) document.body.style.overflow = bodyOverflowBeforeCompactionModal;
  window.removeEventListener('scroll', handleScroll);
});
</script>

<template>
  <div v-if="editingPost" class="vb-modal-overlay" @click.self="closeEditModal">
    <div class="vb-modal">
      <div class="vb-table-header">Edit Post</div>
      <div class="vb-modal-body">
        <textarea v-model="editBody" rows="8" class="vb-modal-textarea"></textarea>
        <div class="vb-modal-actions">
          <button class="vb-btn" :disabled="state.loading.value" @click="saveEdit">Save Changes</button>
          <button class="vb-btn vb-btn-secondary" @click="closeEditModal">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <div v-if="editingTitle" class="vb-modal-overlay" @click.self="closeEditTitle">
    <div class="vb-modal">
      <div class="vb-modal-header">
        <span>Edit Topic Title</span>
        <button class="vb-modal-close" type="button" @click="closeEditTitle">&times;</button>
      </div>
      <div class="vb-modal-body">
        <label>Title:</label>
        <input v-model="newTitle" type="text" @keyup.enter="saveTitle" />
        <div class="vb-modal-actions">
          <button class="vb-btn" :disabled="state.loading.value" @click="saveTitle">Save</button>
          <button class="vb-btn vb-btn-secondary" @click="closeEditTitle">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <div v-if="showMoveTopicModal" class="vb-modal-overlay" @click.self="closeMoveTopicModal">
    <div class="vb-modal">
      <div class="vb-modal-header">
        <span>Move Thread</span>
        <button class="vb-modal-close" type="button" @click="closeMoveTopicModal">&times;</button>
      </div>
      <div class="vb-modal-body">
        <p>This will move the thread to a different forum or subforum.</p>
        <div class="vb-modal-field">
          <label for="move-forum-select">Destination forum</label>
          <select id="move-forum-select" v-model="selectedMoveForumId" class="vb-modal-select">
            <option value="">Select a forum</option>
            <option
              v-for="forum in moveForumOptions"
              :key="forum.id"
              :value="forum.id"
              :disabled="forum.id === state.selectedTopic.value?.forumId"
            >
              {{ forumOptionLabel(forum) }}
            </option>
          </select>
        </div>
        <div class="vb-modal-warning">
          <p>Warning:</p>
          <ul>
            <li>The move will fail if an assistant response is currently in progress.</li>
            <li>Working directory context will change; previous files may no longer exist.</li>
            <li>Topic visibility (and attachment access) will follow the destination forum.</li>
          </ul>
          <label class="vb-modal-checkbox">
            <input data-testid="move-silent-checkbox" type="checkbox" v-model="moveSilentChecked" />
            Move silently without posting a move notice in the thread.
          </label>
          <label class="vb-modal-checkbox">
            <input data-testid="move-confirm-checkbox" type="checkbox" v-model="moveConfirmChecked" />
            I understand and want to proceed.
          </label>
        </div>
        <div v-if="moveError" class="vb-login-error">{{ moveError }}</div>
        <div class="vb-modal-actions">
          <button class="vb-btn" type="button" @click="closeMoveTopicModal">Cancel</button>
          <button
            class="vb-btn vb-btn-danger"
            type="button"
            :disabled="
              moveLoading ||
              !moveConfirmChecked ||
              !selectedMoveForumId ||
              selectedMoveForumId === state.selectedTopic.value?.forumId
            "
            @click="confirmMoveTopic"
          >
            {{ moveLoading ? 'Moving...' : 'Move Thread' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <div v-if="showDeleteTopicConfirm" class="vb-modal-overlay" @click.self="showDeleteTopicConfirm = false">
    <div class="vb-modal">
      <div class="vb-modal-header">
        <span>Delete Topic</span>
        <button class="vb-modal-close" type="button" @click="showDeleteTopicConfirm = false">&times;</button>
      </div>
      <div class="vb-modal-body">
        <p class="vb-delete-warning">
          Are you sure you want to delete this topic and all its posts? This action cannot be undone.
        </p>
        <div class="vb-modal-actions">
          <button class="vb-btn vb-btn-danger" :disabled="state.loading.value" @click="handleDeleteTopic">
            Delete Topic
          </button>
          <button class="vb-btn vb-btn-secondary" @click="showDeleteTopicConfirm = false">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <ConfirmationDialog
    :open="showStopRobotConfirm"
    title="Stop robot?"
    message="This will stop the current response and cancel queued or delegated work for this session. Partial output will remain visible, but work already performed cannot be undone."
    confirm-label="Stop robot"
    cancel-label="Keep running"
    pending-label="Stopping…"
    :pending="robotControlPending"
    @confirm="confirmStopRobot"
    @cancel="showStopRobotConfirm = false"
  />

  <ConfirmationDialog
    :open="showDiscardDraftConfirm"
    title="Discard draft?"
    message="This permanently deletes the saved draft and clears this editor. This cannot be undone."
    confirm-label="Discard draft"
    cancel-label="Keep editing"
    pending-label="Discarding…"
    :pending="discardDraftPending"
    @confirm="confirmDiscardQuickDraft"
    @cancel="showDiscardDraftConfirm = false"
  />

  <div v-if="showForkModal" class="vb-modal-overlay">
    <div
      ref="forkModalRef"
      class="vb-modal"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="fork-modal-title"
      @keydown="handleForkKeydown"
    >
      <div class="vb-modal-header">
        <span id="fork-modal-title">Fork Topic</span>
        <button
          class="vb-modal-close"
          type="button"
          aria-label="Close fork dialog"
          :disabled="forkSubmitting"
          @click="closeForkModal"
        >
          &times;
        </button>
      </div>
      <div class="vb-modal-body">
        <p>Create a new canonical conversation inheriting history before a completed user message.</p>
        <label for="fork-boundary">Fork boundary</label>
        <select id="fork-boundary" v-model="forkBoundaryPostId" @change="selectForkBoundary">
          <option v-for="boundary in forkBoundaries" :key="boundary.postId" :value="boundary.postId">
            #{{ boundary.postNumber }} — {{ boundary.excerpt }}
          </option>
        </select>
        <label for="fork-title">New topic title</label>
        <input id="fork-title" v-model="forkTitle" type="text" maxlength="300" />
        <label for="fork-opening">Edited opening message</label>
        <textarea id="fork-opening" v-model="forkOpeningBody" rows="10"></textarea>
        <p v-if="forkError" class="vb-error">{{ forkError }}</p>
        <div class="vb-modal-actions">
          <button
            class="vb-btn"
            type="button"
            :disabled="forkSubmitting || !forkTitle.trim() || !forkOpeningBody.trim()"
            @click="submitFork"
          >
            {{
              forkSubmitting || forkOperation?.status === 'pending' || forkOperation?.status === 'running'
                ? 'Forking…'
                : 'Create fork'
            }}
          </button>
          <button class="vb-btn vb-btn-secondary" type="button" :disabled="forkSubmitting" @click="closeForkModal">
            Cancel
          </button>
        </div>
      </div>
    </div>
  </div>

  <div v-if="showCompactionModal" class="vb-modal-overlay vb-compaction-modal-overlay">
    <div
      ref="compactionModalRef"
      class="vb-modal vb-compaction-modal"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="compaction-modal-title"
      @keydown="handleCompactionKeydown"
    >
      <div class="vb-modal-header">
        <span id="compaction-modal-title">Compact Session and Recover</span>
        <button
          class="vb-modal-close"
          type="button"
          aria-label="Close compaction dialog"
          :disabled="compactionSubmitting"
          @click="closeCompactionModal"
        >
          &times;
        </button>
      </div>
      <div class="vb-modal-body">
        <p class="vb-delete-warning">
          <strong>This permanently replaces older session context with an AI-generated summary.</strong>
          Exact wording, tool output, and details may be lost. The operation cannot be undone. Once accepted, it runs on
          the server and this page may be closed; a recovery checkpoint will be queued afterward.
        </p>
        <label class="vb-inline-check vb-compaction-confirm">
          <input v-model="compactionConfirmed" type="checkbox" :disabled="compactionSubmitting" />
          <span>I understand that compaction is destructive and may lose context.</span>
        </label>
        <button
          class="vb-small-btn"
          type="button"
          :disabled="compactionSubmitting"
          @click="showCompactionAdvanced = !showCompactionAdvanced"
        >
          {{ showCompactionAdvanced ? 'Hide advanced options' : 'Advanced options' }}
        </button>
        <div v-if="showCompactionAdvanced" class="vb-compaction-advanced">
          <label for="compaction-recovery-prompt">Editable recovery prompt</label>
          <textarea
            id="compaction-recovery-prompt"
            v-model="compactionRecoveryPrompt"
            rows="10"
            class="vb-modal-textarea"
            :disabled="compactionSubmitting"
          ></textarea>
          <label for="compaction-summary-instructions">Custom summary instructions (optional)</label>
          <textarea
            id="compaction-summary-instructions"
            v-model="compactionInstructions"
            rows="4"
            class="vb-modal-textarea"
            :disabled="compactionSubmitting"
            placeholder="Emphasize particular decisions, files, or unresolved work in the compaction summary."
          ></textarea>
        </div>
        <div v-if="compactionSubmitting" class="vb-note" role="status">
          Securing the durable server-side compaction request…
        </div>
        <div v-if="compactionError" class="vb-error vb-compaction-error" role="alert">
          <strong>Compaction failed:</strong> {{ compactionError }}
        </div>
      </div>
      <div class="vb-modal-actions vb-compaction-modal-actions">
        <button
          class="vb-btn vb-btn-danger"
          type="button"
          :disabled="!canCompact || !compactionConfirmed"
          @click="submitCompaction"
        >
          {{ compactionSubmitting ? 'Submitting…' : 'Compact and recover' }}
        </button>
        <button
          class="vb-btn vb-btn-secondary"
          type="button"
          :disabled="compactionSubmitting"
          @click="closeCompactionModal"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>

  <div v-if="isAdmin && compactionActive" class="vb-note vb-compaction-status" role="status" aria-live="polite">
    <strong>Compaction is running on the server.</strong>
    You may leave or close this page. New replies are paused until compaction finishes and the recovery checkpoint is
    queued.
  </div>
  <div v-else-if="isAdmin && checkpointDispatchPending" class="vb-note vb-compaction-status" role="status">
    <strong>Compaction finished; the recovery checkpoint is being dispatched.</strong>
    You may leave this page. New replies remain paused until agentd accepts the checkpoint turn.
  </div>
  <div v-else-if="isAdmin && checkpointNeedsRecovery" class="vb-error vb-compaction-status" role="alert">
    <div>
      <strong>The session was compacted, but its recovery checkpoint could not be dispatched.</strong>
      <span v-if="compactionState.checkpointDispatch?.errorMessage">
        {{ compactionState.checkpointDispatch.errorMessage }}
      </span>
    </div>
    <button class="vb-btn" type="button" :disabled="compactionRetryingCheckpoint" @click="retryCompactionCheckpoint">
      {{ compactionRetryingCheckpoint ? 'Retrying…' : 'Retry recovery checkpoint' }}
    </button>
  </div>
  <div v-if="isAdmin && compactionError && !showCompactionModal" class="vb-error vb-compaction-status" role="alert">
    {{ compactionError }}
  </div>

  <section
    class="vb-section"
    :class="{
      'vb-topic-with-reply-dock': quickReplyDocked,
      'vb-topic-with-reply-dock--expanded': quickReplyExpanded,
      'vb-topic-with-reply-dock--collapsed': quickReplyPresentation === 'docked-collapsed',
    }"
  >
    <div class="vb-thread-titlebar">
      <div class="vb-thread-icon" aria-hidden="true"></div>
      <h2>{{ state.selectedTopic.value?.title }}</h2>
      <span v-if="topicRobotMode === 'mention'" class="vb-robot-mode-pill">Robot: @mention only</span>
      <span v-else-if="topicRobotMode === 'off'" class="vb-robot-mode-pill">Robot: off</span>
      <span v-if="state.isTopicLocked()" class="vb-locked-badge">
        {{ state.selectedTopic.value?.status === 'archived' ? 'Archived' : 'Locked' }}
      </span>
    </div>

    <div v-if="topicLineageLabel" class="vb-reply-context-meter vb-lineage-banner">
      <div class="vb-lineage-summary">
        <strong>{{ topicLineageLabel }}</strong>
        <router-link
          v-if="topicLineage?.parentTopicId"
          class="vb-lineage-link"
          :to="`/topics/${topicLineage.parentTopicId}`"
          >Open parent thread</router-link
        >
      </div>
    </div>

    <div class="vb-controls">
      <div class="vb-control-group">
        <button
          class="vb-btn"
          :disabled="state.loading.value || state.isTopicLocked() || compactionFence"
          @click="openReplyPage"
        >
          Post Reply
        </button>
        <button
          class="vb-btn"
          :disabled="state.loading.value || state.isTopicLocked() || compactionFence"
          @click="openHandoffModal"
        >
          Handoff
        </button>
        <button v-if="isAdmin" class="vb-btn" :disabled="!canFork" @click="openForkModal">Fork</button>
        <button v-if="isAdmin" class="vb-btn" :disabled="!canCompact" @click="openCompactionModal">Compact</button>
        <button class="vb-btn" @click="goHome">Back to Forum</button>
      </div>
      <div class="vb-pagination-controls">
        <button class="vb-page-btn" :disabled="state.currentPage.value <= 1" @click="prevPage">« Prev</button>
        <template v-for="(page, idx) in pageNumbers" :key="idx">
          <span v-if="page === '...'" class="vb-page-ellipsis">...</span>
          <button
            v-else
            class="vb-page-btn"
            :class="{ 'vb-page-active': page === state.currentPage.value }"
            @click="goToPage(page)"
          >
            {{ page }}
          </button>
        </template>
        <button class="vb-page-btn" :disabled="state.currentPage.value >= state.totalPages.value" @click="nextPage">
          Next »
        </button>
        <button
          class="vb-page-btn"
          :disabled="state.sortedPosts.value.length === 0"
          @click="goToLatest"
          title="Jump to latest post"
        >
          »»
        </button>
      </div>
    </div>

    <div class="vb-tools">
      <button v-if="canModerate" class="vb-menu" type="button" @click="showAdminPanel = !showAdminPanel">
        {{ showAdminPanel ? 'Hide Admin Tools' : 'Admin Tools' }}
      </button>
      <button class="vb-menu" type="button" @click="openThreadSearch">Search this Thread</button>
    </div>

    <div v-if="threadSearchOpen" class="vb-thread-search">
      <div class="vb-search-header">
        <span>Search this Thread</span>
        <button class="vb-modal-close" type="button" @click="closeThreadSearch">&times;</button>
      </div>
      <div class="vb-search-input-row">
        <input v-model="threadSearchQuery" type="text" placeholder="Search posts..." class="vb-search-input" />
        <span v-if="threadSearchQuery" class="vb-search-count">
          {{ filteredPosts.length }} of {{ state.currentPosts.value.length }} posts
        </span>
      </div>
    </div>

    <div v-if="showAdminPanel && canModerate" class="vb-admin-panel">
      <div class="vb-admin-actions">
        <button class="vb-small-btn" :disabled="state.loading.value" @click="openEditTitle">Edit Title</button>
        <button
          v-if="isAdmin"
          class="vb-small-btn"
          :disabled="state.loading.value || compactionFence"
          @click="openMoveTopicModal"
        >
          Move Thread
        </button>
        <button class="vb-small-btn" :disabled="state.loading.value" @click="handleToggleSticky">
          {{ isSticky ? 'Unsticky' : 'Sticky' }}
        </button>
        <button
          v-if="state.selectedTopic.value?.status === 'open'"
          class="vb-small-btn"
          :disabled="state.loading.value || compactionFence"
          @click="handleLockTopic"
        >
          Lock Topic
        </button>
        <button
          v-if="state.selectedTopic.value?.status === 'locked'"
          class="vb-small-btn"
          :disabled="state.loading.value"
          @click="handleUnlockTopic"
        >
          Unlock Topic
        </button>
        <button
          v-if="state.selectedTopic.value?.status !== 'archived'"
          class="vb-small-btn"
          :disabled="state.loading.value || compactionFence"
          @click="handleArchiveTopic"
        >
          Archive Topic
        </button>
        <button
          v-if="state.selectedTopic.value?.status === 'archived'"
          class="vb-small-btn"
          :disabled="state.loading.value"
          @click="handleUnlockTopic"
        >
          Unarchive Topic
        </button>
        <button
          class="vb-small-btn vb-btn-danger"
          :disabled="state.loading.value || compactionFence"
          @click="showDeleteTopicConfirm = true"
        >
          Delete Topic
        </button>
      </div>

      <div v-if="showAutoRunPanel" class="vb-robot-state" style="margin-top: 12px">
        <div class="vb-table-header">
          <span>Auto-Director (Thread Tool)</span>
          <div class="vb-robot-actions">
            <span class="vb-status-pill">{{ autoRunStatusLabel }}</span>
            <label class="vb-inline-check">
              <input type="checkbox" v-model="autoRunEnabled" :disabled="!canEditAutoRun || autoRunBusy" />
              <span>Enabled</span>
            </label>
            <button
              class="vb-small-btn"
              type="button"
              :disabled="!canEditAutoRun || autoRunBusy || compactionFence"
              @click="saveAutoRun"
            >
              Save
            </button>
            <button
              class="vb-small-btn"
              type="button"
              :disabled="!canEditAutoRun || autoRunBusy || compactionFence || !autoRunEnabled"
              @click="runAutoRunDirector"
            >
              Run
            </button>
          </div>
        </div>
        <div class="vb-robot-body">
          <div class="vb-state-row">
            <div>
              <strong>Replies:</strong> {{ autoRun?.replyCount ?? 0 }} / {{ autoRun?.maxReplies ?? autoRunMaxReplies }}
            </div>
            <div><strong>Last Run:</strong> {{ autoRun?.lastRunAt ? state.formatDate(autoRun.lastRunAt) : 'n/a' }}</div>
            <div>
              <strong>Last Reply:</strong> {{ autoRun?.lastReplyAt ? state.formatDate(autoRun.lastReplyAt) : 'n/a' }}
            </div>
          </div>
          <div v-if="state.autoRunError.value" class="vb-error">{{ state.autoRunError.value }}</div>
          <div v-if="autoRun?.lastError" class="vb-error">
            <strong>Last error:</strong> {{ formatAutoRunError(autoRun.lastError) }}
          </div>
          <div v-if="autoRun?.lastNotes" class="vb-note">
            <strong>Director notes:</strong>
            <div>{{ autoRun.lastNotes }}</div>
          </div>
          <div v-if="autoRun?.lastSummary" class="vb-note">
            <strong>Last summary:</strong>
            <div>{{ autoRun.lastSummary }}</div>
          </div>
          <label>Goal (optional):</label>
          <textarea
            v-model="autoRunContext"
            class="vb-option-textarea"
            rows="5"
            :readonly="!canEditAutoRun"
            placeholder="Describe the outcome to drive toward. Leave blank to auto-derive the next major goal from the thread."
          ></textarea>
          <div class="vb-reply-options">
            <div class="vb-option-group">
              <label>Worker:</label>
              <select v-model="autoRunWorker" class="vb-option-select" :disabled="!canEditAutoRun || autoRunBusy">
                <option value="echs">echs</option>
              </select>
            </div>
            <div class="vb-option-group">
              <label>Model:</label>
              <select v-model="autoRunModel" class="vb-option-select" :disabled="!canEditAutoRun || autoRunBusy">
                <option v-for="option in autoRunModelOptions" :key="option.value || 'default'" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div v-if="showAutoRunReasoning" class="vb-option-group">
              <label>Reasoning:</label>
              <select v-model="autoRunReasoning" class="vb-option-select" :disabled="!canEditAutoRun || autoRunBusy">
                <option value="">Default</option>
                <option v-for="option in autoRunReasoningOptions" :key="option" :value="option">
                  {{ formatReasoningLabel(option) }}
                </option>
              </select>
            </div>
            <div v-else class="vb-option-group">
              <label>Reasoning:</label>
              <select class="vb-option-select" disabled>
                <option value="">n/a</option>
              </select>
            </div>
            <div class="vb-option-group">
              <label>Max Replies:</label>
              <input
                v-model.number="autoRunMaxReplies"
                type="number"
                min="1"
                class="vb-option-input"
                :disabled="!canEditAutoRun || autoRunBusy"
              />
            </div>
            <button
              class="vb-small-btn"
              type="button"
              :disabled="!canEditAutoRun || autoRunBusy"
              @click="resetAutoRunCount"
            >
              Reset Count
            </button>
          </div>
          <label>Steer auto-director (optional):</label>
          <textarea
            v-model="autoRunSteerMessage"
            class="vb-option-textarea"
            rows="3"
            :disabled="!canEditAutoRun || autoRunBusy"
            placeholder="Add a one-off steering note."
          ></textarea>
          <button
            class="vb-btn"
            type="button"
            :disabled="!canEditAutoRun || autoRunBusy || compactionFence || !autoRunEnabled"
            @click="runAutoRunDirector"
          >
            {{ autoRunBusy ? 'Running...' : 'Run Auto-Director' }}
          </button>
        </div>
      </div>
    </div>

    <div class="vb-posts">
      <div class="vb-table-header">
        {{ new Date().toLocaleDateString() }}
        <span v-if="state.totalPages.value > 1"
          >Page {{ state.currentPage.value }} of {{ state.totalPages.value }}</span
        >
      </div>

      <div v-if="showRobotDraft && !showRobotDraftOnCurrentPage && !threadSearchQuery" class="vb-live-turn-page-hint">
        Monika is responding on page {{ liveTurnPage }}.
        <button type="button" class="vb-inline-link" @click="goToPage(liveTurnPage)">
          {{ canViewLiveTrace ? 'Jump to live trace' : 'Jump to response in progress' }}
        </button>
      </div>

      <div v-if="threadSearchQuery && filteredPosts.length === 0" class="vb-empty">No posts match your search.</div>

      <div v-if="unanchoredOperationalEvents.length > 0" v-show="!threadSearchQuery" class="vb-operational-event-group">
        <OperationalEventBar
          v-for="event in unanchoredOperationalEvents"
          :key="event.id"
          :event="event"
          :can-recover="isAdmin"
          :recover-disabled="!canCompact"
          @recover="openCompactionModal"
        />
      </div>

      <template v-for="(post, idx) in threadSearchQuery ? filteredPosts : state.currentPosts.value" :key="post.id">
        <div
          class="vb-post"
          :id="String(postNumberForPostId(post.id) ?? postNumberForIndex(idx))"
          :class="{ 'vb-post--has-operational-events': operationalEventsAfter(post.id).length > 0 }"
        >
          <div class="vb-post-header">
            <div>● {{ state.formatDate(post.createdAt) }}</div>
            <div class="vb-post-header-right">
              <a
                class="vb-post-anchor"
                :href="`#${postNumberForPostId(post.id) ?? postNumberForIndex(idx)}`"
                :title="`Jump to post #${postNumberForPostId(post.id) ?? postNumberForIndex(idx)}`"
                >#{{ postNumberForPostId(post.id) ?? postNumberForIndex(idx) }}</a
              >
              <span v-if="post.silent" class="vb-post-silent-pill">[Silent]</span>
            </div>
          </div>
          <a
            v-if="
              state.isRobotPost(post) && post.followUp && post.parentPostId && postNumberForPostId(post.parentPostId)
            "
            class="vb-follow-up-origin"
            :href="`#${postNumberForPostId(post.parentPostId)}`"
            >Background follow-up to #{{ postNumberForPostId(post.parentPostId) }}</a
          >
          <div
            class="vb-post-body"
            :class="{ 'vb-post-body--multipost': isRobotOrSystemPost(post) && hasMultipostSegments(post.body) }"
          >
            <template v-if="isRobotOrSystemPost(post) && hasMultipostSegments(post.body)">
              <div class="vb-post-content vb-post-content--multipost">
                <PostTracePanel
                  v-if="state.isRobotPost(post) && hasTraceForPost(post)"
                  :reasoningSteps="planStepsForPost(post)"
                  :reasoningFallbackHtml="
                    planForPost(post)
                      ? renderPost(planForPost(post)?.summary || planForPost(post)?.content || '')
                      : null
                  "
                  :toolRuns="toolRunsForPost(post)"
                  :traceId="post.id"
                  :topicId="routeTopicId"
                  :reasoningCheckpoints="planForPost(post)?.reasoningCheckpoints ?? null"
                  :rawPlanText="planForPost(post)?.summary ?? planForPost(post)?.content ?? null"
                />

                <div class="vb-post-heading">
                  <span>{{ state.selectedTopic.value?.title }}</span>
                  <span v-if="isRecoveryCheckpoint(post.id)" class="vb-recovery-checkpoint-badge"
                    >Automated recovery checkpoint</span
                  >
                  <button
                    v-if="state.isRobotPost(post)"
                    class="vb-tts-inline"
                    type="button"
                    :disabled="ttsLoadingByPost[post.id]"
                    @click="playRobotVoice(post)"
                    title="Play voice"
                  >
                    <span v-if="ttsLoadingByPost[post.id]" class="vb-spinner vb-spinner-dark"></span>
                    <svg
                      v-else
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  </button>
                </div>
                <div v-if="ttsErrorsByPost[post.id]" class="vb-tts-inline-error">{{ ttsErrorsByPost[post.id] }}</div>
                <audio
                  v-if="ttsUrlForPost(post.id)"
                  class="vb-tts-audio-hidden"
                  :id="`tts-audio-${post.id}`"
                  :src="ttsUrlForPost(post.id) ?? undefined"
                  preload="none"
                ></audio>

                <div class="vb-multipost">
                  <div
                    v-for="(segment, segIdx) in parseMultipostSegments(post.body)"
                    :key="`${post.id}:${segIdx}`"
                    class="vb-post-body vb-post-body--virtual"
                    :id="segmentAnchorId(post.id, segIdx)"
                  >
                    <aside class="vb-post-user">
                      <div class="vb-user-name" :style="personaNameStyle(segment.personaKey)">
                        {{ personaDisplayName(segment.personaKey) }}
                      </div>
                      <div class="vb-user-title">{{ personaTitle(segment.personaKey) }}</div>
                      <img class="vb-avatar" :src="personaAvatar(segment.personaKey)" alt="" />
                      <div class="vb-user-meta">
                        <div><span>Persona:</span> {{ segment.personaKey ?? 'narration' }}</div>
                      </div>
                    </aside>
                    <div class="vb-post-content">
                      <div class="vb-multipost-segment-header">
                        <a class="vb-segment-link" :href="`#${segmentAnchorId(post.id, segIdx)}`">#</a>
                      </div>
                      <div
                        v-enhance-mermaid
                        class="vb-post-text vb-rendered-content"
                        v-html="renderPost(segment.body)"
                      ></div>
                      <div v-if="personaSignature(segment.personaKey)" class="vb-post-signature">
                        <div class="vb-signature-line"></div>
                        <div
                          class="vb-signature-text vb-rendered-content"
                          v-html="renderSignature(personaSignature(segment.personaKey))"
                        ></div>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-if="visibleAttachmentsForPost(post.id).length > 0" class="vb-post-attachments">
                  <div class="vb-attachments-header">Attachments</div>
                  <ul class="vb-attachments-list">
                    <li
                      v-for="attachment in visibleAttachmentsForPost(post.id)"
                      :key="attachment.id"
                      class="vb-attachment-item"
                    >
                      <span v-if="attachment.deletedAt" class="vb-attachment-deleted">
                        Attachment deleted: {{ attachment.filename }}
                      </span>
                      <a
                        v-else
                        class="vb-attachment-link"
                        :href="`/api/attachments/${attachment.id}`"
                        target="_blank"
                        rel="noopener"
                      >
                        {{ attachment.filename }}
                      </a>
                      <span v-if="!attachment.deletedAt" class="vb-attachment-meta"
                        >{{ formatBytes(attachment.sizeBytes) }} ·
                        {{ new Date(attachment.createdAt).toLocaleString() }}</span
                      >
                      <button
                        v-if="isPostOwner(post) && !attachment.deletedAt"
                        class="vb-small-btn vb-btn-danger"
                        :disabled="deletingByAttachment[attachment.id]"
                        type="button"
                        @click="removeAttachment(post.id, attachment.id)"
                      >
                        {{ deletingByAttachment[attachment.id] ? 'Removing...' : 'Remove' }}
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
            </template>

            <template v-else>
              <aside class="vb-post-user">
                <router-link class="vb-user-name" :to="{ name: 'user.view', params: { identityId: post.authorId } }">{{
                  state.identityName(post.authorId)
                }}</router-link>
                <div class="vb-user-title">{{ getUserRank(post.authorId) }}</div>
                <img class="vb-avatar" :src="state.avatarFor(post.authorId)" alt="" />
                <div class="vb-user-meta">
                  <div><span>Join Date:</span> {{ getUserJoinDate(post.authorId) }}</div>
                  <div><span>Location:</span> {{ getUserLocation(post.authorId) }}</div>
                  <div><span>Posts:</span> {{ getUserPostCount(post.authorId) }}</div>
                </div>
              </aside>
              <div class="vb-post-content">
                <PostTracePanel
                  v-if="state.isRobotPost(post) && hasTraceForPost(post)"
                  :reasoningSteps="planStepsForPost(post)"
                  :reasoningFallbackHtml="
                    planForPost(post)
                      ? renderPost(planForPost(post)?.summary || planForPost(post)?.content || '')
                      : null
                  "
                  :toolRuns="toolRunsForPost(post)"
                  :traceId="post.id"
                  :topicId="routeTopicId"
                  :reasoningCheckpoints="planForPost(post)?.reasoningCheckpoints ?? null"
                  :rawPlanText="planForPost(post)?.summary ?? planForPost(post)?.content ?? null"
                />
                <div class="vb-post-heading">
                  <span>{{ state.selectedTopic.value?.title }}</span>
                  <span v-if="isRecoveryCheckpoint(post.id)" class="vb-recovery-checkpoint-badge"
                    >Automated recovery checkpoint</span
                  >
                  <button
                    v-if="state.isRobotPost(post)"
                    class="vb-tts-inline"
                    type="button"
                    :disabled="ttsLoadingByPost[post.id]"
                    @click="playRobotVoice(post)"
                    title="Play voice"
                  >
                    <span v-if="ttsLoadingByPost[post.id]" class="vb-spinner vb-spinner-dark"></span>
                    <svg
                      v-else
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  </button>
                </div>
                <div v-if="ttsErrorsByPost[post.id]" class="vb-tts-inline-error">{{ ttsErrorsByPost[post.id] }}</div>
                <audio
                  v-if="ttsUrlForPost(post.id)"
                  class="vb-tts-audio-hidden"
                  :id="`tts-audio-${post.id}`"
                  :src="ttsUrlForPost(post.id) ?? undefined"
                  preload="none"
                ></audio>
                <div v-enhance-mermaid class="vb-post-text vb-rendered-content" v-html="renderPost(post.body)"></div>
                <div v-if="visibleAttachmentsForPost(post.id).length > 0" class="vb-post-attachments">
                  <div class="vb-attachments-header">Attachments</div>
                  <ul class="vb-attachments-list">
                    <li
                      v-for="attachment in visibleAttachmentsForPost(post.id)"
                      :key="attachment.id"
                      class="vb-attachment-item"
                    >
                      <span v-if="attachment.deletedAt" class="vb-attachment-deleted">
                        Attachment deleted: {{ attachment.filename }}
                      </span>
                      <a
                        v-else
                        class="vb-attachment-link"
                        :href="`/api/attachments/${attachment.id}`"
                        target="_blank"
                        rel="noopener"
                      >
                        {{ attachment.filename }}
                      </a>
                      <span v-if="!attachment.deletedAt" class="vb-attachment-meta"
                        >{{ formatBytes(attachment.sizeBytes) }} ·
                        {{ new Date(attachment.createdAt).toLocaleString() }}</span
                      >
                      <button
                        v-if="isPostOwner(post) && !attachment.deletedAt"
                        class="vb-small-btn vb-btn-danger"
                        :disabled="deletingByAttachment[attachment.id]"
                        type="button"
                        @click="removeAttachment(post.id, attachment.id)"
                      >
                        {{ deletingByAttachment[attachment.id] ? 'Removing...' : 'Remove' }}
                      </button>
                    </li>
                  </ul>
                </div>
                <div v-if="getUserSignature(post.authorId)" class="vb-post-signature">
                  <div class="vb-signature-line"></div>
                  <div
                    class="vb-signature-text vb-rendered-content"
                    v-html="renderSignature(getUserSignature(post.authorId))"
                  ></div>
                </div>
              </div>
            </template>
          </div>
          <div class="vb-post-footer">
            <button
              v-if="canEditPost(post)"
              class="vb-control-btn"
              :disabled="state.isTopicLocked() || compactionFence || !!post.deletedAt"
              @click="openEditModal(post)"
            >
              Edit
            </button>
            <button
              class="vb-control-btn"
              :disabled="state.isTopicLocked() || !!post.deletedAt"
              @click="quotePost(post)"
            >
              Quote
            </button>
            <button
              class="vb-control-btn"
              type="button"
              title="Copy exact post source"
              :disabled="!!post.deletedAt"
              aria-live="polite"
              @click="copyPostSource(post)"
            >
              {{ copiedPostSourceId === post.id ? 'Copied' : 'Copy' }}
            </button>
            <button
              class="vb-control-btn"
              type="button"
              :title="`Copy link to post #${postNumberForPostId(post.id) ?? postNumberForIndex(idx)}`"
              aria-live="polite"
              @click="copyPostLink(post)"
            >
              {{ copiedLinkPostId === post.id ? 'Copied' : 'Link' }}
            </button>
            <button
              v-if="canDeletePost(post)"
              class="vb-control-btn"
              :disabled="state.isTopicLocked() || compactionFence || !!post.deletedAt"
              @click="confirmDelete(post)"
            >
              Delete
            </button>
          </div>
          <div v-if="showDeleteConfirm === post.id" class="vb-delete-confirm">
            <span>Delete this post?</span>
            <button
              class="vb-small-btn vb-btn-danger"
              :disabled="state.loading.value || compactionFence"
              @click="handleDelete(post.id)"
            >
              Yes, Delete
            </button>
            <button class="vb-small-btn" @click="cancelDelete">Cancel</button>
          </div>
        </div>
        <div v-if="operationalEventsAfter(post.id).length > 0" class="vb-operational-event-group">
          <OperationalEventBar
            v-for="event in operationalEventsAfter(post.id)"
            :key="event.id"
            :event="event"
            :can-recover="isAdmin"
            :recover-disabled="!canCompact"
            @recover="openCompactionModal"
          />
        </div>
      </template>

      <LiveAssistantTurn
        v-if="showDetailedLiveTraceOnCurrentPage"
        :items="liveTurnItems"
        :activity="state.robotState.value?.activity ?? null"
        :model="state.robotState.value?.model ?? null"
        :reasoning="state.robotState.value?.reasoningEffort ?? null"
        :active="isRobotThinking"
        :interrupted="state.interruptedTrace.value"
        :topicId="routeTopicId"
        :id="String(liveTurnPostNumber)"
      />

      <div
        v-else-if="showPublicRobotPlaceholderOnCurrentPage"
        :id="String(liveTurnPostNumber)"
        class="vb-live-turn vb-post vb-post--draft vb-public-live-placeholder"
      >
        <div class="vb-post-header vb-live-turn-header">
          <div>● Monika is responding</div>
          <div class="vb-post-draft-pill">LIVE</div>
        </div>
        <div class="vb-public-live-placeholder-body" aria-live="polite">
          <span class="vb-spinner vb-spinner-dark"></span>
          <span>Response in progress…</span>
        </div>
      </div>
    </div>

    <div class="vb-controls vb-controls-bottom">
      <div class="vb-control-group">
        <button
          class="vb-btn"
          :disabled="state.loading.value || state.isTopicLocked() || compactionFence"
          @click="openReplyPage"
        >
          Post Reply
        </button>
        <button
          class="vb-btn"
          :disabled="state.loading.value || state.isTopicLocked() || compactionFence"
          @click="openHandoffModal"
        >
          Handoff
        </button>
        <button v-if="isAdmin" class="vb-btn" :disabled="!canFork" @click="openForkModal">Fork</button>
        <button v-if="isAdmin" class="vb-btn" :disabled="!canCompact" @click="openCompactionModal">Compact</button>
        <button class="vb-btn" @click="goHome">Back to Forum</button>
      </div>
      <div class="vb-pagination-controls">
        <button class="vb-page-btn" :disabled="state.currentPage.value <= 1" @click="prevPage">« Prev</button>
        <template v-for="(page, idx) in pageNumbers" :key="idx">
          <span v-if="page === '...'" class="vb-page-ellipsis">...</span>
          <button
            v-else
            class="vb-page-btn"
            :class="{ 'vb-page-active': page === state.currentPage.value }"
            @click="goToPage(page)"
          >
            {{ page }}
          </button>
        </template>
        <button class="vb-page-btn" :disabled="state.currentPage.value >= state.totalPages.value" @click="nextPage">
          Next »
        </button>
        <button
          class="vb-page-btn"
          :disabled="state.sortedPosts.value.length === 0"
          @click="goToLatest"
          title="Jump to latest post"
        >
          »»
        </button>
      </div>
    </div>

    <div v-if="showHandoffModal" ref="handoffPanelRef" class="vb-handoff-inline">
      <div class="vb-quick-reply vb-handoff-panel">
        <div class="vb-table-header">
          <span>{{ handoffStage === 'generate' ? 'Generate Handoff Draft' : 'Create Handoff Thread' }}</span>
          <button class="vb-modal-close" type="button" @click="closeHandoffModal">&times;</button>
        </div>
        <div class="vb-new-body">
          <div v-if="handoffError" class="vb-login-error">{{ handoffError }}</div>

          <template v-if="handoffStage === 'generate'">
            <div class="vb-form-section">
              <div class="vb-form-section-header">Goal</div>
              <div class="vb-form-section-body">
                <textarea
                  v-model="handoffGoal"
                  class="vb-option-textarea vb-handoff-textarea"
                  rows="7"
                  placeholder="What should the next thread accomplish?"
                ></textarea>
              </div>
            </div>
            <div class="vb-form-section">
              <div class="vb-form-section-header">Draft Generation</div>
              <div class="vb-form-section-body">
                <button
                  class="vb-small-btn"
                  type="button"
                  @click="showHandoffDraftModelAdvanced = !showHandoffDraftModelAdvanced"
                >
                  {{ showHandoffDraftModelAdvanced ? 'Hide model options' : 'Advanced model options' }}
                </button>
                <div v-if="showHandoffDraftModelAdvanced" class="vb-reply-options">
                  <div class="vb-option-group">
                    <label>Draft model:</label>
                    <select v-model="handoffDraftModel" class="vb-option-select">
                      <option value="">Current/default</option>
                      <option v-for="model in replyModels" :key="model" :value="model">{{ model }}</option>
                    </select>
                  </div>
                  <div v-if="handoffDraftSupportsReasoning" class="vb-option-group">
                    <label>Reasoning:</label>
                    <select v-model="handoffDraftReasoning" class="vb-option-select">
                      <option v-for="option in handoffDraftReasoningOptions" :key="option" :value="option">
                        {{ formatReasoningLabel(option) }}
                      </option>
                    </select>
                  </div>
                </div>
                <button
                  class="vb-small-btn"
                  type="button"
                  @click="showHandoffAdvancedPrompt = !showHandoffAdvancedPrompt"
                >
                  {{ showHandoffAdvancedPrompt ? 'Hide generation prompt' : 'Customize generation prompt' }}
                </button>
                <div v-if="showHandoffAdvancedPrompt" class="vb-form-row">
                  <div class="vb-form-hint">Edit this prompt or clear it to let agentd use its built-in default.</div>
                  <textarea
                    v-model="handoffSystemPrompt"
                    class="vb-option-textarea vb-handoff-textarea"
                    rows="8"
                    placeholder="Leave blank to use the default handoff generation prompt."
                  ></textarea>
                  <button class="vb-small-btn" type="button" @click="resetHandoffSystemPrompt">Reset to default</button>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="vb-form-section">
              <div class="vb-form-section-header">Destination</div>
              <div class="vb-form-section-body">
                <div class="vb-form-row">
                  <label class="vb-form-label">Thread title:</label>
                  <input v-model="handoffTitle" class="vb-option-input" maxlength="255" />
                </div>
                <div class="vb-form-row">
                  <label class="vb-form-label">Forum:</label>
                  <select v-model="handoffDestinationForumId" class="vb-option-input">
                    <option v-for="forum in moveForumOptions" :key="forum.id" :value="forum.id">
                      {{ forumOptionLabel(forum) }}
                    </option>
                  </select>
                </div>
                <div class="vb-form-row">
                  <label class="vb-checkbox-label">
                    <input v-model="handoffOverrideCwd" type="checkbox" />
                    <span>Override workspace</span>
                  </label>
                  <input
                    v-if="handoffOverrideCwd"
                    v-model="handoffCwdOverride"
                    class="vb-option-input"
                    placeholder="/path/to/workspace"
                  />
                  <div v-else class="vb-form-hint">
                    Workspace: {{ handoffEffectiveCwd || 'forum/default runtime workspace' }}
                  </div>
                </div>
                <button
                  class="vb-small-btn"
                  type="button"
                  @click="showHandoffLaunchAdvanced = !showHandoffLaunchAdvanced"
                >
                  {{ showHandoffLaunchAdvanced ? 'Hide launch model options' : 'Advanced launch model options' }}
                </button>
                <div v-if="showHandoffLaunchAdvanced" class="vb-reply-options">
                  <div class="vb-option-group">
                    <label>New thread model:</label>
                    <select v-model="handoffLaunchModel" class="vb-option-select">
                      <option value="">Current/default</option>
                      <option v-for="model in replyModels" :key="model" :value="model">{{ model }}</option>
                    </select>
                  </div>
                  <div v-if="handoffLaunchSupportsReasoning" class="vb-option-group">
                    <label>Reasoning:</label>
                    <select v-model="handoffLaunchReasoning" class="vb-option-select">
                      <option v-for="option in handoffLaunchReasoningOptions" :key="option" :value="option">
                        {{ formatReasoningLabel(option) }}
                      </option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <div class="vb-form-section">
              <div class="vb-form-section-header">Editable Handoff Draft</div>
              <div class="vb-form-section-body">
                <textarea v-model="handoffDraft" class="vb-option-textarea vb-handoff-textarea" rows="18"></textarea>
              </div>
            </div>
          </template>
        </div>
        <div class="vb-modal-actions">
          <button
            v-if="handoffStage === 'edit'"
            class="vb-btn vb-btn-secondary"
            type="button"
            :disabled="handoffLoading"
            @click="handoffStage = 'generate'"
          >
            Back
          </button>
          <button class="vb-btn vb-btn-secondary" type="button" :disabled="handoffLoading" @click="closeHandoffModal">
            Cancel
          </button>
          <button
            v-if="handoffStage === 'generate'"
            class="vb-btn"
            type="button"
            :disabled="handoffLoading"
            @click="generateHandoffDraft"
          >
            {{ handoffLoading ? 'Generating...' : 'Generate Draft' }}
          </button>
          <button v-else class="vb-btn" type="button" :disabled="handoffLoading" @click="createHandoffThread">
            {{ handoffLoading ? 'Creating...' : 'Create Handoff Thread' }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="quickReplyPresentationReady"
      id="quick-reply-composer"
      ref="quickReplyContainerRef"
      class="vb-quick-reply vb-quick-reply-composer"
      :class="{
        'vb-quick-reply--docked': quickReplyDocked,
        'vb-quick-reply--expanded': quickReplyExpanded,
        'vb-quick-reply--collapsed': quickReplyPresentation === 'docked-collapsed',
      }"
      role="region"
      aria-labelledby="quick-reply-title"
    >
      <div class="vb-table-header vb-quick-reply-header">
        <span id="quick-reply-title">Quick Reply</span>
        <span
          v-if="quickReplyPresentation === 'docked-collapsed'"
          class="vb-quick-reply-compact-status"
          :class="{ 'is-problem': quickReplyCompactStatusIsProblem }"
          role="status"
          aria-live="polite"
        >
          {{ quickReplyCompactStatus }}
        </span>
        <div class="vb-quick-reply-header-actions">
          <button
            v-if="(!quickReplyDocked || quickReplyExpanded) && canDockQuickReply"
            class="vb-small-btn"
            type="button"
            :aria-expanded="quickReplyOptionsOpen"
            aria-controls="quick-reply-template quick-reply-attachment-picker quick-reply-auto-compact"
            @click="quickReplyOptionsOpen = !quickReplyOptionsOpen"
          >
            {{ quickReplyOptionsOpen ? 'Hide options' : 'Options' }}
          </button>
          <button
            v-if="!quickReplyDocked && canDockQuickReply"
            ref="quickReplyKeepVisibleButtonRef"
            class="vb-small-btn"
            type="button"
            aria-label="Keep Quick Reply visible while reading"
            @click="activateQuickReply(false)"
          >
            Keep visible
          </button>
          <button
            v-else-if="quickReplyDocked && quickReplyExpanded && canDockQuickReply"
            class="vb-small-btn"
            type="button"
            aria-expanded="true"
            aria-controls="quick-reply-dock-body"
            @click="collapseQuickReply"
          >
            Collapse
          </button>
          <button
            v-else-if="quickReplyDocked && canDockQuickReply"
            ref="quickReplyExpandButtonRef"
            class="vb-small-btn"
            type="button"
            aria-expanded="false"
            aria-controls="quick-reply-dock-body"
            @click="activateQuickReply(true)"
          >
            Expand
          </button>
          <button v-if="quickReplyDocked" class="vb-small-btn" type="button" @click="undockQuickReply">Undock</button>
        </div>
      </div>
      <div id="quick-reply-dock-body" v-show="!quickReplyDocked || quickReplyExpanded" class="vb-quick-reply-dock-body">
        <div class="vb-quick-reply-scroll-region">
          <div v-if="state.isTopicLocked()" class="vb-locked-notice">
            This topic is {{ state.selectedTopic.value?.status }}. No new replies can be posted.
          </div>
          <div v-else-if="!state.isLoggedIn.value" class="vb-login-notice">
            <template v-if="state.canShowRegisterLink.value">
              <router-link to="/login">Log in</router-link> or <router-link to="/register">register</router-link> to
              post a reply.
            </template>
            <template v-else> <router-link to="/login">Log in</router-link> to post a reply. </template>
          </div>
          <div v-else class="vb-new-body">
            <div v-if="quickReplyWillSteerRobot" class="vb-steer-notice">
              Robot is responding right now.
              <button
                class="vb-btn vb-small-btn vb-btn-danger"
                :disabled="state.robotControlPending.value"
                @click="requestStopRobot"
              >
                {{ state.robotControlPending.value ? 'Stopping...' : 'Stop Robot' }}
              </button>
            </div>
            <div v-if="state.robotState.value?.lastTurnError" class="vb-robot-error-notice">
              <strong>Robot turn failed.</strong>
              <span
                >The last turn stopped before producing a reply. The robot is idle; you can retry or send another
                message.</span
              >
              <span class="vb-robot-error-detail">{{ state.robotState.value.lastTurnError.message }}</span>
            </div>
            <label for="quick-reply-message">Message:</label>
            <div id="quick-reply-template" v-show="quickReplyOptionsOpen" class="vb-quick-reply-options-panel">
              <MessageTemplatePicker
                context="reply"
                :forum-id="state.selectedTopic.value?.forumId ?? null"
                :has-draft="replyBody.length > 0"
                @apply="applyQuickReplyTemplate"
              />
              <router-link class="vb-small-btn" :to="{ name: 'topic.reply', params: { topicId: routeTopicId } }">
                Open full editor
              </router-link>
            </div>
            <DraftStatus
              :status="autosavedReply.status.value"
              :expires-at="autosavedReply.expiresAt.value"
              :conflict="Boolean(autosavedReply.remoteDraft.value)"
              @retry="autosavedReply.resume()"
              @discard="requestDiscardQuickDraft"
              @use-saved="autosavedReply.useSavedVersion()"
              @keep-mine="autosavedReply.keepMyVersion()"
              @copy-mine="autosavedReply.copyMyText()"
            />
            <div v-if="discardDraftError" class="vb-form-error" role="alert">{{ discardDraftError }}</div>
            <textarea
              id="quick-reply-message"
              ref="quickReplyTextareaRef"
              v-model="replyBody"
              rows="6"
              placeholder="Type your reply here..."
              :disabled="isPublishingReply"
              @input="quickReplyPresentationTouched = true"
            ></textarea>
            <div id="quick-reply-attachment-picker" v-show="quickReplyOptionsOpen" class="vb-reply-attachments">
              <label class="vb-attachment-label">Attachments:</label>
              <span class="vb-form-hint">Selected files are not included in autosaved drafts.</span>
              <input
                ref="replyFileInputRef"
                class="vb-attachment-input"
                type="file"
                multiple
                @change="handleReplyFiles"
              />
            </div>
            <div v-if="publishedReplyPostId || replyFiles.length > 0" class="vb-reply-attachments">
              <div v-if="publishedReplyPostId" class="vb-template-conflict" role="alert">
                Reply posted; attachment upload is incomplete. Retrying cannot duplicate the reply. Complete it within
                five minutes.
                <button
                  type="button"
                  class="vb-small-btn"
                  :disabled="isUploadingReply"
                  @click="retryQuickReplyAttachments"
                >
                  {{ replyFiles.length ? 'Retry remaining files' : 'Retry dispatch' }}
                </button>
                <button
                  type="button"
                  class="vb-small-btn"
                  :disabled="isUploadingReply"
                  @click="abandonQuickReplyAttachments"
                >
                  {{ replyFiles.length ? 'Abandon files' : 'Continue'
                  }}{{ publishedReplyNeedsDispatch ? ' and dispatch' : '' }}
                </button>
              </div>
              <div v-if="replyFiles.length > 0" class="vb-attachment-selected">
                <span>Selected:</span>
                <ul>
                  <li v-for="file in replyFiles" :key="file.name">{{ file.name }} ({{ formatBytes(file.size) }})</li>
                </ul>
              </div>
            </div>
            <div id="quick-reply-model-options" class="vb-reply-options">
          <div class="vb-option-group">
            <label for="model-select">Model:</label>
            <select
              id="model-select"
              v-model="selectedModel"
              class="vb-option-select"
              :disabled="topicRobotMode === 'off'"
            >
              <option v-for="model in replyModels" :key="model" :value="model">{{ model }}</option>
            </select>
          </div>
              <div v-if="supportsReasoning" class="vb-option-group">
                <label for="reasoning-select">Reasoning:</label>
                <select
                  id="reasoning-select"
                  v-model="selectedReasoning"
                  class="vb-option-select"
                  :disabled="topicRobotMode === 'off'"
                >
                  <option v-for="option in replyReasoningOptions" :key="option" :value="option">
                    {{ formatReasoningLabel(option) }}
                  </option>
                </select>
              </div>
            </div>
            <span v-if="robotModeNotice" class="vb-reply-options-callout">{{ robotModeNotice }}</span>
            <div id="quick-reply-auto-compact" v-show="quickReplyOptionsOpen">
              <AutoCompactOption
                v-model="autoCompactEnabled"
                :can-edit="isAdmin"
                :busy="isRobotBusy || compactionFence"
              />
            </div>
            <div v-if="sessionContext" id="quick-reply-context" class="vb-reply-context-meter">
          <strong>Context:</strong>
          <span
            v-if="sessionContext.usedTokens !== null && sessionContext.contextWindowTokens"
            class="vb-context-value"
          >
            {{ formatTokenCount(sessionContext.usedTokens) }} /
            {{ formatTokenCount(sessionContext.contextWindowTokens) }}
                <span v-if="typeof sessionContext.percent === 'number'"
                  >({{ sessionContext.percent.toFixed(1) }}%)</span
                >
                <span v-if="!sessionContext.exact" class="vb-context-warning"
                  >best Pi usage; not exact current context</span
                >
              </span>
              <span v-else>usage unavailable</span>
              <span v-if="sessionContext.model" class="vb-context-model">· {{ sessionContext.model }}</span>
            </div>
            <div v-if="compactionFence" class="vb-reply-options-callout" role="status">
              <template v-if="forkNeedsManualReview">
                Replies are paused because a fork needs operator review; the canonical source remains fenced.
              </template>
              <template v-else>Replies are paused while a canonical operation is unresolved.</template>
            </div>
          </div>
        </div>
        <div v-if="state.isLoggedIn.value && !state.isTopicLocked()" class="vb-quick-reply-footer">
          <button
            class="vb-btn vb-quick-reply-submit"
            :disabled="
              state.loading.value ||
              isReplying ||
              isUploadingReply ||
              !autosavedReply.hydrated.value ||
              Boolean(publishedReplyPostId) ||
              compactionFence ||
              !replyBody.trim()
            "
            @click="reply"
          >
            <span v-if="isReplying" class="vb-spinner" style="width: 12px; height: 12px; margin-right: 4px"></span>
            {{
              isUploadingReply
                ? 'Uploading...'
                : isReplying
                  ? 'Posting...'
                  : quickReplyWillSteerRobot
                    ? 'Steer Reply'
                    : 'Post Quick Reply'
            }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showRobotStatePanel" class="vb-robot-state">
      <div class="vb-table-header">
        <span>Robot State</span>
        <div class="vb-robot-actions">
          <span class="vb-status-pill">{{ state.robotState.value?.activity ?? 'idle' }}</span>
          <button
            class="vb-small-btn vb-btn-danger"
            type="button"
            :disabled="!isRobotBusy || robotControlPending"
            @click="requestStopRobot"
          >
            Stop
          </button>
        </div>
      </div>
      <div class="vb-robot-body">
        <div v-if="state.robotStopResult.value" class="vb-state-row">
          <strong>Stop {{ state.robotStopResult.value.state }}:</strong>
          {{ state.robotStopResult.value.message }}
          <span v-if="state.robotStopResult.value.effectsUnknownCount">
            Remote effects remain unknown for {{ state.robotStopResult.value.effectsUnknownCount }} run(s).
          </span>
        </div>
        <div class="vb-state-row">
          <div><strong>Status:</strong> {{ state.robotState.value?.activity ?? 'idle' }}</div>
          <div v-if="state.robotState.value?.lastTurnError" class="vb-state-error">
            <strong>Last turn failed:</strong> {{ state.robotState.value.lastTurnError.message }}
          </div>
          <div>
            <strong>Last Update:</strong>
            {{ state.robotState.value?.lastUpdatedAt ? state.formatDate(state.robotState.value.lastUpdatedAt) : 'n/a' }}
          </div>
        </div>
        <div>
          <strong>Model:</strong>
          {{ (state.robotState.value as any)?.context?.model ?? state.robotState.value?.model ?? 'unknown' }}
        </div>
        <div v-if="(state.robotState.value as any)?.context" class="vb-context-meter">
          <strong>Context:</strong>
          <span
            v-if="
              (state.robotState.value as any).context.usedTokens !== null &&
              (state.robotState.value as any).context.contextWindowTokens
            "
            class="vb-context-value"
          >
            {{ formatTokenCount((state.robotState.value as any).context.usedTokens) }} /
            {{ formatTokenCount((state.robotState.value as any).context.contextWindowTokens) }}
            <span v-if="typeof (state.robotState.value as any).context.percent === 'number'"
              >({{ (state.robotState.value as any).context.percent.toFixed(1) }}%)</span
            >
            <span v-if="!(state.robotState.value as any).context.exact" class="vb-context-warning"
              >best Pi usage; not exact current context</span
            >
          </span>
          <span v-else>usage unavailable</span>
        </div>
        <div class="vb-activity">
          <strong>Activity:</strong>
          <div v-if="liveActivityEvents.length === 0" class="vb-empty">Waiting for input.</div>
          <ol v-else class="vb-activity-feed">
            <li
              v-for="event in liveActivityEvents"
              :key="event.id"
              class="vb-activity-item"
              :class="{ 'vb-activity-item--tool': event.type === 'tool_run' }"
            >
              <template v-if="event.type === 'reasoning_step'">
                <div class="vb-activity-icon">●</div>
                <div class="vb-activity-content">
                  <div class="vb-activity-head">
                    <span class="vb-activity-title">{{ event.title }}</span>
                    <span
                      class="vb-activity-pill"
                      :class="event.status === 'running' ? 'vb-activity-pill--running' : 'vb-activity-pill--done'"
                    >
                      {{ event.status }}
                    </span>
                  </div>
                  <div v-if="event.detail" class="vb-activity-detail">{{ event.detail }}</div>
                </div>
              </template>
              <template v-else>
                <div class="vb-activity-icon">{{ toolKindIcon(toolMiniKind(event.toolRun)) }}</div>
                <div class="vb-activity-content">
                  <div class="vb-activity-head">
                    <span class="vb-activity-title">Tool: {{ toolMiniName(event.toolRun) }}</span>
                    <span class="vb-activity-time">{{ state.formatToolTime(event.toolRun.startedAt) }}</span>
                  </div>
                  <div v-if="toolMiniSummary(event.toolRun)" class="vb-activity-detail">
                    {{ toolMiniSummary(event.toolRun) }}
                  </div>
                  <div class="vb-activity-meta">
                    <span
                      class="vb-activity-pill"
                      :class="
                        !event.toolRun.finishedAt
                          ? 'vb-activity-pill--running'
                          : toolExitCodeValue(event.toolRun) === 0 ||
                              toolExitCodeValue(event.toolRun) === null ||
                              toolExitCodeValue(event.toolRun) === undefined
                            ? 'vb-activity-pill--done'
                            : 'vb-activity-pill--error'
                      "
                    >
                      {{ toolStatusLabel(event.toolRun) }}
                    </span>
                  </div>
                </div>
              </template>
            </li>
          </ol>
        </div>
        <div class="vb-tool-list">
          <div class="vb-tool-title">
            <span>Tool Usage</span>
            <div class="vb-tool-title-actions">
              <button
                class="vb-small-btn"
                type="button"
                :aria-pressed="showToolReasoning"
                @click="showToolReasoning = !showToolReasoning"
              >
                Reasoning: {{ showToolReasoning ? 'On' : 'Off' }}
              </button>
              <button
                class="vb-small-btn"
                type="button"
                :disabled="!canExpandToolUsage"
                @click="showAllTools = !showAllTools"
              >
                {{ showingAllToolUsageGroups ? 'Show Latest' : 'Show All' }}
              </button>
            </div>
          </div>
          <div v-if="toolUsageTraceGroups.length === 0" class="vb-empty">No trace activity yet.</div>
          <div v-else-if="visibleToolUsageEntryCount === 0" class="vb-empty">No tool runs yet.</div>
          <div
            v-for="group in visibleToolUsageGroups"
            :key="group.id"
            class="vb-tool-response"
          >
            <div
              v-if="showingAllToolUsageGroups && visibleToolUsageGroups.length > 1"
              class="vb-tool-response-label"
            >
              Response · {{ state.formatDate(group.latestAt) }}
            </div>
            <div v-if="group.items.length === 0" class="vb-empty">No tool runs in this response.</div>
            <template
              v-for="item in group.items"
              :key="item.type === 'tool' ? `tool:${item.tool.id}` : `reasoning:${item.segmentIndex}`"
            >
              <template v-if="item.type === 'reasoning'">
                <div
                  v-for="(step, stepIndex) in item.steps"
                  :key="toolUsageReasoningKey(group, item, stepIndex)"
                  class="vb-tool-item vb-tool-item--reasoning"
                >
                  <button
                    class="vb-tool-toggle vb-tool-toggle--compact"
                    type="button"
                    :aria-expanded="toolUsageReasoningExpanded(toolUsageReasoningKey(group, item, stepIndex))"
                    @click="toggleToolUsageReasoning(toolUsageReasoningKey(group, item, stepIndex))"
                  >
                    <span class="vb-tool-toggle-left">
                      <span class="vb-tool-reasoning-mini">
                        <span class="vb-tool-reasoning-icon" aria-hidden="true">●</span>
                        <span class="vb-tool-mini-name">{{ step.title || 'Thinking' }}</span>
                        <span v-if="toolUsageReasoningPreview(step.detail)" class="vb-tool-mini-summary">
                          {{ toolUsageReasoningPreview(step.detail) }}
                        </span>
                      </span>
                    </span>
                    <span class="vb-tool-toggle-right">
                      <span
                        class="vb-tool-pill"
                        :class="toolUsageReasoningStatusClass(group, item, stepIndex)"
                      >
                        {{ toolUsageReasoningStatus(group, item, stepIndex) }}
                      </span>
                      <span class="vb-tool-toggle-icon">
                        {{ toolUsageReasoningExpanded(toolUsageReasoningKey(group, item, stepIndex)) ? '−' : '+' }}
                      </span>
                    </span>
                  </button>
                  <div
                    v-if="step.detail && toolUsageReasoningExpanded(toolUsageReasoningKey(group, item, stepIndex))"
                    class="vb-tool-details"
                  >
                    <div
                      class="vb-tool-block vb-tool-reasoning-detail vb-rendered-content"
                      v-html="renderToolUsageReasoning(step.detail)"
                    ></div>
                  </div>
                </div>
              </template>
              <div v-else class="vb-tool-item">
                <button
                  class="vb-tool-toggle vb-tool-toggle--compact"
                  type="button"
                  :aria-expanded="toolExpanded(item.tool)"
                  @click="toggleTool(item.tool)"
                >
                  <span class="vb-tool-toggle-left">
                    <ToolMiniView :tool="item.tool" :showDetail="true" />
                  </span>
                  <span class="vb-tool-toggle-right">
                    <span class="vb-tool-meta">{{ state.formatToolTime(item.tool.startedAt) }}</span>
                    <span v-if="toolDurationLabel(item.tool)" class="vb-tool-duration">
                      {{ toolDurationLabel(item.tool) }}
                    </span>
                    <span class="vb-tool-pill" :class="toolStatusClass(item.tool)">
                      {{ toolStatusLabel(item.tool) }}
                    </span>
                    <span class="vb-tool-toggle-icon">{{ toolExpanded(item.tool) ? '−' : '+' }}</span>
                  </span>
                </button>
                <div v-if="toolExpanded(item.tool)" class="vb-tool-details">
                  <div v-if="toolMini(item.tool).input" class="vb-tool-block">
                    <div class="vb-tool-block-title">Input</div>
                    <pre class="vb-tool-pre">{{ toolMini(item.tool).input }}</pre>
                  </div>
                  <div v-if="toolMini(item.tool).output" class="vb-tool-block">
                    <div class="vb-tool-block-title">Output</div>
                    <pre class="vb-tool-pre">{{ toolMini(item.tool).output }}</pre>
                  </div>
                </div>
              </div>
            </template>
          </div>
          <div v-if="!showingAllToolUsageGroups && canExpandToolUsage" class="vb-tool-hint">
            Latest tool shown. Choose Show All for the complete trace.
          </div>
        </div>
      </div>
    </div>

    <div v-if="showSessionInspectorPanel" class="vb-robot-state">
      <div class="vb-table-header">
        <span>Session Inspector</span>
        <div class="vb-inspector-actions">
          <button class="vb-small-btn" type="button" @click="state.loadSessionInspector">Refresh</button>
          <button
            class="vb-small-btn"
            type="button"
            :disabled="!state.sessionInspector.value || state.sessionInspector.value.toolRuns.length === 0"
            @click="showInspectorTools = !showInspectorTools"
          >
            {{ showInspectorTools ? 'Show Latest Tool' : 'Show All Tools' }}
          </button>
          <button
            class="vb-small-btn"
            type="button"
            :disabled="!state.sessionInspector.value || state.sessionInspector.value.messages.length === 0"
            @click="showInspectorMessages = !showInspectorMessages"
          >
            {{ showInspectorMessages ? 'Hide Messages' : 'Show Messages' }}
          </button>
        </div>
      </div>
      <div class="vb-robot-body">
        <div v-if="!state.sessionInfo.value" class="vb-empty">No session yet.</div>
        <div v-else class="vb-session-meta">
          <div><strong>Session:</strong> {{ state.sessionInfo.value.id }}</div>
          <div><strong>Status:</strong> {{ state.sessionInfo.value.status }}</div>
          <div><strong>Started:</strong> {{ state.formatDate(state.sessionInfo.value.createdAt) }}</div>
          <template v-if="piSessionDiagnostics">
            <div><strong>Canonical Pi session:</strong> {{ piSessionDiagnostics.id }}</div>
            <div><strong>Session path:</strong> {{ piSessionDiagnostics.path }}</div>
            <div v-if="piSessionDiagnostics.cwd"><strong>CWD:</strong> {{ piSessionDiagnostics.cwd }}</div>
            <div v-if="piSessionDiagnostics.parentId">
              <strong>Parent session:</strong> {{ piSessionDiagnostics.parentId }}
            </div>
            <div v-if="piSessionDiagnostics.parentPath">
              <strong>Parent path:</strong> {{ piSessionDiagnostics.parentPath }}
            </div>
            <div v-if="piSessionDiagnostics.lineageKind">
              <strong>Lineage:</strong> {{ piSessionDiagnostics.lineageKind }}
            </div>
            <div v-if="piSessionDiagnostics.lineageSource">
              <strong>Lineage source:</strong> {{ piSessionDiagnostics.lineageSource }}
            </div>
            <div><strong>Imported:</strong> {{ state.formatDate(piSessionDiagnostics.importedAt) }}</div>
            <div v-if="piSessionDiagnostics.lastImportRunId">
              <strong>Import run:</strong> {{ piSessionDiagnostics.lastImportRunId }}
            </div>
          </template>
        </div>

        <div class="vb-tool-list">
          <div class="vb-tool-title">
            <span>Tool Calls (session)</span>
          </div>
          <div
            v-if="!state.sessionInspector.value || state.sessionInspector.value.toolRuns.length === 0"
            class="vb-empty"
          >
            No tool runs captured yet.
          </div>
          <div v-else>
            <div
              v-for="tool in showInspectorTools
                ? state.sessionInspector.value.toolRuns
                : state.sessionInspector.value.toolRuns.slice(0, 1)"
              :key="tool.id"
              class="vb-tool-item"
            >
              <button
                class="vb-tool-toggle vb-tool-toggle--compact"
                type="button"
                @click="toggleInspectorTool(tool.id)"
              >
                <span class="vb-tool-toggle-left">
                  <ToolMiniView :tool="tool" :showDetail="true" />
                </span>
                <span class="vb-tool-toggle-right">
                  <span class="vb-tool-meta">{{ state.formatToolTime(tool.startedAt) }}</span>
                  <span class="vb-tool-pill" :class="toolStatusClass(tool)">{{ toolStatusLabel(tool) }}</span>
                  <span v-if="toolDurationLabel(tool)" class="vb-tool-duration">{{ toolDurationLabel(tool) }}</span>
                  <span class="vb-tool-toggle-icon">{{ toolExpanded(tool) ? '−' : '+' }}</span>
                </span>
                <span>{{ inspectorToolExpanded(tool.id) ? '−' : '+' }}</span>
              </button>
              <div v-if="inspectorToolExpanded(tool.id)" class="vb-tool-details">
                <div v-if="toolMini(tool).input" class="vb-tool-block">
                  <div class="vb-tool-block-title">Input</div>
                  <pre class="vb-tool-pre">{{ toolMini(tool).input }}</pre>
                </div>
                <div v-if="toolMini(tool).output" class="vb-tool-block">
                  <div class="vb-tool-block-title">Output</div>
                  <pre class="vb-tool-pre">{{ toolMini(tool).output }}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="vb-tool-list">
          <div class="vb-tool-title">
            <span>Messages (session)</span>
          </div>
          <div v-if="!showInspectorMessages" class="vb-empty">Messages hidden.</div>
          <div
            v-else-if="!state.sessionInspector.value || state.sessionInspector.value.messages.length === 0"
            class="vb-empty"
          >
            No messages yet.
          </div>
          <div v-else class="vb-session-messages">
            <div
              v-for="msg in state.sessionInspector.value.messages.slice(-10)"
              :key="msg.id"
              class="vb-session-message"
            >
              <div class="vb-session-role">{{ msg.role }}</div>
              <div class="vb-session-content">{{ msg.content }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Scroll to Top Button -->
    <button
      class="vb-scroll-top"
      :class="{ visible: showScrollTop }"
      type="button"
      aria-label="Scroll to top"
      @click="scrollToTop"
    >
      &#9650;
    </button>
  </section>
</template>
