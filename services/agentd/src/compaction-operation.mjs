export class ConversationConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConversationConflictError';
    this.code = code;
    this.details = details;
  }
}

function compactionResultFromEntry(entry) {
  return {
    summary: entry.summary,
    firstKeptEntryId: entry.firstKeptEntryId,
    tokensBefore: entry.tokensBefore,
    ...(entry.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: entry.estimatedTokensAfter } : {}),
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
    ...(entry.details !== undefined ? { details: entry.details } : {}),
  };
}

function completedCompactionForExpectedLeaf(manager, expectedLeafId) {
  return manager.getBranch().find((entry) => entry.type === 'compaction' && entry.parentId === expectedLeafId) ?? null;
}

function assertIdle(conv) {
  const session = conv.session;
  const pendingMessageCount = Number(session.pendingMessageCount ?? 0);
  const hasQueuedMessages = Boolean(session.agent?.hasQueuedMessages?.());
  if (conv.current || session.isStreaming || session.isCompacting || pendingMessageCount > 0 || hasQueuedMessages || conv.compactionOperation) {
    throw new ConversationConflictError('conversation_busy', 'Conversation must be idle before compaction', {
      active_turn: Boolean(conv.current),
      is_streaming: Boolean(session.isStreaming),
      is_compacting: Boolean(session.isCompacting || conv.compactionOperation),
      pending_message_count: Number.isFinite(pendingMessageCount) ? pendingMessageCount : null,
      has_queued_messages: hasQueuedMessages,
    });
  }
}

/**
 * Perform one optimistic, retry-safe manual compaction.
 *
 * A response lost after Pi appends the compaction is recognized from the canonical
 * branch: a compaction entry whose parent is expected_leaf_id proves that request's
 * state transition already happened. No agentd-private marker is written to JSONL.
 */
export async function compactConversation(conv, input) {
  const operationId = typeof input?.operation_id === 'string' ? input.operation_id.trim() : '';
  const expectedLeafId = typeof input?.expected_leaf_id === 'string' ? input.expected_leaf_id.trim() : '';
  if (!operationId) throw new TypeError('operation_id is required');
  if (!expectedLeafId) throw new TypeError('expected_leaf_id is required');
  if (input.custom_instructions !== undefined && typeof input.custom_instructions !== 'string') {
    throw new TypeError('custom_instructions must be a string');
  }

  const manager = conv.session.sessionManager;
  const completed = completedCompactionForExpectedLeaf(manager, expectedLeafId);
  if (completed) {
    return {
      operation_id: operationId,
      compaction_entry_id: completed.id,
      already_completed: true,
      result: compactionResultFromEntry(completed),
    };
  }

  assertIdle(conv);
  const actualLeafId = manager.getLeafId?.() ?? manager.getLeafEntry?.()?.id ?? null;
  if (actualLeafId !== expectedLeafId) {
    throw new ConversationConflictError('stale_leaf', 'Conversation leaf does not match expected_leaf_id', {
      expected_leaf_id: expectedLeafId,
      actual_leaf_id: actualLeafId,
    });
  }

  const operation = (async () => {
    const result = await conv.session.compact(input.custom_instructions);
    const entry = completedCompactionForExpectedLeaf(manager, expectedLeafId);
    if (!entry) throw new Error('Pi compaction completed without appending a compaction entry');
    return {
      operation_id: operationId,
      compaction_entry_id: entry.id,
      already_completed: false,
      result,
    };
  })();
  conv.compactionOperation = operation;
  try {
    return await operation;
  } finally {
    if (conv.compactionOperation === operation) conv.compactionOperation = null;
  }
}
