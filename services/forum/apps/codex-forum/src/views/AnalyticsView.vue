<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  AnalyticsDataTable,
  AnalyticsRankedBarChart,
  AnalyticsTimeSeriesChart,
  AnalyticsVocabularyList,
} from '../components/analytics';
import {
  analyticsQuery,
  analyticsWindow,
  parseAnalyticsFilters,
  rangeLabel,
  shortUtcDate,
  utcDateTime,
} from '../lib/analyticsFilters';
import { api } from '../lib/apiClient';

import type { AnalyticsChartDatum, AnalyticsChartSeries } from '../components/analytics';
import type { AnalyticsTableColumn, RankedBarDatum } from '../components/analytics/types';
import type { AnalyticsFilters } from '../lib/analyticsFilters';
import type { AdminAnalyticsDto } from '../lib/apiClient';

interface AnalyticsApi {
  getAdminAnalytics(
    query: { from: string; to: string; bucket: 'day' | 'week'; forumId: string | null },
    options?: { signal?: AbortSignal }
  ): Promise<AdminAnalyticsDto>;
}

const route = useRoute();
const router = useRouter();
const analyticsApi = api as unknown as AnalyticsApi;
const analytics = ref<AdminAnalyticsDto | null>(null);
const draft = ref<AnalyticsFilters>(parseAnalyticsFilters(route.query));
const applied = ref<AnalyticsFilters>(parseAnalyticsFilters(route.query));
const initialLoading = ref(true);
const refreshing = ref(false);
const fatalError = ref<string | null>(null);
const staleError = ref<string | null>(null);
const statusMessage = ref('Loading analytics…');
let generation = 0;
let controller: AbortController | null = null;

const metrics = computed(() => analytics.value?.runtime.metrics ?? null);
const modelRows = computed(() => metrics.value?.usage.byModel ?? []);
const toolRows = computed(() => metrics.value?.tools.rows ?? []);
const errorRows = computed(() => metrics.value?.errors.rows ?? []);
const delegationRows = computed(() => metrics.value?.delegation.byProfileMode ?? []);
const modelTimeline = computed(() => metrics.value?.modelUsageOverTime ?? []);
const MIN_TOOL_SAMPLES = 5;

const chartColors = [
  'var(--analytics-series-1)',
  'var(--analytics-series-2)',
  'var(--analytics-series-3)',
  'var(--analytics-series-4)',
  'var(--analytics-series-5)',
  'var(--analytics-series-6)',
  'var(--analytics-series-7)',
  'var(--analytics-series-8)',
];
const modelChartSeries = computed<AnalyticsChartSeries[]>(() => {
  const totals = new Map<string, number>();
  for (const row of modelTimeline.value) totals.set(row.vendor, (totals.get(row.vendor) ?? 0) + row.responses);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([vendor], index) => ({
      key: `vendor${String(index)}`,
      label: vendor,
      color: chartColors[index % chartColors.length] ?? 'currentColor',
    }));
});
const modelChartData = computed<AnalyticsChartDatum[]>(() => {
  const keys = new Map(modelChartSeries.value.map((series) => [series.label, series.key]));
  const buckets = new Map<string, AnalyticsChartDatum>();
  for (const row of modelTimeline.value) {
    const point = buckets.get(row.bucket) ?? {
      label: row.bucket,
      bucketEnd: row.bucketEnd,
      observedFrom: row.observedFrom,
      observedTo: row.observedTo,
      isPartial: row.isPartial,
    };
    const key = keys.get(row.vendor);
    if (key) point[key] = row.responses;
    buckets.set(row.bucket, point);
  }
  return [...buckets.values()];
});
const modelChartSummary = computed(() => {
  if (!modelTimeline.value.length) return 'No completed assistant responses in this period.';
  const total = modelTimeline.value.reduce((sum, row) => sum + row.responses, 0);
  return `${integer(total)} completed assistant responses across ${integer(modelChartSeries.value.length)} model vendors. Partial buckets are marked.`;
});
const qualifyingTools = computed(() =>
  toolRows.value
    .filter((row) => row.calls >= MIN_TOOL_SAMPLES)
    .sort(
      (a, b) =>
        b.failureRate - a.failureRate ||
        b.failures - a.failures ||
        b.calls - a.calls ||
        a.operation.localeCompare(b.operation)
    )
);
const toolChartData = computed<RankedBarDatum[]>(() =>
  qualifyingTools.value.slice(0, 10).map((row) => ({
    key: `${row.operation}:${row.backend}`,
    label: `${row.operation} · ${row.backend}`,
    value: row.failureRate * 100,
    valueLabel: percent(row.failureRate),
    detail: `${integer(row.failures)} failures from ${integer(row.calls)} calls (${percent(row.failureRate)}). ${outcomeSummary(row.outcomes)}.`,
  }))
);

const appliedForumName = computed(() => {
  if (!analytics.value?.selectedForumId) return 'All forums';
  return (
    analytics.value.forums.find((forum) => forum.id === analytics.value?.selectedForumId)?.name ?? 'Selected forum'
  );
});
const appliedScope = computed(() => {
  const value = analytics.value;
  if (!value) return '';
  return `${appliedForumName.value} · ${shortUtcDate(value.window.from, true)}–${shortUtcDate(value.window.to, true)} UTC · ${value.window.bucket === 'day' ? 'daily' : 'weekly'}`;
});
const consequentialCoverage = computed(() => {
  const coverage = metrics.value?.coverage ?? {};
  return Object.entries(coverage).filter(
    ([key, value]) =>
      value > 0 &&
      [
        'missing_sessions',
        'parse_errors',
        'unpaired_tool_calls',
        'unpaired_tool_results',
        'unknown_tool_outcomes',
        'excluded_wait_durations',
      ].includes(key)
  );
});
const hasAnyData = computed(() =>
  Boolean(
    (metrics.value?.usage.successfulResponses ?? 0) > 0 ||
    toolRows.value.length ||
    errorRows.value.length ||
    delegationRows.value.length ||
    (metrics.value?.waiting.count ?? 0) > 0 ||
    (metrics.value?.delegation.unknown ?? 0) > 0 ||
    analytics.value?.vocabulary.groups.some((group) => group.terms.length)
  )
);

function integer(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat().format(Math.round(value));
}
function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;
}
function outcomeSummary(outcomes: Record<string, number>): string {
  return (
    Object.entries(outcomes)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([outcome, count]) => `${outcome}: ${integer(count)}`)
      .join(', ') || 'No classified outcomes'
  );
}
function duration(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (value < 1000) return `${String(Math.round(value))} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}
function humanize(key: string): string {
  return key.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}
function rowRecord(row: object): Record<string, unknown> {
  return row as unknown as Record<string, unknown>;
}

async function refresh(filters: AnalyticsFilters, pushStatus = true): Promise<void> {
  const requestGeneration = ++generation;
  controller?.abort();
  controller = new AbortController();
  const hadData = Boolean(analytics.value);
  initialLoading.value = !hadData;
  refreshing.value = hadData;
  fatalError.value = null;
  staleError.value = null;
  if (pushStatus) statusMessage.value = hadData ? 'Refreshing analytics…' : 'Loading analytics…';
  const window = analyticsWindow(filters);
  try {
    const result = await analyticsApi.getAdminAnalytics(
      {
        ...window,
        forumId: filters.forumId || null,
      },
      { signal: controller.signal }
    );
    if (requestGeneration !== generation) return;
    analytics.value = result;
    applied.value = { ...filters };
    statusMessage.value = `Analytics updated for ${appliedForumName.value}.`;
  } catch (error) {
    if (requestGeneration !== generation || (error instanceof DOMException && error.name === 'AbortError')) return;
    const message = error instanceof Error ? error.message : 'Failed to load analytics.';
    if (hadData) {
      staleError.value = message;
      statusMessage.value = 'Refresh failed; showing the last successful result.';
    } else {
      fatalError.value = message;
      statusMessage.value = 'Analytics could not be loaded.';
    }
  } finally {
    if (requestGeneration === generation) {
      initialLoading.value = false;
      refreshing.value = false;
    }
  }
}

async function applyFilters(): Promise<void> {
  const query = analyticsQuery(draft.value);
  if (JSON.stringify(query) === JSON.stringify(analyticsQuery(parseAnalyticsFilters(route.query)))) {
    await refresh({ ...draft.value });
    return;
  }
  await router.push({ query });
}
async function resetFilters(): Promise<void> {
  draft.value = { range: '30d', bucket: 'auto', forumId: '' };
  await router.push({ query: analyticsQuery(draft.value) });
}

watch(
  () => route.query,
  (query) => {
    const parsed = parseAnalyticsFilters(query);
    const canonical = analyticsQuery(parsed);
    if (
      query['range'] !== canonical['range'] ||
      query['bucket'] !== canonical['bucket'] ||
      (query['forum'] ?? '') !== (canonical['forum'] ?? '')
    ) {
      void router.replace({ query: canonical });
      return;
    }
    draft.value = { ...parsed };
    void refresh(parsed);
  },
  { immediate: true, deep: true }
);

const modelColumns: AnalyticsTableColumn[] = [
  { key: 'vendorModel', label: 'Vendor / model' },
  { key: 'responses', label: 'Responses', numeric: true },
  { key: 'totalTokens', label: 'Total tokens', numeric: true, format: (value) => integer(value as number) },
  { key: 'medianTokens', label: 'Median tokens', numeric: true, format: (value) => integer(value as number | null) },
];
const timelineColumns: AnalyticsTableColumn[] = [
  {
    key: 'bucket',
    label: 'Bucket',
    format: (value, row) => `${shortUtcDate(String(value), true)}${row['isPartial'] ? ' (partial)' : ''}`,
  },
  { key: 'vendor', label: 'Vendor' },
  { key: 'responses', label: 'Responses', numeric: true },
  { key: 'totalTokens', label: 'Token footprint', numeric: true, format: (value) => integer(value as number) },
];
const toolColumns: AnalyticsTableColumn[] = [
  { key: 'operation', label: 'Operation' },
  { key: 'backend', label: 'Backend' },
  { key: 'calls', label: 'Calls', numeric: true },
  { key: 'failures', label: 'Failures', numeric: true },
  { key: 'failureRate', label: 'Rate', numeric: true, format: (value) => percent(value as number) },
  {
    key: 'sampleStatus',
    label: 'Sample',
    format: (_value, row) => (Number(row['calls']) >= MIN_TOOL_SAMPLES ? 'Qualifying' : 'Exploratory'),
  },
  { key: 'outcomesText', label: 'Outcomes', sortable: false },
];
const errorColumns: AnalyticsTableColumn[] = [
  { key: 'source', label: 'Source' },
  { key: 'category', label: 'Category' },
  { key: 'operation', label: 'Operation' },
  { key: 'affectedTurns', label: 'Affected turns', numeric: true },
];
const delegationColumns: AnalyticsTableColumn[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'mode', label: 'Mode' },
  { key: 'observed', label: 'Observed', numeric: true },
  { key: 'successful', label: 'Successful', numeric: true },
  { key: 'unsuccessful', label: 'Unsuccessful', numeric: true },
  { key: 'unsuccessfulRate', label: 'Rate', numeric: true, format: (value) => percent(value as number | null) },
];

const modelTableRows = computed(() =>
  modelRows.value.map((row) => rowRecord({ ...row, vendorModel: `${row.vendor} / ${row.model}` }))
);
const timelineTableRows = computed(() => modelTimeline.value.map(rowRecord));
const toolTableRows = computed(() =>
  toolRows.value.map((row) => rowRecord({ ...row, outcomesText: outcomeSummary(row.outcomes) }))
);
const errorTableRows = computed(() =>
  errorRows.value.map((row) => rowRecord({ ...row, operation: row.operation ?? '—' }))
);
const delegationTableRows = computed(() =>
  delegationRows.value.map((row) => rowRecord({ ...row, observed: row.successful + row.unsuccessful }))
);
</script>

<template>
  <section class="vb-section analytics-page vb-fade-in" :aria-busy="initialLoading || refreshing">
    <header class="analytics-header">
      <div>
        <h1>Analytics</h1>
        <p>Privacy-safe canonical Pi execution metrics and forum-native vocabulary.</p>
      </div>
      <form class="analytics-actions" @submit.prevent="applyFilters">
        <label
          >Period
          <select v-model="draft.range">
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
            <option value="1y">1 year</option>
          </select>
        </label>
        <label
          >Granularity
          <select v-model="draft.bucket">
            <option value="auto">Auto</option>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
          </select>
        </label>
        <label
          >Forum
          <select v-model="draft.forumId">
            <option value="">All forums</option>
            <option v-for="forum in analytics?.forums ?? []" :key="forum.id" :value="forum.id">{{ forum.name }}</option>
          </select>
        </label>
        <button class="vb-small-btn" type="submit">Apply</button>
        <button class="vb-small-btn" type="button" @click="resetFilters">Reset</button>
        <button class="vb-small-btn" type="button" :disabled="initialLoading || refreshing" @click="refresh(applied)">
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
        <router-link class="vb-small-btn" :to="{ name: 'admin' }">Admin Panel</router-link>
      </form>
    </header>

    <p class="vb-sr-only" aria-live="polite">{{ statusMessage }}</p>
    <div v-if="initialLoading" class="analytics-loading" role="status">
      <strong>Loading analytics…</strong><span>Scanning canonical aggregate data for the selected scope.</span>
    </div>
    <div v-else-if="fatalError" class="vb-login-error" role="alert">
      {{ fatalError }} <button class="vb-small-btn" type="button" @click="refresh(draft)">Retry</button>
    </div>

    <template v-if="analytics">
      <div class="analytics-scope" role="status">
        <div>
          <strong>{{ appliedScope }}</strong
          ><span>{{ rangeLabel(applied.range) }} calendar scope; incomplete calendar buckets are marked.</span>
        </div>
        <div>
          Forum response {{ utcDateTime(analytics.generatedAt)
          }}<template v-if="metrics?.generatedAt"> · Runtime aggregate {{ utcDateTime(metrics.generatedAt) }}</template>
        </div>
      </div>
      <div v-if="staleError" class="analytics-warning" role="alert">
        <strong>Refresh failed.</strong> Showing the last successful result. {{ staleError }}
      </div>
      <div v-if="!analytics.runtime.available" class="analytics-warning" role="status">
        Canonical Pi analytics are unavailable: {{ analytics.runtime.warning ?? 'agentd did not return metrics' }}.
        Forum vocabulary remains available.
      </div>
      <div v-if="consequentialCoverage.length" class="analytics-warning" role="status">
        <strong>Coverage needs attention:</strong>
        {{ consequentialCoverage.map(([key, value]) => `${humanize(key)}: ${integer(value)}`).join(' · ') }}
      </div>

      <div v-if="metrics && hasAnyData" class="analytics-metrics" aria-label="Analytics headline metrics">
        <article class="analytics-metric">
          <span>Median token footprint</span><strong>{{ integer(metrics.usage.medianTokens) }}</strong
          ><small>{{ integer(metrics.usage.successfulResponses) }} successful responses</small>
        </article>
        <article class="analytics-metric">
          <span>Worst qualifying tool rate</span><strong>{{ percent(metrics.tools.worst?.failureRate) }}</strong
          ><small>{{
            metrics.tools.worst
              ? `${integer(metrics.tools.worst.failures)} / ${integer(metrics.tools.worst.calls)} · ${metrics.tools.worst.operation}`
              : `No operation with ${MIN_TOOL_SAMPLES}+ calls`
          }}</small>
        </article>
        <article class="analytics-metric">
          <span>Top error cluster</span><strong>{{ integer(metrics.errors.top?.affectedTurns) }}</strong
          ><small>{{ metrics.errors.top?.category ?? 'No errors' }} · affected turns</small>
        </article>
        <article class="analytics-metric">
          <span>p95 parent-blocked wait</span><strong>{{ duration(metrics.waiting.p95Ms) }}</strong
          ><small
            >{{ integer(metrics.waiting.count) }} measured · {{ integer(metrics.waiting.excluded) }} excluded</small
          >
        </article>
        <article class="analytics-metric">
          <span>Unsuccessful delegation</span><strong>{{ percent(metrics.delegation.unsuccessfulRate) }}</strong
          ><small
            >{{ integer(metrics.delegation.unsuccessful) }} /
            {{ integer(metrics.delegation.successful + metrics.delegation.unsuccessful) }} classified ·
            {{ integer(metrics.delegation.unknown) }} unknown</small
          >
        </article>
      </div>

      <p v-if="!hasAnyData" class="analytics-empty">
        No analytics observations or distinctive vocabulary were found for this scope.
      </p>

      <div v-if="hasAnyData" class="analytics-grid">
        <article v-if="metrics" id="analytics-usage" class="analytics-panel analytics-panel--wide">
          <h2>Model vendor usage over time</h2>
          <p>
            Completed assistant responses by vendor. Lines share a zero baseline; partial calendar buckets are shaded.
          </p>
          <AnalyticsTimeSeriesChart
            :data="modelChartData"
            :series="modelChartSeries"
            label="Model vendor usage over time"
            :summary="modelChartSummary"
            :height="260"
            :x-tick-formatter="(value) => shortUtcDate(String(value))"
          />
          <details class="analytics-details">
            <summary>View timeline data ({{ modelTimeline.length }})</summary>
            <AnalyticsDataTable
              :rows="timelineTableRows"
              :columns="timelineColumns"
              caption="Model vendor usage over time"
              :row-key="(row) => `${String(row['bucket'])}:${String(row['vendor'])}`"
              default-sort="bucket"
              default-direction="ascending"
            />
          </details>
        </article>

        <article v-if="metrics" class="analytics-panel">
          <h2>Usage by model</h2>
          <p>Successful response and token-footprint aggregates.</p>
          <details class="analytics-details">
            <summary>View model data ({{ modelRows.length }})</summary>
            <AnalyticsDataTable
              :rows="modelTableRows"
              :columns="modelColumns"
              caption="Successful response token footprint by model"
              :row-key="(row) => String(row['vendorModel'])"
              default-sort="responses"
            />
          </details>
        </article>

        <article v-if="metrics" id="analytics-reliability" class="analytics-panel">
          <h2>Tool reliability</h2>
          <p>
            Needs-attention ranking includes operations with at least {{ MIN_TOOL_SAMPLES }} calls. Lower-sample rows
            remain available as exploratory data.
          </p>
          <AnalyticsRankedBarChart
            :data="toolChartData"
            label="Qualifying tool operations ranked by failure rate"
            :summary="`Failure percentages for ${toolChartData.length} qualifying normalized operations.`"
          />
          <details class="analytics-details">
            <summary>View all tool data ({{ toolRows.length }})</summary>
            <AnalyticsDataTable
              :rows="toolTableRows"
              :columns="toolColumns"
              caption="Normalized tool operation reliability"
              :row-key="(row) => `${String(row['operation'])}:${String(row['backend'])}`"
              default-sort="calls"
            />
          </details>
        </article>

        <article v-if="metrics" class="analytics-panel">
          <h2>Error clusters</h2>
          <p>Sanitized categories ranked by affected turns.</p>
          <details class="analytics-details">
            <summary>View error data ({{ errorRows.length }})</summary>
            <AnalyticsDataTable
              :rows="errorTableRows"
              :columns="errorColumns"
              caption="Sanitized error categories"
              :row-key="(row, index) => `${String(row['source'])}:${String(row['category'])}:${index}`"
              default-sort="affectedTurns"
            />
          </details>
        </article>

        <article v-if="metrics" id="analytics-delegation" class="analytics-panel">
          <h2>Delegation outcomes</h2>
          <p>Rates include classified terminal outcomes only; retained lifecycle history can exclude older runs.</p>
          <details class="analytics-details">
            <summary>View delegation data ({{ delegationRows.length }})</summary>
            <AnalyticsDataTable
              :rows="delegationTableRows"
              :columns="delegationColumns"
              caption="Terminal subagent outcomes by profile and mode"
              :row-key="(row) => `${String(row['profile'])}:${String(row['mode'])}`"
              default-sort="observed"
            />
          </details>
        </article>

        <article id="analytics-vocabulary" class="analytics-panel analytics-panel--wide">
          <h2>Distinctive vocabulary</h2>
          <p>
            Forum post bodies only. Human and assistant corpora remain separate; code, URLs, wrappers, deleted posts,
            and common stopwords are excluded.
          </p>
          <div v-if="analytics.vocabulary.groups.length" class="analytics-vocabulary-grid">
            <AnalyticsVocabularyList
              v-for="group in analytics.vocabulary.groups"
              :key="`${group.forumId}:${group.audience}`"
              :group="group"
            />
          </div>
          <p v-else>No vocabulary data in this period.</p>
        </article>

        <article v-if="metrics" class="analytics-panel analytics-panel--wide analytics-meta">
          <details class="analytics-details">
            <summary>Data coverage</summary>
            <dl class="analytics-definition-grid">
              <template v-for="(value, key) in metrics.coverage" :key="key">
                <dt>{{ humanize(key) }}</dt>
                <dd>{{ integer(value) }}</dd>
              </template>
            </dl>
          </details>
          <details class="analytics-details">
            <summary>Methodology and privacy</summary>
            <p>
              Runtime metrics scan only the active branch of allowlisted canonical parent sessions. Tool rates use
              paired results; the headline requires {{ MIN_TOOL_SAMPLES }} calls. Parent wait uses nearest-rank p95 and
              excludes durations outside the accepted 24-hour bound. Delegation rates exclude unknown outcomes. The
              browser receives aggregates only—never prompts, commands, paths, raw errors, session IDs, or message text.
            </p>
          </details>
          <p class="analytics-build">
            Runtime build: <code>{{ metrics.build.commit ?? 'unknown' }}</code
            ><template v-if="metrics.build.createdAt"> · {{ utcDateTime(metrics.build.createdAt) }}</template>
          </p>
        </article>
      </div>
    </template>
  </section>
</template>
