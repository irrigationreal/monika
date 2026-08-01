<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ConfirmationDialog from '../components/ConfirmationDialog.vue';
import { useForumState } from '../composables/useForumState';
import { api, type AdminDeployStatus, type RobotDashboardDto, type RobotJobDto, type RobotStopResultDto } from '../lib/apiClient';

const router = useRouter();
const state = useForumState();
const robotApi = api as typeof api & {
  getRobotDashboard: () => Promise<RobotDashboardDto>;
  getDeployStatus: () => Promise<AdminDeployStatus>;
  interruptRobot: (topicId: string) => Promise<RobotStopResultDto>;
  continueRobot: (topicId: string) => Promise<unknown>;
  triggerDeploy: () => Promise<unknown>;
  triggerDeployOnFinish: () => Promise<unknown>;
  cancelDeployOnFinish: () => Promise<unknown>;
};

const dashboard = ref<RobotDashboardDto | null>(null);
const deployStatus = ref<AdminDeployStatus | null>(null);
const loading = ref(false);
const refreshing = ref(false);
const error = ref<string | null>(null);
const lastRefreshedAt = ref<string | null>(null);
const stopResults = ref<Record<string, RobotStopResultDto>>({});
const stopConfirmationTopicId = ref<string | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const jobs = computed(() => dashboard.value?.jobs ?? []);
const queue = computed(() => dashboard.value?.queue ?? []);
const subagents = computed(() => dashboard.value?.subagents);
const subagentBlockers = computed(() => subagents.value?.groups.blockers ?? []);
const subagentPendingDelivery = computed(() => subagents.value?.groups.pendingDelivery ?? []);
const subagentHistory = computed(() => subagents.value?.groups.history ?? []);

const busyJobs = computed(() =>
  jobs.value.filter((job) => job.activity !== 'idle' && job.activity !== 'waiting')
);
const waitingJobs = computed(() => jobs.value.filter((job) => job.activity === 'waiting'));
const deployOnFinishRequestedAt = computed(() => deployStatus.value?.deployOnFinishRequestedAt ?? null);
const deployOnFinishPending = computed(() => Boolean(deployOnFinishRequestedAt.value));

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function activityLabel(activity: RobotJobDto['activity']): string {
  switch (activity) {
    case 'thinking': return 'Thinking';
    case 'running_tools': return 'Running tools';
    case 'waiting': return 'Queued';
    case 'stopping': return 'Stopping';
    case 'uncertain': return 'Termination uncertain';
    case 'error': return 'Error';
    case 'idle': return 'Idle';
    default: return activity;
  }
}

function subagentStateClass(state: string): string {
  if (state === 'uncertain') return 'vb-status-pill--error';
  if (state === 'active') return 'vb-status-pill--running';
  return 'vb-status-pill--done';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function activityClass(activity: RobotJobDto['activity']): string {
  switch (activity) {
    case 'thinking': return 'vb-status-pill--running';
    case 'running_tools': return 'vb-status-pill--running';
    case 'waiting': return 'vb-status-pill--waiting';
    case 'stopping': return 'vb-status-pill--waiting';
    case 'uncertain': return 'vb-status-pill--error';
    case 'error': return 'vb-status-pill--error';
    default: return 'vb-status-pill--done';
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  error.value = null;
  try {
    const [dash, deploy] = await Promise.all([robotApi.getRobotDashboard(), robotApi.getDeployStatus()]);
    dashboard.value = dash;
    deployStatus.value = deploy;
    lastRefreshedAt.value = new Date().toISOString();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load robot dashboard.';
  } finally {
    refreshing.value = false;
  }
}

async function openTopic(topicId: string): Promise<void> {
  await router.push({ name: 'topic.view', params: { topicId } });
}

function canStopTopic(topicId: string): boolean {
  return !loading.value && (
    jobs.value.some((job) => job.topicId === topicId) ||
    queue.value.some((item) => item.topicId === topicId)
  );
}

function requestStopTopic(topicId: string): void {
  if (!canStopTopic(topicId)) return;
  stopConfirmationTopicId.value = topicId;
}

async function confirmStopTopic(): Promise<void> {
  const topicId = stopConfirmationTopicId.value;
  stopConfirmationTopicId.value = null;
  if (!topicId || !canStopTopic(topicId)) return;
  await interruptTopic(topicId);
}

async function interruptTopic(topicId: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await robotApi.interruptRobot(topicId);
    stopResults.value = { ...stopResults.value, [topicId]: result };
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to interrupt robot.';
  } finally {
    loading.value = false;
  }
}

async function continueTopic(topicId: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    await robotApi.continueRobot(topicId);
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to continue robot.';
  } finally {
    loading.value = false;
  }
}

async function triggerDeploy(): Promise<void> {
  const confirmed = window.confirm(
    'Deploy now?\n\nThis will restart the service and can interrupt active/waiting jobs.'
  );
  if (!confirmed) return;
  loading.value = true;
  error.value = null;
  try {
    await robotApi.triggerDeploy();
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to start deploy.';
  } finally {
    loading.value = false;
  }
}

async function triggerDeployOnFinish(): Promise<void> {
  const confirmed = window.confirm(
    'Deploy on Finish?\n\nThis will wait for all active and waiting robot jobs to finish, then automatically deploy.\n\nDeploying still restarts the service.'
  );
  if (!confirmed) return;

  loading.value = true;
  error.value = null;
  try {
    await robotApi.triggerDeployOnFinish();
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to schedule deploy.';
  } finally {
    loading.value = false;
  }
}

async function cancelDeployOnFinish(): Promise<void> {
  const confirmed = window.confirm('Cancel Deploy on Finish?');
  if (!confirmed) return;

  loading.value = true;
  error.value = null;
  try {
    await robotApi.cancelDeployOnFinish();
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to cancel scheduled deploy.';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  if (state.currentUser.value?.kind !== 'admin') {
    await router.push('/');
    return;
  }

  await refresh();
  refreshTimer = setInterval(() => {
    void refresh();
  }, 5000);
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <ConfirmationDialog
    :open="stopConfirmationTopicId !== null"
    title="Stop robot?"
    message="This will stop the current response and cancel queued or delegated work for this session. Partial output will remain visible, but work already performed cannot be undone."
    confirm-label="Stop robot"
    cancel-label="Keep running"
    :pending="loading"
    @confirm="confirmStopTopic"
    @cancel="stopConfirmationTopicId = null"
  />

  <section class="vb-section vb-fade-in">
    <div class="vb-table-header vb-dashboard-header">
      <div class="vb-dashboard-title">
        Robot Dashboard
        <span class="vb-dashboard-subtitle">Admin only</span>
      </div>
      <div class="vb-dashboard-actions">
        <button class="vb-small-btn" type="button" :disabled="loading || refreshing" @click="refresh">Refresh</button>
        <router-link class="vb-small-btn" to="/admin">Admin Panel</router-link>
      </div>
    </div>

    <div v-if="error" class="vb-login-error" style="margin-bottom: 10px;">
      {{ error }}
    </div>
    <div v-for="(result, topicId) in stopResults" :key="topicId" class="vb-panel" style="margin-bottom: 10px;">
      <strong>Stop {{ result.state }}</strong> · {{ result.message }}
      <span v-if="result.effectsUnknownCount"> Remote effects unknown: {{ result.effectsUnknownCount }}.</span>
    </div>

    <div class="vb-dashboard-grid">
      <div class="vb-panel">
        <div class="vb-panel-title">Deploy</div>
        <div class="vb-panel-body">
          <div class="vb-kv">
            <div class="vb-k">Enabled</div>
            <div class="vb-v">{{ deployStatus?.enabled ? 'Yes' : 'No' }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Running</div>
            <div class="vb-v">{{ deployStatus?.running ? 'Yes' : 'No' }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Last Started</div>
            <div class="vb-v">{{ deployStatus?.lastStartedAt ? formatDateTime(deployStatus.lastStartedAt) : 'n/a' }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Commit</div>
            <div class="vb-v">
              <code v-if="deployStatus?.commitSha" class="vb-cwd-path" :title="deployStatus.commitSha">
                {{ deployStatus.commitSha.slice(0, 10) }}
              </code>
              <span v-else>n/a</span>
            </div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Deploy on Finish</div>
            <div class="vb-v">
              <span v-if="deployOnFinishPending">
                Scheduled ({{ deployOnFinishRequestedAt ? formatDateTime(deployOnFinishRequestedAt) : 'n/a' }})
              </span>
              <span v-else>Off</span>
            </div>
          </div>
          <div v-if="deployStatus?.deployOnFinishLastError" class="vb-login-error" style="margin-top: 8px;">
            Deploy on Finish error: {{ deployStatus.deployOnFinishLastError }}
          </div>
          <div class="vb-panel-actions">
            <div class="vb-panel-actions-row">
              <button
                class="vb-btn"
                type="button"
                :disabled="loading || !deployStatus?.enabled || Boolean(deployStatus?.running)"
                @click="triggerDeploy"
              >
                {{ deployStatus?.running ? 'Deploying…' : 'Deploy' }}
              </button>
              <button
                class="vb-btn"
                type="button"
                :disabled="loading || !deployStatus?.enabled || Boolean(deployStatus?.running) || deployOnFinishPending"
                @click="triggerDeployOnFinish"
              >
                {{ deployOnFinishPending ? 'Deploy on Finish (Scheduled)…' : 'Deploy on Finish' }}
              </button>
              <button
                v-if="deployOnFinishPending"
                class="vb-btn vb-btn-danger"
                type="button"
                :disabled="loading || Boolean(deployStatus?.running)"
                @click="cancelDeployOnFinish"
              >
                Cancel Deploy on Finish
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="vb-panel vb-panel--stats-right">
        <div class="vb-panel-title">Robot Load</div>
        <div class="vb-panel-body">
          <div class="vb-kv">
            <div class="vb-k">Busy</div>
            <div class="vb-v">{{ busyJobs.length }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Queued</div>
            <div class="vb-v">{{ queue.length }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Waiting (db)</div>
            <div class="vb-v">{{ waitingJobs.length }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Background subagents</div>
            <div class="vb-v">{{ subagents?.available ? subagents.activeCount : 'unavailable' }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Uncertain blockers</div>
            <div class="vb-v">{{ subagents?.available ? subagents.uncertainCount : 'unknown' }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Tracked removable bytes</div>
            <div class="vb-v">{{ subagents?.retention?.available ? formatBytes(subagents.retention.trackedRemovableBytes) : 'inventory pending' }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Retention preview</div>
            <div class="vb-v">{{ subagents?.retention?.available ? `${subagents.retention.counts.eligible} eligible · ${subagents.retention.counts.protected} protected` : 'unavailable' }}</div>
          </div>
          <div class="vb-kv">
            <div class="vb-k">Refreshed</div>
            <div class="vb-v">{{ lastRefreshedAt ? formatDateTime(lastRefreshedAt) : 'n/a' }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="vb-forum-list vb-forum-list--jobs">
      <div class="vb-category-header">
        <div class="vb-category-title">Active / Waiting Jobs</div>
      </div>

      <div class="vb-dashboard-table-scroll" aria-label="Active and waiting jobs">
        <div class="vb-job-row vb-job-row--header">
          <div class="vb-job-main">Topic</div>
          <div class="vb-job-activity">Activity</div>
          <div class="vb-job-updated">Last Update</div>
          <div class="vb-job-model">Model</div>
          <div class="vb-job-actions">Actions</div>
        </div>

        <div v-if="refreshing && jobs.length === 0" class="vb-empty-state">
          <div class="vb-spinner vb-spinner-dark" style="width: 24px; height: 24px;"></div>
          <div class="vb-empty-state-text" style="margin-top: 12px;">Loading…</div>
        </div>

        <div v-else-if="jobs.length === 0" class="vb-empty-state">
          <div class="vb-empty-state-icon">&#129302;</div>
          <div class="vb-empty-state-text">No active robot jobs right now.</div>
        </div>

        <div v-else>
          <div
            v-for="(job, index) in jobs"
            :key="job.topicId"
            class="vb-job-row"
            :class="index % 2 === 0 ? 'vb-alt-row-1' : 'vb-alt-row-2'"
          >
            <div class="vb-job-main">
              <div class="vb-job-title">
                <span class="vb-job-topic" @click="openTopic(job.topicId)">
                  {{ job.topicTitle ?? job.topicId }}
                </span>
                <span class="vb-job-meta">
                  <span v-if="job.forumName">in {{ job.forumName }}</span>
                  <span v-if="job.topicStatus">· {{ job.topicStatus }}</span>
                  <span v-if="job.threadLoaded === true">· loaded</span>
                  <span v-else-if="job.threadLoaded === false">· not loaded; canonical stop available</span>
                  <span v-if="job.activeTurnId">· interruptible</span>
                </span>
              </div>
            </div>

            <div class="vb-job-activity">
              <span class="vb-status-pill" :class="activityClass(job.activity)">{{ activityLabel(job.activity) }}</span>
            </div>

            <div class="vb-job-updated">
              {{ formatDateTime(job.lastUpdatedAt) }}
            </div>

            <div class="vb-job-model">
              <div class="vb-job-model-main">{{ job.model ?? 'default' }}</div>
              <div v-if="job.reasoningEffort" class="vb-job-model-sub">effort: {{ job.reasoningEffort }}</div>
            </div>

            <div class="vb-job-actions">
              <button class="vb-btn vb-btn-compact" type="button" :disabled="loading" @click="openTopic(job.topicId)">Open</button>
              <button class="vb-btn vb-btn-danger vb-btn-compact" type="button" :disabled="loading" @click="requestStopTopic(job.topicId)">Stop</button>
              <button class="vb-btn vb-btn-compact" type="button" :disabled="loading || job.activity === 'stopping' || job.activity === 'uncertain'" @click="continueTopic(job.topicId)">Continue</button>
              <span v-if="stopResults[job.topicId]" class="vb-job-meta">{{ stopResults[job.topicId]?.message }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="vb-forum-list vb-forum-list--subagents">
      <div class="vb-category-header">
        <div class="vb-category-title">Background Subagents</div>
      </div>
      <div v-if="subagents?.retention" class="vb-empty-state vb-empty-state--notice" style="margin: 10px;">
        <div class="vb-empty-state-text">
          Retention dry-run: {{ subagents.retention.counts.eligible }} eligible ({{ formatBytes(subagents.retention.eligibleBytes) }} expected reclaimable),
          {{ subagents.retention.counts.waiting }} waiting, {{ subagents.retention.counts.protected }} protected,
          {{ subagents.retention.counts.compacted }} compacted, {{ subagents.retention.counts.error }} errors.
          Automatic compaction removes only bulky lifecycle logs after {{ subagents.retention.retentionDays }} days with terminal, non-resumable, centrally acknowledged delivery proof; child sessions are always preserved.
          <span v-if="subagents.retention.lastError"> Last error: {{ subagents.retention.lastError }}</span>
        </div>
      </div>
      <div v-if="subagents && !subagents.available" class="vb-login-error" style="margin: 10px;">
        Agentd workload unavailable: {{ subagents.error ?? 'unknown error' }}
      </div>
      <div v-else-if="subagentBlockers.length === 0 && subagentPendingDelivery.length === 0 && subagentHistory.length === 0" class="vb-empty-state vb-empty-state--notice">
        <div class="vb-empty-state-text">No retained background subagent runs.</div>
      </div>
      <template v-else>
        <div class="vb-category-title vb-subagent-group-title">Deployment safety blockers</div>
        <div v-if="subagentBlockers.length === 0 && (subagents?.blockerCount ?? 0) === 0" class="vb-empty-state vb-empty-state--notice"><div class="vb-empty-state-text">No subagent safety blockers.</div></div>
        <div v-else-if="subagentBlockers.length === 0" class="vb-login-error" style="margin: 10px;">Authoritative agentd counts report {{ subagents?.blockerCount ?? subagents?.activeCount ?? 'unknown' }} blocker(s), but their details were omitted. Treat deployment as blocked.</div>
        <div v-if="(subagents?.omittedBlockerCount ?? 0) > 0" class="vb-login-error" style="margin: 10px;">{{ subagents?.omittedBlockerCount }} additional blocker detail(s) omitted by the agentd response cap.</div>
        <div v-else class="vb-dashboard-table-scroll" aria-label="Subagent blockers">
          <div v-for="run in subagentBlockers" :key="run.runId" class="vb-subagent-row">
            <div><strong>{{ run.topicTitle ?? run.topicId ?? 'Unmapped parent' }}</strong><div class="vb-job-meta"><code>{{ run.runId }}</code><span v-if="run.reason"> · {{ run.reason }}</span><span v-if="run.updatedAt"> · {{ formatDateTime(run.updatedAt) }}</span></div></div>
            <span class="vb-status-pill" :class="subagentStateClass(run.executionState)">{{ run.executionState }}</span>
            <span>{{ run.effectsState === 'unknown' ? 'effects unknown' : (run.deliveryState ?? 'unknown delivery') }}</span>
            <button v-if="run.topicId" class="vb-btn vb-btn-compact" type="button" @click="openTopic(run.topicId)">Open parent</button><span v-else>Needs attention</span>
          </div>
        </div>
        <div class="vb-category-title vb-subagent-group-title">Pending delivery / manual recovery</div>
        <div v-if="subagentPendingDelivery.length === 0" class="vb-empty-state vb-empty-state--notice"><div class="vb-empty-state-text">No completion evidence awaits manual recovery.</div></div>
        <div v-else class="vb-dashboard-table-scroll" aria-label="Pending subagent delivery">
          <div v-for="run in subagentPendingDelivery" :key="run.runId" class="vb-subagent-row">
            <div><strong>{{ run.topicTitle ?? run.topicId ?? 'Unmapped parent' }}</strong><div class="vb-job-meta"><code>{{ run.runId }}</code><span v-if="run.reason"> · {{ run.reason }}</span><span v-if="run.updatedAt"> · {{ formatDateTime(run.updatedAt) }}</span></div></div>
            <span class="vb-status-pill" :class="subagentStateClass(run.executionState)">{{ run.executionState }}</span><span>pending/manual</span>
            <button v-if="run.topicId" class="vb-btn vb-btn-compact" type="button" @click="openTopic(run.topicId)">Open parent</button><span v-else>Needs attention</span>
          </div>
        </div>
        <details v-if="subagentHistory.length > 0" class="vb-subagent-history">
          <summary>Retained terminal history ({{ subagentHistory.length }})</summary>
          <div class="vb-dashboard-table-scroll" aria-label="Retained subagent history">
            <div v-for="run in subagentHistory" :key="run.runId" class="vb-subagent-row">
              <div><strong>{{ run.topicTitle ?? run.topicId ?? 'Unmapped parent' }}</strong><div class="vb-job-meta"><code>{{ run.runId }}</code><span v-if="run.reason"> · {{ run.reason }}</span><span v-if="run.updatedAt"> · {{ formatDateTime(run.updatedAt) }}</span></div></div>
              <span class="vb-status-pill" :class="subagentStateClass(run.executionState)">{{ run.executionState }}</span><span>{{ run.deliveryState ?? 'settled' }}</span>
              <button v-if="run.topicId" class="vb-btn vb-btn-compact" type="button" @click="openTopic(run.topicId)">Open parent</button><span v-else>Retained</span>
            </div>
          </div>
        </details>
      </template>
    </div>

    <div class="vb-forum-list vb-forum-list--queue">
      <div class="vb-category-header">
        <div class="vb-category-title">Queue (In-Memory)</div>
      </div>

      <div class="vb-dashboard-table-scroll" aria-label="In-memory queue">
        <div class="vb-queue-row vb-queue-row--header">
          <div class="vb-queue-main">Topic</div>
          <div class="vb-queue-queued">Queued At</div>
          <div class="vb-queue-actions">Actions</div>
        </div>

        <div v-if="queue.length === 0" class="vb-empty-state vb-empty-state--notice">
          <div class="vb-empty-state-text">Queue is empty.</div>
        </div>
        <div v-else>
          <div
            v-for="(item, index) in queue"
            :key="`${item.position}:${item.topicId}:${item.queuedAt}`"
            class="vb-queue-row"
            :class="index % 2 === 0 ? 'vb-alt-row-1' : 'vb-alt-row-2'"
          >
            <div class="vb-queue-main">
              <div class="vb-queue-title">
                <span class="vb-queue-pos">{{ item.position }}</span>
                <span class="vb-queue-topic" @click="openTopic(item.topicId)">
                  {{ item.topicTitle ?? item.topicId }}
                </span>
                <span class="vb-queue-meta">
                  <span v-if="item.forumName">in {{ item.forumName }}</span>
                  <span v-if="item.parentPostId">· parent post {{ item.parentPostId }}</span>
                </span>
              </div>
            </div>
            <div class="vb-queue-queued">
              {{ formatDateTime(item.queuedAt) }}
            </div>
            <div class="vb-queue-actions">
              <button class="vb-btn vb-btn-compact" type="button" :disabled="loading" @click="openTopic(item.topicId)">Open</button>
              <button class="vb-btn vb-btn-danger vb-btn-compact" type="button" :disabled="loading" @click="requestStopTopic(item.topicId)">Interrupt</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.vb-forum-list {
  min-width: 0;
}

.vb-dashboard-table-scroll {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.vb-dashboard-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.vb-dashboard-subtitle {
  font-size: 11px;
  font-weight: normal;
  opacity: 0.9;
}

.vb-dashboard-actions {
  display: flex;
  gap: 8px;
}

.vb-dashboard-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 20px;
}

@media (max-width: 900px) {
  .vb-dashboard-grid {
    grid-template-columns: 1fr;
  }
}

.vb-panel {
  border: 1px solid var(--border-default);
  background: var(--bg-surface-alt);
}

.vb-panel-title {
  padding: 8px 10px;
  background: linear-gradient(var(--grad-header-start), var(--grad-header-end));
  color: var(--text-inverse);
  font-weight: bold;
  font-size: 12px;
}

.vb-panel-body {
  padding: 10px;
}

.vb-kv {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-default);
  font-size: 12px;
}

.vb-kv:last-child {
  border-bottom: none;
}

.vb-k {
  color: var(--text-secondary);
}

.vb-v {
  color: var(--text-default);
  font-weight: bold;
}

.vb-panel--stats-right .vb-v {
  text-align: right;
  min-width: 70px;
}

.vb-panel-actions {
  margin-top: 10px;
}

.vb-panel-actions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.vb-job-row,
.vb-queue-row {
  display: grid;
  align-items: stretch;
  border-bottom: 1px solid var(--border-default);
}

.vb-job-row {
  grid-template-columns: minmax(260px, 1fr) 160px 185px 210px 230px;
}

.vb-queue-row {
  grid-template-columns: minmax(260px, 1fr) 210px 180px;
}

.vb-job-row:hover,
.vb-queue-row:hover {
  background: var(--bg-surface-hover);
}

.vb-job-row--header,
.vb-queue-row--header {
  background: var(--table-section-bg);
  font-weight: bold;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.vb-job-row--header:hover,
.vb-queue-row--header:hover {
  background: var(--table-section-bg);
}

.vb-alt-row-1 {
  background: var(--bg-surface);
}

.vb-alt-row-2 {
  background: var(--bg-surface-alt);
}

.vb-job-main,
.vb-queue-main {
  padding: 10px 12px;
  min-width: 0;
}

.vb-job-title,
.vb-queue-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.vb-job-topic,
.vb-queue-topic {
  font-weight: bold;
  color: var(--brand-primary-light);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vb-job-topic:hover,
.vb-queue-topic:hover {
  color: var(--brand-primary-hover);
  text-decoration: underline;
}

.vb-job-meta,
.vb-queue-meta {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vb-job-activity,
.vb-job-updated,
.vb-job-model,
.vb-job-actions,
.vb-queue-queued,
.vb-queue-actions {
  padding: 10px;
  border-left: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}

.vb-job-activity {
  align-items: center;
  text-align: center;
}

.vb-job-updated {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}

.vb-job-model {
  text-align: left;
}

.vb-job-model-main {
  font-size: 12px;
  font-weight: bold;
  color: var(--text-default);
}

.vb-job-model-sub {
  font-size: 11px;
  color: var(--text-muted);
}

.vb-job-actions {
  align-items: center;
  justify-content: center;
  flex-direction: row;
  gap: 6px;
}

.vb-queue-queued {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}

.vb-queue-actions {
  align-items: center;
  justify-content: center;
  flex-direction: row;
  gap: 6px;
}

.vb-status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: bold;
  border: 1px solid var(--border-default);
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
  text-transform: uppercase;
}

.vb-status-pill--running {
  background: var(--status-success-bg);
  border-color: var(--status-success);
  color: var(--status-success);
}

.vb-status-pill--waiting {
  background: var(--status-warning-bg);
  border-color: var(--status-warning);
  color: var(--status-warning);
}

.vb-status-pill--error {
  background: var(--status-error-bg);
  border-color: var(--status-error);
  color: var(--status-error);
}

.vb-job-activity,
.vb-job-updated,
.vb-job-model,
.vb-job-actions,
.vb-queue-queued,
.vb-queue-actions {
  border-left: 1px solid var(--border-default);
}

.vb-job-activity,
.vb-job-updated,
.vb-job-model,
.vb-job-actions {
  border-left: 1px solid var(--border-default);
}

.vb-job-row--header .vb-job-activity,
.vb-job-row--header .vb-job-updated,
.vb-job-row--header .vb-job-model,
.vb-job-row--header .vb-job-actions,
.vb-queue-row--header .vb-queue-queued,
.vb-queue-row--header .vb-queue-actions {
  background: none;
  text-align: center;
}

.vb-job-row--header .vb-job-main,
.vb-queue-row--header .vb-queue-main {
  text-align: left;
}

.vb-btn-compact {
  padding: 4px 8px;
  font-size: 10px;
  border-radius: 3px;
}

.vb-empty-state--notice {
  background: var(--notice-bg);
  border: 1px solid var(--notice-border);
  color: var(--notice-text);
}

.vb-forum-list--queue,
.vb-forum-list--subagents {
  margin-top: 18px;
}

.vb-subagent-row {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 140px 180px 140px;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-surface);
  font-size: 12px;
}

@media (max-width: 1100px) {
  .vb-job-actions {
    flex-wrap: wrap;
  }

  .vb-job-row {
    grid-template-columns: minmax(220px, 1fr) 150px 170px 190px 210px;
  }
}

@media (max-width: 1000px) {
  .vb-queue-row {
    grid-template-columns: minmax(220px, 1fr) 190px 160px;
  }
}
</style>
