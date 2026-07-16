<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useForumState } from '../composables/useForumState';
import {
  api,
  type ForumDto,
  type DiscordBridgeStatus,
  type MatrixBridgeStatus,
  type AdminUserDto,
  type InviteDto,
  type AdminForumDto,
  type AdminSkillDto,
  type AdminSkillListResponseDto,
  type AdminSkillRootDto,
  type AdminDeployStatus,
  type PiSyncHealth,
  type RobotAutomationDto,
  type RobotAutomationRunDto,
  type AdminRobotPersonaDto,
  type TamperConfigDto,
  type TamperPluginDto,
  type TamperTestResultDto
} from '../lib/apiClient';

const router = useRouter();
const state = useForumState();

// Tab state
const activeTab = ref<
  | 'forums'
  | 'personas'
  | 'skills'
  | 'users'
  | 'invites'
  | 'discord'
  | 'matrix'
  | 'deploy'
  | 'sync'
  | 'robots'
  | 'tampers'
>('forums');

// Forums list
const forums = ref<ForumDto[]>([]);
const loadingForums = ref(false);

// Discord state
const discordStatus = ref<DiscordBridgeStatus | null>(null);
const discordLoading = ref(false);
const discordError = ref('');
const discordToken = ref('');
const discordGuildId = ref('');
const discordConnecting = ref(false);

// Discord mapping form
const discordChannelId = ref('');
const discordForumId = ref('');
const discordMappingError = ref('');
const discordMapping = ref(false);

// Matrix state
const matrixStatus = ref<MatrixBridgeStatus | null>(null);
const matrixLoading = ref(false);
const matrixError = ref('');
const matrixHomeserverUrl = ref('');
const matrixAccessToken = ref('');
const matrixUserId = ref('');
const matrixConnecting = ref(false);

// Matrix mapping form
const matrixRoomId = ref('');
const matrixForumId = ref('');
const matrixMappingError = ref('');
const matrixMapping = ref(false);

// Users state
const users = ref<AdminUserDto[]>([]);
const loadingUsers = ref(false);
const usersError = ref('');
// Create user form
const newUserDisplayName = ref('');
const newUserUsername = ref('');
const newUserPassword = ref('');
const newUserKind = ref('human');
const creatingUser = ref(false);
// Edit user modal
const editingUser = ref<AdminUserDto | null>(null);
const editUserDisplayName = ref('');
const editUserKind = ref('');
const editUserPassword = ref('');
const savingUser = ref(false);
// Delete confirmation
const deletingUserId = ref<string | null>(null);

// Invites state
const invites = ref<InviteDto[]>([]);
const loadingInvites = ref(false);
const invitesError = ref('');
// Create invite form
const newInviteMaxUses = ref(1);
const newInviteExpiresInDays = ref(7);
const creatingInvite = ref(false);
// Delete confirmation
const deletingInviteId = ref<string | null>(null);

// Admin Forums state
const adminForums = ref<AdminForumDto[]>([]);
const loadingAdminForums = ref(false);
const adminForumsError = ref('');
// Create forum form
const newForumName = ref('');
const newForumDescription = ref('');
const newForumCwd = ref('');
const newForumPrePrompt = ref('');
const newForumPrePromptEnabled = ref(false);
const newForumPrePromptTemplateKey = ref('');
const newForumParentId = ref<string | null>(null);
const newForumCategory = ref('');
const newForumStatus = ref<'active' | 'archived'>('active');
const newForumVisibility = ref<'public' | 'members' | 'admin'>('public');
const creatingForum = ref(false);
// Edit forum modal
const editingForum = ref<AdminForumDto | null>(null);
const editForumName = ref('');
const editForumDescription = ref('');
const editForumCwd = ref('');
const editForumPrePrompt = ref('');
const editForumPrePromptEnabled = ref(false);
const editForumPrePromptTemplateKey = ref('');
const editForumParentId = ref<string | null>(null);
const editForumCategory = ref('');
const editForumStatus = ref<'active' | 'archived'>('active');
const editForumVisibility = ref<'public' | 'members' | 'admin'>('public');
const savingForum = ref(false);
// Delete confirmation
const deletingForumId = ref<string | null>(null);

// Deploy state
const deployStatus = ref<AdminDeployStatus | null>(null);
const deployLoading = ref(false);
const deployError = ref('');
const deployMessage = ref('');
const deployTriggering = ref(false);

// Pi sync health state
const piSyncHealth = ref<PiSyncHealth | null>(null);
const piSyncLoading = ref(false);
const piSyncAction = ref(false);
const piSyncError = ref('');
const piSyncMessage = ref('');

// Robot Settings state
const robotSettings = ref({ maxConcurrentTurns: 10, activeTurnsCount: 0 });

// Robot Automations state
const robotAutomations = ref<RobotAutomationDto[]>([]);
const loadingRobotAutomations = ref(false);
const robotAutomationsError = ref('');
// Create automation form
const newAutomationName = ref('');
const newAutomationForumId = ref('');
const newAutomationPrompt = ref('');
const newAutomationEnabled = ref(true);
const newAutomationWorker = ref<'echs'>('echs');
const newAutomationModel = ref('');
const newAutomationReasoningEffort = ref('medium');
const newAutomationRunMode = ref<'manual' | 'interval'>('manual');
const newAutomationIntervalMinutes = ref(60);
const creatingAutomation = ref(false);
const automationModels = computed(() => state.allModelOptions.value);
const newAutomationModelOptions = computed(() => {
  return [
    { value: '', label: 'Default' },
    ...automationModels.value.map((model) => ({ value: model, label: model }))
  ];
});
const showNewAutomationReasoning = computed(() => state.modelSupportsReasoning(newAutomationModel.value));
const newAutomationReasoningOptions = computed(() => state.modelReasoningOptions(newAutomationModel.value));
// Edit automation modal
const editingAutomation = ref<RobotAutomationDto | null>(null);
const editAutomationName = ref('');
const editAutomationForumId = ref('');
const editAutomationPrompt = ref('');
const editAutomationEnabled = ref(true);
const editAutomationWorker = ref<'echs'>('echs');
const editAutomationModel = ref('');
const editAutomationReasoningEffort = ref('');
const editAutomationRunMode = ref<'manual' | 'interval'>('manual');
const editAutomationIntervalMinutes = ref<number | null>(null);
const savingAutomation = ref(false);
const deletingAutomationId = ref<string | null>(null);
const runningAutomationId = ref<string | null>(null);
const automationRuns = ref<RobotAutomationRunDto[]>([]);
const loadingAutomationRuns = ref(false);
const runsAutomationId = ref<string | null>(null);
const selectedAutomationRunId = ref<string | null>(null);
const automationLogContent = ref('');
const automationLogOffset = ref(0);
const automationLogLoading = ref(false);
const automationLogError = ref('');
const automationLogPolling = ref<number | null>(null);
const selectedAutomationRun = computed(() =>
  automationRuns.value.find((run) => run.id === selectedAutomationRunId.value) ?? null
);
const editAutomationModelOptions = computed(() => {
  return [
    { value: '', label: 'Default' },
    ...automationModels.value.map((model) => ({ value: model, label: model }))
  ];
});
const showEditAutomationReasoning = computed(() => state.modelSupportsReasoning(editAutomationModel.value));
const editAutomationReasoningOptions = computed(() => state.modelReasoningOptions(editAutomationModel.value));

// Tamper layer state
const tamperPlugins = ref<TamperPluginDto[]>([]);
const tamperConfigs = ref<TamperConfigDto[]>([]);
const loadingTamperPlugins = ref(false);
const loadingTamperConfigs = ref(false);
const tamperError = ref('');
const tamperConfigForumId = ref<string | null>(null);
const tamperConfigPluginKey = ref('');
const tamperConfigEnabled = ref(true);
const tamperConfigPriority = ref(0);
const tamperConfigDirection = ref<'inbound' | 'outbound' | 'both'>('outbound');
const tamperConfigOnlyFirstMessage = ref(false);
const tamperConfigEnhancerTrigger = ref('[[gather]]');
const tamperConfigEnhancerStripTrigger = ref(true);
const tamperConfigEnhancerMaxDocs = ref(8);
const tamperConfigEnhancerPerKindLimit = ref(4);
const tamperConfigEnhancerMaxPrefaceChars = ref(2200);
const tamperConfigEnhancerSkillsRoot = ref('/root/work/skills');
const tamperConfigEnhancerKbRoot = ref('/root/work/kb');
const creatingTamperConfig = ref(false);

const editingTamperConfig = ref<TamperConfigDto | null>(null);
const editTamperForumId = ref<string | null>(null);
const editTamperEnabled = ref(true);
const editTamperPriority = ref(0);
const editTamperDirection = ref<'inbound' | 'outbound' | 'both'>('outbound');
const editTamperOnlyFirstMessage = ref(false);
const editTamperEnhancerTrigger = ref('[[gather]]');
const editTamperEnhancerStripTrigger = ref(true);
const editTamperEnhancerMaxDocs = ref(8);
const editTamperEnhancerPerKindLimit = ref(4);
const editTamperEnhancerMaxPrefaceChars = ref(2200);
const editTamperEnhancerSkillsRoot = ref('/root/work/skills');
const editTamperEnhancerKbRoot = ref('/root/work/kb');
const savingTamperConfig = ref(false);
const deletingTamperConfigId = ref<string | null>(null);

const tamperTestText = ref('');
const tamperTestForumId = ref<string | null>(null);
const tamperTestStage = ref<'inbound.user_to_codex' | 'outbound.codex_to_forum' | 'outbound.forum_post_body'>('outbound.codex_to_forum');
const tamperTestDirection = ref<'inbound' | 'outbound'>('outbound');
const tamperTestIsFirstMessage = ref(true);
const tamperTestPluginKey = ref('');
const tamperTestEnhancerTrigger = ref('[[gather]]');
const tamperTestEnhancerOnlyFirst = ref(true);
const tamperTestEnhancerStripTrigger = ref(true);
const tamperTestEnhancerMaxDocs = ref(8);
const tamperTestEnhancerPerKindLimit = ref(4);
const tamperTestEnhancerMaxPrefaceChars = ref(2200);
const tamperTestEnhancerSkillsRoot = ref('/root/work/skills');
const tamperTestEnhancerKbRoot = ref('/root/work/kb');
const tamperTestOnlyPlugin = ref(true);
const tamperTestResult = ref<TamperTestResultDto | null>(null);
const tamperTesting = ref(false);

const DEFAULT_PROMPT_ENHANCER_TRIGGER = '[[gather]]';
const DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT = '/root/work/skills';
const DEFAULT_PROMPT_ENHANCER_KB_ROOT = '/root/work/kb';

const prePromptTemplates: { key: string; label: string; body: string }[] = [
  {
    key: 'coding',
    label: 'Coding / Repo work (strict)',
    body: [
      'You are operating in a software engineering forum.',
      'Prefer minimal, targeted changes.',
      'When you propose code changes, include file paths and the exact commands to run.',
      'If you are unsure, ask 1–2 clarifying questions before acting.',
      'Do not invent APIs or dependencies that are not present in the repository.'
    ].join('\n')
  },
  {
    key: 'support',
    label: 'Support / Customer service',
    body: [
      'You are responding as a helpful support agent.',
      'Ask clarifying questions when needed and propose step-by-step troubleshooting.',
      'Avoid jargon; keep responses friendly and structured.',
      'If a request is impossible, explain why and offer alternatives.'
    ].join('\n')
  },
  {
    key: 'concise',
    label: 'Ultra concise',
    body: [
      'Be extremely concise.',
      'Prefer bullets over paragraphs.',
      'Do not repeat the user’s question back to them.',
      'If you need info, ask a single direct question.'
    ].join('\n')
  }
];

function getTemplateBody(key: string): string | null {
  const t = prePromptTemplates.find((x) => x.key === key);
  return t?.body ?? null;
}

function setPrePromptEnabled(target: 'new' | 'edit', enabled: boolean): void {
  if (target === 'new') {
    newForumPrePromptEnabled.value = enabled;
    if (!enabled) newForumPrePromptTemplateKey.value = '';
    return;
  }
  editForumPrePromptEnabled.value = enabled;
  if (!enabled) editForumPrePromptTemplateKey.value = '';
}

function onNewForumPrePromptEnabledChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  setPrePromptEnabled('new', target.checked);
}

function onEditForumPrePromptEnabledChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  setPrePromptEnabled('edit', target.checked);
}

function applyPrePromptTemplate(target: 'new' | 'edit', mode: 'replace' | 'append'): void {
  const key = target === 'new' ? newForumPrePromptTemplateKey.value : editForumPrePromptTemplateKey.value;
  const template = getTemplateBody(key);
  if (!template) return;

  if (target === 'new') {
    setPrePromptEnabled('new', true);
    newForumPrePrompt.value =
      mode === 'replace'
        ? template
        : [newForumPrePrompt.value.trim(), template].filter(Boolean).join('\n\n');
    return;
  }

  setPrePromptEnabled('edit', true);
  editForumPrePrompt.value =
    mode === 'replace'
      ? template
      : [editForumPrePrompt.value.trim(), template].filter(Boolean).join('\n\n');
}

function clearPrePrompt(target: 'new' | 'edit'): void {
  if (target === 'new') {
    newForumPrePrompt.value = '';
    newForumPrePromptTemplateKey.value = '';
    newForumPrePromptEnabled.value = false;
    return;
  }
  editForumPrePrompt.value = '';
  editForumPrePromptTemplateKey.value = '';
  editForumPrePromptEnabled.value = false;
}

// Robot Personas (Admin)
const personaForumId = ref<string>('');
const personas = ref<AdminRobotPersonaDto[]>([]);
const loadingPersonas = ref(false);
const personasError = ref('');

// Skills (Admin)
const adminSkills = ref<AdminSkillDto[]>([]);
const adminSkillRoots = ref<AdminSkillRootDto[]>([]);
const adminSkillsMeta = ref<Pick<
  AdminSkillListResponseDto,
  'generatedAt' | 'promptEnhancerEnabledByDefault' | 'defaultSkillsRoot'
> | null>(null);
const loadingAdminSkills = ref(false);
const adminSkillsError = ref('');
const adminSkillsQuery = ref('');
const adminSkillsHideSystem = ref(true);
const adminSkillsOnlyUsed = ref(false);

// Create persona form
const newPersonaKey = ref('');
const newPersonaDisplayName = ref('');
const newPersonaDescription = ref('');
const newPersonaAccentColor = ref('');
const newPersonaAvatarUrl = ref('');
const newPersonaSignature = ref('');
const newPersonaSoul = ref('');
const creatingPersona = ref(false);

// Edit persona modal
const editingPersona = ref<AdminRobotPersonaDto | null>(null);
const editPersonaKey = ref('');
const editPersonaDisplayName = ref('');
const editPersonaDescription = ref('');
const editPersonaAccentColor = ref('');
const editPersonaAvatarUrl = ref('');
const editPersonaSignature = ref('');
const editPersonaSoul = ref('');
const savingPersona = ref(false);
const deletingPersonaKey = ref<string | null>(null);

const currentUser = computed(() => state.currentUser.value);
const isAdmin = computed(() => currentUser.value?.kind === 'admin');
const forumNameById = computed(() => {
  const map = new Map<string, string>();
  forums.value.forEach((forum) => {
    map.set(forum.id, forum.name);
  });
  return map;
});

watch([activeTab, personaForumId], async ([tab]) => {
  if (tab === 'personas') {
    await loadPersonas();
  }
});

watch(activeTab, async (tab) => {
  if (tab === 'skills') {
    await loadAdminSkills();
  }
  if (tab === 'tampers') {
    await loadTamperPlugins();
    await loadTamperConfigs();
  }
  if (tab === 'robots') {
    await loadRobotSettings();
  }
  if (tab === 'sync') {
    await loadPiSyncHealth();
  }
});

watch(tamperConfigPluginKey, (pluginKey) => {
  if (!pluginKey) return;
  tamperConfigDirection.value = resolveDefaultTamperDirection(pluginKey);
  tamperConfigOnlyFirstMessage.value = resolveDefaultTamperOnlyFirstMessage(pluginKey);
});

// Load forums (for dropdowns)
async function loadForums(): Promise<void> {
  loadingForums.value = true;
  try {
    forums.value = await api.listForums({ includeArchived: true });
  } catch (err) {
    console.error('Failed to load forums:', err);
  } finally {
    loadingForums.value = false;
  }
}

// Admin Forum functions
async function loadAdminForums(): Promise<void> {
  loadingAdminForums.value = true;
  adminForumsError.value = '';
  try {
    const response = await api.listAdminForums();
    adminForums.value = response.items;
  } catch (err) {
    adminForumsError.value = err instanceof Error ? err.message : 'Failed to load forums';
  } finally {
    loadingAdminForums.value = false;
  }
}

async function loadPersonas(): Promise<void> {
  if (!personaForumId.value) {
    personas.value = [];
    return;
  }
  loadingPersonas.value = true;
  personasError.value = '';
  try {
    const res = await api.listAdminForumPersonas(personaForumId.value);
    personas.value = res.items;
  } catch (err) {
    personasError.value = err instanceof Error ? err.message : 'Failed to load personas';
  } finally {
    loadingPersonas.value = false;
  }
}

async function createPersona(): Promise<void> {
  if (!personaForumId.value) {
    personasError.value = 'Select a forum first.';
    return;
  }
  if (!newPersonaKey.value.trim() || !newPersonaDisplayName.value.trim()) {
    personasError.value = 'Persona key and display name are required.';
    return;
  }
  creatingPersona.value = true;
  personasError.value = '';
  try {
    await api.createAdminForumPersona(personaForumId.value, {
      key: newPersonaKey.value.trim(),
      displayName: newPersonaDisplayName.value.trim(),
      description: newPersonaDescription.value.trim() || null,
      accentColor: newPersonaAccentColor.value.trim() || null,
      avatarUrl: newPersonaAvatarUrl.value.trim() || null,
      signature: newPersonaSignature.value.trim() || null,
      soul: newPersonaSoul.value.trim() || null
    });
    newPersonaKey.value = '';
    newPersonaDisplayName.value = '';
    newPersonaDescription.value = '';
    newPersonaAccentColor.value = '';
    newPersonaAvatarUrl.value = '';
    newPersonaSignature.value = '';
    newPersonaSoul.value = '';
    await loadPersonas();
  } catch (err) {
    personasError.value = err instanceof Error ? err.message : 'Failed to create persona';
  } finally {
    creatingPersona.value = false;
  }
}

function openEditPersona(persona: AdminRobotPersonaDto): void {
  editingPersona.value = persona;
  editPersonaKey.value = persona.key;
  editPersonaDisplayName.value = persona.displayName;
  editPersonaDescription.value = persona.description ?? '';
  editPersonaAccentColor.value = persona.accentColor ?? '';
  editPersonaAvatarUrl.value = persona.avatarUrl ?? '';
  editPersonaSignature.value = persona.signature ?? '';
  editPersonaSoul.value = persona.soul ?? '';
}

function closeEditPersona(): void {
  editingPersona.value = null;
  editPersonaKey.value = '';
  editPersonaDisplayName.value = '';
  editPersonaDescription.value = '';
  editPersonaAccentColor.value = '';
  editPersonaAvatarUrl.value = '';
  editPersonaSignature.value = '';
  editPersonaSoul.value = '';
}

async function savePersonaEdit(): Promise<void> {
  if (!personaForumId.value || !editingPersona.value) return;
  savingPersona.value = true;
  personasError.value = '';
  try {
    const updates: {
      displayName?: string;
      description?: string | null;
      accentColor?: string | null;
      avatarUrl?: string | null;
      signature?: string | null;
      soul?: string | null;
    } = {
      description: editPersonaDescription.value.trim() || null,
      accentColor: editPersonaAccentColor.value.trim() || null,
      avatarUrl: editPersonaAvatarUrl.value.trim() || null,
      signature: editPersonaSignature.value.trim() || null,
      soul: editPersonaSoul.value.trim() || null
    };
    const displayName = editPersonaDisplayName.value.trim();
    if (displayName) {
      updates.displayName = displayName;
    }
    await api.updateAdminForumPersona(personaForumId.value, editingPersona.value.key, updates);
    closeEditPersona();
    await loadPersonas();
  } catch (err) {
    personasError.value = err instanceof Error ? err.message : 'Failed to update persona';
  } finally {
    savingPersona.value = false;
  }
}

async function deletePersona(key: string): Promise<void> {
  if (!personaForumId.value) return;
  deletingPersonaKey.value = key;
  personasError.value = '';
  try {
    await api.deleteAdminForumPersona(personaForumId.value, key);
    await loadPersonas();
  } catch (err) {
    personasError.value = err instanceof Error ? err.message : 'Failed to delete persona';
  } finally {
    deletingPersonaKey.value = null;
  }
}

async function createForum(): Promise<void> {
  if (!newForumName.value.trim()) {
    adminForumsError.value = 'Forum name is required.';
    return;
  }
  creatingForum.value = true;
  adminForumsError.value = '';
  try {
    await api.createAdminForum({
      name: newForumName.value.trim(),
      description: newForumDescription.value.trim() || null,
      cwd: newForumCwd.value.trim() || null,
      prePrompt: newForumPrePromptEnabled.value ? newForumPrePrompt.value.trim() || null : null,
      parentForumId: newForumParentId.value ?? null,
      category: newForumCategory.value.trim() || null,
      status: newForumStatus.value,
      visibility: newForumVisibility.value
    });
    newForumName.value = '';
    newForumDescription.value = '';
    newForumCwd.value = '';
    newForumPrePrompt.value = '';
    newForumPrePromptEnabled.value = false;
    newForumPrePromptTemplateKey.value = '';
    newForumParentId.value = null;
    newForumCategory.value = '';
    newForumStatus.value = 'active';
    newForumVisibility.value = 'public';
    await loadAdminForums();
    await loadForums(); // Refresh dropdown list too
  } catch (err) {
    adminForumsError.value = err instanceof Error ? err.message : 'Failed to create forum';
  } finally {
    creatingForum.value = false;
  }
}

function openEditForum(forum: AdminForumDto): void {
  editingForum.value = forum;
  editForumName.value = forum.name;
  editForumDescription.value = forum.description ?? '';
  editForumCwd.value = forum.cwd ?? '';
  editForumPrePrompt.value = forum.prePrompt ?? '';
  editForumPrePromptEnabled.value = Boolean(forum.prePrompt?.trim());
  editForumPrePromptTemplateKey.value = '';
  editForumParentId.value = forum.parentForumId ?? null;
  editForumCategory.value = forum.category ?? '';
  editForumStatus.value = forum.status ?? 'active';
  editForumVisibility.value = forum.visibility ?? 'public';
}

function closeEditForum(): void {
  editingForum.value = null;
  editForumName.value = '';
  editForumDescription.value = '';
  editForumCwd.value = '';
  editForumPrePrompt.value = '';
  editForumPrePromptEnabled.value = false;
  editForumPrePromptTemplateKey.value = '';
  editForumParentId.value = null;
  editForumCategory.value = '';
  editForumStatus.value = 'active';
  editForumVisibility.value = 'public';
}

async function saveForumEdit(): Promise<void> {
  if (!editingForum.value) return;
  if (!editForumName.value.trim()) {
    adminForumsError.value = 'Forum name is required.';
    return;
  }
  savingForum.value = true;
  adminForumsError.value = '';
  try {
    await api.updateAdminForum(editingForum.value.id, {
      name: editForumName.value.trim(),
      description: editForumDescription.value.trim() || null,
      cwd: editForumCwd.value.trim() || null,
      prePrompt: editForumPrePromptEnabled.value ? editForumPrePrompt.value.trim() || null : null,
      parentForumId: editForumParentId.value ?? null,
      category: editForumCategory.value.trim() || null,
      status: editForumStatus.value,
      visibility: editForumVisibility.value
    });
    closeEditForum();
    await loadAdminForums();
    await loadForums();
  } catch (err) {
    adminForumsError.value = err instanceof Error ? err.message : 'Failed to update forum';
  } finally {
    savingForum.value = false;
  }
}

async function deleteForum(forumId: string): Promise<void> {
  adminForumsError.value = '';
  try {
    await api.deleteAdminForum(forumId);
    deletingForumId.value = null;
    await loadAdminForums();
    await loadForums();
  } catch (err) {
    adminForumsError.value = err instanceof Error ? err.message : 'Failed to delete forum';
    deletingForumId.value = null;
  }
}

async function toggleForumArchive(forum: AdminForumDto): Promise<void> {
  adminForumsError.value = '';
  try {
    const nextStatus = forum.status === 'archived' ? 'active' : 'archived';
    await api.updateAdminForum(forum.id, {
      status: nextStatus,
      archivedAt: nextStatus === 'archived' ? new Date().toISOString() : null
    });
    await loadAdminForums();
    await loadForums();
  } catch (err) {
    adminForumsError.value = err instanceof Error ? err.message : 'Failed to update forum status';
  }
}

// User functions
async function loadUsers(): Promise<void> {
  loadingUsers.value = true;
  usersError.value = '';
  try {
    const response = await api.listUsers();
    users.value = response.items;
  } catch (err) {
    usersError.value = err instanceof Error ? err.message : 'Failed to load users';
  } finally {
    loadingUsers.value = false;
  }
}

async function createUser(): Promise<void> {
  if (!newUserDisplayName.value.trim()) {
    usersError.value = 'Display name is required.';
    return;
  }
  creatingUser.value = true;
  usersError.value = '';
  try {
    const input: { displayName: string; username?: string; password?: string; kind?: string } = {
      displayName: newUserDisplayName.value.trim(),
      kind: newUserKind.value
    };
    if (newUserUsername.value.trim()) {
      input.username = newUserUsername.value.trim();
    }
    if (newUserPassword.value) {
      input.password = newUserPassword.value;
    }
    await api.createUser(input);
    newUserDisplayName.value = '';
    newUserUsername.value = '';
    newUserPassword.value = '';
    newUserKind.value = 'human';
    await loadUsers();
  } catch (err) {
    usersError.value = err instanceof Error ? err.message : 'Failed to create user';
  } finally {
    creatingUser.value = false;
  }
}

function openEditUser(user: AdminUserDto): void {
  editingUser.value = user;
  editUserDisplayName.value = user.displayName;
  editUserKind.value = user.kind;
  editUserPassword.value = '';
}

function closeEditUser(): void {
  editingUser.value = null;
  editUserDisplayName.value = '';
  editUserKind.value = '';
  editUserPassword.value = '';
}

async function saveUserEdit(): Promise<void> {
  if (!editingUser.value) return;
  if (!editUserDisplayName.value.trim()) {
    usersError.value = 'Display name is required.';
    return;
  }
  savingUser.value = true;
  usersError.value = '';
  try {
    const input: { displayName?: string; kind?: string; password?: string } = {
      displayName: editUserDisplayName.value.trim(),
      kind: editUserKind.value
    };
    if (editUserPassword.value) {
      input.password = editUserPassword.value;
    }
    await api.updateUser(editingUser.value.id, input);
    closeEditUser();
    await loadUsers();
  } catch (err) {
    usersError.value = err instanceof Error ? err.message : 'Failed to update user';
  } finally {
    savingUser.value = false;
  }
}

async function deleteUser(userId: string): Promise<void> {
  usersError.value = '';
  try {
    await api.deleteUser(userId);
    deletingUserId.value = null;
    await loadUsers();
  } catch (err) {
    usersError.value = err instanceof Error ? err.message : 'Failed to delete user';
    deletingUserId.value = null;
  }
}

async function loadAdminSkills(): Promise<void> {
  loadingAdminSkills.value = true;
  adminSkillsError.value = '';
  try {
    const res = await api.listAdminSkills();
    adminSkills.value = res.items ?? [];
    adminSkillRoots.value = res.roots ?? [];
    adminSkillsMeta.value = {
      generatedAt: res.generatedAt,
      promptEnhancerEnabledByDefault: res.promptEnhancerEnabledByDefault,
      defaultSkillsRoot: res.defaultSkillsRoot
    };
  } catch (err) {
    adminSkillsError.value = err instanceof Error ? err.message : 'Failed to load skills';
  } finally {
    loadingAdminSkills.value = false;
  }
}

const filteredAdminSkills = computed(() => {
  const q = adminSkillsQuery.value.trim().toLowerCase();
  const hideSystem = adminSkillsHideSystem.value;
  const onlyUsed = adminSkillsOnlyUsed.value;
  return adminSkills.value.filter((s) => {
    if (hideSystem && s.scope === 'system') return false;
    if (onlyUsed && (!s.availableIn || s.availableIn.length === 0)) return false;
    if (!q) return true;
    const haystack = [
      s.title,
      s.key,
      s.path,
      s.root,
      s.excerpt ?? ''
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
});

function getKindBadgeClass(kind: string): string {
  switch (kind) {
    case 'admin': return 'vb-kind-admin';
    case 'robot': return 'vb-kind-robot';
    case 'archived': return 'vb-kind-archived';
    case 'active': return 'vb-kind-active';
    default: return 'vb-kind-human';
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

// Invite functions
async function loadInvites(): Promise<void> {
  loadingInvites.value = true;
  invitesError.value = '';
  try {
    const response = await api.listInvites();
    invites.value = response.items;
  } catch (err) {
    invitesError.value = err instanceof Error ? err.message : 'Failed to load invites';
  } finally {
    loadingInvites.value = false;
  }
}

async function createInvite(): Promise<void> {
  creatingInvite.value = true;
  invitesError.value = '';
  try {
    await api.createInvite({
      maxUses: newInviteMaxUses.value,
      expiresInDays: newInviteExpiresInDays.value
    });
    newInviteMaxUses.value = 1;
    newInviteExpiresInDays.value = 7;
    await loadInvites();
  } catch (err) {
    invitesError.value = err instanceof Error ? err.message : 'Failed to create invite';
  } finally {
    creatingInvite.value = false;
  }
}

async function deleteInvite(inviteId: string): Promise<void> {
  invitesError.value = '';
  try {
    await api.deleteInvite(inviteId);
    deletingInviteId.value = null;
    await loadInvites();
  } catch (err) {
    invitesError.value = err instanceof Error ? err.message : 'Failed to delete invite';
    deletingInviteId.value = null;
  }
}

function copyInviteLink(code: string): void {
  const url = `${window.location.origin}/register?invite=${code}`;
  navigator.clipboard.writeText(url).catch(() => {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = url;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  });
}

function getInviteStatus(invite: InviteDto): { label: string; class: string } {
  if (invite.uses >= invite.maxUses) {
    return { label: 'Exhausted', class: 'vb-status-exhausted' };
  }
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return { label: 'Expired', class: 'vb-status-expired' };
  }
  return { label: 'Active', class: 'vb-status-active' };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatReasoningLabel(value: string): string {
  if (value === 'xhigh') return 'X-High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Discord functions
async function loadDiscordStatus(): Promise<void> {
  discordLoading.value = true;
  discordError.value = '';
  try {
    discordStatus.value = await api.getDiscordStatus();
  } catch (err) {
    discordError.value = err instanceof Error ? err.message : 'Failed to load Discord status';
  } finally {
    discordLoading.value = false;
  }
}

async function connectDiscord(): Promise<void> {
  if (!discordToken.value.trim() || !discordGuildId.value.trim()) {
    discordError.value = 'Please provide both a bot token and guild ID.';
    return;
  }
  discordConnecting.value = true;
  discordError.value = '';
  try {
    await api.connectDiscord({
      token: discordToken.value.trim(),
      guildId: discordGuildId.value.trim()
    });
    discordToken.value = '';
    discordGuildId.value = '';
    await loadDiscordStatus();
  } catch (err) {
    discordError.value = err instanceof Error ? err.message : 'Failed to connect Discord';
  } finally {
    discordConnecting.value = false;
  }
}

async function disconnectDiscord(): Promise<void> {
  discordConnecting.value = true;
  discordError.value = '';
  try {
    await api.disconnectDiscord();
    await loadDiscordStatus();
  } catch (err) {
    discordError.value = err instanceof Error ? err.message : 'Failed to disconnect Discord';
  } finally {
    discordConnecting.value = false;
  }
}

async function mapDiscordChannel(): Promise<void> {
  if (!discordChannelId.value.trim() || !discordForumId.value) {
    discordMappingError.value = 'Please provide a channel ID and select a forum.';
    return;
  }
  discordMapping.value = true;
  discordMappingError.value = '';
  try {
    await api.mapDiscordChannel(discordChannelId.value.trim(), discordForumId.value);
    discordChannelId.value = '';
    discordForumId.value = '';
    await loadDiscordStatus();
  } catch (err) {
    discordMappingError.value = err instanceof Error ? err.message : 'Failed to map channel';
  } finally {
    discordMapping.value = false;
  }
}

async function unmapDiscordChannel(channelId: string): Promise<void> {
  try {
    await api.unmapDiscordChannel(channelId);
    await loadDiscordStatus();
  } catch (err) {
    discordError.value = err instanceof Error ? err.message : 'Failed to unmap channel';
  }
}

// Matrix functions
async function loadMatrixStatus(): Promise<void> {
  matrixLoading.value = true;
  matrixError.value = '';
  try {
    matrixStatus.value = await api.getMatrixStatus();
  } catch (err) {
    matrixError.value = err instanceof Error ? err.message : 'Failed to load Matrix status';
  } finally {
    matrixLoading.value = false;
  }
}

async function connectMatrix(): Promise<void> {
  if (!matrixHomeserverUrl.value.trim() || !matrixAccessToken.value.trim() || !matrixUserId.value.trim()) {
    matrixError.value = 'Please provide homeserver URL, access token, and user ID.';
    return;
  }
  matrixConnecting.value = true;
  matrixError.value = '';
  try {
    await api.connectMatrix({
      homeserverUrl: matrixHomeserverUrl.value.trim(),
      accessToken: matrixAccessToken.value.trim(),
      userId: matrixUserId.value.trim()
    });
    matrixHomeserverUrl.value = '';
    matrixAccessToken.value = '';
    matrixUserId.value = '';
    await loadMatrixStatus();
  } catch (err) {
    matrixError.value = err instanceof Error ? err.message : 'Failed to connect Matrix';
  } finally {
    matrixConnecting.value = false;
  }
}

async function disconnectMatrix(): Promise<void> {
  matrixConnecting.value = true;
  matrixError.value = '';
  try {
    await api.disconnectMatrix();
    await loadMatrixStatus();
  } catch (err) {
    matrixError.value = err instanceof Error ? err.message : 'Failed to disconnect Matrix';
  } finally {
    matrixConnecting.value = false;
  }
}

async function mapMatrixRoom(): Promise<void> {
  if (!matrixRoomId.value.trim() || !matrixForumId.value) {
    matrixMappingError.value = 'Please provide a room ID and select a forum.';
    return;
  }
  matrixMapping.value = true;
  matrixMappingError.value = '';
  try {
    await api.mapMatrixRoom(matrixRoomId.value.trim(), matrixForumId.value);
    matrixRoomId.value = '';
    matrixForumId.value = '';
    await loadMatrixStatus();
  } catch (err) {
    matrixMappingError.value = err instanceof Error ? err.message : 'Failed to map room';
  } finally {
    matrixMapping.value = false;
  }
}

async function unmapMatrixRoom(roomId: string): Promise<void> {
  try {
    await api.unmapMatrixRoom(roomId);
    await loadMatrixStatus();
  } catch (err) {
    matrixError.value = err instanceof Error ? err.message : 'Failed to unmap room';
  }
}

function getForumName(forumId: string): string {
  const forum = forums.value.find(f => f.id === forumId);
  return forum?.name ?? forumId;
}

function goHome(): void {
  router.push({ name: 'forum.home' });
}

async function loadDeployStatus(): Promise<void> {
  deployLoading.value = true;
  deployError.value = '';
  try {
    deployStatus.value = await api.getDeployStatus();
  } catch (err) {
    deployError.value = err instanceof Error ? err.message : 'Failed to load deploy status';
  } finally {
    deployLoading.value = false;
  }
}

async function triggerDeploy(): Promise<void> {
  if (!deployStatus.value?.enabled) {
    deployError.value = 'Deploy is not configured on this server.';
    return;
  }
  const confirmed = window.confirm('Deploy latest code and restart the server now?');
  if (!confirmed) return;
  deployTriggering.value = true;
  deployError.value = '';
  deployMessage.value = '';
  try {
    const result = await api.triggerDeploy();
    const startedAt = result.startedAt ? new Date(result.startedAt).toLocaleString() : 'just now';
    deployMessage.value = `Deploy started (${startedAt}).`;
    await loadDeployStatus();
  } catch (err) {
    deployError.value = err instanceof Error ? err.message : 'Failed to start deploy';
  } finally {
    deployTriggering.value = false;
  }
}

async function loadPiSyncHealth(): Promise<void> {
  piSyncLoading.value = true;
  piSyncError.value = '';
  try {
    piSyncHealth.value = await api.getPiSyncHealth();
  } catch (err) {
    piSyncError.value = err instanceof Error ? err.message : 'Failed to load Pi sync health';
  } finally {
    piSyncLoading.value = false;
  }
}

async function runPiSync(piSessionId?: string): Promise<void> {
  piSyncAction.value = true;
  piSyncError.value = '';
  piSyncMessage.value = '';
  try {
    const result = piSessionId ? await api.runPiSessionSync(piSessionId) : await api.runPiSync();
    piSyncMessage.value = `${result.message} Checked ${result.sessionsChecked}, imported ${result.postsImported}, processed ${result.anomaliesProcessed} anomalies.`;
    await loadPiSyncHealth();
  } catch (err) {
    piSyncError.value = err instanceof Error ? err.message : 'Failed to run Pi sync';
  } finally {
    piSyncAction.value = false;
  }
}

async function backfillPiSyncAnomaly(anomalyId: string, bumpTopic = false): Promise<void> {
  piSyncAction.value = true;
  piSyncError.value = '';
  piSyncMessage.value = '';
  try {
    const result = await api.backfillPiSyncAnomaly(anomalyId, { bumpTopic });
    piSyncMessage.value = result.message;
    await loadPiSyncHealth();
  } catch (err) {
    piSyncError.value = err instanceof Error ? err.message : 'Failed to backfill anomaly';
  } finally {
    piSyncAction.value = false;
  }
}

async function ignorePiSyncAnomaly(anomalyId: string): Promise<void> {
  if (!window.confirm('Ignore this sync anomaly? It will remain in audit history.')) return;
  piSyncAction.value = true;
  piSyncError.value = '';
  piSyncMessage.value = '';
  try {
    const result = await api.ignorePiSyncAnomaly(anomalyId);
    piSyncMessage.value = result.message;
    await loadPiSyncHealth();
  } catch (err) {
    piSyncError.value = err instanceof Error ? err.message : 'Failed to ignore anomaly';
  } finally {
    piSyncAction.value = false;
  }
}

function formatMaybeDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

// Robot Automation functions
async function loadRobotAutomations(): Promise<void> {
  loadingRobotAutomations.value = true;
  robotAutomationsError.value = '';
  try {
    const response = await api.listRobotAutomations();
    robotAutomations.value = response.items;
  } catch (err) {
    robotAutomationsError.value = err instanceof Error ? err.message : 'Failed to load automations';
  } finally {
    loadingRobotAutomations.value = false;
  }
}

async function loadRobotSettings(): Promise<void> {
  try {
    const response = await api.getRobotDashboard();
    if (response.settings) {
      robotSettings.value = {
        maxConcurrentTurns: response.settings.maxConcurrentTurns,
        activeTurnsCount: response.settings.activeTurnsCount
      };
    }
  } catch {
    // Silently fail - settings will use defaults
  }
}

async function updateRobotSettings(): Promise<void> {
  try {
    const response = await api.updateRobotSettings({
      maxConcurrentTurns: robotSettings.value.maxConcurrentTurns
    });
    robotSettings.value.maxConcurrentTurns = response.maxConcurrentTurns;
  } catch (err) {
    robotAutomationsError.value = err instanceof Error ? err.message : 'Failed to update settings';
  }
}

async function createRobotAutomation(): Promise<void> {
  if (!newAutomationName.value.trim()) {
    robotAutomationsError.value = 'Automation name is required.';
    return;
  }
  if (!newAutomationPrompt.value.trim()) {
    robotAutomationsError.value = 'Automation prompt is required.';
    return;
  }
  if (newAutomationRunMode.value === 'interval' && newAutomationIntervalMinutes.value < 1) {
    robotAutomationsError.value = 'Interval must be at least 1 minute.';
    return;
  }
  creatingAutomation.value = true;
  robotAutomationsError.value = '';
  try {
    await api.createRobotAutomation({
      name: newAutomationName.value.trim(),
      forumId: newAutomationForumId.value || null,
      prompt: newAutomationPrompt.value.trim(),
      enabled: newAutomationEnabled.value,
      worker: newAutomationWorker.value,
      model: newAutomationModel.value.trim() || null,
      reasoningEffort: showNewAutomationReasoning.value ? newAutomationReasoningEffort.value.trim() || null : null,
      runMode: newAutomationRunMode.value,
      intervalMinutes: newAutomationRunMode.value === 'interval' ? newAutomationIntervalMinutes.value : null
    });
    newAutomationName.value = '';
    newAutomationForumId.value = '';
    newAutomationPrompt.value = '';
    newAutomationEnabled.value = true;
    newAutomationWorker.value = 'echs';
    newAutomationModel.value = '';
    newAutomationReasoningEffort.value = 'medium';
    newAutomationRunMode.value = 'manual';
    newAutomationIntervalMinutes.value = 60;
    await loadRobotAutomations();
  } catch (err) {
    robotAutomationsError.value = err instanceof Error ? err.message : 'Failed to create automation';
  } finally {
    creatingAutomation.value = false;
  }
}

function openEditAutomation(automation: RobotAutomationDto): void {
  editingAutomation.value = automation;
  editAutomationName.value = automation.name;
  editAutomationForumId.value = automation.forumId ?? '';
  editAutomationPrompt.value = automation.prompt;
  editAutomationEnabled.value = automation.enabled;
  editAutomationWorker.value = (automation.worker as 'echs') ?? 'echs';
  editAutomationModel.value = automation.model ?? '';
  editAutomationReasoningEffort.value = automation.reasoningEffort ?? '';
  editAutomationRunMode.value = automation.runMode;
  editAutomationIntervalMinutes.value = automation.intervalMinutes ?? null;
}

function closeEditAutomation(): void {
  editingAutomation.value = null;
  editAutomationName.value = '';
  editAutomationForumId.value = '';
  editAutomationPrompt.value = '';
  editAutomationEnabled.value = true;
  editAutomationWorker.value = 'echs';
  editAutomationModel.value = '';
  editAutomationReasoningEffort.value = '';
  editAutomationRunMode.value = 'manual';
  editAutomationIntervalMinutes.value = null;
}

watch(newAutomationWorker, (worker) => {
  const allowedModels = automationModels.value;
  if (newAutomationModel.value && !allowedModels.includes(newAutomationModel.value)) {
    newAutomationModel.value = '';
  }
  if (!state.modelSupportsReasoning(newAutomationModel.value)) {
    newAutomationReasoningEffort.value = '';
  } else if (!newAutomationReasoningEffort.value) {
    newAutomationReasoningEffort.value = 'medium';
  }
});

watch(newAutomationModel, (model) => {
  if (!state.modelSupportsReasoning(model)) {
    newAutomationReasoningEffort.value = '';
    return;
  }
  if (newAutomationReasoningEffort.value && !newAutomationReasoningOptions.value.includes(newAutomationReasoningEffort.value)) {
    newAutomationReasoningEffort.value = 'medium';
  }
});

watch(editAutomationWorker, (worker) => {
  const allowedModels = automationModels.value;
  if (editAutomationModel.value && !allowedModels.includes(editAutomationModel.value)) {
    editAutomationModel.value = '';
  }
  if (!state.modelSupportsReasoning(editAutomationModel.value)) {
    editAutomationReasoningEffort.value = '';
  }
});

watch(editAutomationModel, (model) => {
  if (!state.modelSupportsReasoning(model)) {
    editAutomationReasoningEffort.value = '';
    return;
  }
  if (editAutomationReasoningEffort.value && !editAutomationReasoningOptions.value.includes(editAutomationReasoningEffort.value)) {
    editAutomationReasoningEffort.value = 'medium';
  }
});

async function saveAutomationEdit(): Promise<void> {
  if (!editingAutomation.value) return;
  if (!editAutomationName.value.trim()) {
    robotAutomationsError.value = 'Automation name is required.';
    return;
  }
  if (!editAutomationPrompt.value.trim()) {
    robotAutomationsError.value = 'Automation prompt is required.';
    return;
  }
  if (editAutomationRunMode.value === 'interval' && (!editAutomationIntervalMinutes.value || editAutomationIntervalMinutes.value < 1)) {
    robotAutomationsError.value = 'Interval must be at least 1 minute.';
    return;
  }
  savingAutomation.value = true;
  robotAutomationsError.value = '';
  try {
    await api.updateRobotAutomation(editingAutomation.value.id, {
      name: editAutomationName.value.trim(),
      forumId: editAutomationForumId.value || null,
      prompt: editAutomationPrompt.value.trim(),
      enabled: editAutomationEnabled.value,
      worker: editAutomationWorker.value,
      model: editAutomationModel.value.trim() || null,
      reasoningEffort: showEditAutomationReasoning.value ? editAutomationReasoningEffort.value.trim() || null : null,
      runMode: editAutomationRunMode.value,
      intervalMinutes: editAutomationRunMode.value === 'interval' ? editAutomationIntervalMinutes.value : null
    });
    closeEditAutomation();
    await loadRobotAutomations();
  } catch (err) {
    robotAutomationsError.value = err instanceof Error ? err.message : 'Failed to update automation';
  } finally {
    savingAutomation.value = false;
  }
}

async function deleteRobotAutomation(automationId: string): Promise<void> {
  robotAutomationsError.value = '';
  try {
    await api.deleteRobotAutomation(automationId);
    deletingAutomationId.value = null;
    await loadRobotAutomations();
  } catch (err) {
    robotAutomationsError.value = err instanceof Error ? err.message : 'Failed to delete automation';
    deletingAutomationId.value = null;
  }
}

async function runRobotAutomation(automationId: string): Promise<void> {
  runningAutomationId.value = automationId;
  robotAutomationsError.value = '';
  try {
    await api.runRobotAutomation(automationId);
    await loadRobotAutomations();
  } catch (err) {
    robotAutomationsError.value = err instanceof Error ? err.message : 'Failed to run automation';
  } finally {
    runningAutomationId.value = null;
  }
}

async function loadAutomationRuns(automationId: string): Promise<void> {
  loadingAutomationRuns.value = true;
  robotAutomationsError.value = '';
  try {
    const response = await api.listRobotAutomationRuns(automationId);
    automationRuns.value = response.items;
    if (selectedAutomationRunId.value && !automationRuns.value.find((run) => run.id === selectedAutomationRunId.value)) {
      selectedAutomationRunId.value = null;
      automationLogContent.value = '';
      automationLogOffset.value = 0;
    }
  } catch (err) {
    robotAutomationsError.value = err instanceof Error ? err.message : 'Failed to load runs';
    automationRuns.value = [];
  } finally {
    loadingAutomationRuns.value = false;
  }
}

function stopAutomationLogPolling(): void {
  if (automationLogPolling.value) {
    window.clearInterval(automationLogPolling.value);
    automationLogPolling.value = null;
  }
}

async function loadAutomationLog(opts: { reset?: boolean; tail?: boolean } = {}): Promise<void> {
  if (!selectedAutomationRunId.value) return;
  automationLogLoading.value = true;
  automationLogError.value = '';
  try {
    const response = await api.getRobotAutomationRunLog(selectedAutomationRunId.value, {
      offset: opts.reset ? undefined : automationLogOffset.value,
      tail: opts.tail ?? false
    });
    if (opts.reset) {
      automationLogContent.value = response.content ?? '';
    } else if (response.content) {
      automationLogContent.value += response.content;
    }
    automationLogOffset.value = response.nextOffset;
  } catch (err) {
    automationLogError.value = err instanceof Error ? err.message : 'Failed to load automation log';
  } finally {
    automationLogLoading.value = false;
  }
}

function startAutomationLogPolling(): void {
  stopAutomationLogPolling();
  automationLogPolling.value = window.setInterval(async () => {
    if (!runsAutomationId.value) return;
    await loadAutomationRuns(runsAutomationId.value);
    if (selectedAutomationRun.value?.status === 'running') {
      await loadAutomationLog();
    } else {
      stopAutomationLogPolling();
    }
  }, 2000);
}

async function selectAutomationRun(run: RobotAutomationRunDto): Promise<void> {
  selectedAutomationRunId.value = run.id;
  automationLogContent.value = '';
  automationLogOffset.value = 0;
  automationLogError.value = '';
  await loadAutomationLog({ reset: true, tail: true });
  if (run.status === 'running') {
    startAutomationLogPolling();
  } else {
    stopAutomationLogPolling();
  }
}

async function openAutomationRuns(automationId: string): Promise<void> {
  runsAutomationId.value = automationId;
  selectedAutomationRunId.value = null;
  automationLogContent.value = '';
  automationLogOffset.value = 0;
  automationLogError.value = '';
  stopAutomationLogPolling();
  await loadAutomationRuns(automationId);
}

function closeAutomationRuns(): void {
  runsAutomationId.value = null;
  automationRuns.value = [];
  selectedAutomationRunId.value = null;
  automationLogContent.value = '';
  automationLogOffset.value = 0;
  automationLogError.value = '';
  stopAutomationLogPolling();
}

function extractPromptEnhancerConfig(config: Record<string, unknown> | null): {
  trigger: string;
  stripTrigger: boolean;
  maxDocs: number;
  perKindLimit: number;
  maxPrefaceChars: number;
  skillsRoot: string;
  kbRoot: string;
} {
  const trigger = typeof config?.['trigger'] === 'string' ? config['trigger'] : DEFAULT_PROMPT_ENHANCER_TRIGGER;
  const stripTrigger = typeof config?.['stripTrigger'] === 'boolean' ? config['stripTrigger'] : true;
  const maxDocs = typeof config?.['maxDocs'] === 'number' ? config['maxDocs'] : 8;
  const perKindLimit = typeof config?.['perKindLimit'] === 'number' ? config['perKindLimit'] : 4;
  const maxPrefaceChars = typeof config?.['maxPrefaceChars'] === 'number' ? config['maxPrefaceChars'] : 2200;
  const skillsRoot = typeof config?.['skillsRoot'] === 'string' ? config['skillsRoot'] : DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT;
  const kbRoot = typeof config?.['kbRoot'] === 'string' ? config['kbRoot'] : DEFAULT_PROMPT_ENHANCER_KB_ROOT;
  return {
    trigger,
    stripTrigger,
    maxDocs,
    perKindLimit,
    maxPrefaceChars,
    skillsRoot,
    kbRoot
  };
}

function getTamperPluginEntry(pluginKey: string): TamperPluginDto | undefined {
  return tamperPlugins.value.find((plugin) => plugin.key === pluginKey);
}

function deriveTamperDirections(stages: string[]): Array<'inbound' | 'outbound'> {
  const directions = new Set<'inbound' | 'outbound'>();
  for (const stage of stages) {
    if (stage.startsWith('inbound.')) directions.add('inbound');
    if (stage.startsWith('outbound.')) directions.add('outbound');
  }
  return Array.from(directions.values());
}

function getTamperDirectionOptions(pluginKey: string): Array<'inbound' | 'outbound' | 'both'> {
  const plugin = getTamperPluginEntry(pluginKey);
  if (!plugin) return ['inbound', 'outbound', 'both'];
  const directions = deriveTamperDirections(plugin.stages);
  if (directions.length > 1) return [...directions, 'both'];
  if (directions.length === 1) return directions;
  return ['both'];
}

function resolveDefaultTamperDirection(pluginKey: string): 'inbound' | 'outbound' | 'both' {
  const plugin = getTamperPluginEntry(pluginKey);
  if (plugin?.defaultDirection) return plugin.defaultDirection;
  const directions = plugin ? deriveTamperDirections(plugin.stages) : [];
  if (directions.length > 1) return 'both';
  if (directions.length === 1) return directions[0]!;
  return 'both';
}

function resolveDefaultTamperOnlyFirstMessage(pluginKey: string): boolean {
  const plugin = getTamperPluginEntry(pluginKey);
  if (typeof plugin?.defaultOnlyFirstMessage === 'boolean') return plugin.defaultOnlyFirstMessage;
  return false;
}

function resolveTamperDirectionValue(config: TamperConfigDto): 'inbound' | 'outbound' | 'both' {
  if (config.direction === 'inbound' || config.direction === 'outbound' || config.direction === 'both') {
    return config.direction;
  }
  return resolveDefaultTamperDirection(config.pluginKey);
}

function resolveTamperOnlyFirstMessage(config: TamperConfigDto): boolean {
  if (typeof config.onlyFirstMessage === 'boolean') {
    return config.onlyFirstMessage;
  }
  return resolveDefaultTamperOnlyFirstMessage(config.pluginKey);
}

function resetTamperCreateForm(): void {
  tamperConfigForumId.value = null;
  tamperConfigPluginKey.value = 'prompt.enhancer';
  tamperConfigEnabled.value = true;
  tamperConfigPriority.value = 0;
  tamperConfigDirection.value = resolveDefaultTamperDirection(tamperConfigPluginKey.value);
  tamperConfigOnlyFirstMessage.value = resolveDefaultTamperOnlyFirstMessage(tamperConfigPluginKey.value);
  tamperConfigEnhancerTrigger.value = DEFAULT_PROMPT_ENHANCER_TRIGGER;
  tamperConfigEnhancerStripTrigger.value = true;
  tamperConfigEnhancerMaxDocs.value = 8;
  tamperConfigEnhancerPerKindLimit.value = 4;
  tamperConfigEnhancerMaxPrefaceChars.value = 2200;
  tamperConfigEnhancerSkillsRoot.value = DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT;
  tamperConfigEnhancerKbRoot.value = DEFAULT_PROMPT_ENHANCER_KB_ROOT;
}

async function loadTamperPlugins(): Promise<void> {
  loadingTamperPlugins.value = true;
  tamperError.value = '';
  try {
    const response = await api.listTamperPlugins();
    tamperPlugins.value = response.items;
    if (!tamperConfigPluginKey.value && response.items.length > 0) {
      tamperConfigPluginKey.value = response.items[0]!.key;
    }
    if (!tamperTestPluginKey.value && response.items.length > 0) {
      tamperTestPluginKey.value = response.items[0]!.key;
    }
    if (tamperConfigPluginKey.value) {
      tamperConfigDirection.value = resolveDefaultTamperDirection(tamperConfigPluginKey.value);
      tamperConfigOnlyFirstMessage.value = resolveDefaultTamperOnlyFirstMessage(tamperConfigPluginKey.value);
    }
  } catch (err) {
    tamperError.value = err instanceof Error ? err.message : 'Failed to load tamper plugins';
  } finally {
    loadingTamperPlugins.value = false;
  }
}

async function loadTamperConfigs(): Promise<void> {
  loadingTamperConfigs.value = true;
  tamperError.value = '';
  try {
    const response = await api.listTamperConfigs();
    tamperConfigs.value = response.items;
    if (!tamperConfigEnhancerTrigger.value) {
      tamperConfigEnhancerTrigger.value = DEFAULT_PROMPT_ENHANCER_TRIGGER;
    }
    if (!tamperTestEnhancerTrigger.value) {
      tamperTestEnhancerTrigger.value = DEFAULT_PROMPT_ENHANCER_TRIGGER;
    }
  } catch (err) {
    tamperError.value = err instanceof Error ? err.message : 'Failed to load tamper configs';
  } finally {
    loadingTamperConfigs.value = false;
  }
}

function openEditTamperConfig(config: TamperConfigDto): void {
  editingTamperConfig.value = config;
  editTamperForumId.value = config.forumId ?? null;
  editTamperEnabled.value = config.enabled;
  editTamperPriority.value = config.priority;
  editTamperDirection.value = resolveTamperDirectionValue(config);
  editTamperOnlyFirstMessage.value = resolveTamperOnlyFirstMessage(config);
  if (config.pluginKey === 'prompt.enhancer') {
    const extracted = extractPromptEnhancerConfig(config.config ?? null);
    editTamperEnhancerTrigger.value = extracted.trigger;
    editTamperEnhancerStripTrigger.value = extracted.stripTrigger;
    editTamperEnhancerMaxDocs.value = extracted.maxDocs;
    editTamperEnhancerPerKindLimit.value = extracted.perKindLimit;
    editTamperEnhancerMaxPrefaceChars.value = extracted.maxPrefaceChars;
    editTamperEnhancerSkillsRoot.value = extracted.skillsRoot;
    editTamperEnhancerKbRoot.value = extracted.kbRoot;
  } else {
    editTamperEnhancerTrigger.value = DEFAULT_PROMPT_ENHANCER_TRIGGER;
    editTamperEnhancerStripTrigger.value = true;
    editTamperEnhancerMaxDocs.value = 8;
    editTamperEnhancerPerKindLimit.value = 4;
    editTamperEnhancerMaxPrefaceChars.value = 2200;
    editTamperEnhancerSkillsRoot.value = DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT;
    editTamperEnhancerKbRoot.value = DEFAULT_PROMPT_ENHANCER_KB_ROOT;
  }
}

function closeEditTamperConfig(): void {
  editingTamperConfig.value = null;
  editTamperForumId.value = null;
  editTamperEnabled.value = true;
  editTamperPriority.value = 0;
  editTamperDirection.value = 'outbound';
  editTamperOnlyFirstMessage.value = false;
  editTamperEnhancerTrigger.value = DEFAULT_PROMPT_ENHANCER_TRIGGER;
  editTamperEnhancerStripTrigger.value = true;
  editTamperEnhancerMaxDocs.value = 8;
  editTamperEnhancerPerKindLimit.value = 4;
  editTamperEnhancerMaxPrefaceChars.value = 2200;
  editTamperEnhancerSkillsRoot.value = DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT;
  editTamperEnhancerKbRoot.value = DEFAULT_PROMPT_ENHANCER_KB_ROOT;
}

async function createTamperConfig(): Promise<void> {
  if (!tamperConfigPluginKey.value) {
    tamperError.value = 'Select a plugin.';
    return;
  }
  creatingTamperConfig.value = true;
  tamperError.value = '';
  try {
    const config: Record<string, unknown> | null =
      tamperConfigPluginKey.value === 'prompt.enhancer'
        ? {
            trigger: tamperConfigEnhancerTrigger.value.trim() || null,
            onlyFirstMessage: tamperConfigOnlyFirstMessage.value,
            stripTrigger: tamperConfigEnhancerStripTrigger.value,
            maxDocs: Number(tamperConfigEnhancerMaxDocs.value) || 8,
            perKindLimit: Number(tamperConfigEnhancerPerKindLimit.value) || 4,
            maxPrefaceChars: Number(tamperConfigEnhancerMaxPrefaceChars.value) || 2200,
            skillsRoot: tamperConfigEnhancerSkillsRoot.value.trim() || DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT,
            kbRoot: tamperConfigEnhancerKbRoot.value.trim() || DEFAULT_PROMPT_ENHANCER_KB_ROOT
          }
      : null;

    await api.createTamperConfig({
      forumId: tamperConfigForumId.value,
      pluginKey: tamperConfigPluginKey.value,
      enabled: tamperConfigEnabled.value,
      priority: Number(tamperConfigPriority.value) || 0,
      direction: tamperConfigDirection.value,
      onlyFirstMessage: tamperConfigOnlyFirstMessage.value,
      config
    });
    resetTamperCreateForm();
    await loadTamperConfigs();
  } catch (err) {
    tamperError.value = err instanceof Error ? err.message : 'Failed to create tamper config';
  } finally {
    creatingTamperConfig.value = false;
  }
}

async function saveTamperConfig(): Promise<void> {
  if (!editingTamperConfig.value) return;
  savingTamperConfig.value = true;
  tamperError.value = '';
  try {
    const config: Record<string, unknown> | null =
      editingTamperConfig.value.pluginKey === 'prompt.enhancer'
        ? {
            trigger: editTamperEnhancerTrigger.value.trim() || null,
            onlyFirstMessage: editTamperOnlyFirstMessage.value,
            stripTrigger: editTamperEnhancerStripTrigger.value,
            maxDocs: Number(editTamperEnhancerMaxDocs.value) || 8,
            perKindLimit: Number(editTamperEnhancerPerKindLimit.value) || 4,
            maxPrefaceChars: Number(editTamperEnhancerMaxPrefaceChars.value) || 2200,
            skillsRoot: editTamperEnhancerSkillsRoot.value.trim() || DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT,
            kbRoot: editTamperEnhancerKbRoot.value.trim() || DEFAULT_PROMPT_ENHANCER_KB_ROOT
          }
      : editingTamperConfig.value.config ?? null;

    await api.updateTamperConfig(editingTamperConfig.value.id, {
      forumId: editTamperForumId.value,
      enabled: editTamperEnabled.value,
      priority: Number(editTamperPriority.value) || 0,
      direction: editTamperDirection.value,
      onlyFirstMessage: editTamperOnlyFirstMessage.value,
      config
    });
    closeEditTamperConfig();
    await loadTamperConfigs();
  } catch (err) {
    tamperError.value = err instanceof Error ? err.message : 'Failed to update tamper config';
  } finally {
    savingTamperConfig.value = false;
  }
}

async function deleteTamperConfig(configId: string): Promise<void> {
  deletingTamperConfigId.value = configId;
  tamperError.value = '';
  try {
    await api.deleteTamperConfig(configId);
    await loadTamperConfigs();
  } catch (err) {
    tamperError.value = err instanceof Error ? err.message : 'Failed to delete tamper config';
  } finally {
    deletingTamperConfigId.value = null;
  }
}

async function runTamperTest(): Promise<void> {
  if (!tamperTestText.value.trim()) {
    tamperError.value = 'Enter text to test.';
    return;
  }
  tamperTesting.value = true;
  tamperError.value = '';
  tamperTestResult.value = null;
  try {
    const pluginConfig: Record<string, unknown> | null =
      tamperTestPluginKey.value === 'prompt.enhancer'
        ? {
            trigger: tamperTestEnhancerTrigger.value.trim() || null,
            onlyFirstMessage: tamperTestEnhancerOnlyFirst.value,
            stripTrigger: tamperTestEnhancerStripTrigger.value,
            maxDocs: Number(tamperTestEnhancerMaxDocs.value) || 8,
            perKindLimit: Number(tamperTestEnhancerPerKindLimit.value) || 4,
            maxPrefaceChars: Number(tamperTestEnhancerMaxPrefaceChars.value) || 2200,
            skillsRoot: tamperTestEnhancerSkillsRoot.value.trim() || DEFAULT_PROMPT_ENHANCER_SKILLS_ROOT,
            kbRoot: tamperTestEnhancerKbRoot.value.trim() || DEFAULT_PROMPT_ENHANCER_KB_ROOT,
            priority: 5
          }
      : null;

    tamperTestResult.value = await api.testTamper({
      text: tamperTestText.value,
      forumId: tamperTestForumId.value,
      stage: tamperTestStage.value,
      direction: tamperTestDirection.value,
      isFirstMessage: tamperTestIsFirstMessage.value,
      pluginKey: tamperTestPluginKey.value,
      pluginConfig,
      onlyPlugin: tamperTestOnlyPlugin.value
    });
  } catch (err) {
    tamperError.value = err instanceof Error ? err.message : 'Failed to run tamper test';
  } finally {
    tamperTesting.value = false;
  }
}

onMounted(async () => {
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  if (!state.isLoggedIn.value || !isAdmin.value) {
    router.push({ name: 'forum.home' });
    return;
  }
  await loadForums();
  if (!personaForumId.value && forums.value.length > 0) {
    personaForumId.value = forums.value[0]!.id;
  }
  await loadAdminForums();
  await loadUsers();
  await loadInvites();
  await loadDiscordStatus();
  await loadMatrixStatus();
  await loadDeployStatus();
  await loadRobotAutomations();
  await loadRobotSettings();
  resetTamperCreateForm();
});
</script>

<template>
  <section class="vb-section">
    <div class="vb-table-header">Admin Panel</div>

    <div v-if="!isAdmin" class="vb-admin-content">
      <p>You must be an administrator to access this page.</p>
      <div class="vb-modal-actions">
        <button class="vb-btn" @click="goHome">Return to Forum</button>
      </div>
    </div>

    <div v-else class="vb-admin-content">
      <!-- Tab Navigation -->
      <div class="vb-admin-tabs">
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'forums' }"
          @click="activeTab = 'forums'"
        >
          Forums
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'personas' }"
          @click="activeTab = 'personas'"
        >
          Personas
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'skills' }"
          @click="activeTab = 'skills'"
        >
          Skills
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'users' }"
          @click="activeTab = 'users'"
        >
          Users
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'invites' }"
          @click="activeTab = 'invites'"
        >
          Invites
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'discord' }"
          @click="activeTab = 'discord'"
        >
          Discord
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'matrix' }"
          @click="activeTab = 'matrix'"
        >
          Matrix
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'tampers' }"
          @click="activeTab = 'tampers'"
        >
          Tampers
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'deploy' }"
          @click="activeTab = 'deploy'"
        >
          Deploy
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'sync' }"
          @click="activeTab = 'sync'"
        >
          Sync Health
        </button>
        <button
          class="vb-admin-tab"
          :class="{ active: activeTab === 'robots' }"
          @click="activeTab = 'robots'"
        >
          Robot Automations
        </button>
      </div>

      <!-- Forums Tab -->
      <div v-if="activeTab === 'forums'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Forum Management</h3>

        <div v-if="adminForumsError" class="vb-login-error">{{ adminForumsError }}</div>

        <div v-if="loadingAdminForums" class="vb-admin-loading">Loading forums...</div>

        <template v-else>
          <!-- Forums Table -->
          <div v-if="adminForums.length === 0" class="vb-admin-empty">
            No forums found.
          </div>

          <div v-else class="vb-admin-table-scroll" aria-label="Forum management table">
            <table class="vb-admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Parent</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Visibility</th>
                  <th>Robot</th>
                  <th>Description</th>
                  <th>Working Directory</th>
                  <th>Topics</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="forum in adminForums" :key="forum.id">
                  <td>{{ forum.name }}</td>
                  <td>{{ forum.parentForumId ? forumNameById.get(forum.parentForumId) ?? '—' : '—' }}</td>
                  <td>{{ forum.category || '—' }}</td>
                  <td>
                    <span class="vb-user-kind" :class="getKindBadgeClass(forum.status === 'archived' ? 'archived' : 'active')">
                      {{ forum.status ?? 'active' }}
                    </span>
                  </td>
                  <td>{{ forum.visibility ?? 'public' }}</td>
                  <td>
                    <span
                      class="vb-user-kind"
                      :class="forum.prePrompt && forum.prePrompt.trim().length > 0 ? 'vb-kind-admin' : 'vb-kind-human'"
                      :title="forum.prePrompt && forum.prePrompt.trim().length > 0 ? 'Custom forum instructions enabled' : 'Default robot instructions only'"
                    >
                      {{ forum.prePrompt && forum.prePrompt.trim().length > 0 ? 'custom' : 'default' }}
                    </span>
                  </td>
                  <td>{{ forum.description || '—' }}</td>
                  <td>
                    <code v-if="forum.cwd" class="vb-cwd-path" :title="forum.cwd">{{ forum.cwd }}</code>
                    <span v-else>Default</span>
                  </td>
                  <td>{{ forum.topicCount }}</td>
                  <td>
                    <div class="vb-action-buttons">
                      <template v-if="deletingForumId === forum.id">
                        <button
                          class="vb-btn vb-btn-small vb-btn-danger"
                          @click="deleteForum(forum.id)"
                        >
                          Confirm
                        </button>
                        <button
                          class="vb-btn vb-btn-small vb-btn-secondary"
                          @click="deletingForumId = null"
                        >
                          Cancel
                        </button>
                      </template>
                      <template v-else>
                        <button
                          class="vb-btn vb-btn-small"
                          @click="openEditForum(forum)"
                        >
                          Edit
                        </button>
                        <button
                          class="vb-btn vb-btn-small vb-btn-secondary"
                          @click="toggleForumArchive(forum)"
                        >
                          {{ forum.status === 'archived' ? 'Restore' : 'Archive' }}
                        </button>
                        <button
                          v-if="forum.topicCount === 0"
                          class="vb-btn vb-btn-small vb-btn-danger"
                          @click="deletingForumId = forum.id"
                        >
                          Delete
                        </button>
                      </template>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Create Forum Form -->
          <div class="vb-admin-mapping-form">
            <h5>Create New Forum</h5>
            <div class="vb-form-row">
              <label for="newForumName">Name:</label>
              <input
                id="newForumName"
                v-model="newForumName"
                type="text"
                placeholder="Forum name"
              />
            </div>
            <div class="vb-form-row">
              <label for="newForumDescription">Description:</label>
              <input
                id="newForumDescription"
                v-model="newForumDescription"
                type="text"
                placeholder="Optional description"
              />
            </div>
            <div class="vb-form-row">
              <div class="vb-form-row-header">
                <label for="newForumPrePrompt">Robot behavior (optional)</label>
                <label class="vb-toggle">
                  <input
                    type="checkbox"
                    :checked="newForumPrePromptEnabled"
                    @change="onNewForumPrePromptEnabledChange"
                  />
                  <span>Enable custom forum instructions</span>
                </label>
              </div>

              <div v-if="newForumPrePromptEnabled" class="vb-prompt-editor">
                <div class="vb-prompt-toolbar">
                  <select v-model="newForumPrePromptTemplateKey" class="vb-prompt-template">
                    <option value="">Insert template…</option>
                    <option v-for="t in prePromptTemplates" :key="t.key" :value="t.key">{{ t.label }}</option>
                  </select>
                  <button
                    class="vb-btn vb-btn-small vb-btn-secondary"
                    :disabled="!newForumPrePromptTemplateKey"
                    @click="applyPrePromptTemplate('new', 'replace')"
                  >
                    Replace
                  </button>
                  <button
                    class="vb-btn vb-btn-small vb-btn-secondary"
                    :disabled="!newForumPrePromptTemplateKey"
                    @click="applyPrePromptTemplate('new', 'append')"
                  >
                    Append
                  </button>
                  <div class="vb-prompt-toolbar-spacer" />
                  <button class="vb-btn vb-btn-small vb-btn-danger" @click="clearPrePrompt('new')">Clear</button>
                </div>

                <textarea
                  id="newForumPrePrompt"
                  v-model="newForumPrePrompt"
                  class="vb-prompt-textarea"
                  rows="8"
                  placeholder="Examples:\n- Always answer in bullet points\n- For code, prefer TypeScript\n- Be strict about security and never suggest unsafe commands"
                />

                <div class="vb-prompt-meta">
                  <span class="vb-form-hint">Applied to new ECHS sessions started in this forum.</span>
                  <span class="vb-char-count">{{ newForumPrePrompt.trim().length }} chars</span>
                </div>

                <details class="vb-prompt-preview">
                  <summary>Preview how it is injected</summary>
                  <pre class="vb-prompt-preview-body">Forum instructions:
{{ newForumPrePrompt.trim() || '(empty)' }}</pre>
                </details>
              </div>
              <span v-else class="vb-form-hint">Uses the default robot instructions only.</span>
            </div>
            <div class="vb-form-row">
              <label for="newForumParent">Parent Forum:</label>
              <select id="newForumParent" v-model="newForumParentId">
                <option :value="null">None</option>
                <option
                  v-for="forum in forums"
                  :key="forum.id"
                  :value="forum.id"
                >
                  {{ forum.name }} ({{ forum.status }})
                </option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="newForumCategory">Category:</label>
              <input
                id="newForumCategory"
                v-model="newForumCategory"
                type="text"
                placeholder="Optional category (e.g., Projects)"
              />
            </div>
            <div class="vb-form-row">
              <label for="newForumStatus">Status:</label>
              <select id="newForumStatus" v-model="newForumStatus">
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="newForumVisibility">Visibility:</label>
              <select id="newForumVisibility" v-model="newForumVisibility">
                <option value="public">Public (everyone)</option>
                <option value="members">Members (logged in)</option>
                <option value="admin">Admins only</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="newForumCwd">Working Directory (CWD):</label>
              <input
                id="newForumCwd"
                v-model="newForumCwd"
                type="text"
                placeholder="/path/to/project (leave empty for default)"
              />
              <span class="vb-form-hint">Absolute path where the robot will execute commands for this forum</span>
            </div>
            <div class="vb-modal-actions">
              <button
                class="vb-btn"
                :disabled="creatingForum"
                @click="createForum"
              >
                {{ creatingForum ? 'Creating...' : 'Create Forum' }}
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- Edit Forum Modal -->
      <div v-if="editingForum" class="vb-modal-overlay" @click.self="closeEditForum">
        <div class="vb-modal">
          <div class="vb-modal-header">
            <h3>Edit Forum</h3>
            <button class="vb-modal-close" @click="closeEditForum">&times;</button>
          </div>
          <div class="vb-modal-body">
            <div v-if="adminForumsError" class="vb-login-error">{{ adminForumsError }}</div>
            <div class="vb-form-row">
              <label for="editForumName">Name:</label>
              <input
                id="editForumName"
                v-model="editForumName"
                type="text"
              />
            </div>
            <div class="vb-form-row">
              <label for="editForumDescription">Description:</label>
              <input
                id="editForumDescription"
                v-model="editForumDescription"
                type="text"
                placeholder="Optional description"
              />
            </div>
            <div class="vb-form-row">
              <div class="vb-form-row-header">
                <label for="editForumPrePrompt">Robot behavior (optional)</label>
                <label class="vb-toggle">
                  <input
                    type="checkbox"
                    :checked="editForumPrePromptEnabled"
                    @change="onEditForumPrePromptEnabledChange"
                  />
                  <span>Enable custom forum instructions</span>
                </label>
              </div>

              <div v-if="editForumPrePromptEnabled" class="vb-prompt-editor">
                <div class="vb-prompt-toolbar">
                  <select v-model="editForumPrePromptTemplateKey" class="vb-prompt-template">
                    <option value="">Insert template…</option>
                    <option v-for="t in prePromptTemplates" :key="t.key" :value="t.key">{{ t.label }}</option>
                  </select>
                  <button
                    class="vb-btn vb-btn-small vb-btn-secondary"
                    :disabled="!editForumPrePromptTemplateKey"
                    @click="applyPrePromptTemplate('edit', 'replace')"
                  >
                    Replace
                  </button>
                  <button
                    class="vb-btn vb-btn-small vb-btn-secondary"
                    :disabled="!editForumPrePromptTemplateKey"
                    @click="applyPrePromptTemplate('edit', 'append')"
                  >
                    Append
                  </button>
                  <div class="vb-prompt-toolbar-spacer" />
                  <button class="vb-btn vb-btn-small vb-btn-danger" @click="clearPrePrompt('edit')">Clear</button>
                </div>

                <textarea
                  id="editForumPrePrompt"
                  v-model="editForumPrePrompt"
                  class="vb-prompt-textarea"
                  rows="10"
                  placeholder="Optional extra instructions for the robot in this forum"
                />

                <div class="vb-prompt-meta">
                  <span class="vb-form-hint">Changes apply the next time a new ECHS session is started in this forum.</span>
                  <span class="vb-char-count">{{ editForumPrePrompt.trim().length }} chars</span>
                </div>

                <details class="vb-prompt-preview">
                  <summary>Preview how it is injected</summary>
                  <pre class="vb-prompt-preview-body">Forum instructions:
{{ editForumPrePrompt.trim() || '(empty)' }}</pre>
                </details>
              </div>
              <span v-else class="vb-form-hint">Uses the default robot instructions only.</span>
            </div>
            <div class="vb-form-row">
              <label for="editForumParent">Parent Forum:</label>
              <select id="editForumParent" v-model="editForumParentId">
                <option :value="null">None</option>
                <option
                  v-for="forum in forums"
                  :key="forum.id"
                  :value="forum.id"
                  :disabled="forum.id === editingForum?.id"
                >
                  {{ forum.name }} ({{ forum.status }})
                </option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="editForumCategory">Category:</label>
              <input
                id="editForumCategory"
                v-model="editForumCategory"
                type="text"
                placeholder="Optional category"
              />
            </div>
            <div class="vb-form-row">
              <label for="editForumStatus">Status:</label>
              <select id="editForumStatus" v-model="editForumStatus">
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="editForumVisibility">Visibility:</label>
              <select id="editForumVisibility" v-model="editForumVisibility">
                <option value="public">Public (everyone)</option>
                <option value="members">Members (logged in)</option>
                <option value="admin">Admins only</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="editForumCwd">Working Directory (CWD):</label>
              <input
                id="editForumCwd"
                v-model="editForumCwd"
                type="text"
                placeholder="/path/to/project"
              />
              <span class="vb-form-hint">Absolute path where the robot will execute commands</span>
            </div>
          </div>
          <div class="vb-modal-actions">
            <button
              class="vb-btn"
              :disabled="savingForum"
              @click="saveForumEdit"
            >
              {{ savingForum ? 'Saving...' : 'Save Changes' }}
            </button>
            <button class="vb-btn vb-btn-secondary" @click="closeEditForum">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Personas Tab -->
      <div v-if="activeTab === 'personas'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Robot Personas</h3>

        <div v-if="personasError" class="vb-login-error">{{ personasError }}</div>

        <div class="vb-form-grid">
          <div class="vb-form-row">
            <label for="personaForumId">Forum:</label>
            <select id="personaForumId" v-model="personaForumId">
              <option v-for="f in forums" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <span class="vb-form-hint">Personas are scoped to the selected forum.</span>
          </div>
        </div>

        <div v-if="loadingPersonas" class="vb-admin-loading">Loading personas...</div>

        <template v-else>
          <div v-if="personas.length === 0" class="vb-admin-empty">
            No personas configured for this forum.
          </div>

          <table v-else class="vb-admin-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Display Name</th>
                <th>Description</th>
                <th>Accent</th>
                <th>Avatar</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in personas" :key="p.key">
                <td><code>{{ p.key }}</code></td>
                <td>{{ p.displayName }}</td>
                <td>{{ p.description || '—' }}</td>
                <td><code v-if="p.accentColor">{{ p.accentColor }}</code><span v-else>—</span></td>
                <td><code v-if="p.avatarUrl">{{ p.avatarUrl }}</code><span v-else>—</span></td>
                <td>{{ new Date(p.updatedAt).toLocaleString() }}</td>
                <td class="vb-admin-actions-cell">
                  <button class="vb-small-btn" @click="openEditPersona(p)">Edit</button>
                  <button
                    class="vb-small-btn vb-btn-danger"
                    :disabled="deletingPersonaKey === p.key"
                    @click="deletePersona(p.key)"
                  >
                    {{ deletingPersonaKey === p.key ? 'Deleting...' : 'Delete' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <h4 class="vb-admin-section-subtitle">Create Persona</h4>
          <div class="vb-form-grid">
            <div class="vb-form-row">
              <label for="newPersonaKey">Key:</label>
              <input id="newPersonaKey" v-model="newPersonaKey" type="text" placeholder="mira" />
              <span class="vb-form-hint">Used in robot output: <code>[[persona:&lt;key&gt;]]</code>. Letters/numbers/_/- only, max 32 chars.</span>
            </div>
            <div class="vb-form-row">
              <label for="newPersonaDisplayName">Display Name:</label>
              <input id="newPersonaDisplayName" v-model="newPersonaDisplayName" type="text" placeholder="Mira" />
            </div>
            <div class="vb-form-row">
              <label for="newPersonaDescription">One-line Description:</label>
              <input id="newPersonaDescription" v-model="newPersonaDescription" type="text" placeholder="Curious frontend engineer" />
            </div>
            <div class="vb-form-row">
              <label for="newPersonaAccentColor">Accent Color:</label>
              <input id="newPersonaAccentColor" v-model="newPersonaAccentColor" type="text" placeholder="#5b8def" />
            </div>
            <div class="vb-form-row">
              <label for="newPersonaAvatarUrl">Avatar URL:</label>
              <input id="newPersonaAvatarUrl" v-model="newPersonaAvatarUrl" type="text" placeholder="https://..." />
            </div>
            <div class="vb-form-row">
              <label for="newPersonaSignature">Signature (BBCode ok):</label>
              <textarea id="newPersonaSignature" v-model="newPersonaSignature" rows="3" placeholder="— Mira"></textarea>
            </div>
            <div class="vb-form-row">
              <label for="newPersonaSoul">Soul Document:</label>
              <textarea id="newPersonaSoul" v-model="newPersonaSoul" rows="6" placeholder="Longer persona instructions for the robot..."></textarea>
              <span class="vb-form-hint">Long souls are written to <code>.codex-forum/personas/&lt;key&gt;.md</code> for the robot to open.</span>
            </div>
          </div>
          <div class="vb-admin-actions">
            <button class="vb-btn" :disabled="creatingPersona" @click="createPersona">
              {{ creatingPersona ? 'Creating...' : 'Create Persona' }}
            </button>
          </div>

          <div v-if="editingPersona" class="vb-modal-overlay" @click.self="closeEditPersona">
            <div class="vb-modal">
              <h3>Edit Persona: {{ editPersonaKey }}</h3>
              <div class="vb-form-grid">
                <div class="vb-form-row">
                  <label>Key:</label>
                  <code>{{ editPersonaKey }}</code>
                </div>
                <div class="vb-form-row">
                  <label for="editPersonaDisplayName">Display Name:</label>
                  <input id="editPersonaDisplayName" v-model="editPersonaDisplayName" type="text" />
                </div>
                <div class="vb-form-row">
                  <label for="editPersonaDescription">One-line Description:</label>
                  <input id="editPersonaDescription" v-model="editPersonaDescription" type="text" />
                </div>
                <div class="vb-form-row">
                  <label for="editPersonaAccentColor">Accent Color:</label>
                  <input id="editPersonaAccentColor" v-model="editPersonaAccentColor" type="text" />
                </div>
                <div class="vb-form-row">
                  <label for="editPersonaAvatarUrl">Avatar URL:</label>
                  <input id="editPersonaAvatarUrl" v-model="editPersonaAvatarUrl" type="text" />
                </div>
                <div class="vb-form-row">
                  <label for="editPersonaSignature">Signature (BBCode ok):</label>
                  <textarea id="editPersonaSignature" v-model="editPersonaSignature" rows="3"></textarea>
                </div>
                <div class="vb-form-row">
                  <label for="editPersonaSoul">Soul Document:</label>
                  <textarea id="editPersonaSoul" v-model="editPersonaSoul" rows="8"></textarea>
                </div>
              </div>
              <div class="vb-modal-actions">
                <button class="vb-btn" :disabled="savingPersona" @click="savePersonaEdit">
                  {{ savingPersona ? 'Saving...' : 'Save Changes' }}
                </button>
                <button class="vb-btn vb-btn-secondary" @click="closeEditPersona">Cancel</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Skills Tab -->
      <div v-if="activeTab === 'skills'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Skills</h3>

        <p class="vb-form-hint">
          This tab lists <code>SKILL.md</code> files discovered under the skills roots configured for the
          <strong>prompt enhancer</strong> tamper plugin (<code>prompt.enhancer</code>).
          Skills are effectively available per <strong>forum</strong> (and thus shared by all personas in that forum).
        </p>

        <div v-if="adminSkillsError" class="vb-login-error">{{ adminSkillsError }}</div>

        <div v-if="loadingAdminSkills" class="vb-admin-loading">Loading skills...</div>

        <template v-else>
          <div v-if="adminSkillsMeta" class="vb-admin-skill-meta">
            <div>
              Default skills root: <code>{{ adminSkillsMeta.defaultSkillsRoot }}</code>
              · Prompt enhancer enabled-by-default:
              <span class="vb-user-kind" :class="getKindBadgeClass(adminSkillsMeta.promptEnhancerEnabledByDefault ? 'active' : 'archived')">
                {{ adminSkillsMeta.promptEnhancerEnabledByDefault ? 'enabled' : 'disabled' }}
              </span>
              · Generated: {{ new Date(adminSkillsMeta.generatedAt).toLocaleString() }}
            </div>
          </div>

          <h4 class="vb-admin-section-subtitle">Skill Roots</h4>
          <div v-if="adminSkillRoots.length === 0" class="vb-admin-empty">No skill roots found.</div>
          <table v-else class="vb-admin-table">
            <thead>
              <tr>
                <th>Root</th>
                <th>Status</th>
                <th>Skills</th>
                <th>Used By Forums</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in adminSkillRoots" :key="r.root">
                <td><code>{{ r.root }}</code></td>
                <td>
                  <span class="vb-user-kind" :class="getKindBadgeClass(r.exists ? 'active' : 'archived')">
                    {{ r.exists ? 'exists' : 'missing' }}
                  </span>
                </td>
                <td>{{ r.skillCount }}</td>
                <td>
                  <span v-if="r.usedByForumIds.length === 0">—</span>
                  <template v-else>
                    <span v-for="(fid, idx) in r.usedByForumIds" :key="fid">
                      <span v-if="idx > 0">, </span>
                      <code>{{ forumNameById.get(fid) ?? fid }}</code>
                    </span>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>

          <h4 class="vb-admin-section-subtitle">Skills</h4>

          <div class="vb-form-grid">
            <div class="vb-form-row">
              <label for="adminSkillsQuery">Filter:</label>
              <input
                id="adminSkillsQuery"
                v-model="adminSkillsQuery"
                type="text"
                placeholder="Search by title, key, path, excerpt..."
              />
            </div>
            <div class="vb-form-row">
              <label>
                <input v-model="adminSkillsHideSystem" type="checkbox" />
                Hide system skills
              </label>
              <span class="vb-form-hint">System skills usually live under <code>.system/</code>.</span>
            </div>
            <div class="vb-form-row">
              <label>
                <input v-model="adminSkillsOnlyUsed" type="checkbox" />
                Only show skills that are used by at least one forum
              </label>
            </div>
          </div>

          <div class="vb-admin-skill-summary">
            Showing <strong>{{ filteredAdminSkills.length }}</strong> of <strong>{{ adminSkills.length }}</strong> skills.
          </div>

          <div v-if="filteredAdminSkills.length === 0" class="vb-admin-empty">
            No matching skills.
          </div>

          <div v-else class="vb-admin-table-scroll" aria-label="Skills table">
            <table class="vb-admin-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Key</th>
                  <th>Scope</th>
                  <th>Root</th>
                  <th>Updated</th>
                  <th>Size</th>
                  <th>Available In (Forums / Personas)</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in filteredAdminSkills" :key="s.id">
                  <td>
                    <strong>{{ s.title }}</strong>
                    <div v-if="s.excerpt" class="vb-admin-skill-excerpt">{{ s.excerpt }}</div>
                  </td>
                  <td><code>{{ s.key }}</code></td>
                  <td>
                    <span class="vb-user-kind" :class="getKindBadgeClass(s.scope === 'system' ? 'archived' : 'active')">
                      {{ s.scope }}
                    </span>
                  </td>
                  <td><code>{{ s.root }}</code></td>
                  <td>{{ s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '—' }}</td>
                  <td>{{ formatBytes(s.bytes) }}</td>
                  <td>
                    <div v-if="!s.availableIn || s.availableIn.length === 0">—</div>
                    <ul v-else class="vb-admin-skill-availability">
                      <li v-for="f in s.availableIn" :key="f.forumId">
                        <strong>{{ f.forumName }}</strong>
                        <span class="vb-admin-muted">
                          ({{ f.configScope }}, {{ f.promptEnhancerEnabled ? 'enhancer on' : 'enhancer off' }})
                        </span>
                        <div v-if="f.personas && f.personas.length > 0" class="vb-admin-muted">
                          Personas:
                          <span v-for="(p, idx) in f.personas" :key="p.key">
                            <span v-if="idx > 0">, </span><code>{{ p.key }}</code>
                          </span>
                        </div>
                        <div v-else class="vb-admin-muted">Personas: —</div>
                      </li>
                    </ul>
                  </td>
                  <td><code>{{ s.path }}</code></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- Users Tab -->
      <div v-if="activeTab === 'users'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">User Management</h3>

        <div v-if="usersError" class="vb-login-error">{{ usersError }}</div>

        <div v-if="loadingUsers" class="vb-admin-loading">Loading users...</div>

        <template v-else>
          <!-- Users Table -->
          <div v-if="users.length === 0" class="vb-admin-empty">
            No users found.
          </div>

          <table v-else class="vb-admin-table">
            <thead>
              <tr>
                <th>Display Name</th>
                <th>Username</th>
                <th>Type</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in users" :key="user.id">
                <td>{{ user.displayName }}</td>
                <td>{{ user.username || '—' }}</td>
                <td>
                  <span class="vb-user-kind" :class="getKindBadgeClass(user.kind)">
                    {{ user.kind }}
                  </span>
                </td>
                <td>{{ formatDate(user.createdAt) }}</td>
                <td>
                  <div class="vb-action-buttons">
                    <template v-if="deletingUserId === user.id">
                      <button
                        class="vb-btn vb-btn-small vb-btn-danger"
                        @click="deleteUser(user.id)"
                      >
                        Confirm
                      </button>
                      <button
                        class="vb-btn vb-btn-small vb-btn-secondary"
                        @click="deletingUserId = null"
                      >
                        Cancel
                      </button>
                    </template>
                    <template v-else>
                      <button
                        class="vb-btn vb-btn-small"
                        @click="openEditUser(user)"
                      >
                        Edit
                      </button>
                      <button
                        v-if="user.kind !== 'robot'"
                        class="vb-btn vb-btn-small vb-btn-danger"
                        @click="deletingUserId = user.id"
                      >
                        Delete
                      </button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Create User Form -->
          <div class="vb-admin-mapping-form">
            <h5>Create New User</h5>
            <div class="vb-form-row">
              <label for="newUserDisplayName">Display Name:</label>
              <input
                id="newUserDisplayName"
                v-model="newUserDisplayName"
                type="text"
                placeholder="User display name"
              />
            </div>
            <div class="vb-form-row">
              <label for="newUserUsername">Username (for login):</label>
              <input
                id="newUserUsername"
                v-model="newUserUsername"
                type="text"
                placeholder="Optional login username"
              />
            </div>
            <div class="vb-form-row">
              <label for="newUserPassword">Password:</label>
              <input
                id="newUserPassword"
                v-model="newUserPassword"
                type="password"
                placeholder="Password for login"
              />
            </div>
            <div class="vb-form-row">
              <label for="newUserKind">Type:</label>
              <select id="newUserKind" v-model="newUserKind">
                <option value="human">Human</option>
                <option value="admin">Admin</option>
                <option value="robot">Robot</option>
              </select>
            </div>
            <div class="vb-modal-actions">
              <button
                class="vb-btn"
                :disabled="creatingUser"
                @click="createUser"
              >
                {{ creatingUser ? 'Creating...' : 'Create User' }}
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- Edit User Modal -->
      <div v-if="editingUser" class="vb-modal-overlay" @click.self="closeEditUser">
        <div class="vb-modal">
          <div class="vb-modal-header">
            <h3>Edit User</h3>
            <button class="vb-modal-close" @click="closeEditUser">&times;</button>
          </div>
          <div class="vb-modal-body">
            <div v-if="usersError" class="vb-login-error">{{ usersError }}</div>
            <div class="vb-form-row">
              <label for="editUserDisplayName">Display Name:</label>
              <input
                id="editUserDisplayName"
                v-model="editUserDisplayName"
                type="text"
              />
            </div>
            <div class="vb-form-row">
              <label for="editUserKind">Type:</label>
              <select id="editUserKind" v-model="editUserKind">
                <option value="human">Human</option>
                <option value="admin">Admin</option>
                <option value="robot">Robot</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="editUserPassword">New Password (leave blank to keep current):</label>
              <input
                id="editUserPassword"
                v-model="editUserPassword"
                type="password"
                placeholder="Enter new password"
              />
            </div>
          </div>
          <div class="vb-modal-actions">
            <button
              class="vb-btn"
              :disabled="savingUser"
              @click="saveUserEdit"
            >
              {{ savingUser ? 'Saving...' : 'Save Changes' }}
            </button>
            <button class="vb-btn vb-btn-secondary" @click="closeEditUser">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Invites Tab -->
      <div v-if="activeTab === 'invites'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Invite Management</h3>

        <div v-if="invitesError" class="vb-login-error">{{ invitesError }}</div>

        <div v-if="loadingInvites" class="vb-admin-loading">Loading invites...</div>

        <template v-else>
          <!-- Invites Table -->
          <div v-if="invites.length === 0" class="vb-admin-empty">
            No invites found.
          </div>

          <table v-else class="vb-admin-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Usage</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="invite in invites" :key="invite.id">
                <td><code class="vb-invite-code">{{ invite.code }}</code></td>
                <td>{{ invite.uses }} / {{ invite.maxUses }}</td>
                <td>
                  <span class="vb-invite-status-badge" :class="getInviteStatus(invite).class">
                    {{ getInviteStatus(invite).label }}
                  </span>
                </td>
                <td>{{ invite.expiresAt ? formatDate(invite.expiresAt) : 'Never' }}</td>
                <td>{{ formatDate(invite.createdAt) }}</td>
                <td>
                  <div class="vb-action-buttons">
                    <template v-if="deletingInviteId === invite.id">
                      <button
                        class="vb-btn vb-btn-small vb-btn-danger"
                        @click="deleteInvite(invite.id)"
                      >
                        Confirm
                      </button>
                      <button
                        class="vb-btn vb-btn-small vb-btn-secondary"
                        @click="deletingInviteId = null"
                      >
                        Cancel
                      </button>
                    </template>
                    <template v-else>
                      <button
                        class="vb-btn vb-btn-small"
                        @click="copyInviteLink(invite.code)"
                      >
                        Copy Link
                      </button>
                      <button
                        class="vb-btn vb-btn-small vb-btn-danger"
                        @click="deletingInviteId = invite.id"
                      >
                        Delete
                      </button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Create Invite Form -->
          <div class="vb-admin-mapping-form">
            <h5>Generate New Invite</h5>
            <div class="vb-form-row">
              <label for="newInviteMaxUses">Max Uses:</label>
              <input
                id="newInviteMaxUses"
                v-model.number="newInviteMaxUses"
                type="number"
                min="1"
                max="100"
              />
            </div>
            <div class="vb-form-row">
              <label for="newInviteExpiresInDays">Expires In (days):</label>
              <input
                id="newInviteExpiresInDays"
                v-model.number="newInviteExpiresInDays"
                type="number"
                min="1"
                max="365"
              />
            </div>
            <div class="vb-modal-actions">
              <button
                class="vb-btn"
                :disabled="creatingInvite"
                @click="createInvite"
              >
                {{ creatingInvite ? 'Generating...' : 'Generate Invite' }}
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- Discord Tab -->
      <div v-if="activeTab === 'discord'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Discord Bridge Configuration</h3>

        <div v-if="discordError" class="vb-login-error">{{ discordError }}</div>

        <div v-if="discordLoading" class="vb-admin-loading">Loading Discord status...</div>

        <template v-else-if="discordStatus">
          <!-- Connection Status -->
          <div class="vb-admin-status">
            <span class="vb-admin-status-label">Status:</span>
            <span :class="discordStatus.connected ? 'vb-status-connected' : 'vb-status-disconnected'">
              {{ discordStatus.connected ? 'Connected' : 'Disconnected' }}
            </span>
          </div>

          <template v-if="discordStatus.connected">
            <div class="vb-admin-info">
              <div class="vb-admin-info-row">
                <span class="vb-admin-info-label">Guild:</span>
                <span>{{ discordStatus.guildName || discordStatus.guildId }}</span>
              </div>
            </div>
            <div class="vb-modal-actions">
              <button
                class="vb-btn vb-btn-danger"
                :disabled="discordConnecting"
                @click="disconnectDiscord"
              >
                {{ discordConnecting ? 'Disconnecting...' : 'Disconnect' }}
              </button>
            </div>
          </template>

          <template v-else>
            <div class="vb-admin-form">
              <div class="vb-form-row">
                <label for="discordToken">Bot Token:</label>
                <input
                  id="discordToken"
                  v-model="discordToken"
                  type="password"
                  placeholder="Discord bot token"
                />
              </div>
              <div class="vb-form-row">
                <label for="discordGuildId">Guild ID:</label>
                <input
                  id="discordGuildId"
                  v-model="discordGuildId"
                  type="text"
                  placeholder="Discord server ID"
                />
              </div>
              <div class="vb-modal-actions">
                <button
                  class="vb-btn"
                  :disabled="discordConnecting"
                  @click="connectDiscord"
                >
                  {{ discordConnecting ? 'Connecting...' : 'Connect' }}
                </button>
              </div>
            </div>
          </template>

          <!-- Channel Mappings (only when connected) -->
          <template v-if="discordStatus.connected">
            <h4 class="vb-admin-subsection-title">Channel Mappings</h4>

            <div v-if="discordStatus.channelMappings.length === 0" class="vb-admin-empty">
              No channels mapped yet.
            </div>

            <table v-else class="vb-admin-table">
              <thead>
                <tr>
                  <th>Channel ID</th>
                  <th>Forum</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="mapping in discordStatus.channelMappings" :key="mapping.channelId">
                  <td>{{ mapping.channelName || mapping.channelId }}</td>
                  <td>{{ getForumName(mapping.forumId) }}</td>
                  <td>
                    <button
                      class="vb-btn vb-btn-small vb-btn-danger"
                      @click="unmapDiscordChannel(mapping.channelId)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- Add mapping form -->
            <div class="vb-admin-mapping-form">
              <h5>Add Channel Mapping</h5>
              <div v-if="discordMappingError" class="vb-login-error">{{ discordMappingError }}</div>
              <div class="vb-form-row">
                <label for="discordChannelId">Channel ID:</label>
                <input
                  id="discordChannelId"
                  v-model="discordChannelId"
                  type="text"
                  placeholder="Discord channel ID"
                />
              </div>
              <div class="vb-form-row">
                <label for="discordForumId">Forum:</label>
                <select id="discordForumId" v-model="discordForumId">
                  <option value="">-- Select Forum --</option>
                  <option v-for="forum in forums" :key="forum.id" :value="forum.id">
                    {{ forum.name }}
                  </option>
                </select>
              </div>
              <div class="vb-modal-actions">
                <button
                  class="vb-btn"
                  :disabled="discordMapping"
                  @click="mapDiscordChannel"
                >
                  {{ discordMapping ? 'Mapping...' : 'Add Mapping' }}
                </button>
              </div>
            </div>
          </template>
        </template>
      </div>

      <!-- Matrix Tab -->
      <div v-if="activeTab === 'matrix'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Matrix Bridge Configuration</h3>

        <div v-if="matrixError" class="vb-login-error">{{ matrixError }}</div>

        <div v-if="matrixLoading" class="vb-admin-loading">Loading Matrix status...</div>

        <template v-else-if="matrixStatus">
          <!-- Connection Status -->
          <div class="vb-admin-status">
            <span class="vb-admin-status-label">Status:</span>
            <span :class="matrixStatus.connected ? 'vb-status-connected' : 'vb-status-disconnected'">
              {{ matrixStatus.connected ? 'Connected' : 'Disconnected' }}
            </span>
          </div>

          <template v-if="matrixStatus.connected">
            <div class="vb-admin-info">
              <div class="vb-admin-info-row">
                <span class="vb-admin-info-label">Homeserver:</span>
                <span>{{ matrixStatus.homeserverUrl }}</span>
              </div>
              <div class="vb-admin-info-row">
                <span class="vb-admin-info-label">User ID:</span>
                <span>{{ matrixStatus.userId }}</span>
              </div>
            </div>
            <div class="vb-modal-actions">
              <button
                class="vb-btn vb-btn-danger"
                :disabled="matrixConnecting"
                @click="disconnectMatrix"
              >
                {{ matrixConnecting ? 'Disconnecting...' : 'Disconnect' }}
              </button>
            </div>
          </template>

          <template v-else>
            <div class="vb-admin-form">
              <div class="vb-form-row">
                <label for="matrixHomeserverUrl">Homeserver URL:</label>
                <input
                  id="matrixHomeserverUrl"
                  v-model="matrixHomeserverUrl"
                  type="text"
                  placeholder="https://matrix.example.org"
                />
              </div>
              <div class="vb-form-row">
                <label for="matrixAccessToken">Access Token:</label>
                <input
                  id="matrixAccessToken"
                  v-model="matrixAccessToken"
                  type="password"
                  placeholder="Matrix access token"
                />
              </div>
              <div class="vb-form-row">
                <label for="matrixUserId">User ID:</label>
                <input
                  id="matrixUserId"
                  v-model="matrixUserId"
                  type="text"
                  placeholder="@bot:example.org"
                />
              </div>
              <div class="vb-modal-actions">
                <button
                  class="vb-btn"
                  :disabled="matrixConnecting"
                  @click="connectMatrix"
                >
                  {{ matrixConnecting ? 'Connecting...' : 'Connect' }}
                </button>
              </div>
            </div>
          </template>

          <!-- Room Mappings (only when connected) -->
          <template v-if="matrixStatus.connected">
            <h4 class="vb-admin-subsection-title">Room Mappings</h4>

            <div v-if="matrixStatus.roomMappings.length === 0" class="vb-admin-empty">
              No rooms mapped yet.
            </div>

            <table v-else class="vb-admin-table">
              <thead>
                <tr>
                  <th>Room ID</th>
                  <th>Forum</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="mapping in matrixStatus.roomMappings" :key="mapping.roomId">
                  <td>{{ mapping.roomName || mapping.roomId }}</td>
                  <td>{{ getForumName(mapping.forumId) }}</td>
                  <td>
                    <button
                      class="vb-btn vb-btn-small vb-btn-danger"
                      @click="unmapMatrixRoom(mapping.roomId)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- Add mapping form -->
            <div class="vb-admin-mapping-form">
              <h5>Add Room Mapping</h5>
              <div v-if="matrixMappingError" class="vb-login-error">{{ matrixMappingError }}</div>
              <div class="vb-form-row">
                <label for="matrixRoomId">Room ID:</label>
                <input
                  id="matrixRoomId"
                  v-model="matrixRoomId"
                  type="text"
                  placeholder="!room:example.org"
                />
              </div>
              <div class="vb-form-row">
                <label for="matrixForumId">Forum:</label>
                <select id="matrixForumId" v-model="matrixForumId">
                  <option value="">-- Select Forum --</option>
                  <option v-for="forum in forums" :key="forum.id" :value="forum.id">
                    {{ forum.name }}
                  </option>
                </select>
              </div>
              <div class="vb-modal-actions">
                <button
                  class="vb-btn"
                  :disabled="matrixMapping"
                  @click="mapMatrixRoom"
                >
                  {{ matrixMapping ? 'Mapping...' : 'Add Mapping' }}
                </button>
              </div>
            </div>
          </template>
        </template>
      </div>

      <!-- Tampers Tab -->
      <div v-if="activeTab === 'tampers'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Tamper Layer</h3>

        <div v-if="tamperError" class="vb-login-error">{{ tamperError }}</div>

        <div v-if="loadingTamperPlugins || loadingTamperConfigs" class="vb-admin-loading">Loading tamper settings...</div>

        <template v-else>
          <h4 class="vb-admin-section-subtitle">Tamper Configs</h4>
          <div v-if="tamperConfigs.length === 0" class="vb-admin-empty">
            No tamper configs defined yet.
          </div>
          <table v-else class="vb-admin-table">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Scope</th>
                <th>Direction</th>
                <th>Run</th>
                <th>Enabled</th>
                <th>Priority</th>
                <th>Prompt</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="config in tamperConfigs" :key="config.id">
                <td>{{ config.pluginKey }}</td>
                <td>{{ config.forumId ? getForumName(config.forumId) : 'Global' }}</td>
                <td>{{ resolveTamperDirectionValue(config) }}</td>
                <td>{{ resolveTamperOnlyFirstMessage(config) ? 'first message' : 'every message' }}</td>
                <td>
                  <span class="vb-user-kind" :class="config.enabled ? 'vb-kind-admin' : 'vb-kind-human'">
                    {{ config.enabled ? 'on' : 'off' }}
                  </span>
                </td>
                <td>{{ config.priority }}</td>
                <td>
                  <span v-if="config.pluginKey === 'prompt.enhancer'">
                    {{ extractPromptEnhancerConfig(config.config ?? null).trigger || 'always' }}
                  </span>
                  <span v-else>—</span>
                </td>
                <td class="vb-admin-actions-cell">
                  <div class="vb-action-buttons">
                    <template v-if="deletingTamperConfigId === config.id">
                      <button class="vb-btn vb-btn-small vb-btn-danger" @click="deleteTamperConfig(config.id)">
                        Confirm
                      </button>
                      <button class="vb-btn vb-btn-small vb-btn-secondary" @click="deletingTamperConfigId = null">
                        Cancel
                      </button>
                    </template>
                    <template v-else>
                      <button class="vb-btn vb-btn-small" @click="openEditTamperConfig(config)">
                        Edit
                      </button>
                      <button class="vb-btn vb-btn-small vb-btn-danger" @click="deletingTamperConfigId = config.id">
                        Delete
                      </button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <h4 class="vb-admin-section-subtitle">Create Tamper Config</h4>
          <div class="vb-admin-form">
            <div class="vb-form-row">
              <label for="tamperPluginKey">Plugin:</label>
              <select id="tamperPluginKey" v-model="tamperConfigPluginKey">
                <option v-for="plugin in tamperPlugins" :key="plugin.key" :value="plugin.key">
                  {{ plugin.label }}
                </option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="tamperForumId">Forum scope:</label>
              <select id="tamperForumId" v-model="tamperConfigForumId">
                <option :value="null">Global (all forums)</option>
                <option v-for="forum in forums" :key="forum.id" :value="forum.id">
                  {{ forum.name }}
                </option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="tamperEnabled">Enabled:</label>
              <input id="tamperEnabled" v-model="tamperConfigEnabled" type="checkbox" />
            </div>
            <div class="vb-form-row">
              <label for="tamperPriority">Priority:</label>
              <input id="tamperPriority" v-model="tamperConfigPriority" type="number" />
            </div>
            <div class="vb-form-row">
              <label for="tamperDirection">Direction:</label>
              <select
                id="tamperDirection"
                v-model="tamperConfigDirection"
                :disabled="getTamperDirectionOptions(tamperConfigPluginKey).length === 1"
              >
                <option v-for="direction in getTamperDirectionOptions(tamperConfigPluginKey)" :key="direction" :value="direction">
                  {{ direction }}
                </option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="tamperOnlyFirst">Run only on first message:</label>
              <input id="tamperOnlyFirst" v-model="tamperConfigOnlyFirstMessage" type="checkbox" />
            </div>
            <template v-if="tamperConfigPluginKey === 'prompt.enhancer'">
              <div class="vb-form-row">
                <label for="tamperEnhancerTrigger">Trigger token (blank = always):</label>
                <input
                  id="tamperEnhancerTrigger"
                  v-model="tamperConfigEnhancerTrigger"
                  type="text"
                  placeholder="[[gather]]"
                />
              </div>
              <div class="vb-form-row">
                <label for="tamperEnhancerStripTrigger">Strip trigger:</label>
                <input id="tamperEnhancerStripTrigger" v-model="tamperConfigEnhancerStripTrigger" type="checkbox" />
              </div>
              <div class="vb-form-row">
                <label for="tamperEnhancerMaxDocs">Max docs:</label>
                <input id="tamperEnhancerMaxDocs" v-model="tamperConfigEnhancerMaxDocs" type="number" />
              </div>
              <div class="vb-form-row">
                <label for="tamperEnhancerPerKind">Per-kind limit:</label>
                <input id="tamperEnhancerPerKind" v-model="tamperConfigEnhancerPerKindLimit" type="number" />
              </div>
              <div class="vb-form-row">
                <label for="tamperEnhancerMaxChars">Max preface chars:</label>
                <input id="tamperEnhancerMaxChars" v-model="tamperConfigEnhancerMaxPrefaceChars" type="number" />
              </div>
              <div class="vb-form-row">
                <label for="tamperEnhancerSkillsRoot">Skills root:</label>
                <input
                  id="tamperEnhancerSkillsRoot"
                  v-model="tamperConfigEnhancerSkillsRoot"
                  type="text"
                />
              </div>
              <div class="vb-form-row">
                <label for="tamperEnhancerKbRoot">KB root:</label>
                <input
                  id="tamperEnhancerKbRoot"
                  v-model="tamperConfigEnhancerKbRoot"
                  type="text"
                />
              </div>
            </template>
            <div class="vb-modal-actions">
              <button class="vb-btn" :disabled="creatingTamperConfig" @click="createTamperConfig">
                {{ creatingTamperConfig ? 'Saving...' : 'Create Config' }}
              </button>
            </div>
          </div>

          <h4 class="vb-admin-section-subtitle">Test Tamper</h4>
          <div class="vb-admin-form">
            <div class="vb-form-row">
              <label for="tamperTestText">Input text:</label>
              <textarea
                id="tamperTestText"
                v-model="tamperTestText"
                rows="5"
                placeholder="Paste the message to test here"
              />
            </div>
            <div class="vb-form-row">
              <label for="tamperTestForum">Forum context:</label>
              <select id="tamperTestForum" v-model="tamperTestForumId">
                <option :value="null">Global (no forum)</option>
                <option v-for="forum in forums" :key="forum.id" :value="forum.id">
                  {{ forum.name }}
                </option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="tamperTestStage">Stage:</label>
              <select id="tamperTestStage" v-model="tamperTestStage">
                <option value="inbound.user_to_codex">Inbound: user → robot</option>
                <option value="outbound.codex_to_forum">Outbound: robot → forum</option>
                <option value="outbound.forum_post_body">Outbound: forum post body</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="tamperTestDirection">Direction:</label>
              <select id="tamperTestDirection" v-model="tamperTestDirection">
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="tamperTestFirstMessage">First message context:</label>
              <input id="tamperTestFirstMessage" v-model="tamperTestIsFirstMessage" type="checkbox" />
            </div>
            <div class="vb-form-row">
              <label for="tamperTestOnly">Only run selected plugin:</label>
              <input id="tamperTestOnly" v-model="tamperTestOnlyPlugin" type="checkbox" />
            </div>
            <div class="vb-form-row">
              <label for="tamperTestPlugin">Plugin:</label>
              <select id="tamperTestPlugin" v-model="tamperTestPluginKey">
                <option v-for="plugin in tamperPlugins" :key="plugin.key" :value="plugin.key">
                  {{ plugin.label }}
                </option>
              </select>
            </div>
            <template v-if="tamperTestPluginKey === 'prompt.enhancer'">
              <div class="vb-form-row">
                <label for="tamperTestEnhancerTrigger">Trigger token (blank = always):</label>
                <input
                  id="tamperTestEnhancerTrigger"
                  v-model="tamperTestEnhancerTrigger"
                  type="text"
                  placeholder="[[gather]]"
                />
              </div>
              <div class="vb-form-row">
                <label for="tamperTestEnhancerOnlyFirst">Only first message:</label>
                <input id="tamperTestEnhancerOnlyFirst" v-model="tamperTestEnhancerOnlyFirst" type="checkbox" />
              </div>
              <div class="vb-form-row">
                <label for="tamperTestEnhancerStripTrigger">Strip trigger:</label>
                <input id="tamperTestEnhancerStripTrigger" v-model="tamperTestEnhancerStripTrigger" type="checkbox" />
              </div>
              <div class="vb-form-row">
                <label for="tamperTestEnhancerMaxDocs">Max docs:</label>
                <input id="tamperTestEnhancerMaxDocs" v-model="tamperTestEnhancerMaxDocs" type="number" />
              </div>
              <div class="vb-form-row">
                <label for="tamperTestEnhancerPerKind">Per-kind limit:</label>
                <input id="tamperTestEnhancerPerKind" v-model="tamperTestEnhancerPerKindLimit" type="number" />
              </div>
              <div class="vb-form-row">
                <label for="tamperTestEnhancerMaxChars">Max preface chars:</label>
                <input id="tamperTestEnhancerMaxChars" v-model="tamperTestEnhancerMaxPrefaceChars" type="number" />
              </div>
              <div class="vb-form-row">
                <label for="tamperTestEnhancerSkillsRoot">Skills root:</label>
                <input
                  id="tamperTestEnhancerSkillsRoot"
                  v-model="tamperTestEnhancerSkillsRoot"
                  type="text"
                />
              </div>
              <div class="vb-form-row">
                <label for="tamperTestEnhancerKbRoot">KB root:</label>
                <input
                  id="tamperTestEnhancerKbRoot"
                  v-model="tamperTestEnhancerKbRoot"
                  type="text"
                />
              </div>
            </template>
            <div class="vb-modal-actions">
              <button class="vb-btn" :disabled="tamperTesting" @click="runTamperTest">
                {{ tamperTesting ? 'Testing...' : 'Run Test' }}
              </button>
            </div>
          </div>

          <div v-if="tamperTestResult" class="vb-admin-info">
            <h5 class="vb-admin-subsection-title">Test Result</h5>
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Tampered:</span>
              <span>{{ tamperTestResult.tampered ? 'Yes' : 'No' }}</span>
            </div>
            <div class="vb-form-row">
              <label>Output text:</label>
              <textarea :value="tamperTestResult.outputText" rows="6" readonly />
            </div>
            <div v-if="tamperTestResult.trail.length > 0">
              <h6 class="vb-admin-subsection-title">Trail</h6>
              <table class="vb-admin-table">
                <thead>
                  <tr>
                    <th>Plugin</th>
                    <th>Stage</th>
                    <th>Changed</th>
                    <th>Duration (ms)</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(entry, idx) in tamperTestResult.trail" :key="entry.pluginKey + entry.stage + idx">
                    <td>{{ entry.pluginKey }}</td>
                    <td>{{ entry.stage }}</td>
                    <td>{{ entry.changed ? 'Yes' : 'No' }}</td>
                    <td>{{ entry.durationMs }}</td>
                    <td>{{ entry.error || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="editingTamperConfig" class="vb-modal-overlay">
            <div class="vb-modal">
              <h4>Edit Tamper Config</h4>
              <div class="vb-form-row">
                <label>Plugin:</label>
                <input :value="editingTamperConfig.pluginKey" type="text" readonly />
              </div>
              <div class="vb-form-row">
                <label for="editTamperForumId">Forum scope:</label>
                <select id="editTamperForumId" v-model="editTamperForumId">
                  <option :value="null">Global (all forums)</option>
                  <option v-for="forum in forums" :key="forum.id" :value="forum.id">
                    {{ forum.name }}
                  </option>
                </select>
              </div>
              <div class="vb-form-row">
                <label for="editTamperEnabled">Enabled:</label>
                <input id="editTamperEnabled" v-model="editTamperEnabled" type="checkbox" />
              </div>
              <div class="vb-form-row">
                <label for="editTamperPriority">Priority:</label>
                <input id="editTamperPriority" v-model="editTamperPriority" type="number" />
              </div>
              <div class="vb-form-row">
                <label for="editTamperDirection">Direction:</label>
                <select
                  id="editTamperDirection"
                  v-model="editTamperDirection"
                  :disabled="getTamperDirectionOptions(editingTamperConfig.pluginKey).length === 1"
                >
                  <option
                    v-for="direction in getTamperDirectionOptions(editingTamperConfig.pluginKey)"
                    :key="direction"
                    :value="direction"
                  >
                    {{ direction }}
                  </option>
                </select>
              </div>
              <div class="vb-form-row">
                <label for="editTamperOnlyFirst">Run only on first message:</label>
                <input id="editTamperOnlyFirst" v-model="editTamperOnlyFirstMessage" type="checkbox" />
              </div>
              <template v-if="editingTamperConfig.pluginKey === 'prompt.enhancer'">
                <div class="vb-form-row">
                  <label for="editTamperEnhancerTrigger">Trigger token (blank = always):</label>
                  <input
                    id="editTamperEnhancerTrigger"
                    v-model="editTamperEnhancerTrigger"
                    type="text"
                  />
                </div>
                <div class="vb-form-row">
                  <label for="editTamperEnhancerStripTrigger">Strip trigger:</label>
                  <input id="editTamperEnhancerStripTrigger" v-model="editTamperEnhancerStripTrigger" type="checkbox" />
                </div>
                <div class="vb-form-row">
                  <label for="editTamperEnhancerMaxDocs">Max docs:</label>
                  <input id="editTamperEnhancerMaxDocs" v-model="editTamperEnhancerMaxDocs" type="number" />
                </div>
                <div class="vb-form-row">
                  <label for="editTamperEnhancerPerKind">Per-kind limit:</label>
                  <input id="editTamperEnhancerPerKind" v-model="editTamperEnhancerPerKindLimit" type="number" />
                </div>
                <div class="vb-form-row">
                  <label for="editTamperEnhancerMaxChars">Max preface chars:</label>
                  <input id="editTamperEnhancerMaxChars" v-model="editTamperEnhancerMaxPrefaceChars" type="number" />
                </div>
                <div class="vb-form-row">
                  <label for="editTamperEnhancerSkillsRoot">Skills root:</label>
                  <input id="editTamperEnhancerSkillsRoot" v-model="editTamperEnhancerSkillsRoot" type="text" />
                </div>
                <div class="vb-form-row">
                  <label for="editTamperEnhancerKbRoot">KB root:</label>
                  <input id="editTamperEnhancerKbRoot" v-model="editTamperEnhancerKbRoot" type="text" />
                </div>
              </template>
              <div class="vb-modal-actions">
                <button class="vb-btn" :disabled="savingTamperConfig" @click="saveTamperConfig">
                  {{ savingTamperConfig ? 'Saving...' : 'Save' }}
                </button>
                <button class="vb-btn vb-btn-secondary" @click="closeEditTamperConfig">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Deploy Tab -->
      <div v-if="activeTab === 'deploy'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Deploy & Restart</h3>

        <div v-if="deployError" class="vb-login-error">{{ deployError }}</div>

        <div v-if="deployLoading" class="vb-admin-loading">Loading deploy status...</div>

        <template v-else>
          <div class="vb-admin-status">
            <span class="vb-admin-status-label">Deploy enabled:</span>
            <span>{{ deployStatus?.enabled ? 'Yes' : 'No' }}</span>
          </div>

          <div v-if="deployStatus?.commitSha" class="vb-admin-info">
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Commit:</span>
              <code class="vb-cwd-path" :title="deployStatus.commitSha">{{ deployStatus.commitSha }}</code>
            </div>
          </div>

          <div v-if="deployStatus?.scriptPath" class="vb-admin-info">
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Script:</span>
              <code class="vb-cwd-path" :title="deployStatus.scriptPath">{{ deployStatus.scriptPath }}</code>
            </div>
          </div>

          <div v-if="deployStatus?.logPath" class="vb-admin-info">
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Log:</span>
              <code class="vb-cwd-path" :title="deployStatus.logPath">{{ deployStatus.logPath }}</code>
            </div>
          </div>

          <div v-if="deployStatus?.lastStartedAt" class="vb-admin-info">
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Last started:</span>
              <span>{{ new Date(deployStatus.lastStartedAt).toLocaleString() }}</span>
            </div>
          </div>

          <div v-if="deployStatus?.lastFinishedAt" class="vb-admin-info">
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Last finished:</span>
              <span>{{ new Date(deployStatus.lastFinishedAt).toLocaleString() }}</span>
            </div>
          </div>

          <div v-if="deployStatus?.lastExitCode !== undefined && deployStatus?.lastExitCode !== null" class="vb-admin-info">
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Last exit code:</span>
              <span>{{ deployStatus.lastExitCode }}</span>
            </div>
          </div>

          <div v-if="deployStatus?.lastError" class="vb-admin-info">
            <div class="vb-admin-info-row">
              <span class="vb-admin-info-label">Last error:</span>
              <span>{{ deployStatus.lastError }}</span>
            </div>
          </div>

          <div v-if="deployStatus?.running" class="vb-admin-status">
            <span class="vb-admin-status-label">Status:</span>
            <span>Deploy in progress...</span>
          </div>

          <p v-if="!deployStatus?.enabled" class="vb-form-hint">
            Set CODEX_FORUM_DEPLOY_SCRIPT on the server to enable one-click deploys.
          </p>

          <div v-if="deployMessage" class="vb-admin-status">
            <span class="vb-admin-status-label">Info:</span>
            <span>{{ deployMessage }}</span>
          </div>

          <div class="vb-modal-actions">
            <button
              class="vb-btn"
              :disabled="deployTriggering || !deployStatus?.enabled || deployStatus?.running"
              @click="triggerDeploy"
            >
              {{ deployTriggering ? 'Deploying...' : deployStatus?.running ? 'Deploying...' : 'Deploy Latest Code' }}
            </button>
            <button
              class="vb-btn vb-btn-secondary"
              :disabled="deployLoading"
              @click="loadDeployStatus"
            >
              Refresh Status
            </button>
          </div>
        </template>
      </div>

      <!-- Sync Health Tab -->
      <div v-if="activeTab === 'sync'" class="vb-admin-panel">
        <h3 class="vb-admin-section-title">Pi Sync Health</h3>
        <p class="vb-form-hint">
          Tracks bounded Pi/forum projection anomalies so failed live-topic imports are visible and repairable without making the hot sync loop retry forever.
        </p>

        <div v-if="piSyncError" class="vb-login-error">{{ piSyncError }}</div>
        <div v-if="piSyncMessage" class="vb-admin-status"><span>{{ piSyncMessage }}</span></div>
        <div v-if="piSyncLoading" class="vb-admin-loading">Loading sync health...</div>

        <template v-else>
          <div class="vb-admin-info">
            <div class="vb-admin-info-row"><span class="vb-admin-info-label">Enabled:</span><span>{{ piSyncHealth?.enabled ? 'Yes' : 'No' }}</span></div>
            <div class="vb-admin-info-row"><span class="vb-admin-info-label">Running:</span><span>{{ piSyncHealth?.running ? 'Yes' : 'No' }}</span></div>
            <div class="vb-admin-info-row"><span class="vb-admin-info-label">Last run:</span><span>{{ formatMaybeDate(piSyncHealth?.lastRunFinishedAt) }}</span></div>
            <div class="vb-admin-info-row"><span class="vb-admin-info-label">Deferred:</span><span>{{ piSyncHealth?.counts.deferred ?? 0 }}</span></div>
            <div class="vb-admin-info-row"><span class="vb-admin-info-label">Needs review:</span><span>{{ piSyncHealth?.counts.needs_manual_review ?? 0 }}</span></div>
            <div v-if="piSyncHealth?.lastRunError" class="vb-admin-info-row"><span class="vb-admin-info-label">Last error:</span><span>{{ piSyncHealth.lastRunError }}</span></div>
          </div>

          <div class="vb-modal-actions">
            <button class="vb-btn" :disabled="piSyncAction || piSyncHealth?.running" @click="runPiSync()">
              {{ piSyncAction || piSyncHealth?.running ? 'Rescanning...' : 'Rescan All Sessions' }}
            </button>
            <button class="vb-btn vb-btn-secondary" :disabled="piSyncLoading" @click="loadPiSyncHealth">Refresh</button>
          </div>

          <div v-if="!piSyncHealth?.anomalies.length" class="vb-admin-empty">No active sync anomalies.</div>
          <div v-else class="vb-admin-table-scroll" aria-label="Pi sync anomalies table">
            <table class="vb-admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Topic</th>
                  <th>Role</th>
                  <th>First seen</th>
                  <th>Retries</th>
                  <th>Preview</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="anomaly in piSyncHealth.anomalies" :key="anomaly.id">
                  <td>{{ anomaly.status }}</td>
                  <td><router-link :to="{ name: 'topic.view', params: { topicId: anomaly.topicId } }">{{ anomaly.topicTitle || anomaly.topicId }}</router-link></td>
                  <td>{{ anomaly.role || '—' }}</td>
                  <td>{{ formatMaybeDate(anomaly.firstSeenAt) }}</td>
                  <td>{{ anomaly.retryCount }}</td>
                  <td>{{ anomaly.preview || anomaly.piMessageId }}</td>
                  <td>
                    <div class="vb-inline-actions">
                      <button class="vb-small-btn" :disabled="piSyncAction" @click="runPiSync(anomaly.piSessionId)">Rescan Session</button>
                      <button class="vb-small-btn" :disabled="piSyncAction" @click="backfillPiSyncAnomaly(anomaly.id, false)">Backfill Silent</button>
                      <button class="vb-small-btn" :disabled="piSyncAction" @click="backfillPiSyncAnomaly(anomaly.id, true)">Backfill + Bump</button>
                      <button class="vb-small-btn vb-danger-btn" :disabled="piSyncAction" @click="ignorePiSyncAnomaly(anomaly.id)">Ignore</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- Robot Automations Tab -->
      <div v-if="activeTab === 'robots'" class="vb-admin-panel">
        <!-- Robot Settings Section -->
        <h3 class="vb-admin-section-title">Robot Settings</h3>
        <div class="vb-admin-mapping-form" style="margin-bottom: 2rem;">
          <div class="vb-form-row">
            <label for="maxConcurrentTurns">Max Concurrent Turns:</label>
            <input
              id="maxConcurrentTurns"
              v-model.number="robotSettings.maxConcurrentTurns"
              type="number"
              min="1"
              max="100"
              style="width: 80px;"
              @change="updateRobotSettings"
            />
            <span class="vb-form-hint" style="margin-left: 1rem;">
              Currently active: {{ robotSettings.activeTurnsCount }} / {{ robotSettings.maxConcurrentTurns }}
            </span>
          </div>
        </div>

        <h3 class="vb-admin-section-title">Robot Automations</h3>

        <div v-if="robotAutomationsError" class="vb-login-error">{{ robotAutomationsError }}</div>

        <div v-if="loadingRobotAutomations" class="vb-admin-loading">Loading automations...</div>

        <template v-else>
          <div v-if="robotAutomations.length === 0" class="vb-admin-empty">
            No automations found.
          </div>

          <table v-else class="vb-admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Forum</th>
                <th>Worker</th>
                <th>Model</th>
                <th>Enabled</th>
                <th>Run Mode</th>
                <th>Last Run</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="automation in robotAutomations" :key="automation.id">
                <td>{{ automation.name }}</td>
                <td>{{ automation.forumId ? getForumName(automation.forumId) : 'All forums' }}</td>
                <td>{{ automation.worker }}</td>
                <td>{{ automation.model || 'Default' }}</td>
                <td>{{ automation.enabled ? 'Yes' : 'No' }}</td>
                <td>{{ automation.runMode }}<span v-if="automation.runMode === 'interval'"> / {{ automation.intervalMinutes }}m</span></td>
                <td>{{ automation.lastRunAt ? formatDateTime(automation.lastRunAt) : '—' }}</td>
                <td>
                  <div class="vb-action-buttons">
                    <button
                      class="vb-btn vb-btn-small"
                      :disabled="runningAutomationId === automation.id"
                      @click="runRobotAutomation(automation.id)"
                    >
                      {{ runningAutomationId === automation.id ? 'Running...' : 'Run' }}
                    </button>
                    <button
                      class="vb-btn vb-btn-small vb-btn-secondary"
                      @click="openAutomationRuns(automation.id)"
                    >
                      Runs
                    </button>
                    <template v-if="deletingAutomationId === automation.id">
                      <button
                        class="vb-btn vb-btn-small vb-btn-danger"
                        @click="deleteRobotAutomation(automation.id)"
                      >
                        Confirm
                      </button>
                      <button
                        class="vb-btn vb-btn-small vb-btn-secondary"
                        @click="deletingAutomationId = null"
                      >
                        Cancel
                      </button>
                    </template>
                    <template v-else>
                      <button
                        class="vb-btn vb-btn-small"
                        @click="openEditAutomation(automation)"
                      >
                        Edit
                      </button>
                      <button
                        class="vb-btn vb-btn-small vb-btn-danger"
                        @click="deletingAutomationId = automation.id"
                      >
                        Delete
                      </button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="vb-admin-mapping-form">
            <h5>Create Automation</h5>
            <div class="vb-form-row">
              <label for="newAutomationName">Name:</label>
              <input
                id="newAutomationName"
                v-model="newAutomationName"
                type="text"
                placeholder="Automation name"
              />
            </div>
            <div class="vb-form-row">
              <label for="newAutomationForum">Forum:</label>
              <select id="newAutomationForum" v-model="newAutomationForumId">
                <option value="">All forums</option>
                <option v-for="forum in forums" :key="forum.id" :value="forum.id">{{ forum.name }}</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="newAutomationPrompt">Prompt:</label>
              <textarea
                id="newAutomationPrompt"
                v-model="newAutomationPrompt"
                rows="6"
                placeholder="Describe what the robot should do"
              />
            </div>
            <div class="vb-form-row">
              <label for="newAutomationEnabled">Enabled:</label>
              <input id="newAutomationEnabled" v-model="newAutomationEnabled" type="checkbox" />
            </div>
            <div class="vb-form-row">
              <label for="newAutomationWorker">Worker:</label>
              <select id="newAutomationWorker" v-model="newAutomationWorker">
                <option value="echs">echs</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="newAutomationModel">Model:</label>
              <select id="newAutomationModel" v-model="newAutomationModel">
                <option v-for="option in newAutomationModelOptions" :key="option.value || 'default'" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div v-if="showNewAutomationReasoning" class="vb-form-row">
              <label for="newAutomationReasoning">Reasoning Effort:</label>
              <select id="newAutomationReasoning" v-model="newAutomationReasoningEffort">
                <option value="">Default</option>
                <option v-for="option in newAutomationReasoningOptions" :key="option" :value="option">
                  {{ formatReasoningLabel(option) }}
                </option>
              </select>
            </div>
            <div v-else class="vb-form-row">
              <label for="newAutomationReasoning">Reasoning Effort:</label>
              <select id="newAutomationReasoning" disabled>
                <option value="">n/a</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="newAutomationRunMode">Run Mode:</label>
              <select id="newAutomationRunMode" v-model="newAutomationRunMode">
                <option value="manual">manual</option>
                <option value="interval">interval</option>
              </select>
            </div>
            <div v-if="newAutomationRunMode === 'interval'" class="vb-form-row">
              <label for="newAutomationInterval">Interval (minutes):</label>
              <input
                id="newAutomationInterval"
                v-model.number="newAutomationIntervalMinutes"
                type="number"
                min="1"
              />
            </div>
            <div class="vb-modal-actions">
              <button
                class="vb-btn"
                :disabled="creatingAutomation"
                @click="createRobotAutomation"
              >
                {{ creatingAutomation ? 'Creating...' : 'Create Automation' }}
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- Edit Automation Modal -->
      <div v-if="editingAutomation" class="vb-modal-overlay" @click.self="closeEditAutomation">
        <div class="vb-modal">
          <div class="vb-modal-header">
            <h3>Edit Automation</h3>
            <button class="vb-modal-close" @click="closeEditAutomation">&times;</button>
          </div>
          <div class="vb-modal-body">
            <div v-if="robotAutomationsError" class="vb-login-error">{{ robotAutomationsError }}</div>
            <div class="vb-form-row">
              <label for="editAutomationName">Name:</label>
              <input id="editAutomationName" v-model="editAutomationName" type="text" />
            </div>
            <div class="vb-form-row">
              <label for="editAutomationForum">Forum:</label>
              <select id="editAutomationForum" v-model="editAutomationForumId">
                <option value="">All forums</option>
                <option v-for="forum in forums" :key="forum.id" :value="forum.id">{{ forum.name }}</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="editAutomationPrompt">Prompt:</label>
              <textarea id="editAutomationPrompt" v-model="editAutomationPrompt" rows="6"></textarea>
            </div>
            <div class="vb-form-row">
              <label for="editAutomationEnabled">Enabled:</label>
              <input id="editAutomationEnabled" v-model="editAutomationEnabled" type="checkbox" />
            </div>
            <div class="vb-form-row">
              <label for="editAutomationWorker">Worker:</label>
              <select id="editAutomationWorker" v-model="editAutomationWorker">
                <option value="echs">echs</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="editAutomationModel">Model:</label>
              <select id="editAutomationModel" v-model="editAutomationModel">
                <option v-for="option in editAutomationModelOptions" :key="option.value || 'default'" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div v-if="showEditAutomationReasoning" class="vb-form-row">
              <label for="editAutomationReasoning">Reasoning Effort:</label>
              <select id="editAutomationReasoning" v-model="editAutomationReasoningEffort">
                <option value="">Default</option>
                <option v-for="option in editAutomationReasoningOptions" :key="option" :value="option">
                  {{ formatReasoningLabel(option) }}
                </option>
              </select>
            </div>
            <div v-else class="vb-form-row">
              <label for="editAutomationReasoning">Reasoning Effort:</label>
              <select id="editAutomationReasoning" disabled>
                <option value="">n/a</option>
              </select>
            </div>
            <div class="vb-form-row">
              <label for="editAutomationRunMode">Run Mode:</label>
              <select id="editAutomationRunMode" v-model="editAutomationRunMode">
                <option value="manual">manual</option>
                <option value="interval">interval</option>
              </select>
            </div>
            <div v-if="editAutomationRunMode === 'interval'" class="vb-form-row">
              <label for="editAutomationInterval">Interval (minutes):</label>
              <input
                id="editAutomationInterval"
                v-model.number="editAutomationIntervalMinutes"
                type="number"
                min="1"
              />
            </div>
          </div>
          <div class="vb-modal-actions">
            <button
              class="vb-btn"
              :disabled="savingAutomation"
              @click="saveAutomationEdit"
            >
              {{ savingAutomation ? 'Saving...' : 'Save Changes' }}
            </button>
            <button class="vb-btn vb-btn-secondary" @click="closeEditAutomation">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Automation Runs Modal -->
      <div v-if="runsAutomationId" class="vb-modal-overlay" @click.self="closeAutomationRuns">
        <div class="vb-modal">
          <div class="vb-modal-header">
            <h3>Automation Runs</h3>
            <button class="vb-modal-close" @click="closeAutomationRuns">&times;</button>
          </div>
          <div class="vb-modal-body">
            <div v-if="loadingAutomationRuns" class="vb-admin-loading">Loading runs...</div>
            <template v-else>
              <div v-if="automationRuns.length === 0" class="vb-admin-empty">
                No runs recorded yet.
              </div>
              <table v-else class="vb-admin-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Finished</th>
                    <th>Exit</th>
                    <th>Summary</th>
                    <th>Log</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="run in automationRuns" :key="run.id" :class="{ 'vb-admin-row-active': run.id === selectedAutomationRunId }">
                    <td>{{ run.status }}</td>
                    <td>{{ formatDateTime(run.startedAt) }}</td>
                    <td>{{ run.finishedAt ? formatDateTime(run.finishedAt) : '—' }}</td>
                    <td>{{ run.exitCode ?? '—' }}</td>
                    <td>{{ run.outputSummary || run.lastMessage || '—' }}</td>
                    <td>
                      <button class="vb-btn vb-btn-small" @click="selectAutomationRun(run)">View</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="selectedAutomationRun" class="vb-admin-log-panel">
                <div class="vb-admin-log-header">
                  <strong>Automation Log</strong>
                  <span class="vb-admin-log-meta">
                    {{ selectedAutomationRun.status }} · {{ formatDateTime(selectedAutomationRun.startedAt) }}
                  </span>
                  <button class="vb-btn vb-btn-small vb-btn-secondary" :disabled="automationLogLoading" @click="loadAutomationLog({ reset: true, tail: true })">
                    {{ automationLogLoading ? 'Loading...' : 'Refresh Log' }}
                  </button>
                </div>
                <div v-if="automationLogError" class="vb-login-error">{{ automationLogError }}</div>
                <div v-else-if="automationLogLoading && !automationLogContent" class="vb-admin-loading">Loading log...</div>
                <pre class="vb-admin-log-output">{{ automationLogContent || 'No log output yet.' }}</pre>
                <div v-if="selectedAutomationRun.status === 'running'" class="vb-admin-log-hint">Auto-refreshing while run is active.</div>
              </div>
            </template>
          </div>
          <div class="vb-modal-actions">
            <button class="vb-btn vb-btn-secondary" @click="closeAutomationRuns">Close</button>
          </div>
        </div>
      </div>

      <!-- Back button -->
      <div class="vb-admin-footer">
        <button class="vb-btn vb-btn-secondary" @click="goHome">Back to Forum</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-admin-content {
  background: var(--bg-surface-alt);
  padding: 16px;
  border: 1px solid var(--border-muted);
  min-width: 0;
}

.vb-admin-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 2px solid var(--brand-secondary);
}

.vb-admin-tab {
  padding: 10px 20px;
  background: linear-gradient(var(--bg-surface-alt), var(--bg-surface-muted));
  border: 1px solid var(--border-muted);
  border-bottom: none;
  cursor: pointer;
  font-weight: bold;
  color: var(--text-secondary);
  transition: all 0.15s ease;
  border-radius: 4px 4px 0 0;
  position: relative;
  top: 1px;
}

.vb-admin-tab:hover:not(.active) {
  background: linear-gradient(var(--bg-surface-muted), var(--border-default));
  color: var(--brand-secondary);
}

.vb-admin-tab.active {
  background: linear-gradient(var(--grad-nav-start), var(--grad-nav-end));
  color: var(--text-inverse);
  border-color: var(--brand-secondary);
  box-shadow: 0 -2px 4px var(--shadow-color);
}

.vb-admin-panel {
  background: var(--bg-surface);
  border: 1px solid var(--border-muted);
  padding: 16px;
  margin-bottom: 16px;
  min-width: 0;
}

.vb-admin-row-active {
  background: var(--bg-surface-alt);
}

.vb-admin-log-panel {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface-alt);
}

.vb-admin-log-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.vb-admin-log-meta {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.vb-admin-log-output {
  background: var(--bg-surface);
  border: 1px solid var(--border-muted);
  padding: 8px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
}

.vb-admin-log-hint {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.vb-admin-skill-meta {
  margin-bottom: 12px;
  padding: 10px 12px;
  background: var(--bg-surface-alt);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
}

.vb-admin-skill-summary {
  margin: 8px 0 12px 0;
  color: var(--text-secondary);
}

.vb-admin-skill-excerpt {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  max-width: 560px;
}

.vb-admin-skill-availability {
  margin: 0;
  padding-left: 18px;
}

.vb-admin-skill-availability li {
  margin-bottom: 8px;
}

.vb-admin-muted {
  color: var(--text-muted);
  font-size: 12px;
}

.vb-admin-section-title {
  margin: 0 0 16px 0;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--brand-secondary);
  color: var(--brand-accent);
  font-size: 16px;
}

.vb-admin-subsection-title {
  margin: 24px 0 12px 0;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
  color: var(--brand-accent);
  font-size: 14px;
}

.vb-admin-status {
  margin-bottom: 16px;
  padding: 12px 16px;
  background: linear-gradient(var(--bg-surface-alt), var(--bg-surface-alt));
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  display: flex;
  align-items: center;
}

.vb-admin-status-label {
  font-weight: bold;
  margin-right: 8px;
}

.vb-status-connected {
  color: var(--status-success);
  font-weight: bold;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.vb-status-connected::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  background: var(--status-success);
  border-radius: 50%;
  animation: pulse-dot 2s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.vb-status-disconnected {
  color: var(--status-error);
  font-weight: bold;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.vb-status-disconnected::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  background: var(--status-error);
  border-radius: 50%;
}

.vb-admin-info {
  margin-bottom: 16px;
}

.vb-admin-info-row {
  margin-bottom: 8px;
}

.vb-admin-info-label {
  display: inline-block;
  font-weight: bold;
  width: 120px;
}

.vb-admin-form {
  margin-bottom: 16px;
}

.vb-form-row {
  margin-bottom: 12px;
}

.vb-form-row-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.vb-form-row-header label {
  margin-bottom: 0;
}

.vb-form-row label {
  display: block;
  font-weight: bold;
  margin-bottom: 4px;
}

.vb-form-row input,
.vb-form-row select {
  width: 100%;
  max-width: 400px;
  padding: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text-primary);
}

.vb-form-row textarea {
  width: 100%;
  max-width: 100%;
  padding: 10px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.vb-form-hint {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.vb-char-count {
  font-size: 11px;
  color: var(--text-muted);
}

.vb-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
  user-select: none;
  cursor: pointer;
}

.vb-toggle input[type='checkbox'] {
  width: 14px;
  height: 14px;
}

.vb-prompt-editor {
  border: 1px solid var(--border-default);
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-surface);
  box-shadow: 0 1px 2px var(--shadow-color);
}

.vb-prompt-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  background: linear-gradient(var(--bg-surface-alt), var(--bg-surface-muted));
  border-bottom: 1px solid var(--border-default);
}

.vb-prompt-template {
  flex: 1;
  min-width: 220px;
  max-width: none;
}

.vb-prompt-toolbar-spacer {
  flex: 1;
}

.vb-prompt-textarea {
  border: none;
  border-radius: 0;
  padding: 12px;
  min-height: 160px;
  font-size: 12px;
}

.vb-prompt-textarea:focus {
  outline: none;
  box-shadow: inset 0 0 0 2px rgba(92, 112, 153, 0.25);
}

.vb-prompt-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-surface-alt);
}

.vb-prompt-preview {
  border-top: 1px solid var(--border-default);
  background: var(--bg-surface);
}

.vb-prompt-preview summary {
  cursor: pointer;
  padding: 10px 12px;
  font-weight: bold;
  font-size: 11px;
  color: var(--brand-accent);
  user-select: none;
}

.vb-prompt-preview-body {
  margin: 0;
  padding: 10px 12px 12px;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  background: var(--bg-input);
  border-top: 1px solid var(--border-default);
}

.vb-admin-table-scroll {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.vb-admin-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px var(--shadow-color);
}

.vb-admin-table th,
.vb-admin-table td {
  padding: 10px 14px;
  border: 1px solid var(--border-default);
  text-align: left;
}

.vb-admin-table th {
  background: linear-gradient(var(--grad-header-start), var(--grad-header-end));
  color: var(--text-inverse);
  font-weight: bold;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.vb-admin-table tr {
  transition: background-color 0.15s ease;
}

.vb-admin-table tr:nth-child(even) {
  background: var(--bg-surface-alt);
}

.vb-admin-table tr:hover {
  background: var(--bg-surface-hover);
}

.vb-admin-mapping-form {
  margin-top: 16px;
  padding: 16px;
  background: linear-gradient(var(--bg-surface-alt), var(--bg-surface-alt));
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
}

.vb-admin-mapping-form h5 {
  margin: 0 0 12px 0;
  color: var(--brand-accent);
  font-size: 13px;
}

.vb-admin-empty {
  padding: 16px;
  color: var(--text-muted);
  font-style: italic;
  text-align: center;
  background: var(--bg-surface-alt);
  border: 1px dashed var(--border-muted);
  border-radius: 4px;
}

.vb-admin-loading {
  padding: 16px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 10px;
}

.vb-admin-loading::before {
  content: '';
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-top-color: var(--brand-secondary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.vb-admin-footer {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-muted);
}

.vb-btn-danger {
  background: linear-gradient(var(--grad-danger-start), var(--grad-danger-end));
  color: var(--text-inverse);
  border: 1px solid var(--status-error);
  transition: all 0.15s ease;
}

.vb-btn-danger:hover {
  background: linear-gradient(var(--grad-danger-end), var(--status-error));
  transform: translateY(-1px);
  box-shadow: 0 2px 4px var(--shadow-color);
}

.vb-btn-danger:active {
  transform: translateY(0);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.2);
}

.vb-btn-small {
  padding: 6px 12px;
  font-size: 11px;
  border-radius: 3px;
}

/* Form input focus styles */
.vb-form-row input:focus,
.vb-form-row select:focus,
.vb-form-row textarea:focus {
  outline: none;
  border-color: var(--brand-secondary);
  box-shadow: 0 0 0 3px rgba(92, 112, 153, 0.2);
}

/* User kind badges */
.vb-user-kind {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: bold;
  text-transform: uppercase;
}

.vb-kind-human {
  background: var(--status-info-bg);
  color: var(--status-info);
}

.vb-kind-admin {
  background: var(--status-warning-bg);
  color: var(--status-warning);
}

.vb-kind-robot {
  background: var(--bg-surface-alt);
  color: var(--brand-primary);
}

.vb-kind-active {
  background: var(--status-success-light);
  color: var(--status-success);
}

.vb-kind-archived {
  background: var(--status-warning-bg);
  color: var(--status-warning);
}

/* Invite status badges */
.vb-invite-status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: bold;
  text-transform: uppercase;
}

.vb-status-active {
  background: var(--status-success-light);
  color: var(--status-success);
}

.vb-status-expired {
  background: var(--status-error-light);
  color: var(--status-error);
}

.vb-status-exhausted {
  background: var(--status-warning-bg);
  color: var(--status-warning);
}

/* Invite code styling */
.vb-invite-code {
  font-family: monospace;
  background: var(--bg-surface-alt);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
}

/* CWD path styling */
.vb-cwd-path {
  font-family: monospace;
  background: var(--status-info-bg);
  color: var(--status-info);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Action buttons */
.vb-action-buttons {
  display: flex;
  gap: 4px;
}

/* Secondary button */
.vb-btn-secondary {
  background: linear-gradient(var(--grad-secondary-start), var(--grad-secondary-end));
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
}

.vb-btn-secondary:hover {
  background: linear-gradient(var(--grad-secondary-end), var(--border-default));
}

/* Modal styles */
.vb-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--overlay-color);
  display: flex;
  /* Allow tall modals (like Edit Forum) to remain usable on small screens.
     We top-align the modal and make the overlay scrollable so the header isn't
     pushed off-screen. */
  align-items: flex-start;
  justify-content: center;
  padding: 24px 16px;
  overflow-y: auto;
  z-index: 1000;
}

.vb-modal {
  background: var(--bg-surface);
  border: 2px solid var(--brand-secondary);
  box-shadow: 0 4px 20px var(--shadow-strong);
  /* Responsive sizing: avoid horizontal overflow on mobile while keeping a
     comfortable width on desktop. */
  width: 100%;
  max-width: 500px;
  box-sizing: border-box;

  /* Constrain height to the viewport and let the body scroll so actions remain
     reachable. */
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 48px);
  /* Center when there's room; fall back to top alignment when content is tall. */
  margin-top: auto;
  margin-bottom: auto;
  animation: modal-appear 0.2s ease-out;
}

@supports (height: 100dvh) {
  .vb-modal {
    max-height: calc(100dvh - 48px);
  }
}

@keyframes modal-appear {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.vb-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: linear-gradient(var(--grad-header-start), var(--grad-header-end));
  color: var(--text-inverse);
}

.vb-modal-header h3 {
  margin: 0;
  font-size: 16px;
}

.vb-modal-close {
  background: none;
  border: none;
  color: var(--text-inverse);
  font-size: 24px;
  cursor: pointer;
  line-height: 1;
  padding: 0;
  opacity: 0.8;
}

.vb-modal-close:hover {
  opacity: 1;
}

.vb-modal-body {
  padding: 16px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.vb-modal .vb-modal-actions {
  padding: 12px 16px;
  background: var(--bg-surface-alt);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
