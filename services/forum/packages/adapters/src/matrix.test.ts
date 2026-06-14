import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MatrixAdapter, type MatrixAdapterConfig, type MatrixSurfaceEvent } from './matrix';

// Store mock client and event handlers at module level for access in tests
let mockClientInstance: any = null;
const eventHandlers: Record<string, ((...args: any[]) => void)[]> = {};
const onceHandlers: Record<string, ((...args: any[]) => void)[]> = {};

// Mock matrix-js-sdk
vi.mock('matrix-js-sdk', () => {
  return {
    createClient: vi.fn(() => {
      mockClientInstance = {
        startClient: vi.fn().mockResolvedValue(undefined),
        stopClient: vi.fn(),
        removeAllListeners: vi.fn(() => {
          Object.keys(eventHandlers).forEach((key) => delete eventHandlers[key]);
          Object.keys(onceHandlers).forEach((key) => delete onceHandlers[key]);
        }),
        sendMessage: vi.fn().mockResolvedValue({ event_id: '$mock-event-id' }),
        getRoom: vi.fn(),
        getRooms: vi.fn().mockReturnValue([]),
        getProfileInfo: vi.fn(),
        mxcUrlToHttp: vi.fn((url) => `https://matrix.example.org/_matrix/media/${url}`),
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          if (!eventHandlers[event]) {
            eventHandlers[event] = [];
          }
          eventHandlers[event].push(handler);
          return mockClientInstance;
        }),
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
          if (!onceHandlers[event]) {
            onceHandlers[event] = [];
          }
          onceHandlers[event].push(handler);
          return mockClientInstance;
        })
      };
      return mockClientInstance;
    })
  };
});

// Helper to trigger events
function triggerEvent(eventName: string, ...args: any[]) {
  const handlers = eventHandlers[eventName] || [];
  handlers.forEach((handler) => handler(...args));
}

function triggerOnceEvent(eventName: string, ...args: any[]) {
  const handlers = onceHandlers[eventName] || [];
  handlers.forEach((handler) => handler(...args));
  delete onceHandlers[eventName];
}

describe('MatrixAdapter', () => {
  const validConfig: MatrixAdapterConfig = {
    homeserverUrl: 'https://matrix.example.org',
    accessToken: 'test-access-token-12345',
    userId: '@testbot:example.org'
  };

  let adapter: MatrixAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear event handlers
    Object.keys(eventHandlers).forEach((key) => delete eventHandlers[key]);
    Object.keys(onceHandlers).forEach((key) => delete onceHandlers[key]);
    mockClientInstance = null;
    adapter = new MatrixAdapter(validConfig);
  });

  afterEach(async () => {
    // Clean up running adapter if needed
    if (adapter.isRunning()) {
      await adapter.stop();
    }
  });

  describe('Construction', () => {
    it('should construct with valid config', () => {
      const instance = new MatrixAdapter(validConfig);
      expect(instance).toBeInstanceOf(MatrixAdapter);
      expect(instance.surface).toBe('matrix');
    });

    it('should store config correctly', () => {
      const instance = new MatrixAdapter(validConfig);
      // userId @testbot:example.org -> testbot
      expect(instance.surfaceId).toBe('matrix:testbot');
    });

    it('should initialize with default capabilities', () => {
      const instance = new MatrixAdapter(validConfig);
      expect(instance.capabilities).toEqual({
        canCreateTopic: true,
        canCreatePost: true,
        canEditPost: false,
        canDeletePost: false,
        canUpdateTopic: false,
        supportsThreads: true,
        supportsAttachments: true,
        supportsReactions: true
      });
    });

    it('should initialize with running state as false', () => {
      const instance = new MatrixAdapter(validConfig);
      expect(instance.isRunning()).toBe(false);
    });
  });

  describe('surfaceId generation', () => {
    it('should generate surfaceId from userId without @ prefix', () => {
      const config: MatrixAdapterConfig = {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'token',
        userId: '@mybot:matrix.org'
      };
      const instance = new MatrixAdapter(config);
      expect(instance.surfaceId).toBe('matrix:mybot');
    });

    it('should extract local part before colon', () => {
      const config: MatrixAdapterConfig = {
        homeserverUrl: 'https://homeserver.example',
        accessToken: 'token',
        userId: '@forum-bridge:homeserver.example'
      };
      const instance = new MatrixAdapter(config);
      expect(instance.surfaceId).toBe('matrix:forum-bridge');
    });

    it('should handle userId without @ prefix gracefully', () => {
      const config: MatrixAdapterConfig = {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'token',
        userId: 'noprefix:matrix.org'
      };
      const instance = new MatrixAdapter(config);
      expect(instance.surfaceId).toBe('matrix:noprefix');
    });

    it('should have unique surfaceIds for different users', () => {
      const adapter1 = new MatrixAdapter({
        homeserverUrl: 'https://matrix.org',
        accessToken: 'token',
        userId: '@user1:matrix.org'
      });
      const adapter2 = new MatrixAdapter({
        homeserverUrl: 'https://matrix.org',
        accessToken: 'token',
        userId: '@user2:matrix.org'
      });
      expect(adapter1.surfaceId).not.toBe(adapter2.surfaceId);
    });

    it('should handle empty local part by using empty string', () => {
      const config: MatrixAdapterConfig = {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'token',
        userId: '@:matrix.org'
      };
      const instance = new MatrixAdapter(config);
      // The code uses ?? 'matrix' but split on ':' with empty string before colon gives ''
      // Actual behavior: '@:matrix.org' -> ':matrix.org' -> split(':')[0] = ''
      // '' ?? 'matrix' = '' (empty string is not nullish)
      expect(instance.surfaceId).toBe('matrix:');
    });
  });

  describe('Room mapping (mapRoom)', () => {
    it('should map a room with explicit forumId', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-456');
      expect(adapter.getMappedForumId('!room123:example.org')).toBe('forum-456');
    });

    it('should use roomId as forumId when forumId not provided', async () => {
      await adapter.mapRoom('!room789:example.org');
      expect(adapter.getMappedForumId('!room789:example.org')).toBe('!room789:example.org');
    });

    it('should overwrite existing mapping when same room mapped again', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-old');
      await adapter.mapRoom('!room123:example.org', 'forum-new');
      expect(adapter.getMappedForumId('!room123:example.org')).toBe('forum-new');
    });

    it('should support multiple room mappings', async () => {
      await adapter.mapRoom('!room1:example.org', 'forum-1');
      await adapter.mapRoom('!room2:example.org', 'forum-2');
      await adapter.mapRoom('!room3:example.org', 'forum-3');

      expect(adapter.getMappedForumId('!room1:example.org')).toBe('forum-1');
      expect(adapter.getMappedForumId('!room2:example.org')).toBe('forum-2');
      expect(adapter.getMappedForumId('!room3:example.org')).toBe('forum-3');
    });
  });

  describe('Room unmapping (unmapRoom)', () => {
    it('should unmap an existing room', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-456');
      adapter.unmapRoom('!room123:example.org');
      expect(adapter.getMappedForumId('!room123:example.org')).toBeUndefined();
    });

    it('should not throw when unmapping non-existent room', () => {
      expect(() => adapter.unmapRoom('!non-existent:example.org')).not.toThrow();
    });

    it('should only unmap the specified room', async () => {
      await adapter.mapRoom('!room1:example.org', 'forum-1');
      await adapter.mapRoom('!room2:example.org', 'forum-2');
      adapter.unmapRoom('!room1:example.org');

      expect(adapter.getMappedForumId('!room1:example.org')).toBeUndefined();
      expect(adapter.getMappedForumId('!room2:example.org')).toBe('forum-2');
    });
  });

  describe('getMappedRooms', () => {
    it('should return empty Map when no rooms mapped', () => {
      const rooms = adapter.getMappedRooms();
      expect(rooms).toBeInstanceOf(Map);
      expect(rooms.size).toBe(0);
    });

    it('should return a copy of the mapped rooms', async () => {
      await adapter.mapRoom('!room1:example.org', 'forum-1');
      await adapter.mapRoom('!room2:example.org', 'forum-2');

      const rooms = adapter.getMappedRooms();
      expect(rooms.size).toBe(2);
      expect(rooms.get('!room1:example.org')).toBe('forum-1');
      expect(rooms.get('!room2:example.org')).toBe('forum-2');
    });

    it('should return independent copy (modifications do not affect adapter)', async () => {
      await adapter.mapRoom('!room1:example.org', 'forum-1');

      const rooms = adapter.getMappedRooms();
      rooms.set('!modified:example.org', 'forum-modified');

      expect(adapter.getMappedForumId('!modified:example.org')).toBeUndefined();
    });
  });

  describe('Event queue operations (poll)', () => {
    it('should return empty batch when no events queued', async () => {
      const batch = await adapter.poll();
      expect(batch.events).toEqual([]);
      expect(batch.hasMore).toBe(false);
    });

    it('should return null cursor when no events and no cursor provided', async () => {
      const batch = await adapter.poll();
      expect(batch.nextCursor).toBeNull();
    });

    it('should return provided cursor when no events', async () => {
      const batch = await adapter.poll('10');
      expect(batch.nextCursor).toBe('10');
    });

    it('should support cursor-based pagination', async () => {
      const batch = await adapter.poll('0');
      expect(batch.events).toBeInstanceOf(Array);
    });

    it('should calculate hasMore correctly', async () => {
      const batch = await adapter.poll();
      expect(batch.hasMore).toBe(false);
    });

    it('should return events with updated cursor', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const mockEvent = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@otheruser:example.org',
        getId: () => '$test-event-123',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Test message' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({
          name: 'Other User',
          getAvatarUrl: () => null
        })
      };

      triggerEvent('Room.timeline', mockEvent, mockRoom, false);

      const batch = await adapter.poll();
      expect(batch.events.length).toBe(1);
      expect(batch.nextCursor).toBe('1');
    });
  });

  describe('Event acknowledgement (ack)', () => {
    it('should not throw when acking non-existent event', async () => {
      const fakeEvent: MatrixSurfaceEvent = {
        surfaceId: adapter.surfaceId,
        surfaceKind: 'matrix',
        externalEventId: '$non-existent-event',
        cursor: '999',
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        actor: null,
        subject: {
          id: 'ref-test',
          surfaceId: adapter.surfaceId,
          surfaceKind: 'matrix',
          externalId: '$test-123',
          kind: 'post'
        },
        payload: {
          type: 'post.created',
          entityType: 'event',
          roomId: null,
          body: 'Test'
        }
      };

      await expect(adapter.ack(fakeEvent)).resolves.not.toThrow();
    });

    it('should remove acknowledged event from queue', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const mockEvent = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@otheruser:example.org',
        getId: () => '$event-to-ack',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Test message' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({
          name: 'Other User',
          getAvatarUrl: () => null
        })
      };

      triggerEvent('Room.timeline', mockEvent, mockRoom, false);

      // Poll to get events
      const beforeAck = await adapter.poll();
      expect(beforeAck.events.length).toBe(1);

      const eventToAck = beforeAck.events[0];
      await adapter.ack(eventToAck);

      // Check that event was removed
      const afterAck = await adapter.poll();
      expect(afterAck.events.length).toBe(0);
    });
  });

  describe('isRunning() state management', () => {
    it('should return false initially', () => {
      expect(adapter.isRunning()).toBe(false);
    });

    it('should return true after start()', async () => {
      await adapter.start();
      expect(adapter.isRunning()).toBe(true);
    });

    it('should return false after stop()', async () => {
      await adapter.start();
      expect(adapter.isRunning()).toBe(true);
      await adapter.stop();
      expect(adapter.isRunning()).toBe(false);
    });

    it('should not change state when start() called while already running', async () => {
      await adapter.start();
      expect(adapter.isRunning()).toBe(true);
      await adapter.start(); // Call again
      expect(adapter.isRunning()).toBe(true);
    });

    it('should not throw when stop() called while not running', async () => {
      expect(adapter.isRunning()).toBe(false);
      await expect(adapter.stop()).resolves.not.toThrow();
      expect(adapter.isRunning()).toBe(false);
    });
  });

  describe('Start and Stop lifecycle', () => {
    it('should create Matrix client with correct config', async () => {
      await adapter.start();

      const matrixSdk = await import('matrix-js-sdk');
      expect(matrixSdk.createClient).toHaveBeenCalledWith({
        baseUrl: validConfig.homeserverUrl,
        accessToken: validConfig.accessToken,
        userId: validConfig.userId
      });
    });

    it('should call startClient with initialSyncLimit', async () => {
      await adapter.start();

      expect(mockClientInstance.startClient).toHaveBeenCalledWith({ initialSyncLimit: 10 });
    });

    it('should emit ready event when sync is PREPARED', async () => {
      const readyHandler = vi.fn();
      adapter.on('ready', readyHandler);

      await adapter.start();

      triggerOnceEvent('sync', 'PREPARED');

      expect(readyHandler).toHaveBeenCalled();
    });

    it('should emit disconnect event after stop', async () => {
      const disconnectHandler = vi.fn();
      adapter.on('disconnect', disconnectHandler);

      await adapter.start();
      await adapter.stop();

      expect(disconnectHandler).toHaveBeenCalled();
    });

    it('should clean up client on stop', async () => {
      await adapter.start();

      expect(mockClientInstance).not.toBeNull();

      await adapter.stop();

      expect(mockClientInstance.removeAllListeners).toHaveBeenCalled();
      expect(mockClientInstance.stopClient).toHaveBeenCalled();
    });
  });

  describe('Event handling - Timeline events (messages)', () => {
    it('should ignore non-message events', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const nonMessageEvent = {
        getType: () => 'm.room.member',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@otheruser:example.org',
        getId: () => '$member-event',
        getTs: () => Date.now(),
        getContent: () => ({ membership: 'join' })
      };

      const mockRoom = { roomId: '!room123:example.org' };
      triggerEvent('Room.timeline', nonMessageEvent, mockRoom, false);

      const batch = await adapter.poll();
      const memberEvents = batch.events.filter((e) => e.externalEventId === '$member-event');
      expect(memberEvents.length).toBe(0);
    });

    it('should ignore messages from self (loop prevention)', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const selfMessage = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => validConfig.userId, // Same as adapter's userId
        getId: () => '$self-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'My own message' })
      };

      const mockRoom = { roomId: '!room123:example.org' };
      triggerEvent('Room.timeline', selfMessage, mockRoom, false);

      const batch = await adapter.poll();
      const selfEvents = batch.events.filter((e) => e.externalEventId === '$self-message');
      expect(selfEvents.length).toBe(0);
    });

    it('should ignore messages from unmapped rooms', async () => {
      await adapter.start();

      const unmappedMessage = {
        getType: () => 'm.room.message',
        getRoomId: () => '!unmapped:example.org',
        getSender: () => '@otheruser:example.org',
        getId: () => '$unmapped-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Message in unmapped room' })
      };

      const mockRoom = { roomId: '!unmapped:example.org' };
      triggerEvent('Room.timeline', unmappedMessage, mockRoom, false);

      const batch = await adapter.poll();
      const unmappedEvents = batch.events.filter((e) => e.externalEventId === '$unmapped-message');
      expect(unmappedEvents.length).toBe(0);
    });

    it('should ignore historical events (toStartOfTimeline = true)', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const historicalMessage = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@otheruser:example.org',
        getId: () => '$historical-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Historical message' })
      };

      const mockRoom = { roomId: '!room123:example.org' };
      // toStartOfTimeline = true means it's a historical event
      triggerEvent('Room.timeline', historicalMessage, mockRoom, true);

      const batch = await adapter.poll();
      const historicalEvents = batch.events.filter(
        (e) => e.externalEventId === '$historical-message'
      );
      expect(historicalEvents.length).toBe(0);
    });

    it('should ignore messages with empty body', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const emptyMessage = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@otheruser:example.org',
        getId: () => '$empty-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: '' })
      };

      const mockRoom = { roomId: '!room123:example.org' };
      triggerEvent('Room.timeline', emptyMessage, mockRoom, false);

      const batch = await adapter.poll();
      const emptyEvents = batch.events.filter((e) => e.externalEventId === '$empty-message');
      expect(emptyEvents.length).toBe(0);
    });

    it('should create post.created event for valid messages', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const validMessage = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@testuser:example.org',
        getId: () => '$valid-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Hello, Matrix!' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({
          name: 'Test User',
          rawDisplayName: 'Test User Raw',
          getAvatarUrl: () => 'https://avatar.url/image.png'
        })
      };

      triggerEvent('Room.timeline', validMessage, mockRoom, false);

      const batch = await adapter.poll();
      const postEvents = batch.events.filter(
        (e) => e.payload.type === 'post.created' && e.externalEventId === '$valid-message'
      );
      expect(postEvents.length).toBe(1);
      expect(postEvents[0].payload.body).toBe('Hello, Matrix!');
    });

    it('should handle thread replies correctly', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const threadReply = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@threaduser:example.org',
        getId: () => '$thread-reply',
        getTs: () => Date.now(),
        getContent: () => ({
          body: 'Reply in thread',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$thread-root-event'
          }
        })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({
          name: 'Thread User',
          getAvatarUrl: () => null
        })
      };

      triggerEvent('Room.timeline', threadReply, mockRoom, false);

      const batch = await adapter.poll();
      const threadEvents = batch.events.filter((e) => e.externalEventId === '$thread-reply');
      expect(threadEvents.length).toBe(1);
      expect(threadEvents[0].subject.scopeKind).toBe('thread');
      expect(threadEvents[0].subject.scope).toBe('$thread-root-event');
    });

    it('should include sender profile info in metadata', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const message = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@profileuser:example.org',
        getId: () => '$profile-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Message with profile' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({
          name: 'Profile User',
          rawDisplayName: 'Profile User Raw',
          getAvatarUrl: () => 'https://avatar.example.org/user.png'
        })
      };

      triggerEvent('Room.timeline', message, mockRoom, false);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === '$profile-message');
      expect(event).toBeDefined();
      expect(event?.metadata?.authorDisplayName).toBe('Profile User');
      expect(event?.metadata?.authorAvatarUrl).toBe('https://avatar.example.org/user.png');
    });
  });

  describe('Event handling - Room creation', () => {
    it('should emit roomCreate event for mapped rooms', async () => {
      const roomCreateHandler = vi.fn();
      adapter.on('roomCreate', roomCreateHandler);

      await adapter.mapRoom('!newroom:example.org', 'forum-new');
      await adapter.start();

      const mockRoom = {
        roomId: '!newroom:example.org',
        name: 'New Room',
        topic: 'Room description'
      };

      triggerEvent('Room', mockRoom);

      expect(roomCreateHandler).toHaveBeenCalled();
    });

    it('should not emit roomCreate for unmapped rooms', async () => {
      const roomCreateHandler = vi.fn();
      adapter.on('roomCreate', roomCreateHandler);

      await adapter.start();

      const unmappedRoom = {
        roomId: '!unmapped:example.org',
        name: 'Unmapped Room'
      };

      triggerEvent('Room', unmappedRoom);

      expect(roomCreateHandler).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should emit error event on sync ERROR state', async () => {
      const errorHandler = vi.fn();
      adapter.on('error', errorHandler);

      await adapter.start();

      triggerEvent('sync', 'ERROR', null, { error: { message: 'Sync failed' } });

      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('External Ref generation', () => {
    it('should generate proper ExternalRef for messages', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const message = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@refuser:example.org',
        getId: () => '$ext-ref-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'External ref test' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({ name: 'Ref User', getAvatarUrl: () => null })
      };

      triggerEvent('Room.timeline', message, mockRoom, false);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === '$ext-ref-message');

      expect(event).toBeDefined();
      expect(event?.subject).toMatchObject({
        id: 'ref-event-$ext-ref-message',
        surfaceId: adapter.surfaceId,
        surfaceKind: 'matrix',
        externalId: '$ext-ref-message',
        kind: 'post'
      });
    });

    it('should generate proper actor ExternalRef', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const message = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@actoruser:example.org',
        getId: () => '$actor-ref-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Actor ref test' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({ name: 'Actor User', getAvatarUrl: () => null })
      };

      triggerEvent('Room.timeline', message, mockRoom, false);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === '$actor-ref-message');

      expect(event).toBeDefined();
      expect(event?.actor).toMatchObject({
        id: 'ref-user-@actoruser:example.org',
        surfaceId: adapter.surfaceId,
        surfaceKind: 'matrix',
        externalId: '@actoruser:example.org',
        kind: 'identity'
      });
    });
  });

  describe('Cursor management', () => {
    it('should increment cursor counter for each event', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      // Create multiple messages
      for (let i = 0; i < 3; i++) {
        const message = {
          getType: () => 'm.room.message',
          getRoomId: () => '!room123:example.org',
          getSender: () => '@cursoruser:example.org',
          getId: () => `$cursor-message-${i}`,
          getTs: () => Date.now(),
          getContent: () => ({ body: `Message ${i}` })
        };

        const mockRoom = {
          roomId: '!room123:example.org',
          getMember: () => ({ name: 'Cursor User', getAvatarUrl: () => null })
        };

        triggerEvent('Room.timeline', message, mockRoom, false);
      }

      const batch = await adapter.poll();
      const cursors = batch.events.map((e) => parseInt(e.cursor ?? '0', 10));

      // Cursors should be sequential
      expect(cursors.length).toBe(3);
      for (let i = 1; i < cursors.length; i++) {
        expect(cursors[i]).toBeGreaterThan(cursors[i - 1]);
      }
    });
  });

  describe('EventEmitter functionality', () => {
    it('should emit messageCreate event when processing messages', async () => {
      const messageCreateHandler = vi.fn();
      adapter.on('messageCreate', messageCreateHandler);

      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const message = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@emituser:example.org',
        getId: () => '$emit-test-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Emit test' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({ name: 'Emit User', getAvatarUrl: () => null })
      };

      triggerEvent('Room.timeline', message, mockRoom, false);

      expect(messageCreateHandler).toHaveBeenCalled();
    });
  });

  describe('Payload structure', () => {
    it('should include correct payload fields for post.created', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const message = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@payloaduser:example.org',
        getId: () => '$payload-message',
        getTs: () => Date.now(),
        getContent: () => ({ body: 'Payload test message' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({ name: 'Payload User', getAvatarUrl: () => null })
      };

      triggerEvent('Room.timeline', message, mockRoom, false);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === '$payload-message');

      expect(event).toBeDefined();
      expect(event?.payload).toMatchObject({
        type: 'post.created',
        roomId: '!room123:example.org',
        threadId: null,
        eventId: '$payload-message',
        authorId: '@payloaduser:example.org',
        entityType: 'event',
        body: 'Payload test message'
      });
    });

    it('should include threadId in payload for thread replies', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const threadMessage = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@threaduser:example.org',
        getId: () => '$thread-payload-message',
        getTs: () => Date.now(),
        getContent: () => ({
          body: 'Thread reply',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$thread-root'
          }
        })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({ name: 'Thread User', getAvatarUrl: () => null })
      };

      triggerEvent('Room.timeline', threadMessage, mockRoom, false);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === '$thread-payload-message');

      expect(event).toBeDefined();
      if (event?.payload.type === 'post.created') {
        expect(event.payload.threadId).toBe('$thread-root');
      }
    });
  });

  describe('Timestamp handling', () => {
    it('should use event timestamp for occurredAt', async () => {
      await adapter.mapRoom('!room123:example.org', 'forum-123');
      await adapter.start();

      const eventTimestamp = new Date('2024-01-15T10:30:00Z').getTime();

      const message = {
        getType: () => 'm.room.message',
        getRoomId: () => '!room123:example.org',
        getSender: () => '@timestampuser:example.org',
        getId: () => '$timestamp-message',
        getTs: () => eventTimestamp,
        getContent: () => ({ body: 'Timestamp test' })
      };

      const mockRoom = {
        roomId: '!room123:example.org',
        getMember: () => ({ name: 'Timestamp User', getAvatarUrl: () => null })
      };

      triggerEvent('Room.timeline', message, mockRoom, false);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === '$timestamp-message');

      expect(event).toBeDefined();
      expect(event?.occurredAt).toBe(new Date(eventTimestamp).toISOString());
    });
  });
});
