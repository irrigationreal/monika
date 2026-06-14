import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAdapter, type DiscordAdapterConfig, type DiscordSurfaceEvent } from './discord';

// Store mock client and event handlers at module level for access in tests
let mockClientInstance: any = null;
const eventHandlers: Record<string, ((...args: any[]) => void)[]> = {};
const onceHandlers: Record<string, ((...args: any[]) => void)[]> = {};

// Mock discord.js
vi.mock('discord.js', () => {
  // Create a class-like constructor that returns our mock
  class MockClient {
    user = { tag: 'TestBot#1234' };
    channels = {
      fetch: vi.fn()
    };
    users = {
      fetch: vi.fn()
    };

    login = vi.fn().mockResolvedValue('token');
    destroy = vi.fn().mockResolvedValue(undefined);
    removeAllListeners = vi.fn(() => {
      // Clear handlers on removeAllListeners
      Object.keys(eventHandlers).forEach((key) => delete eventHandlers[key]);
      Object.keys(onceHandlers).forEach((key) => delete onceHandlers[key]);
    });

    on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!eventHandlers[event]) {
        eventHandlers[event] = [];
      }
      eventHandlers[event].push(handler);
      return this;
    });

    once = vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!onceHandlers[event]) {
        onceHandlers[event] = [];
      }
      onceHandlers[event].push(handler);
      return this;
    });

    constructor() {
      mockClientInstance = this;
    }
  }

  return {
    Client: MockClient,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      GuildMembers: 8
    },
    Partials: {
      Message: 1,
      Channel: 2,
      ThreadMember: 3
    }
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
  // Clear once handlers after triggering
  delete onceHandlers[eventName];
}

describe('DiscordAdapter', () => {
  const validConfig: DiscordAdapterConfig = {
    token: 'test-token-12345',
    guildId: '123456789012345678'
  };

  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear event handlers
    Object.keys(eventHandlers).forEach((key) => delete eventHandlers[key]);
    Object.keys(onceHandlers).forEach((key) => delete onceHandlers[key]);
    mockClientInstance = null;
    adapter = new DiscordAdapter(validConfig);
  });

  afterEach(async () => {
    // Clean up running adapter if needed
    if (adapter.isRunning()) {
      await adapter.stop();
    }
  });

  describe('Construction', () => {
    it('should construct with valid config', () => {
      const instance = new DiscordAdapter(validConfig);
      expect(instance).toBeInstanceOf(DiscordAdapter);
      expect(instance.surface).toBe('discord');
    });

    it('should store config correctly', () => {
      const instance = new DiscordAdapter(validConfig);
      expect(instance.surfaceId).toBe(`discord:${validConfig.guildId}`);
    });

    it('should initialize with default capabilities', () => {
      const instance = new DiscordAdapter(validConfig);
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
      const instance = new DiscordAdapter(validConfig);
      expect(instance.isRunning()).toBe(false);
    });
  });

  describe('surfaceId generation', () => {
    it('should generate surfaceId in format discord:{guildId}', () => {
      const config: DiscordAdapterConfig = {
        token: 'token',
        guildId: '999888777666555444'
      };
      const instance = new DiscordAdapter(config);
      expect(instance.surfaceId).toBe('discord:999888777666555444');
    });

    it('should have unique surfaceIds for different guilds', () => {
      const adapter1 = new DiscordAdapter({ token: 'token', guildId: 'guild1' });
      const adapter2 = new DiscordAdapter({ token: 'token', guildId: 'guild2' });
      expect(adapter1.surfaceId).not.toBe(adapter2.surfaceId);
    });
  });

  describe('Channel mapping (mapForumChannel)', () => {
    it('should map a forum channel with explicit forumId', async () => {
      await adapter.mapForumChannel('channel-123', 'forum-456');
      expect(adapter.getMappedForumId('channel-123')).toBe('forum-456');
    });

    it('should use channelId as forumId when forumId not provided', async () => {
      await adapter.mapForumChannel('channel-789');
      expect(adapter.getMappedForumId('channel-789')).toBe('channel-789');
    });

    it('should overwrite existing mapping when same channel mapped again', async () => {
      await adapter.mapForumChannel('channel-123', 'forum-old');
      await adapter.mapForumChannel('channel-123', 'forum-new');
      expect(adapter.getMappedForumId('channel-123')).toBe('forum-new');
    });

    it('should support multiple channel mappings', async () => {
      await adapter.mapForumChannel('channel-1', 'forum-1');
      await adapter.mapForumChannel('channel-2', 'forum-2');
      await adapter.mapForumChannel('channel-3', 'forum-3');

      expect(adapter.getMappedForumId('channel-1')).toBe('forum-1');
      expect(adapter.getMappedForumId('channel-2')).toBe('forum-2');
      expect(adapter.getMappedForumId('channel-3')).toBe('forum-3');
    });
  });

  describe('Channel unmapping (unmapForumChannel)', () => {
    it('should unmap an existing channel', async () => {
      await adapter.mapForumChannel('channel-123', 'forum-456');
      adapter.unmapForumChannel('channel-123');
      expect(adapter.getMappedForumId('channel-123')).toBeUndefined();
    });

    it('should not throw when unmapping non-existent channel', () => {
      expect(() => adapter.unmapForumChannel('non-existent')).not.toThrow();
    });

    it('should only unmap the specified channel', async () => {
      await adapter.mapForumChannel('channel-1', 'forum-1');
      await adapter.mapForumChannel('channel-2', 'forum-2');
      adapter.unmapForumChannel('channel-1');

      expect(adapter.getMappedForumId('channel-1')).toBeUndefined();
      expect(adapter.getMappedForumId('channel-2')).toBe('forum-2');
    });
  });

  describe('getMappedChannels', () => {
    it('should return empty Map when no channels mapped', () => {
      const channels = adapter.getMappedChannels();
      expect(channels).toBeInstanceOf(Map);
      expect(channels.size).toBe(0);
    });

    it('should return a copy of the mapped channels', async () => {
      await adapter.mapForumChannel('channel-1', 'forum-1');
      await adapter.mapForumChannel('channel-2', 'forum-2');

      const channels = adapter.getMappedChannels();
      expect(channels.size).toBe(2);
      expect(channels.get('channel-1')).toBe('forum-1');
      expect(channels.get('channel-2')).toBe('forum-2');
    });

    it('should return independent copy (modifications do not affect adapter)', async () => {
      await adapter.mapForumChannel('channel-1', 'forum-1');

      const channels = adapter.getMappedChannels();
      channels.set('channel-modified', 'forum-modified');

      expect(adapter.getMappedForumId('channel-modified')).toBeUndefined();
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
      const batch = await adapter.poll('5');
      expect(batch.nextCursor).toBe('5');
    });

    it('should return events with updated cursor', async () => {
      // Map a channel first
      await adapter.mapForumChannel('parent-channel-123', 'forum-123');

      // Start the adapter to set up event handlers
      await adapter.start();

      // Trigger a thread creation event
      const mockThread = {
        id: 'thread-123',
        parentId: 'parent-channel-123',
        guildId: validConfig.guildId,
        ownerId: 'user-456',
        name: 'Test Thread',
        createdAt: new Date()
      };
      triggerEvent('threadCreate', mockThread);

      const batch = await adapter.poll();
      expect(batch.events.length).toBe(1);
      expect(batch.nextCursor).toBe('1');
    });

    it('should support cursor-based pagination', async () => {
      const batch = await adapter.poll('0');
      expect(batch.events).toBeInstanceOf(Array);
    });
  });

  describe('Event acknowledgement (ack)', () => {
    it('should remove acknowledged event from queue', async () => {
      // Map a channel
      await adapter.mapForumChannel('parent-channel-123', 'forum-123');

      // Start adapter to set up event handlers
      await adapter.start();

      // Trigger a thread creation event
      const mockThread = {
        id: 'thread-to-ack',
        parentId: 'parent-channel-123',
        guildId: validConfig.guildId,
        ownerId: 'user-456',
        name: 'Thread To Ack',
        createdAt: new Date()
      };
      triggerEvent('threadCreate', mockThread);

      // Poll to get events
      const beforeAck = await adapter.poll();
      const eventCount = beforeAck.events.length;
      expect(eventCount).toBe(1);

      const eventToAck = beforeAck.events[0];
      await adapter.ack(eventToAck);

      // Check that event was removed
      const afterAck = await adapter.poll();
      expect(afterAck.events.length).toBe(0);
    });

    it('should not throw when acking non-existent event', async () => {
      const fakeEvent: DiscordSurfaceEvent = {
        surfaceId: adapter.surfaceId,
        surfaceKind: 'discord',
        externalEventId: 'non-existent-event',
        cursor: '999',
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        actor: null,
        subject: {
          id: 'ref-test',
          surfaceId: adapter.surfaceId,
          surfaceKind: 'discord',
          externalId: 'test-123',
          kind: 'post'
        },
        payload: {
          type: 'post.created',
          entityType: 'message',
          guildId: null,
          channelId: null,
          body: 'Test'
        }
      };

      await expect(adapter.ack(fakeEvent)).resolves.not.toThrow();
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
    it('should emit ready event after successful start', async () => {
      const readyHandler = vi.fn();
      adapter.on('ready', readyHandler);

      await adapter.start();

      // Trigger ready event
      triggerOnceEvent('ready');

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
      expect(mockClientInstance.destroy).toHaveBeenCalled();
    });
  });

  describe('Event handling - Message creation', () => {
    it('should ignore bot messages', async () => {
      await adapter.mapForumChannel('channel-123', 'forum-123');
      await adapter.start();

      const botMessage = {
        id: 'bot-msg-123',
        author: { bot: true, id: 'bot-user', username: 'Bot' },
        channel: { id: 'channel-123', isThread: () => false },
        guildId: validConfig.guildId,
        content: 'Bot message',
        createdAt: new Date()
      };

      triggerEvent('messageCreate', botMessage);

      const batch = await adapter.poll();
      const botEvents = batch.events.filter(
        (e) => e.payload.type === 'post.created' && e.externalEventId === 'bot-msg-123'
      );
      expect(botEvents.length).toBe(0);
    });

    it('should ignore messages from unmapped channels', async () => {
      await adapter.start();

      const unmappedMessage = {
        id: 'unmapped-msg-123',
        author: { bot: false, id: 'user-123', username: 'User' },
        channel: { id: 'unmapped-channel', isThread: () => false },
        guildId: validConfig.guildId,
        content: 'Message in unmapped channel',
        createdAt: new Date()
      };

      triggerEvent('messageCreate', unmappedMessage);

      const batch = await adapter.poll();
      const unmappedEvents = batch.events.filter((e) => e.externalEventId === 'unmapped-msg-123');
      expect(unmappedEvents.length).toBe(0);
    });

    it('should create post.created event for valid messages', async () => {
      await adapter.mapForumChannel('channel-123', 'forum-123');
      await adapter.start();

      const validMessage = {
        id: 'valid-msg-123',
        author: {
          bot: false,
          id: 'user-456',
          username: 'TestUser',
          displayName: 'Test User',
          avatar: 'avatar-hash'
        },
        channel: { id: 'channel-123', isThread: () => false },
        guildId: validConfig.guildId,
        content: 'Hello, forum!',
        createdAt: new Date()
      };

      triggerEvent('messageCreate', validMessage);

      const batch = await adapter.poll();
      const postEvents = batch.events.filter(
        (e) => e.payload.type === 'post.created' && e.externalEventId === 'valid-msg-123'
      );
      expect(postEvents.length).toBe(1);
      expect(postEvents[0].payload.body).toBe('Hello, forum!');
    });

    it('should handle thread messages correctly', async () => {
      await adapter.mapForumChannel('parent-channel', 'forum-123');
      await adapter.start();

      const threadMessage = {
        id: 'thread-msg-123',
        author: {
          bot: false,
          id: 'user-789',
          username: 'ThreadUser',
          displayName: 'Thread User',
          avatar: null
        },
        channel: {
          id: 'thread-channel',
          parentId: 'parent-channel',
          isThread: () => true
        },
        guildId: validConfig.guildId,
        content: 'Reply in thread',
        createdAt: new Date()
      };

      triggerEvent('messageCreate', threadMessage);

      const batch = await adapter.poll();
      const threadEvents = batch.events.filter((e) => e.externalEventId === 'thread-msg-123');
      expect(threadEvents.length).toBe(1);
      expect(threadEvents[0].subject.scopeKind).toBe('thread');
    });
  });

  describe('Event handling - Thread creation', () => {
    it('should create topic.created event for new threads', async () => {
      await adapter.mapForumChannel('forum-channel', 'forum-123');
      await adapter.start();

      const newThread = {
        id: 'new-thread-123',
        parentId: 'forum-channel',
        guildId: validConfig.guildId,
        ownerId: 'creator-user',
        name: 'New Discussion Topic',
        createdAt: new Date()
      };

      triggerEvent('threadCreate', newThread);

      const batch = await adapter.poll();
      const topicEvents = batch.events.filter(
        (e) => e.payload.type === 'topic.created' && e.externalEventId === 'new-thread-123'
      );
      expect(topicEvents.length).toBe(1);

      const event = topicEvents[0];
      expect(event.payload.type).toBe('topic.created');
      expect(event.subject.kind).toBe('topic');
      if (event.payload.type === 'topic.created') {
        expect(event.payload.title).toBe('New Discussion Topic');
      }
    });

    it('should ignore threads from unmapped channels', async () => {
      await adapter.start();

      const unmappedThread = {
        id: 'unmapped-thread-123',
        parentId: 'unmapped-forum-channel',
        guildId: validConfig.guildId,
        ownerId: 'some-user',
        name: 'Thread in unmapped channel',
        createdAt: new Date()
      };

      triggerEvent('threadCreate', unmappedThread);

      const batch = await adapter.poll();
      const unmappedEvents = batch.events.filter(
        (e) => e.externalEventId === 'unmapped-thread-123'
      );
      expect(unmappedEvents.length).toBe(0);
    });

    it('should include actor reference when thread has owner', async () => {
      await adapter.mapForumChannel('forum-channel', 'forum-123');
      await adapter.start();

      const threadWithOwner = {
        id: 'owned-thread-123',
        parentId: 'forum-channel',
        guildId: validConfig.guildId,
        ownerId: 'owner-user-456',
        name: 'Thread with owner',
        createdAt: new Date()
      };

      triggerEvent('threadCreate', threadWithOwner);

      const batch = await adapter.poll();
      const threadEvents = batch.events.filter((e) => e.externalEventId === 'owned-thread-123');
      expect(threadEvents.length).toBe(1);
      expect(threadEvents[0].actor).not.toBeNull();
      expect(threadEvents[0].actor?.externalId).toBe('owner-user-456');
    });
  });

  describe('Error handling', () => {
    it('should emit error event when client encounters error', async () => {
      const errorHandler = vi.fn();
      adapter.on('error', errorHandler);

      await adapter.start();

      const testError = new Error('Test client error');
      triggerEvent('error', testError);

      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('External Ref generation', () => {
    it('should generate proper ExternalRef for threads', async () => {
      await adapter.mapForumChannel('forum-channel', 'forum-123');
      await adapter.start();

      const thread = {
        id: 'ext-ref-thread',
        parentId: 'forum-channel',
        guildId: validConfig.guildId,
        ownerId: 'user-123',
        name: 'External Ref Test',
        createdAt: new Date()
      };

      triggerEvent('threadCreate', thread);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === 'ext-ref-thread');

      expect(event).toBeDefined();
      expect(event?.subject).toMatchObject({
        id: 'ref-thread-ext-ref-thread',
        surfaceId: adapter.surfaceId,
        surfaceKind: 'discord',
        externalId: 'ext-ref-thread',
        kind: 'topic',
        scopeKind: 'channel'
      });
    });

    it('should generate proper ExternalRef for messages', async () => {
      await adapter.mapForumChannel('channel-123', 'forum-123');
      await adapter.start();

      const message = {
        id: 'ext-ref-msg',
        author: { bot: false, id: 'user-123', username: 'User' },
        channel: { id: 'channel-123', isThread: () => false },
        guildId: validConfig.guildId,
        content: 'Test message',
        createdAt: new Date()
      };

      triggerEvent('messageCreate', message);

      const batch = await adapter.poll();
      const event = batch.events.find((e) => e.externalEventId === 'ext-ref-msg');

      expect(event).toBeDefined();
      expect(event?.subject).toMatchObject({
        id: 'ref-msg-ext-ref-msg',
        surfaceId: adapter.surfaceId,
        surfaceKind: 'discord',
        externalId: 'ext-ref-msg',
        kind: 'post'
      });
    });
  });

  describe('Cursor management', () => {
    it('should increment cursor counter for each event', async () => {
      await adapter.mapForumChannel('forum-channel', 'forum-123');
      await adapter.start();

      // Create multiple threads
      for (let i = 0; i < 3; i++) {
        const thread = {
          id: `thread-cursor-${i}`,
          parentId: 'forum-channel',
          guildId: validConfig.guildId,
          ownerId: 'user-123',
          name: `Thread ${i}`,
          createdAt: new Date()
        };
        triggerEvent('threadCreate', thread);
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

      await adapter.mapForumChannel('channel-123', 'forum-123');
      await adapter.start();

      const message = {
        id: 'emit-test-msg',
        author: { bot: false, id: 'user-123', username: 'User' },
        channel: { id: 'channel-123', isThread: () => false },
        guildId: validConfig.guildId,
        content: 'Emit test',
        createdAt: new Date()
      };

      triggerEvent('messageCreate', message);

      expect(messageCreateHandler).toHaveBeenCalled();
    });

    it('should emit threadCreate event when processing threads', async () => {
      const threadCreateHandler = vi.fn();
      adapter.on('threadCreate', threadCreateHandler);

      await adapter.mapForumChannel('forum-channel', 'forum-123');
      await adapter.start();

      const thread = {
        id: 'emit-test-thread',
        parentId: 'forum-channel',
        guildId: validConfig.guildId,
        ownerId: 'user-123',
        name: 'Emit test thread',
        createdAt: new Date()
      };

      triggerEvent('threadCreate', thread);

      expect(threadCreateHandler).toHaveBeenCalled();
    });
  });
});
