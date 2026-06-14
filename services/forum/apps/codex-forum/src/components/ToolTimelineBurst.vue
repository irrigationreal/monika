<template>
  <div class="vb-timeline-node">
    <span class="vb-timeline-dot" :class="[dotClass, { 'vb-timeline-dot--latest': isLatest }]">{{ dotChar }}</span>
    <button class="vb-timeline-burst-header" type="button" @click="$emit('toggle-burst', burst.id)">
      <span
        class="vb-timeline-burst-arrow"
        :class="{ 'vb-timeline-burst-arrow--open': burstExpanded }"
      >▸</span>
      <span class="vb-timeline-kind">{{ burst.kindAbbr }}</span>
      <span class="vb-timeline-burst-label">{{ burst.label }}</span>
      <span class="vb-timeline-duration">{{ burst.durationLabel }}</span>
    </button>
    <div v-if="!burstExpanded" class="vb-timeline-burst-meta" style="padding-left: 44px;">
      (collapsed — expand to see each {{ burst.children.length === 1 ? 'call' : `${burst.children.length} calls` }})
    </div>
    <div v-if="burstExpanded" class="vb-timeline-burst-children">
      <ToolTimelineEvent
        v-for="child in burst.children"
        :key="child.id"
        :event="child"
        :expanded="expandedEvents.has(child.id)"
        @toggle="(id: string) => $emit('toggle-event', id)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { statusDotChar, statusDotClass, type TimelineBurst } from '../lib/toolTimeline';
import ToolTimelineEvent from './ToolTimelineEvent.vue';

const props = defineProps<{
  burst: TimelineBurst;
  burstExpanded: boolean;
  expandedEvents: Set<string>;
  isLatest?: boolean;
}>();

defineEmits<{
  'toggle-burst': [id: string];
  'toggle-event': [id: string];
}>();

const dotChar = computed(() => statusDotChar(props.burst.status));
const dotClass = computed(() => statusDotClass(props.burst.status));
</script>
