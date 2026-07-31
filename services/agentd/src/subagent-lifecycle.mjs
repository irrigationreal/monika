import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SUBAGENT_RUN_CUSTOM_TYPE = 'monika.subagent.run';
export const SUBAGENT_RUN_VERSION = 1;
export const SUBAGENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set(['pending', 'registered', 'launching', 'queued', 'running', 'stopping']);
const MAX_PUBLIC_RUNS = 64;
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function string(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function runId(value) { const data = record(value); return string(data?.runId ?? data?.id ?? data?.asyncId); }
function validObservedProcessTerminal(value, expectedRunId = null) {
  const proof = record(value);
  if (!proof || proof.version !== 1 || proof.state !== 'observed'
    || !string(proof.runId) || (expectedRunId && proof.runId !== expectedRunId)
    || !string(proof.runnerProcessInstanceId)
    || typeof proof.observedAt !== 'number' || !Number.isFinite(proof.observedAt)
    || !Array.isArray(proof.instances)) return false;
  return proof.instances.some((instance) => record(instance)?.kind === 'runner'
    && instance.processInstanceId === proof.runnerProcessInstanceId
    && typeof instance.closeObservedAt === 'number' && Number.isFinite(instance.closeObservedAt));
}
function terminalObserved(value, id = null) { return validObservedProcessTerminal(record(value)?.processTerminal ?? value, id); }
function safeState(value) { return string(value) ?? 'unknown'; }
function sessionMatches(conv, value) {
  const ref = string(value);
  if (!ref) return false;
  if (ref === conv?.piSessionId || ref === conv?.sessionPath) return true;
  return path.isAbsolute(ref) && path.isAbsolute(conv?.sessionPath ?? '')
    && path.resolve(ref) === path.resolve(conv.sessionPath);
}
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }

export function validateLifecycleArtifact(value, expected = {}) {
  const data = record(value);
  if (!data || !Number.isInteger(data.lifecycleArtifactVersion) || data.lifecycleArtifactVersion < 1) return null;
  const id = runId(data); const sessionId = string(data.sessionId);
  const asyncDir = string(data.asyncDir) ?? string(expected.asyncDir); const sessionDir = string(data.sessionDir);
  if (!id || !sessionId || !asyncDir || !path.isAbsolute(asyncDir)) return null;
  if (expected.runId && expected.runId !== id) return null;
  if (expected.sessionId && expected.sessionId !== sessionId) return null;
  return {
    lifecycleArtifactVersion: data.lifecycleArtifactVersion, runId: id, sessionId,
    asyncDir: path.resolve(asyncDir), sessionDir: sessionDir && path.isAbsolute(sessionDir) ? path.resolve(sessionDir) : null,
    state: safeState(data.state), pid: Number.isInteger(data.pid) ? data.pid : null,
    processTerminal: record(data.processTerminal),
    startedAt: data.startedAt ?? null,
    updatedAt: data.updatedAt ?? data.completedAt ?? data.endedAt ?? data.lastUpdate ?? data.timestamp ?? null,
    mode: string(data.mode),
  };
}

function originFor(conv) {
  const dispatches = conv?.provenanceState?.dispatches ?? [];
  const dispatch = [...dispatches].reverse().find((item) => item.accepted !== false && !item.settled)
    ?? [...dispatches].reverse().find((item) => item.provenance);
  return dispatch ? { turnId: dispatch.turnId ?? null, topicId: dispatch.provenance?.topicId ?? null, postId: dispatch.provenance?.postId ?? null }
    : { turnId: null, topicId: null, postId: null };
}
function publicRun(run) {
  return {
    run_id: run.runId, state: run.state, execution_state: run.executionState ?? (run.active ? 'active' : 'terminal'),
    delivery_state: run.deliveryState ?? null, blocking: Boolean(run.active), reason: run.reason ?? null,
    parent_session_id: run.sessionId ?? null, parent_session_path: run.artifactSessionId ?? null,
    async_dir: run.asyncDir ?? null, origin: run.origin ?? null,
    started_at: run.startedAt ?? null, updated_at: run.updatedAt ?? null, completed_at: run.completedAt ?? null,
  };
}
export function extractSubagentRuns(entries) {
  return entries.filter((entry) => entry?.type === 'custom' && entry.customType === SUBAGENT_RUN_CUSTOM_TYPE
    && record(entry.data)?.version === SUBAGENT_RUN_VERSION && runId(entry.data))
    .map((entry) => ({ entry_id: entry.id, parent_id: entry.parentId ?? null, ...entry.data }));
}
export function backgroundStatus(conv) {
  const runs = [...(conv?.subagents?.runs?.values?.() ?? [])]; const active = runs.filter((run) => run.active);
  return { active_count: active.length, total_count: runs.length,
    runs: runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, MAX_PUBLIC_RUNS).map(publicRun),
    omitted: Math.max(0, runs.length - MAX_PUBLIC_RUNS) };
}
export function hasActiveBackgroundWork(conv) { return backgroundStatus(conv).active_count > 0; }

export class SubagentLifecycle {
  constructor({ now = Date.now } = {}) { this.now = now; this.conv = null; this.unsubscribes = []; this.completions = []; this.eventBus = null; this.earlyEvents = []; }
  async attach(conv) { this.conv = conv; conv.subagents ??= { runs: new Map() }; this.restoreMappings(); await this.reconcileArtifacts(); const early = this.earlyEvents.splice(0); for (const event of early) { if (event.type === 'started') this.onStarted(event.value); else if (event.type === 'complete') this.onComplete(event.value); else this.onTerminal(event.value); } }
  adoptSnapshotRuns(snapshot) {
    for (const summary of snapshot?.runs ?? []) {
      const id = string(summary.run_id); const sessionRef = string(summary.parent_session_id ?? summary.parent_session_path);
      if (!id || this.conv.subagents.runs.has(id) || !sessionMatches(this.conv, sessionRef)) continue;
      this.conv.subagents.runs.set(id, {
        runId: id, sessionId: this.conv.piSessionId, artifactSessionId: sessionRef,
        asyncDir: string(summary.async_dir), state: summary.state, active: summary.blocking,
        executionState: summary.execution_state, reason: summary.reason ?? null,
        origin: record(summary.origin) ?? {}, startedAt: summary.started_at ?? null,
        updatedAt: summary.updated_at ?? null, completedAt: summary.blocking ? null : summary.updated_at ?? null,
      });
    }
  }
  async reconcileArtifacts(snapshot = null) {
    const byId = snapshot?.byId;
    for (const run of this.conv?.subagents?.runs?.values?.() ?? []) {
      let summary = byId?.get(run.runId) ?? null;
      if (!summary && run.asyncDir) {
        try { summary = await classifyRunDirectory(run.asyncDir, { runtime: snapshot?.runtime }); } catch { summary = null; }
      }
      if (!summary) continue;
      run.state = summary.state; run.executionState = summary.execution_state; run.reason = summary.reason;
      run.processTerminal = summary.processTerminal; run.active = summary.blocking;
      run.updatedAt = summary.updated_at; run.deliveryState = summary.delivery_state;
      if (!run.active) run.completedAt = summary.updated_at;
    }
    return backgroundStatus(this.conv);
  }
  restoreMappings() {
    const branch = this.conv?.session?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== SUBAGENT_RUN_CUSTOM_TYPE) continue;
      const data = record(entry.data); const id = runId(data);
      if (!id || data.version !== SUBAGENT_RUN_VERSION || !sessionMatches(this.conv, data.sessionId)) continue;
      const previous = this.conv.subagents.runs.get(id);
      this.conv.subagents.runs.set(id, { runId: id, sessionId: this.conv.piSessionId,
        artifactSessionId: string(data.artifactSessionId) ?? string(data.sessionId) ?? this.conv.sessionPath,
        asyncDir: string(data.asyncDir), state: previous?.state ?? 'unknown', active: previous?.active ?? true,
        executionState: previous?.executionState ?? 'uncertain', origin: record(data.origin) ?? {},
        startedAt: data.startedAt ?? null, completedAt: previous?.completedAt ?? null });
    }
  }
  extension() { const owner = this; return { name: 'agentd-subagent-lifecycle', hidden: true, factory(pi) { owner.eventBus = pi.events; owner.unsubscribes.push(pi.events.on('subagent:async-registering', (data) => owner.onStarted(data)), pi.events.on('subagent:async-started', (data) => owner.onStarted(data)), pi.events.on('subagent:async-complete', (data) => owner.onComplete(data)), pi.events.on('subagent:process-terminal', (data) => owner.onTerminal(data))); } }; }
  onStarted(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'started', value }); return true; }
    const data = record(value); const id = runId(data); const sessionId = string(data?.sessionId); const asyncDir = string(data?.asyncDir);
    if (!id || !sessionMatches(this.conv, sessionId) || !asyncDir || !path.isAbsolute(asyncDir)) return false;
    if (this.conv.subagents.runs.has(id)) return true;
    const run = { runId: id, sessionId: this.conv.piSessionId, artifactSessionId: sessionId, asyncDir: path.resolve(asyncDir), state: 'running', executionState: 'active', active: true, origin: originFor(this.conv), startedAt: this.now(), completedAt: null };
    this.conv.subagents.runs.set(id, run);
    this.conv.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, { version: SUBAGENT_RUN_VERSION, runId: id, sessionId: this.conv.piSessionId, artifactSessionId: run.artifactSessionId, asyncDir: run.asyncDir, origin: run.origin, startedAt: run.startedAt });
    return true;
  }
  onComplete(value) { if (!this.conv) { this.earlyEvents.push({ type: 'complete', value }); return true; } const data = record(value); const id = runId(data); if (!id) return false; const run = this.conv.subagents.runs.get(id); if (!run) return false; run.state = data.success === false ? 'failed' : safeState(data.state) === 'unknown' ? 'completed' : safeState(data.state); run.deliveryState = 'notified'; run.completedAt = this.now(); this.completions.push({ runId: id, origin: run.origin }); if (this.completions.length > 100) this.completions.shift(); return true; }
  onTerminal(value) { if (!this.conv) { this.earlyEvents.push({ type: 'terminal', value }); return true; } const id = runId(value); const run = this.conv?.subagents?.runs?.get(id); if (!run || !validObservedProcessTerminal(value, id)) return false; run.processTerminal = record(value); run.executionState = 'terminal'; run.active = false; run.completedAt = this.now(); return true; }
  handleSessionEvent(event) {
    const message = event?.message;
    if (event?.type === 'message_start' && message?.role === 'custom' && message.customType === 'subagent-notify') {
      const detailIds = Array.isArray(message.details?.runIds) ? message.details.runIds.map(string).filter(Boolean).slice(0, 100) : [];
      let completions;
      if (detailIds.length > 0) { completions = detailIds.flatMap((id) => { const run = this.conv.subagents.runs.get(id); return run ? [{ runId: id, origin: run.origin ?? {} }] : []; }); const claimed = new Set(detailIds); this.completions = this.completions.filter((completion) => !claimed.has(completion.runId)); }
      else { const grouped = typeof message.content === 'string' ? message.content.match(/^Background tasks completed \((\d+)\):/) : null; const requested = grouped ? Math.max(1, Math.min(100, Number(grouped[1]))) : 1; completions = this.completions.splice(0, requested); }
      const primary = completions[0] ?? null; const continuation = primary ? { ...primary, runIds: completions.map((c) => c.runId), origins: completions.map((c) => ({ runId: c.runId, ...c.origin })) } : null;
      if (this.conv.current) this.conv.subagents.currentContinuation = continuation; else this.conv.subagents.pendingContinuation = continuation;
    }
    if (event?.type === 'agent_start' && this.conv?.subagents?.pendingContinuation) { this.conv.subagents.currentContinuation = this.conv.subagents.pendingContinuation; this.conv.subagents.pendingContinuation = null; }
    if (event?.type === 'agent_settled') this.conv.subagents.currentContinuation = null;
  }
  continuation() { return this.conv?.subagents?.currentContinuation ?? null; }
  async requestStops() { const runs = [...(this.conv?.subagents?.runs?.values?.() ?? [])].filter((run) => run.active); if (!this.eventBus) return { requested: 0, unavailable: runs.length }; for (const run of runs) this.eventBus.emit('subagents:rpc:v1:request', { version: 1, requestId: randomUUID(), method: 'stop', params: { runId: run.runId }, source: { extension: 'agentd' } }); return { requested: runs.length, unavailable: 0 }; }
  dispose() { for (const unsubscribe of this.unsubscribes) { try { unsubscribe?.(); } catch {} } this.unsubscribes = []; }
}

async function lifecycleEntries(root) {
  const output = new Map();
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT' && depth === 0) return; throw error; }
    for (const entry of entries) { const candidate = path.join(dir, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) await walk(candidate, depth + 1); else if (entry.isFile() && (entry.name === 'status.json' || entry.name === 'launch.json')) output.set(path.dirname(candidate), true); }
  }
  await walk(root, 0); return [...output.keys()];
}
function timestampMs(value) { if (typeof value === 'number' && Number.isFinite(value)) return value; const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; }
async function readRuntimeInstance(runtimeInstanceFile) {
  if (!runtimeInstanceFile) return null;
  const data = await readJson(runtimeInstanceFile).catch(() => null);
  return data && string(data.id) && Number.isFinite(data.createdAt) ? { id: data.id, createdAt: data.createdAt } : null;
}
async function processAlive(pid, launch = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const expectedTicks = string(launch?.processStartTicks);
    if (!expectedTicks) return true;
    const close = stat.lastIndexOf(')');
    const actualTicks = stat.slice(close + 2).split(/\s+/)[19];
    return actualTicks === expectedTicks;
  } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
async function classifyRunDirectory(asyncDir, { runtime = null, processInspector = processAlive, resultsRoot = null } = {}) {
  const statusRaw = await readJson(path.join(asyncDir, 'status.json')).catch(() => null);
  const launch = await readJson(path.join(asyncDir, 'launch.json')).catch(() => null);
  const id = runId(statusRaw) ?? runId(launch) ?? path.basename(asyncDir);
  const status = statusRaw ? validateLifecycleArtifact(statusRaw, { runId: id, asyncDir }) : null;
  if (!status && !launch) return { run_id: id, state: 'unknown', execution_state: 'uncertain', delivery_state: null, blocking: true, reason: 'malformed-lifecycle-artifact', async_dir: asyncDir, processTerminal: null };
  let proof = await readJson(path.join(asyncDir, 'process-terminal.json')).catch(() => null);
  if (!proof) proof = status?.processTerminal ?? null;
  const operatorResolution = await readJson(path.join(asyncDir, 'operator-resolution.json')).catch(() => null);
  const expectedInstanceId = string(proof?.runnerProcessInstanceId) ?? string(launch?.runnerProcessInstanceId);
  const operatorQuarantined = operatorResolution?.version === 1 && operatorResolution.action === 'quarantine'
    && operatorResolution.runId === id && string(operatorResolution.runnerProcessInstanceId) === expectedInstanceId;
  const logicalTerminal = status ? !ACTIVE_STATES.has(status.state) && status.state !== 'unknown' : false;
  const runnerPid = Number.isInteger(status?.pid) ? status.pid : Number.isInteger(launch?.pid) ? launch.pid : null;
  const launchRuntimeId = string(launch?.runtimeInstanceId);
  let executionState = 'uncertain'; let blocking = true; let reason = null;
  if (operatorQuarantined) { executionState = 'quarantined'; blocking = false; reason = `operator-quarantine:${string(operatorResolution.reason) ?? 'no-reason'}`; }
  else if (proof?.version === 1 && proof?.state === 'not-started' && proof?.runId === id) { executionState = 'interrupted'; blocking = false; reason = 'runner-not-started'; }
  else if (validObservedProcessTerminal(proof, id)) { executionState = 'terminal'; blocking = false; }
  else {
    const updated = timestampMs(status?.updatedAt ?? launch?.updatedAt ?? launch?.registeredAt);
    if (runtime && launchRuntimeId && launchRuntimeId !== runtime.id) { executionState = 'interrupted'; blocking = false; reason = 'prior-runtime-instance'; }
    else if (runtime && !launchRuntimeId && updated !== null && updated < runtime.createdAt) { executionState = 'interrupted'; blocking = false; reason = 'legacy-record-predates-runtime'; }
    else if (Number.isInteger(runnerPid) && launchRuntimeId && runtime?.id === launchRuntimeId && !(await processInspector(runnerPid, launch))) { executionState = 'interrupted'; blocking = false; reason = logicalTerminal ? 'terminal-runner-no-longer-present' : 'runner-no-longer-present'; }
    else if (logicalTerminal && Number.isInteger(runnerPid) && !(await processInspector(runnerPid, launch))) { executionState = 'interrupted'; blocking = false; reason = 'terminal-runner-no-longer-present'; }
    else if (logicalTerminal) { reason = string(proof?.reason) ?? 'terminal-proof-unavailable'; }
    else { executionState = 'active'; reason = status ? null : 'launch-not-yet-settled'; }
  }
  const resultFile = resultsRoot ? path.join(resultsRoot, `${id}.json`) : null;
  const deliveryState = resultFile && await fs.access(resultFile).then(() => true).catch(() => false) ? 'pending' : 'settled-or-unavailable';
  return { run_id: id, state: status?.state ?? safeState(launch?.state), execution_state: executionState, delivery_state: deliveryState,
    blocking, reason, parent_session_id: status?.sessionId ?? string(launch?.sessionId), parent_session_path: status?.sessionId ?? string(launch?.sessionId),
    async_dir: asyncDir, mode: status?.mode ?? string(launch?.mode), pid: runnerPid,
    started_at: status?.startedAt ?? launch?.registeredAt ?? null, updated_at: status?.updatedAt ?? launch?.updatedAt ?? null,
    processTerminal: proof, runtime_instance_id: launchRuntimeId, origin: null };
}
export async function scanLifecycleSnapshot({ lifecycleRoot, runtimeInstanceFile = '/run/monika-runtime-instance.json', processInspector, resultsRoot } = {}) {
  const resolvedRoot = path.resolve(lifecycleRoot ?? '');
  if (!path.isAbsolute(lifecycleRoot ?? '') || resolvedRoot === path.parse(resolvedRoot).root) throw new Error('dedicated absolute subagent lifecycle root is required');
  const runtime = await readRuntimeInstance(runtimeInstanceFile); const runs = [];
  for (const dir of await lifecycleEntries(resolvedRoot)) { if (!isWithin(resolvedRoot, dir)) continue; try { runs.push(await classifyRunDirectory(dir, { runtime, processInspector, resultsRoot })); } catch (error) { runs.push({ run_id: path.basename(dir), state: 'unknown', execution_state: 'uncertain', delivery_state: null, blocking: true, reason: `lifecycle-read-failed:${error?.code ?? error?.message ?? 'error'}`, async_dir: dir }); } }
  runs.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  return { runtime, runs, byId: new Map(runs.map((run) => [run.run_id, { ...run, runId: run.run_id, active: run.blocking, asyncDir: run.async_dir, updatedAt: run.updated_at, deliveryState: run.delivery_state, executionState: run.execution_state }])), active_count: runs.filter((run) => run.blocking).length, uncertain_count: runs.filter((run) => run.execution_state === 'uncertain').length };
}
export async function scanActiveLifecycleRuns(opts = {}) { const snapshot = await scanLifecycleSnapshot(opts); return snapshot.runs.filter((run) => run.blocking).map((run) => ({ ...run, runId: run.run_id, asyncDir: run.async_dir })); }

export function mergeMappedLifecycleRuns(snapshot, conversations = []) {
  for (const conv of conversations) {
    conv.subagentLifecycle?.adoptSnapshotRuns(snapshot);
    for (const run of conv.subagents?.runs?.values?.() ?? []) {
      if (snapshot.byId.has(run.runId)) continue;
      const missing = { run_id: run.runId, runId: run.runId, state: 'unknown', execution_state: 'uncertain', executionState: 'uncertain',
        delivery_state: run.deliveryState ?? null, deliveryState: run.deliveryState ?? null, blocking: true, active: true,
        reason: 'mapped-lifecycle-artifact-missing', parent_session_id: run.sessionId, parent_session_path: run.artifactSessionId,
        async_dir: run.asyncDir, asyncDir: run.asyncDir, started_at: run.startedAt, updated_at: null, updatedAt: null, origin: run.origin ?? null };
      snapshot.runs.push(missing); snapshot.byId.set(run.runId, missing);
    }
  }
  snapshot.active_count = snapshot.runs.filter((run) => run.blocking).length;
  snapshot.uncertain_count = snapshot.runs.filter((run) => run.execution_state === 'uncertain').length;
  return snapshot;
}

export async function quarantineLifecycleRun({ lifecycleRoot, runId: requestedRunId, runnerProcessInstanceId, reason, runtimeInstanceFile = '/run/monika-runtime-instance.json', processInspector } = {}) {
  const id = string(requestedRunId); const expected = string(runnerProcessInstanceId); const operatorReason = string(reason);
  if (!id || path.basename(id) !== id || !expected || !operatorReason) throw new Error('runId, runnerProcessInstanceId, and reason are required');
  const root = path.resolve(lifecycleRoot ?? '');
  const matches = (await lifecycleEntries(root)).filter((candidate) => path.basename(candidate) === id);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? 'run lifecycle directory not found' : 'run id is ambiguous');
  const asyncDir = matches[0];
  if (!isWithin(root, asyncDir)) throw new Error('invalid run path');
  const runtime = await readRuntimeInstance(runtimeInstanceFile);
  const current = await classifyRunDirectory(asyncDir, { runtime, processInspector });
  const launch = await readJson(path.join(asyncDir, 'launch.json')).catch(() => null);
  const status = await readJson(path.join(asyncDir, 'status.json')).catch(() => null);
  const proof = await readJson(path.join(asyncDir, 'process-terminal.json')).catch(() => null) ?? record(status)?.processTerminal;
  const actualInstance = string(proof?.runnerProcessInstanceId) ?? string(launch?.runnerProcessInstanceId);
  if (actualInstance !== expected) throw new Error('runner process instance confirmation does not match');
  const pid = Number.isInteger(status?.pid) ? status.pid : Number.isInteger(launch?.pid) ? launch.pid : null;
  if (current.execution_state === 'active' || (pid && await (processInspector ?? processAlive)(pid, launch))) throw new Error('refusing to quarantine a live runner');
  const resolution = { version: 1, action: 'quarantine', runId: id, runnerProcessInstanceId: expected, reason: operatorReason, resolvedAt: Date.now() };
  const file = path.join(asyncDir, 'operator-resolution.json'); const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(resolution, null, 2)}\n`, { mode: 0o600 });
  try {
    // Audit publication precedes the effective per-run resolution. If audit
    // persistence fails, classification remains fail-closed and the request
    // reports failure; a successful audit with a failed rename is also safe.
    await fs.appendFile(path.join(root, 'operator-resolutions.jsonl'), `${JSON.stringify(resolution)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return resolution;
}

/** Conservative retention: malformed, active, leased, and unproven-terminal child sessions survive. */
export async function pruneTerminalSubagentRuns({ lifecycleRoot, sessionRoot, nowMs = Date.now(), retentionMs = SUBAGENT_RETENTION_MS, activeRunIds = new Set(), hasSessionLease = () => false } = {}) {
  const resolvedLifecycleRoot = path.resolve(lifecycleRoot ?? ''); const resolvedSessionRoot = path.resolve(sessionRoot ?? '');
  for (const [label, raw, resolved] of [['lifecycle', lifecycleRoot, resolvedLifecycleRoot], ['session', sessionRoot, resolvedSessionRoot]]) if (!path.isAbsolute(raw ?? '') || resolved === path.parse(resolved).root) throw new Error(`dedicated absolute subagent ${label} root is required`);
  const canonicalSessionRoot = await fs.realpath(resolvedSessionRoot).catch(() => null); if (!canonicalSessionRoot) return { removed: [], retained: ['session-root-unavailable'] };
  const removed = []; const retained = [];
  for (const asyncDir of await lifecycleEntries(resolvedLifecycleRoot)) {
    const artifact = validateLifecycleArtifact(await readJson(path.join(asyncDir, 'status.json')).catch(() => null), { asyncDir });
    if (!artifact || artifact.asyncDir !== asyncDir || !artifact.sessionDir || !isWithin(resolvedSessionRoot, artifact.sessionDir)) { retained.push(asyncDir); continue; }
    const canonicalSessionDir = await fs.realpath(artifact.sessionDir).catch(() => null); const relative = canonicalSessionDir ? path.relative(canonicalSessionRoot, canonicalSessionDir) : '';
    if (!canonicalSessionDir || !relative || relative.startsWith('..') || path.isAbsolute(relative)) { retained.push(asyncDir); continue; }
    const timestamp = timestampMs(artifact.updatedAt);
    if (!terminalObserved(artifact, artifact.runId) || ACTIVE_STATES.has(artifact.state) || activeRunIds.has(artifact.runId) || hasSessionLease(artifact.sessionId) || timestamp === null || nowMs - timestamp < retentionMs) { retained.push(asyncDir); continue; }
    try { await fs.rm(canonicalSessionDir, { recursive: true, force: false }); removed.push(canonicalSessionDir); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return { removed, retained };
}
