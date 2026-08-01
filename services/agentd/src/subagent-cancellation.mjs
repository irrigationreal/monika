import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION_KEYS = new Set(['version', 'kind', 'operation_id', 'parent_session_id', 'parent_session_path', 'generation', 'reason', 'requested_at', 'state', 'completed_at', 'targets', 'unresolved', 'effects_unknown', 'errors', 'parent_abort_error']);
const STATES = new Set(['stopping', 'stopped', 'uncertain']);

function string(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function matchesSession(run, sessionId, sessionPath) {
  const refs = [run.parent_session_id, run.parent_session_path].map(string).filter(Boolean);
  return refs.some((ref) => ref === sessionId || ref === sessionPath
    || (sessionPath && path.isAbsolute(ref) && path.resolve(ref) === path.resolve(sessionPath)));
}
function selectRuns(snapshot, sessionId, sessionPath) {
  const direct = snapshot.runs.filter((run) => run.scope === 'top' && matchesSession(run, sessionId, sessionPath));
  const rootIds = new Set(direct.map((run) => run.run_id));
  const nested = snapshot.runs.filter((run) => run.scope === 'nested' && rootIds.has(run.root_run_id));
  const canonicalDirs = new Set([...direct, ...nested].map((run) => path.resolve(run.async_dir ?? '/invalid')));
  // A scanner read failure can still carry canonical parent identity recovered
  // from the mapped directory's launch/status record. Keep it in the barrier.
  const malformed = snapshot.runs.filter((run) => !run.scope && canonicalDirs.has(path.resolve(run.async_dir ?? '/missing')));
  const unsupported = snapshot.runs.filter((run) => !['top', 'nested'].includes(run.scope) && !malformed.includes(run) && matchesSession(run, sessionId, sessionPath));
  return { owned: [...direct, ...nested, ...malformed], unsupported };
}
async function syncDirectory(dir) {
  const handle = await fs.open(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function directoryIdentity(dir) {
  const stat = await fs.lstat(dir); const real = await fs.realpath(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== path.resolve(dir)) throw new Error('unsafe cancellation directory');
  return { real, dev: stat.dev, ino: stat.ino };
}
async function safeDirectory(root, candidate) {
  const resolvedRoot = path.resolve(root); const resolved = path.resolve(candidate);
  if (!isWithin(resolvedRoot, resolved)) throw new Error('lifecycle directory escapes the dedicated root');
  const [rootIdentity, identity] = await Promise.all([directoryIdentity(resolvedRoot), directoryIdentity(resolved)]);
  if (!isWithin(rootIdentity.real, identity.real)) throw new Error('unsafe lifecycle directory');
  return identity;
}
async function atomicJson(file, value, mode = 0o600) {
  const dir = path.dirname(file); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const before = await directoryIdentity(dir);
  const temp = path.join(before.real, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  try {
    const after = await directoryIdentity(dir);
    if (after.dev !== before.dev || after.ino !== before.ino || after.real !== before.real) throw new Error('cancellation directory identity changed during write');
    await fs.rename(temp, path.join(after.real, path.basename(file)));
    const published = await directoryIdentity(dir);
    if (published.dev !== before.dev || published.ino !== before.ino) throw new Error('cancellation directory identity changed during publish');
    await syncDirectory(after.real);
  } catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
}
async function exactJson(file) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('operation record is not a regular file'); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
function validTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => ['run_key', 'run_id', 'async_dir'].includes(key)) && typeof value.run_key === 'string'
    && typeof value.run_id === 'string' && typeof value.async_dir === 'string' && path.isAbsolute(value.async_dir);
}
function parseOperation(value, expectedId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !OPERATION_KEYS.has(key))) throw new Error('invalid cancellation operation schema');
  if (value.version !== 1 || value.kind !== 'subagent-cancellation' || !OPERATION_ID.test(value.operation_id ?? '')
    || (expectedId && value.operation_id !== expectedId) || !string(value.parent_session_id)
    || !(value.parent_session_path === null || string(value.parent_session_path)) || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !string(value.reason) || !Number.isFinite(value.requested_at) || !STATES.has(value.state)
    || !(value.completed_at === null || Number.isFinite(value.completed_at))
    || !(value.parent_abort_error === undefined || value.parent_abort_error === null || string(value.parent_abort_error))
    || !Array.isArray(value.targets) || !value.targets.every(validTarget)
    || !Array.isArray(value.unresolved) || !Array.isArray(value.effects_unknown) || !Array.isArray(value.errors) || !value.errors.every((item) => typeof item === 'string')) {
    throw new Error('invalid cancellation operation schema');
  }
  return value;
}
async function readOperation(file, expectedId = null) {
  try { return parseOperation(await exactJson(file), expectedId); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function publicRun(run) {
  return { run_key: run.run_key ?? null, run_id: run.run_id, execution_state: run.execution_state,
    effects_state: run.effects_state ?? null, delivery_state: run.delivery_state ?? null,
    blocking: Boolean(run.blocking), reason: run.reason ?? null };
}
function sameInput(left, right) {
  return left.operationId === right.operationId && left.sessionId === right.sessionId
    && (left.sessionPath ?? null) === (right.sessionPath ?? null) && left.generation === right.generation
    && (left.reason ?? 'forum-stop') === (right.reason ?? 'forum-stop');
}

export function createSubagentCancellationCoordinator({ lifecycleRoot, operatorRoot, scan, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), settleTimeoutMs = 5000, pollMs = 100 } = {}) {
  if (!path.isAbsolute(lifecycleRoot ?? '') || !path.isAbsolute(operatorRoot ?? '')) throw new Error('dedicated absolute lifecycle and operator roots are required');
  const operationsRoot = path.join(path.resolve(operatorRoot), 'cancellations');
  const operationFile = (id) => path.join(operationsRoot, `${id}.json`);
  const inflight = new Map();

  async function assertMarkerAndControl(run, input) {
    if (!run.run_key || !run.async_dir) throw new Error('run lacks scoped durable identity');
    const identity = await safeDirectory(lifecycleRoot, run.async_dir);
    const marker = { version: 1, kind: 'host-cancellation', operationId: input.operationId, generation: input.generation,
      runId: run.run_id, runKey: run.run_key, runSessionId: run.parent_session_id ?? null,
      parentSessionId: input.sessionId, parentSessionPath: input.sessionPath, requestedAt: now(), reason: input.reason };
    await atomicJson(path.join(identity.real, 'host-cancellation.json'), marker);
    if (run.blocking || run.execution_state === 'active') {
      await atomicJson(path.join(identity.real, 'control', 'stop.json'), { type: 'stop', source: 'agentd-cancellation', operationId: input.operationId,
        cancellationGeneration: input.generation, runId: run.run_id, runKey: run.run_key,
        runSessionId: run.parent_session_id ?? null, parentSessionId: input.sessionId,
        parentSessionPath: input.sessionPath, reason: input.reason, ts: now() });
    }
    return { run_key: run.run_key, run_id: run.run_id, async_dir: identity.real };
  }

  async function execute(rawInput) {
    const input = { ...rawInput, sessionPath: rawInput.sessionPath ?? null, reason: rawInput.reason ?? 'forum-stop' };
    const existing = await readOperation(operationFile(input.operationId), input.operationId);
    if (existing && (existing.parent_session_id !== input.sessionId || existing.parent_session_path !== input.sessionPath
      || existing.generation !== input.generation || existing.reason !== input.reason)) throw new Error('cancellation operation identity conflict');
    const requestedAt = existing?.requested_at ?? now(); const attemptStartedAt = now();
    const base = { version: 1, kind: 'subagent-cancellation', operation_id: input.operationId,
      parent_session_id: input.sessionId, parent_session_path: input.sessionPath, generation: input.generation, reason: input.reason,
      requested_at: requestedAt, state: 'stopping', completed_at: null, targets: existing?.targets ?? [], unresolved: [], effects_unknown: [], errors: [],
      parent_abort_error: existing?.parent_abort_error ?? null };
    await atomicJson(operationFile(input.operationId), base);
    const seen = new Map(base.targets.map((target) => [target.run_key, target])); const errors = [];
    let finalSnapshot = null; let firstScan = true;
    while (firstScan || now() - attemptStartedAt <= settleTimeoutMs) {
      firstScan = false; let snapshot;
      try { snapshot = await scan(); finalSnapshot = snapshot; }
      catch (error) { errors.push(`lifecycle-scan:${error instanceof Error ? error.message : String(error)}`); break; }
      const { owned, unsupported } = selectRuns(snapshot, input.sessionId, input.sessionPath);
      for (const run of unsupported.filter((item) => item.blocking || item.execution_state === 'uncertain')) errors.push(`unsupported-scope:${run.scope ?? 'missing'}:${run.run_key ?? run.run_id ?? 'unknown'}`);
      // Result custody is part of cancellation: terminal pending results must be
      // marked before the barrier can report stopped. Active controls are
      // deliberately reasserted on every reconciliation if a runner consumed it.
      for (const run of owned.filter((item) => item.blocking || item.execution_state === 'uncertain' || item.delivery_state === 'pending')) {
        const key = run.run_key ?? `uncertain:${run.async_dir}`;
        try {
          const target = await assertMarkerAndControl(run, input);
          const prior = seen.get(key);
          if (prior && (prior.run_id !== target.run_id || prior.async_dir !== target.async_dir)) throw new Error('durable run identity changed during cancellation');
          seen.set(key, target);
        } catch (error) { errors.push(`${key}:${error instanceof Error ? error.message : String(error)}`); }
      }
      const unresolved = owned.filter((run) => run.blocking || run.execution_state === 'uncertain');
      if (unresolved.length === 0 && unsupported.length === 0) {
        await sleep(pollMs); const confirm = await scan(); finalSnapshot = confirm;
        const confirmed = selectRuns(confirm, input.sessionId, input.sessionPath);
        const pendingUnmarked = confirmed.owned.filter((run) => run.delivery_state === 'pending' && !seen.has(run.run_key));
        if (confirmed.unsupported.length === 0 && pendingUnmarked.length === 0
          && confirmed.owned.every((run) => !run.blocking && run.execution_state !== 'uncertain')) break;
      }
      await sleep(pollMs);
    }
    const selected = finalSnapshot ? selectRuns(finalSnapshot, input.sessionId, input.sessionPath) : { owned: [], unsupported: [] };
    const unresolved = [...selected.owned.filter((run) => run.blocking || run.execution_state === 'uncertain'), ...selected.unsupported];
    const effectsUnknown = selected.owned.filter((run) => run.effects_state === 'unknown');
    const uniqueErrors = [...new Set([...(base.parent_abort_error ? [`parent-abort:${base.parent_abort_error}`] : []), ...errors])];
    const state = uniqueErrors.length || unresolved.some((run) => run.execution_state === 'uncertain' || !['top', 'nested'].includes(run.scope)) ? 'uncertain'
      : unresolved.length ? 'stopping' : 'stopped';
    const result = { ...base, state, completed_at: state === 'stopped' ? now() : null, targets: [...seen.values()],
      unresolved: unresolved.map(publicRun), effects_unknown: effectsUnknown.map(publicRun), errors: uniqueErrors };
    await atomicJson(operationFile(input.operationId), result); return result;
  }

  async function request(rawInput) {
    const input = { ...rawInput, sessionPath: rawInput?.sessionPath ?? null, reason: rawInput?.reason ?? 'forum-stop' };
    if (!OPERATION_ID.test(input?.operationId ?? '') || !string(input?.sessionId) || !Number.isSafeInteger(input?.generation) || input.generation < 0 || !string(input.reason)) throw new Error('valid operationId, sessionId, generation, and reason are required');
    const running = inflight.get(input.operationId);
    if (running) { if (!sameInput(running.input, input)) throw new Error('cancellation operation identity conflict'); return running.promise; }
    const promise = execute(input).finally(() => { if (inflight.get(input.operationId)?.promise === promise) inflight.delete(input.operationId); });
    inflight.set(input.operationId, { input, promise }); return promise;
  }

  async function latestForSession(sessionId, sessionPath = null) {
    let entries;
    try { entries = await fs.readdir(operationsRoot, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    let latest = null;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5); if (!OPERATION_ID.test(id)) continue;
      const operation = await readOperation(operationFile(id), id);
      if (operation && operation.parent_session_id === sessionId
        && (!sessionPath || operation.parent_session_path === sessionPath)
        && (!latest || operation.generation > latest.generation
          || (operation.generation === latest.generation && operation.requested_at > latest.requested_at))) latest = operation;
    }
    return latest;
  }
  async function reconcileSession(sessionId, sessionPath = null) {
    const latest = await latestForSession(sessionId, sessionPath);
    if (!latest) return null;
    return request({ operationId: latest.operation_id, sessionId: latest.parent_session_id, sessionPath: latest.parent_session_path,
      generation: latest.generation, reason: latest.reason });
  }
  async function markParentAbortUncertain(operationId, message) {
    const current = OPERATION_ID.test(operationId ?? '') ? await readOperation(operationFile(operationId), operationId) : null;
    if (!current) throw new Error('cancellation operation not found');
    const parentAbortError = string(message) ?? 'parent termination is unproven';
    const next = { ...current, state: 'uncertain', completed_at: null, parent_abort_error: parentAbortError,
      errors: [...new Set([...(current.errors ?? []), `parent-abort:${parentAbortError}`])] };
    await atomicJson(operationFile(operationId), next); return next;
  }
  async function proveParentTerminated(operationId) {
    const current = OPERATION_ID.test(operationId ?? '') ? await readOperation(operationFile(operationId), operationId) : null;
    if (!current) throw new Error('cancellation operation not found');
    if (!current.parent_abort_error) return current;
    const next = { ...current, state: 'stopping', completed_at: null, parent_abort_error: null,
      errors: (current.errors ?? []).filter((item) => !item.startsWith('parent-abort:')) };
    await atomicJson(operationFile(operationId), next); return next;
  }
  return { request, reconcileSession, latestForSession, markParentAbortUncertain, proveParentTerminated,
    read: async (operationId) => OPERATION_ID.test(operationId ?? '') ? readOperation(operationFile(operationId), operationId) : null };
}
