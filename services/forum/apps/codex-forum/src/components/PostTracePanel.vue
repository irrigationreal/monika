<template>
  <div class="vb-post-trace" :class="{ 'vb-trace-collapsed': !live && !expanded }">
    <!-- Collapsible header (saved mode only) -->
    <button v-if="!live" class="vb-trace-toggle" type="button" @click="expanded = !expanded">
      <span class="vb-trace-toggle-icon">{{ expanded ? '&#9660;' : '&#9654;' }}</span>
      <span>Trace History</span>
      <span class="vb-trace-summary" v-if="!expanded">
        ({{ toolRuns.length }} tool{{ toolRuns.length !== 1 ? 's' : '' }})
      </span>
    </button>

    <div v-if="expanded || live" class="vb-trace-body">
      <div class="vb-trace-stream">

        <!-- ═══ LIVE MODE REASONING ═══ -->
        <div
          v-if="live"
          class="vb-live-reasoning"
          :class="{
            'vb-live-reasoning--active': active && (latestReasoningTitle || reasoningSteps.length > 0),
            'vb-live-reasoning--idle': !active,
          }"
        >
          <div class="vb-live-reasoning-header">
            <span class="vb-live-turn-dot vb-live-turn-dot--running">◉</span>
            <span class="vb-live-reasoning-title"><DecryptText :text="latestReasoningTitle ?? 'Thinking'" /></span>
            <div v-if="active" class="vb-live-reasoning-indicator">
              <span class="vb-live-reasoning-dot"></span>
              <span class="vb-live-reasoning-dot"></span>
              <span class="vb-live-reasoning-dot"></span>
            </div>
          </div>
          <div class="vb-live-reasoning-body">
            <div v-if="latestReasoningDetail" class="vb-live-reasoning-text"><DecryptText :text="latestReasoningDetail" /></div>
            <div v-else class="vb-live-reasoning-empty">Waiting for reasoning...</div>
          </div>
          <!-- Previous steps history -->
          <div v-if="reasoningSteps.length > 0" class="vb-live-reasoning-footer">
            <button class="vb-live-reasoning-history-btn" @click="showHistory = !showHistory">
              <span class="vb-live-reasoning-history-dots">•••</span>
              <span>{{ reasoningSteps.length }} previous</span>
            </button>
          </div>
          <div v-if="showHistory && reasoningSteps.length > 0" class="vb-live-reasoning-history">
            <ul class="vb-live-reasoning-history-list">
              <li
                v-for="(step, idx) in reasoningSteps"
                :key="`live-step-${idx}`"
                class="vb-live-reasoning-history-item"
              >
                <div class="vb-live-reasoning-history-row">
                  <span class="vb-live-reasoning-history-bullet">●</span>
                  <span class="vb-live-reasoning-history-title">{{ step.title }}</span>
                  <button
                    v-if="step.detail"
                    type="button"
                    class="vb-live-reasoning-history-toggle"
                    @click="toggleDetailExpand(idx)"
                  >
                    {{ detailExpanded(idx) ? 'Hide' : 'Show' }}
                  </button>
                </div>
                <div v-if="step.detail" class="vb-live-reasoning-history-detail">
                  {{ detailExpanded(idx) ? step.detail : truncate(step.detail, 60) }}
                </div>
              </li>
            </ul>
          </div>
        </div>

        <!-- ═══ SAVED MODE: UNIFIED TRACE (reasoning + tools in one stream) ═══ -->
        <template v-if="!live">
          <!-- Reasoning steps (collapsible if many) -->
          <div v-if="latestStep" class="vb-trace-reasoning-inline">
            <div v-if="olderSteps.length > 0" class="vb-trace-history">
              <button class="vb-trace-history-toggle" type="button" @click="showHistory = !showHistory">
                <span class="vb-live-turn-dot vb-live-turn-dot--success" style="font-size: 8px;">●</span>
                <span class="vb-trace-dots">{{ showHistory ? '▼' : '•••' }}</span>
                <span class="vb-trace-history-count">{{ olderSteps.length }} earlier reasoning step{{ olderSteps.length !== 1 ? 's' : '' }}</span>
              </button>
              <div v-if="showHistory" class="vb-trace-history-items">
                <div
                  v-for="(step, stepIdx) in olderSteps"
                  :key="`saved-step-${stepIdx}`"
                  class="vb-trace-history-item vb-trace-history-item--reasoning"
                >
                  <div class="vb-trace-history-row">
                    <span class="vb-trace-history-bullet">○</span>
                    <span class="vb-trace-history-title">{{ step.title }}</span>
                    <button
                      v-if="step.detail"
                      type="button"
                      class="vb-trace-history-expand"
                      @click="toggleDetailExpand(stepIdx)"
                    >
                      {{ detailExpanded(stepIdx) ? 'Hide' : 'Show' }}
                    </button>
                  </div>
                  <div
                    v-if="step.detail && detailExpanded(stepIdx)"
                    class="vb-trace-history-detail vb-rendered-content"
                    v-html="renderMarkdown(step.detail)"
                  ></div>
                </div>
              </div>
            </div>
            <!-- Latest reasoning step -->
            <div class="vb-trace-latest vb-trace-latest--reasoning">
              <div class="vb-trace-latest-row">
                <span class="vb-live-turn-dot vb-live-turn-dot--success" style="font-size: 8px;">●</span>
                <span class="vb-trace-latest-title">{{ latestStep.title }}</span>
              </div>
              <div
                v-if="latestStep.detail"
                class="vb-trace-latest-detail vb-rendered-content"
                v-html="renderMarkdown(latestStep.detail)"
              ></div>
            </div>
          </div>

          <!-- Reasoning fallback (raw plan HTML) -->
          <div v-else-if="reasoningFallbackHtml" class="vb-trace-reasoning-inline">
            <div class="vb-trace-latest vb-trace-latest--reasoning">
              <div class="vb-trace-latest-row">
                <span class="vb-live-turn-dot vb-live-turn-dot--success" style="font-size: 8px;">●</span>
                <span class="vb-trace-latest-title">Reasoning</span>
              </div>
              <div
                class="vb-trace-latest-detail vb-rendered-content"
                v-html="reasoningFallbackHtml"
              ></div>
            </div>
          </div>

          <!-- Tools (directly in the stream, no section wrapper) -->
          <ToolTimeline v-if="toolRuns.length > 0" :tools="toolRuns" />
        </template>

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolRunDto } from '../lib/apiClient';
import type { ReasoningStep } from '../lib/reasoning';
import { useMarkdown } from '../composables/useMarkdown';
import DecryptText from './DecryptText.vue';
import ToolTimeline from './ToolTimeline.vue';

const props = withDefaults(
  defineProps<{
    /** All reasoning steps — in saved mode the last is treated as "latest" */
    reasoningSteps: ReasoningStep[];
    /** Pre-rendered HTML fallback when no parsed steps exist (saved mode) */
    reasoningFallbackHtml?: string | null;
    /** Live-mode title override for DecryptText animation */
    latestReasoningTitle?: string | null;
    /** Live-mode detail override for DecryptText animation */
    latestReasoningDetail?: string | null;
    /** Tool runs to display via ToolTimeline */
    toolRuns: ToolRunDto[];
    /** true = live draft mode (DecryptText + animated dots), false = saved post */
    live?: boolean;
    /** true = robot is actively thinking (animated indicator) */
    active?: boolean;
    /** Unique ID for expand-state isolation */
    traceId: string;
    /** Topic id for attachment proxy URLs inside reasoning/tool detail markdown */
    topicId?: string | null;
  }>(),
  {
    reasoningFallbackHtml: null,
    latestReasoningTitle: null,
    latestReasoningDetail: null,
    live: false,
    active: false,
    topicId: null,
  }
);

const { renderContent } = useMarkdown();

// --- Internal state ---
const expanded = ref(false);
const showHistory = ref(false);
const expandedDetails = ref(new Set<number>());

// --- Computed ---
const latestStep = computed(() => {
  const steps = props.reasoningSteps;
  return steps.length > 0 ? steps[steps.length - 1] : null;
});

const olderSteps = computed(() => {
  const steps = props.reasoningSteps;
  return steps.length > 1 ? steps.slice(0, -1) : [];
});

// --- Helpers ---
function renderMarkdown(text: string): string {
  return renderContent(text, { topicId: props.topicId });
}

function toggleDetailExpand(idx: number): void {
  const next = new Set(expandedDetails.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  expandedDetails.value = next;
}

function detailExpanded(idx: number): boolean {
  return expandedDetails.value.has(idx);
}

function truncate(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}
</script>
