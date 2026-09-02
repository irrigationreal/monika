import { setTimeout as delay } from 'node:timers/promises';

import type { UtteranceOrigin } from '@irrigationreal/codex-forum-core';

export interface EchsClientOptions {
  baseUrl: string;
  apiToken?: string | null;
}

export class EchsTransportError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    readonly status: number | null = null,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'EchsTransportError';
  }
}

export function isEchsTransportError(error: unknown): error is EchsTransportError {
  return error instanceof EchsTransportError;
}

export class EchsDispatchNotAcceptedError extends Error {
  readonly retryable: boolean;
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
    readonly safeRetry = false
  ) {
    super(message);
    this.name = 'EchsDispatchNotAcceptedError';
    this.retryable = safeRetry;
  }
}

export function isEchsDispatchNotAcceptedError(error: unknown): error is EchsDispatchNotAcceptedError {
  return error instanceof EchsDispatchNotAcceptedError;
}

export interface EchsThreadState {
  thread_id: string;
  state?: {
    status?: string;
    current_message_id?: string | null;
    [key: string]: unknown;
  };
}

export interface EchsConversationRecord {
  conversation_id: string;
  active_thread_id?: string | null;
  activity?: 'active' | 'idle';
  model?: string | null;
  reasoning?: string | null;
  auto_compact?: boolean;
  cwd?: string | null;
  instructions?: string | null;
  tools_json?: string | null;
  coordination_mode?: string | null;
  created_at_ms?: number | null;
  last_activity_at_ms?: number | null;
  session_id?: string | null;
  session_path?: string | null;
}

export interface EchsConversationState {
  conversation: EchsConversationRecord;
}

export interface EchsCancellationResult {
  ok: boolean;
  operation_id: string;
  generation: number;
  state: 'stopping' | 'stopped' | 'uncertain';
  targets: number;
  unresolved_count: number;
  effects_unknown_count: number;
  error_count: number;
  message: string;
}

export interface EchsSubagentRun {
  run_id: string;
  run_key?: string;
  state: string;
  execution_state: 'active' | 'terminal' | 'interrupted' | 'uncertain' | 'quarantined';
  outcome_state?: string | null;
  effects_state?: 'none' | 'confirmed' | 'unknown' | null;
  delivery_state?: string | null;
  execution_target?: { kind: 'local' } | { kind: 'ssh'; name: string } | null;
  blocking: boolean;
  reason?: string | null;
  parent_session_id?: string | null;
  parent_session_path?: string | null;
  async_dir?: string | null;
  started_at?: number | string | null;
  updated_at?: number | string | null;
  origin?: { topicId?: string | null; postId?: string | null; turnId?: string | null } | null;
}

export interface EchsSubagentRetention {
  ok: boolean;
  digest: string | null;
  generatedAt: number | null;
  retentionMs: number;
  counts: { protected: number; waiting: number; eligible: number; compacted: number; error: number };
  bytes: { tracked_removable: number; eligible: number };
  omitted: number;
  running: boolean;
  last_run_at?: number | null;
  last_error?: string | null;
}

export interface EchsSubagentWorkload {
  ok: boolean;
  active_count: number;
  uncertain_count: number;
  effects_unknown_count?: number;
  runs: EchsSubagentRun[];
  omitted: number;
  blocker_count?: number;
  omitted_blocker_count?: number;
}

export interface EchsThreadHistory {
  thread_id: string;
  items?: unknown[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface EchsConversationHistory {
  conversation_id: string;
  items?: unknown[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface EchsContinuationMetadata {
  source_kind?: string | null;
  sourceKind?: string | null;
  run_id?: string | null;
  runId?: string | null;
  origin_turn_id?: string | null;
  originTurnId?: string | null;
  origin_post_id?: string | null;
  originPostId?: string | null;
  origin_topic_id?: string | null;
  originTopicId?: string | null;
  pi_message_id?: string | null;
  piMessageId?: string | null;
}

export interface EchsEvent<T = unknown> {
  event: string;
  data: T;
  id?: string | null;
}

function normalizeWorkdir(config: Record<string, unknown>): Record<string, unknown> {
  if (!config || typeof config !== 'object') return config;
  if ('workdir' in config || 'cwd' in config) {
    const cwd = (config as Record<string, unknown>)['cwd'] ?? (config as Record<string, unknown>)['workdir'];
    return { ...config, cwd };
  }
  return config;
}

export class EchsClient {
  private readonly baseUrl: string;
  private readonly apiToken: string | null;

  constructor(options: EchsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiToken = options.apiToken ?? null;
  }

  async getSubagentWorkload(): Promise<EchsSubagentWorkload> {
    return (await this.request('/v1/admin/subagents')) as EchsSubagentWorkload;
  }

  async getSubagentRetention(): Promise<EchsSubagentRetention> {
    return (await this.request('/v1/admin/subagents/retention')) as EchsSubagentRetention;
  }

  async getQuiescence(): Promise<Record<string, unknown>> {
    return (await this.request('/v1/admin/quiescence')) as Record<string, unknown>;
  }

  async getAnalytics(input: {
    from: string;
    to: string;
    bucket: 'day' | 'week';
    piSessionIds: string[];
    minToolSamples?: number;
  }): Promise<Record<string, unknown>> {
    return (await this.request('/v1/admin/analytics/query', {
      method: 'POST',
      body: {
        from: input.from,
        to: input.to,
        bucket: input.bucket,
        pi_session_ids: input.piSessionIds,
        min_tool_samples: input.minToolSamples ?? 5,
      },
    })) as Record<string, unknown>;
  }

  async createThread(opts: {
    cwd?: string | null;
    workdir?: string | null;
    model?: string | null;
    reasoning?: string | null;
    instructions?: string | null;
    tools?: unknown[] | null;
    coordinationMode?: string | null;
  }): Promise<string> {
    const payload: Record<string, unknown> = {};
    const cwd = opts.cwd ?? opts.workdir;
    if (cwd) payload['cwd'] = cwd;
    if (opts.model) payload['model'] = opts.model;
    if (opts.reasoning) payload['reasoning'] = opts.reasoning;
    if (opts.instructions) payload['instructions'] = opts.instructions;
    if (opts.tools) payload['tools'] = opts.tools;
    if (opts.coordinationMode) payload['coordination_mode'] = opts.coordinationMode;
    const result = (await this.request('/v1/threads', { method: 'POST', body: payload })) as { thread_id: string };
    return result.thread_id;
  }

  async openConversation(opts: {
    piSessionId?: string | null;
    piSessionPath?: string | null;
    cwd?: string | null;
    autoCompact?: boolean;
  }): Promise<EchsConversationRecord> {
    const payload: Record<string, unknown> = {};
    if (opts.piSessionId) payload['pi_session_id'] = opts.piSessionId;
    if (opts.piSessionPath) payload['pi_session_path'] = opts.piSessionPath;
    if (opts.cwd) payload['cwd'] = opts.cwd;
    if (opts.autoCompact !== undefined) payload['auto_compact'] = opts.autoCompact;
    const result = (await this.request('/v1/conversations/open', {
      method: 'POST',
      body: payload,
      timeoutMs: 30_000,
    })) as {
      conversation?: EchsConversationRecord;
    };
    if (!result?.conversation?.conversation_id) throw new Error('ECHS openConversation did not return conversation_id');
    return result.conversation;
  }

  async closeConversation(conversationId: string): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}/close`, { method: 'POST' });
  }

  async compactConversation(
    conversationId: string,
    opts: {
      operationId: string;
      expectedLeafId: string;
      customInstructions?: string | null;
    }
  ): Promise<Record<string, unknown>> {
    return (await this.request(`/v1/conversations/${conversationId}/compact`, {
      method: 'POST',
      body: {
        operation_id: opts.operationId,
        expected_leaf_id: opts.expectedLeafId,
        ...(opts.customInstructions ? { custom_instructions: opts.customInstructions } : {}),
      },
      timeoutMs: 10 * 60_000,
    })) as Record<string, unknown>;
  }
  async forkConversation(
    conversationId: string,
    opts: { operationId: string; expectedLeafId: string; boundaryEntryId: string }
  ): Promise<{
    child_session_id: string;
    child_session_path: string;
    inherited_generation: number;
    active_entry_ids: string[];
  }> {
    return (await this.request(`/v1/conversations/${conversationId}/fork`, {
      method: 'POST',
      body: {
        operation_id: opts.operationId,
        expected_leaf_id: opts.expectedLeafId,
        boundary_entry_id: opts.boundaryEntryId,
      },
      timeoutMs: 10 * 60_000,
    })) as {
      child_session_id: string;
      child_session_path: string;
      inherited_generation: number;
      active_entry_ids: string[];
    };
  }

  async acknowledgeForumFork(operationId: string, childSessionId: string): Promise<void> {
    await this.request(`/v1/forum-forks/${encodeURIComponent(operationId)}/ack`, {
      method: 'POST',
      body: { child_session_id: childSessionId },
    });
  }

  async createConversation(opts: {
    cwd?: string | null;
    workdir?: string | null;
    model?: string | null;
    reasoning?: string | null;
    instructions?: string | null;
    tools?: unknown[] | null;
    coordinationMode?: string | null;
    autoCompact?: boolean;
    conversationId?: string | null;
    parentPiSessionId?: string | null;
    parentPiSessionPath?: string | null;
    lineageKind?: string | null;
    lineageSource?: string | null;
    lineageMetadata?: unknown;
    creationId?: string;
  }): Promise<string> {
    const payload: Record<string, unknown> = opts.creationId
      ? { durable_session: true, creation_id: opts.creationId }
      : {};
    const cwd = opts.cwd ?? opts.workdir;
    if (cwd) payload['cwd'] = cwd;
    if (opts.model) payload['model'] = opts.model;
    if (opts.reasoning) payload['reasoning'] = opts.reasoning;
    if (opts.instructions) payload['instructions'] = opts.instructions;
    if (opts.tools) payload['tools'] = opts.tools;
    if (opts.coordinationMode) payload['coordination_mode'] = opts.coordinationMode;
    if (opts.autoCompact !== undefined) payload['auto_compact'] = opts.autoCompact;
    if (opts.conversationId) payload['conversation_id'] = opts.conversationId;
    if (opts.parentPiSessionId) payload['parent_pi_session_id'] = opts.parentPiSessionId;
    if (opts.parentPiSessionPath) payload['parent_pi_session_path'] = opts.parentPiSessionPath;
    if (opts.lineageKind) payload['lineage_kind'] = opts.lineageKind;
    if (opts.lineageSource) payload['lineage_source'] = opts.lineageSource;
    if (opts.lineageMetadata !== undefined) payload['lineage_metadata'] = opts.lineageMetadata;
    const result = (await this.request('/v1/conversations', { method: 'POST', body: payload })) as {
      conversation?: EchsConversationRecord;
    };
    const conversationId = result?.conversation?.conversation_id;
    if (!conversationId) {
      throw new Error('ECHS createConversation did not return conversation_id');
    }
    return conversationId;
  }

  async createConversationRecord(opts: {
    cwd?: string | null;
    workdir?: string | null;
    model?: string | null;
    reasoning?: string | null;
    instructions?: string | null;
    autoCompact?: boolean;
    parentPiSessionId?: string | null;
    parentPiSessionPath?: string | null;
    lineageKind?: string | null;
    lineageSource?: string | null;
    lineageMetadata?: unknown;
    creationId?: string;
  }): Promise<EchsConversationRecord> {
    const conversationId = await this.createConversation(opts);
    const conversation = await this.getConversation(conversationId);
    if (!conversation) throw new Error('ECHS createConversationRecord could not load created conversation');
    return conversation;
  }

  async generateHandoffDraft(
    conversationId: string,
    opts: {
      goal: string;
      model?: string | null;
      reasoning?: string | null;
      systemPrompt?: string | null;
    }
  ): Promise<{ source?: unknown; goal: string; draft: string; model?: string | null; reasoning?: string | null }> {
    return (await this.request(`/v1/conversations/${conversationId}/handoff/draft`, {
      method: 'POST',
      body: {
        goal: opts.goal,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      },
    })) as { source?: unknown; goal: string; draft: string; model?: string | null; reasoning?: string | null };
  }

  async resolveArtifact(opts: {
    path: string;
    filename?: string | null;
    mimeType?: string | null;
  }): Promise<{ filename: string; mimeType: string; sizeBytes: number; sha256: string; dataBase64: string }> {
    return (await this.request('/v1/artifacts/resolve', {
      method: 'POST',
      body: opts as Record<string, unknown>,
    })) as { filename: string; mimeType: string; sizeBytes: number; sha256: string; dataBase64: string };
  }

  async configureThread(threadId: string, config: Record<string, unknown>): Promise<void> {
    await this.request(`/v1/threads/${threadId}`, { method: 'PATCH', body: { config: normalizeWorkdir(config) } });
  }

  async configureConversation(conversationId: string, config: Record<string, unknown>): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}`, {
      method: 'PATCH',
      body: { config: normalizeWorkdir(config) },
    });
  }

  async enqueueMessage(
    threadId: string,
    content: string | unknown[],
    opts?: {
      mode?: 'queue' | 'steer';
      messageId?: string | null;
      configure?: Record<string, unknown>;
      attachments?: unknown[];
    }
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      mode: opts?.mode ?? 'queue',
      content,
    };
    if (opts?.messageId) payload['message_id'] = opts.messageId;
    if (opts?.configure) payload['configure'] = opts.configure;
    if (opts?.attachments) payload['attachments'] = opts.attachments;
    const result = (await this.request(`/v1/threads/${threadId}/messages`, { method: 'POST', body: payload })) as {
      message_id: string;
    };
    return result.message_id;
  }

  async enqueueConversationMessage(
    conversationId: string,
    content: string | unknown[],
    opts?: {
      mode?: 'queue' | 'steer';
      messageId?: string | null;
      dispatchId?: string;
      generation?: number;
      configure?: Record<string, unknown>;
      attachments?: unknown[];
      provenance?: {
        origin: 'forum';
        topicId: string;
        postId: string;
        version?: 2;
        utteranceIds?: string[];
        executionOrigins?: UtteranceOrigin[];
      };
    }
  ): Promise<{ messageId: string; threadId?: string | null; compacted?: boolean; deduplicated?: boolean }> {
    const payload: Record<string, unknown> = {
      mode: opts?.mode ?? 'queue',
      content,
    };
    if (opts?.messageId) payload['message_id'] = opts.messageId;
    if (opts?.dispatchId) payload['dispatch_id'] = opts.dispatchId;
    if (opts?.generation !== undefined) payload['generation'] = opts.generation;
    if (opts?.configure) payload['configure'] = opts.configure;
    if (opts?.attachments) payload['attachments'] = opts.attachments;
    if (opts?.provenance) payload['provenance'] = opts.provenance;
    const result = (await this.request(`/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: payload,
      timeoutMs: 30_000,
    })) as { message_id: string; thread_id?: string | null; compacted?: boolean; deduplicated?: boolean };
    const out: { messageId: string; threadId?: string | null; compacted?: boolean; deduplicated?: boolean } = {
      messageId: result.message_id,
      threadId: result.thread_id ?? null,
    };
    if (result.compacted !== undefined) out.compacted = result.compacted;
    if (result.deduplicated !== undefined) out.deduplicated = result.deduplicated;
    return out;
  }

  async interruptConversation(
    conversationId: string,
    generation?: number,
    operationId?: string
  ): Promise<EchsCancellationResult> {
    return this.requestCancellation(`/v1/conversations/${conversationId}/interrupt`, {
      ...(generation === undefined ? {} : { generation }),
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    });
  }

  async cancelPiSession(
    sessionId: string,
    input: { operationId: string; generation: number }
  ): Promise<EchsCancellationResult> {
    return this.requestCancellation(`/v1/pi/sessions/${encodeURIComponent(sessionId)}/cancellation`, {
      operation_id: input.operationId,
      generation: input.generation,
    });
  }

  async reconcilePiSessionCancellation(sessionId: string): Promise<EchsCancellationResult | null> {
    try {
      return (await this.request(`/v1/pi/sessions/${encodeURIComponent(sessionId)}/cancellation`, {
        timeoutMs: 15_000,
      })) as EchsCancellationResult;
    } catch (error) {
      if ((error as Error & { status?: number }).status === 404) return null;
      throw error;
    }
  }

  private async requestCancellation(path: string, body: Record<string, unknown>): Promise<EchsCancellationResult> {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return (await this.request(path, { method: 'POST', body, timeoutMs: 10_000 })) as EchsCancellationResult;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError;
  }

  async pauseConversation(conversationId: string): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}/pause`, { method: 'POST' });
  }

  async resumeConversation(conversationId: string): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}/resume`, { method: 'POST' });
  }

  async interruptThread(threadId: string): Promise<void> {
    await this.request(`/v1/threads/${threadId}/interrupt`, { method: 'POST' });
  }

  async pauseThread(threadId: string): Promise<void> {
    await this.request(`/v1/threads/${threadId}/pause`, { method: 'POST' });
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request(`/v1/threads/${threadId}/resume`, { method: 'POST' });
  }

  async getThread(threadId: string): Promise<EchsThreadState | null> {
    try {
      return (await this.request(`/v1/threads/${threadId}`)) as EchsThreadState;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  async getConversation(conversationId: string): Promise<EchsConversationRecord | null> {
    try {
      const result = (await this.request(`/v1/conversations/${conversationId}`)) as {
        conversation?: EchsConversationRecord;
      };
      return result?.conversation ?? null;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  async getThreadHistory(threadId: string): Promise<EchsThreadHistory | null> {
    try {
      return (await this.request(`/v1/threads/${threadId}/history?redact=1`)) as EchsThreadHistory;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  async getConversationHistory(conversationId: string): Promise<EchsConversationHistory | null> {
    try {
      return (await this.request(`/v1/conversations/${conversationId}/history?redact=1`)) as EchsConversationHistory;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  async checkHealth(): Promise<{ ok: boolean; status: string; queue_depth?: number; active_threads?: number } | null> {
    try {
      const data = (await this.request('/healthz', { timeoutMs: 2_000 })) as Record<string, unknown>;
      const isOk = data['ok'] === true;
      const result: { ok: boolean; status: string; queue_depth?: number; active_threads?: number } = {
        ok: isOk,
        status: (data['status'] as string) ?? (isOk ? 'healthy' : 'degraded'),
      };
      if (typeof data['queue_depth'] === 'number') result.queue_depth = data['queue_depth'];
      if (typeof data['active_threads'] === 'number') result.active_threads = data['active_threads'];
      return result;
    } catch {
      return null;
    }
  }

  async listPiSessions(): Promise<{ sessions: Array<Record<string, unknown>> } | null> {
    try {
      return (await this.request('/v1/pi/sessions')) as { sessions: Array<Record<string, unknown>> };
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      return null;
    }
  }

  async exportPiSession(sessionId: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.request(`/v1/pi/sessions/${encodeURIComponent(sessionId)}/export`)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }
  async getPiSessionContext(sessionId: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.request(`/v1/pi/sessions/${encodeURIComponent(sessionId)}/context`)) as Record<
        string,
        unknown
      >;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      return null;
    }
  }

  async getConversationContext(conversationId: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.request(`/v1/conversations/${conversationId}/context`)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      return null;
    }
  }
  async listModels(): Promise<unknown | null> {
    try {
      return await this.request('/v1/models');
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        return null;
      }
      return null;
    }
  }

  subscribeConversation(
    conversationId: string,
    onEvent: (event: EchsEvent) => void,
    opts?: { lastEventId?: string | null; retryDelayMs?: number }
  ): { close: () => void; ready: Promise<void> } {
    return this.subscribeStream(`/v1/conversations/${conversationId}/events`, onEvent, opts);
  }

  subscribe(
    threadId: string,
    onEvent: (event: EchsEvent) => void,
    opts?: { lastEventId?: string | null; retryDelayMs?: number }
  ): { close: () => void; ready: Promise<void> } {
    return this.subscribeStream(`/v1/threads/${threadId}/events`, onEvent, opts);
  }

  private async request(
    path: string,
    opts?: { method?: string; body?: Record<string, unknown>; timeoutMs?: number }
  ): Promise<unknown> {
    const method = opts?.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiToken) headers['Authorization'] = `Bearer ${this.apiToken}`;
    if (opts?.body) headers['Content-Type'] = 'application/json';
    const fetchInit: RequestInit = { method, headers };
    if (opts?.body) fetchInit.body = JSON.stringify(opts.body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30_000);
    fetchInit.signal = controller.signal;
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`, fetchInit);
      text = await response.text();
    } catch (error) {
      throw new EchsTransportError('Agent runtime transport is unavailable', null, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
    const data = text ? safeJsonParse(text) : null;
    if (!response.ok) {
      const message = `ECHS ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`;
      if (
        data &&
        typeof data === 'object' &&
        (data as Record<string, unknown>)['dispatch_acceptance'] === 'not_accepted'
      ) {
        throw new EchsDispatchNotAcceptedError(
          message,
          response.status,
          data,
          (data as Record<string, unknown>)['dispatch_retry'] === 'safe'
        );
      }
      if (response.status >= 500) throw new EchsTransportError(message, response.status);
      const error = new Error(message) as Error & { status?: number; details?: unknown };
      error.status = response.status;
      error.details = data;
      throw error;
    }
    return data;
  }

  private subscribeStream(
    path: string,
    onEvent: (event: EchsEvent) => void,
    opts?: { lastEventId?: string | null; retryDelayMs?: number }
  ): { close: () => void; ready: Promise<void> } {
    const controller = new AbortController();
    const retryDelay = opts?.retryDelayMs ?? 1000;
    let readyResolve: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    let readySettled = false;
    const markReady = () => {
      if (!readySettled) {
        readySettled = true;
        readyResolve?.();
      }
    };

    const handleEvent = (event: EchsEvent) => {
      markReady();
      onEvent(event);
    };

    const connect = async () => {
      let currentDelay = retryDelay;
      const maxDelay = 30_000;
      while (!controller.signal.aborted) {
        try {
          const headers: Record<string, string> = { Accept: 'text/event-stream' };
          if (this.apiToken) headers['Authorization'] = `Bearer ${this.apiToken}`;
          if (opts?.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
          const response = await fetch(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
            headers,
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`ECHS SSE error: ${response.status}`);
          }
          await this.consumeStream(response.body, handleEvent, controller.signal);
          currentDelay = retryDelay; // reset on successful stream consumption
        } catch (err) {
          if (controller.signal.aborted) break;
          const jitter = Math.random() * 1000 - 500;
          await delay(Math.max(100, Math.min(currentDelay + jitter, maxDelay)));
          currentDelay = Math.min(currentDelay * 2, maxDelay);
        }
      }
    };

    void connect();

    return {
      close: () => controller.abort(),
      ready,
    };
  }

  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: EchsEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let eventName: string | null = null;
    let eventId: string | null = null;
    let dataLines: string[] = [];

    const flush = () => {
      if (dataLines.length === 0) {
        eventName = null;
        eventId = null;
        return;
      }
      const dataText = dataLines.join('\n');
      const parsed = safeJsonParse(dataText);
      onEvent({ event: eventName ?? 'message', data: parsed, id: eventId });
      eventName = null;
      eventId = null;
      dataLines = [];
    };

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        flush();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line) {
          flush();
          continue;
        }
        if (line.startsWith(':')) {
          // Emit keepalive/comment lines as synthetic events so callers can
          // track stream liveness (ECHS sends `: keepalive` every 15s).
          onEvent({ event: '__keepalive', data: null, id: null });
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim();
          continue;
        }
        if (line.startsWith('id:')) {
          eventId = line.slice('id:'.length).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim());
        }
      }
    }
  }
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
