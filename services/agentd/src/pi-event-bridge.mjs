import { randomUUID } from 'node:crypto';

function extractTextFromMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

function extractLastAssistantText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return extractTextFromMessage(messages[i]);
  }
  return '';
}

function extractUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.usage;
    if (usage && typeof usage === 'object') {
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
  const text = String(error ?? '').toLowerCase();
  if (/context (?:length|window)|maximum context|context limit|too many tokens|prompt (?:is )?too long|token limit/.test(text)) {
    return 'context_overflow';
  }
  if (/\brate[ -]?limit|\btoo many requests\b|\b429\b|quota exceeded/.test(text)) return 'rate_limit';
  if (/\bauthentication\b|\bunauthorized\b|\bforbidden\b|invalid (?:api )?key|api key.*(?:invalid|missing)|\b40[13]\b/.test(text)) {
    return 'authentication';
  }
  if (/\bprovider\b|\bupstream\b|service unavailable|temporarily unavailable|overloaded|internal server error|\b50[0234]\b/.test(text)) {
    return 'provider';
  }
  return 'unknown';
}

/**
 * Translate Pi SDK lifecycle events into agentd's stable forum-facing event
 * protocol. agent_end is not a durable completion boundary: Pi may still retry,
 * compact and retry, or drain a queued continuation. agent_settled is the first
 * point at which downstream consumers may commit the final response.
 */
export function handlePiEvent(conv, event, emit, createId = randomUUID) {
  switch (event.type) {
    case 'agent_start': {
      // Automatic retries and continuations can start another low-level agent run
      // for the same forum response. Keep its stable id and accumulated output.
      if (!conv.current) {
        const messageId = createId();
        conv.current = {
          messageId,
          text: '',
          toolCalls: new Map(),
          startedAt: Date.now(),
          completionText: '',
          usage: null,
          terminalError: null,
        };
        emit(conv, 'turn_started', { message_id: messageId, thread_id: conv.id });
      }
      break;
    }
    case 'message_update': {
      const assistantEvent = event.assistantMessageEvent ?? event;
      if (assistantEvent.type === 'text_delta' && assistantEvent.delta) {
        if (conv.current) conv.current.text += assistantEvent.delta;
        emit(conv, 'turn_delta', { content: assistantEvent.delta });
      } else if (assistantEvent.type === 'thinking_delta' && assistantEvent.delta) {
        emit(conv, 'reasoning_delta', { delta: assistantEvent.delta });
      }
      break;
    }
    case 'tool_execution_start': {
      const callId = event.toolCallId ?? event.id ?? createId();
      if (conv.current) conv.current.toolCalls.set(callId, event.toolName ?? 'tool');
      emit(conv, 'item_started', {
        item: {
          type: 'function_call',
          id: callId,
          call_id: callId,
          name: event.toolName ?? 'tool',
          arguments: event.args ?? event.input ?? event.arguments ?? null,
        },
      });
      break;
    }
    case 'tool_execution_update': {
      const callId = event.toolCallId ?? event.id ?? createId();
      emit(conv, 'tool_updated', {
        call_id: callId,
        tool_name: event.toolName ?? 'tool',
        args: event.args ?? null,
        partial_result: event.partialResult ?? null,
      });
      break;
    }
    case 'tool_execution_end': {
      const callId = event.toolCallId ?? event.id ?? createId();
      emit(conv, 'tool_completed', {
        call_id: callId,
        tool_name: event.toolName ?? 'tool',
        args: event.args ?? null,
        result: event.result ?? event.output ?? event.error ?? null,
        is_error: Boolean(event.isError),
      });
      break;
    }
    case 'message_end': {
      if (!conv.current || event.message?.role !== 'assistant') break;
      if (event.message.stopReason === 'error') {
        conv.current.terminalError = String(event.message.errorMessage ?? 'Provider request failed');
      } else {
        // A later successful assistant response means Pi recovered the prior
        // provider failure through retry/compaction. Only the terminal attempt
        // is user-visible as an error.
        conv.current.terminalError = null;
      }
      break;
    }
    case 'agent_end': {
      if (conv.current) {
        conv.current.completionText = conv.current.text || extractLastAssistantText(event.messages);
        conv.current.usage = extractUsage(event.messages) ?? conv.current.usage;
      }
      break;
    }
    case 'compaction_start':
      emit(conv, 'compaction_start', { reason: event.reason, thread_id: conv.id });
      break;
    case 'compaction_end':
      emit(conv, 'compaction_end', {
        reason: event.reason,
        aborted: Boolean(event.aborted),
        will_retry: Boolean(event.willRetry),
        error: event.errorMessage ?? null,
        result: event.result ?? null,
        thread_id: conv.id,
      });
      break;
    case 'agent_settled': {
      if (!conv.current) break;
      const {
        completionText, text, usage, messageId, piMessageId, userMappings = [], terminalError,
        sourceKind = null, subagentRunId = null, subagentRunIds = null, subagentOrigins = null, origin = null,
      } = conv.current;
      if (terminalError) {
        emit(conv, 'turn_error', {
          error: terminalError,
          category: classifyProviderError(terminalError),
          turn_id: userMappings.length === 1 ? userMappings[0].turn_id : (messageId ?? null),
          pi_message_id: piMessageId ?? null,
          thread_id: conv.id,
        });
        conv.current = null;
        break;
      }
      const finalText = completionText || text;
      if (finalText && finalText.trim()) {
        emit(conv, 'item_completed', {
          item: {
            type: 'message',
            id: piMessageId ?? null,
            role: 'assistant',
            content: [{ type: 'text', text: finalText }],
            ...(sourceKind ? {
              source_kind: sourceKind,
              subagent_run_id: subagentRunId,
              subagent_run_ids: subagentRunIds ?? (subagentRunId ? [subagentRunId] : []),
              subagent_origins: subagentOrigins ?? [],
              origin_turn_id: origin?.turnId ?? null,
              origin_topic_id: origin?.topicId ?? null,
              origin_post_id: origin?.postId ?? null,
            } : {}),
          },
        });
      }
      if (usage) emit(conv, 'turn_usage', { usage });
      emit(conv, 'turn_completed', {
        message_id: messageId ?? null,
        pi_message_id: piMessageId ?? null,
        user_pi_message_id: userMappings.length === 1 ? userMappings[0].user_pi_message_id : null,
        user_mappings: userMappings,
        ...(sourceKind ? {
          source_kind: sourceKind,
          subagent_run_id: subagentRunId,
          subagent_run_ids: subagentRunIds ?? (subagentRunId ? [subagentRunId] : []),
          subagent_origins: subagentOrigins ?? [],
          origin_turn_id: origin?.turnId ?? null,
          origin_topic_id: origin?.topicId ?? null,
          origin_post_id: origin?.postId ?? null,
        } : {}),
        thread_id: conv.id,
      });
      conv.current = null;
      break;
    }
  }
}
