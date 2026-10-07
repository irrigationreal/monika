import type { ServerResponse } from 'node:http';

interface StreamEntry {
  response: ServerResponse;
  finish: () => void;
  close: () => void;
  error: () => void;
  finalize: () => void;
}

export interface SseLifecycleCounts {
  active: number;
  closed: number;
}

/** Owns browser SSE response admission and exactly-once stream cleanup. */
export class SseLifecycleRegistry {
  private accepting = true;
  private readonly streams = new Set<StreamEntry>();
  private closed = 0;

  register(response: ServerResponse, cleanup: () => void): boolean {
    if (!this.accepting) return false;

    let cleaned = false;
    let entry: StreamEntry;
    const finalize = () => {
      if (cleaned) return;
      cleaned = true;
      response.off('finish', entry.finish);
      response.off('close', entry.close);
      response.off('error', entry.error);
      this.streams.delete(entry);
      this.closed += 1;
      try {
        cleanup();
      } catch (error) {
        // Cleanup is best-effort per stream. One broken listener must not keep
        // other SSE responses registered during shutdown.
        console.error('[sse] stream cleanup failed', error);
      }
    };
    const finish = () => finalize();
    const close = () => finalize();
    const error = () => finalize();
    entry = { response, finish, close, error, finalize };
    response.once('finish', finish);
    response.once('close', close);
    response.once('error', error);
    this.streams.add(entry);
    return true;
  }

  closeAll(): SseLifecycleCounts {
    this.accepting = false;
    for (const entry of [...this.streams]) {
      // Release route/bus listeners synchronously before response.end(). Real
      // ServerResponse finish/close events are asynchronous and cannot be the
      // pre-close fencing boundary.
      entry.finalize();
      try {
        entry.response.end();
      } catch {
        try {
          entry.response.destroy();
        } catch {
          // Continue closing the remaining streams.
        }
      }
    }
    return this.counts;
  }

  get size(): number {
    return this.streams.size;
  }

  get counts(): SseLifecycleCounts {
    return { active: this.streams.size, closed: this.closed };
  }

  get isAccepting(): boolean {
    return this.accepting;
  }
}
