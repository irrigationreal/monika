import { MatrixAdapter, type MatrixSurfaceEvent, type MatrixPostEventPayload } from '@irrigationreal/codex-forum-adapters';
import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';
import type { AgentBridge } from '../agentBridge';

export interface MatrixBridgeConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  defaultForumId?: string | null;
}

export interface MatrixBridgeStatus {
  connected: boolean;
  homeserverUrl: string;
  userId: string;
  surfaceId: string;
  mappedRooms: Array<{ roomId: string; forumId: string }>;
  error?: string | null;
}

/**
 * Bridge between Matrix adapter and ForumStore.
 * Handles incoming Matrix messages by creating identities and posts,
 * and handles outgoing forum posts by sending to Matrix rooms.
 */
export class MatrixBridge {
  private adapter: MatrixAdapter | null = null;
  private config: MatrixBridgeConfig;
  private store: ForumStore;
  private bus: StreamBusInterface;
  private codex: AgentBridge | null;
  private topicSubscriptions = new Map<string, () => void>();
  private lastError: string | null = null;
  // Map of thread root event ID -> room ID for sending replies
  private threadRoomMap = new Map<string, string>();

  constructor(
    store: ForumStore,
    bus: StreamBusInterface,
    config: MatrixBridgeConfig,
    codex?: AgentBridge | null
  ) {
    this.store = store;
    this.bus = bus;
    this.config = config;
    this.codex = codex ?? null;
  }

  /**
   * Connect to Matrix and start listening for events
   */
  async connect(): Promise<void> {
    if (this.adapter?.isRunning()) {
      console.log('[MatrixBridge] Already connected');
      return;
    }

    try {
      this.adapter = new MatrixAdapter({
        homeserverUrl: this.config.homeserverUrl,
        accessToken: this.config.accessToken,
        userId: this.config.userId
      });

      // Set up event handlers
      this.adapter.on('messageCreate', (event) => this.handleMessageCreate(event));
      this.adapter.on('error', (error) => {
        console.error('[MatrixBridge] Adapter error:', error.message);
        this.lastError = error.message;
      });
      this.adapter.on('disconnect', () => {
        console.log('[MatrixBridge] Adapter disconnected');
      });

      await this.adapter.start();
      this.lastError = null;

      console.log('[MatrixBridge] Connected to Matrix');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastError = err.message;
      console.error('[MatrixBridge] Failed to connect:', err.message);
      throw err;
    }
  }

  /**
   * Disconnect from Matrix
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
    this.threadRoomMap.clear();

    await this.adapter.stop();
    this.adapter = null;

    console.log('[MatrixBridge] Disconnected from Matrix');
  }

  /**
   * Check if connected to Matrix
   */
  isConnected(): boolean {
    return this.adapter?.isRunning() ?? false;
  }

  /**
   * Get the current status of the bridge
   */
  getStatus(): MatrixBridgeStatus {
    const mappedRooms = this.adapter
      ? Array.from(this.adapter.getMappedRooms().entries()).map(([roomId, forumId]) => ({
          roomId,
          forumId
        }))
      : [];

    return {
      connected: this.isConnected(),
      homeserverUrl: this.config.homeserverUrl,
      userId: this.config.userId,
      surfaceId: this.adapter?.surfaceId ?? `matrix:${this.config.userId.replace(/^@/, '').split(':')[0]}`,
      mappedRooms,
      error: this.lastError
    };
  }

  /**
   * Map a Matrix room to a forum
   */
  async mapRoom(roomId: string, forumId: string): Promise<void> {
    if (!this.adapter) {
      throw new Error('Matrix adapter is not connected');
    }

    await this.adapter.syncRoom(roomId, forumId);

    // Create external ref for the room -> forum mapping
    const existing = this.store.getExternalRefByExternal(
      this.adapter.surfaceId,
      'matrix',
      roomId
    );

    if (!existing) {
      this.store.createExternalRef({
        surfaceId: this.adapter.surfaceId,
        surfaceKind: 'matrix',
        externalId: roomId,
        kind: 'forum',
        scope: this.config.homeserverUrl,
        scopeKind: 'homeserver',
        mappedForumId: forumId
      });
    }

    console.log(`[MatrixBridge] Mapped room ${roomId} to forum ${forumId}`);
  }

  /**
   * Unmap a Matrix room
   */
  unmapRoom(roomId: string): void {
    if (!this.adapter) {
      return;
    }

    this.adapter.unmapRoom(roomId);
    console.log(`[MatrixBridge] Unmapped room ${roomId}`);
  }

  /**
   * Handle incoming Matrix messages
   */
  private async handleMessageCreate(event: MatrixSurfaceEvent): Promise<void> {
    const payload = event.payload as MatrixPostEventPayload;

    if (payload.type !== 'post.created' || !payload.body) {
      return;
    }

    const roomId = payload.roomId;
    const threadId = payload.threadId;

    if (!roomId) {
      // Message has no room, skip
      return;
    }

    try {
      // Look up or create identity for Matrix user
      const authorId = payload.authorId;
      if (!authorId) {
        console.warn('[MatrixBridge] Message has no author ID');
        return;
      }

      const identity = await this.getOrCreateIdentity(authorId, event);

      // Determine if this is a thread reply or a new top-level message
      if (threadId) {
        // This is a reply in an existing thread
        await this.handleThreadReply(event, identity, roomId, threadId, payload);
      } else {
        // This is a new top-level message - create a new topic
        await this.handleNewMessage(event, identity, roomId, payload);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[MatrixBridge] Failed to handle message:', err.message);
    }
  }

  /**
   * Handle a thread reply (message in an existing thread)
   */
  private async handleThreadReply(
    event: MatrixSurfaceEvent,
    identity: { id: string; display_name: string },
    roomId: string,
    threadId: string,
    payload: MatrixPostEventPayload
  ): Promise<void> {
    // Look up mapped topic for this thread
    const topicRef = this.store.getExternalRefByExternal(
      event.surfaceId,
      'matrix',
      threadId
    );

    if (!topicRef?.mapped_topic_id) {
      // Thread not mapped yet - this could be a reply to a message we haven't seen
      // Try to create a topic for it
      console.log(`[MatrixBridge] No topic mapping for thread ${threadId}, creating new topic`);
      await this.createTopicFromThread(event, identity, roomId, threadId, payload);
      return;
    }

    // Check if message already exists (prevent duplicates)
    const eventId = payload.eventId;
    if (eventId) {
      const messageRef = this.store.getExternalRefByExternal(
        event.surfaceId,
        'matrix',
        eventId
      );

      if (messageRef?.mapped_post_id) {
        // Already processed
        return;
      }
    }

    // Create post in forum
    const post = this.store.createPost({
      topicId: topicRef.mapped_topic_id,
      body: payload.body!,
      authorId: identity.id,
      parentPostId: null
    });

    // Create external ref for event -> post mapping
    if (eventId) {
      this.store.createExternalRef({
        surfaceId: event.surfaceId,
        surfaceKind: 'matrix',
        externalId: eventId,
        kind: 'post',
        scope: threadId,
        scopeKind: 'thread',
        mappedTopicId: topicRef.mapped_topic_id,
        mappedPostId: post.id
      });
    }

    console.log(`[MatrixBridge] Created post ${post.id} from Matrix event ${eventId}`);

    // Trigger robot response if available
    if (this.codex) {
      const session = this.store.ensureSession({ topicId: topicRef.mapped_topic_id });
      this.store.createSessionMessage(session.id, 'user', payload.body!, 'public');
      await this.codex.sendUserMessage(topicRef.mapped_topic_id, payload.body!, post.id);
    }
  }

  /**
   * Handle a new top-level message (create a new topic)
   */
  private async handleNewMessage(
    event: MatrixSurfaceEvent,
    identity: { id: string; display_name: string },
    roomId: string,
    payload: MatrixPostEventPayload
  ): Promise<void> {
    const eventId = payload.eventId;

    // Check if this message is already a topic
    if (eventId) {
      const existingRef = this.store.getExternalRefByExternal(
        event.surfaceId,
        'matrix',
        eventId
      );

      if (existingRef?.mapped_topic_id) {
        // Already mapped as a topic
        return;
      }
    }

    // Look up forum for this room
    const roomRef = this.store.getExternalRefByExternal(
      event.surfaceId,
      'matrix',
      roomId
    );

    const forumId = roomRef?.mapped_forum_id ?? this.config.defaultForumId;
    if (!forumId) {
      console.log(`[MatrixBridge] No forum mapping for room ${roomId}`);
      return;
    }

    // Create topic in forum
    // Use the first line or first 100 chars as title
    const body = payload.body!;
    const firstLine = body.split('\n')[0] ?? body;
    const title = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;

    const { topic, post } = this.store.createTopic({
      forumId,
      title: title,
      body: body,
      authorId: identity.id
    });

    // Create external ref for event -> topic mapping
    if (eventId) {
      this.store.createExternalRef({
        surfaceId: event.surfaceId,
        surfaceKind: 'matrix',
        externalId: eventId,
        kind: 'topic',
        scope: roomId,
        scopeKind: 'room',
        mappedForumId: forumId,
        mappedTopicId: topic.id
      });

      // Store the room ID for this thread so we can send replies back
      this.threadRoomMap.set(eventId, roomId);
    }

    console.log(`[MatrixBridge] Created topic ${topic.id} from Matrix event ${eventId}`);

    // Subscribe to topic events for sending robot replies back to Matrix
    if (eventId) {
      this.subscribeToTopic(topic.id, roomId, eventId);
    }

    // Trigger robot response if available
    if (this.codex && body) {
      const session = this.store.ensureSession({ topicId: topic.id });
      this.store.createSessionMessage(session.id, 'user', body, 'public');
      await this.codex.sendUserMessage(topic.id, body, post.id);
    }
  }

  /**
   * Create a topic from a thread reply when the thread root wasn't seen
   */
  private async createTopicFromThread(
    event: MatrixSurfaceEvent,
    identity: { id: string; display_name: string },
    roomId: string,
    threadId: string,
    payload: MatrixPostEventPayload
  ): Promise<void> {
    // Look up forum for this room
    const roomRef = this.store.getExternalRefByExternal(
      event.surfaceId,
      'matrix',
      roomId
    );

    const forumId = roomRef?.mapped_forum_id ?? this.config.defaultForumId;
    if (!forumId) {
      console.log(`[MatrixBridge] No forum mapping for room ${roomId}`);
      return;
    }

    // Create topic for the thread
    const body = payload.body!;
    const title = `Matrix Thread ${threadId.slice(-8)}`;

    const { topic, post } = this.store.createTopic({
      forumId,
      title: title,
      body: body,
      authorId: identity.id
    });

    // Create external ref for thread -> topic mapping
    this.store.createExternalRef({
      surfaceId: event.surfaceId,
      surfaceKind: 'matrix',
      externalId: threadId,
      kind: 'topic',
      scope: roomId,
      scopeKind: 'room',
      mappedForumId: forumId,
      mappedTopicId: topic.id
    });

    // Also map the current event as the first post
    const eventId = payload.eventId;
    if (eventId) {
      this.store.createExternalRef({
        surfaceId: event.surfaceId,
        surfaceKind: 'matrix',
        externalId: eventId,
        kind: 'post',
        scope: threadId,
        scopeKind: 'thread',
        mappedTopicId: topic.id,
        mappedPostId: post.id
      });
    }

    // Store the room ID for this thread
    this.threadRoomMap.set(threadId, roomId);

    console.log(`[MatrixBridge] Created topic ${topic.id} from Matrix thread ${threadId}`);

    // Subscribe to topic events
    this.subscribeToTopic(topic.id, roomId, threadId);

    // Trigger robot response if available
    if (this.codex && body) {
      const session = this.store.ensureSession({ topicId: topic.id });
      this.store.createSessionMessage(session.id, 'user', body, 'public');
      await this.codex.sendUserMessage(topic.id, body, post.id);
    }
  }

  /**
   * Subscribe to topic events to send robot replies to Matrix
   */
  private subscribeToTopic(topicId: string, roomId: string, threadRootEventId: string): void {
    if (this.topicSubscriptions.has(topicId)) {
      return;
    }

    const unsubscribe = this.bus.subscribe(topicId, (event) => {
      if (event.type === 'assistant_message' && event.data) {
        const text = (event.data as { text?: string }).text;
        if (text) {
          this.sendRobotReplyToMatrix(roomId, threadRootEventId, text).catch((err) => {
            console.error('[MatrixBridge] Failed to send robot reply:', err.message);
          });
        }
      }
    });

    this.topicSubscriptions.set(topicId, unsubscribe);
  }

  /**
   * Send a robot reply to Matrix
   */
  private async sendRobotReplyToMatrix(roomId: string, threadRootEventId: string, content: string): Promise<void> {
    if (!this.adapter?.isRunning()) {
      console.warn('[MatrixBridge] Cannot send reply - adapter not running');
      return;
    }

    try {
      const robotIdentity = this.store.getIdentityByKind('robot');
      const authorName = robotIdentity?.display_name ?? 'Robot';

      await this.adapter.sendToThread(roomId, threadRootEventId, content, authorName);
      console.log(`[MatrixBridge] Sent robot reply to thread ${threadRootEventId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[MatrixBridge] Failed to send to Matrix:', err.message);
      throw err;
    }
  }

  /**
   * Get or create an identity for a Matrix user
   */
  private async getOrCreateIdentity(
    matrixUserId: string,
    event: MatrixSurfaceEvent
  ): Promise<{ id: string; display_name: string }> {
    // Check if identity already exists via external ref
    const existingRef = this.store.getExternalRefByExternal(
      event.surfaceId,
      'matrix',
      matrixUserId
    );

    if (existingRef?.mapped_identity_id) {
      const identity = this.store.getIdentity(existingRef.mapped_identity_id);
      if (identity) {
        return { id: identity.id, display_name: identity.display_name };
      }
    }

    // Get user info from event metadata
    const metadata = event.metadata as {
      authorDisplayName?: string;
      authorAvatarUrl?: string;
    } | undefined;

    const displayName = metadata?.authorDisplayName ?? matrixUserId.split(':')[0]?.replace(/^@/, '') ?? `Matrix User`;
    const avatarUrl = metadata?.authorAvatarUrl ?? null;

    // Create new identity
    const identity = this.store.createIdentity(displayName, 'matrix', avatarUrl);

    // Create external ref for Matrix user -> identity mapping
    this.store.createExternalRef({
      surfaceId: event.surfaceId,
      surfaceKind: 'matrix',
      externalId: matrixUserId,
      kind: 'identity',
      scope: this.config.homeserverUrl,
      scopeKind: 'homeserver',
      mappedIdentityId: identity.id
    });

    console.log(`[MatrixBridge] Created identity ${identity.id} for Matrix user ${matrixUserId}`);

    return { id: identity.id, display_name: identity.display_name };
  }

  /**
   * Send a message to a Matrix room (external API)
   */
  async sendToRoom(roomId: string, content: string, authorName?: string): Promise<string | null> {
    if (!this.adapter?.isRunning()) {
      throw new Error('Matrix adapter is not connected');
    }

    const name = authorName ?? 'Forum';
    return this.adapter.sendToRoom(roomId, content, name);
  }

  /**
   * Send a message to a Matrix thread (external API)
   */
  async sendToThread(roomId: string, threadRootEventId: string, content: string, authorName?: string): Promise<string | null> {
    if (!this.adapter?.isRunning()) {
      throw new Error('Matrix adapter is not connected');
    }

    const name = authorName ?? 'Forum';
    return this.adapter.sendToThread(roomId, threadRootEventId, content, name);
  }

  /**
   * Get the list of joined rooms
   */
  getJoinedRooms(): string[] {
    return this.adapter?.getJoinedRooms() ?? [];
  }

  /**
   * Get room info
   */
  getRoomInfo(roomId: string): { id: string; name: string; topic: string | null } | null {
    return this.adapter?.getRoomInfo(roomId) ?? null;
  }

  /**
   * Get the underlying adapter (for advanced use cases)
   */
  getAdapter(): MatrixAdapter | null {
    return this.adapter;
  }
}
