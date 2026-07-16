import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ForumStore } from '../store';
import { EchsClient, type EchsClientOptions, type EchsEvent } from '../echsClient';
import { generateToken } from './auth';

const AUTOMATION_PREAMBLE = `You are a forum automation agent. Your job is to read the forum and respond only when needed. If no reply is needed, do nothing.

Be terse and practical. Do not expose secrets.`;

const AUTOMATION_BASE_INSTRUCTIONS = AUTOMATION_PREAMBLE;

export interface MappedRobotAutomation {
  id: string;
  name: string;
  forumId: string | null;
  prompt: string;
  enabled: boolean;
  worker: string;
  model: string | null;
  reasoningEffort: string | null;
  runMode: string;
  intervalMinutes: number | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapRobotAutomation(row: any): MappedRobotAutomation {
  return {
    id: row.id,
    name: row.name,
    forumId: row.forum_id ?? null,
    prompt: row.prompt,
    enabled: Boolean(row.enabled),
    worker: row.worker,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    runMode: row.run_mode,
    intervalMinutes: row.interval_minutes,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface MappedRobotAutomationRun {
  id: string;
  automationId: string;
  worker: string;
  model: string | null;
  reasoningEffort: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  outputSummary: string | null;
  lastMessage: string | null;
  logPath: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapRobotAutomationRun(row: any): MappedRobotAutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    worker: row.worker,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    outputSummary: row.output_summary,
    lastMessage: row.last_message,
    logPath: row.log_path
  };
}

export function buildAutomationPrompt(
  automation: { prompt: string; forum_id?: string | null },
  forumName?: string | null
): string {
  const scopeLine = forumName ? `Scope: forum "${forumName}".` : 'Scope: all forums.';
  return `${AUTOMATION_PREAMBLE}\n\n${scopeLine}\n\nTask:\n${automation.prompt.trim()}`;
}

export function truncateText(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function createAutomationRunner({
  app,
  store,
  apiBaseUrl,
  workDir,
  automationLogDir,
  echs
}: {
  app: FastifyInstance;
  store: ForumStore;
  apiBaseUrl: string;
  workDir: string;
  automationLogDir: string;
  echs: EchsClientOptions;
}): { startRun: (automationId: string) => void } {
  if (!echs?.baseUrl) {
    throw new Error('ECHS automation requires CODEX_FORUM_ECHS_BASE_URL');
  }

  function startRun(automationId: string): void {
    void runAutomation(automationId);
  }

  async function runAutomation(automationId: string): Promise<void> {
    const automation = store.getRobotAutomation(automationId);
    if (!automation) {
      throw app.httpErrors.notFound('Automation not found');
    }

    const forum = automation.forum_id ? store.getForum(automation.forum_id) : null;
    const prompt = buildAutomationPrompt(automation, forum?.name ?? null);
    const run = store.createRobotAutomationRun({
      automationId: automation.id,
      worker: 'echs',
      model: automation.model,
      reasoningEffort: automation.reasoning_effort,
      status: 'running'
    });

    const runDir = join(automationLogDir, automation.id);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    const logPath = join(runDir, `${run.id}.log`);
    store.updateRobotAutomationRun(run.id, { log_path: logPath });
    store.updateRobotAutomation(automation.id, { lastRunAt: new Date().toISOString() });

    const robotIdentity = store.getIdentityByKind('robot');
    const token = robotIdentity ? generateToken('cforum_access') : null;
    if (robotIdentity && token) {
      store.createAuthSession(token, robotIdentity.id, 1);
    }

    const env = {
      ...process.env,
      CODEX_FORUM_TOKEN: token ?? '',
      CODEX_FORUM_API_BASE_URL: apiBaseUrl
    };

    const cwd = forum?.cwd ?? workDir;
    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.write(`[PROMPT]\n${prompt}\n[/PROMPT]\n`);

    const finalize = (opts: { status: 'completed' | 'error'; lastMessage: string | null; exitCode?: number | null }) => {
      const summary = opts.lastMessage ? truncateText(opts.lastMessage, 500) : null;
      store.updateRobotAutomationRun(run.id, {
        status: opts.status,
        finished_at: new Date().toISOString(),
        exit_code: opts.exitCode ?? null,
        output_summary: summary,
        last_message: opts.lastMessage
      });
      if (token) {
        store.deleteAuthSession(token);
      }
      logStream.end();
    };

    try {
      const result = await runEchsAutomation({
        client: new EchsClient(echs),
        prompt,
        cwd,
        model: automation.model,
        reasoningEffort: automation.reasoning_effort,
        conversationId: automation.worker_thread_id ?? null,
        env
      });
      if (result.conversationId && result.conversationId !== automation.worker_thread_id) {
        store.updateRobotAutomation(automation.id, { workerThreadId: result.conversationId });
      }
      logStream.write(`\n[OUTPUT]\n${result.output}\n[/OUTPUT]\n`);
      const lastMessage = result.output.trim() || null;
      finalize({ status: 'completed', lastMessage, exitCode: 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Automation run failed';
      logStream.write(`\n[ERROR]\n${message}\n[/ERROR]\n`);
      finalize({ status: 'error', lastMessage: message, exitCode: 1 });
    }
  }

  return { startRun };
}

async function runEchsAutomation(opts: {
  client: EchsClient;
  prompt: string;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  conversationId: string | null;
  env: NodeJS.ProcessEnv;
}): Promise<{ output: string; conversationId: string }> {
  let conversationId = opts.conversationId;
  if (conversationId) {
    const existing = await opts.client.getConversation(conversationId);
    if (!existing) {
      conversationId = null;
    }
  }

  if (!conversationId) {
    conversationId = await opts.client.createConversation({
      cwd: opts.cwd,
      model: opts.model,
      reasoning: opts.reasoningEffort,
      instructions: AUTOMATION_BASE_INSTRUCTIONS
    });
  }

  const configure: Record<string, unknown> = { cwd: opts.cwd };
  if (opts.model) configure['model'] = opts.model;
  if (opts.reasoningEffort) configure['reasoning'] = opts.reasoningEffort;

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
        completionReject?.(new Error('ECHS automation turn interrupted'));
        break;
      }
      case 'turn_error': {
        completionReject?.(new Error('ECHS automation turn failed'));
        break;
      }
      default:
        break;
    }
  };

  const subscription = opts.client.subscribeConversation(conversationId, (event: EchsEvent) => {
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
    const { messageId } = await opts.client.enqueueConversationMessage(conversationId, opts.prompt, {
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
        setTimeout(() => reject(new Error('ECHS automation turn timed out')), 4 * 60 * 1000);
      })
    ]);

    const finalOutput = output?.trim() ? output : await fallbackEchsOutput(opts.client, conversationId);
    return { output: finalOutput, conversationId };
  } finally {
    subscription.close();
  }
}

async function fallbackEchsOutput(client: EchsClient, conversationId: string): Promise<string> {
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
