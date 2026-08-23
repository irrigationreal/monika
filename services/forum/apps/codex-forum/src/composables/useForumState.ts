import { computed, ref } from 'vue';

import { api, createStateStream } from '../lib/apiClient';
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
  TopicAutoRunDto,
  TopicDto,
  TopicOperationalEventDto,
  TopicTraceDto,
} from '../lib/apiClient';

export type TraceSegment = { kind: 'reasoning'; text: string } | { kind: 'tool'; toolRunId: string };

export function freezeInterruptedTextSegments(segments: TraceSegment[], reasoning: string): TraceSegment[] {
  const frozen = [...segments];
  if (reasoning) frozen.push({ kind: 'reasoning', text: reasoning });
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
const committedSegments = ref<TraceSegment[]>([]);
/** True when the response was interrupted — keeps the trace visible as frozen. */
const interruptedTrace = ref(false);

const sessionInfo = ref<SessionDto | null>(null);
const topicTrace = ref<TopicTraceDto | null>(null);
const adminEnrichmentLoading = ref(false);
const adminEnrichmentError = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const currentPage = ref(1);
const POSTS_PER_PAGE = 8;
const attachmentsByPost = ref<Record<string, AttachmentDto[]>>({});
const lastReplyModel = ref<string | null>(null);
const lastReplyReasoning = ref<string | null>(null);
const fallbackModelCatalog: ModelCatalogDto = {
  items: [
    {
      id: 'gpt-5.2',
      family: 'echs',
      supportsReasoning: true,
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      supportsTools: true,
      contextWindowTokens: 200000,
    },
  ],
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
  passwordLoginEnabled: false,
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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 2000;
let streamManuallyClosed = false;
let streamGeneration = 0;
let activeTopicGeneration = 0;
let liveStateRevision = 0;
let pendingReasoningDelta = '';
let flushHandle: number | null = null;
let assistantMessageReloadOwner: number | null = null;
let assistantMessageReloadRevision = 0;
let assistantMessageReloadQueued = false;
let topicLoadCounter = 0;
let topicSelectionRequestCounter = 0;
let forumsLoadCounter = 0;
let archivedForumsLoadCounter = 0;
let recentPostsLoadCounter = 0;
let topicHydrationEnabled = true;
let adminEnrichmentLoadCounter = 0;
// --- Committed segments (append-only trace model) ---
// No longer using client-side checkpoints for trace interleaving.
// Instead, tool_started events flush pending drafts into committedSegments.

function resetRobotActivity(): void {
  committedSegments.value = [];
}

function clearCompletedAssistantTurnTrace(): void {
  reasoningDraft.value = '';
  pendingReasoningDelta = '';
  interruptedTrace.value = false;
  robotStopResult.value = null;
  activePlanId = null;
  resetRobotActivity();
}

/** Flush buffered reasoning before a synchronous tool boundary commit. */
function flushPendingDeltas(): void {
  if (pendingReasoningDelta) {
    reasoningDraft.value += pendingReasoningDelta;
    pendingReasoningDelta = '';
  }
  if (flushHandle !== null) {
    window.cancelAnimationFrame(flushHandle);
    flushHandle = null;
  }
}

function freezeCurrentInterruptedTrace(): void {
  flushPendingDeltas();
  committedSegments.value = freezeInterruptedTextSegments(committedSegments.value, reasoningDraft.value);
  reasoningDraft.value = '';
  pendingReasoningDelta = '';
  activePlanId = null;
  interruptedTrace.value = true;
}

function hasCurrentTrace(): boolean {
  return (
    interruptedTrace.value ||
    committedSegments.value.length > 0 ||
    Boolean(reasoningDraft.value || pendingReasoningDelta)
  );
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
    const activity = robotState.value?.activity ?? 'idle';
    return activity !== 'idle' && activity !== 'stopped' && activity !== 'error';
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
  const isRobotBusy = computed(() =>
    Boolean(robotState.value && !['idle', 'stopped'].includes(robotState.value.activity))
  );

  const isLoggedIn = computed(() => currentUser.value !== null);
  const isAdmin = computed(() => currentUser.value?.kind === 'admin');
  const canPublicRegister = computed(() => registrationSettings.value.publicRegistrationEnabled);
  const canInviteRegister = computed(() => registrationSettings.value.inviteRegistrationEnabled);
  const canShowRegisterLink = computed(() => registrationSettings.value.registrationEnabled);
  const passwordLoginEnabled = computed(() => registrationSettings.value.passwordLoginEnabled);
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
        currentUser.value = null;
        currentPermissions.value = [];
      }
    }
    authChecked.value = true;
  }

  async function login(username: string, password: string): Promise<boolean> {
    try {
      const res = await api.login(username, password);
      if (!res.identity) return false;
      await checkAuth();
      return true;
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
    // Invite registration creates a cookie session; public registration waits for verification.
    if (result.identity && username && password) {
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
      quickReplyDesktopMode: currentUser.value?.quickReplyDesktopMode ?? null,
      quickReplyMobileMode: currentUser.value?.quickReplyMobileMode ?? null,
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

  async function updateQuickReplyPreference(preferences: {
    desktopMode: 'inline' | 'docked';
    mobileMode: 'inline' | 'docked';
  }): Promise<void> {
    if (!currentUser.value) return;
    const result = await api.updateQuickReplyPreference(preferences);
    currentUser.value = {
      ...currentUser.value,
      quickReplyDesktopMode: result.desktopMode,
      quickReplyMobileMode: result.mobileMode,
    };
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
    return Boolean(state && state.activity !== 'idle' && state.currentPlan);
  }

  /** Reconstruct reasoning/tool segments from server state after refresh or reconnect. */
  function reconstructSegmentsFromState(state: RobotStateDto | null): void {
    if (!state) {
      reasoningDraft.value = '';
      return;
    }
    const planSummary = state.currentPlan?.summary ?? '';
    const checkpoints = state.currentPlan?.reasoningCheckpoints ?? [];
    const toolRuns = state.recentToolRuns.slice().reverse();
    if (toolRuns.length === 0) {
      reasoningDraft.value = planSummary;
      return;
    }
    const segments: TraceSegment[] = [];
    let cursor = 0;
    for (let index = 0; index < toolRuns.length; index += 1) {
      const checkpoint = checkpoints[index] ?? planSummary.length;
      const reasoning = planSummary.slice(cursor, checkpoint).trim();
      if (reasoning) segments.push({ kind: 'reasoning', text: reasoning });
      cursor = checkpoint;
      const tool = toolRuns[index];
      if (tool) segments.push({ kind: 'tool', toolRunId: tool.id });
    }
    committedSegments.value = segments;
    reasoningDraft.value = planSummary.slice(cursor);
  }

  function resetSessionInspectorState(): void {
    adminEnrichmentLoadCounter += 1;
    topicTrace.value = null;
    adminEnrichmentLoading.value = false;
    adminEnrichmentError.value = null;
  }

  function resetTopicState(): void {
    robotState.value = null;
    sessionContext.value = null;
    topicAutoRun.value = null;
    autoRunError.value = null;
    autoRunLoading.value = false;
    sessionInfo.value = null;
    resetSessionInspectorState();
    robotStopResult.value = null;
    reasoningDraft.value = '';
    interruptedTrace.value = false;
    activePlanId = null;
    resetRobotActivity();
  }

  function resetTopicProjection(): void {
    activeTopicGeneration += 1;
    selectedTopic.value = null;
    posts.value = [];
    operationalEvents.value = [];
    identities.value = {};
    robotPersonas.value = {};
    attachmentsByPost.value = {};
    currentPage.value = 1;
    resetTopicState();
  }

  function isActiveTopic(topicId: string): boolean {
    return selectedTopicId.value === topicId;
  }

  function isActiveTopicGeneration(topicId: string, generation: number): boolean {
    return activeTopicGeneration === generation && isActiveTopic(topicId);
  }

  async function loadTopics(): Promise<void> {
    if (!selectedForumId.value) return;
    const res = await api.listTopics(selectedForumId.value, { page: 1, pageSize: desiredTopicsPageSize() });
    topics.value = sortTopicsByActivity(res.items);
  }

  async function loadPosts(topicId: string): Promise<void> {
    const generation = activeTopicGeneration;
    // TopicView paginates this collection client-side, so load the complete
    // canonical sequence. The former API default of 200 broke permalinks to
    // later posts (including links from User Files).
    const res = await api.listPosts(topicId, { page: 1, pageSize: 100_000, include: ['reactions'] });
    if (!isActiveTopicGeneration(topicId, generation)) return;
    posts.value = res.items;
  }

  async function loadOperationalEvents(topicId: string): Promise<void> {
    const generation = activeTopicGeneration;
    try {
      const res = await operationalEventApi.listOperationalEvents(topicId);
      if (!isActiveTopicGeneration(topicId, generation)) return;
      operationalEvents.value = Array.isArray(res.items) ? res.items : [];
    } catch {
      // Keep topic rendering compatible during rolling deploys where the forum
      // frontend may briefly precede the operational-events API.
      if (isActiveTopicGeneration(topicId, generation)) operationalEvents.value = [];
    }
  }

  async function loadIdentities(topicId: string): Promise<void> {
    const generation = activeTopicGeneration;
    const res = await api.listIdentities(topicId);
    if (!isActiveTopicGeneration(topicId, generation)) return;
    identities.value = res.items.reduce<Record<string, IdentityDto>>((acc, identity) => {
      acc[identity.id] = identity;
      return acc;
    }, {});
  }

  async function loadRobotPersonas(topicId: string): Promise<void> {
    const generation = activeTopicGeneration;
    const res = await api.listTopicPersonas(topicId);
    if (!isActiveTopicGeneration(topicId, generation)) return;
    robotPersonas.value = res.items.reduce<Record<string, RobotPersonaDto>>((acc, persona) => {
      acc[persona.key] = persona;
      return acc;
    }, {});
  }

  async function loadState(
    topicId: string,
    opts: { reconstructTrace?: boolean; expectedLiveStateRevision?: number } = {}
  ): Promise<void> {
    const generation = activeTopicGeneration;
    const revision = opts.expectedLiveStateRevision ?? liveStateRevision;
    const { reconstructTrace = true } = opts;
    const nextState = await api.getRobotState(topicId, { include: ['plan', 'toolRuns'] });
    // An SSE event received after this snapshot began is newer than the HTTP
    // response, even when both belong to the same topic generation.
    if (!isActiveTopicGeneration(topicId, generation) || liveStateRevision !== revision) return;
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
    // Reconstruct committed segments from server-provided plan/checkpoints
    // so a page refresh shows the trace built so far. Completion reloads opt
    // out because assistant_message is authoritative and stale idle state may
    // still carry the just-finished plan/tool data.
    if (!preserveInterruptedTrace && reconstructTrace && shouldReconstructTraceFromState(nextState)) {
      reconstructSegmentsFromState(nextState);
    } else if (!preserveInterruptedTrace) {
      reasoningDraft.value = '';
    }
    if (durableStop) freezeCurrentInterruptedTrace();
  }

  async function loadAutoRun(topicId: string): Promise<void> {
    const generation = activeTopicGeneration;
    autoRunLoading.value = true;
    autoRunError.value = null;
    try {
      const result = await api.getTopicAutoRun(topicId);
      if (!isActiveTopicGeneration(topicId, generation)) return;
      topicAutoRun.value = result;
    } catch (err) {
      if (!isActiveTopicGeneration(topicId, generation)) return;
      autoRunError.value = err instanceof Error ? err.message : 'Failed to load auto-run settings.';
      topicAutoRun.value = null;
    } finally {
      if (!isActiveTopicGeneration(topicId, generation)) return;
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
    const generation = activeTopicGeneration;
    if (!topicId) return;

    try {
      const result = await api.listTopicAttachments(topicId);
      if (!isActiveTopicGeneration(topicId, generation)) return;
      const next: Record<string, AttachmentDto[]> = { ...attachmentsByPost.value };
      for (const postId of uniqueIds) {
        next[postId] = result.itemsByPostId[postId] ?? [];
      }
      attachmentsByPost.value = next;
    } catch {
      if (!isActiveTopicGeneration(topicId, generation)) return;
      const next: Record<string, AttachmentDto[]> = { ...attachmentsByPost.value };
      for (const postId of uniqueIds) {
        next[postId] = [];
      }
      attachmentsByPost.value = next;
    }
  }

  async function loadAdminEnrichment(topicId = selectedTopicId.value): Promise<void> {
    const loadId = ++adminEnrichmentLoadCounter;
    const generation = activeTopicGeneration;
    if (!isAdmin.value || !topicId) {
      sessionInfo.value = null;
      topicTrace.value = null;
      adminEnrichmentLoading.value = false;
      adminEnrichmentError.value = null;
      return;
    }
    adminEnrichmentLoading.value = true;
    adminEnrichmentError.value = null;
    try {
      const [session, trace] = await Promise.all([api.getSessionByTopic(topicId), api.getTopicTrace(topicId)]);
      if (loadId !== adminEnrichmentLoadCounter || !isActiveTopicGeneration(topicId, generation)) return;
      sessionInfo.value = session;
      topicTrace.value = trace;
    } catch (err) {
      if (loadId !== adminEnrichmentLoadCounter || !isActiveTopicGeneration(topicId, generation)) return;
      adminEnrichmentError.value = err instanceof Error ? err.message : 'Failed to load admin diagnostics.';
    } finally {
      if (loadId === adminEnrichmentLoadCounter && isActiveTopicGeneration(topicId, generation)) {
        adminEnrichmentLoading.value = false;
      }
    }
  }

  async function interruptRobot(): Promise<void> {
    const topicId = selectedTopicId.value;
    const generation = activeTopicGeneration;
    if (!topicId) return;
    robotControlPending.value = true;
    error.value = null;
    try {
      const result = await api.interruptRobot(topicId);
      // Navigation can finish while Stop is in flight. Never surface a result
      // from another selection generation in the newly selected topic's controls.
      if (!isActiveTopicGeneration(topicId, generation)) return;
      robotStopResult.value = result;
      await loadState(topicId);
      if (isActiveTopicGeneration(topicId, generation)) void loadAdminEnrichment(topicId);
    } catch (err) {
      if (isActiveTopicGeneration(topicId, generation)) {
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
      }
    });
  }

  function openStream(topicId: string): void {
    if (stream) stream.close();
    streamManuallyClosed = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const connectionGeneration = ++streamGeneration;
    const topicGeneration = activeTopicGeneration;
    const nextStream = createStateStream(topicId);
    stream = nextStream;
    const isCurrentConnection = (): boolean =>
      stream === nextStream &&
      streamGeneration === connectionGeneration &&
      isActiveTopicGeneration(topicId, topicGeneration);
    const isCurrentGeneration = (): boolean =>
      streamGeneration === connectionGeneration && isActiveTopicGeneration(topicId, topicGeneration);

    nextStream.addEventListener('open', () => {
      if (!isCurrentConnection()) return;
      reconnectDelayMs = 2000;
    });
    nextStream.addEventListener('context_updated', (event: MessageEvent<string>) => {
      if (!isCurrentConnection()) return;
      liveStateRevision += 1;
      const payload = JSON.parse(event.data) as SessionContextDto;
      sessionContext.value = retainSessionContext(sessionContext.value, payload);
    });
    nextStream.addEventListener('state', (event: MessageEvent<string>) => {
      if (!isCurrentConnection()) return;
      liveStateRevision += 1;
      const payload = JSON.parse(event.data) as RobotStateDto;
      const durableStop = isDurableStopBoundary(payload.activity);
      const newlyStopped = durableStop && !interruptedTrace.value;
      const preserveInterruptedTrace = durableStop && hasCurrentTrace();
      if (preserveInterruptedTrace) freezeCurrentInterruptedTrace();
      robotState.value = payload;
      const nextPlanId = payload.currentPlan?.id ?? null;
      // The server clears currentPlan at the start of a new turn. Use that as a boundary so
      // we don't concatenate two different turns into one "reasoningDraft" blob. A durable
      // stopped boundary is different: its absent plan must not clear the trace being frozen.
      if (!preserveInterruptedTrace && activePlanId !== null && nextPlanId === null) {
        reasoningDraft.value = '';
        resetRobotActivity();
      }
      activePlanId = nextPlanId;
      // Flush buffered reasoning before processing tools so checkpoints are accurate.
      flushPendingDeltas();
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
      if (newlyStopped) void loadAdminEnrichment(topicId);
    });
    nextStream.addEventListener('tool_started', (event: MessageEvent<string>) => {
      if (!isCurrentConnection()) return;
      liveStateRevision += 1;
      // A new tool just started. Flush buffered reasoning, then commit it
      // before the tool boundary. Committed segments never move.
      flushPendingDeltas();
      const payload = JSON.parse(event.data) as { toolRunId: string; tool?: string; callId?: string | null };
      const rText = reasoningDraft.value;
      if (rText) {
        committedSegments.value = [...committedSegments.value, { kind: 'reasoning', text: rText }];
        reasoningDraft.value = '';
      }
      committedSegments.value = [...committedSegments.value, { kind: 'tool', toolRunId: payload.toolRunId }];
    });
    nextStream.addEventListener('reasoning_delta', (event: MessageEvent<string>) => {
      if (!isCurrentConnection()) return;
      liveStateRevision += 1;
      const payload = JSON.parse(event.data) as { delta: string };
      pendingReasoningDelta += payload.delta;
      scheduleStreamFlush();
    });
    nextStream.addEventListener('assistant_reset', (event: MessageEvent<string>) => {
      if (!isCurrentConnection()) return;
      liveStateRevision += 1;
      const payload = JSON.parse(event.data) as { reason?: string };
      flushPendingDeltas();
      if (payload.reason === 'interrupted') {
        // The same idempotent freeze path handles SSE delivery, direct HTTP
        // completion, hydration, and a reconnect that missed the reset event.
        freezeCurrentInterruptedTrace();
      } else {
        // New turn: clear everything for a fresh start.
        reasoningDraft.value = '';
        pendingReasoningDelta = '';
        activePlanId = null;
        interruptedTrace.value = false;
        robotStopResult.value = null;
        resetRobotActivity();
      }
    });
    nextStream.addEventListener('assistant_error', () => {
      if (!isCurrentConnection()) return;
      void loadOperationalEvents(topicId);
    });
    nextStream.addEventListener('operational_event', () => {
      if (!isCurrentConnection()) return;
      void loadOperationalEvents(topicId);
    });
    nextStream.addEventListener('assistant_message', () => {
      if (!isCurrentConnection()) return;
      liveStateRevision += 1;
      // A single Pi settlement may publish multiple canonical assistant items.
      // Coalesce bursts for this connection, but never let an old topic's
      // completion reload whichever topic happens to be selected later.
      assistantMessageReloadRevision = liveStateRevision;
      assistantMessageReloadQueued = true;
      if (assistantMessageReloadOwner === connectionGeneration) return;
      assistantMessageReloadOwner = connectionGeneration;
      void drainAssistantMessageReloads(topicId, connectionGeneration, topicGeneration).finally(() => {
        if (assistantMessageReloadOwner === connectionGeneration) assistantMessageReloadOwner = null;
      });
    });
    nextStream.addEventListener('error', () => {
      if (streamManuallyClosed || !isCurrentConnection()) return;
      nextStream.close();
      if (stream === nextStream) stream = null;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!isCurrentGeneration()) return;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
        void loadState(topicId).then(
          () => {
            if (isCurrentGeneration()) openStream(topicId);
          },
          () => {
            if (isCurrentGeneration()) openStream(topicId);
          }
        );
      }, reconnectDelayMs);
    });
  }

  async function drainAssistantMessageReloads(
    topicId: string,
    connectionGeneration: number,
    topicGeneration: number
  ): Promise<void> {
    while (
      assistantMessageReloadQueued &&
      streamGeneration === connectionGeneration &&
      isActiveTopicGeneration(topicId, topicGeneration)
    ) {
      assistantMessageReloadQueued = false;
      const messageRevision = assistantMessageReloadRevision;
      await handleAssistantMessage(topicId, connectionGeneration, topicGeneration, messageRevision);
    }
  }

  async function handleAssistantMessage(
    topicId: string,
    connectionGeneration: number,
    topicGeneration: number,
    messageRevision: number
  ): Promise<void> {
    if (streamGeneration !== connectionGeneration || !isActiveTopicGeneration(topicId, topicGeneration)) return;
    // The canonical item is now represented by a post. Clear its live trace,
    // but retain the server's activity until a later state/turn-completed
    // boundary says the whole agent run is idle.
    flushPendingDeltas();
    clearCompletedAssistantTurnTrace();
    await Promise.all([loadPosts(topicId), loadIdentities(topicId), loadRobotPersonas(topicId)]);
    if (streamGeneration !== connectionGeneration || !isActiveTopicGeneration(topicId, topicGeneration)) return;
    await Promise.all([
      loadAttachmentsForPosts(posts.value.map((post) => post.id)),
      loadAutoRun(topicId),
      loadState(topicId, { reconstructTrace: false, expectedLiveStateRevision: messageRevision }),
    ]);
    if (streamGeneration !== connectionGeneration || !isActiveTopicGeneration(topicId, topicGeneration)) return;
    void loadAdminEnrichment(topicId);
  }

  function closeStream(): void {
    streamGeneration += 1;
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
    pendingReasoningDelta = '';
    assistantMessageReloadOwner = null;
    assistantMessageReloadQueued = false;
    reconnectDelayMs = 2000;
  }

  async function selectTopic(topic: TopicDto, options?: { hydrateState?: boolean }): Promise<void> {
    // A direct selection supersedes any topic fetch still pending in selectTopicById.
    topicSelectionRequestCounter += 1;
    if (selectedTopicId.value === topic.id) return;
    const loadId = ++topicLoadCounter;
    const hydrateState = options?.hydrateState ?? true;
    topicHydrationEnabled = hydrateState;
    closeStream();
    resetTopicProjection();
    selectedTopic.value = topic;
    await Promise.all([loadPosts(topic.id), loadIdentities(topic.id), loadRobotPersonas(topic.id)]);
    // Operational events are an additive projection and must not delay core
    // topic/robot hydration when an older API or test fixture lacks the route.
    void loadOperationalEvents(topic.id);
    await loadAttachmentsForPosts(posts.value.map((post) => post.id));
    if (!isActiveTopic(topic.id) || loadId !== topicLoadCounter) {
      return;
    }
    if (hydrateState) {
      if (isAdmin.value) adminEnrichmentLoading.value = true;
      try {
        await Promise.all([loadState(topic.id), loadAutoRun(topic.id)]);
      } catch (err) {
        if (isActiveTopic(topic.id) && loadId === topicLoadCounter) adminEnrichmentLoading.value = false;
        throw err;
      }
      if (isActiveTopic(topic.id) && loadId === topicLoadCounter) {
        openStream(topic.id);
        void loadAdminEnrichment(topic.id);
      }
    }
  }

  async function selectTopicById(topicId: string, options?: { hydrateState?: boolean }): Promise<void> {
    const requestId = ++topicSelectionRequestCounter;
    if (selectedTopicId.value === topicId) {
      if (options?.hydrateState !== undefined && options.hydrateState !== topicHydrationEnabled) {
        topicHydrationEnabled = options.hydrateState;
        closeStream();
        activeTopicGeneration += 1;
        if (!options.hydrateState) {
          resetTopicState();
          return;
        }
        const loadId = ++topicLoadCounter;
        if (isAdmin.value) adminEnrichmentLoading.value = true;
        try {
          await Promise.all([loadState(topicId), loadAutoRun(topicId)]);
        } catch (err) {
          if (requestId === topicSelectionRequestCounter && isActiveTopic(topicId) && loadId === topicLoadCounter) {
            adminEnrichmentLoading.value = false;
          }
          throw err;
        }
        if (requestId === topicSelectionRequestCounter && isActiveTopic(topicId) && loadId === topicLoadCounter) {
          openStream(topicId);
          void loadAdminEnrichment(topicId);
        }
      } else if (topicHydrationEnabled) {
        openStream(topicId);
      }
      return;
    }
    // Route changes reuse TopicView and this singleton store. Relinquish the
    // previous topic before fetching the next record so no old post, activity,
    // or trace can render beneath the destination URL while hydration runs.
    topicLoadCounter += 1;
    closeStream();
    resetTopicProjection();
    let topic: TopicDto;
    try {
      topic = await api.getTopic(topicId);
    } catch (err) {
      if (requestId !== topicSelectionRequestCounter) return;
      throw err;
    }
    if (requestId !== topicSelectionRequestCounter) return;
    await selectTopic(topic, options);
  }

  function clearTopic(): void {
    topicSelectionRequestCounter += 1;
    topicLoadCounter += 1;
    closeStream();
    resetTopicProjection();
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
      draft?: { id: string; revision: number };
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
        draft?: { id: string; revision: number };
      } = {
        title,
        body,
      };
      if (options?.draft) payload.draft = options.draft;
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
      try {
        await loadTopics();
      } catch {
        // Publication already committed; a projection refresh failure must not make the composer resubmit it.
      }
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
      draft?: { id: string; revision: number };
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
        draft?: { id: string; revision: number };
      } = { body };
      if (options?.draft) payload.draft = options.draft;
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
      try {
        await Promise.all([loadPosts(topicId), loadIdentities(topicId), loadRobotPersonas(topicId)]);
        await loadAttachmentsForPosts(posts.value.map((item) => item.id));
      } catch {
        // Publication already committed; a projection refresh failure must not make the composer resubmit it.
      }
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
      void loadAdminEnrichment(result.topic.id);
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
          [postId]: existing.map((item) =>
            item.id === attachmentId ? { ...item, deletedAt: new Date().toISOString() } : item
          ),
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
    committedSegments,
    interruptedTrace,
    sessionInfo,
    topicTrace,
    adminEnrichmentLoading,
    adminEnrichmentError,
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
    passwordLoginEnabled,
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
    loadAdminEnrichment,
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
    updateQuickReplyPreference,
    openLoginModal,
    closeLoginModal,
    setDateFilter,
    loadTopicsWithFilter,
    rememberReplyOptions,
  };
}
