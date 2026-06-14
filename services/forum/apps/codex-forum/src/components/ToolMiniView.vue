<template>
  <div class="vb-tool-mini" :class="toolMiniClasses">
    <div class="vb-tool-mini-header">
      <span class="vb-tool-mini-icon" aria-hidden="true">{{ icon }}</span>
      <span class="vb-tool-mini-name">{{ model.name }}</span>
      <span v-if="model.summary" class="vb-tool-mini-summary">{{ model.summary }}</span>
    </div>
    <div v-if="showDetail && model.detail" class="vb-tool-mini-detail" :class="detailClass">
      <template v-if="model.detail.style === 'chips'">
        <span v-for="(line, idx) in model.detail.lines" :key="idx" class="vb-tool-mini-chip">{{ line }}</span>
      </template>
      <template v-else>
        <div
          v-for="(line, idx) in model.detail.lines"
          :key="idx"
          class="vb-tool-mini-line"
          :class="detailLineClass(line, model.detail.style)"
        >
          <span v-if="model.detail.style === 'table' && splitKeyValue(line)" class="vb-tool-mini-key">{{ splitKeyValue(line)?.key }}</span>
          <span v-if="model.detail.style === 'table' && splitKeyValue(line)" class="vb-tool-mini-value">{{ splitKeyValue(line)?.value }}</span>
          <template v-else>{{ line }}</template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ToolRunDto } from '../lib/apiClient';
import { getToolMiniModel, toolKindIcon } from '../lib/toolMiniView';

const props = defineProps<{ tool: ToolRunDto; compact?: boolean; showDetail?: boolean }>();

const model = computed(() => getToolMiniModel(props.tool));

const icon = computed(() => toolKindIcon(model.value.kind));

const toolMiniClasses = computed(() => {
  return [
    `vb-tool-mini--${model.value.kind}`,
    props.compact ? 'vb-tool-mini--compact' : null
  ];
});

const detailClass = computed(() => {
  return model.value.detail ? `vb-tool-mini-detail--${model.value.detail.style}` : '';
});

function detailLineClass(line: string, style: string): string | null {
  if (style !== 'diff') return null;
  if (line.startsWith('+')) return 'vb-tool-mini-line--add';
  if (line.startsWith('-')) return 'vb-tool-mini-line--del';
  if (line.startsWith('@')) return 'vb-tool-mini-line--meta';
  return null;
}

function splitKeyValue(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  return { key: line.slice(0, idx), value: line.slice(idx + 1).trim() };
}
</script>
