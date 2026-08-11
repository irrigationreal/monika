import { DiscordAdapter, type DiscordSurfaceEvent, type DiscordPostEventPayload, type DiscordTopicEventPayload } from '@irrigationreal/codex-forum-adapters';
import { originMatchesSurface } from '@irrigationreal/codex-forum-core';
import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';
import type { AgentBridge } from '../agentBridge';

export interface DiscordBridgeConfig {
  token: string;
  guildId: string;
  defaultForumId?: string | null;
}

export interface DiscordBridgeStatus {
  connected: boolean;
  guildId: string;
  surfaceId: string;
  mappedChannels: Array<{ channelId: string; forumId: string }>;
  error?: string | null;
}

/**
 * Bridge between Discord adapter and ForumStore.
 * Handles incoming Discord messages by creating identities and posts,
 * and handles outgoing forum posts by sending to Discord threads.
 */
export class DiscordBridge {
  private adapter: DiscordAdapter | null = null;
  private config: DiscordBridgeConfig;
  private store: ForumStore;
  private bus: StreamBusInterface;
  private codex: AgentBridge | null;
  private topicSubscriptions = new Map<string, () => void>();
  private lastError: string | null = null;

  constructor(
    store: ForumStore,
    bus: StreamBusInterface,
    config: DiscordBridgeConfig,
    codex?: AgentBridge | null
  ) {
    this.store = store;
    this.bus = bus;
    this.config = config;
    this.codex = codex ?? null;
  }

  /**
   * Connect to Discord and start listening for events
   */
  async connect(): Promise<void> {
    if (this.adapter?.isRunning()) {
      console.log('[DiscordBridge] Already connected');
      return;
    }

    try {
      this.adapter = new DiscordAdapter({
        token: this.config.token,
        guildId: this.config.guildId
      });

      // Set up event handlers
      this.adapter.on('messageCreate', (event) => this.handleMessageCreate(event));
      this.adapter.on('threadCreate', (event) => this.handleThreadCreate(event));
      this.adapter.on('error', (error) => {
        console.error('[DiscordBridge] Adapter error:', error.message);
        this.lastError = error.message;
      });
      this.adapter.on('disconnect', () => {
        console.log('[DiscordBridge] Adapter disconnected');
      });

      await this.adapter.start();
      this.lastError = null;

      console.log('[DiscordBridge] Connected to Discord');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastError = err.message;
      console.error('[DiscordBridge] Failed to connect:', err.message);
      throw err;
    }
  }

  /**
   * Disconnect from Discord
   */
  async disconnect(): Promise<void> {
    if (!this.adapter) {
      return;
    }

    // Unsubscribe from all topic events
    this.topicSubscriptions.forEach((unsub) => {
      unsub();
    });
    this.topicSubscriptions.clear();

    await this.adapter.stop();
    this.adapter = null;

    console.log('[DiscordBridge] Disconnected from Discord');
  }

  /**
   * Check if connected to Discord
   */
  isConnected(): boolean {
    return this.adapter?.isRunning() ?? false;
  }

  /**
   * Get the current status of the bridge
   */
  getStatus(): DiscordBridgeStatus {
    const mappedChannels = this.adapter
      ? Array.from(this.adapter.getMappedChannels().entries()).map(([channelId, forumId]) => ({
          channelId,
          forumId
        }))
      : [];

    return {
      connected: this.isConnected(),
      guildId: this.config.guildId,
      surfaceId: this.adapter?.surfaceId ?? `discord:${this.config.guildId}`,
      mappedChannels,
      error: this.lastError
    };
  }

  /**
   * Map a Discord channel to a forum
   */
  async mapChannel(channelId: string, forumId: string): Promise<void> {
    if (!this.adapter) {
      throw new Error('Discord adapter is not connected');
    }

    await this.adapter.syncChannel(channelId, forumId);

    // Create external ref for the channel -> forum mapping
    const existing = this.store.getExternalRefByExternal(
      this.adapter.surfaceId,
      'discord',
      channelId
    );

    if (!existing) {
      this.store.createExternalRef({
        surfaceId: this.adapter.surfaceId,
        surfaceKind: 'discord',
        externalId: channelId,
        kind: 'forum',
        scope: this.config.guildId,
        scopeKind: 'server',
        mappedForumId: forumId
      });
    }

    console.log(`[DiscordBridge] Mapped channel ${channelId} to forum ${forumId}`);
  }

  /**
   * Unmap a Discord channel
   */
  unmapChannel(channelId: string): void {
    if (!this.adapter) {
      return;
    }

    this.adapter.unmapForumChannel(channelId);
    console.log(`[DiscordBridge] Unmapped channel ${channelId}`);
  }

  /**
   * Handle incoming Discord messages
   */
  private async handleMessageCreate(event: DiscordSurfaceEvent): Promise<void> {
    const payload = event.payload as DiscordPostEventPayload;

    if (payload.type !== 'post.created' || !payload.body) {
      return;
    }

    const threadId = payload.threadId;
    if (!threadId) {
      // Message not in a thread, skip
      return;
    }

    try {
      // Look up or create identity for Discord user
      const authorId = payload.authorId;
      if (!authorId) {
        console.warn('[DiscordBridge] Message has no author ID');
        return;
      }

      const identity = await this.getOrCreateIdentity(authorId, event);

      // Look up mapped topic for this thread
      const topicRef = this.store.getExternalRefByExternal(
        event.surfaceId,
        'discord',
        threadId
      );

      if (!topicRef?.mapped_topic_id) {
        // Thread not mapped yet, need to handle thread creation first
        console.log(`[DiscordBridge] No topic mapping for thread ${threadId}`);
        return;
      }

      // Check if message already exists (prevent duplicates)
      const messageRef = this.store.getExternalRefByExternal(
        event.surfaceId,
        'discord',
        payload.messageId!
      );

      if (messageRef?.mapped_post_id) {
        // Already processed
        return;
      }

      const session = this.codex ? this.store.ensureSession({ topicId: topicRef.mapped_topic_id }) : null;
      const post = this.store.createExternalPostWithDispatch({
        post: {
          topicId: topicRef.mapped_topic_id,
          body: payload.body,
          authorId: identity.id,
          parentPostId: null
        },
        externalRef: {
          surfaceId: event.surfaceId,
          surfaceKind: 'discord',
          externalId: payload.messageId!,
          kind: 'post',
          scope: threadId,
          scopeKind: 'thread',
          mappedTopicId: topicRef.mapped_topic_id
        },
        sessionId: session?.id ?? null
      });
      console.log(`[DiscordBridge] Atomically queued durable post ${post.id} from Discord message ${payload.messageId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[DiscordBridge] Failed to handle message:', err.message);
    }
  }

  /**
   * Handle Discord thread creation
   */
  private async handleThreadCreate(event: DiscordSurfaceEvent): Promise<void> {
    const payload = event.payload as DiscordTopicEventPayload;

    if (payload.type !== 'topic.created') {
      return;
    }

    const threadId = payload.threadId;
    const channelId = payload.channelId;

    if (!threadId || !channelId) {
      return;
    }

    try {
      // Check if thread already mapped
      const existing = this.store.getExternalRefByExternal(
        event.surfaceId,
        'discord',
        threadId
      );

      if (existing?.mapped_topic_id) {
        // Already mapped
        return;
      }

      // Look up forum for this channel
      const channelRef = this.store.getExternalRefByExternal(
        event.surfaceId,
        'discord',
        channelId
      );

      const forumId = channelRef?.mapped_forum_id ?? this.config.defaultForumId;
      if (!forumId) {
        console.log(`[DiscordBridge] No forum mapping for channel ${channelId}`);
        return;
      }

      // Get or create identity for thread creator
      const authorId = payload.authorId;
      let identity = authorId ? await this.getOrCreateIdentity(authorId, event) : null;

      // Fall back to a generic Discord identity
      if (!identity) {
        identity = this.store.getIdentityByDisplayName('Discord User');
        if (!identity) {
          identity = this.store.createIdentity('Discord User', 'discord');
        }
      }

      // Publish the topic mapping and optional robot dispatch as one durable unit.
      // A retried thread event can therefore never observe a mapped first post
      // whose user message/dispatch was lost in a crash window.
      const { topic } = this.store.createExternalTopicWithDispatch({
        topic: {
          forumId,
          title: payload.title ?? 'Untitled Thread',
          body: payload.body ?? `Thread created from Discord: ${payload.title ?? 'Untitled'}`,
          authorId: identity.id,
        },
        externalRef: {
          surfaceId: event.surfaceId,
          surfaceKind: 'discord',
          externalId: threadId,
          kind: 'topic',
          scope: channelId,
          scopeKind: 'channel',
          mappedForumId: forumId,
        },
        dispatch: Boolean(this.codex && payload.body),
      });

      console.log(`[DiscordBridge] Created topic ${topic.id} from Discord thread ${threadId}`);

      // Subscribe to topic events for sending robot replies back to Discord
      this.subscribeToTopic(topic.id, threadId);

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[DiscordBridge] Failed to handle thread create:', err.message);
    }
  }

  /**
   * Subscribe to topic events to send robot replies to Discord
   */
  private subscribeToTopic(topicId: string, threadId: string): void {
    if (this.topicSubscriptions.has(topicId)) {
      return;
    }

    const unsubscribe = this.bus.subscribe(topicId, (event) => {
      if (event.type === 'assistant_message' && event.data) {
        const data = event.data as { text?: string; origin?: { channelKind?: string; surfaceId?: string | null; scope?: string | null } | null };
        const origin = data.origin;
        if (!this.adapter || !originMatchesSurface(origin, {
          channelKind: 'discord', surfaceId: this.adapter.surfaceId, scope: threadId,
        })) return;
        const text = data.text;
        if (text) {
          this.sendRobotReplyToDiscord(threadId, text).catch((err) => {
            console.error('[DiscordBridge] Failed to send robot reply:', err.message);
          });
        }
      }
    });

    this.topicSubscriptions.set(topicId, unsubscribe);
  }

  /**
   * Send a robot reply to Discord
   */
  private async sendRobotReplyToDiscord(threadId: string, content: string): Promise<void> {
    if (!this.adapter?.isRunning()) {
      console.warn('[DiscordBridge] Cannot send reply - adapter not running');
      return;
    }

    try {
      const robotIdentity = this.store.getIdentityByKind('robot');
      const authorName = robotIdentity?.display_name ?? 'Robot';

      await this.adapter.sendToThread(threadId, content, authorName);
      console.log(`[DiscordBridge] Sent robot reply to thread ${threadId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[DiscordBridge] Failed to send to Discord:', err.message);
      throw err;
    }
  }

  /**
   * Get or create an identity for a Discord user
   */
  private async getOrCreateIdentity(
    discordUserId: string,
    event: DiscordSurfaceEvent
  ): Promise<{ id: string; display_name: string }> {
    // Check if identity already exists via external ref
    const existingRef = this.store.getExternalRefByExternal(
      event.surfaceId,
      'discord',
      discordUserId
    );

    if (existingRef?.mapped_identity_id) {
      const identity = this.store.getIdentity(existingRef.mapped_identity_id);
      if (identity) {
        return { id: identity.id, display_name: identity.display_name };
      }
    }

    // Get user info from Discord
    const metadata = event.metadata as {
      authorUsername?: string;
      authorDisplayName?: string;
      authorAvatar?: string;
    } | undefined;

    const displayName = metadata?.authorDisplayName ?? metadata?.authorUsername ?? `Discord User ${discordUserId.slice(-4)}`;
    const avatarUrl = metadata?.authorAvatar ?? null;

    // Create new identity
    const identity = this.store.createIdentity(displayName, 'discord', avatarUrl);

    // Create external ref for Discord user -> identity mapping
    this.store.createExternalRef({
      surfaceId: event.surfaceId,
      surfaceKind: 'discord',
      externalId: discordUserId,
      kind: 'identity',
      scope: this.config.guildId,
      scopeKind: 'server',
      mappedIdentityId: identity.id
    });

    console.log(`[DiscordBridge] Created identity ${identity.id} for Discord user ${discordUserId}`);

    return { id: identity.id, display_name: identity.display_name };
  }

  /**
   * Send a message to a Discord thread (external API)
   */
  async sendToThread(threadId: string, content: string, authorName?: string): Promise<string | null> {
    if (!this.adapter?.isRunning()) {
      throw new Error('Discord adapter is not connected');
    }

    const name = authorName ?? 'Forum';
    return this.adapter.sendToThread(threadId, content, name);
  }

  /**
   * Get the underlying adapter (for advanced use cases)
   */
  getAdapter(): DiscordAdapter | null {
    return this.adapter;
  }
}
