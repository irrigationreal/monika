<template>
  <div class="vb-timeline" :class="densityClass">
    <div v-if="showHeader" class="vb-timeline-header">
      <span class="vb-timeline-header-title">{{ title ?? 'Tools Timeline' }} ({{ tools.length }})</span>
      <div class="vb-timeline-header-controls">
        <label>
          Density:
          <select v-model="density" class="vb-timeline-select">
            <option value="condensed">Condensed</option>
            <option value="normal">Normal</option>
            <option value="raw">Raw</option>
          </select>
        </label>
        <label>
          Filter:
          <select v-model="filterKind" class="vb-timeline-select">
            <option :value="null">All tools</option>
            <option value="exec">exec</option>
            <option value="read">read</option>
            <option value="apply_patch">patch</option>
            <option value="web">web</option>
            <option value="image">image</option>
            <option value="agent">agent</option>
            <option value="forum">forum</option>
            <option value="other">other</option>
          </select>
        </label>
      </div>
    </div>

    <div v-if="tools.length === 0" class="vb-timeline-empty">No tool runs yet.</div>

    <div v-else class="vb-timeline-spine">
      <!-- NOW separator if there's a running tool -->
      <div v-if="hasRunningTool" class="vb-timeline-separator">NOW</div>

      <template v-for="(node, idx) in filteredNodes" :key="node.id">
        <!-- OLDER separator: after the last running node -->
        <div
          v-if="olderSeparatorIndex === idx"
          class="vb-timeline-separator"
        >OLDER ({{ filteredNodes.length - idx }} earlier)</div>

        <!-- Event node -->
        <ToolTimelineEvent
          v-if="node.type === 'event'"
          :event="node"
          :expanded="expandedEvents.has(node.id)"
          :isLatest="idx === 0"
          @toggle="toggleEvent"
        />

        <!-- Burst node -->
        <ToolTimelineBurst
          v-else-if="node.type === 'burst'"
          :burst="node"
          :burstExpanded="expandedBursts.has(node.id)"
          :expandedEvents="expandedEvents"
          :isLatest="idx === 0"
          @toggle-burst="toggleBurst"
          @toggle-event="toggleEvent"
        />

        <!-- Agent frame -->
        <div v-else-if="node.type === 'agent_frame'" class="vb-timeline-node">
          <span class="vb-timeline-dot" :class="agentDotClass(node)">{{ agentDotChar(node) }}</span>
          <button class="vb-timeline-agent-header" type="button" @click="toggleAgent(node.id)">
            <span
              class="vb-timeline-burst-arrow"
              :class="{ 'vb-timeline-burst-arrow--open': expandedAgents.has(node.id) }"
            >▸</span>
            <span class="vb-timeline-kind">agent</span>
            <span class="vb-timeline-burst-label">{{ node.label }}</span>
            <span class="vb-timeline-burst-meta">steps {{ node.children.length }}</span>
          </button>
          <div v-if="expandedAgents.has(node.id)" class="vb-timeline-agent-children">
            <template v-for="child in node.children" :key="child.id">
              <ToolTimelineEvent
                v-if="child.type === 'event'"
                :event="child"
                :expanded="expandedEvents.has(child.id)"
                @toggle="toggleEvent"
              />
              <ToolTimelineBurst
                v-else-if="child.type === 'burst'"
                :burst="child"
                :burstExpanded="expandedBursts.has(child.id)"
                :expandedEvents="expandedEvents"
                @toggle-burst="toggleBurst"
                @toggle-event="toggleEvent"
              />
            </template>
          </div>
        </div>
      </template>

      <!-- END marker -->
      <div v-if="filteredNodes.length > 0" class="vb-timeline-separator">END</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolRunDto } from '../lib/apiClient';
import {
  buildTimeline,
  filterByKind,
  statusDotChar,
  statusDotClass,
  type DensityMode,
  type TimelineAgentFrame,
  type TimelineNode,
} from '../lib/toolTimeline';
import type { ToolKind } from '../lib/toolMiniView';
import ToolTimelineEvent from './ToolTimelineEvent.vue';
import ToolTimelineBurst from './ToolTimelineBurst.vue';

const props = defineProps<{
  tools: ToolRunDto[];
  title?: string;
  showHeader?: boolean;
}>();

// Internal state
const density = ref<DensityMode>('normal');
const filterKind = ref<ToolKind | null>(null);
const expandedBursts = ref(new Set<string>());
const expandedEvents = ref(new Set<string>());
const expandedAgents = ref(new Set<string>());

// Computed
const densityClass = computed(() => `vb-timeline--${density.value}`);

const timelineNodes = computed(() => buildTimeline(props.tools, density.value));

const filteredNodes = computed(() => filterByKind(timelineNodes.value, filterKind.value));

const hasRunningTool = computed(() =>
  filteredNodes.value.some((n) => {
    if (n.type === 'event') return n.status === 'running';
    if (n.type === 'burst') return n.status === 'running';
    if (n.type === 'agent_frame') return n.status === 'running';
    return false;
  })
);

const olderSeparatorIndex = computed(() => {
  if (!hasRunningTool.value) return -1;
  // Find the first non-running node after the running ones
  for (let i = 0; i < filteredNodes.value.length; i++) {
    const n = filteredNodes.value[i];
    const isRunning =
      (n.type === 'event' && n.status === 'running') ||
      (n.type === 'burst' && n.status === 'running') ||
      (n.type === 'agent_frame' && n.status === 'running');
    if (!isRunning) return i;
  }
  return -1;
});

// Toggle handlers
function toggleEvent(id: string) {
  const next = new Set(expandedEvents.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedEvents.value = next;
}

function toggleBurst(id: string) {
  const next = new Set(expandedBursts.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedBursts.value = next;
}

function toggleAgent(id: string) {
  const next = new Set(expandedAgents.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedAgents.value = next;
}

// Agent frame helpers
function agentDotChar(frame: TimelineAgentFrame) {
  return statusDotChar(frame.status);
}

function agentDotClass(frame: TimelineAgentFrame) {
  return statusDotClass(frame.status);
}
</script>
