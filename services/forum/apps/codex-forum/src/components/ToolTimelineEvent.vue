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
      <div v-if="event.model.input" class="vb-timeline-detail-block">
        <div class="vb-timeline-detail-label">Input</div>
        <pre class="vb-timeline-detail-pre">{{ event.model.input }}</pre>
      </div>
      <div v-if="event.model.output" class="vb-timeline-detail-block">
        <div class="vb-timeline-detail-label">{{ event.kind === 'agent' && event.model.name === 'spawn_agent' ? 'Subagent Summary' : 'Output' }}</div>
        <pre class="vb-timeline-detail-pre">{{ event.model.output }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { statusDotChar, statusDotClass, type TimelineEvent } from '../lib/toolTimeline';

const props = defineProps<{
  event: TimelineEvent;
  expanded: boolean;
  isLatest?: boolean;
}>();

defineEmits<{
  toggle: [id: string];
}>();

const dotChar = computed(() => statusDotChar(props.event.status));
const dotClass = computed(() => statusDotClass(props.event.status));
</script>
