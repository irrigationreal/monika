<template>
  <section
    class="vb-topic-trace"
    :class="{ 'vb-topic-trace--preview': preview }"
    :aria-label="preview ? 'Live trace preview' : 'Trace'"
  >
    <div v-if="preview" class="vb-trace-preview-header">
      <div>
        <strong>Trace</strong>
        <span v-if="renderGroups.length > 0" class="vb-spinner vb-spinner-dark" aria-hidden="true"></span>
        <span class="vb-status-pill">{{ state.robotState.value?.activity ?? 'starting' }}</span>
      </div>
      <div class="vb-trace-preview-actions">
        <button class="vb-small-btn" type="button" @click="$emit('open')">Open Trace</button>
        <button class="vb-small-btn vb-btn-danger" type="button" :disabled="stopDisabled" @click="$emit('stop')">
          {{ stopDisabled ? 'Stopping…' : 'Stop Robot' }}
        </button>
      </div>
    </div>

    <div v-else class="vb-trace-controls">
      <button class="vb-small-btn" type="button" :aria-pressed="showReasoning" @click="showReasoning = !showReasoning">
        Reasoning: {{ showReasoning ? 'On' : 'Off' }}
      </button>
      <button class="vb-small-btn" type="button" :aria-label="traceDirectionLabel" @click="toggleTraceDirection">
        Order: {{ traceDirection === 'newest-first' ? 'Newest first' : 'Oldest first' }}
      </button>
      <button
        class="vb-small-btn"
        type="button"
        :disabled="state.adminEnrichmentLoading.value"
        @click="state.loadAdminEnrichment()"
      >
        Refresh
      </button>
    </div>

    <div v-if="state.adminEnrichmentLoading.value && traceGroups.length === 0" class="vb-empty" role="status">
      Loading Trace…
    </div>
    <div v-else-if="state.adminEnrichmentError.value && traceGroups.length === 0" class="vb-empty" role="alert">
      Trace unavailable: {{ state.adminEnrichmentError.value }}
    </div>
    <div v-else-if="renderGroups.length === 0" class="vb-empty" :aria-live="preview ? 'polite' : undefined">
      <template v-if="preview">
        <span class="vb-spinner vb-spinner-dark" aria-hidden="true"></span>
        Starting response…
      </template>
      <template v-else>No trace activity yet.</template>
    </div>

    <div v-for="group in renderGroups" :key="group.id" class="vb-tool-response">
      <div v-if="!preview && traceGroups.length > 1" class="vb-tool-response-label">
        Response · {{ state.formatDate(group.latestAt) }}
      </div>
      <template v-for="card in group.cards" :key="card.key">
        <div v-if="card.type === 'reasoning'" class="vb-tool-item vb-tool-item--reasoning">
          <button
            class="vb-tool-toggle vb-tool-toggle--compact"
            type="button"
            :aria-expanded="reasoningExpanded(card.key)"
            @click="toggleReasoning(card.key)"
          >
            <span class="vb-tool-toggle-left">
              <span class="vb-tool-reasoning-mini">
                <span class="vb-tool-reasoning-icon" aria-hidden="true">●</span>
                <span class="vb-tool-mini-name">{{ card.step.title || 'Thinking' }}</span>
                <span v-if="reasoningPreview(card.step.detail)" class="vb-tool-mini-summary">
                  {{ reasoningPreview(card.step.detail) }}
                </span>
              </span>
            </span>
            <span class="vb-tool-toggle-right">
              <span
                class="vb-tool-pill"
                :class="card.running ? 'vb-trace-tool-status--running' : 'vb-trace-tool-status--ok'"
              >
                {{ card.running ? 'thinking' : 'done' }}
              </span>
              <span class="vb-tool-toggle-icon">{{ reasoningExpanded(card.key) ? '−' : '+' }}</span>
            </span>
          </button>
          <div v-if="card.step.detail && reasoningExpanded(card.key)" class="vb-tool-details">
            <div
              class="vb-tool-block vb-tool-reasoning-detail vb-rendered-content"
              v-html="renderReasoning(card.step.detail)"
            ></div>
          </div>
        </div>

        <div v-else class="vb-tool-item">
          <button
            class="vb-tool-toggle vb-tool-toggle--compact"
            type="button"
            :aria-expanded="toolExpanded(card.tool.id)"
            @click="toggleTool(card.tool.id)"
          >
            <span class="vb-tool-toggle-left">
              <ToolMiniView :tool="card.tool" :showDetail="true" />
            </span>
            <span class="vb-tool-toggle-right">
              <span class="vb-tool-meta">{{ state.formatToolTime(card.tool.startedAt) }}</span>
              <span v-if="toolDurationLabel(card.tool)" class="vb-tool-duration">{{
                toolDurationLabel(card.tool)
              }}</span>
              <span class="vb-tool-pill" :class="toolStatusClass(card.tool)">{{ toolStatusLabel(card.tool) }}</span>
              <span class="vb-tool-toggle-icon">{{ toolExpanded(card.tool.id) ? '−' : '+' }}</span>
            </span>
          </button>
          <div v-if="toolExpanded(card.tool.id)" class="vb-tool-details">
            <div v-if="toolMini(card.tool).input" class="vb-tool-block">
              <div class="vb-tool-block-title">Input</div>
              <pre class="vb-tool-pre">{{ toolMini(card.tool).input }}</pre>
            </div>
            <div v-if="toolMini(card.tool).output" class="vb-tool-block">
              <div class="vb-tool-block-title">Output</div>
              <pre class="vb-tool-pre">{{ toolMini(card.tool).output }}</pre>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div v-if="preview && activeCardCount > previewCardLimit" class="vb-tool-hint">
      Showing the latest {{ previewCardLimit }} trace entries.
    </div>
    <div
      v-if="!preview && state.adminEnrichmentLoading.value && traceGroups.length > 0"
      class="vb-tool-hint"
      role="status"
    >
      Refreshing Trace…
    </div>
    <div
      v-if="!preview && state.adminEnrichmentError.value && traceGroups.length > 0"
      class="vb-tool-hint"
      role="alert"
    >
      Trace refresh failed; showing the most recent available data.
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { useForumState } from '../composables/useForumState';
import { useMarkdown } from '../composables/useMarkdown';
import { getToolMiniModel } from '../lib/toolMiniView';
import { buildLiveTraceItems, buildPersistedTraceItems } from '../lib/unifiedTrace';
import ToolMiniView from './ToolMiniView.vue';

import type { ToolRunDto, TopicTraceDto } from '../lib/apiClient';
import type { ReasoningStep } from '../lib/reasoning';
import type { UnifiedTraceItem } from '../lib/unifiedTrace';

const props = withDefaults(
  defineProps<{
    preview?: boolean;
    previewCardLimit?: number;
    stopDisabled?: boolean;
    topicId?: string | null;
  }>(),
  {
    preview: false,
    previewCardLimit: 3,
    stopDisabled: false,
    topicId: null,
  }
);

defineEmits<{ open: []; stop: [] }>();

const state = useForumState();
const { renderContent } = useMarkdown();
const reasoningPreferenceKey = 'codex-forum:trace:show-reasoning';
const legacyReasoningPreferenceKey = 'codex-forum:tool-usage:show-reasoning';
const showReasoning = ref(readReasoningPreference());
type TraceDirection = 'newest-first' | 'oldest-first';
const traceDirection = ref<TraceDirection>('newest-first');
const traceDirectionLabel = computed(() =>
  traceDirection.value === 'newest-first'
    ? 'Trace order: newest first. Activate to show oldest first.'
    : 'Trace order: oldest first. Activate to show newest first.'
);
const expandedReasoning = ref(new Set<string>());
const expandedTools = ref(new Set<string>());

type TracePlan = TopicTraceDto['plans'][number];
type TraceCard =
  | { type: 'reasoning'; key: string; step: ReasoningStep; running: boolean }
  | { type: 'tool'; key: string; tool: ToolRunDto };
interface TraceGroup {
  id: string;
  parentPostId: string | null;
  latestAt: string;
  live: boolean;
  cards: TraceCard[];
}
interface MutableGroup {
  id: string;
  parentPostId: string | null;
  latestAt: string;
  plan: TracePlan | null;
  tools: ToolRunDto[];
}

function readReasoningPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored =
      window.localStorage.getItem(reasoningPreferenceKey) ?? window.localStorage.getItem(legacyReasoningPreferenceKey);
    return stored !== 'false';
  } catch {
    return true;
  }
}

watch(showReasoning, (value) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(reasoningPreferenceKey, String(value));
  } catch {
    // The in-memory preference remains valid when storage is unavailable.
  }
});

function laterTimestamp(current: string, candidate: string | null | undefined): string {
  return candidate && candidate > current ? candidate : current;
}

function cardsForItems(groupId: string, items: UnifiedTraceItem[], live: boolean): TraceCard[] {
  const cards: TraceCard[] = [];
  for (const item of items) {
    if (item.type === 'tool') {
      cards.push({ type: 'tool', key: `${groupId}:tool:${item.tool.id}`, tool: item.tool });
      continue;
    }
    for (let index = 0; index < item.steps.length; index += 1) {
      const step = item.steps[index]!;
      cards.push({
        type: 'reasoning',
        key: `${groupId}:reasoning:${item.segmentIndex}:${index}`,
        step,
        running: live && items.at(-1) === item && index === item.steps.length - 1,
      });
    }
  }
  return cards;
}

const traceGroups = computed<TraceGroup[]>(() => {
  const planById = new Map<string, TracePlan>();
  for (const plan of state.topicTrace.value?.plans ?? []) planById.set(plan.id, plan);
  const currentPlan = state.robotState.value?.currentPlan ?? null;
  if (currentPlan) {
    const persisted = planById.get(currentPlan.id);
    planById.set(currentPlan.id, {
      ...persisted,
      ...currentPlan,
      parentPostId: currentPlan.parentPostId ?? persisted?.parentPostId ?? null,
    } as TracePlan);
  }

  const toolById = new Map<string, ToolRunDto>();
  for (const tool of state.topicTrace.value?.toolRuns ?? []) toolById.set(tool.id, tool);
  for (const tool of state.robotState.value?.recentToolRuns ?? []) toolById.set(tool.id, tool);

  const groups = new Map<string, MutableGroup>();
  for (const plan of planById.values()) {
    const parentPostId = plan.parentPostId ?? null;
    const id = parentPostId ? `response:${parentPostId}` : `plan:${plan.id}`;
    const existing = groups.get(id);
    if (existing) {
      existing.latestAt = laterTimestamp(existing.latestAt, plan.updatedAt);
      if (!existing.plan || plan.updatedAt > existing.plan.updatedAt) existing.plan = plan;
    } else {
      groups.set(id, { id, parentPostId, latestAt: plan.updatedAt ?? plan.createdAt ?? '', plan, tools: [] });
    }
  }

  for (const tool of toolById.values()) {
    const parentPostId = tool.parentPostId ?? null;
    const id = parentPostId ? `response:${parentPostId}` : `tool:${tool.id}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, parentPostId, latestAt: tool.finishedAt ?? tool.startedAt, plan: null, tools: [] };
      groups.set(id, group);
    }
    group.tools.push(tool);
    group.latestAt = laterTimestamp(group.latestAt, tool.finishedAt ?? tool.startedAt);
  }

  const active = Boolean(state.robotState.value && state.robotState.value.activity !== 'idle');
  const activeParentPostId = currentPlan?.parentPostId ?? null;
  return [...groups.values()]
    .map((group) => {
      const live = Boolean(
        active &&
        currentPlan &&
        (activeParentPostId ? group.parentPostId === activeParentPostId : group.plan?.id === currentPlan.id)
      );
      let items = live
        ? buildLiveTraceItems({
            segments: state.committedSegments.value,
            reasoningDraft: state.reasoningDraft.value,
            tools: group.tools,
          })
        : [];
      if (items.length === 0)
        items = buildPersistedTraceItems({
          reasoningText: group.plan?.summary ?? group.plan?.content ?? null,
          reasoningCheckpoints: group.plan?.reasoningCheckpoints ?? null,
          tools: group.tools,
        });
      return { ...group, live, cards: cardsForItems(group.id, items, live) };
    })
    .filter((group) => group.cards.length > 0)
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
});

const activeGroup = computed(() => traceGroups.value.find((group) => group.live) ?? null);
const activeCardCount = computed(() => activeGroup.value?.cards.length ?? 0);
const renderGroups = computed<TraceGroup[]>(() => {
  if (props.preview) {
    const group = activeGroup.value;
    if (!group) return [];
    return [{ ...group, cards: group.cards.slice(-props.previewCardLimit) }];
  }
  const groups = traceGroups.value
    .map((group) => ({
      ...group,
      cards: showReasoning.value ? [...group.cards] : group.cards.filter((card) => card.type === 'tool'),
    }))
    .filter((group) => group.cards.length > 0);
  if (traceDirection.value === 'oldest-first') return [...groups].reverse();
  return groups.map((group) => ({ ...group, cards: [...group.cards].reverse() }));
});

function toggleTraceDirection(): void {
  traceDirection.value = traceDirection.value === 'newest-first' ? 'oldest-first' : 'newest-first';
}

function compact(value: string | null | undefined, max = 140): string | null {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
function reasoningPreview(detail: string | null): string | null {
  return compact(detail);
}
function renderReasoning(detail: string): string {
  return renderContent(detail, { topicId: props.topicId });
}
function toggleReasoning(key: string): void {
  const next = new Set(expandedReasoning.value);
  next.has(key) ? next.delete(key) : next.add(key);
  expandedReasoning.value = next;
}
function reasoningExpanded(key: string): boolean {
  return expandedReasoning.value.has(key);
}
function toggleTool(id: string): void {
  const next = new Set(expandedTools.value);
  next.has(id) ? next.delete(id) : next.add(id);
  expandedTools.value = next;
}
function toolExpanded(id: string): boolean {
  return expandedTools.value.has(id);
}
function toolMini(tool: ToolRunDto) {
  return getToolMiniModel(tool);
}
function toolExitCodeValue(tool: { exitCode?: number | null; outputSummary?: string | null }): number | null {
  if (tool.exitCode !== null && tool.exitCode !== undefined) return tool.exitCode;
  const match =
    (tool.outputSummary ?? '').match(/Process exited with code\s+(-?\d+)/i) ??
    (tool.outputSummary ?? '').match(/Exit:\s*(-?\d+)/i);
  return match ? Number.parseInt(match[1]!, 10) : null;
}
function toolStatusLabel(tool: ToolRunDto): string {
  if (!tool.finishedAt) return 'running';
  const exitCode = toolExitCodeValue(tool);
  return exitCode === null ? 'done' : `exit ${exitCode}`;
}
function toolStatusClass(tool: ToolRunDto): string {
  if (!tool.finishedAt) return 'vb-trace-tool-status--running';
  const exitCode = toolExitCodeValue(tool);
  return exitCode === null || exitCode === 0 ? 'vb-trace-tool-status--ok' : 'vb-trace-tool-status--error';
}
function toolDurationLabel(tool: ToolRunDto): string | null {
  if (!tool.startedAt || !tool.finishedAt) return null;
  const durationMs = Math.max(0, new Date(tool.finishedAt).getTime() - new Date(tool.startedAt).getTime());
  if (!Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
</script>
