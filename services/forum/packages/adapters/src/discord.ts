import type { SurfaceEventEnvelope, ExternalRef, ExternalId } from '@irrigationreal/codex-forum-core';
import type { SurfaceAdapter, SurfaceCapabilities, SurfaceEventBatch } from './surface';
import { EventEmitter } from 'node:events';

export type DiscordEntityType = 'guild' | 'channel' | 'thread' | 'message' | 'user';

export interface DiscordEventBase {
  guildId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  authorId?: string | null;
  entityType: DiscordEntityType;
}

export interface DiscordForumEventPayload extends DiscordEventBase {
  type: 'forum.created' | 'forum.updated';
  title?: string | null;
  description?: string | null;
}

export interface DiscordTopicEventPayload extends DiscordEventBase {
  type: 'topic.created' | 'topic.renamed' | 'topic.tagged' | 'topic.status.changed';
  title?: string | null;
  tags?: string[];
  status?: 'open' | 'locked' | 'archived';
  body?: string | null;
}

export interface DiscordPostEventPayload extends DiscordEventBase {
  type: 'post.created' | 'post.edited' | 'post.deleted';
  body?: string | null;
  parentMessageId?: ExternalId | null;
}

export interface DiscordIdentityEventPayload extends DiscordEventBase {
  type: 'identity.synced';
  displayName?: string | null;
  avatarUrl?: string | null;
}

export type DiscordEventPayload =
  | DiscordForumEventPayload
  | DiscordTopicEventPayload
  | DiscordPostEventPayload
  | DiscordIdentityEventPayload;

export type DiscordSurfaceEvent = SurfaceEventEnvelope<DiscordEventPayload>;

export interface DiscordAdapterInterface extends SurfaceAdapter<DiscordSurfaceEvent> {
  readonly surface: 'discord';
  mapForumChannel(forumChannelId: string): Promise<void>;
}

// Config for the Discord adapter
export interface DiscordAdapterConfig {
  token: string;
  guildId: string;
}

// Event types emitted by the adapter
export interface DiscordAdapterEvents {
  messageCreate: (event: DiscordSurfaceEvent) => void;
  threadCreate: (event: DiscordSurfaceEvent) => void;
  ready: () => void;
  error: (error: Error) => void;
  disconnect: () => void;
}

/**
 * Discord adapter that bridges Discord forum channels/threads to the forum system.
 * Uses discord.js to connect to Discord and listen for events.
 */
export class DiscordAdapter extends EventEmitter {
  readonly surface = 'discord' as const;
  readonly surfaceId: string;
  readonly capabilities: SurfaceCapabilities = {
    canCreateTopic: true,
    canCreatePost: true,
    canEditPost: false,
    canDeletePost: false,
    canUpdateTopic: false,
    supportsThreads: true,
    supportsAttachments: true,
    supportsReactions: true
  };

  private client: any = null;
  private config: DiscordAdapterConfig;
  private running = false;
  private mappedChannels = new Map<string, string>(); // Discord channelId -> forumId
  private eventQueue: DiscordSurfaceEvent[] = [];
  private cursorCounter = 0;

  constructor(config: DiscordAdapterConfig) {
    super();
    this.config = config;
    this.surfaceId = `discord:${config.guildId}`;
  }

  /**
   * Start the Discord adapter and connect to Discord
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      const { Client, GatewayIntentBits, Partials } = await import('discord.js');

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers
        ],
        partials: [Partials.Message, Partials.Channel, Partials.ThreadMember]
      });

      this.setupEventHandlers();

      await this.client.login(this.config.token);
      this.running = true;

      console.log(`[DiscordAdapter] Connected to Discord guild ${this.config.guildId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[DiscordAdapter] Failed to start:', err.message);
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Stop the Discord adapter and disconnect from Discord
   */
  async stop(): Promise<void> {
    if (!this.running || !this.client) {
      return;
    }

    try {
      this.client.removeAllListeners();
      await this.client.destroy();
      this.client = null;
      this.running = false;
      this.emit('disconnect');
      console.log('[DiscordAdapter] Disconnected from Discord');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[DiscordAdapter] Failed to stop cleanly:', err.message);
      this.emit('error', err);
    }
  }

  /**
   * Check if the adapter is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Map a Discord forum channel to a forum ID
   */
  async mapForumChannel(forumChannelId: string, forumId?: string): Promise<void> {
    this.mappedChannels.set(forumChannelId, forumId ?? forumChannelId);
    console.log(`[DiscordAdapter] Mapped channel ${forumChannelId} to forum ${forumId ?? forumChannelId}`);
  }

  /**
   * Unmap a Discord forum channel
   */
  unmapForumChannel(forumChannelId: string): void {
    this.mappedChannels.delete(forumChannelId);
  }

  /**
   * Get the mapped forum ID for a channel
   */
  getMappedForumId(channelId: string): string | undefined {
    return this.mappedChannels.get(channelId);
  }

  /**
   * Get all mapped channels
   */
  getMappedChannels(): Map<string, string> {
    return new Map(this.mappedChannels);
  }

  /**
   * Sync a Discord channel to a forum
   */
  async syncChannel(channelId: string, forumId: string): Promise<void> {
    if (!this.client || !this.running) {
      throw new Error('Discord adapter is not running');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    this.mappedChannels.set(channelId, forumId);
    console.log(`[DiscordAdapter] Synced channel ${channelId} to forum ${forumId}`);
  }

  /**
   * Sync a Discord thread to a topic
   * This is handled through external refs in the bridge layer
   */
  async syncThread(threadId: string, topicId: string): Promise<void> {
    // Thread syncing is handled at the bridge layer using external refs
    console.log(`[DiscordAdapter] Thread ${threadId} mapped to topic ${topicId}`);
  }

  /**
   * Send a message to a Discord thread
   */
  async sendToThread(threadId: string, content: string, authorName: string): Promise<string> {
    if (!this.client || !this.running) {
      throw new Error('Discord adapter is not running');
    }

    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) {
        throw new Error(`Thread ${threadId} not found or is not a thread`);
      }

      const message = await thread.send({
        content: `**${authorName}**: ${content}`
      });

      return message.id;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[DiscordAdapter] Failed to send to thread ${threadId}:`, err.message);
      throw err;
    }
  }

  /**
   * Poll for queued events
   */
  async poll(cursor?: string | null): Promise<SurfaceEventBatch<DiscordSurfaceEvent>> {
    const startIndex = cursor ? parseInt(cursor, 10) : 0;
    const events = this.eventQueue.slice(startIndex, startIndex + 100);
    const nextCursor = events.length > 0 ? String(startIndex + events.length) : cursor ?? null;

    return {
      events,
      nextCursor,
      hasMore: startIndex + events.length < this.eventQueue.length
    };
  }

  /**
   * Acknowledge an event (remove from queue)
   */
  async ack(event: DiscordSurfaceEvent): Promise<void> {
    const index = this.eventQueue.findIndex(e => e.externalEventId === event.externalEventId);
    if (index !== -1) {
      this.eventQueue.splice(index, 1);
    }
  }

  /**
   * Create a topic (thread) in Discord
   */
  async createTopic(
    forumId: string,
    title: string,
    body: string,
    _authorId: string
  ): Promise<ExternalRef> {
    if (!this.client || !this.running) {
      throw new Error('Discord adapter is not running');
    }

    // Find the Discord channel for this forum
    let channelId: string | null = null;
    for (const [discordChannelId, mappedForumId] of this.mappedChannels) {
      if (mappedForumId === forumId) {
        channelId = discordChannelId;
        break;
      }
    }

    if (!channelId) {
      throw new Error(`No Discord channel mapped for forum ${forumId}`);
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isThreadOnly()) {
      throw new Error(`Channel ${channelId} is not a forum channel`);
    }

    const thread = await channel.threads.create({
      name: title,
      message: { content: body }
    });

    return {
      id: `ref-${thread.id}`,
      surfaceId: this.surfaceId,
      surfaceKind: 'discord',
      externalId: thread.id,
      kind: 'topic',
      scope: channelId,
      scopeKind: 'channel'
    };
  }

  /**
   * Create a post (message) in a Discord thread
   */
  async createPost(
    topicId: string,
    body: string,
    _authorId: string,
    _parentPostId?: string | null
  ): Promise<ExternalRef> {
    const messageId = await this.sendToThread(topicId, body, 'Forum');

    return {
      id: `ref-${messageId}`,
      surfaceId: this.surfaceId,
      surfaceKind: 'discord',
      externalId: messageId,
      kind: 'post',
      scope: topicId,
      scopeKind: 'thread'
    };
  }

  /**
   * Set up Discord event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.once('ready', () => {
      console.log(`[DiscordAdapter] Bot ready as ${this.client.user?.tag}`);
      this.emit('ready');
    });

    this.client.on('messageCreate', (message: any) => {
      this.handleMessageCreate(message);
    });

    this.client.on('threadCreate', (thread: any) => {
      this.handleThreadCreate(thread);
    });

    this.client.on('error', (error: Error) => {
      console.error('[DiscordAdapter] Client error:', error.message);
      this.emit('error', error);
    });

    this.client.on('disconnect', () => {
      console.log('[DiscordAdapter] Client disconnected');
      this.running = false;
      this.emit('disconnect');
    });
  }

  /**
   * Handle incoming Discord messages
   */
  private handleMessageCreate(message: any): void {
    // Ignore bot messages to avoid loops
    if (message.author.bot) {
      return;
    }

    // Only process messages from mapped channels or threads in mapped channels
    const channelId = message.channel.isThread()
      ? message.channel.parentId
      : message.channel.id;

    if (!channelId || !this.mappedChannels.has(channelId)) {
      return;
    }

    const now = new Date().toISOString();
    const event: DiscordSurfaceEvent = {
      surfaceId: this.surfaceId,
      surfaceKind: 'discord',
      externalEventId: message.id,
      cursor: String(++this.cursorCounter),
      occurredAt: message.createdAt?.toISOString() ?? now,
      receivedAt: now,
      actor: {
        id: `ref-user-${message.author.id}`,
        surfaceId: this.surfaceId,
        surfaceKind: 'discord',
        externalId: message.author.id,
        kind: 'identity'
      },
      subject: {
        id: `ref-msg-${message.id}`,
        surfaceId: this.surfaceId,
        surfaceKind: 'discord',
        externalId: message.id,
        kind: 'post',
        scope: message.channel.isThread() ? message.channel.id : channelId,
        scopeKind: message.channel.isThread() ? 'thread' : 'channel'
      },
      payload: {
        type: 'post.created',
        guildId: message.guildId ?? null,
        channelId: channelId,
        threadId: message.channel.isThread() ? message.channel.id : null,
        messageId: message.id,
        authorId: message.author.id,
        entityType: 'message',
        body: message.content
      },
      metadata: {
        authorUsername: message.author.username,
        authorDisplayName: message.author.displayName ?? message.author.username,
        authorAvatar: message.author.avatar
          ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png`
          : null
      }
    };

    this.eventQueue.push(event);
    this.emit('messageCreate', event);
  }

  /**
   * Handle thread creation in forum channels
   */
  private handleThreadCreate(thread: any): void {
    if (!thread.parentId || !this.mappedChannels.has(thread.parentId)) {
      return;
    }

    const now = new Date().toISOString();
    const event: DiscordSurfaceEvent = {
      surfaceId: this.surfaceId,
      surfaceKind: 'discord',
      externalEventId: thread.id,
      cursor: String(++this.cursorCounter),
      occurredAt: thread.createdAt?.toISOString() ?? now,
      receivedAt: now,
      actor: thread.ownerId ? {
        id: `ref-user-${thread.ownerId}`,
        surfaceId: this.surfaceId,
        surfaceKind: 'discord',
        externalId: thread.ownerId,
        kind: 'identity'
      } : null,
      subject: {
        id: `ref-thread-${thread.id}`,
        surfaceId: this.surfaceId,
        surfaceKind: 'discord',
        externalId: thread.id,
        kind: 'topic',
        scope: thread.parentId,
        scopeKind: 'channel'
      },
      payload: {
        type: 'topic.created',
        guildId: thread.guildId ?? null,
        channelId: thread.parentId,
        threadId: thread.id,
        authorId: thread.ownerId ?? null,
        entityType: 'thread',
        title: thread.name,
        body: null
      }
    };

    this.eventQueue.push(event);
    this.emit('threadCreate', event);
  }

  /**
   * Get Discord user info
   */
  async getUserInfo(userId: string): Promise<{ id: string; username: string; displayName: string; avatarUrl: string | null } | null> {
    if (!this.client || !this.running) {
      return null;
    }

    try {
      const user = await this.client.users.fetch(userId);
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName ?? user.username,
        avatarUrl: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
          : null
      };
    } catch {
      return null;
    }
  }
}
