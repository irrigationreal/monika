import { EventEmitter } from 'node:events';
import type { EventAppendResult, EventStore, ForumCoreEvent } from '@irrigationreal/codex-forum-core';

export class InMemoryEventStore implements EventStore {
  private readonly events: ForumCoreEvent[] = [];
  private cursorCounter = 0;
  private emitter = new EventEmitter();

  async append(event: ForumCoreEvent): Promise<EventAppendResult> {
    this.events.push(event);
    const cursor = String(++this.cursorCounter);
    this.emitter.emit('event', event);
    return { id: event.id, sequence: event.sequence, cursor };
  }

  async *getSince(cursor?: string | null, sinceTime?: string): AsyncIterable<ForumCoreEvent> {
    let startIndex = 0;
    if (cursor) {
      const parsed = Number(cursor);
      if (Number.isFinite(parsed) && parsed > 0) {
        startIndex = Math.max(0, Math.min(this.events.length, Math.trunc(parsed)));
      }
    }

    const sinceMs = sinceTime ? new Date(sinceTime).getTime() : null;

    for (let index = startIndex; index < this.events.length; index += 1) {
      const event = this.events[index]!;
      if (sinceMs !== null) {
        const occurredAt = new Date(event.occurredAt).getTime();
        if (Number.isFinite(occurredAt) && occurredAt < sinceMs) {
          continue;
        }
      }
      yield event;
    }
  }

  onEvent(handler: (event: ForumCoreEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
