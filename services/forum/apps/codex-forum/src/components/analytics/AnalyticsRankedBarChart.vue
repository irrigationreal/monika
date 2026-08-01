<script setup lang="ts">
import { ref } from 'vue';

import type { RankedBarDatum } from './types';

defineProps<{ data: RankedBarDatum[]; label: string; summary: string }>();
const activeKey = ref<string | null>(null);
</script>

<template>
  <figure class="vb-analytics-chart vb-analytics-ranked" :aria-label="label">
    <figcaption class="vb-analytics-chart-summary">{{ summary }}</figcaption>
    <p v-if="!data.length" class="vb-analytics-chart-empty">No chart data.</p>
    <ol v-else class="analytics-ranked-bars">
      <li v-for="item in data" :key="item.key">
        <button
          type="button"
          class="analytics-ranked-bar"
          :aria-label="`${item.label}: ${item.detail}`"
          @mouseenter="activeKey = item.key"
          @mouseleave="activeKey = null"
          @focus="activeKey = item.key"
          @blur="activeKey = null"
          @click="activeKey = activeKey === item.key ? null : item.key"
          @keydown.esc="activeKey = null"
        >
          <span class="analytics-ranked-label">{{ item.label }}</span>
          <span class="analytics-ranked-track" aria-hidden="true">
            <span
              class="analytics-ranked-fill"
              :style="{ width: `${Math.max(0, Math.min(100, item.value)).toString()}%` }"
            />
          </span>
          <strong>{{ item.valueLabel }}</strong>
        </button>
        <span v-if="activeKey === item.key" class="analytics-ranked-detail" role="status">{{ item.detail }}</span>
      </li>
    </ol>
  </figure>
</template>
