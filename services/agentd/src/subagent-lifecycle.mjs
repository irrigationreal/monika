import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SUBAGENT_RUN_CUSTOM_TYPE = 'monika.subagent.run';
export const SUBAGENT_RUN_VERSION = 1;
export const SUBAGENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set(['pending', 'queued', 'running', 'stopping']);
const MAX_PUBLIC_RUNS = 16;
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function string(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function runId(value) { const data = record(value); return string(data?.runId ?? data?.id ?? data?.asyncId); }
function validObservedProcessTerminal(value) {
  const proof = record(value);
  if (!proof || proof.version !== 1 || proof.state !== 'observed'
    || !string(proof.runId) || !string(proof.runnerProcessInstanceId)
    || typeof proof.observedAt !== 'number' || !Number.isFinite(proof.observedAt)
    || !Array.isArray(proof.instances)) return false;
  return proof.instances.some((instance) => record(instance)?.kind === 'runner'
    && instance.processInstanceId === proof.runnerProcessInstanceId
    && typeof instance.closeObservedAt === 'number' && Number.isFinite(instance.closeObservedAt));
}
function terminalObserved(value) { return validObservedProcessTerminal(record(value)?.processTerminal); }
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

export function validateLifecycleArtifact(value, expected = {}) {
  const data = record(value);
  if (!data || !Number.isInteger(data.lifecycleArtifactVersion) || data.lifecycleArtifactVersion < 1) return null;
  const id = runId(data);
  const sessionId = string(data.sessionId);
  // status.json lives inside asyncDir but does not repeat that path in v3.
  const asyncDir = string(data.asyncDir) ?? string(expected.asyncDir);
  const sessionDir = string(data.sessionDir);
  if (!id || !sessionId || !asyncDir || !path.isAbsolute(asyncDir)) return null;
  if (expected.runId && expected.runId !== id) return null;
  if (expected.sessionId && expected.sessionId !== sessionId) return null;
  return {
    lifecycleArtifactVersion: data.lifecycleArtifactVersion,
    runId: id,
    sessionId,
    asyncDir: path.resolve(asyncDir),
    sessionDir: sessionDir && path.isAbsolute(sessionDir) ? path.resolve(sessionDir) : null,
    state: safeState(data.state),
    processTerminal: record(data.processTerminal),
    updatedAt: data.updatedAt ?? data.completedAt ?? data.endedAt ?? data.lastUpdate ?? data.timestamp ?? null,
  };
}

function originFor(conv) {
  const dispatches = conv?.provenanceState?.dispatches ?? [];
  const dispatch = [...dispatches].reverse().find((item) => item.accepted !== false && !item.settled)
    ?? [...dispatches].reverse().find((item) => item.provenance);
  return dispatch ? {
    turnId: dispatch.turnId ?? null,
    topicId: dispatch.provenance?.topicId ?? null,
    postId: dispatch.provenance?.postId ?? null,
  } : { turnId: null, topicId: null, postId: null };
}

function publicRun(run) {
  return {
    run_id: run.runId,
    state: run.state,
    active: Boolean(run.active),
    started_at: run.startedAt ?? null,
    completed_at: run.completedAt ?? null,
  };
}

export function extractSubagentRuns(entries) {
  return entries
    .filter((entry) => entry?.type === 'custom' && entry.customType === SUBAGENT_RUN_CUSTOM_TYPE
      && record(entry.data)?.version === SUBAGENT_RUN_VERSION && runId(entry.data))
    .map((entry) => ({ entry_id: entry.id, parent_id: entry.parentId ?? null, ...entry.data }));
}

export function backgroundStatus(conv) {
  const runs = [...(conv?.subagents?.runs?.values?.() ?? [])];
  const active = runs.filter((run) => run.active);
  return {
    active_count: active.length,
    total_count: runs.length,
    runs: runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, MAX_PUBLIC_RUNS).map(publicRun),
    omitted: Math.max(0, runs.length - MAX_PUBLIC_RUNS),
  };
}

export function hasActiveBackgroundWork(conv) { return backgroundStatus(conv).active_count > 0; }

export class SubagentLifecycle {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.conv = null;
    this.unsubscribes = [];
    this.completions = [];
    this.eventBus = null;
    this.earlyEvents = [];
  }

  async attach(conv) {
    this.conv = conv;
    conv.subagents ??= { runs: new Map() };
    this.restoreMappings();
    await this.reconcileArtifacts();
    const early = this.earlyEvents.splice(0);
    for (const event of early) {
      if (event.type === 'started') this.onStarted(event.value);
      else if (event.type === 'complete') this.onComplete(event.value);
      else this.onTerminal(event.value);
    }
  }

  async reconcileArtifacts() {
    for (const run of this.conv?.subagents?.runs?.values?.() ?? []) {
      if (!run.asyncDir) continue;
      const artifact = validateLifecycleArtifact(await readJson(path.join(run.asyncDir, 'status.json')), {
        runId: run.runId, sessionId: run.artifactSessionId ?? this.conv.sessionPath, asyncDir: run.asyncDir,
      });
      if (!artifact || artifact.asyncDir !== run.asyncDir) continue; // uncertainty retains the lease
      run.state = artifact.state;
      run.processTerminal = artifact.processTerminal;
      run.logicalTerminal = !ACTIVE_STATES.has(artifact.state) && artifact.state !== 'unknown';
      run.active = !run.logicalTerminal || !terminalObserved(run);
      if (!run.active) run.completedAt = artifact.updatedAt;
    }
  }

  restoreMappings() {
    const branch = this.conv?.session?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== SUBAGENT_RUN_CUSTOM_TYPE) continue;
      const data = record(entry.data);
      const id = runId(data);
      if (!id || data.version !== SUBAGENT_RUN_VERSION || !sessionMatches(this.conv, data.sessionId)) continue;
      const previous = this.conv.subagents.runs.get(id);
      this.conv.subagents.runs.set(id, {
        runId: id,
        sessionId: this.conv.piSessionId,
        artifactSessionId: string(data.artifactSessionId) ?? string(data.sessionId) ?? this.conv.sessionPath,
        asyncDir: string(data.asyncDir),
        state: previous?.state ?? 'unknown',
        active: previous?.active ?? true,
        origin: record(data.origin) ?? {},
        startedAt: data.startedAt ?? null,
        completedAt: previous?.completedAt ?? null,
      });
    }
  }

  extension() {
    const owner = this;
    return {
      name: 'agentd-subagent-lifecycle', hidden: true,
      factory(pi) {
        owner.eventBus = pi.events;
        owner.unsubscribes.push(
          pi.events.on('subagent:async-started', (data) => owner.onStarted(data)),
          pi.events.on('subagent:async-complete', (data) => owner.onComplete(data)),
          pi.events.on('subagent:process-terminal', (data) => owner.onTerminal(data)),
        );
      },
    };
  }

  onStarted(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'started', value }); return true; }
    const data = record(value); const id = runId(data); const sessionId = string(data?.sessionId);
    const asyncDir = string(data?.asyncDir);
    if (!this.conv || !id || !sessionMatches(this.conv, sessionId) || !asyncDir || !path.isAbsolute(asyncDir)) return false;
    if (this.conv.subagents.runs.has(id)) return true;
    const run = { runId: id, sessionId: this.conv.piSessionId, artifactSessionId: sessionId, asyncDir: path.resolve(asyncDir), state: 'running', active: true,
      logicalTerminal: false, origin: originFor(this.conv), startedAt: this.now(), completedAt: null };
    this.conv.subagents.runs.set(id, run);
    this.conv.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, {
      version: SUBAGENT_RUN_VERSION, runId: id, sessionId: this.conv.piSessionId,
      artifactSessionId: run.artifactSessionId, asyncDir: run.asyncDir,
      origin: run.origin, startedAt: run.startedAt,
    });
    return true;
  }

  onComplete(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'complete', value }); return true; }
    const data = record(value); const id = runId(data); if (!id) return false;
    const run = this.conv.subagents.runs.get(id); if (!run) return false;
    run.state = data.success === false ? 'failed' : safeState(data.state) === 'unknown' ? 'completed' : safeState(data.state);
    run.logicalTerminal = true;
    run.active = !terminalObserved(run);
    run.completedAt = this.now();
    this.completions.push({ runId: id, origin: run.origin });
    if (this.completions.length > 100) this.completions.shift();
    return true;
  }

  onTerminal(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'terminal', value }); return true; }
    const id = runId(value); const run = this.conv?.subagents?.runs?.get(id); if (!run) return false;
    const proof = record(value);
    if (!validObservedProcessTerminal(proof)) return false;
    run.processTerminal = proof;
    run.active = !run.logicalTerminal;
    return true;
  }

  handleSessionEvent(event) {
    const message = event?.message;
    if (event?.type === 'message_start' && message?.role === 'custom' && message.customType === 'subagent-notify') {
      const detailIds = Array.isArray(message.details?.runIds)
        ? message.details.runIds.map(string).filter(Boolean).slice(0, 100)
        : [];
      let completions;
      if (detailIds.length > 0) {
        completions = detailIds.flatMap((id) => {
          const run = this.conv.subagents.runs.get(id);
          return run ? [{ runId: id, origin: run.origin ?? {} }] : [];
        });
        const claimed = new Set(detailIds);
        this.completions = this.completions.filter((completion) => !claimed.has(completion.runId));
      } else {
        const grouped = typeof message.content === 'string'
          ? message.content.match(/^Background tasks completed \((\d+)\):/)
          : null;
        const requested = grouped ? Math.max(1, Math.min(100, Number(grouped[1]))) : 1;
        completions = this.completions.splice(0, requested);
      }
      const primary = completions[0] ?? null;
      const continuation = primary ? {
        ...primary,
        runIds: completions.map((completion) => completion.runId),
        origins: completions.map((completion) => ({ runId: completion.runId, ...completion.origin })),
      } : null;
      // Pi emits agent_start before message_start. Attach the machine-readable
      // notification to the already-open turn rather than waiting for another run.
      if (this.conv.current) this.conv.subagents.currentContinuation = continuation;
      else this.conv.subagents.pendingContinuation = continuation;
    }
    if (event?.type === 'agent_start' && this.conv?.subagents?.pendingContinuation) {
      this.conv.subagents.currentContinuation = this.conv.subagents.pendingContinuation;
      this.conv.subagents.pendingContinuation = null;
    }
    if (event?.type === 'agent_settled') this.conv.subagents.currentContinuation = null;
  }

  continuation() { return this.conv?.subagents?.currentContinuation ?? null; }

  async requestStops() {
    const runs = [...(this.conv?.subagents?.runs?.values?.() ?? [])].filter((run) => run.active);
    if (!this.eventBus) return { requested: 0, unavailable: runs.length };
    for (const run of runs) this.eventBus.emit('subagents:rpc:v1:request', {
      version: 1, requestId: randomUUID(), method: 'stop', params: { runId: run.runId }, source: { extension: 'agentd' },
    });
    return { requested: runs.length, unavailable: 0 };
  }

  dispose() { for (const unsubscribe of this.unsubscribes) { try { unsubscribe?.(); } catch {} } this.unsubscribes = []; }
}

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
async function statusFiles(root) {
  const output = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(candidate, depth + 1);
      else if (entry.isFile() && entry.name === 'status.json') output.push(candidate);
    }
  }
  await walk(root, 0); return output;
}

export async function scanActiveLifecycleRuns({ lifecycleRoot } = {}) {
  const resolvedRoot = path.resolve(lifecycleRoot ?? '');
  if (!path.isAbsolute(lifecycleRoot ?? '') || resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error('dedicated absolute subagent lifecycle root is required');
  }
  const active = [];
  for (const file of await statusFiles(resolvedRoot)) {
    if (!isWithin(resolvedRoot, file)) continue;
    const artifact = validateLifecycleArtifact(await readJson(file), { asyncDir: path.dirname(file) });
    if (!artifact) {
      active.push({ runId: `malformed:${file}`, state: 'unknown', asyncDir: path.dirname(file) });
      continue;
    }
    const logicalTerminal = !ACTIVE_STATES.has(artifact.state) && artifact.state !== 'unknown';
    if (!logicalTerminal || !terminalObserved(artifact)) active.push(artifact);
  }
  return active;
}

/** Conservative retention: malformed, active, leased, and unproven-terminal child sessions survive. */
export async function pruneTerminalSubagentRuns({ lifecycleRoot, sessionRoot, nowMs = Date.now(), retentionMs = SUBAGENT_RETENTION_MS, activeRunIds = new Set(), hasSessionLease = () => false } = {}) {
  const resolvedLifecycleRoot = path.resolve(lifecycleRoot ?? '');
  const resolvedSessionRoot = path.resolve(sessionRoot ?? '');
  for (const [label, raw, resolved] of [
    ['lifecycle', lifecycleRoot, resolvedLifecycleRoot], ['session', sessionRoot, resolvedSessionRoot],
  ]) {
    if (!path.isAbsolute(raw ?? '') || resolved === path.parse(resolved).root) throw new Error(`dedicated absolute subagent ${label} root is required`);
  }
  const canonicalSessionRoot = await fs.realpath(resolvedSessionRoot).catch(() => null);
  if (!canonicalSessionRoot) return { removed: [], retained: ['session-root-unavailable'] };
  const removed = []; const retained = [];
  for (const file of await statusFiles(resolvedLifecycleRoot)) {
    if (!isWithin(resolvedLifecycleRoot, file)) continue;
    const asyncDir = path.dirname(file);
    const artifact = validateLifecycleArtifact(await readJson(file), { asyncDir });
    if (!artifact || artifact.asyncDir !== asyncDir || !artifact.sessionDir || !isWithin(resolvedSessionRoot, artifact.sessionDir)) {
      retained.push(file); continue;
    }
    const canonicalSessionDir = await fs.realpath(artifact.sessionDir).catch(() => null);
    const sessionRelative = canonicalSessionDir ? path.relative(canonicalSessionRoot, canonicalSessionDir) : '';
    if (!canonicalSessionDir || !sessionRelative || sessionRelative.startsWith('..') || path.isAbsolute(sessionRelative)) {
      retained.push(file); continue;
    }
    const timestamp = typeof artifact.updatedAt === 'number' ? artifact.updatedAt : Date.parse(artifact.updatedAt ?? '');
    if (!terminalObserved(artifact) || ACTIVE_STATES.has(artifact.state) || activeRunIds.has(artifact.runId)
      || hasSessionLease(artifact.sessionId) || !Number.isFinite(timestamp) || nowMs - timestamp < retentionMs) {
      retained.push(file); continue;
    }
    try {
      await fs.rm(canonicalSessionDir, { recursive: true, force: false });
      removed.push(canonicalSessionDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { removed, retained };
}
