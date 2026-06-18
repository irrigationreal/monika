<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import DecryptText from '../components/DecryptText.vue';
import LiveAssistantTurn from '../components/LiveAssistantTurn.vue';
import PostTracePanel from '../components/PostTracePanel.vue';
import ToolMiniView from '../components/ToolMiniView.vue';
import { useForumState } from '../composables/useForumState';
import { useMarkdown } from '../composables/useMarkdown';
import { api } from '../lib/apiClient';
import { parseReasoningSteps } from '../lib/reasoning';
import { getToolMiniModel, toolKindIcon, traceToneForKind } from '../lib/toolMiniView';

import type { RobotActivityEvent } from '../composables/useForumState';
import type {
  AttachmentDto,
  ForumDto,
  PostDto,
  RobotPersonaDto,
  SessionInspectorDto,
  ToolRunDto,
} from '../lib/apiClient';
import type { ReasoningStep } from '../lib/reasoning';

type LiveTurnItem = {
  id: string;
  type: 'status' | 'reasoning' | 'tool' | 'assistant_text' | 'error';
  title: string;
  status: 'running' | 'success' | 'error' | 'done';
  meta?: string | null;
  detail?: string | null;
  markdown?: string | null;
  text?: string | null;
};

const { renderContent, renderBBCode } = useMarkdown();
const apiAny = api as any;

const route = useRoute();
const router = useRouter();
const state = useForumState();

const replyBody = ref('');
const editingPost = ref<PostDto | null>(null);
const editBody = ref('');
const showDeleteConfirm = ref<string | null>(null);
const showAllTools = ref(false);
const showAdminPanel = ref(false);
const editingTitle = ref(false);
const newTitle = ref('');
const showDeleteTopicConfirm = ref(false);
const showMoveTopicModal = ref(false);
const moveForumOptions = ref<ForumDto[]>([]);
const selectedMoveForumId = ref('');
const moveConfirmChecked = ref(false);
const moveError = ref('');
const moveLoading = ref(false);
const expandedTools = ref(new Set<string>());
const showInspectorTools = ref(false);
const expandedInspectorTools = ref(new Set<string>());
const showInspectorMessages = ref(false);
const showScrollTop = ref(false);
const isReplying = ref(false);
const isUploadingReply = ref(false);
const replyFiles = ref<File[]>([]);
const deletingByAttachment = ref<Record<string, boolean>>({});
const ttsLoadingByPost = ref<Record<string, boolean>>({});
const ttsErrorsByPost = ref<Record<string, string>>({});
const threadSearchOpen = ref(false);
const threadSearchQuery = ref('');
const selectedModel = ref(state.lastReplyModel.value ?? '');
const selectedReasoning = ref(state.lastReplyReasoning.value ?? 'medium');
const replyModels = computed(() => state.allModelOptions.value);
const effectiveSelectedModel = computed(() => selectedModel.value || (state.robotState.value as any)?.model || state.defaultModel.value || '');
const supportsReasoning = computed(() => state.modelSupportsReasoning(effectiveSelectedModel.value));
const reasoningOptions = ['low', 'medium', 'high', 'xhigh'];
const replyReasoningOptions = computed(() => reasoningOptions);
const canModerate = computed(() => state.canModerate.value);
const isAdmin = computed(() => state.currentUser.value?.kind === 'admin');
const isRobotBusy = computed(() => state.isRobotBusy.value);
const topicRobotMode = computed(() => state.selectedTopic.value?.robotMode ?? null);
const robotControlPending = computed(() => state.robotControlPending.value);
const isSticky = computed(() => state.selectedTopic.value?.tags?.includes('sticky') ?? false);
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

const autoRun = computed(() => state.topicAutoRun.value);
const showAutoRunPanel = computed(() => isAdmin.value && showAdminPanel.value && Boolean(routeTopicId.value));
const showRobotStatePanel = computed(() => isAdmin.value && topicRobotMode.value && topicRobotMode.value !== 'off');
const showSessionInspectorPanel = computed(() => topicRobotMode.value && topicRobotMode.value !== 'off');
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
const autoRunReasoningOptions = computed(() => reasoningOptions);

function normalizeReasoning(model: string, reasoning: string): string {
  const options = reasoningOptions;
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

const liveTurnPostNumber = computed(() => state.sortedPosts.value.length + 1);
const liveTurnPage = computed(() => pageForPostNumber(liveTurnPostNumber.value));
const showRobotDraftOnCurrentPage = computed(() => showRobotDraft.value && state.currentPage.value === liveTurnPage.value);

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
  return /@robot\\b/i.test(replyBody.value);
});

const quickReplyWillSteerRobot = computed(() => showRobotBusyNotice.value && quickReplyWillDispatchRobot.value);
const sessionContext = computed(() => (state.robotState.value as any)?.context ?? null);
const topicPiSession = computed(() => ((state.selectedTopic.value as any)?.piSession ?? null) as Record<string, any> | null);
const topicLineageLabel = computed(() => {
  const session = topicPiSession.value;
  if (!session?.parentId && !session?.parentPath) return null;
  const kind = String(session.lineageKind ?? '').trim().toLowerCase();
  if (kind === 'handoff') return 'Handoff from parent session';
  if (kind === 'delegate') return 'Delegate fork from parent session';
  if (kind === 'sleep') return 'Sleep fork from parent session';
  return 'Parent session';
});
const handoffDestinationForum = computed(() => moveForumOptions.value.find((forum) => forum.id === handoffDestinationForumId.value) ?? null);
const handoffEffectiveCwd = computed(() => handoffOverrideCwd.value ? handoffCwdOverride.value.trim() : (((handoffDestinationForum.value as any)?.cwd as string | undefined) ?? ''));
const handoffDraftModelEffective = computed(() => handoffDraftModel.value || effectiveSelectedModel.value || state.defaultModel.value || '');
const handoffLaunchModelEffective = computed(() => handoffLaunchModel.value || effectiveSelectedModel.value || state.defaultModel.value || '');
const handoffDraftSupportsReasoning = computed(() => state.modelSupportsReasoning(handoffDraftModelEffective.value));
const handoffLaunchSupportsReasoning = computed(() => state.modelSupportsReasoning(handoffLaunchModelEffective.value));

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
  const command = tool.command?.trim();
  if (mini.kind === 'exec' && command) return compact(command, 120) ?? command;
  return mini.name || tool.tool || 'tool';
}

function liveToolDetail(tool: ToolRunDto): string | null {
  const parts = [compact(tool.command, 1000), compact(tool.outputSummary, 900)].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

const liveTurnItems = computed<LiveTurnItem[]>(() => {
  const items: LiveTurnItem[] = [];
  const activity = state.robotState.value?.activity ?? 'idle';
  if (activity !== 'idle') {
    const statusTitle = activity === 'running_tools' ? 'Running tools' : activity === 'waiting' ? 'Waiting' : activity === 'error' ? 'Error' : 'Thinking';
    items.push({ id: 'status:activity', type: 'status', title: statusTitle, status: activity === 'error' ? 'error' : 'running' });
  }

  for (const event of liveActivityEvents.value) {
    if (event.type === 'reasoning_step') {
      items.push({
        id: event.id,
        type: 'reasoning',
        title: event.title || 'Thinking',
        status: event.status === 'running' ? 'running' : 'done',
        markdown: event.detail ?? null,
      });
      continue;
    }
    const tool = event.toolRun;
    const status = !tool.finishedAt ? 'running' : (toolExitCodeValue(tool) ?? 0) === 0 ? 'success' : 'error';
    const timeoutHint = tool.command?.match(/timeout(?:Ms)?[=:]\s*(\d+)/i)?.[1] ?? null;
    items.push({
      id: event.id,
      type: 'tool',
      title: liveToolTitle(tool),
      status,
      meta: [tool.tool, toolStatusLabel(tool), timeoutHint ? `timeout ${timeoutHint}ms` : null].filter(Boolean).join(' · '),
      detail: liveToolDetail(tool),
    });
  }

  const lastError = state.robotState.value?.lastTurnError?.message ?? null;
  if (lastError && activity === 'error') {
    items.push({ id: 'error:last-turn', type: 'error', title: 'Turn error', status: 'error', detail: lastError });
  }

  if (state.assistantDraft.value.trim()) {
    items.push({ id: 'assistant:live', type: 'assistant_text', title: 'Writing response', status: 'running', text: state.assistantDraft.value });
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
    await state.moveTopicToForum(selectedMoveForumId.value);
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
  handoffDraftReasoning.value = normalizeReasoning(model || state.defaultModel.value || '', handoffDraftReasoning.value);
});

watch(handoffLaunchModel, (model) => {
  handoffLaunchReasoning.value = normalizeReasoning(model || state.defaultModel.value || '', handoffLaunchReasoning.value);
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

const visibleToolRuns = computed(() => {
  if (!state.robotState.value?.recentToolRuns) return [];
  return showAllTools.value ? state.robotState.value.recentToolRuns : state.robotState.value.recentToolRuns.slice(0, 1);
});

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

function copyPostLink(post: PostDto): void {
  const postNumber = postNumberForPostId(post.id);
  if (!postNumber) return;
  const url = buildPostPermalink(postNumber);
  navigator.clipboard
    .writeText(url)
    .then(() => {
      copiedLinkPostId.value = post.id;
      window.setTimeout(() => {
        if (copiedLinkPostId.value === post.id) copiedLinkPostId.value = null;
      }, 1200);
    })
    .catch(() => {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = url;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copiedLinkPostId.value = post.id;
      window.setTimeout(() => {
        if (copiedLinkPostId.value === post.id) copiedLinkPostId.value = null;
      }, 1200);
    });
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

function quotePost(post: PostDto): void {
  if (state.isTopicLocked()) {
    state.setError('Cannot reply to a locked or archived topic.');
    return;
  }
  const authorName = state.identityName(post.authorId);
  const quoted = `[QUOTE=${authorName}]\n${post.body}\n[/QUOTE]\n\n`;
  replyBody.value = quoted + replyBody.value;
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

async function reply(): Promise<void> {
  if (!replyBody.value.trim()) return;
  isReplying.value = true;
  try {
    const attachmentsPending = replyFiles.value.length > 0;
    const post = await state.createPost(replyBody.value.trim(), {
      model: effectiveSelectedModel.value,
      reasoningEffort: supportsReasoning.value ? selectedReasoning.value : null,
      attachmentsPending,
    });
    if (replyFiles.value.length > 0) {
      isUploadingReply.value = true;
      for (const file of replyFiles.value) {
        await state.uploadAttachment(post.id, file);
      }
      if (attachmentsPending) {
        await state.dispatchPost(post.id, {
          model: effectiveSelectedModel.value,
          reasoningEffort: supportsReasoning.value ? selectedReasoning.value : null,
        });
      }
      replyFiles.value = [];
    }
    replyBody.value = '';

    // UX: when replying from an earlier page in a multi-page thread, your post lands on the last page.
    // Jump to the last page and set the URL hash to the new post number.
    const lastPage = state.totalPages.value;
    const lastIndex = state.sortedPosts.value.length;
    const nextQuery = buildPageQuery(lastPage);
    state.setPage(lastPage);
    await router.push({ query: nextQuery, hash: `#${lastIndex}` });
    await nextTick();
    scrollToAnchor('smooth');
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to post reply.');
  } finally {
    isReplying.value = false;
    isUploadingReply.value = false;
  }
}

async function stopRobot(): Promise<void> {
  await state.interruptRobot();
}

async function continueRobot(): Promise<void> {
  await state.continueRobot();
}

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
  if (!state.selectedTopic.value) return;
  router.push({
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

watch(
  routeTopicId,
  async (topicId) => {
    if (topicId) {
      await loadTopic(topicId);
    }
  },
  { immediate: true }
);

onMounted(() => {
  window.addEventListener('scroll', handleScroll);
});

onUnmounted(() => {
  state.closeStream();
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
            <li>In-flight robot responses will be interrupted.</li>
            <li>Working directory context will change; previous files may no longer exist.</li>
            <li>Topic visibility (and attachment access) will follow the destination forum.</li>
          </ul>
          <label class="vb-modal-checkbox">
            <input type="checkbox" v-model="moveConfirmChecked" />
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

  <section class="vb-section">
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
        <router-link v-if="topicPiSession?.parentTopicId" class="vb-lineage-link" :to="`/topics/${topicPiSession.parentTopicId}`">Open parent thread</router-link>
        <span v-if="topicPiSession?.lineageSource" class="vb-context-model">· {{ topicPiSession.lineageSource }}</span>
      </div>
      <details>
        <summary>Details</summary>
        <div v-if="topicPiSession?.parentId"><strong>Parent session:</strong> {{ topicPiSession.parentId }}</div>
        <div v-if="topicPiSession?.parentPath"><strong>Parent path:</strong> {{ topicPiSession.parentPath }}</div>
        <div v-if="topicPiSession?.id"><strong>Current session:</strong> {{ topicPiSession.id }}</div>
        <div v-if="topicPiSession?.path"><strong>Current path:</strong> {{ topicPiSession.path }}</div>
        <div v-if="topicPiSession?.cwd"><strong>CWD:</strong> {{ topicPiSession.cwd }}</div>
      </details>
    </div>

    <div class="vb-controls">
      <div class="vb-control-group">
        <button class="vb-btn" :disabled="state.loading.value || state.isTopicLocked()" @click="openReplyPage">
          Post Reply
        </button>
        <button class="vb-btn" :disabled="state.loading.value || state.isTopicLocked()" @click="openHandoffModal">Handoff</button>
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
        <button v-if="isAdmin" class="vb-small-btn" :disabled="state.loading.value" @click="openMoveTopicModal">
          Move Thread
        </button>
        <button class="vb-small-btn" :disabled="state.loading.value" @click="handleToggleSticky">
          {{ isSticky ? 'Unsticky' : 'Sticky' }}
        </button>
        <button
          v-if="state.selectedTopic.value?.status === 'open'"
          class="vb-small-btn"
          :disabled="state.loading.value"
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
          :disabled="state.loading.value"
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
          :disabled="state.loading.value"
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
            <button class="vb-small-btn" type="button" :disabled="!canEditAutoRun || autoRunBusy" @click="saveAutoRun">
              Save
            </button>
            <button
              class="vb-small-btn"
              type="button"
              :disabled="!canEditAutoRun || autoRunBusy || !autoRunEnabled"
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
            :disabled="!canEditAutoRun || autoRunBusy || !autoRunEnabled"
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
        <button type="button" class="vb-inline-link" @click="goToPage(liveTurnPage)">Jump to live trace</button>
      </div>

      <div v-if="threadSearchQuery && filteredPosts.length === 0" class="vb-empty">No posts match your search.</div>

      <div
        v-for="(post, idx) in threadSearchQuery ? filteredPosts : state.currentPosts.value"
        :key="post.id"
        class="vb-post"
        :id="String(postNumberForPostId(post.id) ?? postNumberForIndex(idx))"
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
                  planForPost(post) ? renderPost(planForPost(post)?.summary || planForPost(post)?.content || '') : null
                "
                :toolRuns="toolRunsForPost(post)"
                :traceId="post.id"
                :topicId="routeTopicId"
              />

              <div class="vb-post-heading">
                <span>{{ state.selectedTopic.value?.title }}</span>
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
                    <div class="vb-post-text vb-rendered-content" v-html="renderPost(segment.body)"></div>
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
                    <a
                      class="vb-attachment-link"
                      :href="`/api/attachments/${attachment.id}`"
                      target="_blank"
                      rel="noopener"
                    >
                      {{ attachment.filename }}
                    </a>
                    <span class="vb-attachment-meta"
                      >{{ formatBytes(attachment.sizeBytes) }} ·
                      {{ new Date(attachment.createdAt).toLocaleString() }}</span
                    >
                    <button
                      v-if="isPostOwner(post)"
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
                  planForPost(post) ? renderPost(planForPost(post)?.summary || planForPost(post)?.content || '') : null
                "
                :toolRuns="toolRunsForPost(post)"
                :traceId="post.id"
                :topicId="routeTopicId"
              />
              <div class="vb-post-heading">
                <span>{{ state.selectedTopic.value?.title }}</span>
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
              <div class="vb-post-text vb-rendered-content" v-html="renderPost(post.body)"></div>
              <div v-if="visibleAttachmentsForPost(post.id).length > 0" class="vb-post-attachments">
                <div class="vb-attachments-header">Attachments</div>
                <ul class="vb-attachments-list">
                  <li
                    v-for="attachment in visibleAttachmentsForPost(post.id)"
                    :key="attachment.id"
                    class="vb-attachment-item"
                  >
                    <a
                      class="vb-attachment-link"
                      :href="`/api/attachments/${attachment.id}`"
                      target="_blank"
                      rel="noopener"
                    >
                      {{ attachment.filename }}
                    </a>
                    <span class="vb-attachment-meta"
                      >{{ formatBytes(attachment.sizeBytes) }} ·
                      {{ new Date(attachment.createdAt).toLocaleString() }}</span
                    >
                    <button
                      v-if="isPostOwner(post)"
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
            :disabled="state.isTopicLocked() || !!post.deletedAt"
            @click="openEditModal(post)"
          >
            Edit
          </button>
          <button class="vb-control-btn" :disabled="state.isTopicLocked() || !!post.deletedAt" @click="quotePost(post)">
            Quote
          </button>
          <button
            class="vb-control-btn"
            type="button"
            :title="`Copy link to post #${postNumberForPostId(post.id) ?? postNumberForIndex(idx)}`"
            @click="copyPostLink(post)"
          >
            {{ copiedLinkPostId === post.id ? 'Copied' : 'Link' }}
          </button>
          <button
            v-if="canDeletePost(post)"
            class="vb-control-btn"
            :disabled="state.isTopicLocked() || !!post.deletedAt"
            @click="confirmDelete(post)"
          >
            Delete
          </button>
        </div>
        <div v-if="showDeleteConfirm === post.id" class="vb-delete-confirm">
          <span>Delete this post?</span>
          <button class="vb-small-btn vb-btn-danger" :disabled="state.loading.value" @click="handleDelete(post.id)">
            Yes, Delete
          </button>
          <button class="vb-small-btn" @click="cancelDelete">Cancel</button>
        </div>
      </div>

      <LiveAssistantTurn
        v-if="showRobotDraftOnCurrentPage"
        :items="liveTurnItems"
        :activity="state.robotState.value?.activity ?? null"
        :model="state.robotState.value?.model ?? null"
        :reasoning="state.robotState.value?.reasoningEffort ?? null"
        :active="isRobotThinking"
        :topicId="routeTopicId"
        :id="String(liveTurnPostNumber)"
      />
    </div>

    <div class="vb-controls vb-controls-bottom">
      <div class="vb-control-group">
        <button class="vb-btn" :disabled="state.loading.value || state.isTopicLocked()" @click="openReplyPage">
          Post Reply
        </button>
        <button class="vb-btn" :disabled="state.loading.value || state.isTopicLocked()" @click="openHandoffModal">Handoff</button>
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
              <button class="vb-small-btn" type="button" @click="showHandoffDraftModelAdvanced = !showHandoffDraftModelAdvanced">
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
                    <option v-for="option in replyReasoningOptions" :key="option" :value="option">{{ formatReasoningLabel(option) }}</option>
                  </select>
                </div>
              </div>
              <button class="vb-small-btn" type="button" @click="showHandoffAdvancedPrompt = !showHandoffAdvancedPrompt">
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
                  <option v-for="forum in moveForumOptions" :key="forum.id" :value="forum.id">{{ forumOptionLabel(forum) }}</option>
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
                <div v-else class="vb-form-hint">Workspace: {{ handoffEffectiveCwd || 'forum/default runtime workspace' }}</div>
              </div>
              <button class="vb-small-btn" type="button" @click="showHandoffLaunchAdvanced = !showHandoffLaunchAdvanced">
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
                    <option v-for="option in replyReasoningOptions" :key="option" :value="option">{{ formatReasoningLabel(option) }}</option>
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
        <button v-if="handoffStage === 'edit'" class="vb-btn vb-btn-secondary" type="button" :disabled="handoffLoading" @click="handoffStage = 'generate'">
          Back
        </button>
        <button class="vb-btn vb-btn-secondary" type="button" :disabled="handoffLoading" @click="closeHandoffModal">Cancel</button>
        <button v-if="handoffStage === 'generate'" class="vb-btn" type="button" :disabled="handoffLoading" @click="generateHandoffDraft">
          {{ handoffLoading ? 'Generating...' : 'Generate Draft' }}
        </button>
        <button v-else class="vb-btn" type="button" :disabled="handoffLoading" @click="createHandoffThread">
          {{ handoffLoading ? 'Creating...' : 'Create Handoff Thread' }}
        </button>
      </div>
    </div>
  </div>


    <div class="vb-quick-reply">
      <div class="vb-table-header">Quick Reply</div>
      <div v-if="state.isTopicLocked()" class="vb-locked-notice">
        This topic is {{ state.selectedTopic.value?.status }}. No new replies can be posted.
      </div>
      <div v-else-if="!state.isLoggedIn.value" class="vb-login-notice">
        <router-link to="/login">Log in</router-link> or <router-link to="/register">register</router-link> to post a
        reply.
      </div>
      <div v-else class="vb-new-body">
        <div v-if="quickReplyWillSteerRobot" class="vb-steer-notice">
          Robot is responding right now.
          <button
            class="vb-btn vb-small-btn vb-btn-danger"
            :disabled="state.robotControlPending.value"
            @click="stopRobot"
          >
            {{ state.robotControlPending.value ? 'Stopping...' : 'Stop Robot' }}
          </button>
        </div>
        <div v-if="state.robotState.value?.lastTurnError" class="vb-robot-error-notice">
          <strong>Robot turn failed.</strong>
          <span>The last turn stopped before producing a reply. The robot is idle; you can retry or send another message.</span>
          <span class="vb-robot-error-detail">{{ state.robotState.value.lastTurnError.message }}</span>
        </div>
        <label>Message:</label>
        <textarea v-model="replyBody" rows="6" placeholder="Type your reply here..."></textarea>
        <div class="vb-reply-attachments">
          <label class="vb-attachment-label">Attachments:</label>
          <input class="vb-attachment-input" type="file" multiple @change="handleReplyFiles" />
          <div v-if="replyFiles.length > 0" class="vb-attachment-selected">
            <span>Selected:</span>
            <ul>
              <li v-for="file in replyFiles" :key="file.name">{{ file.name }} ({{ formatBytes(file.size) }})</li>
            </ul>
          </div>
        </div>
        <div class="vb-reply-options">
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
          <div class="vb-option-group" v-if="supportsReasoning">
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
          <span v-if="robotModeNotice" class="vb-reply-options-callout">{{ robotModeNotice }}</span>
        </div>
        <div v-if="sessionContext" class="vb-reply-context-meter">
          <strong>Context:</strong>
          <span v-if="sessionContext.usedTokens !== null && sessionContext.contextWindowTokens" class="vb-context-value">
            {{ formatTokenCount(sessionContext.usedTokens) }} / {{ formatTokenCount(sessionContext.contextWindowTokens) }}
            <span v-if="typeof sessionContext.percent === 'number'">({{ sessionContext.percent.toFixed(1) }}%)</span>
            <span v-if="!sessionContext.exact" class="vb-context-warning">best Pi usage; not exact current context</span>
          </span>
          <span v-else>usage unavailable</span>
          <span v-if="sessionContext.model" class="vb-context-model">· {{ sessionContext.model }}</span>
        </div>
        <button
          class="vb-btn"
          :disabled="state.loading.value || isReplying || isUploadingReply || !replyBody.trim()"
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

    <div v-if="showRobotStatePanel" class="vb-robot-state">
      <div class="vb-table-header">
        <span>Robot State</span>
        <div class="vb-robot-actions">
          <span class="vb-status-pill">{{ state.robotState.value?.activity ?? 'idle' }}</span>
          <button
            class="vb-small-btn vb-btn-danger"
            type="button"
            :disabled="!isRobotBusy || robotControlPending"
            @click="stopRobot"
          >
            Stop
          </button>
          <button
            class="vb-small-btn"
            type="button"
            :disabled="isRobotBusy || robotControlPending"
            @click="continueRobot"
          >
            Continue
          </button>
        </div>
      </div>
      <div class="vb-robot-body">
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
        <div><strong>Model:</strong> {{ (state.robotState.value as any)?.context?.model ?? state.robotState.value?.model ?? 'unknown' }}</div>
        <div v-if="(state.robotState.value as any)?.context" class="vb-context-meter">
          <strong>Context:</strong>
          <span v-if="(state.robotState.value as any).context.usedTokens !== null && (state.robotState.value as any).context.contextWindowTokens" class="vb-context-value">
            {{ formatTokenCount((state.robotState.value as any).context.usedTokens) }} / {{ formatTokenCount((state.robotState.value as any).context.contextWindowTokens) }}
            <span v-if="typeof (state.robotState.value as any).context.percent === 'number'">({{ (state.robotState.value as any).context.percent.toFixed(1) }}%)</span>
            <span v-if="!(state.robotState.value as any).context.exact" class="vb-context-warning">best Pi usage; not exact current context</span>
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
                <div class="vb-activity-icon">🧠</div>
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
            <button
              class="vb-small-btn"
              :disabled="!state.robotState.value || state.robotState.value.recentToolRuns.length === 0"
              @click="showAllTools = !showAllTools"
            >
              {{ showAllTools ? 'Show Latest' : 'Show All' }}
            </button>
          </div>
          <div v-if="!state.robotState.value || state.robotState.value.recentToolRuns.length === 0" class="vb-empty">
            No tool runs yet.
          </div>
          <div v-for="tool in visibleToolRuns" :key="tool.id" class="vb-tool-item">
            <button class="vb-tool-toggle vb-tool-toggle--compact" type="button" @click="toggleTool(tool)">
              <span class="vb-tool-toggle-left">
                <ToolMiniView :tool="tool" :showDetail="true" />
              </span>
              <span class="vb-tool-toggle-right">
                <span class="vb-tool-meta">{{ state.formatToolTime(tool.startedAt) }}</span>
                <span class="vb-tool-pill" :class="toolStatusClass(tool)">{{ toolStatusLabel(tool) }}</span>
                <span v-if="toolDurationLabel(tool)" class="vb-tool-duration">{{ toolDurationLabel(tool) }}</span>
                <span class="vb-tool-toggle-icon">{{ toolExpanded(tool) ? '−' : '+' }}</span>
              </span>
            </button>
            <div v-if="toolExpanded(tool)" class="vb-tool-details">
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
          <div v-if="state.latestToolRun.value && !toolExpanded(state.latestToolRun.value)" class="vb-tool-hint">
            Latest tool run shown. Expand for details.
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
