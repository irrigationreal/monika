import { EventEmitter } from 'node:events';

export type StreamEventType =
  | 'state'
  | 'context_updated'
  | 'reasoning_delta'
  | 'tool_run'
  | 'tool_started'
  | 'assistant_message'
  | 'assistant_error'
  | 'operational_event'
  | 'assistant_reset'
  | 'notification'
  | 'chat_message'
  | 'chat_attachment'
  | 'chat_presence_state'
  | 'chat_join'
  | 'chat_part'
  | 'chat_typing'
  | 'chat_message_expired';

export interface StreamEvent<T = unknown> {
  type: StreamEventType;
  data: T;
}

export interface StreamBusInterface {
  emit(topicId: string, event: StreamEvent): void;
  subscribe(topicId: string, handler: (event: StreamEvent) => void): () => void;
}

export class StreamBus implements StreamBusInterface {
  private emitter = new EventEmitter();

  emit(topicId: string, event: StreamEvent): void {
    this.emitter.emit(topicId, event);
  }

  subscribe(topicId: string, handler: (event: StreamEvent) => void): () => void {
    this.emitter.on(topicId, handler);
    return () => this.emitter.off(topicId, handler);
  }
}

export interface RedisStreamBusConfig {
  publisherUrl: string;
  subscriberUrl: string;
}

export class RedisStreamBus implements StreamBusInterface {
  private localEmitter = new EventEmitter();
  private publisherClient: unknown = null;
  private subscriberClient: unknown = null;
  private subscribedTopics = new Set<string>();
  private config: RedisStreamBusConfig;

  constructor(config: RedisStreamBusConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const { createClient } = await import('redis');
      this.publisherClient = createClient({ url: this.config.publisherUrl });
      this.subscriberClient = createClient({ url: this.config.subscriberUrl });

      await (this.publisherClient as { connect: () => Promise<void> }).connect();
      await (this.subscriberClient as { connect: () => Promise<void> }).connect();

      console.log('Redis Stream Bus connected');
    } catch (err) {
      console.error('Failed to connect Redis Stream Bus:', err);
      throw err;
    }
  }

  emit(topicId: string, event: StreamEvent): void {
    const channel = `forum:topic:${topicId}`;
    const message = JSON.stringify(event);

    if (this.publisherClient) {
      void (this.publisherClient as { publish: (channel: string, message: string) => Promise<number> })
        .publish(channel, message)
        .catch((err: unknown) => console.error('Redis publish error:', err));
    }

    this.localEmitter.emit(topicId, event);
  }

  subscribe(topicId: string, handler: (event: StreamEvent) => void): () => void {
    const channel = `forum:topic:${topicId}`;

    this.localEmitter.on(topicId, handler);

    if (this.subscriberClient && !this.subscribedTopics.has(topicId)) {
      this.subscribedTopics.add(topicId);
      void (
        this.subscriberClient as { subscribe: (channel: string, listener: (message: string) => void) => Promise<void> }
      )
        .subscribe(channel, (message: string) => {
          try {
            const event = JSON.parse(message) as StreamEvent;
            this.localEmitter.emit(topicId, event);
          } catch (err) {
            console.error('Redis message parse error:', err);
          }
        })
        .catch((err: unknown) => console.error('Redis subscribe error:', err));
    }

    return () => {
      this.localEmitter.off(topicId, handler);
    };
  }

  async close(): Promise<void> {
    if (this.publisherClient) {
      await (this.publisherClient as { quit: () => Promise<void> }).quit();
    }
    if (this.subscriberClient) {
      await (this.subscriberClient as { quit: () => Promise<void> }).quit();
    }
  }
}

export function createStreamBus(useRedis: boolean, redisUrl?: string): StreamBusInterface {
  if (useRedis && redisUrl) {
    return new RedisStreamBus({
      publisherUrl: redisUrl,
      subscriberUrl: redisUrl,
    });
  }
  return new StreamBus();
}
