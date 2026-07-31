import path from 'node:path';
import { findLifecycleRunIdentities, removeAcknowledgedResultWithCustody, resultPathForIdentity, writeSubagentDeliveryAck } from './subagent-lifecycle.mjs';

export const MESSAGE_PROVENANCE_CUSTOM_TYPE = 'monika.message.provenance';
export const MESSAGE_PROVENANCE_VERSION = 1;

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`provenance.${name} must be a non-empty string`);
  return value.trim();
}

/** Normalize the forum-owned portion of a provenance request. */
export function normalizeForumProvenance(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provenance must be an object');
  const origin = nonEmptyString(value.origin ?? 'forum', 'origin');
  if (origin !== 'forum') throw new Error('provenance.origin must be "forum"');
  return {
    origin,
    topicId: nonEmptyString(value.topicId ?? value.topic_id, 'topicId'),
    postId: nonEmptyString(value.postId ?? value.post_id, 'postId'),
  };
}

export function createProvenanceState() {
  return {
    dispatches: [],
    runActive: false,
    assistantMessages: [],
  };
}

export function registerDispatch(conv, { turnId, dispatchMode, text, provenance }) {
  conv.provenanceState ??= createProvenanceState();
  const dispatch = {
    turnId,
    dispatchMode,
    text,
    provenance,
    accepted: null,
    userMessage: null,
    userPiMessageId: null,
    assistantPiMessageId: null,
    userProvenanceEntryId: null,
    assistantProvenanceEntryId: null,
    settled: false,
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

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

function findMessageEntry(sessionManager, message) {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === 'message' && entry.message === message) return entry;
  }
  return null;
}

function provenancePayload(dispatch, piMessageId, messageKind) {
  return {
    version: MESSAGE_PROVENANCE_VERSION,
    piMessageId,
    turnId: dispatch.turnId,
    origin: dispatch.provenance.origin,
    topicId: dispatch.provenance.topicId,
    postId: dispatch.provenance.postId,
    dispatchMode: dispatch.dispatchMode,
    messageKind,
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
    dispatch.userProvenanceEntryId = sessionManager.appendCustomEntry(
      MESSAGE_PROVENANCE_CUSTOM_TYPE,
      provenancePayload(dispatch, entry.id, 'user_prompt'),
    );
  }
}

function matchDispatchForUser(state, message) {
  const awaiting = state.dispatches.filter((dispatch) => !dispatch.userMessage && dispatch.accepted !== false);
  const text = messageText(message);
  return awaiting.find((dispatch) => dispatch.text === text) ?? (awaiting.length === 1 ? awaiting[0] : null);
}

/**
 * Observe Pi events before the transport bridge handles them. message_end is
 * emitted before SessionManager persistence, so user reconciliation is deferred
 * to a microtask. agent_settled is emitted after all messages are persisted.
 */
export function handleProvenanceEvent(conv, event) {
  conv.provenanceState ??= createProvenanceState();
  const state = conv.provenanceState;

  if (event.type === 'agent_start' && !state.runActive) {
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
    state.assistantMessages.push(event.message);
  }

  if (event.type !== 'agent_settled') return null;

  // Pi emits agent_settled only after message_end persistence. Use object identity
  // to recover canonical entry IDs rather than inventing transport identifiers.
  for (const dispatch of state.dispatches) reconcileUserMessage(conv, dispatch);
  const terminalMessage = state.assistantMessages.at(-1) ?? null;
  const terminalEntry = terminalMessage ? findMessageEntry(conv.session.sessionManager, terminalMessage) : null;
  const delivered = state.dispatches.filter((dispatch) => dispatch.userPiMessageId && !dispatch.settled);

  for (const dispatch of delivered) {
    dispatch.assistantPiMessageId = terminalEntry?.id ?? null;
    if (dispatch.provenance && terminalEntry && !dispatch.assistantProvenanceEntryId) {
      dispatch.assistantProvenanceEntryId = conv.session.sessionManager.appendCustomEntry(
        MESSAGE_PROVENANCE_CUSTOM_TYPE,
        provenancePayload(dispatch, terminalEntry.id, 'assistant_terminal'),
      );
    }
    dispatch.settled = true;
  }

  state.runActive = false;
  state.assistantMessages = [];
  // Bound retained dispatch metadata while preserving unresolved queued prompts.
  state.dispatches = state.dispatches.filter((dispatch, index, all) => !dispatch.settled || index >= all.length - 100);

  const mappings = delivered.map((dispatch) => ({
    turn_id: dispatch.turnId,
    user_pi_message_id: dispatch.userPiMessageId,
  }));
  return {
    assistantPiMessageId: terminalEntry?.id ?? null,
    userMappings: mappings,
  };
}

export function appendSubagentCompletionProvenance(conv, piMessageId, continuation) {
  if (!piMessageId || !continuation || continuation.sourceKind !== 'subagent-completion') return null;
  const sessionManager = conv.session.sessionManager;
  const existing = sessionManager.getBranch().find((entry) => entry.type === 'custom'
    && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE
    && entry.data?.piMessageId === piMessageId
    && entry.data?.sourceKind === 'subagent-completion');
  if (existing) return existing.id;
  return sessionManager.appendCustomEntry(MESSAGE_PROVENANCE_CUSTOM_TYPE, {
    version: MESSAGE_PROVENANCE_VERSION,
    piMessageId,
    origin: 'subagent-completion',
    sourceKind: 'subagent-completion',
    runId: continuation.subagentRunId ?? null,
    runIds: continuation.subagentRunIds ?? [],
    origins: continuation.subagentOrigins ?? [],
    originTurnId: continuation.origin?.turnId ?? null,
    originTopicId: continuation.origin?.topicId ?? null,
    originPostId: continuation.origin?.postId ?? null,
    messageKind: 'assistant_terminal',
    createdAt: new Date().toISOString(),
  });
}

export function extractMessageProvenance(entries) {
  return entries
    .filter((entry) => entry.type === 'custom'
      && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE
      && entry.data && typeof entry.data === 'object')
    .map((entry) => ({ entryId: entry.id, parentId: entry.parentId ?? null, timestamp: entry.timestamp ?? null, ...entry.data }));
}

/** Canonical proof that recovered completion results were already applied. */
function extractCompletedSubagentProofs(entries) {
  const proofs = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const data = entry?.type === 'custom' && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE ? entry.data : null;
    if (!data || data.version !== MESSAGE_PROVENANCE_VERSION
      || data.sourceKind !== 'subagent-completion' || data.messageKind !== 'assistant_terminal'
      || typeof data.piMessageId !== 'string') continue;
    const assistant = entries.slice(0, index).find((candidate) => candidate?.type === 'message'
      && candidate.id === data.piMessageId && candidate.message?.role === 'assistant');
    const content = assistant?.message?.content;
    const visible = typeof content === 'string' ? Boolean(content.trim())
      : Array.isArray(content) && content.some((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim());
    const stopReason = assistant?.message?.stopReason;
    if (!visible || typeof stopReason !== 'string' || ['error', 'aborted', 'cancelled'].includes(stopReason)) continue;
    const candidates = Array.isArray(data.runIds) ? data.runIds : [data.runId];
    for (const id of candidates) {
      if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) proofs.set(id, { entryId: entry.id, piMessageId: data.piMessageId });
    }
  }
  return proofs;
}
export function extractCompletedSubagentRunIds(entries) { return new Set(extractCompletedSubagentProofs(entries).keys()); }

export async function settleCompletedSubagentResults(entries, { resultsRoot, lifecycleRoot, operatorRoot, beforeAck, beforeCustody } = {}) {
  if (!path.isAbsolute(resultsRoot ?? '') || !path.isAbsolute(lifecycleRoot ?? '') || !path.isAbsolute(operatorRoot ?? '')) throw new Error('absolute resultsRoot, lifecycleRoot, and operatorRoot are required');
  const outcomes = [];
  for (const [runId, proof] of extractCompletedSubagentProofs(entries)) {
    try {
      const matches = await findLifecycleRunIdentities(lifecycleRoot, runId);
      if (matches.length !== 1) throw new Error(matches.length ? 'run identity is ambiguous' : 'run lifecycle directory not found');
      const identity = matches[0]; const file = resultPathForIdentity(resultsRoot, identity);
      const acknowledgement = await writeSubagentDeliveryAck({ lifecycleRoot, asyncDir: identity.asyncDir, resultsRoot, operatorRoot, runId, runKey: identity.runKey,
        resultFile: file, proofKind: 'canonical-message-provenance', proofReference: `${proof.entryId}:${proof.piMessageId}`,
        beforePublish: beforeAck });
      await removeAcknowledgedResultWithCustody(file, acknowledgement.ack, { expectedIdentity: acknowledgement.resultIdentity, beforeCustody });
      outcomes.push({ runId, runKey: identity.runKey, settled: true, error: null });
    } catch (error) {
      outcomes.push({ runId, runKey: null, settled: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
