<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { AnalyticsTableColumn } from './types';

const props = withDefaults(
  defineProps<{
    rows: Record<string, unknown>[];
    columns: AnalyticsTableColumn[];
    caption: string;
    rowKey: (row: Record<string, unknown>, index: number) => string;
    defaultSort: string;
    defaultDirection?: 'ascending' | 'descending';
    pageSize?: number;
    emptyText?: string;
  }>(),
  { defaultDirection: 'descending', pageSize: 10, emptyText: 'No data for this period.' }
);

const sortKey = ref(props.defaultSort);
const direction = ref<'ascending' | 'descending'>(props.defaultDirection);
const page = ref(1);

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return JSON.stringify(value);
}

function compareValues(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return textValue(left).localeCompare(textValue(right), undefined, { numeric: true, sensitivity: 'base' });
}

const sortedRows = computed(() =>
  props.rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const compared = compareValues(a.row[sortKey.value], b.row[sortKey.value]);
      return (direction.value === 'ascending' ? compared : -compared) || a.index - b.index;
    })
    .map(({ row }) => row)
);
const pageCount = computed(() => Math.max(1, Math.ceil(sortedRows.value.length / props.pageSize)));
const visibleRows = computed(() =>
  sortedRows.value.slice((page.value - 1) * props.pageSize, page.value * props.pageSize)
);
const firstRow = computed(() => (sortedRows.value.length ? (page.value - 1) * props.pageSize + 1 : 0));
const lastRow = computed(() => Math.min(page.value * props.pageSize, sortedRows.value.length));

watch(
  () => [props.rows, props.pageSize],
  () => {
    page.value = 1;
  },
  { deep: false }
);
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

function toggleSort(column: AnalyticsTableColumn): void {
  if (column.sortable === false) return;
  if (sortKey.value === column.key) direction.value = direction.value === 'ascending' ? 'descending' : 'ascending';
  else {
    sortKey.value = column.key;
    direction.value = column.numeric ? 'descending' : 'ascending';
  }
  page.value = 1;
}
function formatted(column: AnalyticsTableColumn, row: Record<string, unknown>): string {
  const value = row[column.key];
  return column.format ? column.format(value, row) : textValue(value);
}
</script>

<template>
  <div class="analytics-data-table">
    <div class="analytics-table-scroll" role="region" :aria-label="caption" tabindex="0">
      <table>
        <caption>
          {{
            caption
          }}
        </caption>
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              scope="col"
              :class="{ 'analytics-cell--numeric': column.numeric }"
              :aria-sort="sortKey === column.key ? direction : undefined"
            >
              <button v-if="column.sortable !== false" type="button" class="analytics-sort" @click="toggleSort(column)">
                {{ column.label }}
                <span aria-hidden="true">{{
                  sortKey === column.key ? (direction === 'ascending' ? '▲' : '▼') : '↕'
                }}</span>
              </button>
              <span v-else>{{ column.label }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in visibleRows" :key="rowKey(row, index)">
            <td v-for="column in columns" :key="column.key" :class="{ 'analytics-cell--numeric': column.numeric }">
              {{ formatted(column, row) }}
            </td>
          </tr>
          <tr v-if="!visibleRows.length">
            <td :colspan="columns.length">{{ emptyText }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav v-if="pageCount > 1" class="analytics-pagination" :aria-label="`${caption} pages`">
      <span aria-live="polite">Rows {{ firstRow }}–{{ lastRow }} of {{ sortedRows.length }}</span>
      <button class="vb-small-btn" type="button" :disabled="page === 1" @click="page -= 1">Previous</button>
      <span>Page {{ page }} of {{ pageCount }}</span>
      <button class="vb-small-btn" type="button" :disabled="page === pageCount" @click="page += 1">Next</button>
    </nav>
  </div>
</template>
