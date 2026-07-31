import { EchsBridge } from './echsBridge';

import type { MessageTamperContext, MessageTamperLayer, MessageTamperPlugin } from '@irrigationreal/codex-forum-core';

import type { ForumStore } from './store';
import type { EchsSubagentRetention, EchsSubagentWorkload } from './echsClient';
import type { StreamBusInterface } from './streamBus';

export type AgentBackend = 'echs';

export interface AgentBridgeConfig {
  model: string;
  reasoningEffort?: string | null;
  workDir: string;
  apiBaseUrl?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  tamperLayer?: MessageTamperLayer<MessageTamperContext>;
  maxConcurrentTurns?: number;
  maxTurnChars?: number;
  maxPostChars?: number;
  autoRunDirector?: {
    handleAssistantReply: (opts: { topicId: string; postId: string; text: string }) => void | Promise<void>;
  };
  tts?: {
    enabled: boolean;
    scriptPath: string;
    uploadsDir: string;
    maxChars?: number;
  };
  echs: {
    baseUrl: string;
    apiToken?: string | null;
  };
}

export class AgentBridge {
  private readonly echs: EchsBridge;

  constructor(
    private readonly store: ForumStore,
    bus: StreamBusInterface,
    config: AgentBridgeConfig
  ) {
    if (!config.echs?.baseUrl) {
      throw new Error('ECHS backend requires CODEX_FORUM_ECHS_BASE_URL');
    }

    this.echs = new EchsBridge(store, bus, {
      model: config.model,
      reasoningEffort: config.reasoningEffort ?? null,
      workDir: config.workDir,
      apiBaseUrl: config.apiBaseUrl ?? null,
      baseInstructions: config.baseInstructions ?? null,
      developerInstructions: config.developerInstructions ?? null,
      echs: config.echs,
      ...(config.tamperLayer !== undefined && { tamperLayer: config.tamperLayer }),
      ...(config.maxConcurrentTurns !== undefined && { maxConcurrentTurns: config.maxConcurrentTurns }),
      ...(config.autoRunDirector !== undefined && { autoRunDirector: config.autoRunDirector }),
      ...(config.tts !== undefined && { tts: config.tts }),
      ...(config.maxTurnChars !== undefined && { maxTurnChars: config.maxTurnChars }),
      ...(config.maxPostChars !== undefined && { maxPostChars: config.maxPostChars }),
    });
  }

  registerTamperPlugin(plugin: MessageTamperPlugin<MessageTamperContext>): void {
    this.echs.registerTamperPlugin(plugin);
  }

  get maxConcurrentTurns(): number {
    return this.echs.maxConcurrentTurns;
  }

  setMaxConcurrentTurns(value: number): void {
    this.echs.setMaxConcurrentTurns(value);
  }

  async start(): Promise<void> {
    await this.echs.start();
  }

  async stop(): Promise<void> {
    await this.echs.stop();
  }

  async reconcileLoadedThreads(opts?: { sinceMs?: number }): Promise<{ reattached: number; missing: number }> {
    return this.echs.reconcileLoadedThreads(opts);
  }

  listQueuedTurns(): Array<
    Pick<
      { topicId: string; sessionId: string; parentPostId: string | null; queuedAt: string },
      'topicId' | 'sessionId' | 'parentPostId' | 'queuedAt'
    >
  > {
    return this.echs.listQueuedTurns();
  }

  listActiveTurns(): Array<{
    threadId: string;
    topicId: string;
    sessionId: string;
    turnId: string;
    parentPostId: string | null;
  }> {
    return this.echs.listActiveTurns();
  }

  async pauseActiveThreads(reason = 'deploy'): Promise<{ paused: number; skipped: number }> {
    return this.echs.pauseActiveThreads(reason);
  }

  async sendUserMessage(
    topicId: string,
    body: string,
    parentPostId: string | null,
    options?: { model?: string | null; reasoningEffort?: string | null }
  ): Promise<void> {
    this.store.setSessionAgentBackend(this.store.ensureSession({ topicId }).id, 'echs');
    return this.echs.sendUserMessage(topicId, body, parentPostId, options);
  }

  async steerUserMessage(
    topicId: string,
    body: string,
    parentPostId: string | null,
    options?: { model?: string | null; reasoningEffort?: string | null }
  ): Promise<void> {
    this.store.setSessionAgentBackend(this.store.ensureSession({ topicId }).id, 'echs');
    return this.echs.steerUserMessage(topicId, body, parentPostId, options);
  }

  async dispatchPostToAgent(
    topicId: string,
    postId: string,
    options?: { mode?: 'queue' | 'steer'; model?: string | null; reasoningEffort?: string | null; dispatchId?: string; generation?: number }
  ): Promise<void> {
    this.store.setSessionAgentBackend(this.store.ensureSession({ topicId }).id, 'echs');
    return this.echs.dispatchPostToAgent(topicId, postId, options);
  }

  async interruptTopic(topicId: string): Promise<{ ok: boolean; message: string }> {
    return this.echs.interruptTopic(topicId);
  }

  async closeTopic(topicId: string): Promise<{ ok: boolean; message: string }> {
    return this.echs.closeTopic(topicId);
  }

  async getSubagentWorkload(): Promise<EchsSubagentWorkload> {
    return this.echs.getSubagentWorkload();
  }

  async getSubagentRetention(): Promise<EchsSubagentRetention> {
    return this.echs.getSubagentRetention();
  }

  async getAgentdQuiescence(): Promise<Record<string, unknown>> {
    return this.echs.getAgentdQuiescence();
  }

  async getAnalytics(input: {
    from: string;
    to: string;
    bucket: 'day' | 'week';
    piSessionIds: string[];
    minToolSamples?: number;
  }): Promise<Record<string, unknown>> {
    return this.echs.getAnalytics(input);
  }

  async isThreadLoaded(threadId: string): Promise<boolean> {
    return this.echs.isThreadLoaded(threadId);
  }

  getStreamLiveness(topicId: string): { lastStreamEventAt: string | null; streamAlive: boolean } | null {
    return this.echs.getStreamLiveness(topicId);
  }

  async getTopicContext(topicId: string): Promise<Record<string, unknown> | null> {
    return this.echs.getTopicContext(topicId);
  }

  async generateHandoffDraft(
    topicId: string,
    opts: { goal: string; model?: string | null; reasoningEffort?: string | null; systemPrompt?: string | null }
  ): Promise<{ source?: unknown; goal: string; draft: string; model?: string | null; reasoning?: string | null }> {
    return this.echs.generateHandoffDraft(topicId, opts);
  }

  async getTopicCompactionLeaf(topicId: string): Promise<string | null> {
    return this.echs.getTopicCompactionLeaf(topicId);
  }

  async compactTopicConversation(
    topicId: string,
    opts: { operationId: string; expectedLeafId: string; customInstructions?: string | null }
  ): Promise<Record<string, unknown>> {
    return this.echs.compactTopicConversation(topicId, opts);
  }

  async createLinkedHandoffConversation(
    topicId: string,
    opts: {
      parentPiSessionId?: string | null;
      parentPiSessionPath?: string | null;
      cwd: string;
      model?: string | null;
      reasoningEffort?: string | null;
    }
  ): Promise<unknown> {
    return this.echs.createLinkedHandoffConversation(topicId, opts);
  }
}
