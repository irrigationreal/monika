import { computed, ref } from 'vue';

import { api, createStateStream, getAuthToken, setAuthToken, setRefreshToken } from '../lib/apiClient';
import { parseReasoningSteps } from '../lib/reasoning';
import { retainSessionContext } from '../lib/sessionContext';
import { useTheme } from './useTheme';

import type {
  AttachmentDto,
  AuthUserDto,
  ForumDto,
  ForumLeaderDto,
  ForumThemeKey,
  IdentityDto,
  ListForumsParams,
  ModelCatalogDto,
  ModelInfoDto,
  PostDto,
  RecentPostDto,
  RegisterResponseDto,
  RegistrationModeDto,
  RobotPersonaDto,
  RobotStateDto,
  RobotStopResultDto,
  SessionContextDto,
  SessionDto,
  SessionInspectorDto,
  TopicAutoRunDto,
  TopicDto,
  TopicOperationalEventDto,
} from '../lib/apiClient';
import type { ReasoningStep } from '../lib/reasoning';

export type TraceSegment =
  { kind: 'reasoning'; text: string } | { kind: 'assistant_text'; text: string } | { kind: 'tool'; toolRunId: string };

export function freezeInterruptedTextSegments(segments: TraceSegment[], reasoning: string, assistant: string): TraceSegment[] {
  const frozen = [...segments];
  if (reasoning) frozen.push({ kind: 'reasoning', text: reasoning });
  if (assistant) frozen.push({ kind: 'assistant_text', text: assistant });
  return frozen;
}

export function isDurableStopBoundary(activity: RobotStateDto['activity'] | null | undefined): boolean {
  return activity === 'stopped';
}

export function isInitiatingTopicCurrent(initiatingTopicId: string, currentTopicId: string | null): boolean {
  return initiatingTopicId === currentTopicId;
}

const forums = ref<ForumDto[]>([]);
const archivedForums = ref<ForumDto[]>([]);
const topics = ref<TopicDto[]>([]);
const selectedForumId = ref<string | null>(null);
const selectedTopic = ref<TopicDto | null>(null);
const posts = ref<PostDto[]>([]);
const operationalEvents = ref<TopicOperationalEventDto[]>([]);
const recentPosts = ref<RecentPostDto[]>([]);
const forumLeaders = ref<ForumLeaderDto[]>([]);
const forumLeadersLoading = ref(false);
const forumLeadersError = ref<string | null>(null);
const identities = ref<Record<string, IdentityDto>>({});
const robotPersonas = ref<Record<string, RobotPersonaDto>>({});
const robotState = ref<RobotStateDto | null>(null);
const sessionContext = ref<SessionContextDto | null>(null);
const topicAutoRun = ref<TopicAutoRunDto | null>(null);
const autoRunLoading = ref(false);
const autoRunError = ref<string | null>(null);
const robotControlPending = ref(false);
const robotStopResult = ref<RobotStopResultDto | null>(null);
const reasoningDraft = ref('');
const assistantDraft = ref('');
const reasoningSteps = ref<ReasoningStep[]>([]);
const committedSegments = ref<TraceSegment[]>([]);
/** True when the response was interrupted — keeps the trace visible as frozen. */
const interruptedTrace = ref(false);

export type RobotActivityEvent =
  | {
      type: 'reasoning_step';
      id: string;
      seq: number;
      title: string;
      detail: string | null;
      status: 'running' | 'done';
    }
  | {
      type: 'tool_run';
      id: string;
      seq: number;
      toolRun: RobotStateDto['recentToolRuns'][number];
    };

const activityLog = ref<RobotActivityEvent[]>([]);
const sessionInfo = ref<SessionDto | null>(null);
const sessionInspector = ref<SessionInspectorDto | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const currentPage = ref(1);
const POSTS_PER_PAGE = 8;
const attachmentsByPost = ref<Record<string, AttachmentDto[]>>({});
const lastReplyModel = ref<string | null>(null);
const lastReplyReasoning = ref<string | null>(null);
const fallbackModelCatalog: ModelCatalogDto = {
  items: [{
    id: 'gpt-5.2',
    family: 'echs',
    supportsReasoning: true,
    supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    supportsTools: true,
    contextWindowTokens: 200000
  }],
  updatedAt: new Date(0).toISOString(),
};
const FORUM_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const modelCatalog = ref<ModelCatalogDto | null>(null);
const modelCatalogLoading = ref(false);
const modelCatalogError = ref<string | null>(null);
const registrationSettings = ref<RegistrationModeDto>({
  mode: 'disabled',
  registrationEnabled: false,
  inviteRegistrationEnabled: false,
  publicRegistrationEnabled: false,
});
const registrationSettingsLoading = ref(false);
const registrationSettingsError = ref<string | null>(null);

const LAST_REPLY_MODEL_KEY = 'codex-forum:last-reply-model';
const LAST_REPLY_REASONING_KEY = 'codex-forum:last-reply-reasoning';
let lastReplyDefaultsLoaded = false;
let modelCatalogLoaded = false;
let registrationSettingsLoaded = false;

const currentUser = ref<AuthUserDto['identity']>(null);
const currentPermissions = ref<string[]>([]);
const authChecked = ref(false);
const showLoginModal = ref(false);
// Matches the “Show threads from…” dropdown on forum index pages.
// Default to classic forum behavior (show everything).
const dateFilter = ref<'day' | '2days' | 'week' | 'beginning'>('beginning');

const { setTheme } = useTheme();
const operationalEventApi = api as unknown as {
  listOperationalEvents(topicId: string): Promise<{ items: TopicOperationalEventDto[] }>;
};

let stream: EventSource | null = null;
let activePlanId: string | null = null;
let reasoningStepCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 2000;
let streamManuallyClosed = false;
let pendingReasoningDelta = '';
let pendingAssistantDelta = '';
let flushHandle: number | null = null;
let assistantMessagePending = false;
let topicLoadCounter = 0;
let forumsLoadCounter = 0;
let archivedForumsLoadCounter = 0;
let recentPostsLoadCounter = 0;
let topicHydrationEnabled = true;
let liveTurnStartedAt: number | null = null;
// --- Committed segments (append-only trace model) ---
// No longer using client-side checkpoints for trace interleaving.
// Instead, tool_started events flush pending drafts into committedSegments.

function resetRobotActivity(): void {
  reasoningSteps.value = [];
  activityLog.value = [];
  reasoningStepCount = 0;
  committedSegments.value = [];
}

function clearCompletedAssistantTurnTrace(): void {
  assistantDraft.value = '';
  reasoningDraft.value = '';
  pendingAssistantDelta = '';
  pendingReasoningDelta = '';
  interruptedTrace.value = false;
  robotStopResult.value = null;
  activePlanId = null;
  liveTurnStartedAt = null;
  resetRobotActivity();
}

function syncReasoningActivity(statusOverride?: { status: 'running' | 'done' }): void {
  const parsed = parseReasoningSteps(reasoningDraft.value);
  reasoningSteps.value = parsed;
  reasoningStepCount = parsed.length;
}

/** Flush any buffered reasoning deltas into reasoningDraft and re-parse steps.
 *  Must be called before recording reasoning checkpoints so the step count
 *  reflects all reasoning that arrived before the tool event. */
function flushPendingDeltas(): void {
  if (pendingReasoningDelta) {
    reasoningDraft.value += pendingReasoningDelta;
    pendingReasoningDelta = '';
    syncReasoningActivity();
  }
  if (pendingAssistantDelta) {
    assistantDraft.value += pendingAssistantDelta;
    pendingAssistantDelta = '';
  }
  if (flushHandle !== null) {
    window.cancelAnimationFrame(flushHandle);
    flushHandle = null;
  }
}

function freezeCurrentInterruptedTrace(): void {
  flushPendingDeltas();
  committedSegments.value = freezeInterruptedTextSegments(
    committedSegments.value,
    reasoningDraft.value,
    assistantDraft.value,
  );
  assistantDraft.value = '';
  reasoningDraft.value = '';
  pendingAssistantDelta = '';
  pendingReasoningDelta = '';
  activePlanId = null;
  interruptedTrace.value = true;
}

function hasCurrentTrace(): boolean {
  return interruptedTrace.value || committedSegments.value.length > 0 || Boolean(
    reasoningDraft.value || assistantDraft.value || pendingReasoningDelta || pendingAssistantDelta,
  );
}

function syncToolActivity(toolRuns: RobotStateDto['recentToolRuns']): void {
  const runsOldestFirst = toolRuns.slice().reverse();

  for (const run of runsOldestFirst) {
    const id = `tool:${run.id}`;
    const existing = activityLog.value.find((event) => event.type === 'tool_run' && event.id === id) as
      Extract<RobotActivityEvent, { type: 'tool_run' }> | undefined;
    if (existing) {
      // Immutable update so Vue re-triggers computed dependencies
      activityLog.value = activityLog.value.map((e) =>
        e.type === 'tool_run' && e.id === id ? { ...e, toolRun: run } : e
      );
      continue;
    }
    // Immutable append so Vue re-triggers computed dependencies
    activityLog.value = [...activityLog.value, { type: 'tool_run', id, seq: 0, toolRun: run }];
  }
}
function getTopicActivityTime(topic: TopicDto): number {
  const iso = topic.lastPostAt ?? topic.updatedAt;
  return new Date(iso).getTime();
}

function sortTopicsByActivity(items: TopicDto[]): TopicDto[] {
  return items.slice().sort((a, b) => getTopicActivityTime(b) - getTopicActivityTime(a));
}

export function useForumState() {
  if (!lastReplyDefaultsLoaded) {
    lastReplyDefaultsLoaded = true;
    if (typeof window !== 'undefined') {
      try {
        const storedModel = window.localStorage.getItem(LAST_REPLY_MODEL_KEY);
        if (storedModel) {
          lastReplyModel.value = storedModel;
        }
        const storedReasoning = window.localStorage.getItem(LAST_REPLY_REASONING_KEY);
        if (storedReasoning) {
          lastReplyReasoning.value = storedReasoning;
        }
      } catch {
        // Ignore storage errors
      }
    }
  }
  if (!registrationSettingsLoaded) {
    void loadRegistrationSettings();
  }
  const selectedTopicId = computed(() => selectedTopic.value?.id ?? null);

  const sortedPosts = computed(() => posts.value.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)));

  const hasPendingAssistantTurn = computed(() => {
    if (!selectedTopic.value?.robotMode || selectedTopic.value.robotMode === 'off') return false;
    if (interruptedTrace.value) return true;
    if (assistantDraft.value.trim()) return true;
    if (committedSegments.value.length > 0) return true;
    const activity = robotState.value?.activity ?? 'idle';
    return activity !== 'idle';
  });

  const totalPages = computed(() => {
    const timelineLength = sortedPosts.value.length + (hasPendingAssistantTurn.value ? 1 : 0);
    return Math.max(1, Math.ceil(timelineLength / POSTS_PER_PAGE));
  });

  const currentPosts = computed(() => {
    const start = (currentPage.value - 1) * POSTS_PER_PAGE;
    return sortedPosts.value.slice(start, start + POSTS_PER_PAGE);
  });

  const modelItems = computed<ModelInfoDto[]>(() => {
    const items = modelCatalog.value?.items ?? [];
    return items.length > 0 ? items : fallbackModelCatalog.items;
  });

  const modelIndex = computed(() => {
    const map = new Map<string, ModelInfoDto>();
    for (const item of modelItems.value) {
      if (!item?.id) continue;
      map.set(item.id.toLowerCase(), item);
    }
    return map;
  });

  const getModelInfo = (modelId: string | null | undefined): ModelInfoDto | null => {
    if (!modelId) return null;
    const key = modelId.trim().toLowerCase();
    const found = modelIndex.value.get(key);
    if (found) return found;
    return { id: modelId, family: 'echs', supportsReasoning: true, supportsTools: true };
  };

  const getModelFamily = (modelId: string | null | undefined): string => {
    return getModelInfo(modelId)?.family ?? 'unknown';
  };

  const modelSupportsReasoning = (modelId: string | null | undefined): boolean => {
    return getModelInfo(modelId)?.supportsReasoning ?? false;
  };

  const defaultModel = computed(() => {
    const catalogDefault =
      (modelCatalog.value as any)?.defaultModel ?? (modelCatalog.value as any)?.default_model ?? null;
    return catalogDefault || modelItems.value[0]?.id || null;
  });

  const modelReasoningOptions = (modelId: string | null | undefined): string[] => {
    const effectiveModel = modelId || defaultModel.value;
    const info = getModelInfo(effectiveModel);
    if (!info?.supportsReasoning) return [];
    const advertised = info.supportedThinkingLevels;
    if (!advertised?.length) return FORUM_REASONING_LEVELS.filter((level) => level !== 'max');
    const supported = new Set(advertised);
    return FORUM_REASONING_LEVELS.filter((level) => supported.has(level));
  };

  const allModelOptions = computed(() => modelItems.value.map((item) => item.id));

  const latestToolRun = computed(() => robotState.value?.recentToolRuns[0] ?? null);
  const isRobotBusy = computed(() => Boolean(robotState.value && !['idle', 'stopped'].includes(robotState.value.activity)));

  const isLoggedIn = computed(() => currentUser.value !== null);
  const isAdmin = computed(() => currentUser.value?.kind === 'admin');
  const canPublicRegister = computed(() => registrationSettings.value.publicRegistrationEnabled);
  const canInviteRegister = computed(() => registrationSettings.value.inviteRegistrationEnabled);
  const canShowRegisterLink = computed(() => registrationSettings.value.registrationEnabled);
  const canModerate = computed(() => {
    const kind = currentUser.value?.kind;
    if (kind === 'admin') return true;
    const permissions = currentPermissions.value;
    return (
      permissions.includes('*') ||
      permissions.includes('admin.all') ||
      permissions.includes('admin.write') ||
      permissions.includes('mod.all') ||
      permissions.includes('mod.sticky')
    );
  });

  async function loadCurrentPermissions(): Promise<void> {
    if (!currentUser.value) {
      currentPermissions.value = [];
      return;
    }
    try {
      const res = await api.getIdentityPermissions(currentUser.value.id);
      currentPermissions.value = res.permissions;
    } catch {
      currentPermissions.value = [];
    }
  }

  async function checkAuth(): Promise<void> {
    if (!getAuthToken()) {
      authChecked.value = true;
      currentPermissions.value = [];
      return;
    }
    try {
      const res = await api.me();
      currentUser.value = res.identity;
      if (res.identity) {
        const preferredTheme: ForumThemeKey = res.identity.theme ?? 'vmonika';
        setTheme(preferredTheme);
      }
      await loadCurrentPermissions();
      if (res.identity && !modelCatalogLoaded) {
        modelCatalogLoaded = true;
        void loadModelCatalog();
      }
    } catch (err) {
      const status = err instanceof Error && 'status' in err ? (err as Error & { status?: number }).status : undefined;
      if (status === 401) {
        setAuthToken(null);
        setRefreshToken(null);
        currentUser.value = null;
        currentPermissions.value = [];
      }
    }
    authChecked.value = true;
  }

  async function login(username: string, password: string): Promise<boolean> {
    try {
      const res = await api.login(username, password);
      if (res.token) {
        setAuthToken(res.token);
        setRefreshToken(res.refreshToken ?? null);
        await checkAuth();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // ignore errors
    }
    setAuthToken(null);
    setRefreshToken(null);
    currentUser.value = null;
    currentPermissions.value = [];
    modelCatalog.value = null;
    modelCatalogLoaded = false;
  }

  async function register(
    displayName: string,
    inviteCode?: string,
    username?: string,
    password?: string
  ): Promise<RegisterResponseDto> {
    const result = await api.register(displayName, inviteCode, username, password);
    // If we got a token, user is logged in directly
    if (result.token) {
      setAuthToken(result.token);
      setRefreshToken(result.refreshToken ?? null);
      currentUser.value = result.identity;
      setTheme(result.identity.theme ?? 'vmonika');
      await loadCurrentPermissions();
      if (!modelCatalogLoaded) {
        modelCatalogLoaded = true;
        void loadModelCatalog();
      }
    }
    return result;
  }

  async function verify(token: string): Promise<{ displayName: string }> {
    const result = await api.verify(token);
    setAuthToken(result.token);
    setRefreshToken(result.refreshToken ?? null);
    currentUser.value = result.identity;
    setTheme(result.identity.theme ?? 'vmonika');
    await loadCurrentPermissions();
    if (!modelCatalogLoaded) {
      modelCatalogLoaded = true;
      void loadModelCatalog();
    }
    return { displayName: result.identity.displayName };
  }

  async function checkInviteCode(code: string): Promise<boolean> {
    try {
      const result = await api.getInviteInfo(code);
      return result.valid;
    } catch {
      return false;
    }
  }

  async function updateProfile(
    identityId: string,
    updates: {
      displayName?: string;
      avatarUrl?: string;
      location?: string | null;
      signature?: string | null;
      theme?: ForumThemeKey | null;
    }
  ): Promise<void> {
    const updated = await api.updateIdentity(identityId, updates);
    const hasPrivateEmail = currentUser.value?.hasPrivateEmail ?? false;
    currentUser.value = {
      id: updated.id,
      displayName: updated.displayName,
      kind: updated.kind,
      avatarUrl: updated.avatarUrl ?? null,
      location: updated.location ?? null,
      signature: updated.signature ?? null,
      theme: updated.theme ?? null,
      hasPrivateEmail,
    };

    if (currentUser.value.theme) {
      setTheme(currentUser.value.theme);
    } else {
      setTheme('system');
    }
  }

  async function updatePrivateEmail(emailAddress: string | null): Promise<void> {
    if (!currentUser.value) return;
    const result = await api.updatePrivateEmail(emailAddress);
    currentUser.value = { ...currentUser.value, hasPrivateEmail: result.hasPrivateEmail };
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  function identityName(authorId: string): string {
    return identities.value[authorId]?.displayName ?? `User-${authorId.slice(0, 6)}`;
  }

  function topicStarterName(topic: TopicDto): string {
    return topic.createdByName ?? identityName(topic.createdBy);
  }

  function avatarFor(authorId: string): string {
    const identity = identities.value[authorId];
    if (!identity) return '/avatars/user.svg';
    if (identity.avatarUrl) return identity.avatarUrl;
    const name = identity.displayName.toLowerCase();
    if (identity.kind === 'robot' || name.includes('robot') || name.includes('codex')) {
      return '/avatars/monika.png';
    }
    if (name.includes('muse')) {
      return '/avatars/muse.webp';
    }
    if (name.includes('director')) {
      return '/avatars/director.webp';
    }
    return '/avatars/user.svg';
  }

  function isRobotPost(post: PostDto): boolean {
    return identities.value[post.authorId]?.kind === 'robot';
  }

  function isTopicLocked(): boolean {
    return selectedTopic.value?.status === 'locked' || selectedTopic.value?.status === 'archived';
  }

  function formatToolTime(iso?: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString();
  }

  async function loadRegistrationSettings(force = false): Promise<void> {
    if (registrationSettingsLoading.value) return;
    if (registrationSettingsLoaded && !force) return;
    registrationSettingsLoading.value = true;
    registrationSettingsError.value = null;
    try {
      registrationSettings.value = await api.registrationMode();
      registrationSettingsLoaded = true;
    } catch (err) {
      registrationSettingsError.value = err instanceof Error ? err.message : 'Failed to load registration settings.';
    } finally {
      registrationSettingsLoading.value = false;
    }
  }

  async function loadModelCatalog(force = false): Promise<void> {
    if (modelCatalogLoading.value) return;
    if (modelCatalog.value && !force) return;
    modelCatalogLoading.value = true;
    modelCatalogError.value = null;
    try {
      modelCatalog.value = await api.listModels();
    } catch (err) {
      modelCatalogError.value = err instanceof Error ? err.message : 'Failed to load models.';
    } finally {
      modelCatalogLoading.value = false;
    }
  }

  async function loadForums(params?: ListForumsParams): Promise<void> {
    const loadId = ++forumsLoadCounter;
    try {
      const nextForums = await api.listForums(params);
      if (loadId === forumsLoadCounter) forums.value = nextForums;
    } catch (err) {
      if (loadId === forumsLoadCounter) throw err;
    }
  }

  async function loadArchivedForums(): Promise<void> {
    const loadId = ++archivedForumsLoadCounter;
    try {
      const nextForums = await api.listForums({ status: 'archived', includeArchived: true });
      if (loadId === archivedForumsLoadCounter) archivedForums.value = nextForums;
    } catch (err) {
      if (loadId === archivedForumsLoadCounter) throw err;
    }
  }

  async function loadRecentPosts(limit = 3): Promise<void> {
    const loadId = ++recentPostsLoadCounter;
    try {
      const nextPosts = await api.listRecentPosts(limit);
      if (loadId === recentPostsLoadCounter) recentPosts.value = nextPosts;
    } catch (err) {
      if (loadId === recentPostsLoadCounter) throw err;
    }
  }

  async function loadForumLeaders(limit = 5): Promise<void> {
    forumLeadersLoading.value = true;
    forumLeadersError.value = null;
    try {
      const res = await api.listForumLeaders(limit);
      forumLeaders.value = res.leaders;
    } catch (err) {
      forumLeaders.value = [];
      forumLeadersError.value = err instanceof Error ? err.message : 'Failed to load forum leaders.';
    } finally {
      forumLeadersLoading.value = false;
    }
  }

  const selectedForum = computed(() => forums.value.find((f) => f.id === selectedForumId.value) ?? null);

  function selectForum(forumId: string): void {
    selectedForumId.value = forumId;
    topics.value = [];
  }

  function clearForum(): void {
    selectedForumId.value = null;
    topics.value = [];
  }

  function shouldReconstructTraceFromState(state: RobotStateDto | null): boolean {
    if (!state || state.activity === 'idle') return false;
    const assistantText = (state as any).assistantText ?? '';
    return Boolean(state.currentPlan || String(assistantText).trim());
  }

  /** Reconstruct committed segments from server state (for refresh/reconnect resilience). */
  function reconstructSegmentsFromState(state: RobotStateDto | null): void {
    if (!state) {
      reasoningDraft.value = '';
      assistantDraft.value = '';
      return;
    }
    const planSummary = state.currentPlan?.summary ?? '';
    const rCheckpoints = state.currentPlan?.reasoningCheckpoints ?? [];
    // assistantCheckpoints and assistantText come from live state emission
    const aCheckpoints = (state as any).assistantCheckpoints ?? [];
    const aFullText = (state as any).assistantText ?? '';
    const toolRuns = state.recentToolRuns.slice().reverse(); // oldest first

    // If no tools, just set the reasoning draft and assistant draft as tails
    if (toolRuns.length === 0) {
      reasoningDraft.value = planSummary;
      assistantDraft.value = aFullText;
      return;
    }

    const segments: TraceSegment[] = [];
    let rCursor = 0;
    let aCursor = 0;

    for (let t = 0; t < toolRuns.length; t++) {
      const rCp = rCheckpoints[t] ?? planSummary.length;
      const rSegment = planSummary.slice(rCursor, rCp).trim();
      if (rSegment) segments.push({ kind: 'reasoning', text: rSegment });
      rCursor = rCp;

      const aCp = aCheckpoints[t] ?? aFullText.length;
      const aSegment = aFullText.slice(aCursor, aCp).trim();
      if (aSegment) segments.push({ kind: 'assistant_text', text: aSegment });
      aCursor = aCp;

      const toolRun = toolRuns[t];
      if (toolRun) {
        segments.push({ kind: 'tool', toolRunId: toolRun.id });
      }
    }

    committedSegments.value = segments;
    // Set remaining text as the live tail
    reasoningDraft.value = planSummary.slice(rCursor);
    assistantDraft.value = aFullText.slice(aCursor);
  }

  function resetTopicState(): void {
    robotState.value = null;
    sessionContext.value = null;
    topicAutoRun.value = null;
    autoRunError.value = null;
    autoRunLoading.value = false;
    sessionInfo.value = null;
    sessionInspector.value = null;
    assistantDraft.value = '';
    reasoningDraft.value = '';
    activePlanId = null;
    resetRobotActivity();
  }

  function isActiveTopic(topicId: string): boolean {
    return selectedTopicId.value === topicId;
  }

  async function loadTopics(): Promise<void> {
    if (!selectedForumId.value) return;
    const res = await api.listTopics(selectedForumId.value, { page: 1, pageSize: desiredTopicsPageSize() });
    topics.value = sortTopicsByActivity(res.items);
  }

  async function loadPosts(topicId: string): Promise<void> {
    const res = await api.listPosts(topicId, { include: ['reactions'] });
    if (!isActiveTopic(topicId)) return;
    posts.value = res.items;
  }

  async function loadOperationalEvents(topicId: string): Promise<void> {
    try {
      const res = await operationalEventApi.listOperationalEvents(topicId);
      if (!isActiveTopic(topicId)) return;
      operationalEvents.value = Array.isArray(res.items) ? res.items : [];
    } catch {
      // Keep topic rendering compatible during rolling deploys where the forum
      // frontend may briefly precede the operational-events API.
      if (isActiveTopic(topicId)) operationalEvents.value = [];
    }
  }

  async function loadIdentities(topicId: string): Promise<void> {
    const res = await api.listIdentities(topicId);
    if (!isActiveTopic(topicId)) return;
    identities.value = res.items.reduce<Record<string, IdentityDto>>((acc, identity) => {
      acc[identity.id] = identity;
      return acc;
    }, {});
  }

  async function loadRobotPersonas(topicId: string): Promise<void> {
    const res = await api.listTopicPersonas(topicId);
    if (!isActiveTopic(topicId)) return;
    robotPersonas.value = res.items.reduce<Record<string, RobotPersonaDto>>((acc, persona) => {
      acc[persona.key] = persona;
      return acc;
    }, {});
  }

  async function loadState(topicId: string, opts: { reconstructTrace?: boolean } = {}): Promise<void> {
    const { reconstructTrace = true } = opts;
    const nextState = await api.getRobotState(topicId, { include: ['plan', 'toolRuns'] });
    if (!isActiveTopic(topicId)) return;
    const durableStop = isDurableStopBoundary(nextState?.activity);
    const preserveInterruptedTrace = durableStop && hasCurrentTrace();
    // Stop HTTP completion and reconnect hydration can return a durable stopped
    // state with no live plan. Freeze local buffered text before any state reset
    // so that sparse durable projection cannot erase the interrupted trace.
    if (preserveInterruptedTrace) freezeCurrentInterruptedTrace();
    robotState.value = nextState;
    sessionContext.value = retainSessionContext(sessionContext.value, nextState?.context);
    activePlanId = nextState?.currentPlan?.id ?? null;
    if (!preserveInterruptedTrace) resetRobotActivity();
    if (nextState) {
      syncToolActivity(nextState.recentToolRuns);
    }
    // Reconstruct committed segments from server-provided plan/checkpoints
    // so a page refresh shows the trace built so far. Completion reloads opt
    // out because assistant_message is authoritative and stale idle state may
    // still carry the just-finished plan/tool data.
    if (!preserveInterruptedTrace && reconstructTrace && shouldReconstructTraceFromState(nextState)) {
      reconstructSegmentsFromState(nextState);
    } else if (!preserveInterruptedTrace) {
      reasoningDraft.value = '';
      assistantDraft.value = '';
    }
    if (durableStop) freezeCurrentInterruptedTrace();
    syncReasoningActivity();
  }

  async function loadAutoRun(topicId: string): Promise<void> {
    autoRunLoading.value = true;
    autoRunError.value = null;
    try {
      const result = await api.getTopicAutoRun(topicId);
      if (!isActiveTopic(topicId)) return;
      topicAutoRun.value = result;
    } catch (err) {
      if (!isActiveTopic(topicId)) return;
      autoRunError.value = err instanceof Error ? err.message : 'Failed to load auto-run settings.';
      topicAutoRun.value = null;
    } finally {
      if (!isActiveTopic(topicId)) return;
      autoRunLoading.value = false;
    }
  }

  async function updateAutoRun(input: {
    enabled?: boolean;
    context?: string | null;
    worker?: 'echs';
    model?: string | null;
    reasoningEffort?: string | null;
    maxReplies?: number | null;
    resetCount?: boolean;
    steerMessage?: string | null;
  }): Promise<void> {
    if (!selectedTopicId.value) return;
    autoRunLoading.value = true;
    autoRunError.value = null;
    try {
      topicAutoRun.value = await api.updateTopicAutoRun(selectedTopicId.value, input);
    } catch (err) {
      autoRunError.value = err instanceof Error ? err.message : 'Failed to update auto-run settings.';
    } finally {
      autoRunLoading.value = false;
    }
  }

  async function runAutoRun(steerMessage?: string | null): Promise<void> {
    if (!selectedTopicId.value) return;
    autoRunLoading.value = true;
    autoRunError.value = null;
    try {
      await api.runTopicAutoRun(selectedTopicId.value, { steerMessage: steerMessage ?? null });
      await loadAutoRun(selectedTopicId.value);
    } catch (err) {
      autoRunError.value = err instanceof Error ? err.message : 'Failed to run auto-run director.';
    } finally {
      autoRunLoading.value = false;
    }
  }

  async function loadAttachmentsForPosts(postIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(postIds.filter(Boolean))];
    if (uniqueIds.length === 0) return;
    const topicId = selectedTopicId.value;
    if (!topicId) return;

    try {
      const result = await api.listTopicAttachments(topicId);
      if (selectedTopicId.value !== topicId) return;
      const next: Record<string, AttachmentDto[]> = { ...attachmentsByPost.value };
      for (const postId of uniqueIds) {
        next[postId] = result.itemsByPostId[postId] ?? [];
      }
      attachmentsByPost.value = next;
    } catch {
      if (selectedTopicId.value !== topicId) return;
      const next: Record<string, AttachmentDto[]> = { ...attachmentsByPost.value };
      for (const postId of uniqueIds) {
        next[postId] = [];
      }
      attachmentsByPost.value = next;
    }
  }

  async function loadSession(topicId: string): Promise<void> {
    if (!isAdmin.value) {
      sessionInfo.value = null;
      sessionInspector.value = null;
      return;
    }
    const result = await api.getSessionByTopic(topicId);
    if (!isActiveTopic(topicId)) return;
    sessionInfo.value = result;
    sessionInspector.value = null;
  }

  async function loadSessionInspector(): Promise<void> {
    if (!isAdmin.value) return;
    if (!sessionInfo.value) return;
    const topicId = selectedTopicId.value;
    if (!topicId) return;
    const result = await api.inspectSession(sessionInfo.value.id);
    if (selectedTopicId.value !== topicId) return;
    sessionInspector.value = result;
  }

  async function interruptRobot(): Promise<void> {
    const topicId = selectedTopicId.value;
    if (!topicId) return;
    robotControlPending.value = true;
    error.value = null;
    try {
      const result = await api.interruptRobot(topicId);
      // Navigation can finish while Stop is in flight. Never surface a result
      // from another topic in the newly selected topic's controls.
      if (!isInitiatingTopicCurrent(topicId, selectedTopicId.value)) return;
      robotStopResult.value = result;
      await loadState(topicId);
    } catch (err) {
      if (isInitiatingTopicCurrent(topicId, selectedTopicId.value)) {
        error.value = err instanceof Error ? err.message : 'Failed to interrupt robot.';
      }
    } finally {
      robotControlPending.value = false;
    }
  }

  function scheduleStreamFlush(): void {
    if (flushHandle !== null) return;
    flushHandle = window.requestAnimationFrame(() => {
      flushHandle = null;
      if (pendingReasoningDelta) {
        reasoningDraft.value += pendingReasoningDelta;
        pendingReasoningDelta = '';
        syncReasoningActivity();
      }
      if (pendingAssistantDelta) {
        assistantDraft.value += pendingAssistantDelta;
        pendingAssistantDelta = '';
      }
    });
  }

  function openStream(topicId: string): void {
    if (stream) {
      stream.close();
    }
    streamManuallyClosed = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stream = createStateStream(topicId);
    stream.addEventListener('open', () => {
      reconnectDelayMs = 2000;
    });
    stream.addEventListener('context_updated', (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as SessionContextDto;
      sessionContext.value = retainSessionContext(sessionContext.value, payload);
    });
    stream.addEventListener('state', (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as RobotStateDto;
      const durableStop = isDurableStopBoundary(payload.activity);
      const preserveInterruptedTrace = durableStop && hasCurrentTrace();
      if (preserveInterruptedTrace) freezeCurrentInterruptedTrace();
      robotState.value = payload;
      const nextPlanId = payload.currentPlan?.id ?? null;
      // The server clears currentPlan at the start of a new turn. Use that as a boundary so
      // we don't concatenate two different turns into one "reasoningDraft" blob. A durable
      // stopped boundary is different: its absent plan must not clear the trace being frozen.
      if (!preserveInterruptedTrace && activePlanId !== null && nextPlanId === null) {
        reasoningDraft.value = '';
        assistantDraft.value = '';
        resetRobotActivity();
      }
      activePlanId = nextPlanId;
      // Flush buffered reasoning before processing tools so checkpoints are accurate.
      flushPendingDeltas();
      syncToolActivity(payload.recentToolRuns);
      // If we have tool runs from the server but no committed segments yet
      // (reconnect/refresh mid-turn), reconstruct from server state.
      if (
        !preserveInterruptedTrace &&
        committedSegments.value.length === 0 &&
        payload.recentToolRuns.length > 0 &&
        shouldReconstructTraceFromState(payload)
      ) {
        reconstructSegmentsFromState(payload);
      }
      if (durableStop) freezeCurrentInterruptedTrace();
      syncReasoningActivity();
    });
    stream.addEventListener('tool_started', (event: MessageEvent<string>) => {
      // A new tool just started. Flush buffered deltas, then commit any
      // accumulated reasoning/assistant text as frozen segments. This is
      // the append-only model: committed segments never change once pushed.
      flushPendingDeltas();
      const payload = JSON.parse(event.data) as { toolRunId: string; tool?: string; callId?: string | null };
      const rText = reasoningDraft.value;
      if (rText) {
        committedSegments.value = [...committedSegments.value, { kind: 'reasoning', text: rText }];
        reasoningDraft.value = '';
        syncReasoningActivity();
      }
      const aText = assistantDraft.value;
      if (aText) {
        committedSegments.value = [...committedSegments.value, { kind: 'assistant_text', text: aText }];
        assistantDraft.value = '';
      }
      committedSegments.value = [...committedSegments.value, { kind: 'tool', toolRunId: payload.toolRunId }];
    });
    stream.addEventListener('reasoning_delta', (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as { delta: string };
      pendingReasoningDelta += payload.delta;
      scheduleStreamFlush();
    });
    stream.addEventListener('assistant_delta', (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as { delta: string };
      pendingAssistantDelta += payload.delta;
      scheduleStreamFlush();
    });
    stream.addEventListener('assistant_reset', (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as { reason?: string };
      flushPendingDeltas();
      if (payload.reason === 'interrupted') {
        // The same idempotent freeze path handles SSE delivery, direct HTTP
        // completion, hydration, and a reconnect that missed the reset event.
        freezeCurrentInterruptedTrace();
      } else {
        // New turn: clear everything for a fresh start.
        assistantDraft.value = '';
        reasoningDraft.value = '';
        pendingAssistantDelta = '';
        pendingReasoningDelta = '';
        activePlanId = null;
        liveTurnStartedAt = Date.now();
        interruptedTrace.value = false;
        robotStopResult.value = null;
        resetRobotActivity();
      }
    });
    stream.addEventListener('assistant_error', () => {
      if (isActiveTopic(topicId)) void loadOperationalEvents(topicId);
    });
    stream.addEventListener('operational_event', () => {
      if (isActiveTopic(topicId)) void loadOperationalEvents(topicId);
    });
    stream.addEventListener('assistant_message', () => {
      if (assistantMessagePending) return;
      assistantMessagePending = true;
      void handleAssistantMessage().finally(() => {
        assistantMessagePending = false;
      });
    });
    stream.addEventListener('error', () => {
      if (streamManuallyClosed || !selectedTopicId.value) {
        return;
      }
      if (stream) {
        stream.close();
        stream = null;
      }
      if (reconnectTimer) {
        return;
      }
      const currentTopicId = selectedTopicId.value;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
        void loadState(currentTopicId);
        openStream(currentTopicId);
      }, reconnectDelayMs);
    });
  }

  async function handleAssistantMessage(): Promise<void> {
    // Commit any remaining pending tail before clearing
    flushPendingDeltas();
    const rText = reasoningDraft.value;
    if (rText) {
      committedSegments.value = [...committedSegments.value, { kind: 'reasoning', text: rText }];
    }
    const aText = assistantDraft.value;
    if (aText) {
      committedSegments.value = [...committedSegments.value, { kind: 'assistant_text', text: aText }];
    }
    clearCompletedAssistantTurnTrace();
    if (selectedTopicId.value) {
      const topicId = selectedTopicId.value;
      await Promise.all([loadPosts(topicId), loadIdentities(topicId), loadRobotPersonas(topicId)]);
      await Promise.all([
        loadAttachmentsForPosts(posts.value.map((post) => post.id)),
        loadAutoRun(topicId),
        loadState(topicId, { reconstructTrace: false }),
        loadSessionInspector(),
      ]);
      if (!isActiveTopic(topicId)) return;
      // assistant_message is authoritative — the turn is done. A state reload
      // can race with server cleanup and still include the just-finished plan,
      // tool runs, assistant text, or non-idle activity. Keep the completed
      // reply in the post list and make the live trace disappear locally.
      clearCompletedAssistantTurnTrace();
      if (robotState.value) {
        robotState.value = { ...robotState.value, activity: 'idle' };
      }
    }
  }

  function closeStream(): void {
    if (stream) {
      stream.close();
      stream = null;
    }
    streamManuallyClosed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (flushHandle !== null) {
      window.cancelAnimationFrame(flushHandle);
      flushHandle = null;
    }
    pendingAssistantDelta = '';
    pendingReasoningDelta = '';
    assistantMessagePending = false;
    reconnectDelayMs = 2000;
  }

  async function selectTopic(topic: TopicDto, options?: { hydrateState?: boolean }): Promise<void> {
    if (selectedTopicId.value === topic.id) {
      return;
    }
    const loadId = ++topicLoadCounter;
    const hydrateState = options?.hydrateState ?? true;
    topicHydrationEnabled = hydrateState;
    robotStopResult.value = null;
    selectedTopic.value = topic;
    currentPage.value = 1;
    assistantDraft.value = '';
    reasoningDraft.value = '';
    interruptedTrace.value = false;
    activePlanId = null;
    liveTurnStartedAt = null;
    resetRobotActivity();
    closeStream();
    if (!hydrateState) {
      resetTopicState();
    }
    await Promise.all([loadPosts(topic.id), loadIdentities(topic.id), loadRobotPersonas(topic.id)]);
    // Operational events are an additive projection and must not delay core
    // topic/robot hydration when an older API or test fixture lacks the route.
    void loadOperationalEvents(topic.id);
    await loadAttachmentsForPosts(posts.value.map((post) => post.id));
    if (!isActiveTopic(topic.id) || loadId !== topicLoadCounter) {
      return;
    }
    if (hydrateState) {
      await Promise.all([loadState(topic.id), loadAutoRun(topic.id), loadSession(topic.id)]);
      await loadSessionInspector();
      if (isActiveTopic(topic.id) && loadId === topicLoadCounter) {
        openStream(topic.id);
      }
    }
  }

  async function selectTopicById(topicId: string, options?: { hydrateState?: boolean }): Promise<void> {
    if (selectedTopicId.value === topicId) {
      if (options?.hydrateState !== undefined && options.hydrateState !== topicHydrationEnabled) {
        topicHydrationEnabled = options.hydrateState;
        closeStream();
        if (!options.hydrateState) {
          resetTopicState();
          return;
        }
        const loadId = ++topicLoadCounter;
        await Promise.all([loadState(topicId), loadAutoRun(topicId), loadSession(topicId)]);
        await loadSessionInspector();
        if (isActiveTopic(topicId) && loadId === topicLoadCounter) {
          openStream(topicId);
        }
      }
      return;
    }
    const topic = await api.getTopic(topicId);
    await selectTopic(topic, options);
  }

  function clearTopic(): void {
    selectedTopic.value = null;
    posts.value = [];
    operationalEvents.value = [];
    identities.value = {};
    robotPersonas.value = {};
    sessionInfo.value = null;
    sessionInspector.value = null;
    attachmentsByPost.value = {};
    topicAutoRun.value = null;
    autoRunError.value = null;
    autoRunLoading.value = false;
    robotStopResult.value = null;
    assistantDraft.value = '';
    reasoningDraft.value = '';
    interruptedTrace.value = false;
    activePlanId = null;
    liveTurnStartedAt = null;
    resetRobotActivity();
    closeStream();
  }

  async function createTopic(
    title: string,
    body: string,
    options?: {
      model?: string;
      reasoningEffort?: string;
      attachmentsPending?: boolean;
      silent?: boolean;
      robotMode?: 'auto' | 'mention' | 'off';
      autoCompactEnabled?: boolean;
    }
  ): Promise<TopicDto> {
    if (!selectedForumId.value) {
      throw new Error('No forum selected');
    }
    loading.value = true;
    error.value = null;
    try {
      const payload: {
        title: string;
        body: string;
        model?: string | null;
        reasoningEffort?: string | null;
        robotMode?: 'auto' | 'mention' | 'off';
        autoCompactEnabled?: boolean;
        attachmentsPending?: boolean;
        silent?: boolean;
      } = {
        title,
        body,
      };
      if (options?.robotMode) {
        payload.robotMode = options.robotMode;
      }
      if (options?.autoCompactEnabled !== undefined) payload.autoCompactEnabled = options.autoCompactEnabled;
      if (options?.attachmentsPending) {
        payload.attachmentsPending = true;
      }
      if (options?.silent) {
        payload.silent = true;
      } else {
        if (options?.model !== undefined) payload.model = options.model ?? null;
        if (options?.reasoningEffort !== undefined) payload.reasoningEffort = options.reasoningEffort ?? null;
      }
      const topic = await api.createTopic(selectedForumId.value, payload);
      if (!options?.silent) {
        rememberReplyOptions(options);
      }
      await loadTopics();
      return topic;
    } finally {
      loading.value = false;
    }
  }

  async function createPost(
    body: string,
    options?: {
      model?: string;
      reasoningEffort?: string;
      autoCompactEnabled?: boolean;
      autoCompactRevision?: number;
      attachmentsPending?: boolean;
      silent?: boolean;
    }
  ): Promise<PostDto> {
    if (!selectedTopic.value) {
      throw new Error('No topic selected');
    }
    loading.value = true;
    error.value = null;
    try {
      const payload: {
        body: string;
        model?: string;
        reasoningEffort?: string;
        autoCompactEnabled?: boolean;
        autoCompactRevision?: number;
        attachmentsPending?: boolean;
        silent?: boolean;
      } = { body };
      if (options?.autoCompactEnabled !== undefined) payload.autoCompactEnabled = options.autoCompactEnabled;
      if (options?.autoCompactRevision !== undefined) payload.autoCompactRevision = options.autoCompactRevision;
      if (options?.attachmentsPending) {
        payload.attachmentsPending = true;
      }
      if (options?.silent) {
        payload.silent = true;
      } else {
        if (options?.model !== undefined) payload.model = options.model;
        if (options?.reasoningEffort !== undefined) payload.reasoningEffort = options.reasoningEffort;
      }
      const topicId = selectedTopic.value.id;
      const priorAutoCompactEnabled = selectedTopic.value.autoCompactEnabled;
      const post = await api.createPost(topicId, payload);
      if (options?.autoCompactEnabled !== undefined && options.autoCompactEnabled !== priorAutoCompactEnabled) {
        const currentTopic = selectedTopic.value;
        if (currentTopic) {
          selectedTopic.value = {
            ...currentTopic,
            autoCompactEnabled: options.autoCompactEnabled,
            autoCompactRevision: currentTopic.autoCompactRevision + 1,
          };
        }
        void api
          .getTopic(topicId)
          .then((topic) => {
            if (selectedTopic.value?.id === topicId) selectedTopic.value = topic;
          })
          .catch(() => {});
      }
      if (!options?.silent) {
        rememberReplyOptions(options);
      }
      await Promise.all([
        loadPosts(selectedTopic.value.id),
        loadIdentities(selectedTopic.value.id),
        loadRobotPersonas(selectedTopic.value.id),
      ]);
      await loadAttachmentsForPosts(posts.value.map((post) => post.id));
      return post;
    } finally {
      loading.value = false;
    }
  }

  async function updatePost(postId: string, body: string): Promise<PostDto> {
    loading.value = true;
    error.value = null;
    try {
      const post = await api.updatePost(postId, { body });
      if (selectedTopic.value) {
        await loadPosts(selectedTopic.value.id);
        await loadAttachmentsForPosts(posts.value.map((post) => post.id));
      }
      return post;
    } finally {
      loading.value = false;
    }
  }

  async function deletePost(postId: string): Promise<PostDto> {
    loading.value = true;
    error.value = null;
    try {
      const post = await api.deletePost(postId);
      if (selectedTopic.value) {
        await loadPosts(selectedTopic.value.id);
        await loadAttachmentsForPosts(posts.value.map((post) => post.id));
      }
      return post;
    } finally {
      loading.value = false;
    }
  }

  async function dispatchPost(postId: string, options?: { model?: string; reasoningEffort?: string }): Promise<void> {
    await api.dispatchPost(postId, {
      model: options?.model ?? null,
      reasoningEffort: options?.reasoningEffort ?? null,
    });
  }

  async function updateTopicTitle(title: string): Promise<TopicDto> {
    if (!selectedTopic.value) {
      throw new Error('No topic selected');
    }
    loading.value = true;
    error.value = null;
    try {
      const topic = await api.updateTopicTitle(selectedTopic.value.id, title);
      selectedTopic.value = topic;
      await loadTopics();
      return topic;
    } finally {
      loading.value = false;
    }
  }

  async function updateTopicStatus(status: 'open' | 'locked' | 'archived'): Promise<TopicDto> {
    if (!selectedTopic.value) {
      throw new Error('No topic selected');
    }
    loading.value = true;
    error.value = null;
    try {
      const topic = await api.updateTopicStatus(selectedTopic.value.id, status);
      selectedTopic.value = topic;
      await loadTopics();
      return topic;
    } finally {
      loading.value = false;
    }
  }

  async function updateTopicSticky(sticky: boolean): Promise<TopicDto> {
    if (!selectedTopic.value) {
      throw new Error('No topic selected');
    }
    loading.value = true;
    error.value = null;
    try {
      const topic = await api.updateTopicSticky(selectedTopic.value.id, sticky);
      selectedTopic.value = topic;
      await loadTopics();
      return topic;
    } finally {
      loading.value = false;
    }
  }

  async function moveTopicToForum(forumId: string, opts?: { silent?: boolean }): Promise<TopicDto> {
    if (!selectedTopic.value) {
      throw new Error('No topic selected');
    }
    loading.value = true;
    error.value = null;
    try {
      const result = await api.moveTopic(selectedTopic.value.id, forumId, opts);
      selectedTopic.value = result.topic;
      await loadTopics();
      await loadPosts(result.topic.id);
      await loadIdentities(result.topic.id);
      await loadRobotPersonas(result.topic.id);
      await loadState(result.topic.id);
      await loadSession(result.topic.id);
      return result.topic;
    } finally {
      loading.value = false;
    }
  }

  async function deleteTopic(): Promise<void> {
    if (!selectedTopic.value) {
      throw new Error('No topic selected');
    }
    loading.value = true;
    error.value = null;
    try {
      await api.deleteTopic(selectedTopic.value.id);
      clearTopic();
      await loadTopics();
    } finally {
      loading.value = false;
    }
  }

  async function listPostAttachments(postId: string): Promise<AttachmentDto[]> {
    const items = await api.listPostAttachments(postId);
    attachmentsByPost.value = { ...attachmentsByPost.value, [postId]: items };
    return items;
  }

  async function uploadAttachment(postId: string, file: File): Promise<AttachmentDto> {
    loading.value = true;
    error.value = null;
    try {
      const attachment = await api.uploadPostAttachment(postId, file);
      const existing = attachmentsByPost.value[postId] ?? [];
      attachmentsByPost.value = { ...attachmentsByPost.value, [postId]: [...existing, attachment] };
      return attachment;
    } finally {
      loading.value = false;
    }
  }

  async function deleteAttachment(attachmentId: string, postId?: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await api.deleteAttachment(attachmentId);
      if (postId) {
        const existing = attachmentsByPost.value[postId] ?? [];
        attachmentsByPost.value = {
          ...attachmentsByPost.value,
          [postId]: existing.filter((item) => item.id !== attachmentId),
        };
      }
    } finally {
      loading.value = false;
    }
  }

  async function generatePostTts(postId: string): Promise<AttachmentDto> {
    loading.value = true;
    error.value = null;
    try {
      const attachment = await api.generatePostTts(postId);
      const existing = attachmentsByPost.value[postId] ?? [];
      const already = existing.find((item) => item.id === attachment.id);
      attachmentsByPost.value = {
        ...attachmentsByPost.value,
        [postId]: already ? existing : [...existing, attachment],
      };
      return attachment;
    } finally {
      loading.value = false;
    }
  }

  function setError(msg: string): void {
    error.value = msg;
  }

  function clearError(): void {
    error.value = null;
  }

  function setPage(page: number): void {
    currentPage.value = page;
  }

  function openLoginModal(): void {
    showLoginModal.value = true;
  }

  function closeLoginModal(): void {
    showLoginModal.value = false;
  }

  function setDateFilter(filter: string): void {
    // Keep this defensive because the UI is user-controlled and we don't want invalid
    // values to poison state.
    if (filter === 'day' || filter === '2days' || filter === 'week' || filter === 'beginning') {
      dateFilter.value = filter;
      return;
    }
    dateFilter.value = 'beginning';
  }

  function desiredTopicsPageSize(): number {
    const count = selectedForum.value?.threadCount ?? 50;
    // Don't request an unbounded page size, but do make the default large enough that
    // “missing threads” isn't a regular occurrence for small/medium forums.
    return Math.max(50, Math.min(500, Math.trunc(count)));
  }

  async function loadTopicsWithFilter(): Promise<void> {
    if (!selectedForumId.value) return;
    // Calculate date from filter
    let since: string | undefined;
    const now = new Date();
    switch (dateFilter.value) {
      case 'day':
        since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        break;
      case '2days':
        since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case 'week':
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case 'beginning':
        since = undefined;
        break;
    }
    const res = await api.listTopics(selectedForumId.value, {
      ...(since ? { since } : {}),
      page: 1,
      pageSize: desiredTopicsPageSize(),
    });
    topics.value = sortTopicsByActivity(res.items);
  }

  function rememberReplyOptions(options?: { model?: string | null; reasoningEffort?: string | null }): void {
    if (!options) return;
    if (options.model) {
      lastReplyModel.value = options.model;
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(LAST_REPLY_MODEL_KEY, options.model);
        } catch {
          // Ignore storage errors
        }
      }
    }
    if (options.reasoningEffort) {
      lastReplyReasoning.value = options.reasoningEffort;
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(LAST_REPLY_REASONING_KEY, options.reasoningEffort);
        } catch {
          // Ignore storage errors
        }
      }
    }
  }

  return {
    // State
    forums,
    archivedForums,
    topics,
    selectedForumId,
    selectedForum,
    selectedTopic,
    selectedTopicId,
    posts,
    operationalEvents,
    recentPosts,
    forumLeaders,
    forumLeadersLoading,
    forumLeadersError,
    identities,
    robotPersonas,
    robotState,
    sessionContext,
    topicAutoRun,
    autoRunLoading,
    autoRunError,
    reasoningDraft,
    assistantDraft,
    reasoningSteps,
    committedSegments,
    interruptedTrace,
    activityLog,
    sessionInfo,
    sessionInspector,
    robotControlPending,
    robotStopResult,
    loading,
    error,
    currentPage,
    POSTS_PER_PAGE,
    currentUser,
    currentPermissions,
    authChecked,
    showLoginModal,
    dateFilter,
    attachmentsByPost,
    lastReplyModel,
    lastReplyReasoning,
    modelCatalog,
    modelCatalogLoading,
    modelCatalogError,
    registrationSettings,
    registrationSettingsLoading,
    registrationSettingsError,

    // Computed
    sortedPosts,
    totalPages,
    currentPosts,
    hasPendingAssistantTurn,
    latestToolRun,
    isRobotBusy,
    isLoggedIn,
    canPublicRegister,
    canInviteRegister,
    canShowRegisterLink,
    canModerate,
    modelItems,
    modelSupportsReasoning,
    modelReasoningOptions,
    defaultModel,
    allModelOptions,
    getModelInfo,
    getModelFamily,

    // Helpers
    formatDate,
    identityName,
    topicStarterName,
    avatarFor,
    isRobotPost,
    isTopicLocked,
    formatToolTime,

    // Actions
    selectForum,
    clearForum,
    loadForums,
    loadArchivedForums,
    loadRecentPosts,
    loadForumLeaders,
    loadTopics,
    loadPosts,
    loadOperationalEvents,
    loadIdentities,
    loadRobotPersonas,
    loadState,
    loadAutoRun,
    loadSession,
    loadSessionInspector,
    loadRegistrationSettings,
    loadModelCatalog,
    interruptRobot,
    updateAutoRun,
    runAutoRun,
    loadAttachmentsForPosts,
    selectTopic,
    selectTopicById,
    clearTopic,
    createTopic,
    createPost,
    dispatchPost,
    updatePost,
    deletePost,
    listPostAttachments,
    uploadAttachment,
    deleteAttachment,
    generatePostTts,
    updateTopicTitle,
    updateTopicStatus,
    updateTopicSticky,
    moveTopicToForum,
    deleteTopic,
    setError,
    clearError,
    setPage,
    closeStream,
    checkAuth,
    login,
    logout,
    register,
    verify,
    checkInviteCode,
    updateProfile,
    updatePrivateEmail,
    openLoginModal,
    closeLoginModal,
    setDateFilter,
    loadTopicsWithFilter,
    rememberReplyOptions,
  };
}
