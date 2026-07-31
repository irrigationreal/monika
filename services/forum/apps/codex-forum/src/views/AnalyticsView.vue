<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { AnalyticsBreakdownBarChart, AnalyticsTimeSeriesChart } from '../components/analytics';
import { api } from '../lib/apiClient';

import type { AnalyticsChartDatum, AnalyticsChartSeries } from '../components/analytics';
import type { AdminAnalyticsDto } from '../lib/apiClient';

interface AnalyticsApi {
  getAdminAnalytics(query: {
    from: string;
    to: string;
    bucket: 'day' | 'week';
    forumId: string | null;
  }): Promise<AdminAnalyticsDto>;
}

const analyticsApi = api as unknown as AnalyticsApi;
const analytics = ref<AdminAnalyticsDto | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const days = ref(30);
const forumId = ref('');
const bucket = ref<'day' | 'week'>('day');

const metrics = computed(() => analytics.value?.runtime.metrics ?? null);
const modelRows = computed(() => metrics.value?.usage.byModel ?? []);
const toolRows = computed(() => metrics.value?.tools.rows ?? []);
const errorRows = computed(() => metrics.value?.errors.rows ?? []);
const delegationRows = computed(() => metrics.value?.delegation.byProfileMode ?? []);
const modelTimeline = computed(() => metrics.value?.modelUsageOverTime ?? []);
const chartColors = ['#37d468', '#7aa2f7', '#bb9af7', '#ff9e64', '#e0af68', '#f7768e', '#2ac3de', '#9ece6a'];
const modelChartSeries = computed<AnalyticsChartSeries[]>(() =>
  [...new Set(modelTimeline.value.map((row) => row.vendor))].map((vendor, index) => ({
    key: `vendor${String(index)}`,
    label: vendor,
    color: chartColors[index % chartColors.length] ?? '#37d468',
    variant: index % 2 ? 'hatched' : 'gradient',
  }))
);
const modelChartData = computed<AnalyticsChartDatum[]>(() => {
  const keys = new Map(modelChartSeries.value.map((series) => [series.label, series.key]));
  const buckets = new Map<string, AnalyticsChartDatum>();
  for (const row of modelTimeline.value) {
    const point = buckets.get(row.bucket) ?? { label: row.bucket };
    const key = keys.get(row.vendor);
    if (key) point[key] = row.responses;
    buckets.set(row.bucket, point);
  }
  return [...buckets.values()];
});
const modelChartSummary = computed(() => {
  if (!modelTimeline.value.length) return 'No completed assistant responses in this period.';
  const total = modelTimeline.value.reduce((sum, row) => sum + row.responses, 0);
  return `${integer(total)} completed assistant responses across ${String(modelChartSeries.value.length)} model vendors.`;
});
const toolChartData = computed<AnalyticsChartDatum[]>(() =>
  toolRows.value.slice(0, 12).map((row) => ({ label: row.operation, failureRate: row.failureRate * 100 }))
);
const toolChartSeries: AnalyticsChartSeries[] = [
  { key: 'failureRate', label: 'Failure rate (%)', color: '#f7768e', variant: 'hatched' },
];

function windowForDays(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days.value * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const window = windowForDays();
    analytics.value = await analyticsApi.getAdminAnalytics({
      ...window,
      bucket: bucket.value,
      forumId: forumId.value === '' ? null : forumId.value,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load analytics.';
  } finally {
    loading.value = false;
  }
}

function integer(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat().format(Math.round(value));
}
function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;
}
function duration(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (value < 1000) return `${String(Math.round(value))} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}
function vocabularySize(score: number, maxScore: number): string {
  if (maxScore <= 0) return '0.85rem';
  return `${String(0.8 + Math.min(1, score / maxScore) * 1.25)}rem`;
}

onMounted(() => void refresh());
</script>

<template>
  <section class="vb-section analytics-page vb-fade-in">
    <header class="analytics-header">
      <div>
        <h1>Analytics</h1>
        <p>Canonical Pi execution metrics and forum-native vocabulary. Admin only.</p>
      </div>
      <div class="analytics-actions">
        <label
          >Period
          <select v-model.number="days" @change="refresh">
            <option :value="7">7 days</option>
            <option :value="30">30 days</option>
            <option :value="90">90 days</option>
            <option :value="365">1 year</option>
          </select>
        </label>
        <label
          >Bucket
          <select v-model="bucket" @change="refresh">
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
          </select>
        </label>
        <label
          >Forum
          <select v-model="forumId" @change="refresh">
            <option value="">All forums</option>
            <option v-for="forum in analytics?.forums ?? []" :key="forum.id" :value="forum.id">{{ forum.name }}</option>
          </select>
        </label>
        <button class="vb-small-btn" type="button" :disabled="loading" @click="refresh">
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
        <router-link class="vb-small-btn" :to="{ name: 'admin' }">Admin Panel</router-link>
      </div>
    </header>

    <div v-if="error" class="vb-login-error" role="alert">{{ error }}</div>
    <div v-if="analytics && !analytics.runtime.available" class="analytics-warning" role="status">
      Canonical Pi analytics are unavailable: {{ analytics.runtime.warning ?? 'agentd did not return metrics' }}. Forum
      vocabulary remains available.
    </div>

    <div class="analytics-metrics" aria-label="Analytics headline metrics">
      <article class="analytics-metric">
        <span>Median token footprint</span><strong>{{ integer(metrics?.usage.medianTokens) }}</strong
        ><small>per successful assistant response</small>
      </article>
      <article class="analytics-metric">
        <span>Worst tool failure rate</span><strong>{{ percent(metrics?.tools.worst?.failureRate) }}</strong
        ><small>{{ metrics?.tools.worst?.operation ?? 'No qualifying operation' }}</small>
      </article>
      <article class="analytics-metric">
        <span>Top error cluster</span><strong>{{ integer(metrics?.errors.top?.affectedTurns) }}</strong
        ><small>{{ metrics?.errors.top?.category ?? 'No errors' }}</small>
      </article>
      <article class="analytics-metric">
        <span>p95 parent-blocked wait</span><strong>{{ duration(metrics?.waiting.p95Ms) }}</strong
        ><small>{{ integer(metrics?.waiting.count) }} measured waits</small>
      </article>
      <article class="analytics-metric">
        <span>Unsuccessful delegation</span><strong>{{ percent(metrics?.delegation.unsuccessfulRate) }}</strong
        ><small>{{ integer(metrics?.delegation.unknown) }} unknown outcomes excluded</small>
      </article>
    </div>

    <div class="analytics-grid">
      <article class="analytics-panel analytics-panel--wide">
        <h2>Model-family usage over time</h2>
        <p>Completed assistant responses by model vendor. The table is the authoritative accessible representation.</p>
        <AnalyticsTimeSeriesChart
          :data="modelChartData"
          :series="modelChartSeries"
          ariaLabel="Model-family usage over time"
          :summary="modelChartSummary"
          :height="220"
        />
        <div class="analytics-table-scroll">
          <table>
            <caption>
              Model-family usage over time
            </caption>
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col">Vendor</th>
                <th scope="col">Responses</th>
                <th scope="col">Token footprint</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in modelTimeline" :key="`${row.bucket}:${row.vendor}`">
                <td>{{ row.bucket }}</td>
                <td>{{ row.vendor }}</td>
                <td>{{ integer(row.responses) }}</td>
                <td>{{ integer(row.totalTokens) }}</td>
              </tr>
              <tr v-if="!modelTimeline.length">
                <td colspan="4">No model usage in this period.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="analytics-panel">
        <h2>Usage by model</h2>
        <div class="analytics-table-scroll">
          <table>
            <caption>
              Successful response token footprint by model
            </caption>
            <thead>
              <tr>
                <th scope="col">Vendor / model</th>
                <th scope="col">Responses</th>
                <th scope="col">Median</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in modelRows" :key="`${row.vendor}:${row.model}`">
                <td>{{ row.vendor }} / {{ row.model }}</td>
                <td>{{ integer(row.responses) }}</td>
                <td>{{ integer(row.medianTokens) }}</td>
              </tr>
              <tr v-if="!modelRows.length">
                <td colspan="3">No usage data.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="analytics-panel">
        <h2>Tool reliability</h2>
        <AnalyticsBreakdownBarChart
          :data="toolChartData"
          :series="toolChartSeries"
          ariaLabel="Failure rate by normalized tool operation"
          summary="The chart shows failure percentages for up to twelve of the most frequently observed normalized operations."
          :height="190"
          :stack-type="'default'"
        />
        <div class="analytics-table-scroll">
          <table>
            <caption>
              Normalized tool operation reliability
            </caption>
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Calls</th>
                <th scope="col">Failures</th>
                <th scope="col">Rate</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in toolRows" :key="row.operation">
                <td>{{ row.operation }}</td>
                <td>{{ integer(row.calls) }}</td>
                <td>{{ integer(row.failures) }}</td>
                <td>{{ percent(row.failureRate) }}</td>
              </tr>
              <tr v-if="!toolRows.length">
                <td colspan="4">No paired tool calls.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="analytics-panel">
        <h2>Error clusters</h2>
        <div class="analytics-table-scroll">
          <table>
            <caption>
              Sanitized error categories
            </caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Category</th>
                <th scope="col">Operation</th>
                <th scope="col">Turns</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in errorRows" :key="`${row.source}:${row.category}:${row.operation}:${index}`">
                <td>{{ row.source }}</td>
                <td>{{ row.category }}</td>
                <td>{{ row.operation ?? '—' }}</td>
                <td>{{ integer(row.affectedTurns) }}</td>
              </tr>
              <tr v-if="!errorRows.length">
                <td colspan="4">No errors in this period.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="analytics-panel">
        <h2>Delegation outcomes</h2>
        <div class="analytics-table-scroll">
          <table>
            <caption>
              Terminal subagent outcomes by profile and mode
            </caption>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Mode</th>
                <th scope="col">Successful</th>
                <th scope="col">Unsuccessful</th>
                <th scope="col">Rate</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in delegationRows" :key="`${row.profile}:${row.mode}`">
                <td>{{ row.profile }}</td>
                <td>{{ row.mode }}</td>
                <td>{{ integer(row.successful) }}</td>
                <td>{{ integer(row.unsuccessful) }}</td>
                <td>{{ percent(row.unsuccessfulRate) }}</td>
              </tr>
              <tr v-if="!delegationRows.length">
                <td colspan="5">No classified terminal delegation outcomes.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="analytics-panel analytics-panel--wide">
        <h2>Distinctive vocabulary</h2>
        <p>
          Forum post bodies only. Code, URLs, Markdown wrappers, deleted posts, and common stopwords are excluded; human
          and assistant corpora remain separate.
        </p>
        <div v-if="analytics?.vocabulary.groups.length" class="analytics-vocabulary-grid">
          <section
            v-for="group in analytics.vocabulary.groups"
            :key="`${group.forumId}:${group.audience}`"
            class="analytics-vocabulary-group"
          >
            <h3>{{ group.forumName }} · {{ group.audience }}</h3>
            <div
              class="analytics-word-cloud"
              :aria-label="`Distinctive ${group.audience} vocabulary for ${group.forumName}`"
            >
              <span
                v-for="term in group.terms"
                :key="term.term"
                :style="{ fontSize: vocabularySize(term.score, group.terms[0]?.score ?? 1) }"
                :title="`${term.count} uses in ${term.documentCount} posts; score ${term.score}`"
                >{{ term.term }}</span
              >
              <em v-if="!group.terms.length">Not enough repeated vocabulary.</em>
            </div>
          </section>
        </div>
        <p v-else>No vocabulary data in this period.</p>
      </article>
    </div>
  </section>
</template>
