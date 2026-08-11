import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { findLifecycleRunIdentities, lifecycleRunIdentity, removeAcknowledgedResultWithCustody, resultPathForIdentity, writeSubagentDeliveryAck } from './subagent-lifecycle.mjs';

export const MESSAGE_PROVENANCE_CUSTOM_TYPE = 'monika.message.provenance';
export const MESSAGE_PROVENANCE_VERSION = 2;
export const RESULT_CLAIM_CUSTOM_TYPE = 'pi-subagents.result-claim';
export const ATTACHMENT_REF_CUSTOM_TYPE = 'monika.forum.attachment.ref';

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`provenance.${name} must be a non-empty string`);
  return value.trim();
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function string(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function validRunId(value) { return Boolean(string(value)?.match(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)); }
function nullableString(value, name) {
  if (value == null) return null;
  return nonEmptyString(value, name);
}
function normalizeExecutionOrigin(value, index) {
  const origin = record(value);
  if (!origin) throw new Error(`provenance.executionOrigins[${index}] must be an object`);
  const originKind = nonEmptyString(origin.originKind ?? origin.origin_kind, `executionOrigins[${index}].originKind`);
  if (originKind !== 'forum' && originKind !== 'external') throw new Error(`provenance.executionOrigins[${index}].originKind is invalid`);
  return {
    utteranceId: nonEmptyString(origin.utteranceId ?? origin.utterance_id, `executionOrigins[${index}].utteranceId`),
    originKind,
    channelKind: nonEmptyString(origin.channelKind ?? origin.channel_kind, `executionOrigins[${index}].channelKind`),
    topicId: nonEmptyString(origin.topicId ?? origin.topic_id, `executionOrigins[${index}].topicId`),
    postId: nonEmptyString(origin.postId ?? origin.post_id, `executionOrigins[${index}].postId`),
    surfaceId: nullableString(origin.surfaceId ?? origin.surface_id, `executionOrigins[${index}].surfaceId`),
    externalEventId: nullableString(origin.externalEventId ?? origin.external_event_id, `executionOrigins[${index}].externalEventId`),
    scope: nullableString(origin.scope, `executionOrigins[${index}].scope`),
    scopeKind: nullableString(origin.scopeKind ?? origin.scope_kind, `executionOrigins[${index}].scopeKind`),
  };
}

/** Normalize the forum-owned, channel-neutral v2 provenance boundary. */
export function normalizeForumProvenance(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provenance must be an object');
  const origin = nonEmptyString(value.origin ?? 'forum', 'origin');
  if (origin !== 'forum') throw new Error('provenance.origin must be "forum"');
  const topicId = nonEmptyString(value.topicId ?? value.topic_id, 'topicId');
  const postId = nonEmptyString(value.postId ?? value.post_id, 'postId');
  const version = value.version ?? 1;
  if (version !== 1 && version !== 2) throw new Error('provenance.version must be 1 or 2');
  const utteranceIds = version === 2
    ? [...new Set((Array.isArray(value.utteranceIds ?? value.utterance_ids) ? (value.utteranceIds ?? value.utterance_ids) : [])
      .map((id, index) => nonEmptyString(id, `utteranceIds[${index}]`)))]
    : [postId];
  const suppliedOrigins = value.executionOrigins ?? value.execution_origins;
  if (version === 2 && !Array.isArray(suppliedOrigins)) throw new Error('provenance.executionOrigins must be an array');
  const executionOrigins = Array.isArray(suppliedOrigins)
    ? suppliedOrigins.map(normalizeExecutionOrigin)
    : [];
  return { origin, topicId, postId, version, utteranceIds: utteranceIds.length ? utteranceIds : [postId], executionOrigins };
}

export function createProvenanceState() {
  return {
    dispatches: [], runActive: false, activeTurnId: null,
    assistantMessages: [], consumedAttachmentRefEntryIds: new Set(),
  };
}

export function registerDispatch(conv, { turnId, dispatchMode, text, provenance }) {
  conv.provenanceState ??= createProvenanceState();
  const dispatch = {
    turnId, dispatchMode, text, provenance, accepted: null, userMessage: null,
    userPiMessageId: null, userProvenanceEntryId: null, settled: false, boundaryStarted: false,
  };
  conv.provenanceState.dispatches.push(dispatch);
  return dispatch;
}

export function discardDispatch(conv, dispatch) {
  const dispatches = conv.provenanceState?.dispatches;
  if (!dispatches || dispatch.userMessage) return;
  const index = dispatches.indexOf(dispatch);
  if (index >= 0) dispatches.splice(index, 1);
}

export function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

/** Canonical, channel-neutral participant visibility policy. */
export function isOutwardAssistantMessage(message) {
  if (message?.role !== 'assistant' || !messageText(message).trim()) return false;
  return !['error', 'aborted', 'cancelled'].includes(message.stopReason);
}

function findMessageEntry(sessionManager, message) {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry.type === 'message' && entry.message === message) return entry;
  }
  return null;
}

function executionOrigins(dispatch) {
  if (!dispatch?.provenance) return [];
  if (dispatch.provenance.executionOrigins?.length) return dispatch.provenance.executionOrigins;
  return [{
    utteranceId: dispatch.provenance.postId,
    originKind: 'forum',
    channelKind: 'web',
    topicId: dispatch.provenance.topicId,
    postId: dispatch.provenance.postId,
    surfaceId: null,
    externalEventId: null,
    scope: null,
    scopeKind: null,
  }];
}

function userProvenancePayload(dispatch, piMessageId) {
  return {
    version: MESSAGE_PROVENANCE_VERSION,
    piMessageId,
    utteranceId: dispatch.provenance.postId,
    utteranceIds: dispatch.provenance.utteranceIds ?? [dispatch.provenance.postId],
    messageKind: 'user_prompt',
    utteranceKind: 'participant',
    executionOrigins: executionOrigins(dispatch),
    continuation: null,
    resultClaims: [],
    attachmentRefs: [],
    // Backwards-compatible fields.
    turnId: dispatch.turnId,
    origin: dispatch.provenance.origin,
    topicId: dispatch.provenance.topicId,
    postId: dispatch.provenance.postId,
    dispatchMode: dispatch.dispatchMode,
    createdAt: new Date().toISOString(),
  };
}

function reconcileUserMessage(conv, dispatch) {
  if (dispatch.userPiMessageId || !dispatch.userMessage) return;
  const sessionManager = conv.session.sessionManager;
  const entry = findMessageEntry(sessionManager, dispatch.userMessage);
  if (!entry) return;
  dispatch.userPiMessageId = entry.id;
  if (dispatch.provenance && !dispatch.userProvenanceEntryId) {
    const existing = sessionManager.getBranch().find((candidate) => candidate.type === 'custom'
      && candidate.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE
      && candidate.data?.version === 2 && candidate.data?.piMessageId === entry.id
      && candidate.data?.messageKind === 'user_prompt');
    dispatch.userProvenanceEntryId = existing?.id ?? sessionManager.appendCustomEntry(
      MESSAGE_PROVENANCE_CUSTOM_TYPE, userProvenancePayload(dispatch, entry.id),
    );
  }
}

function matchDispatchForUser(state, message) {
  const awaiting = state.dispatches.filter((dispatch) => !dispatch.userMessage && dispatch.accepted !== false);
  const text = messageText(message);
  return awaiting.find((dispatch) => dispatch.text === text) ?? (awaiting.length === 1 ? awaiting[0] : null);
}

function safeAttachmentRef(data, entryId = null) {
  const value = record(data);
  if (!value) return null;
  const ref = {
    ...(entryId ? { refEntryId: entryId } : {}),
    version: value.version,
    pendingAttachmentId: string(value.pendingAttachmentId ?? value.pending_attachment_id),
    topicId: string(value.topicId ?? value.topic_id),
    filename: string(value.filename),
    mimeType: string(value.mimeType ?? value.mime_type),
    sizeBytes: Number.isSafeInteger(value.sizeBytes ?? value.size_bytes) ? (value.sizeBytes ?? value.size_bytes) : null,
    sha256: typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) ? value.sha256 : null,
    expiresAt: string(value.expiresAt ?? value.expires_at),
  };
  return ref.version === 1 && ref.pendingAttachmentId && ref.topicId && ref.filename && ref.mimeType
    && ref.sizeBytes > 0 && ref.sha256 && ref.expiresAt ? ref : null;
}

function continuationPayload(value) {
  const continuation = record(value);
  if (!continuation) return null;
  const runId = continuation.runId ?? continuation.subagentRunId ?? null;
  const runKey = continuation.runKey ?? continuation.subagentRunKey ?? null;
  return {
    sourceKind: 'subagent-completion',
    subagentRunId: runId,
    subagentRunKey: runKey,
    subagentRunIds: continuation.runIds ?? continuation.subagentRunIds ?? (runId ? [runId] : []),
    subagentRunKeys: continuation.runKeys ?? continuation.subagentRunKeys ?? (runKey ? [runKey] : []),
    subagentOrigins: continuation.origins ?? continuation.subagentOrigins ?? [],
    origin: continuation.origin ?? null,
  };
}

function claimPayload(value) {
  const claim = record(value?.claim ?? value);
  const claimEntryId = string(value?.claimEntryId);
  if (!claim || claim.version !== 1 || claim.kind !== RESULT_CLAIM_CUSTOM_TYPE
    || !validRunId(claim.runId) || !string(claim.runKey) || claim.deliveryDisposition !== 'awaited'
    || !/^[a-f0-9]{64}$/.test(claim.resultSha256 ?? '')
    || !Number.isSafeInteger(claim.resultSizeBytes) || claim.resultSizeBytes < 0 || !claimEntryId) return null;
  return {
    version: 1, kind: RESULT_CLAIM_CUSTOM_TYPE, runId: claim.runId, runKey: claim.runKey,
    sessionId: claim.sessionId, deliveryDisposition: 'awaited', resultSha256: claim.resultSha256,
    resultSizeBytes: claim.resultSizeBytes, claimedAt: claim.claimedAt, claimEntryId,
  };
}

function assistantProvenancePayload(recordValue, executionOriginsValue) {
  const continuation = continuationPayload(recordValue.continuation);
  return {
    version: MESSAGE_PROVENANCE_VERSION,
    piMessageId: recordValue.piMessageId,
    utteranceId: recordValue.piMessageId,
    utteranceIds: recordValue.utteranceIds ?? [],
    messageKind: 'assistant_outward',
    utteranceKind: 'participant',
    executionOrigins: executionOriginsValue,
    continuation,
    resultClaims: recordValue.resultClaims,
    attachmentRefs: recordValue.attachmentRefs,
    // Backwards-compatible continuation fields.
    ...(continuation ? {
      origin: 'subagent-completion', sourceKind: 'subagent-completion',
      runId: continuation.subagentRunId, runKey: continuation.subagentRunKey,
      runIds: continuation.subagentRunIds, runKeys: continuation.subagentRunKeys,
      origins: continuation.subagentOrigins,
      originTurnId: continuation.origin?.turnId ?? null,
      originTopicId: continuation.origin?.topicId ?? null,
      originPostId: continuation.origin?.postId ?? null,
    } : {}),
    createdAt: new Date().toISOString(),
  };
}

function appendAssistantProvenance(sessionManager, assistantRecord, executionOrigins) {
  const existing = sessionManager.getBranch().find((entry) => entry.type === 'custom'
    && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE && entry.data?.version === 2
    && entry.data?.piMessageId === assistantRecord.piMessageId
    && entry.data?.messageKind === 'assistant_outward');
  if (existing) return existing.id;
  return sessionManager.appendCustomEntry(
    MESSAGE_PROVENANCE_CUSTOM_TYPE,
    assistantProvenancePayload(assistantRecord, executionOrigins),
  );
}

/**
 * Capture immutable assistant records at message_end and reconcile their
 * canonical JSONL entries only at Pi's agent_settled idle barrier.
 */
export function handleProvenanceEvent(conv, event, { consumeCausalMetadata } = {}) {
  conv.provenanceState ??= createProvenanceState();
  const state = conv.provenanceState;

  if (event.type === 'agent_start' && !state.runActive) {
    // Pi emits agent_start only for a new run. A steer contributes to the
    // current run and must never replace its boundary identity. Bind the
    // earliest durably accepted queued dispatch that has not started yet.
    const boundary = state.dispatches.find((dispatch) => dispatch.accepted === true
      && dispatch.dispatchMode === 'queue' && !dispatch.settled && !dispatch.boundaryStarted);
    if (boundary) boundary.boundaryStarted = true;
    state.activeTurnId = boundary?.turnId ?? null;
    state.runActive = true;
    state.assistantMessages = [];
  }

  if (event.type === 'message_end' && event.message?.role === 'user') {
    const dispatch = matchDispatchForUser(state, event.message);
    if (dispatch) {
      dispatch.userMessage = event.message;
      queueMicrotask(() => reconcileUserMessage(conv, dispatch));
    }
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const outward = isOutwardAssistantMessage(event.message);
    const causal = outward ? (consumeCausalMetadata?.() ?? {}) : {};
    const resultClaims = (causal.resultClaims ?? []).map(claimPayload).filter(Boolean);
    state.assistantMessages.push(Object.freeze({
      message: event.message,
      entry: null,
      piMessageId: null,
      text: messageText(event.message),
      outward,
      continuation: continuationPayload(causal.continuation),
      resultClaims,
      attachmentRefs: [],
      executionOrigins: [],
      utteranceIds: [],
    }));
  }

  if (event.type !== 'agent_settled') return null;

  for (const dispatch of state.dispatches) reconcileUserMessage(conv, dispatch);
  const delivered = state.dispatches.filter((dispatch) => dispatch.userPiMessageId && !dispatch.settled);
  const allExecutionOrigins = delivered.flatMap(executionOrigins).filter((origin, index, all) =>
    all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(origin)) === index);
  const utteranceIds = [...new Set(delivered.flatMap((dispatch) => dispatch.provenance?.utteranceIds ?? []))];
  const assistantUtterances = [];
  const sessionManager = conv.session.sessionManager;
  const branch = sessionManager.getBranch();
  const branchOrder = new Map(branch.map((entry, index) => [entry.id, index]));
  for (const provenance of extractMessageProvenance(branch)) {
    for (const ref of Array.isArray(provenance.attachmentRefs) ? provenance.attachmentRefs : []) {
      if (string(ref?.refEntryId)) state.consumedAttachmentRefEntryIds.add(ref.refEntryId);
    }
  }
  const unconsumedRefs = branch.flatMap((entry, index) => {
    if (entry.type !== 'custom' || entry.customType !== ATTACHMENT_REF_CUSTOM_TYPE
      || state.consumedAttachmentRefEntryIds.has(entry.id)) return [];
    const ref = safeAttachmentRef(entry.data, entry.id);
    return ref ? [{ index, ref }] : [];
  });
  const resolvedRecords = state.assistantMessages.flatMap((captured) => {
    const entry = findMessageEntry(sessionManager, captured.message);
    if (!entry || !captured.outward || !isOutwardAssistantMessage(entry.message)) return [];
    return [{ ...captured, entry, piMessageId: entry.id, text: messageText(entry.message), executionOrigins: allExecutionOrigins, utteranceIds }];
  }).sort((left, right) => branchOrder.get(left.piMessageId) - branchOrder.get(right.piMessageId));

  let priorAssistantIndex = -1;
  for (const resolved of resolvedRecords) {
    const assistantIndex = branchOrder.get(resolved.piMessageId);
    const attachmentRefs = unconsumedRefs
      .filter((candidate) => candidate.index > priorAssistantIndex && candidate.index < assistantIndex)
      .map((candidate) => candidate.ref);
    for (const ref of attachmentRefs) state.consumedAttachmentRefEntryIds.add(ref.refEntryId);
    resolved.attachmentRefs = attachmentRefs;
    const provenanceEntryId = appendAssistantProvenance(sessionManager, resolved, allExecutionOrigins);
    assistantUtterances.push({
      piMessageId: resolved.piMessageId,
      utteranceId: resolved.piMessageId,
      text: resolved.text,
      continuation: resolved.continuation,
      attachmentRefs: resolved.attachmentRefs,
      executionOrigins: allExecutionOrigins,
      utteranceIds,
      provenanceEntryId,
    });
    priorAssistantIndex = assistantIndex;
  }

  for (const dispatch of delivered) dispatch.settled = true;
  state.runActive = false;
  state.activeTurnId = null;
  state.assistantMessages = [];
  state.dispatches = state.dispatches.filter((dispatch, index, all) => !dispatch.settled || index >= all.length - 100);

  return {
    assistantPiMessageId: assistantUtterances.at(-1)?.piMessageId ?? null,
    assistantUtterances,
    userMappings: delivered.map((dispatch) => ({ turn_id: dispatch.turnId, user_pi_message_id: dispatch.userPiMessageId })),
  };
}

/** Compatibility helper for callers/tests that append a follow-up proof directly. */
export function appendSubagentCompletionProvenance(conv, piMessageId, continuation) {
  if (!piMessageId || !continuation || continuation.sourceKind !== 'subagent-completion') return null;
  return appendAssistantProvenance(conv.session.sessionManager, {
    piMessageId, continuation, resultClaims: [], attachmentRefs: [],
  }, []);
}

export function extractMessageProvenance(entries) {
  return entries.filter((entry) => entry.type === 'custom'
    && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE && record(entry.data))
    .map((entry) => ({ entryId: entry.id, parentId: entry.parentId ?? null, timestamp: entry.timestamp ?? null, ...entry.data }));
}

function assistantPrecedesProof(entries, index, piMessageId) {
  const assistant = entries.slice(0, index).find((candidate) => candidate?.type === 'message'
    && candidate.id === piMessageId && isOutwardAssistantMessage(candidate.message));
  return Boolean(assistant);
}

/** Canonical proofs that visible parent speech incorporated a child result. */
function extractCompletedSubagentProofs(entries) {
  const proofs = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const data = entry?.type === 'custom' && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE ? record(entry.data) : null;
    const historicalFollowUp = data?.version === 1 && data.sourceKind === 'subagent-completion' && data.messageKind === 'assistant_terminal';
    const outwardV2 = data?.version === 2 && data.messageKind === 'assistant_outward';
    if ((!historicalFollowUp && !outwardV2) || !string(data.piMessageId)
      || !assistantPrecedesProof(entries, index, data.piMessageId)) continue;

    const continuation = record(data.continuation);
    if (historicalFollowUp || data.sourceKind === 'subagent-completion' || continuation?.sourceKind === 'subagent-completion') {
      const ids = Array.isArray(data.runIds) ? data.runIds
        : Array.isArray(continuation?.subagentRunIds) ? continuation.subagentRunIds : [data.runId ?? continuation?.subagentRunId];
      const keys = Array.isArray(data.runKeys) ? data.runKeys
        : Array.isArray(continuation?.subagentRunKeys) ? continuation.subagentRunKeys : [];
      ids.forEach((id, offset) => {
        if (validRunId(id)) proofs.set(keys[offset] ?? `raw:${id}`, {
          kind: 'follow-up', runId: id, runKey: string(keys[offset]), entryId: entry.id, piMessageId: data.piMessageId,
        });
      });
    }

    if (outwardV2 && Array.isArray(data.resultClaims)) {
      for (const value of data.resultClaims) {
        const claim = claimPayload(value);
        if (!claim) continue;
        const claimIndex = entries.findIndex((candidate) => candidate?.id === claim.claimEntryId
          && candidate.type === 'custom' && candidate.customType === RESULT_CLAIM_CUSTOM_TYPE);
        const canonicalClaim = claimIndex >= 0 ? record(entries[claimIndex].data) : null;
        if (claimIndex < 0 || claimIndex >= index || JSON.stringify(canonicalClaim) !== JSON.stringify(Object.fromEntries(
          Object.entries(claim).filter(([key]) => key !== 'claimEntryId'),
        ))) continue;
        proofs.set(claim.runKey, {
          kind: 'awaited-claim', runId: claim.runId, runKey: claim.runKey,
          claim, entryId: entry.id, piMessageId: data.piMessageId,
        });
      }
    }
  }
  return proofs;
}

export function extractCompletedSubagentRunIds(entries) {
  return new Set([...extractCompletedSubagentProofs(entries).values()].map((proof) => proof.runId));
}

async function exactFileBytes(file) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('artifact is not a regular file');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function resolveProofIdentity(proof, lifecycleRoot) {
  const matches = await findLifecycleRunIdentities(lifecycleRoot, proof.runId);
  const scoped = proof.runKey ? matches.filter((identity) => identity.runKey === proof.runKey) : matches;
  if (scoped.length !== 1) throw new Error(scoped.length ? 'run identity is ambiguous' : 'run lifecycle directory not found');
  return scoped[0];
}

async function readLifecycleProof(identity, expectedDisposition) {
  const status = JSON.parse((await exactFileBytes(path.join(identity.asyncDir, 'status.json'))).toString('utf8'));
  let launch = null;
  try { launch = JSON.parse((await exactFileBytes(path.join(identity.asyncDir, 'launch.json'))).toString('utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const modern = status.lifecycleArtifactVersion >= 5 || launch?.lifecycleArtifactVersion >= 5;
  if (modern && (status.deliveryDisposition !== expectedDisposition || launch?.deliveryDisposition !== expectedDisposition)) throw new Error(`${expectedDisposition} disposition mismatch`);
  return { launch, status };
}

async function verifyProofDisposition(identity, expected) { await readLifecycleProof(identity, expected); }

function assertExactAwaitedArtifact(value, label, identity, parentSessionId) {
  if (!record(value) || value.lifecycleArtifactVersion !== 5
    || (value.runId ?? value.id) !== identity.runId
    || value.sessionId !== parentSessionId
    || value.asyncDir !== identity.asyncDir
    || value.deliveryDisposition !== 'awaited') throw new Error(`${label} identity mismatch`);
  if (value.runKey !== undefined && value.runKey !== identity.runKey) throw new Error(`${label} run key mismatch`);
}

async function verifyAwaitedClaim(proof, identity, resultsRoot, parentSessionId) {
  if (!parentSessionId || proof.claim.sessionId !== parentSessionId) throw new Error('claim parent session identity mismatch');
  if (identity.runId !== proof.claim.runId || identity.runKey !== proof.claim.runKey) throw new Error('claim run identity mismatch');
  const { launch, status } = await readLifecycleProof(identity, 'awaited');
  assertExactAwaitedArtifact(launch, 'launch artifact', identity, parentSessionId);
  assertExactAwaitedArtifact(status, 'status artifact', identity, parentSessionId);
  const sidecarBytes = await exactFileBytes(path.join(identity.asyncDir, 'result-claim.json'));
  const sidecar = JSON.parse(sidecarBytes.toString('utf8'));
  const expected = Object.fromEntries(Object.entries(proof.claim).filter(([key]) => key !== 'claimEntryId'));
  if (JSON.stringify(sidecar) !== JSON.stringify(expected) || sidecar.deliveryDisposition !== 'awaited') throw new Error('result claim sidecar mismatch');
  const result = await exactFileBytes(resultPathForIdentity(resultsRoot, identity));
  let resultArtifact;
  try { resultArtifact = JSON.parse(result.toString('utf8')); } catch { throw new Error('result artifact is malformed'); }
  assertExactAwaitedArtifact(resultArtifact, 'result artifact', identity, parentSessionId);
  if (result.length !== sidecar.resultSizeBytes
    || createHash('sha256').update(result).digest('hex') !== sidecar.resultSha256) throw new Error('claimed result digest mismatch');
}

export async function settleCompletedSubagentResults(entries, { resultsRoot, lifecycleRoot, operatorRoot, parentSessionId = null, beforeAck, beforeCustody } = {}) {
  if (!path.isAbsolute(resultsRoot ?? '') || !path.isAbsolute(lifecycleRoot ?? '') || !path.isAbsolute(operatorRoot ?? '')) throw new Error('absolute resultsRoot, lifecycleRoot, and operatorRoot are required');
  const outcomes = [];
  for (const proof of extractCompletedSubagentProofs(entries).values()) {
    try {
      const identity = await resolveProofIdentity(proof, lifecycleRoot);
      if (proof.kind === 'awaited-claim') await verifyAwaitedClaim(proof, identity, resultsRoot, parentSessionId);
      else await verifyProofDisposition(identity, 'follow_up');
      const file = resultPathForIdentity(resultsRoot, identity);
      const acknowledgement = await writeSubagentDeliveryAck({
        lifecycleRoot, asyncDir: identity.asyncDir, resultsRoot, operatorRoot,
        runId: identity.runId, runKey: identity.runKey, resultFile: file,
        proofKind: proof.kind === 'awaited-claim' ? 'awaited-result-claim-synthesis' : 'canonical-message-provenance',
        proofReference: `${proof.entryId}:${proof.piMessageId}`,
        beforePublish: beforeAck,
      });
      await removeAcknowledgedResultWithCustody(file, acknowledgement.ack, { expectedIdentity: acknowledgement.resultIdentity, beforeCustody });
      outcomes.push({ runId: identity.runId, runKey: identity.runKey, settled: true, error: null });
    } catch (error) {
      outcomes.push({ runId: proof.runId, runKey: proof.runKey ?? null, settled: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
