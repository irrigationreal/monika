import { randomUUID } from "node:crypto";

function extractUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = messages[i]?.usage;
    if (usage && typeof usage === "object") {
      return {
        input_tokens: usage.input ?? usage.input_tokens,
        output_tokens: usage.output ?? usage.output_tokens,
        total_tokens: usage.totalTokens ?? usage.total_tokens ?? usage.total,
      };
    }
  }
  return null;
}

export function classifyProviderError(error) {
  const text = String(error ?? "").toLowerCase();
  if (/context (?:length|window)|maximum context|context limit|too many tokens|prompt (?:is )?too long|token limit/.test(text)) return "context_overflow";
  if (/\brate[ -]?limit|\btoo many requests\b|\b429\b|quota exceeded/.test(text)) return "rate_limit";
  if (/\bauthentication\b|\bunauthorized\b|\bforbidden\b|invalid (?:api )?key|api key.*(?:invalid|missing)|\b40[13]\b/.test(text)) return "authentication";
  if (/\bprovider\b|\bupstream\b|service unavailable|temporarily unavailable|overloaded|internal server error|\b50[0234]\b/.test(text)) return "provider";
  return "unknown";
}

const PRIVATE_SUBAGENT_TOOLS = new Set(['subagent', 'subagent_wait']);
function boundedString(value, max = 128) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }
function redactedSubagentResult(value) {
  const details = value && typeof value === 'object' && !Array.isArray(value) ? value.details : null;
  const claims = Array.isArray(details?.resultClaims) ? details.resultClaims.slice(0, 32).flatMap((item) => {
    const claim = item?.claim && typeof item.claim === 'object' ? item.claim : item;
    const runId = boundedString(claim?.runId); const runKey = boundedString(claim?.runKey);
    if (!runId || !runKey || !/^[a-f0-9]{64}$/.test(claim?.resultSha256 ?? '')
      || !Number.isSafeInteger(claim?.resultSizeBytes) || claim.resultSizeBytes < 0) return [];
    return [{ run_id: runId, run_key: runKey, delivery_disposition: claim.deliveryDisposition === 'awaited' ? 'awaited' : null,
      result_sha256: claim.resultSha256, result_size_bytes: claim.resultSizeBytes,
      claim_entry_id: boundedString(item?.claimEntryId), idempotent: Boolean(item?.idempotent) }];
  }) : [];
  const resultCount = Array.isArray(details?.results) ? details.results.length : null;
  return { redacted: true, status: {
    mode: boundedString(details?.mode, 64), state: boundedString(details?.state, 64),
    run_id: boundedString(details?.runId ?? details?.asyncId),
    delivery_disposition: ['awaited', 'follow_up', 'silent'].includes(details?.deliveryDisposition) ? details.deliveryDisposition : null,
    result_count: resultCount, claim_count: claims.length,
  }, claims };
}
function outwardToolResult(conv, event, callId, value) {
  const toolName = event.toolName ?? conv.current?.toolCalls?.get(callId) ?? 'tool';
  return PRIVATE_SUBAGENT_TOOLS.has(toolName) ? redactedSubagentResult(value) : value;
}

function continuationWire(continuation) {
  if (!continuation) return {};
  return {
    source_kind: continuation.sourceKind,
    subagent_run_id: continuation.subagentRunId,
    subagent_run_key: continuation.subagentRunKey ?? null,
    subagent_run_ids: continuation.subagentRunIds ?? (continuation.subagentRunId ? [continuation.subagentRunId] : []),
    subagent_run_keys: continuation.subagentRunKeys ?? (continuation.subagentRunKey ? [continuation.subagentRunKey] : []),
    subagent_origins: continuation.subagentOrigins ?? [],
    origin_turn_id: continuation.origin?.turnId ?? null,
    origin_topic_id: continuation.origin?.topicId ?? null,
    origin_post_id: continuation.origin?.postId ?? null,
  };
}

/**
 * Translate Pi lifecycle events into agentd's stable forum protocol. Deltas are
 * live trace only; persisted canonical assistant entries define final items.
 */
export function handlePiEvent(conv, event, emit, createId = randomUUID) {
  switch (event.type) {
    case "agent_start": {
      if (!conv.current) {
        // Forum dispatches carry a durable at-most-once identity selected by
        // message-provenance at this agent_start. Direct/non-forum runs retain
        // an ephemeral bridge UUID for backwards compatibility.
        const messageId = conv.provenanceState?.activeTurnId ?? createId();
        conv.current = {
          messageId,
          traceText: "",
          toolCalls: new Map(),
          startedAt: Date.now(),
          usage: null,
          terminalError: null,
          assistantUtterances: [],
          userMappings: [],
        };
        emit(conv, "turn_started", { message_id: messageId, turn_id: messageId, thread_id: conv.id });
      }
      break;
    }
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent ?? event;
      if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
        if (conv.current) conv.current.traceText += assistantEvent.delta;
        emit(conv, "turn_delta", { content: assistantEvent.delta });
      } else if (assistantEvent.type === "thinking_delta" && assistantEvent.delta) {
        emit(conv, "reasoning_delta", { delta: assistantEvent.delta });
      }
      break;
    }
    case "tool_execution_start": {
      const callId = event.toolCallId ?? event.id ?? createId();
      if (conv.current) conv.current.toolCalls.set(callId, event.toolName ?? "tool");
      emit(conv, "item_started", { item: { type: "function_call", id: callId, call_id: callId, name: event.toolName ?? "tool", arguments: event.args ?? event.input ?? event.arguments ?? null } });
      break;
    }
    case "tool_execution_update": {
      const callId = event.toolCallId ?? event.id ?? createId();
      const toolName = event.toolName ?? conv.current?.toolCalls?.get(callId) ?? "tool";
      emit(conv, "tool_updated", { call_id: callId, tool_name: toolName, args: event.args ?? null, partial_result: outwardToolResult(conv, event, callId, event.partialResult ?? null) });
      break;
    }
    case "tool_execution_end": {
      const callId = event.toolCallId ?? event.id ?? createId();
      const toolName = event.toolName ?? conv.current?.toolCalls?.get(callId) ?? "tool";
      const result = event.result ?? event.output ?? event.error ?? null;
      emit(conv, "tool_completed", { call_id: callId, tool_name: toolName, args: event.args ?? null, result: outwardToolResult(conv, event, callId, result), is_error: Boolean(event.isError) });
      break;
    }
    case "message_end": {
      if (!conv.current || event.message?.role !== "assistant") break;
      if (["error", "aborted", "cancelled"].includes(event.message.stopReason)) {
        conv.current.terminalError = String(event.message.errorMessage ?? "Provider request failed");
      } else {
        conv.current.terminalError = null;
      }
      break;
    }
    case "agent_end": {
      if (conv.current) conv.current.usage = extractUsage(event.messages) ?? conv.current.usage;
      break;
    }
    case "compaction_start":
      emit(conv, "compaction_start", { reason: event.reason, thread_id: conv.id });
      break;
    case "compaction_end": {
      const latestCompaction = !event.aborted && !event.errorMessage
        ? [...(conv.session?.sessionManager?.getBranch?.() ?? [])].reverse().find((entry) => entry.type === "compaction") : null;
      emit(conv, "compaction_end", {
        reason: event.reason, aborted: Boolean(event.aborted), will_retry: Boolean(event.willRetry),
        error: event.errorMessage ?? null, compaction_entry_id: latestCompaction?.id ?? null,
        result: event.result ?? null, thread_id: conv.id,
      });
      break;
    }
    case "agent_settled": {
      if (!conv.current) break;
      const { usage, messageId, userMappings = [], terminalError, assistantUtterances = [] } = conv.current;
      for (const utterance of assistantUtterances) {
        emit(conv, 'item_completed', {
          item: {
            type: 'message', id: utterance.piMessageId, pi_message_id: utterance.piMessageId,
            utterance_id: utterance.utteranceId ?? utterance.piMessageId,
            utterance_ids: utterance.utteranceIds ?? [],
            utterance_kind: 'participant', message_kind: 'assistant_outward', role: 'assistant',
            content: [{ type: 'text', text: utterance.text }],
            execution_origins: utterance.executionOrigins ?? [],
            attachment_refs: utterance.attachmentRefs ?? [],
            ...continuationWire(utterance.continuation),
          },
        });
      }
      const lastPiMessageId = assistantUtterances.at(-1)?.piMessageId ?? null;
      if (terminalError) {
        emit(conv, "turn_error", {
          error: terminalError, category: classifyProviderError(terminalError),
          turn_id: userMappings.length === 1 ? userMappings[0].turn_id : (messageId ?? null),
          pi_message_id: lastPiMessageId, thread_id: conv.id,
        });
        conv.current = null;
        break;
      }
      if (usage) emit(conv, 'turn_usage', { usage });
      emit(conv, 'turn_completed', {
        message_id: messageId ?? null,
        pi_message_id: lastPiMessageId,
        user_pi_message_id: userMappings.length === 1 ? userMappings[0].user_pi_message_id : null,
        user_mappings: userMappings,
        thread_id: conv.id,
      });
      conv.current = null;
      break;
    }
  }
}
