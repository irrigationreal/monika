import type { SurfaceEventEnvelope, ExternalRef, ExternalId } from '@irrigationreal/codex-forum-core';
import type { SurfaceAdapter, SurfaceCapabilities, SurfaceEventBatch } from './surface';
import { EventEmitter } from 'node:events';

export type MatrixEntityType = 'room' | 'thread' | 'event' | 'user';

export interface MatrixEventBase {
  roomId?: string | null;
  threadId?: string | null;
  eventId?: string | null;
  authorId?: string | null;
  entityType: MatrixEntityType;
}

export interface MatrixForumEventPayload extends MatrixEventBase {
  type: 'forum.created' | 'forum.updated';
  title?: string | null;
  description?: string | null;
}

export interface MatrixTopicEventPayload extends MatrixEventBase {
  type: 'topic.created' | 'topic.renamed' | 'topic.tagged' | 'topic.status.changed';
  title?: string | null;
  tags?: string[];
  status?: 'open' | 'locked' | 'archived';
  body?: string | null;
}

export interface MatrixPostEventPayload extends MatrixEventBase {
  type: 'post.created' | 'post.edited' | 'post.deleted';
  body?: string | null;
  parentEventId?: ExternalId | null;
}

export interface MatrixIdentityEventPayload extends MatrixEventBase {
  type: 'identity.synced';
  displayName?: string | null;
  avatarUrl?: string | null;
}

export type MatrixEventPayload =
  | MatrixForumEventPayload
  | MatrixTopicEventPayload
  | MatrixPostEventPayload
  | MatrixIdentityEventPayload;

export type MatrixSurfaceEvent = SurfaceEventEnvelope<MatrixEventPayload>;

export interface MatrixAdapterInterface extends SurfaceAdapter<MatrixSurfaceEvent> {
  readonly surface: 'matrix';
  mapRoom(roomId: string): Promise<void>;
}

// Config for the Matrix adapter
export interface MatrixAdapterConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
}

// Event types emitted by the adapter
export interface MatrixAdapterEvents {
  messageCreate: (event: MatrixSurfaceEvent) => void;
  roomCreate: (event: MatrixSurfaceEvent) => void;
  ready: () => void;
  error: (error: Error) => void;
  disconnect: () => void;
}

/**
 * Matrix adapter that bridges Matrix rooms to the forum system.
 * Uses matrix-js-sdk to connect to Matrix and listen for events.
 */
export class MatrixAdapter extends EventEmitter {
  readonly surface = 'matrix' as const;
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
  private config: MatrixAdapterConfig;
  private running = false;
  private mappedRooms = new Map<string, string>(); // Matrix roomId -> forumId
  private eventQueue: MatrixSurfaceEvent[] = [];
  private cursorCounter = 0;

  constructor(config: MatrixAdapterConfig) {
    super();
    this.config = config;
    // Use the user ID without the leading @ as the surface ID suffix
    const userIdSuffix = config.userId.replace(/^@/, '').split(':')[0] ?? 'matrix';
    this.surfaceId = `matrix:${userIdSuffix}`;
  }

  /**
   * Start the Matrix adapter and connect to Matrix
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      const matrixSdk = await import('matrix-js-sdk');

      this.client = matrixSdk.createClient({
        baseUrl: this.config.homeserverUrl,
        accessToken: this.config.accessToken,
        userId: this.config.userId
      });

      this.setupEventHandlers();

      // Start the client with sync
      await this.client.startClient({ initialSyncLimit: 10 });
      this.running = true;

      console.log(`[MatrixAdapter] Connected to Matrix homeserver ${this.config.homeserverUrl}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[MatrixAdapter] Failed to start:', err.message);
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Stop the Matrix adapter and disconnect from Matrix
   */
  async stop(): Promise<void> {
    if (!this.running || !this.client) {
      return;
    }

    try {
      this.client.removeAllListeners();
      this.client.stopClient();
      this.client = null;
      this.running = false;
      this.emit('disconnect');
      console.log('[MatrixAdapter] Disconnected from Matrix');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[MatrixAdapter] Failed to stop cleanly:', err.message);
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
   * Map a Matrix room to a forum ID
   */
  async mapRoom(roomId: string, forumId?: string): Promise<void> {
    this.mappedRooms.set(roomId, forumId ?? roomId);
    console.log(`[MatrixAdapter] Mapped room ${roomId} to forum ${forumId ?? roomId}`);
  }

  /**
   * Unmap a Matrix room
   */
  unmapRoom(roomId: string): void {
    this.mappedRooms.delete(roomId);
  }

  /**
   * Get the mapped forum ID for a room
   */
  getMappedForumId(roomId: string): string | undefined {
    return this.mappedRooms.get(roomId);
  }

  /**
   * Get all mapped rooms
   */
  getMappedRooms(): Map<string, string> {
    return new Map(this.mappedRooms);
  }

  /**
   * Sync a Matrix room to a forum
   */
  async syncRoom(roomId: string, forumId: string): Promise<void> {
    if (!this.client || !this.running) {
      throw new Error('Matrix adapter is not running');
    }

    // Verify room exists by attempting to get state
    try {
      await this.client.getRoom(roomId);
    } catch {
      throw new Error(`Room ${roomId} not found or not accessible`);
    }

    this.mappedRooms.set(roomId, forumId);
    console.log(`[MatrixAdapter] Synced room ${roomId} to forum ${forumId}`);
  }

  /**
   * Sync a Matrix thread to a topic
   * This is handled through external refs in the bridge layer
   */
  async syncThread(threadId: string, topicId: string): Promise<void> {
    // Thread syncing is handled at the bridge layer using external refs
    console.log(`[MatrixAdapter] Thread ${threadId} mapped to topic ${topicId}`);
  }

  /**
   * Send a message to a Matrix room
   */
  async sendToRoom(roomId: string, content: string, authorName: string): Promise<string> {
    if (!this.client || !this.running) {
      throw new Error('Matrix adapter is not running');
    }

    try {
      const formattedContent = `**${authorName}**: ${content}`;

      const result = await this.client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: formattedContent,
        format: 'org.matrix.custom.html',
        formatted_body: `<strong>${authorName}</strong>: ${content}`
      });

      return result.event_id;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[MatrixAdapter] Failed to send to room ${roomId}:`, err.message);
      throw err;
    }
  }

  /**
   * Send a message to a Matrix thread (reply to a specific event)
   */
  async sendToThread(roomId: string, threadRootEventId: string, content: string, authorName: string): Promise<string> {
    if (!this.client || !this.running) {
      throw new Error('Matrix adapter is not running');
    }

    try {
      const formattedContent = `**${authorName}**: ${content}`;

      const result = await this.client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: formattedContent,
        format: 'org.matrix.custom.html',
        formatted_body: `<strong>${authorName}</strong>: ${content}`,
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: threadRootEventId,
          is_falling_back: true,
          'm.in_reply_to': {
            event_id: threadRootEventId
          }
        }
      });

      return result.event_id;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[MatrixAdapter] Failed to send to thread ${threadRootEventId}:`, err.message);
      throw err;
    }
  }

  /**
   * Poll for queued events
   */
  async poll(cursor?: string | null): Promise<SurfaceEventBatch<MatrixSurfaceEvent>> {
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
  async ack(event: MatrixSurfaceEvent): Promise<void> {
    const index = this.eventQueue.findIndex(e => e.externalEventId === event.externalEventId);
    if (index !== -1) {
      this.eventQueue.splice(index, 1);
    }
  }

  /**
   * Create a topic (new thread in a room) in Matrix
   */
  async createTopic(
    forumId: string,
    title: string,
    body: string,
    _authorId: string
  ): Promise<ExternalRef> {
    if (!this.client || !this.running) {
      throw new Error('Matrix adapter is not running');
    }

    // Find the Matrix room for this forum
    let roomId: string | null = null;
    for (const [matrixRoomId, mappedForumId] of this.mappedRooms) {
      if (mappedForumId === forumId) {
        roomId = matrixRoomId;
        break;
      }
    }

    if (!roomId) {
      throw new Error(`No Matrix room mapped for forum ${forumId}`);
    }

    // Create a new message that will serve as the thread root
    const threadContent = `**${title}**\n\n${body}`;

    const result = await this.client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: threadContent,
      format: 'org.matrix.custom.html',
      formatted_body: `<strong>${title}</strong><br><br>${body}`
    });

    const eventId = result.event_id;

    return {
      id: `ref-${eventId}`,
      surfaceId: this.surfaceId,
      surfaceKind: 'matrix',
      externalId: eventId,
      kind: 'topic',
      scope: roomId,
      scopeKind: 'channel'
    };
  }

  /**
   * Create a post (message reply in thread) in Matrix
   */
  async createPost(
    topicId: string, // This is the thread root event ID
    body: string,
    _authorId: string,
    _parentPostId?: string | null
  ): Promise<ExternalRef> {
    // Find the room for this thread
    // topicId here is the external event ID of the thread root
    // We need to find which room it belongs to
    let roomId: string | null = null;

    // Search through mapped rooms to find where this thread exists
    for (const [matrixRoomId] of this.mappedRooms) {
      try {
        const room = this.client?.getRoom(matrixRoomId);
        if (room) {
          const timeline = room.getLiveTimeline();
          const events = timeline.getEvents();
          if (events.some((e: any) => e.getId() === topicId)) {
            roomId = matrixRoomId;
            break;
          }
        }
      } catch {
        // Room not accessible, continue
      }
    }

    if (!roomId) {
      // Fall back to trying to send directly - Matrix will handle the error
      roomId = Array.from(this.mappedRooms.keys())[0] ?? null;
    }

    if (!roomId) {
      throw new Error('No Matrix rooms mapped');
    }

    const eventId = await this.sendToThread(roomId, topicId, body, 'Forum');

    return {
      id: `ref-${eventId}`,
      surfaceId: this.surfaceId,
      surfaceKind: 'matrix',
      externalId: eventId,
      kind: 'post',
      scope: topicId,
      scopeKind: 'thread'
    };
  }

  /**
   * Set up Matrix event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.once('sync', (state: string) => {
      if (state === 'PREPARED') {
        console.log(`[MatrixAdapter] Client ready and synced`);
        this.emit('ready');
      }
    });

    this.client.on('Room.timeline', (event: any, room: any, toStartOfTimeline: boolean) => {
      // Ignore historical events loaded during initial sync
      if (toStartOfTimeline) {
        return;
      }
      this.handleTimelineEvent(event, room);
    });

    this.client.on('Room', (room: any) => {
      this.handleRoomCreate(room);
    });

    this.client.on('sync', (state: string, _prevState: string | null, data: any) => {
      if (state === 'ERROR') {
        const error = new Error(data?.error?.message ?? 'Matrix sync error');
        console.error('[MatrixAdapter] Sync error:', error.message);
        this.emit('error', error);
      }
    });
  }

  /**
   * Handle incoming Matrix timeline events (messages)
   */
  private handleTimelineEvent(event: any, room: any): void {
    // Only process message events
    if (event.getType() !== 'm.room.message') {
      return;
    }

    const roomId = room?.roomId ?? event.getRoomId();
    if (!roomId || !this.mappedRooms.has(roomId)) {
      return;
    }

    // Ignore our own messages to avoid loops
    const senderId = event.getSender();
    if (senderId === this.config.userId) {
      return;
    }

    const content = event.getContent();
    const body = content?.body;
    if (!body) {
      return;
    }

    // Check if this is a thread reply
    const relatesTo = content['m.relates_to'];
    const isThreadReply = relatesTo?.rel_type === 'm.thread';
    const threadRootId = isThreadReply ? relatesTo?.event_id : null;

    const eventId = event.getId();
    const timestamp = event.getTs();
    const now = new Date().toISOString();

    // Get sender profile info
    const senderMember = room?.getMember(senderId);
    const displayName = senderMember?.name ?? senderMember?.rawDisplayName ?? senderId;
    const avatarUrl = senderMember?.getAvatarUrl(this.config.homeserverUrl, 64, 64, 'scale', false) ?? null;

    const surfaceEvent: MatrixSurfaceEvent = {
      surfaceId: this.surfaceId,
      surfaceKind: 'matrix',
      externalEventId: eventId,
      cursor: String(++this.cursorCounter),
      occurredAt: new Date(timestamp).toISOString(),
      receivedAt: now,
      actor: {
        id: `ref-user-${senderId}`,
        surfaceId: this.surfaceId,
        surfaceKind: 'matrix',
        externalId: senderId,
        kind: 'identity'
      },
      subject: {
        id: `ref-event-${eventId}`,
        surfaceId: this.surfaceId,
        surfaceKind: 'matrix',
        externalId: eventId,
        kind: 'post',
        scope: threadRootId ?? roomId,
        scopeKind: threadRootId ? 'thread' : 'channel'
      },
      payload: {
        type: 'post.created',
        roomId: roomId,
        threadId: threadRootId,
        eventId: eventId,
        authorId: senderId,
        entityType: 'event',
        body: body
      },
      metadata: {
        authorDisplayName: displayName,
        authorAvatarUrl: avatarUrl
      }
    };

    this.eventQueue.push(surfaceEvent);
    this.emit('messageCreate', surfaceEvent);
  }

  /**
   * Handle room creation/invitation events
   */
  private handleRoomCreate(room: any): void {
    const roomId = room?.roomId;
    if (!roomId) {
      return;
    }

    // Only emit event if this room is in our mapped rooms or we're auto-mapping
    // For now, just log it
    console.log(`[MatrixAdapter] Joined room: ${roomId}`);

    // If the room is already mapped, emit a forum.created event
    if (this.mappedRooms.has(roomId)) {
      const now = new Date().toISOString();
      const roomName = room.name ?? 'Unnamed Room';

      const surfaceEvent: MatrixSurfaceEvent = {
        surfaceId: this.surfaceId,
        surfaceKind: 'matrix',
        externalEventId: `room-${roomId}`,
        cursor: String(++this.cursorCounter),
        occurredAt: now,
        receivedAt: now,
        actor: null,
        subject: {
          id: `ref-room-${roomId}`,
          surfaceId: this.surfaceId,
          surfaceKind: 'matrix',
          externalId: roomId,
          kind: 'forum',
          scope: null,
          scopeKind: null
        },
        payload: {
          type: 'forum.created',
          roomId: roomId,
          threadId: null,
          eventId: null,
          authorId: null,
          entityType: 'room',
          title: roomName,
          description: room.topic ?? null
        }
      };

      this.eventQueue.push(surfaceEvent);
      this.emit('roomCreate', surfaceEvent);
    }
  }

  /**
   * Get Matrix user info
   */
  async getUserInfo(userId: string): Promise<{ id: string; displayName: string; avatarUrl: string | null } | null> {
    if (!this.client || !this.running) {
      return null;
    }

    try {
      const profile = await this.client.getProfileInfo(userId);
      return {
        id: userId,
        displayName: profile.displayname ?? userId,
        avatarUrl: profile.avatar_url
          ? this.client.mxcUrlToHttp(profile.avatar_url, 64, 64, 'scale')
          : null
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the list of joined rooms
   */
  getJoinedRooms(): string[] {
    if (!this.client || !this.running) {
      return [];
    }

    try {
      const rooms = this.client.getRooms();
      return rooms.map((room: any) => room.roomId);
    } catch {
      return [];
    }
  }

  /**
   * Get room info
   */
  getRoomInfo(roomId: string): { id: string; name: string; topic: string | null } | null {
    if (!this.client || !this.running) {
      return null;
    }

    try {
      const room = this.client.getRoom(roomId);
      if (!room) {
        return null;
      }

      return {
        id: roomId,
        name: room.name ?? 'Unnamed Room',
        topic: room.topic ?? null
      };
    } catch {
      return null;
    }
  }
}
