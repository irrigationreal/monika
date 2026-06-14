import type { IdempotencyStore } from '@irrigationreal/codex-forum-core';

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Map<string, string>();

  async has(surfaceId: string, externalEventId: string): Promise<boolean> {
    return this.seen.has(`${surfaceId}:${externalEventId}`);
  }

  async mark(surfaceId: string, externalEventId: string, eventId: string): Promise<void> {
    this.seen.set(`${surfaceId}:${externalEventId}`, eventId);
  }
}
