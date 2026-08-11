import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

export const SUBAGENT_RUN_CUSTOM_TYPE = 'monika.subagent.run';
export const SUBAGENT_RUN_VERSION = 2;
export const SUBAGENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set(['pending', 'registered', 'launching', 'queued', 'running', 'stopping']);
const MAX_PUBLIC_RUNS = 64;
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function string(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function runId(value) { const data = record(value); return string(data?.runId ?? data?.id ?? data?.asyncId); }
function validObservedProcessTerminal(value, expectedRunId = null, expectedRunnerProcessInstanceId = null) {
  const proof = record(value);
  if (!proof || proof.version !== 1 || proof.state !== 'observed'
    || !string(proof.runId) || (expectedRunId && proof.runId !== expectedRunId)
    || !string(proof.runnerProcessInstanceId)
    || (expectedRunnerProcessInstanceId && proof.runnerProcessInstanceId !== expectedRunnerProcessInstanceId)
    || typeof proof.observedAt !== 'number' || !Number.isFinite(proof.observedAt)
    || !Array.isArray(proof.instances)) return false;
  return proof.instances.some((instance) => record(instance)?.kind === 'runner'
    && instance.processInstanceId === proof.runnerProcessInstanceId
    && typeof instance.closeObservedAt === 'number' && Number.isFinite(instance.closeObservedAt));
}
function safeState(value) { return string(value) ?? 'unknown'; }
const EXECUTION_STATES = new Set(['active', 'terminal', 'interrupted', 'uncertain', 'quarantined']);
const OUTCOME_STATES = new Set(['pending', 'succeeded', 'failed', 'interrupted', 'unknown']);
const EFFECTS_STATES = new Set(['none', 'confirmed', 'unknown']);
const DELIVERY_STATES = new Set(['pending', 'settled', 'operator-resolved']);
const DELIVERY_DISPOSITIONS = new Set(['awaited', 'follow_up', 'silent']);
function publicExecutionTarget(value) {
  const data = record(value); const keys = data ? Object.keys(data).sort() : [];
  if (data?.kind === 'local' && keys.length === 1) return { kind: 'local' };
  if (data?.kind === 'ssh' && keys.join(',') === 'kind,name' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data.name ?? '')) return { kind: 'ssh', name: data.name };
  return null;
}
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
async function readJson(file) {
  try { return JSON.parse((await exactFileBytes(file)).bytes.toString('utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function readOptionalJsonArtifact(file) {
  try { return { present: true, value: JSON.parse((await exactFileBytes(file)).bytes.toString('utf8')), error: null }; }
  catch (error) {
    if (error?.code === 'ENOENT') return { present: false, value: null, error: null };
    return { present: true, value: null, error };
  }
}
async function syncDirectory(dir) {
  const handle = await fs.open(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
function validSimpleId(value) { return Boolean(string(value)?.match(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)); }
export function lifecycleRunIdentity(lifecycleRoot, asyncDir, id) {
  const root = path.resolve(lifecycleRoot ?? ''); const dir = path.resolve(asyncDir ?? ''); const run = string(id);
  if (!path.isAbsolute(lifecycleRoot ?? '') || !run || !validSimpleId(run) || !isWithin(root, dir)) return null;
  const parts = path.relative(root, dir).split(path.sep).filter(Boolean);
  if ((parts.length === 1 || (parts.length === 2 && parts[0] === 'async-subagent-runs')) && parts.at(-1) === run) {
    return { scope: 'top', runId: run, runKey: `top:${run}`, rootRunId: null, asyncDir: dir };
  }
  if (parts.length === 3 && parts[0] === 'nested-subagent-runs' && validSimpleId(parts[1]) && parts[2] === run) {
    return { scope: 'nested', runId: run, runKey: `nested:${parts[1]}:${run}`, rootRunId: parts[1], asyncDir: dir };
  }
  return null;
}
export function resultPathForIdentity(resultsRoot, identity) {
  const root = path.resolve(resultsRoot ?? '');
  if (!path.isAbsolute(resultsRoot ?? '') || !identity) return null;
  return identity.scope === 'nested'
    ? path.join(root, 'nested', identity.rootRunId, `${identity.runId}.json`)
    : path.join(root, `${identity.runId}.json`);
}
async function exactFileBytes(file) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('result is not a regular file'); return { bytes: await handle.readFile(), stat }; }
  finally { await handle.close(); }
}
async function readDeliveryAckRecord(file) {
  try { const record = await exactFileBytes(file); return { ...record, value: JSON.parse(record.bytes.toString('utf8')) }; }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function readDeliveryAck(file) { return (await readDeliveryAckRecord(file))?.value ?? null; }
function compatibleDeliveryAck(value, expected, resultData = null) {
  return value?.version === 1 && value.kind === 'completion-delivery' && value.runId === expected.runId && value.runKey === expected.runKey
    && value.proofKind === expected.proofKind && value.proofReference === expected.proofReference
    && /^[a-f0-9]{64}$/.test(value.resultSha256 ?? '') && Number.isSafeInteger(value.resultSize) && value.resultSize >= 0
    && (!resultData || (value.resultSha256 === createHash('sha256').update(resultData.bytes).digest('hex') && value.resultSize === resultData.bytes.length));
}
const DELIVERY_LEDGER_FILE = 'delivery-acknowledgements.jsonl';
function validLedgerRecord(value) {
  return value?.version === 1 && value.kind === 'completion-delivery-ledger' && validSimpleId(value.runId)
    && typeof value.runKey === 'string' && /^(?:top|nested):/.test(value.runKey)
    && /^[a-f0-9]{64}$/.test(value.ackSha256 ?? '') && /^[a-f0-9]{64}$/.test(value.resultSha256 ?? '')
    && Number.isSafeInteger(value.resultSize) && value.resultSize >= 0 && string(value.proofKind)
    && string(value.proofReference) && Number.isFinite(value.acknowledgedAt);
}
async function validateOperatorRoot(operatorRoot, { create = false } = {}) {
  const root = path.resolve(operatorRoot ?? '');
  if (!path.isAbsolute(operatorRoot ?? '') || root === path.parse(root).root) throw new Error('dedicated absolute operator root is required');
  if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root); const real = await fs.realpath(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== root) throw new Error('unsafe operator root');
  return root;
}
export async function readDeliveryAcknowledgementLedger(operatorRoot) {
  const root = await validateOperatorRoot(operatorRoot); const file = path.join(root, DELIVERY_LEDGER_FILE);
  let text;
  try { text = await exactFileBytes(file).then((entry) => entry.bytes.toString('utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const lines = text.split('\n'); if (lines.at(-1) !== '') throw new Error('malformed delivery acknowledgement ledger');
  const records = lines.slice(0, -1).map((line) => { try { const value = JSON.parse(line); if (!validLedgerRecord(value)) throw new Error(); return value; } catch { throw new Error('malformed delivery acknowledgement ledger'); } });
  const byRun = new Map();
  for (const value of records) { const key = `${value.runKey}\0${value.runId}`; const prior = byRun.get(key); if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('conflicting delivery acknowledgement ledger'); byRun.set(key, value); }
  return records;
}
function ledgerRecordFor(ack, ackBytes) {
  return { version: 1, kind: 'completion-delivery-ledger', runId: ack.runId, runKey: ack.runKey,
    ackSha256: createHash('sha256').update(ackBytes).digest('hex'), resultSha256: ack.resultSha256,
    resultSize: ack.resultSize, proofKind: ack.proofKind, proofReference: ack.proofReference, acknowledgedAt: ack.acknowledgedAt };
}
export async function trustedDeliveryAcknowledgement(operatorRoot, ack, ackBytes) {
  if (!ack || !ackBytes) return false;
  const expected = ledgerRecordFor(ack, ackBytes); const records = await readDeliveryAcknowledgementLedger(operatorRoot);
  return records.some((record) => JSON.stringify(record) === JSON.stringify(expected));
}
const deliveryLedgerQueues = new Map();
function sameDeliveryProof(left, right) {
  return left.runId === right.runId && left.runKey === right.runKey && left.resultSha256 === right.resultSha256
    && left.resultSize === right.resultSize && left.proofKind === right.proofKind && left.proofReference === right.proofReference;
}
async function appendDeliveryLedgerUnlocked(operatorRoot, ack, ackBytes) {
  const root = await validateOperatorRoot(operatorRoot, { create: true });
  const expected = ledgerRecordFor(ack, ackBytes); const records = await readDeliveryAcknowledgementLedger(root);
  const matchingRun = records.filter((record) => record.runId === ack.runId && record.runKey === ack.runKey);
  if (matchingRun.length) {
    if (matchingRun.length !== 1 || !sameDeliveryProof(matchingRun[0], expected)) throw new Error('conflicting delivery acknowledgement ledger');
    return matchingRun[0];
  }
  const file = path.join(root, DELIVERY_LEDGER_FILE); const handle = await fs.open(file, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(expected)}\n`); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(root); return expected;
}
async function appendDeliveryLedger(operatorRoot, ack, ackBytes) {
  const key = path.resolve(operatorRoot ?? ''); const prior = deliveryLedgerQueues.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(() => appendDeliveryLedgerUnlocked(operatorRoot, ack, ackBytes));
  deliveryLedgerQueues.set(key, current);
  try { return await current; } finally { if (deliveryLedgerQueues.get(key) === current) deliveryLedgerQueues.delete(key); }
}
export async function writeSubagentDeliveryAck({ lifecycleRoot, asyncDir, resultsRoot, operatorRoot, runId: requestedRunId, runKey = null, proofKind, proofReference, resultFile = null, beforePublish = async () => {} } = {}) {
  const identity = lifecycleRunIdentity(lifecycleRoot, asyncDir, requestedRunId);
  if (!identity || (runKey && runKey !== identity.runKey)) throw new Error('exact lifecycle run identity is required');
  const result = resultFile ?? resultPathForIdentity(resultsRoot, identity);
  if (!result || !isWithin(path.resolve(resultsRoot), result)) throw new Error('safe result path is required');
  const requestedProofKind = string(proofKind); const requestedProofReference = string(proofReference);
  if (!requestedProofKind || !requestedProofReference) throw new Error('delivery proof kind and reference are required');
  const file = path.join(identity.asyncDir, 'delivery-ack.json'); const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const existingRecord = await readDeliveryAckRecord(file); const existing = existingRecord?.value ?? null;
  let resultData = null;
  try { resultData = await exactFileBytes(result); } catch (error) {
    if (error?.code !== 'ENOENT' || !existing) throw error;
  }
  if (existing) {
    if (!compatibleDeliveryAck(existing, { ...identity, proofKind: requestedProofKind, proofReference: requestedProofReference }, resultData)) throw new Error('conflicting delivery acknowledgement');
    const ledger = await appendDeliveryLedger(operatorRoot, existing, existingRecord.bytes);
    if (JSON.stringify(ledger) !== JSON.stringify(ledgerRecordFor(existing, existingRecord.bytes))) throw new Error('delivery acknowledgement does not match durable ledger');
    return { ack: existing, resultFile: result, identity, resultIdentity: resultData ? { dev: resultData.stat.dev, ino: resultData.stat.ino, size: resultData.stat.size } : null };
  }
  const { bytes } = resultData;
  let ack = { version: 1, kind: 'completion-delivery', runId: identity.runId, runKey: identity.runKey,
    resultSha256: createHash('sha256').update(bytes).digest('hex'), resultSize: bytes.length,
    proofKind: requestedProofKind, proofReference: requestedProofReference, acknowledgedAt: Date.now() };
  let ackBytes = Buffer.from(`${JSON.stringify(ack, null, 2)}\n`);
  const ledger = await appendDeliveryLedger(operatorRoot, ack, ackBytes);
  if (ledger.ackSha256 !== createHash('sha256').update(ackBytes).digest('hex')) {
    ack = { ...ack, acknowledgedAt: ledger.acknowledgedAt };
    ackBytes = Buffer.from(`${JSON.stringify(ack, null, 2)}\n`);
    if (JSON.stringify(ledger) !== JSON.stringify(ledgerRecordFor(ack, ackBytes))) throw new Error('delivery ledger cannot reconstruct acknowledgement');
  }
  const handle = await fs.open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(ackBytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await beforePublish(ack);
    try {
      await fs.link(tmp, file);
      await fs.unlink(tmp);
      await syncDirectory(identity.asyncDir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const racedRecord = await readDeliveryAckRecord(file); const raced = racedRecord?.value;
      if (!compatibleDeliveryAck(raced, ack, resultData)) throw new Error('conflicting delivery acknowledgement');
      const racedLedger = await appendDeliveryLedger(operatorRoot, raced, racedRecord.bytes);
      if (JSON.stringify(racedLedger) !== JSON.stringify(ledgerRecordFor(raced, racedRecord.bytes))) throw new Error('raced acknowledgement does not match durable ledger');
      await fs.rm(tmp, { force: true });
      return { ack: raced, resultFile: result, identity, resultIdentity: { dev: resultData.stat.dev, ino: resultData.stat.ino, size: resultData.stat.size } };
    }
  } catch (error) { await fs.rm(tmp, { force: true }).catch(() => {}); throw error; }
  return { ack, resultFile: result, identity, resultIdentity: { dev: resultData.stat.dev, ino: resultData.stat.ino, size: resultData.stat.size } };
}

export async function resultCustodyFiles(resultFile) {
  const source = path.resolve(resultFile); const dir = path.dirname(source); const prefix = `.${path.basename(source)}.custody.`;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const candidate = path.join(dir, entry.name); const stat = await fs.lstat(candidate);
    if (!entry.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe result custody: ${candidate}`);
    files.push(candidate);
  }
  return files.sort();
}

async function verifyCustody(custody, ack, expectedIdentity = null) {
  const captured = await exactFileBytes(custody);
  return (!expectedIdentity || (captured.stat.dev === expectedIdentity.dev && captured.stat.ino === expectedIdentity.ino && captured.stat.size === expectedIdentity.size))
    && captured.bytes.length === ack?.resultSize && createHash('sha256').update(captured.bytes).digest('hex') === ack?.resultSha256;
}

async function restoreMismatchedCustody(custody, source, dir) {
  try {
    await fs.link(custody, source); await fs.unlink(custody); await syncDirectory(dir);
    throw new Error('captured result does not match delivery acknowledgement; source restored');
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`captured result does not match delivery acknowledgement; custody retained at ${custody}`);
    throw error;
  }
}

export async function removeAcknowledgedResultWithCustody(resultFile, ack, { expectedIdentity = null, beforeCustody = async () => {}, afterCapture = async () => {} } = {}) {
  const source = path.resolve(resultFile); const dir = path.dirname(source);
  const existingCustody = await resultCustodyFiles(source);
  if (existingCustody.length > 1) throw new Error('multiple result custody files require operator review');
  if (existingCustody.length === 1) {
    const custody = existingCustody[0];
    if (!await verifyCustody(custody, ack, expectedIdentity)) await restoreMismatchedCustody(custody, source, dir);
    await fs.unlink(custody); await syncDirectory(dir);
    return { removed: true, custody, recovered: true };
  }
  const custody = path.join(dir, `.${path.basename(source)}.custody.${process.pid}.${randomUUID()}`);
  await beforeCustody({ source, custody, ack });
  await fs.rename(source, custody); await syncDirectory(dir); await afterCapture({ source, custody, ack });
  if (!await verifyCustody(custody, ack, expectedIdentity)) await restoreMismatchedCustody(custody, source, dir);
  await fs.unlink(custody); await syncDirectory(dir);
  return { removed: true, custody, recovered: false };
}

export function validateLifecycleArtifact(value, expected = {}) {
  const data = record(value);
  if (!data || !Number.isInteger(data.lifecycleArtifactVersion) || data.lifecycleArtifactVersion < 1) return null;
  const id = runId(data); const sessionId = string(data.sessionId);
  const asyncDir = string(data.asyncDir) ?? string(expected.asyncDir); const sessionDir = string(data.sessionDir);
  if (!id || !sessionId || !asyncDir || !path.isAbsolute(asyncDir)) return null;
  if (expected.runId && expected.runId !== id) return null;
  if (expected.sessionId && expected.sessionId !== sessionId) return null;
  if (data.lifecycleArtifactVersion >= 4 && (!EXECUTION_STATES.has(data.execution_state) || !OUTCOME_STATES.has(data.outcome_state)
    || !EFFECTS_STATES.has(data.effects_state) || !DELIVERY_STATES.has(data.delivery_state))) return null;
  if (data.lifecycleArtifactVersion >= 5 && !DELIVERY_DISPOSITIONS.has(data.deliveryDisposition)) return null;
  return {
    lifecycleArtifactVersion: data.lifecycleArtifactVersion, runId: id, sessionId,
    executionState: data.lifecycleArtifactVersion >= 4 ? data.execution_state : null,
    outcomeState: data.lifecycleArtifactVersion >= 4 ? data.outcome_state : null,
    effectsState: data.lifecycleArtifactVersion >= 4 ? data.effects_state : 'unknown',
    deliveryState: data.lifecycleArtifactVersion >= 4 ? data.delivery_state : null,
    deliveryDisposition: data.lifecycleArtifactVersion >= 5 ? data.deliveryDisposition : 'follow_up',
    executionTarget: publicExecutionTarget(data.executionTarget ?? data.execution_target),
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
    run_id: run.runId, run_key: run.runKey ?? null, state: run.state,
    delivery_disposition: run.deliveryDisposition ?? 'follow_up', claim_state: run.claimState ?? 'unclaimed',
    execution_state: run.executionState ?? (run.active ? 'active' : 'terminal'),
    outcome_state: run.outcomeState ?? 'unknown', effects_state: run.effectsState === undefined ? 'unknown' : run.effectsState,
    delivery_state: run.deliveryState ?? null, execution_target: run.executionTarget ?? null,
    blocking: Boolean(run.active), reason: run.reason ?? null,
    parent_session_id: run.sessionId ?? null, parent_session_path: run.artifactSessionId ?? null,
    async_dir: run.asyncDir ?? null, origin: run.origin ?? null,
    started_at: run.startedAt ?? null, updated_at: run.updatedAt ?? null, completed_at: run.completedAt ?? null,
  };
}
export function extractSubagentRuns(entries) {
  return entries.filter((entry) => entry?.type === 'custom' && entry.customType === SUBAGENT_RUN_CUSTOM_TYPE
    && [1, SUBAGENT_RUN_VERSION].includes(record(entry.data)?.version) && runId(entry.data))
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
  constructor({ now = Date.now, lifecycleRoot = process.env.PI_SUBAGENT_RUNTIME_ROOT, resultsRoot = null } = {}) {
    this.now = now; this.lifecycleRoot = lifecycleRoot ? path.resolve(lifecycleRoot) : null;
    this.resultsRoot = resultsRoot ? path.resolve(resultsRoot) : this.lifecycleRoot ? path.join(this.lifecycleRoot, 'async-subagent-results') : null;
    this.conv = null; this.unsubscribes = []; this.completions = [];
    this.eventBus = null; this.earlyEvents = []; this.pendingContinuation = null; this.pendingResultClaims = [];
    this.recoveredFollowUps = new Set();
  }
  findRun(id, key = null) {
    const matches = [...(this.conv?.subagents?.runs?.values?.() ?? [])]
      .filter((run) => run.runId === id && (!key || run.runKey === key));
    return matches.length === 1 ? matches[0] : null;
  }
  async attach(conv) {
    this.conv = conv; conv.subagents ??= { runs: new Map() }; this.restoreMappings(); await this.reconcileArtifacts();
    const early = this.earlyEvents.splice(0);
    for (const event of early) {
      if (event.type === 'started') this.onStarted(event.value);
      else if (event.type === 'complete') this.onComplete(event.value);
      else if (event.type === 'claim') this.onClaimed(event.value);
      else this.onTerminal(event.value);
    }
    this.restorePendingResultClaims();
  }
  adoptSnapshotRuns(snapshot) {
    for (const summary of snapshot?.runs ?? []) {
      const id = string(summary.run_id); const key = string(summary.run_key); const sessionRef = string(summary.parent_session_id ?? summary.parent_session_path);
      if (!id || this.findRun(id, key) || !sessionMatches(this.conv, sessionRef)) continue;
      this.conv.subagents.runs.set(key ?? id, {
        runId: id, runKey: key, sessionId: this.conv.piSessionId, artifactSessionId: sessionRef,
        asyncDir: string(summary.async_dir), state: summary.state, active: summary.blocking,
        executionState: summary.execution_state, reason: summary.reason ?? null,
        deliveryDisposition: DELIVERY_DISPOSITIONS.has(summary.deliveryDisposition) ? summary.deliveryDisposition : 'follow_up',
        deliveryState: summary.delivery_state, claimState: 'unclaimed', origin: record(summary.origin) ?? {},
        startedAt: summary.started_at ?? null, updatedAt: summary.updated_at ?? null,
        completedAt: summary.blocking ? null : summary.updated_at ?? null,
      });
    }
  }
  async reconcileArtifacts(snapshot = null) {
    const byId = snapshot?.byId;
    for (const run of this.conv?.subagents?.runs?.values?.() ?? []) {
      let summary = (run.asyncDir ? snapshot?.byDir?.get(path.resolve(run.asyncDir)) : null) ?? byId?.get(run.runId) ?? null;
      if (!summary && !snapshot && run.asyncDir) {
        try { summary = await classifyRunDirectory(run.asyncDir, { runtime: snapshot?.runtime }); } catch { summary = null; }
      }
      if (!summary) continue;
      run.state = summary.state; run.runKey = string(summary.run_key) ?? run.runKey; run.executionState = summary.execution_state; run.reason = summary.reason;
      run.processTerminal = summary.processTerminal; run.active = summary.blocking; run.updatedAt = summary.updated_at;
      run.deliveryState = summary.delivery_state; run.deliveryDisposition = summary.deliveryDisposition ?? run.deliveryDisposition ?? 'follow_up';
      run.outcomeState = summary.outcome_state; run.effectsState = summary.effects_state; run.executionTarget = summary.execution_target;
      if (!run.active) run.completedAt = summary.updated_at;
    }
    return backgroundStatus(this.conv);
  }
  restoreMappings() {
    const branch = this.conv?.session?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== SUBAGENT_RUN_CUSTOM_TYPE) continue;
      const data = record(entry.data); const id = runId(data);
      if (!id || ![1, SUBAGENT_RUN_VERSION].includes(data.version) || !sessionMatches(this.conv, data.sessionId)) continue;
      const key = string(data.runKey) ?? id; const previous = this.conv.subagents.runs.get(key);
      this.conv.subagents.runs.set(key, {
        runId: id, runKey: string(data.runKey), sessionId: this.conv.piSessionId,
        artifactSessionId: string(data.artifactSessionId) ?? string(data.sessionId) ?? this.conv.sessionPath,
        asyncDir: string(data.asyncDir), state: previous?.state ?? 'unknown', active: previous?.active ?? true,
        executionState: previous?.executionState ?? 'uncertain', origin: record(data.origin) ?? {},
        originUtteranceId: string(data.originUtteranceId) ?? string(data.origin?.postId),
        deliveryDisposition: DELIVERY_DISPOSITIONS.has(data.deliveryDisposition) ? data.deliveryDisposition : 'follow_up',
        deliveryState: data.deliveryState ?? previous?.deliveryState ?? 'pending', claimState: data.claimState ?? 'unclaimed',
        startedAt: data.startedAt ?? null, completedAt: previous?.completedAt ?? null,
      });
    }
  }
  restorePendingResultClaims() {
    const branch = this.conv?.session?.sessionManager?.getBranch?.() ?? [];
    const consumed = new Set(branch.filter((entry) => entry?.type === 'custom'
      && entry.customType === 'monika.message.provenance' && entry.data?.version === 2)
      .flatMap((entry) => Array.isArray(entry.data.resultClaims) ? entry.data.resultClaims : [])
      .map((claim) => string(claim?.claimEntryId)).filter(Boolean));
    for (const entry of branch) {
      if (entry?.type !== 'custom' || entry.customType !== 'pi-subagents.result-claim'
        || consumed.has(entry.id)) continue;
      this.onClaimed({ ...record(entry.data), claimEntryId: entry.id });
    }
  }
  extension() {
    const owner = this;
    return { name: 'agentd-subagent-lifecycle', hidden: true, factory(pi) {
      owner.eventBus = pi.events;
      owner.unsubscribes.push(
        pi.events.on('subagent:async-registering', (data) => owner.onStarted(data)),
        pi.events.on('subagent:async-started', (data) => owner.onStarted(data)),
        pi.events.on('subagent:async-complete', (data) => owner.onComplete(data)),
        pi.events.on('subagent:process-terminal', (data) => owner.onTerminal(data)),
        pi.events.on('subagent:result-claimed', (data) => owner.onClaimed(data)),
      );
    } };
  }
  onStarted(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'started', value }); return true; }
    const data = record(value); const id = runId(data); const sessionId = string(data?.sessionId); const asyncDir = string(data?.asyncDir);
    const disposition = DELIVERY_DISPOSITIONS.has(data?.deliveryDisposition) ? data.deliveryDisposition : 'follow_up';
    if (!id || !sessionMatches(this.conv, sessionId) || !asyncDir || !path.isAbsolute(asyncDir)) return false;
    const identity = lifecycleRunIdentity(this.lifecycleRoot ?? path.resolve(path.dirname(asyncDir)), asyncDir, id);
    const key = identity?.runKey ?? string(data.runKey) ?? id;
    const existing = this.findRun(id, identity?.runKey ?? null);
    if (existing) { existing.deliveryDisposition = disposition; existing.runKey ??= identity?.runKey ?? null; return true; }
    const origin = originFor(this.conv);
    const run = {
      runId: id, runKey: identity?.runKey ?? string(data.runKey), sessionId: this.conv.piSessionId,
      artifactSessionId: sessionId, asyncDir: path.resolve(asyncDir), state: 'running', executionState: 'active', active: true,
      deliveryDisposition: disposition, deliveryState: 'pending', claimState: 'unclaimed', origin,
      originUtteranceId: origin.postId ?? null, startedAt: this.now(), completedAt: null,
    };
    this.conv.subagents.runs.set(key, run);
    this.conv.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, {
      version: SUBAGENT_RUN_VERSION, runId: id, runKey: run.runKey ?? null, sessionId: this.conv.piSessionId,
      artifactSessionId: run.artifactSessionId, asyncDir: run.asyncDir, deliveryDisposition: disposition,
      deliveryState: run.deliveryState, claimState: run.claimState, origin: run.origin,
      originUtteranceId: run.originUtteranceId, startedAt: run.startedAt,
    });
    return true;
  }
  onComplete(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'complete', value }); return true; }
    const data = record(value); const id = runId(data); if (!id) return false;
    const run = this.findRun(id, string(data.runKey)); if (!run) return false;
    if (data.deliveryDisposition && data.deliveryDisposition !== run.deliveryDisposition) return false;
    run.state = data.success === false ? 'failed' : safeState(data.state) === 'unknown' ? 'completed' : safeState(data.state);
    run.completedAt = this.now();
    run.deliveryState = run.deliveryDisposition === 'follow_up' ? 'pending-notification'
      : run.deliveryDisposition === 'awaited' ? 'awaiting-claim' : 'retained';
    if (run.deliveryDisposition === 'follow_up' && run.claimState !== 'claimed') {
      this.completions.push({ runId: id, runKey: run.runKey, origin: run.origin });
      if (this.completions.length > 100) this.completions.shift();
    }
    return true;
  }
  onClaimed(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'claim', value }); return true; }
    const claim = record(value); const id = string(claim?.runId); const key = string(claim?.runKey);
    if (!id || !key || claim.kind !== 'pi-subagents.result-claim' || claim.deliveryDisposition !== 'awaited'
      || !sessionMatches(this.conv, claim.sessionId) || !string(claim.claimEntryId)
      || !/^[a-f0-9]{64}$/.test(claim.resultSha256 ?? '')
      || !Number.isSafeInteger(claim.resultSizeBytes) || claim.resultSizeBytes < 0
      || typeof claim.claimedAt !== 'number' || !Number.isFinite(claim.claimedAt)) return false;
    const run = this.findRun(id, key);
    if (!run || run.deliveryDisposition !== 'awaited') return false;
    run.claimState = 'claimed'; run.deliveryState = 'claimed-awaiting-synthesis';
    this.completions = this.completions.filter((completion) => completion.runKey !== key);
    const canonicalClaim = {
      version: 1, kind: 'pi-subagents.result-claim', runId: id, runKey: key,
      sessionId: claim.sessionId, deliveryDisposition: 'awaited', resultSha256: claim.resultSha256,
      resultSizeBytes: claim.resultSizeBytes, claimedAt: claim.claimedAt,
    };
    if (!this.pendingResultClaims.some((item) => item.claim.runKey === key && item.claim.resultSha256 === claim.resultSha256)) this.pendingResultClaims.push({ claim: canonicalClaim, claimEntryId: claim.claimEntryId });
    return true;
  }
  onTerminal(value) {
    if (!this.conv) { this.earlyEvents.push({ type: 'terminal', value }); return true; }
    const id = runId(value); const run = this.findRun(id, string(value?.runKey));
    if (!run || !validObservedProcessTerminal(value, id)) return false;
    run.processTerminal = record(value); run.executionState = 'terminal'; run.active = false; run.completedAt = this.now(); return true;
  }
  handleSessionEvent(event) {
    const message = event?.message;
    if (event?.type === 'message_start' && message?.role === 'custom' && message.customType === 'subagent-notify') {
      const detailIds = Array.isArray(message.details?.runIds) ? message.details.runIds.map(string).filter(Boolean).slice(0, 100) : [];
      let completions;
      if (detailIds.length > 0) {
        completions = detailIds.flatMap((id) => {
          const run = this.findRun(id);
          return run && run.deliveryDisposition === 'follow_up' && run.claimState !== 'claimed'
            ? [{ runId: id, runKey: run.runKey, origin: run.origin ?? {} }] : [];
        });
        if (completions.length !== detailIds.length) return;
        const claimed = new Set(detailIds); this.completions = this.completions.filter((completion) => !claimed.has(completion.runId));
      } else {
        const grouped = typeof message.content === 'string' ? message.content.match(/^Background tasks completed \((\d+)\):/) : null;
        const requested = grouped ? Math.max(1, Math.min(100, Number(grouped[1]))) : 1;
        completions = this.completions.splice(0, requested);
      }
      const primary = completions[0] ?? null;
      this.pendingContinuation = primary ? {
        runId: primary.runId,
        ...(primary.runKey ? { runKey: primary.runKey } : {}),
        origin: primary.origin,
        runIds: completions.map((item) => item.runId),
        ...(completions.some((item) => item.runKey) ? { runKeys: completions.map((item) => item.runKey).filter(Boolean) } : {}),
        origins: completions.map((item) => ({ runId: item.runId, ...(item.runKey ? { runKey: item.runKey } : {}), ...item.origin })),
      } : null;
    }
    if (event?.type === 'agent_settled') this.pendingContinuation = null;
  }
  continuation() { return this.pendingContinuation; }
  consumeCausalMetadata() {
    const result = { continuation: this.pendingContinuation, resultClaims: this.pendingResultClaims };
    this.pendingContinuation = null; this.pendingResultClaims = [];
    return result;
  }
  async recoverPendingFollowUps() {
    if (!this.eventBus || !this.conv) return { recovered: 0 };
    const branch = this.conv.session?.sessionManager?.getBranch?.() ?? [];
    const notified = new Set(branch.flatMap((entry) => {
      const message = entry?.type === 'message' ? entry.message : entry?.type === 'custom' ? entry : null;
      if (message?.customType !== 'subagent-notify') return [];
      const details = message.details ?? message.data;
      return Array.isArray(details?.runIds) ? details.runIds.map(string).filter(Boolean) : [];
    }));
    let recovered = 0;
    for (const run of this.conv.subagents?.runs?.values?.() ?? []) {
      if (run.deliveryDisposition !== 'follow_up' || run.active || !['pending', 'unproven'].includes(run.deliveryState)
        || notified.has(run.runId) || this.recoveredFollowUps.has(run.runKey ?? run.runId)
        || !run.asyncDir || !path.isAbsolute(run.asyncDir)) continue;
      try {
        await fs.access(path.join(run.asyncDir, 'host-cancellation.json'));
        continue;
      } catch (error) { if (error?.code !== 'ENOENT') continue; }
      try {
        if (!this.lifecycleRoot || !this.resultsRoot) continue;
        const identity = lifecycleRunIdentity(this.lifecycleRoot, run.asyncDir, run.runId);
        if (!identity || identity.runKey !== run.runKey) continue;
        const [launch, status, resultBytes] = await Promise.all([
          readJson(path.join(run.asyncDir, 'launch.json')),
          readJson(path.join(run.asyncDir, 'status.json')),
          exactFileBytes(resultPathForIdentity(this.resultsRoot, identity)),
        ]);
        const result = JSON.parse(resultBytes.bytes.toString('utf8'));
        const matches = (value) => record(value) && value.lifecycleArtifactVersion >= 5
          && (value.runId ?? value.id) === run.runId && value.sessionId === this.conv.piSessionId
          && value.asyncDir === identity.asyncDir && value.deliveryDisposition === 'follow_up'
          && (value.runKey === undefined || value.runKey === identity.runKey);
        if (!matches(launch) || !matches(status) || !matches(result)) continue;
        this.recoveredFollowUps.add(run.runKey ?? run.runId);
        this.eventBus.emit('subagent:async-complete', { ...result, runId: run.runId, runKey: run.runKey, triggerTurn: true });
        recovered += 1;
      } catch { /* incomplete or foreign artifacts remain retained */ }
    }
    return { recovered };
  }
  async requestStops() {
    const runs = [...(this.conv?.subagents?.runs?.values?.() ?? [])].filter((run) => run.active);
    if (!this.eventBus) return { requested: 0, unavailable: runs.length };
    for (const run of runs) this.eventBus.emit('subagents:rpc:v1:request', { version: 1, requestId: randomUUID(), method: 'stop', params: { runId: run.runId }, source: { extension: 'agentd' } });
    return { requested: runs.length, unavailable: 0 };
  }
  dispose() { for (const unsubscribe of this.unsubscribes) { try { unsubscribe?.(); } catch {} } this.unsubscribes = []; }
}

async function lifecycleEntries(root) {
  const output = new Map();
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT' && depth === 0) return; throw error; }
    for (const entry of entries) { const candidate = path.join(dir, entry.name); if (entry.isSymbolicLink()) throw new Error(`unsafe lifecycle symlink: ${candidate}`); if (entry.isDirectory()) await walk(candidate, depth + 1); else if (entry.isFile() && (entry.name === 'status.json' || entry.name === 'launch.json')) output.set(path.dirname(candidate), true); }
  }
  await walk(root, 0); return [...output.keys()];
}
export async function findLifecycleRunIdentities(lifecycleRoot, requestedRunId) {
  const root = path.resolve(lifecycleRoot ?? ''); const id = string(requestedRunId); const matches = [];
  for (const dir of await lifecycleEntries(root)) {
    const status = await readJson(path.join(dir, 'status.json')).catch(() => null); const launch = await readJson(path.join(dir, 'launch.json')).catch(() => null);
    const candidateId = runId(status) ?? runId(launch) ?? path.basename(dir); const identity = lifecycleRunIdentity(root, dir, candidateId);
    if (identity && candidateId === id) matches.push(identity);
  }
  return matches;
}
function timestampMs(value) { if (typeof value === 'number' && Number.isFinite(value)) return value; const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; }
function validLaunchArtifact(value, { lifecycleRoot, asyncDir } = {}) {
  const launch = record(value); const id = runId(launch); const sessionId = string(launch?.sessionId);
  const launchDir = string(launch?.asyncDir); const runnerProcessInstanceId = string(launch?.runnerProcessInstanceId);
  if (!launch || !id || !sessionId || !launchDir || !path.isAbsolute(launchDir) || path.resolve(launchDir) !== path.resolve(asyncDir)
    || !runnerProcessInstanceId || !lifecycleRunIdentity(lifecycleRoot, asyncDir, id)) return null;
  return { ...launch, runId: id, sessionId, asyncDir: path.resolve(launchDir), runnerProcessInstanceId };
}
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
async function readOperatorResolutionAudit(lifecycleRoot) {
  const text = await fs.readFile(path.join(lifecycleRoot, 'operator-resolutions.jsonl'), 'utf8').catch(() => '');
  const records = [];
  for (const line of text.split('\n').filter(Boolean)) {
    try { const value = JSON.parse(line); if (record(value)) records.push(value); } catch { /* an incomplete tail cannot authorize a resolution */ }
  }
  return records;
}
function auditedEffectsResolution(value, id, operatorAudit) {
  const resolution = record(value);
  if (resolution?.version !== 1 || resolution.kind !== 'effects-attestation' || resolution.runId !== id
    || !['none', 'confirmed'].includes(resolution.effectsState) || !string(resolution.reason)
    || typeof resolution.resolvedAt !== 'number' || !Number.isFinite(resolution.resolvedAt)) return null;
  return operatorAudit.some((entry) => entry?.version === resolution.version && entry?.kind === resolution.kind
    && entry?.runId === resolution.runId && entry?.effectsState === resolution.effectsState
    && entry?.reason === resolution.reason && entry?.resolvedAt === resolution.resolvedAt) ? resolution : null;
}
async function classifyRunDirectory(asyncDir, { lifecycleRoot = path.dirname(asyncDir), runtime = null, processInspector = processAlive,
  resultsRoot = null, operatorRoot = null, operatorAudit = [] } = {}) {
  let statusRaw = null; let statusReadFailed = false;
  try { statusRaw = await readJson(path.join(asyncDir, 'status.json')); }
  catch { statusReadFailed = true; }
  const launchArtifact = await readOptionalJsonArtifact(path.join(asyncDir, 'launch.json'));
  const launchRaw = launchArtifact.value;
  const launch = validLaunchArtifact(launchRaw, { lifecycleRoot, asyncDir });
  // launch.json is the canonical process instance and parent mapping. A
  // malformed status must not substitute a stale run identity for it. Legacy
  // unbound terminal proof is compatible only when launch.json is truly absent;
  // a present but unreadable or malformed launch remains blocking uncertainty.
  const id = launch?.runId ?? runId(statusRaw) ?? path.basename(asyncDir);
  const status = statusRaw ? validateLifecycleArtifact(statusRaw, { runId: id, sessionId: launch?.sessionId, asyncDir }) : null;
  const identity = lifecycleRunIdentity(lifecycleRoot, asyncDir, id);
  if (!identity || statusReadFailed || (statusRaw !== null && !status) || (launchArtifact.present && !launch) || (!status && !launch)) return { run_id: id, run_key: identity?.runKey ?? null,
    scope: identity?.scope ?? null, root_run_id: identity?.rootRunId ?? null, state: 'unknown',
    lifecycle_artifact_version: null, execution_state: 'uncertain', outcome_state: 'unknown', effects_state: 'unknown',
    delivery_state: null, execution_target: null, blocking: true,
    reason: identity ? 'malformed-lifecycle-artifact' : 'invalid-lifecycle-location',
    parent_session_id: string(statusRaw?.sessionId ?? launch?.sessionId),
    parent_session_path: string(launch?.parentSessionPath ?? launch?.sessionPath ?? statusRaw?.parentSessionPath ?? statusRaw?.sessionPath),
    runner_process_instance_id: launch?.runnerProcessInstanceId ?? null,
    async_dir: asyncDir, processTerminal: null };
  let proof = await readJson(path.join(asyncDir, 'process-terminal.json')).catch(() => null);
  if (!proof) proof = status?.processTerminal ?? null;
  const operatorResolution = await readJson(path.join(asyncDir, 'operator-resolution.json')).catch(() => null);
  const effectsResolution = await readJson(path.join(asyncDir, 'effects-resolution.json')).catch(() => null);
  const expectedInstanceId = launch?.runnerProcessInstanceId ?? null;
  const operatorQuarantined = operatorResolution?.version === 1 && operatorResolution.action === 'quarantine'
    && operatorResolution.runId === id && string(operatorResolution.runnerProcessInstanceId) === expectedInstanceId;
  const auditedEffects = auditedEffectsResolution(effectsResolution, id, operatorAudit);
  const operatorEffectsState = auditedEffects?.effectsState ?? null;
  const logicalTerminal = status ? !ACTIVE_STATES.has(status.state) && status.state !== 'unknown' : false;
  const runnerPid = Number.isInteger(status?.pid) ? status.pid : Number.isInteger(launch?.pid) ? launch.pid : null;
  const launchRuntimeId = string(launch?.runtimeInstanceId);
  let executionState = 'uncertain'; let blocking = true; let reason = null;
  if (operatorQuarantined) { executionState = 'quarantined'; blocking = false; reason = `operator-quarantine:${string(operatorResolution.reason) ?? 'no-reason'}`; }
  else if (expectedInstanceId && proof?.version === 1 && proof?.state === 'not-started' && proof?.runId === id
    && proof?.runnerProcessInstanceId === expectedInstanceId) { executionState = 'interrupted'; blocking = false; reason = 'runner-not-started'; }
  else if (validObservedProcessTerminal(proof, id, expectedInstanceId)) { executionState = 'terminal'; blocking = false; }
  else {
    const updated = timestampMs(status?.updatedAt ?? launch?.updatedAt ?? launch?.registeredAt);
    if (runtime && launchRuntimeId && launchRuntimeId !== runtime.id) { executionState = 'interrupted'; blocking = false; reason = 'prior-runtime-instance'; }
    else if (runtime && !launchRuntimeId && updated !== null && updated < runtime.createdAt) { executionState = 'interrupted'; blocking = false; reason = 'legacy-record-predates-runtime'; }
    else if (Number.isInteger(runnerPid) && launchRuntimeId && runtime?.id === launchRuntimeId && !(await processInspector(runnerPid, launch))) { executionState = 'interrupted'; blocking = false; reason = logicalTerminal ? 'terminal-runner-no-longer-present' : 'runner-no-longer-present'; }
    else if (logicalTerminal && Number.isInteger(runnerPid) && !(await processInspector(runnerPid, launch))) { executionState = 'interrupted'; blocking = false; reason = 'terminal-runner-no-longer-present'; }
    else if (logicalTerminal) { reason = string(proof?.reason) ?? 'terminal-proof-unavailable'; }
    else { executionState = 'active'; reason = status ? null : 'launch-not-yet-settled'; }
  }
  const profiles = [...new Set((Array.isArray(statusRaw?.steps) ? statusRaw.steps : [])
    .map((step) => string(record(step)?.agent)).filter(Boolean))];
  const profile = profiles.length === 1 ? profiles[0] : profiles.length > 1 ? 'mixed' : null;
  const resultFile = resultsRoot ? resultPathForIdentity(resultsRoot, identity) : null;
  let resultPending = false;
  if (resultFile) {
    try { const stat = await fs.lstat(resultFile); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe pending result'); resultPending = true; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if ((await resultCustodyFiles(resultFile)).length > 0) resultPending = true;
  }
  const deliveryAckRecord = await readDeliveryAckRecord(path.join(asyncDir, 'delivery-ack.json')).catch(() => null);
  const deliveryAck = deliveryAckRecord?.value;
  const validDeliveryAck = deliveryAck?.version === 1 && deliveryAck.kind === 'completion-delivery'
    && deliveryAck.runId === identity.runId && deliveryAck.runKey === identity.runKey
    && /^[a-f0-9]{64}$/.test(deliveryAck.resultSha256 ?? '')
    && Number.isSafeInteger(deliveryAck.resultSize) && deliveryAck.resultSize >= 0
    && string(deliveryAck.proofKind) && string(deliveryAck.proofReference);
  let trustedDeliveryAck = false;
  if (validDeliveryAck && operatorRoot) trustedDeliveryAck = await trustedDeliveryAcknowledgement(operatorRoot, deliveryAck, deliveryAckRecord.bytes).catch(() => false);
  const deliveryState = resultPending ? 'pending' : trustedDeliveryAck ? 'settled' : 'unproven';
  const outcomeState = status?.outcomeState ?? (logicalTerminal ? (status?.state === 'complete' ? 'succeeded' : 'unknown') : 'pending');
  const effectsState = operatorEffectsState ?? (status?.lifecycleArtifactVersion >= 4 ? status.effectsState : null);
  return { run_id: id, run_key: identity.runKey, scope: identity.scope, root_run_id: identity.rootRunId,
    result_path: resultFile, result_file: resultFile,
    state: status?.state ?? safeState(launch?.state), lifecycle_artifact_version: status?.lifecycleArtifactVersion ?? null,
    execution_state: executionState, outcome_state: outcomeState, effects_state: effectsState, delivery_state: deliveryState,
    deliveryDisposition: status?.deliveryDisposition ?? (DELIVERY_DISPOSITIONS.has(launch?.deliveryDisposition) ? launch.deliveryDisposition : 'follow_up'),
    effects_resolution: operatorEffectsState ? auditedEffects : null, execution_target: status?.executionTarget ?? null,
    blocking, reason, parent_session_id: launch?.sessionId ?? status?.sessionId,
    parent_session_path: string(launch?.parentSessionPath ?? launch?.sessionPath ?? statusRaw?.parentSessionPath ?? statusRaw?.sessionPath) ?? launch?.sessionId ?? status?.sessionId,
    runner_process_instance_id: launch?.runnerProcessInstanceId ?? null,
    async_dir: asyncDir, mode: status?.mode ?? string(launch?.mode), profile, pid: runnerPid,
    started_at: status?.startedAt ?? launch?.registeredAt ?? null, updated_at: status?.updatedAt ?? launch?.updatedAt ?? null,
    processTerminal: proof, runtime_instance_id: launchRuntimeId, origin: null };
}
export async function scanLifecycleSnapshot({ lifecycleRoot, runtimeInstanceFile = '/run/monika-runtime-instance.json', processInspector, resultsRoot, operatorRoot } = {}) {
  const resolvedRoot = path.resolve(lifecycleRoot ?? '');
  if (!path.isAbsolute(lifecycleRoot ?? '') || resolvedRoot === path.parse(resolvedRoot).root) throw new Error('dedicated absolute subagent lifecycle root is required');
  const runtime = await readRuntimeInstance(runtimeInstanceFile); const runs = [];
  const operatorAudit = await readOperatorResolutionAudit(resolvedRoot);
  for (const dir of await lifecycleEntries(resolvedRoot)) {
    if (!isWithin(resolvedRoot, dir)) continue;
    try { runs.push(await classifyRunDirectory(dir, { lifecycleRoot: resolvedRoot, runtime, processInspector, resultsRoot, operatorRoot, operatorAudit })); }
    catch (error) {
      const id = path.basename(dir); const identity = lifecycleRunIdentity(resolvedRoot, dir, id);
      // Recover only canonical correlation fields. A malformed/read-failed
      // artifact cannot prove execution state, but its known scoped path and
      // parent mapping must not disappear from cancellation selection.
      let raw = null;
      try { raw = validLaunchArtifact(await readJson(path.join(dir, 'launch.json')), { lifecycleRoot: resolvedRoot, asyncDir: dir }); } catch { /* keep fail-closed */ }
      if (!raw) {
        try { const candidate = await readJson(path.join(dir, 'status.json')); if (record(candidate)) raw = candidate; } catch { /* keep fail-closed */ }
      }
      const recoveredId = runId(raw) ?? id;
      const recoveredIdentity = lifecycleRunIdentity(resolvedRoot, dir, recoveredId) ?? identity;
      runs.push({ run_id: recoveredId, run_key: recoveredIdentity?.runKey ?? null, scope: recoveredIdentity?.scope ?? null,
        root_run_id: recoveredIdentity?.rootRunId ?? null, state: 'unknown', lifecycle_artifact_version: null,
        execution_state: 'uncertain', outcome_state: 'unknown', effects_state: 'unknown', delivery_state: null,
        execution_target: null, blocking: true, reason: `lifecycle-read-failed:${error?.code ?? error?.message ?? 'error'}`,
        parent_session_id: string(raw?.sessionId),
        parent_session_path: string(raw?.parentSessionPath ?? raw?.sessionPath),
        runner_process_instance_id: string(raw?.runnerProcessInstanceId), async_dir: dir });
    }
  }
  const byRawId = new Map(); for (const run of runs) { const list = byRawId.get(run.run_id) ?? []; list.push(run); byRawId.set(run.run_id, list); }
  // Scoped run keys are authoritative internally. Raw-ID APIs still reject
  // collisions by omitting ambiguous entries from byId below.
  runs.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  const mapped = (run) => ({ ...run, runId: run.run_id, runKey: run.run_key, active: run.blocking, asyncDir: run.async_dir, updatedAt: run.updated_at, deliveryState: run.delivery_state, executionState: run.execution_state });
  const byKey = new Map(runs.filter((run) => run.run_key).map((run) => [run.run_key, mapped(run)]));
  const byDir = new Map(runs.map((run) => [path.resolve(run.async_dir), mapped(run)]));
  const byId = new Map([...byRawId].filter(([, list]) => list.length === 1).map(([id, [run]]) => [id, mapped(run)]));
  return { runtime, runs, byId, byKey, byDir,
    active_count: runs.filter((run) => run.blocking).length,
    uncertain_count: runs.filter((run) => run.execution_state === 'uncertain').length,
    effects_unknown_count: runs.filter((run) => run.lifecycle_artifact_version >= 4 && run.effects_state === 'unknown').length };
}
export async function scanActiveLifecycleRuns(opts = {}) { const snapshot = await scanLifecycleSnapshot(opts); return snapshot.runs.filter((run) => run.blocking).map((run) => ({ ...run, runId: run.run_id, asyncDir: run.async_dir })); }

export function prioritizeLifecycleRuns(runs, limit = 64) {
  const safetyBlocker = (run) => run.blocking || run.execution_state === 'uncertain'
    || (run.lifecycle_artifact_version >= 4 && run.effects_state === 'unknown');
  const rank = (run) => safetyBlocker(run) ? 0
    : run.delivery_state === 'unproven' ? 1 : run.delivery_state === 'pending' ? 2 : 3;
  return [...runs].sort((left, right) => rank(left) - rank(right)
    || ((timestampMs(right.updated_at ?? right.started_at) ?? 0) - (timestampMs(left.updated_at ?? left.started_at) ?? 0)))
    .slice(0, Math.max(0, limit));
}

export function capLifecycleRuns(runs, limit = 64) {
  const selected = prioritizeLifecycleRuns(runs, limit);
  const blocker = (run) => run.blocking || run.execution_state === 'uncertain'
    || (run.lifecycle_artifact_version >= 4 && run.effects_state === 'unknown');
  const blockerCount = runs.filter(blocker).length;
  return {
    selected,
    omitted: Math.max(0, runs.length - selected.length),
    blockerCount,
    omittedBlockerCount: Math.max(0, blockerCount - selected.filter(blocker).length),
  };
}

export function mergeMappedLifecycleRuns(snapshot, conversations = []) {
  for (const conv of conversations) {
    conv.subagentLifecycle?.adoptSnapshotRuns(snapshot);
    for (const run of conv.subagents?.runs?.values?.() ?? []) {
      if (snapshot.byId.has(run.runId) || (run.asyncDir && snapshot.byDir?.has(path.resolve(run.asyncDir)))) continue;
      const missing = { run_id: run.runId, runId: run.runId, run_key: run.runKey ?? null, runKey: run.runKey ?? null,
        state: 'unknown', lifecycle_artifact_version: null, execution_state: 'uncertain', executionState: 'uncertain',
        outcome_state: run.outcomeState ?? 'unknown', effects_state: run.effectsState ?? 'unknown', execution_target: run.executionTarget ?? null,
        delivery_state: run.deliveryState ?? null, deliveryState: run.deliveryState ?? null, blocking: true, active: true,
        reason: 'mapped-lifecycle-artifact-missing', parent_session_id: run.sessionId, parent_session_path: run.artifactSessionId,
        async_dir: run.asyncDir, asyncDir: run.asyncDir, started_at: run.startedAt, updated_at: null, updatedAt: null, origin: run.origin ?? null };
      snapshot.runs.push(missing); snapshot.byId.set(run.runId, missing);
    }
  }
  snapshot.active_count = snapshot.runs.filter((run) => run.blocking).length;
  snapshot.uncertain_count = snapshot.runs.filter((run) => run.execution_state === 'uncertain').length;
  snapshot.effects_unknown_count = snapshot.runs.filter((run) => run.lifecycle_artifact_version >= 4 && run.effects_state === 'unknown').length;
  return snapshot;
}

export async function resolvePendingSubagentDelivery({ lifecycleRoot, resultsRoot, operatorRoot, runId: requestedRunId, runKey: requestedRunKey = null, action, reason, beforeStep = async () => {} } = {}) {
  const id = string(requestedRunId); const operatorReason = string(reason);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !['dismiss', 'supersede'].includes(action) || !operatorReason) {
    throw new Error('runId, action (dismiss|supersede), and reason are required');
  }
  const lifecycle = path.resolve(lifecycleRoot ?? ''); const resultRoot = path.resolve(resultsRoot ?? '');
  const auditRoot = path.resolve(operatorRoot ?? '');
  if (!isWithin(lifecycle, resultRoot) || auditRoot === path.parse(auditRoot).root) throw new Error('dedicated lifecycle, results, and operator roots are required');
  const matches = [];
  for (const dir of await lifecycleEntries(lifecycle)) {
    const status = await readJson(path.join(dir, 'status.json')).catch(() => null); const launch = await readJson(path.join(dir, 'launch.json')).catch(() => null);
    const candidateId = runId(status) ?? runId(launch) ?? path.basename(dir); const identity = lifecycleRunIdentity(lifecycle, dir, candidateId);
    if (identity && candidateId === id && (!requestedRunKey || requestedRunKey === identity.runKey)) matches.push(identity);
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'run identity is ambiguous' : 'run lifecycle directory not found');
  const identity = matches[0];
  await fs.mkdir(auditRoot, { recursive: true, mode: 0o700 });
  const auditStat = await fs.lstat(auditRoot); const auditReal = await fs.realpath(auditRoot);
  if (!auditStat.isDirectory() || auditStat.isSymbolicLink() || auditReal !== auditRoot) throw new Error('unsafe operator root');
  const retainedDir = path.join(auditRoot, 'retained-results');
  await fs.mkdir(retainedDir, { recursive: true, mode: 0o700 });
  const retainedStat = await fs.lstat(retainedDir); const retainedReal = await fs.realpath(retainedDir);
  if (!retainedStat.isDirectory() || retainedStat.isSymbolicLink() || !isWithin(auditReal, retainedReal)) throw new Error('unsafe retained result directory');
  const source = resultPathForIdentity(resultRoot, identity);
  let readableSource = source; let sourceHandle;
  try { sourceHandle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const custody = await resultCustodyFiles(source);
    if (custody.length !== 1) throw new Error(custody.length ? 'multiple result custody files require operator review' : 'pending result file not found');
    readableSource = custody[0]; sourceHandle = await fs.open(readableSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  }
  let bytes; let sourceIdentity;
  try {
    const stat = await sourceHandle.stat(); if (!stat.isFile()) throw new Error('pending result file not found');
    sourceIdentity = { dev: stat.dev, ino: stat.ino, size: stat.size }; bytes = await sourceHandle.readFile();
  } finally { await sourceHandle.close(); }
  const resolution = { version: 1, kind: 'completion-delivery', action, runId: id, runKey: identity.runKey, reason: operatorReason, resolvedAt: Date.now() };
  const retainedName = identity.scope === 'top' ? id : `${identity.rootRunId}.${id}`;
  const destination = path.join(retainedReal, `${retainedName}.${action}.json`);
  const sidecar = `${destination}.resolution.json`;
  const auditFile = path.join(auditReal, 'operator-resolutions.jsonl');
  const syncDirectory = async (dir) => {
    const handle = await fs.open(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const appendAudit = async (record) => {
    const handle = await fs.open(auditFile, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(auditReal);
  };
  await appendAudit({ ...resolution, phase: 'requested' });
  await beforeStep('intent');
  try {
    const retained = await fs.open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await retained.writeFile(bytes); await retained.sync(); } finally { await retained.close(); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existingStat = await fs.lstat(destination);
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) throw new Error('unsafe retained result destination');
    const existingHandle = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { if (!Buffer.from(await existingHandle.readFile()).equals(bytes)) throw new Error('conflicting retained result bytes'); }
    finally { await existingHandle.close(); }
  }
  await syncDirectory(retainedReal);
  await beforeStep('retained');
  let completed = { ...resolution, phase: 'completed', retainedResult: destination };
  let sidecarBytes = `${JSON.stringify(completed, null, 2)}\n`;
  try {
    const sidecarHandle = await fs.open(sidecar, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await sidecarHandle.writeFile(sidecarBytes); await sidecarHandle.sync(); } finally { await sidecarHandle.close(); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existingHandle = await fs.open(sidecar, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const existingText = await existingHandle.readFile('utf8');
      const existing = JSON.parse(existingText);
      if (existing?.version !== 1 || existing.runId !== id || existing.action !== action || existing.reason !== operatorReason
        || existing.phase !== 'completed' || existing.retainedResult !== destination) throw new Error('conflicting operator resolution sidecar');
      completed = existing;
      sidecarBytes = existingText;
    } finally { await existingHandle.close(); }
  }
  await syncDirectory(retainedReal);
  await beforeStep('sidecar');
  await appendAudit(completed);
  await beforeStep('completed-audit');
  const acknowledgement = await writeSubagentDeliveryAck({ lifecycleRoot: lifecycle, asyncDir: identity.asyncDir, resultsRoot: resultRoot,
    operatorRoot: auditRoot, runId: id, runKey: identity.runKey, resultFile: source, proofKind: 'operator-resolution', proofReference: sidecar,
    beforePublish: async () => beforeStep('delivery-ack'), });
  await removeAcknowledgedResultWithCustody(source, acknowledgement.ack, { expectedIdentity: sourceIdentity,
    beforeCustody: async () => beforeStep('result-custody'), afterCapture: async () => beforeStep('result-captured') });
  return completed;
}

export async function resolveSubagentEffects({ lifecycleRoot, runId: requestedRunId, effectsState, reason, runtimeInstanceFile = '/run/monika-runtime-instance.json', processInspector } = {}) {
  const id = string(requestedRunId); const operatorReason = string(reason);
  if (!id || path.basename(id) !== id || !['none', 'confirmed'].includes(effectsState) || !operatorReason) {
    throw new Error('runId, effectsState (none|confirmed), and reason are required');
  }
  const root = path.resolve(lifecycleRoot ?? '');
  const matches = (await lifecycleEntries(root)).filter((candidate) => path.basename(candidate) === id);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? 'run lifecycle directory not found' : 'run id is ambiguous');
  const asyncDir = matches[0];
  if (!isWithin(root, asyncDir)) throw new Error('invalid run path');
  const runtime = await readRuntimeInstance(runtimeInstanceFile);
  const operatorAudit = await readOperatorResolutionAudit(root);
  const current = await classifyRunDirectory(asyncDir, { runtime, processInspector, operatorAudit });
  if (current.blocking || !['terminal', 'interrupted', 'quarantined'].includes(current.execution_state)) {
    throw new Error('effects can only be attested after execution is durably inactive');
  }
  if (current.lifecycle_artifact_version < 4) throw new Error('effects attestation requires lifecycle artifact version 4 or newer');
  if (current.effects_state !== 'unknown') {
    const existing = current.effects_resolution;
    if (existing?.effectsState === effectsState && existing?.reason === operatorReason) return existing;
    throw new Error('run effects are already resolved');
  }
  const resolution = {
    version: 1, kind: 'effects-attestation', runId: id, effectsState,
    reason: operatorReason, resolvedAt: Date.now(),
  };
  const file = path.join(asyncDir, 'effects-resolution.json'); const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const syncDirectory = async (dir) => {
    const handle = await fs.open(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
  };
  try {
    const sidecar = await fs.open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await sidecar.writeFile(`${JSON.stringify(resolution, null, 2)}\n`); await sidecar.sync(); } finally { await sidecar.close(); }
    // Audit publication precedes the effective per-run attestation. A failed
    // audit therefore cannot make an unknown remote mutation deploy-safe.
    const audit = await fs.open(path.join(root, 'operator-resolutions.jsonl'), fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await audit.writeFile(`${JSON.stringify(resolution)}\n`); await audit.sync(); } finally { await audit.close(); }
    await syncDirectory(root);
    await fs.rename(tmp, file);
    await syncDirectory(asyncDir);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return resolution;
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

/** Child sessions are inventory-only until cross-process lease fencing is authoritative. */
export async function pruneTerminalSubagentRuns({ lifecycleRoot } = {}) {
  const resolvedLifecycleRoot = path.resolve(lifecycleRoot ?? '');
  if (!path.isAbsolute(lifecycleRoot ?? '') || resolvedLifecycleRoot === path.parse(resolvedLifecycleRoot).root) throw new Error('dedicated absolute subagent lifecycle root is required');
  return { removed: [], retained: await lifecycleEntries(resolvedLifecycleRoot) };
}
