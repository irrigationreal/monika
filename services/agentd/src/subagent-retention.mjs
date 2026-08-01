import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { resultCustodyFiles, SUBAGENT_RETENTION_MS, scanLifecycleSnapshot, trustedDeliveryAcknowledgement, validateLifecycleArtifact } from './subagent-lifecycle.mjs';

export function summarizeSubagentRetention({ inventory = null, result = null, error = null, running = false, lastRunAt = null } = {}) {
  const items = inventory?.items ?? [];
  const errorItems = items.filter((item) => item.protected_reasons?.some((reason) => /(?:invalid|unreadable|unsafe|symlink)/.test(reason)));
  const compactedItems = items.filter((item) => item.protected_reasons?.includes('already-compacted'));
  const waitingItems = items.filter((item) => item.protected_reasons?.length === 1 && item.protected_reasons[0] === 'retention-age-not-met');
  const protectedCount = items.filter((item) => !item.eligible && !waitingItems.includes(item) && !errorItems.includes(item) && !compactedItems.includes(item)).length;
  return { ok: !error, digest: inventory?.digest ?? null, generatedAt: inventory?.generated_at ?? null,
    retentionMs: inventory?.retention_ms ?? SUBAGENT_RETENTION_MS,
    counts: { protected: protectedCount, waiting: waitingItems.length, eligible: inventory?.eligible_count ?? 0,
      compacted: Math.max(compactedItems.length, result?.compacted_count ?? 0), error: errorItems.length + (error ? 1 : 0) },
    bytes: { tracked_removable: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0), eligible: inventory?.eligible_bytes ?? 0 },
    omitted: inventory?.omitted ?? 0, running: Boolean(running), last_run_at: lastRunAt, last_error: error ?? null };
}

export function conversationHasPendingRetentionMutations(conversation) {
  return Number.isFinite(conversation?.pendingMutations) && conversation.pendingMutations > 0;
}

export function retentionApplyInput(body) {
  if (body?.apply !== true || typeof body.inventory_digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.inventory_digest)
    || typeof body.reason !== 'string' || !body.reason.trim()) {
    throw new Error('apply:true, a SHA-256 inventory_digest, and reason are required');
  }
  return { inventoryDigest: body.inventory_digest, reason: body.reason.trim() };
}

export class SubagentRetentionCoordinator {
  constructor() { this.promise = null; this.inProgress = false; }
  async run(operation) {
    if (this.promise) throw new Error('subagent retention cleanup already in progress');
    this.inProgress = true; this.promise = Promise.resolve().then(operation);
    try { return await this.promise; } finally { this.promise = null; this.inProgress = false; }
  }
  async wait() { try { return await this.promise; } catch { return undefined; } }
}

const BULKY_FILES = new Set(['events.jsonl', 'runner.stdout.log', 'runner.stderr.log']);
const BULKY_PATTERNS = [/^output-[A-Za-z0-9._-]+\.log$/, /^subagent-log-[A-Za-z0-9._-]+\.md$/];
function isWithin(root, candidate) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function timestampMs(value) { if (typeof value === 'number' && Number.isFinite(value)) return value; const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; }
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function readJsonBytes(file) { try { const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('unsafe-json-file'); const bytes = await handle.readFile(); return { bytes, value: JSON.parse(bytes.toString('utf8')) }; } finally { await handle.close(); } } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function syncDirectory(dir) { const handle = await fs.open(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)); try { await handle.sync(); } finally { await handle.close(); } }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function inventoryDigest(items) { return createHash('sha256').update(JSON.stringify(canonical(items))).digest('hex'); }
function bulky(name) { return BULKY_FILES.has(name) || BULKY_PATTERNS.some((pattern) => pattern.test(name)); }
function observedUnavailable(proof, runId) {
  return proof?.version === 1 && proof.state === 'observed' && proof.runId === runId && proof.resumeDisposition === 'unavailable'
    && typeof proof.runnerProcessInstanceId === 'string' && Number.isFinite(proof.observedAt) && Array.isArray(proof.instances)
    && proof.instances.some((instance) => instance?.kind === 'runner' && instance.processInstanceId === proof.runnerProcessInstanceId && Number.isFinite(instance.closeObservedAt));
}

async function safeTree(root) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe-root');
  let bytes = 0; let files = 0;
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name); const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('symlink');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) { bytes += stat.size; files += 1; }
      else throw new Error('special-file');
    }
  }
  await walk(root); return { bytes, files, dev: rootStat.dev, ino: rootStat.ino };
}

async function inspectRun(run, { lifecycleRoot, sessionRoot, resultsRoot, operatorRoot, nowMs, retentionMs, activeRunKeys, hasSessionLease, protectedParentSessionIds, protectedParentSessionPaths, controlProtection, nestedRootIds }) {
  const item = { run_id: run.run_id, run_key: run.run_key, async_dir: run.async_dir, eligible: false, protected_reasons: [], bytes: 0, files: [], session_dir: null, session_present: false, session_bytes: 0, session_files: 0, session_dev: null, session_ino: null, parent_session_id: run.parent_session_id ?? null, parent_session_path: run.parent_session_path ?? null, origin: run.origin ?? null, process_terminal_sha256: null, delivery_ack_sha256: null };
  const protect = (reason) => { if (!item.protected_reasons.includes(reason)) item.protected_reasons.push(reason); };
  if (run.scope !== 'top' || run.run_key !== `top:${run.run_id}`) protect('not-unique-top-level');
  if (run.scope === 'top' && nestedRootIds.has(run.run_id)) protect('nested-descendants-present');
  if (run.blocking || run.execution_state === 'uncertain') protect('execution-not-settled');
  if (activeRunKeys.has(run.run_key) || activeRunKeys.has(run.run_id)) protect('active-run');
  if (protectedParentSessionIds.has(run.parent_session_id) || protectedParentSessionPaths.has(path.resolve(run.parent_session_path ?? '/'))) protect('loaded-parent-session');
  if (controlProtection.all || controlProtection.runKeys.has(run.run_key) || controlProtection.runIds.has(run.run_id)) protect('pending-supervisor-control');
  let dirStat;
  try { dirStat = await fs.lstat(run.async_dir); if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !isWithin(lifecycleRoot, run.async_dir)) protect('unsafe-run-directory'); }
  catch { protect('unreadable-run-directory'); return item; }
  const statusRaw = await readJson(path.join(run.async_dir, 'status.json')).catch(() => null);
  const status = validateLifecycleArtifact(statusRaw, { runId: run.run_id, asyncDir: run.async_dir });
  // Package status artifacts do not carry asyncDir. The trusted scanner supplies
  // the containing directory; if an artifact does carry asyncDir, validation
  // still resolves and compares it to that exact scoped path.
  if (!status || status.asyncDir !== path.resolve(run.async_dir)) protect('invalid-status');
  const proofRecord = await readJsonBytes(path.join(run.async_dir, 'process-terminal.json')).catch(() => null);
  const proof = proofRecord?.value ?? status?.processTerminal;
  if (proofRecord) item.process_terminal_sha256 = sha256(proofRecord.bytes);
  else protect('process-terminal-artifact-missing-or-invalid');
  if (!observedUnavailable(proof, run.run_id)) protect('resumability-or-terminal-proof-protected');
  const ackRecord = await readJsonBytes(path.join(run.async_dir, 'delivery-ack.json')).catch(() => null);
  const ack = ackRecord?.value ?? null;
  if (ackRecord) item.delivery_ack_sha256 = sha256(ackRecord.bytes);
  if (!ack || ack.version !== 1 || ack.kind !== 'completion-delivery' || ack.runId !== run.run_id || ack.runKey !== run.run_key
    || !/^[a-f0-9]{64}$/.test(ack.resultSha256 ?? '') || !Number.isSafeInteger(ack.resultSize) || ack.resultSize < 0
    || typeof ack.proofKind !== 'string' || typeof ack.proofReference !== 'string') protect('delivery-ack-missing-or-invalid');
  else if (!await trustedDeliveryAcknowledgement(operatorRoot, ack, ackRecord.bytes).catch(() => false)) protect('central-delivery-ack-missing-or-invalid');
  const resultPath = run.result_file ?? path.join(resultsRoot, `${run.run_id}.json`);
  try { const resultStat = await fs.lstat(resultPath); protect(resultStat.isSymbolicLink() || !resultStat.isFile() ? 'unsafe-result-path' : 'result-still-pending'); }
  catch (error) { if (error?.code !== 'ENOENT') protect('unreadable-result-path'); }
  try { if ((await resultCustodyFiles(resultPath)).length > 0) protect('result-custody-pending'); }
  catch { protect('unsafe-result-custody'); }
  const ageFrom = Math.max(...[status?.updatedAt, proof?.observedAt, ack?.acknowledgedAt].map(timestampMs).filter((value) => value !== null));
  if (!Number.isFinite(ageFrom) || nowMs - ageFrom < retentionMs) protect('retention-age-not-met');
  if (status && hasSessionLease(status.sessionId)) protect('session-leased');
  try {
    const entries = await fs.readdir(run.async_dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(run.async_dir, entry.name); const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) { protect('symlink-in-run-directory'); continue; }
      if (entry.isFile() && bulky(entry.name)) { item.files.push({ path: file, name: entry.name, size: stat.size, dev: stat.dev, ino: stat.ino }); item.bytes += stat.size; }
    }
  } catch { protect('unreadable-run-directory'); }
  if (status?.sessionDir) {
    const resolvedSession = path.resolve(status.sessionDir); item.session_dir = resolvedSession;
    if (!isWithin(sessionRoot, resolvedSession)) protect('unsafe-session-directory');
    else {
      try {
        const stat = await fs.lstat(resolvedSession);
        if (!stat.isDirectory() || stat.isSymbolicLink()) protect('unsafe-session-directory');
        else { const tree = await safeTree(resolvedSession); item.session_present = true; item.session_bytes = tree.bytes; item.session_files = tree.files; item.session_dev = tree.dev; item.session_ino = tree.ino; }
      } catch (error) { if (error?.code !== 'ENOENT') protect(error?.message === 'symlink' ? 'symlink-in-session-directory' : 'unreadable-session-directory'); }
    }
  }
  const tombstone = await readJson(path.join(run.async_dir, 'retention-tombstone.json')).catch(() => null);
  if (tombstone?.phase === 'completed' && item.files.length === 0) protect('already-compacted');
  item.files.sort((a, b) => a.path.localeCompare(b.path)); item.protected_reasons.sort(); item.eligible = item.protected_reasons.length === 0;
  return item;
}

async function validateRoot(root) {
  if (!path.isAbsolute(root ?? '') || path.resolve(root) === path.parse(path.resolve(root ?? '')).root) throw new Error('dedicated absolute retention roots are required');
  const resolved = path.resolve(root); const stat = await fs.lstat(resolved); const real = await fs.realpath(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw new Error(`unsafe retention root: ${resolved}`);
  return resolved;
}
async function pendingControlProtection(lifecycleRoot) {
  const protection = { all: false, runIds: new Set(), runKeys: new Set() };
  async function scanSupervisorChannels(root) {
    for (const channel of await fs.readdir(root, { withFileTypes: true })) {
      if (channel.isSymbolicLink() || !channel.isDirectory()) { protection.all = true; continue; }
      const channelDir = path.join(root, channel.name); const requestsDir = path.join(channelDir, 'requests'); const repliesDir = path.join(channelDir, 'replies');
      let requests;
      try {
        const [requestsStat, repliesStat] = await Promise.all([fs.lstat(requestsDir), fs.lstat(repliesDir)]);
        if (!requestsStat.isDirectory() || requestsStat.isSymbolicLink() || !repliesStat.isDirectory() || repliesStat.isSymbolicLink()) { protection.all = true; continue; }
        requests = await fs.readdir(requestsDir, { withFileTypes: true });
      } catch { protection.all = true; continue; }
      for (const entry of requests) {
        if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) { protection.all = true; continue; }
        try {
          const value = (await readJsonBytes(path.join(requestsDir, entry.name)))?.value;
          const expectedName = typeof value?.id === 'string' && value.id && !value.id.includes('/') && !value.id.includes('\\') ? `${value.id}.json` : null;
          if (value?.type !== 'subagent.supervisor.request' || !expectedName || entry.name !== expectedName
            || typeof value.runId !== 'string' || !value.runId || typeof value.expectsReply !== 'boolean') { protection.all = true; continue; }
          if (!value.expectsReply) continue;
          const reply = path.join(channelDir, 'replies', expectedName);
          try { const stat = await fs.lstat(reply); if (!stat.isFile() || stat.isSymbolicLink()) protection.all = true; }
          catch (error) { if (error?.code === 'ENOENT') protection.runIds.add(value.runId); else protection.all = true; }
        } catch { protection.all = true; }
      }
    }
  }
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { protection.all = true; continue; }
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !/\.(?:json|jsonl)$/.test(entry.name)) continue;
      try {
        const text = await fs.readFile(file, 'utf8');
        const records = entry.name.endsWith('.jsonl') ? text.split('\n').filter(Boolean).map(JSON.parse) : [JSON.parse(text)];
        for (const value of records) {
          const state = value?.state ?? value?.status ?? value?.deliveryState ?? value?.delivery_state;
          if (!['pending', 'registered', 'launching', 'queued', 'running', 'stopping'].includes(state)) continue;
          const id = value?.runId ?? value?.run_id ?? value?.asyncId; const key = value?.runKey ?? value?.run_key;
          if (typeof id === 'string') protection.runIds.add(id); else if (typeof key !== 'string') protection.all = true;
          if (typeof key === 'string') protection.runKeys.add(key);
        }
      } catch { protection.all = true; }
    }
  }
  const supervisorRoot = path.join(lifecycleRoot, 'supervisor-channels');
  try { await scanSupervisorChannels(supervisorRoot); } catch (error) { if (error?.code !== 'ENOENT') protection.all = true; }
  for (const name of ['chain-runs', 'nested-subagent-routing', 'nested-subagent-events']) { const root = path.join(lifecycleRoot, name); try { await walk(root); } catch (error) { if (error?.code !== 'ENOENT') protection.all = true; } }
  return protection;
}
export async function inventorySubagentRetention({ lifecycleRoot, sessionRoot, resultsRoot, operatorRoot, nowMs = Date.now(), retentionMs = SUBAGENT_RETENTION_MS, activeRunKeys = new Set(), hasSessionLease = () => false, protectedParentSessionIds = new Set(), protectedParentSessionPaths = new Set() } = {}) {
  const [lifecycle, sessions, results, operator] = await Promise.all([validateRoot(lifecycleRoot), validateRoot(sessionRoot), validateRoot(resultsRoot), validateRoot(operatorRoot)]);
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: lifecycle, resultsRoot: results, operatorRoot: operator, runtimeInstanceFile: path.join(lifecycle, '.retention-no-runtime') });
  const controlProtection = await pendingControlProtection(lifecycle);
  const protectedPaths = new Set([...protectedParentSessionPaths].filter((value) => typeof value === 'string' && path.isAbsolute(value)).map((value) => path.resolve(value)));
  const nestedRootIds = new Set(snapshot.runs.filter((run) => run.scope === 'nested' && typeof run.root_run_id === 'string').map((run) => run.root_run_id));
  const items = [];
  for (const run of snapshot.runs) items.push(await inspectRun(run, { lifecycleRoot: lifecycle, sessionRoot: sessions, resultsRoot: results, operatorRoot: operator, nowMs, retentionMs, activeRunKeys, hasSessionLease, protectedParentSessionIds, protectedParentSessionPaths: protectedPaths, controlProtection, nestedRootIds }));
  items.sort((a, b) => (a.run_key ?? '').localeCompare(b.run_key ?? ''));
  const digestInput = items.map(({ run_id, run_key, async_dir, eligible, protected_reasons, bytes, files, session_dir, session_present, session_bytes, session_files, session_dev, session_ino, parent_session_id, parent_session_path, origin, process_terminal_sha256, delivery_ack_sha256 }) => ({ run_id, run_key, async_dir, eligible, protected_reasons, bytes, files, session_dir, session_present, session_bytes, session_files, session_dev, session_ino, parent_session_id, parent_session_path, origin, process_terminal_sha256, delivery_ack_sha256 }));
  return { version: 1, generated_at: nowMs, retention_ms: retentionMs, digest: inventoryDigest(digestInput), eligible_count: items.filter((item) => item.eligible).length, eligible_bytes: items.filter((item) => item.eligible).reduce((sum, item) => sum + item.bytes, 0), items };
}

async function durableJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`; const handle = await fs.open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(tmp, file); await syncDirectory(path.dirname(file)); } catch (error) { await fs.rm(tmp, { force: true }).catch(() => {}); throw error; }
}
async function appendAudit(file, value) { const handle = await fs.open(file, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); } await syncDirectory(path.dirname(file)); }

export async function compactSubagentRetention(options = {}) {
  const { expectedDigest, requestedReason = 'automatic-daily-retention', beforeStep = async () => {} } = options;
  if (typeof expectedDigest !== 'string') throw new Error('exact retention inventory digest is required');
  const inventory = await inventorySubagentRetention(options);
  if (inventory.digest !== expectedDigest) throw new Error('retention inventory digest mismatch');
  const auditFile = path.join(path.resolve(options.lifecycleRoot), 'retention-audit.jsonl'); const compacted = [];
  for (const item of inventory.items.filter((candidate) => candidate.eligible)) {
    const tombstoneFile = path.join(item.async_dir, 'retention-tombstone.json');
    let tombstone = await readJson(tombstoneFile);
    if (!tombstone) {
      tombstone = { version: 1, kind: 'subagent-retention', phase: 'prepared', operationId: randomUUID(), runId: item.run_id, runKey: item.run_key, inventoryDigest: inventory.digest, requestedAt: Date.now(), requestedReason, processTerminalSha256: item.process_terminal_sha256, deliveryAckSha256: item.delivery_ack_sha256, parentSessionId: item.parent_session_id, parentSessionPath: item.parent_session_path, origin: item.origin };
      await beforeStep('before-tombstone', item); await durableJson(tombstoneFile, tombstone); await beforeStep('after-tombstone', item);
    } else if (tombstone.version !== 1 || tombstone.runId !== item.run_id || tombstone.runKey !== item.run_key || !['prepared', 'authorized'].includes(tombstone.phase)) throw new Error('conflicting retention tombstone');
    if (tombstone.phase === 'prepared') {
      await appendAudit(auditFile, { ...tombstone, phase: 'authorized', bytes: item.bytes, files: item.files.map((file) => file.name), sessionDir: item.session_dir });
      tombstone = { ...tombstone, phase: 'authorized', authorizedAt: Date.now() };
      await durableJson(tombstoneFile, tombstone); await beforeStep('after-audit', item);
    }
    let removedBytes = 0; let removedFiles = 0;
    for (const candidate of item.files) {
      const stat = await fs.lstat(candidate.path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== candidate.dev || stat.ino !== candidate.ino || stat.size !== candidate.size) throw new Error('retention candidate changed after inventory');
      await fs.unlink(candidate.path); removedBytes += candidate.size; removedFiles += 1;
    }
    const completed = { ...tombstone, phase: 'completed', completedAt: Date.now(), removedBytes, removedFiles };
    await durableJson(tombstoneFile, completed); await appendAudit(auditFile, completed);
    compacted.push({ run_id: item.run_id, run_key: item.run_key, removed_bytes: removedBytes, removed_files: removedFiles });
  }
  return { inventory_digest: inventory.digest, compacted_count: compacted.length, compacted };
}
