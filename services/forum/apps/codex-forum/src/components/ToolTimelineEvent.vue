<template>
  <div class="vb-timeline-node">
    <span class="vb-timeline-dot" :class="[dotClass, { 'vb-timeline-dot--latest': isLatest }]">{{ dotChar }}</span>
    <button class="vb-timeline-card" type="button" @click="$emit('toggle', event.id)">
      <span class="vb-timeline-kind">{{ event.kindAbbr }}</span>
      <span class="vb-timeline-title">{{ event.humanTitle }}</span>
      <span
        v-if="event.status === 'running'"
        class="vb-timeline-status vb-timeline-status--running"
      >running</span>
      <span
        v-else-if="event.status === 'error'"
        class="vb-timeline-status vb-timeline-status--error"
      >error</span>
      <span v-if="event.durationLabel" class="vb-timeline-duration">{{ event.durationLabel }}</span>
      <span v-if="event.timeoutLabel" class="vb-timeline-timeout">{{ event.timeoutLabel }}</span>
      <span class="vb-timeline-toggle-icon">{{ expanded ? '−' : '+' }}</span>
    </button>
    <div v-if="event.subtitle && !expanded" class="vb-timeline-subtitle">{{ event.subtitle }}</div>
    <div v-if="expanded" class="vb-timeline-details">
      <div v-if="event.subtitle" class="vb-timeline-subtitle" style="padding-left: 0;">{{ event.subtitle }}</div>

      <!-- Structured detail (parsed key/value lines from ToolMiniModel) -->
      <div v-if="detailLines.length > 0" class="vb-timeline-detail-block">
        <div class="vb-timeline-detail-structured">
          <div
            v-for="(line, idx) in detailLines"
            :key="idx"
            class="vb-timeline-detail-line"
            :class="detailLineClass(line)"
          >{{ line }}</div>
        </div>
      </div>

      <!-- Cleaned output summary -->
      <div v-if="event.model.output" class="vb-timeline-detail-block">
        <div class="vb-timeline-detail-label">{{ outputLabel }}</div>
        <pre class="vb-timeline-detail-pre">{{ event.model.output }}</pre>
      </div>

      <!-- Raw JSON toggle -->
      <div v-if="hasRawJson" class="vb-timeline-detail-block">
        <button class="vb-timeline-raw-toggle" type="button" @click.stop="showRaw = !showRaw">
          {{ showRaw ? 'Hide raw JSON' : 'Raw JSON' }}
        </button>
        <div v-if="showRaw">
          <div v-if="event.model.input" class="vb-timeline-detail-block">
            <div class="vb-timeline-detail-label">Input (raw)</div>
            <pre class="vb-timeline-detail-pre">{{ event.model.input }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { statusDotChar, statusDotClass, type TimelineEvent } from '../lib/toolTimeline';

const props = defineProps<{
  event: TimelineEvent;
  expanded: boolean;
  isLatest?: boolean;
}>();

defineEmits<{
  toggle: [id: string];
}>();

const showRaw = ref(false);

const dotChar = computed(() => statusDotChar(props.event.status));
const dotClass = computed(() => statusDotClass(props.event.status));

const detailLines = computed(() => props.event.model.detail?.lines ?? []);

const outputLabel = computed(() => {
  const lowerName = (props.event.model.name ?? '').toLowerCase();
  if (props.event.kind === 'agent' && lowerName === 'spawn_agent') return 'Subagent Summary';
  return 'Output';
});

const hasRawJson = computed(() => {
  // Show raw toggle when there's input JSON that differs from the structured detail
  return Boolean(props.event.model.input);
});

function detailLineClass(line: string): string {
  if (line.startsWith('> ')) return 'vb-timeline-detail-line--command';
  if (line.startsWith('cwd:') || line.startsWith('Path:') || line.startsWith('Dir:')) return 'vb-timeline-detail-line--meta';
  if (line.startsWith('• ') || line.startsWith('+')) return 'vb-timeline-detail-line--file';
  return '';
}
</script>
