import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';
import { EchsClient, type EchsClientOptions, type EchsEvent } from '../echsClient';
import { truncateText } from '../utils/automation';

export type AutoRunDirectorWorker = 'echs';

export interface AutoRunDirectorConfig {
  workDir: string;
  apiBaseUrl?: string | null;
  defaultWorker: AutoRunDirectorWorker;
  defaultModel?: string | null;
  defaultReasoningEffort?: string | null;
  maxPostChars?: number;
  /**
   * When true, automatically run the Director after every assistant reply
   * (default: false). This is intentionally opt-in because it can be noisy.
   */
  autoStartOnAssistantReply?: boolean;
  echs?: EchsClientOptions | null;
}

export type AutoRunDirectorRobotDispatch = (opts: {
  topicId: string;
  body: string;
  parentPostId: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}) => void | Promise<void>;

function normalizeAutoRunPreference(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'default') return null;
  return trimmed;
}

type DirectorDecision = {
  action: 'reply' | 'stop' | 'idle';
  reply?: string | null;
  notes?: string | null;
  nextModel?: string | null;
  nextReasoningEffort?: string | null;
  nextWorker?: AutoRunDirectorWorker | null;
};

const nowIso = (): string => new Date().toISOString();

function formatBytes(sizeBytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, sizeBytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function extractJsonPayload(text: string): DirectorDecision {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Director returned empty output');
  }
  try {
    return JSON.parse(trimmed) as DirectorDecision;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start == -1 || end == -1 || end <= start) {
      throw new Error('Director output was not valid JSON');
    }
    const slice = trimmed.slice(start, end + 1);
    return JSON.parse(slice) as DirectorDecision;
  }
}

export class AutoRunDirector {
  private readonly runningTopics = new Set<string>();
  private echsClient: EchsClient | null = null;
  private robotDispatch: AutoRunDirectorRobotDispatch | null = null;

  constructor(
    private readonly store: ForumStore,
    private readonly bus: StreamBusInterface,
    private readonly config: AutoRunDirectorConfig
  ) {}

  setRobotDispatcher(dispatch: AutoRunDirectorRobotDispatch | null): void {
    this.robotDispatch = dispatch;
  }

  async start(): Promise<void> {
    // ECHS-only: no background process to start.
  }

  async stop(): Promise<void> {
    // EchsClient is stateless; dropping the reference is sufficient.
    this.echsClient = null;
  }

  async handleAssistantReply(opts: { topicId: string; postId: string; text: string }): Promise<void> {
    // Director posts will trigger the robot separately; do not re-run the Director.
    const post = this.store.getPost(opts.postId);
    if (post) {
      const author = this.store.getIdentity(post.author_id);
      const name = author?.display_name?.toLowerCase() ?? '';
      if (name === 'director' || name === 'the director') {
        return;
      }
    }

    if (!this.config.autoStartOnAssistantReply) {
      return;
    }

    await this.runDirector({ topicId: opts.topicId, triggerPostId: opts.postId });
  }

  async runManual(opts: { topicId: string; steerMessage?: string | null }): Promise<{ ok: boolean; message: string }> {
    const autoRun = this.store.getTopicAutoRun(opts.topicId);
    if (!autoRun || !autoRun.enabled) {
      return { ok: false, message: 'Auto-run is disabled for this topic.' };
    }
    if (opts.steerMessage !== undefined) {
      this.store.upsertTopicAutoRun({ topicId: opts.topicId, steerMessage: opts.steerMessage ?? null });
    }
    await this.runDirector({ topicId: opts.topicId, triggerPostId: null, force: true });
    return { ok: true, message: 'Director run started.' };
  }

  private async runDirector(opts: { topicId: string; triggerPostId: string | null; force?: boolean }): Promise<void> {
    if (this.store.hasCompactionFence(opts.topicId)) return;
    const autoRun = this.store.getTopicAutoRun(opts.topicId);
    if (!autoRun) return;
    if (!autoRun.enabled && !opts.force) return;
    if (autoRun.reply_count >= autoRun.max_replies) {
      if (autoRun.enabled) {
        this.store.upsertTopicAutoRun({
          topicId: opts.topicId,
          enabled: false,
          status: 'stopped',
          lastError: 'max_replies_reached'
        });
      }
      return;
    }
    if (!opts.force && autoRun.status === 'running') return;
    if (opts.triggerPostId && autoRun.last_trigger_post_id === opts.triggerPostId) return;
    if (this.runningTopics.has(opts.topicId)) return;

    this.runningTopics.add(opts.topicId);
    this.store.upsertTopicAutoRun({
      topicId: opts.topicId,
      status: 'running',
      lastRunAt: nowIso(),
      lastError: null,
      lastTriggerPostId: opts.triggerPostId ?? autoRun.last_trigger_post_id
    });

    try {
      const topic = this.store.getTopic(opts.topicId);
      if (!topic) {
        throw new Error('Topic not found');
      }
      const forum = this.store.getForum(topic.forum_id);
      const prompt = this.buildPrompt({ topicId: opts.topicId, autoRun });

      // Backwards-compat: keep worker/model semantics for UI, but the execution path
      // is always ECHS.
      const worker = (autoRun.worker as AutoRunDirectorWorker | null) ?? this.config.defaultWorker;
      const model = normalizeAutoRunPreference(autoRun.model) ?? this.config.defaultModel ?? null;
      const reasoningEffort =
        normalizeAutoRunPreference(autoRun.reasoning_effort) ?? this.config.defaultReasoningEffort ?? null;
      const cwd = forum?.cwd ?? this.config.workDir;

      const { output, directorThreadId } = await this.runPrompt({
        worker,
        prompt,
        cwd,
        model,
        reasoningEffort,
        directorThreadId: autoRun.director_thread_id ?? null,
        topicId: opts.topicId,
        triggerPostId: opts.triggerPostId
      });
      if (directorThreadId && directorThreadId !== autoRun.director_thread_id) {
        this.store.upsertTopicAutoRun({ topicId: opts.topicId, directorThreadId });
      }

      const decision = extractJsonPayload(output);
      const nextWorker = decision.nextWorker ?? null;
      // Backwards-compat: some Director prompts output literal "default".
      // Treat that as unset so ECHS receives an actual model id.
      const nextModel = normalizeAutoRunPreference(decision.nextModel);
      const nextReasoning = normalizeAutoRunPreference(decision.nextReasoningEffort);
      const notes = decision.notes?.trim() ? decision.notes.trim() : null;
      const normalizedSummary = normalizeDirectorSummary(decision);

      if (decision.action == 'stop') {
        this.store.upsertTopicAutoRun({
          topicId: opts.topicId,
          enabled: false,
          status: 'stopped',
          lastNotes: notes,
          lastSummary: normalizedSummary,
          lastRunAt: nowIso(),
          steerMessage: null,
          ...(nextWorker ? { worker: nextWorker } : {}),
          model: nextModel,
          reasoningEffort: nextReasoning
        });
        return;
      }

      if (decision.action == 'reply') {
        if (this.store.hasCompactionFence(opts.topicId)) {
          throw new Error('Conversation compaction recovery must finish before the Director can post');
        }
        const reply = decision.reply?.trim();
        if (!reply) {
          throw new Error('Director reply action missing reply text');
        }
        const directorIdentity =
          this.store.getIdentityByDisplayName('Director') ??
          this.store.getIdentityByDisplayName('director') ??
          this.store.getIdentityByDisplayName('The Director') ??
          this.store.getIdentityByDisplayName('the director') ??
          this.store.getIdentityByKind('robot');
        if (!directorIdentity) {
          throw new Error('Director identity not found');
        }
        const session = this.store.ensureSession({ topicId: opts.topicId });
        const sessionMessage = this.store.createSessionMessage(session.id, 'assistant', reply, 'public');
        const post = this.store.createPost({
          topicId: opts.topicId,
          body: reply,
          authorId: directorIdentity.id,
          parentPostId: opts.triggerPostId,
          sourceMessageId: sessionMessage.id
        });

        const replyCount = autoRun.reply_count + 1;
        const reachedMax = replyCount >= autoRun.max_replies;
        this.store.upsertTopicAutoRun({
          topicId: opts.topicId,
          enabled: reachedMax ? false : Boolean(autoRun.enabled),
          status: reachedMax ? 'stopped' : 'idle',
          replyCount,
          lastReplyAt: nowIso(),
          lastRunAt: nowIso(),
          lastNotes: notes,
          lastSummary: truncateText(reply, 500),
          lastError: reachedMax ? 'max_replies_reached' : null,
          steerMessage: null,
          ...(nextWorker ? { worker: nextWorker } : {}),
          model: nextModel,
          reasoningEffort: nextReasoning
        });

        this.bus.emit(opts.topicId, { type: 'assistant_message', data: { text: reply, postId: post.id } });

        // Director posts are meant to drive the robot. Kick off a robot turn using the Director post as the parent.
        // This is best-effort; failures should not crash the director.
        if (this.robotDispatch) {
          try {
            const dispatchModel = nextModel ?? model;
            const dispatchReasoning = nextReasoning ?? reasoningEffort;
            await this.robotDispatch({
              topicId: opts.topicId,
              body: reply,
              parentPostId: post.id,
              model: dispatchModel,
              reasoningEffort: dispatchReasoning
            });
          } catch {
            // ignore dispatch errors
          }
        }
        return;
      }

      this.store.upsertTopicAutoRun({
        topicId: opts.topicId,
        status: 'idle',
        lastNotes: notes,
        lastSummary: normalizedSummary,
        lastRunAt: nowIso(),
        steerMessage: null,
        ...(nextWorker ? { worker: nextWorker } : {}),
        model: nextModel,
        reasoningEffort: nextReasoning
      });
    } catch (err) {
      const message = formatDirectorError(err);
      this.store.upsertTopicAutoRun({
        topicId: opts.topicId,
        status: 'error',
        lastError: message,
        lastRunAt: nowIso()
      });
    } finally {
      this.runningTopics.delete(opts.topicId);
    }
  }

  private buildPrompt(opts: { topicId: string; autoRun: NonNullable<ReturnType<ForumStore['getTopicAutoRun']>> }): string {
    const topic = this.store.getTopic(opts.topicId);
    const forum = topic ? this.store.getForum(topic.forum_id) : null;
    const posts = this.store.listAllPosts(opts.topicId);
    const autoRun = opts.autoRun;
    const maxPostChars = this.config.maxPostChars ?? 4000;
    const explicitGoal = autoRun.context?.trim() ? autoRun.context.trim() : null;
    const derivedGoal = explicitGoal ? null : deriveNextMajorGoal(posts, this.store, maxPostChars);

    const participants = new Map<string, { name: string; kind: string }>();
    for (const post of posts) {
      const author = this.store.getIdentity(post.author_id);
      participants.set(post.author_id, {
        name: author?.display_name ?? 'unknown',
        kind: author?.kind ?? 'unknown'
      });
    }

    const participantLines = Array.from(participants.values()).map((p) => `- ${p.name} (${p.kind})`);

    const apiBase = this.config.apiBaseUrl?.trim() ? this.config.apiBaseUrl.trim().replace(/\/$/, '') : null;
    const postLines: string[] = [];
    for (const post of posts) {
      const author = this.store.getIdentity(post.author_id);
      const flags: string[] = [];
      if (post.silent) flags.push('silent');
      if (post.deleted_at) flags.push('deleted');
      const flagText = flags.length > 0 ? ` flags=${flags.join(',')}` : '';
      postLines.push(`[POST id=${post.id}${flagText}]`);
      postLines.push(`Author: ${author?.display_name ?? 'unknown'} (${author?.kind ?? 'unknown'})`);
      postLines.push(`Created: ${post.created_at}`);
      postLines.push('');
      postLines.push(truncateText(post.body ?? '', maxPostChars));

      const attachments = this.store.listAttachmentsByPost(post.id);
      if (attachments.length > 0) {
        postLines.push('');
        postLines.push(`Attachments (${attachments.length}):`);
        for (const attachment of attachments) {
          const url = apiBase ? `${apiBase}/attachments/${attachment.id}` : `/attachments/${attachment.id}`;
          postLines.push(`- ${attachment.filename} (${formatBytes(attachment.size_bytes)}) id=${attachment.id} url=${url}`);
        }
      }

      postLines.push('');
    }

    const remainingReplies = Math.max(0, autoRun.max_replies - autoRun.reply_count);

    const prompt = [
      'You are the Auto-Run Director for a forum thread.',
      'Your job is to direct the forum robot toward a clear goal using concise, human-sounding direction posts.',
      'Always read the full thread context provided below.',
      'If Auto-run context is present, treat it as the goal to achieve.',
      'If Auto-run context is empty, infer the next major goal from the most recent unresolved user/admin asks.',
      'When action="reply", write as a human Director: short, clear, encouraging, and goal-focused.',
      'Do not provide step-by-step strategy, command-level instructions, or implementation details.',
      'Do not mention being a robot/system/model. Sound like a real thread participant.',
      'If nothing meaningful can be done now (blocked, waiting, or truly no obvious next move), choose action="stop".',
      'You may still update notes and future settings via nextModel/nextReasoningEffort/nextWorker.',
      'Director notes should be a brief reasoning summary (1-3 sentences, no chain-of-thought).',
      'Reply ONLY with valid JSON (no markdown, no commentary).',
      '',
      'JSON schema:',
      '{ "action": "reply" | "idle" | "stop", "reply": "...", "notes": "...", "nextModel": "...", "nextReasoningEffort": "...", "nextWorker": "echs" }',
      '',
      `Topic: ${topic?.title ?? 'unknown'} (${opts.topicId})`,
      `Forum: ${forum?.name ?? 'unknown'}`,
      `Auto-run context: ${autoRun.context ?? '(none)'}`,
      `Active goal: ${explicitGoal ?? derivedGoal ?? '(derive from thread context)'}`,
      `Steer message: ${autoRun.steer_message ?? '(none)'}`,
      `Previous director notes: ${autoRun.last_notes ?? '(none)'}`,
      `Preferred worker: ${autoRun.worker ?? this.config.defaultWorker}`,
      `Preferred model: ${autoRun.model ?? '(default)'}`,
      `Preferred reasoning effort: ${autoRun.reasoning_effort ?? '(default)'}`,
      `Remaining auto-replies: ${remainingReplies}`,
      '',
      participantLines.length > 0 ? ['Participants:', ...participantLines, ''].join('\n') : '',
      '[THREAD]',
      postLines.join('\n'),
      '[/THREAD]'
    ]
      .filter((line) => line !== '')
      .join('\n');

    return prompt;
  }

  private async runPrompt(opts: {
    worker: AutoRunDirectorWorker;
    prompt: string;
    cwd: string;
    model: string | null;
    reasoningEffort: string | null;
    directorThreadId: string | null;
    topicId: string;
    triggerPostId: string | null;
  }): Promise<{
    output: string;
    directorThreadId: string | null;
  }> {
    // ECHS-only. Worker selection is ignored, but preserved for compatibility.
    void opts.worker;
    const { output, conversationId } = await this.runEchs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      conversationId: opts.directorThreadId,
      topicId: opts.topicId,
      triggerPostId: opts.triggerPostId
    });
    return { output, directorThreadId: conversationId };
  }

  private ensureEchsClient(): EchsClient {
    if (this.echsClient) return this.echsClient;
    if (!this.config.echs?.baseUrl) {
      throw new Error('ECHS is not configured (missing ECHS_BASE_URL)');
    }
    this.echsClient = new EchsClient({
      baseUrl: this.config.echs.baseUrl,
      apiToken: this.config.echs.apiToken ?? null
    });
    return this.echsClient;
  }

  private async runEchs(opts: {
    prompt: string;
    cwd: string;
    model: string | null;
    reasoningEffort: string | null;
    conversationId: string | null;
    topicId: string;
    triggerPostId: string | null;
  }): Promise<{ output: string; conversationId: string }> {
    const client = this.ensureEchsClient();
    let conversationId = opts.conversationId;

    if (conversationId) {
      const existing = await client.getConversation(conversationId);
      if (!existing) {
        conversationId = null;
      }
    }

    if (!conversationId) {
      conversationId = await client.createConversation({
        cwd: opts.cwd,
        model: opts.model,
        reasoning: opts.reasoningEffort,
        instructions: DIRECTOR_BASE_INSTRUCTIONS
      });
    }

    const session = this.store.ensureSession({ topicId: opts.topicId });
    const existingState = this.store.getRobotState(opts.topicId);
    if (!existingState) {
      this.store.upsertRobotState({
        topicId: opts.topicId,
        sessionId: session.id,
        activity: 'idle',
        model: null,
        reasoningEffort: null,
        currentPlanId: null
      });
    }
    this.store.upsertRobotState({
      topicId: opts.topicId,
      sessionId: session.id,
      activity: 'running',
      model: opts.model ?? null,
      reasoningEffort: opts.reasoningEffort ?? null,
      currentPlanId: null
    });

    const configure: Record<string, unknown> = { cwd: opts.cwd };
    if (opts.model) configure['model'] = opts.model;
    if (opts.reasoningEffort) configure['reasoning'] = opts.reasoningEffort;

    const toolRunByCallId = new Map<string, string>();
    let targetMessageId: string | null = null;
    const bufferedEvents: EchsEvent[] = [];
    let outputBuffer = '';
    let lastAssistantMessage: string | null = null;
    let completionResolve: ((value: string) => void) | null = null;
    let completionReject: ((err: Error) => void) | null = null;

    const completion = new Promise<string>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });

    const finalizePendingTools = (summary: string) => {
      const finishedAt = nowIso();
      for (const toolRunId of toolRunByCallId.values()) {
        this.store.updateToolRun(toolRunId, {
          finished_at: finishedAt,
          exit_code: 1,
          output_summary: summary
        });
      }
      toolRunByCallId.clear();
    };

    const markRobotIdle = () => {
      this.store.upsertRobotState({
        topicId: opts.topicId,
        sessionId: session.id,
        activity: 'idle',
        model: opts.model ?? null,
        reasoningEffort: opts.reasoningEffort ?? null,
        currentPlanId: null
      });
    };

    const handleEvent = (event: EchsEvent) => {
      const eventMessageId = extractEventMessageId(event);
      if (eventMessageId && eventMessageId !== targetMessageId) return;

      switch (event.event) {
        case 'turn_delta': {
          const data = event.data as any;
          const delta = typeof data?.content === 'string' ? data.content : '';
          if (delta) outputBuffer += delta;
          break;
        }
        case 'item_started': {
          const item = (event.data as any)?.item;
          if (!item?.type) break;
          if (item.type !== 'function_call' && item.type !== 'local_shell_call') break;
          const callId = item.call_id ?? item.callId ?? item.id;
          if (typeof callId !== 'string' || !callId) break;
          if (toolRunByCallId.has(callId)) break;
          const tool = mapEchsToolName(item.name ?? item.type);
          const command = formatEchsToolCommand(item);
          const toolRun = this.store.createToolRun({
            topicId: opts.topicId,
            sessionId: session.id,
            tool,
            parentPostId: opts.triggerPostId,
            command,
            outputSummary: null,
            visibility: 'internal'
          });
          toolRunByCallId.set(callId, toolRun.id);
          break;
        }
        case 'tool_completed': {
          const data = event.data as any;
          const callId = data?.call_id ?? data?.callId ?? null;
          if (typeof callId !== 'string' || !callId) break;
          const toolRunId = toolRunByCallId.get(callId);
          if (!toolRunId) break;
          const rawSummary = summarizeToolResult(data?.result);
          const summary = truncateText(rawSummary, 500);
          this.store.updateToolRun(toolRunId, {
            finished_at: nowIso(),
            exit_code: null,
            output_summary: summary
          });
          toolRunByCallId.delete(callId);
          break;
        }
        case 'item_completed': {
          const item = (event.data as any)?.item;
          if (item?.type === 'message' && item?.role === 'assistant') {
            const text = extractAssistantText(item);
            if (text?.trim()) {
              lastAssistantMessage = text;
            }
          }
          break;
        }
        case 'turn_completed': {
          completionResolve?.(lastAssistantMessage ?? outputBuffer);
          break;
        }
        case 'turn_interrupted': {
          completionReject?.(new Error('ECHS director turn interrupted'));
          break;
        }
        case 'turn_error': {
          completionReject?.(new Error('ECHS director turn failed'));
          break;
        }
        default:
          break;
      }
    };

    const subscription = client.subscribeConversation(conversationId, (event: EchsEvent) => {
      if (!targetMessageId) {
        bufferedEvents.push(event);
        if (bufferedEvents.length > 200) {
          bufferedEvents.shift();
        }
        return;
      }
      handleEvent(event);
    });

    try {
      const { messageId } = await client.enqueueConversationMessage(conversationId, opts.prompt, {
        mode: 'queue',
        configure
      });
      targetMessageId = messageId;
      if (bufferedEvents.length > 0) {
        for (const event of bufferedEvents) {
          handleEvent(event);
        }
        bufferedEvents.length = 0;
      }

      const output = await Promise.race([
        completion,
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error('ECHS director turn timed out')), 4 * 60 * 1000);
        })
      ]);

      const finalOutput = output?.trim() ? output : await this.fallbackEchsOutput(client, conversationId);
      return { output: finalOutput, conversationId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ECHS director turn failed';
      try {
        await client.interruptConversation(conversationId);
      } catch {
        // Best-effort interruption.
      }
      finalizePendingTools(message);
      throw err;
    } finally {
      markRobotIdle();
      subscription.close();
    }
  }

  private async fallbackEchsOutput(client: EchsClient, conversationId: string): Promise<string> {
    try {
      const history = await client.getConversationHistory(conversationId);
      const items = (history as any)?.items;
      if (Array.isArray(items)) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const item = items[i];
          if (item?.type === 'message' && item?.role === 'assistant') {
            const text = extractAssistantText(item);
            if (text?.trim()) return text;
          }
        }
      }
    } catch {
      // Ignore history failures.
    }
    return '';
  }
}

function deriveNextMajorGoal(
  posts: Array<{ author_id: string; body: string; deleted_at: string | null }>,
  store: ForumStore,
  maxPostChars: number
): string | null {
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const post = posts[i];
    if (!post || post.deleted_at) continue;
    const author = store.getIdentity(post.author_id);
    if (!author) continue;
    if (author.kind === 'robot' || author.kind === 'persona' || author.kind === 'system' || author.kind === 'webhook') {
      continue;
    }
    const body = truncateText((post.body ?? '').trim(), Math.max(120, Math.min(maxPostChars, 260)));
    if (!body) continue;
    return `Address the latest requester intent from ${author.display_name}: ${body}`;
  }
  return null;
}

const DIRECTOR_BASE_INSTRUCTIONS = [
  'You are the Auto-Run Director for a forum thread.',
  'Always reply with valid JSON only. No markdown.',
  'Choose action=reply to write a forum reply, action=idle if no reply is needed now, or action=stop to disable auto-run.',
  'If the input includes full thread context, prioritize that and do not ask for missing context.'
].join('\n');

function formatDirectorError(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { status?: number; details?: unknown };
    const status = typeof anyErr.status === 'number' ? ` (status ${anyErr.status})` : '';
    const details = anyErr.details ? ` details=${safeStringify(anyErr.details)}` : '';
    return `${anyErr.message}${status}${details}`;
  }
  return `Director run failed: ${String(err)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function normalizeDirectorSummary(decision: DirectorDecision): string | null {
  if (decision.action === 'reply') {
    return decision.reply ? truncateText(decision.reply, 500) : 'action=reply';
  }
  const note = decision.notes?.trim();
  if (note) {
    return truncateText(note, 500);
  }
  return `action=${decision.action}`;
}

function extractEventMessageId(event: EchsEvent): string | null {
  const data = event.data as any;
  const messageId = data?.message_id ?? data?.messageId ?? null;
  return typeof messageId === 'string' ? messageId : null;
}

function extractAssistantText(item: any): string {
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  const content = item.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .join('');
  }
  return '';
}

function mapEchsToolName(name: string): string {
  const key = String(name ?? '').toLowerCase();
  if (['exec_command', 'write_stdin', 'shell', 'local_shell'].includes(key)) return 'exec';
  if (key === 'apply_patch') return 'apply_patch';
  if (key.startsWith('forum_')) return 'mcp';
  return 'other';
}

function formatEchsToolCommand(item: any): string | null {
  if (!item) return null;
  if (item.type === 'local_shell_call') {
    const command = item?.action?.command;
    if (Array.isArray(command)) {
      return command.join(' ');
    }
    if (typeof command === 'string') return command;
  }
  if (item.type === 'function_call') {
    const args = typeof item.arguments === 'string' ? item.arguments : safeJson(item.arguments);
    return args ? `${item.name} ${truncateText(String(args), 200)}` : item.name ?? null;
  }
  return null;
}

function summarizeToolResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
