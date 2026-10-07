export const TRANSPORT_WATCHDOG_MS = 60_000;

interface ShutdownApp {
  close(): Promise<void>;
  server: { closeAllConnections(): void };
  log: {
    info(bindings: Record<string, unknown>, message: string): void;
    error(bindings: Record<string, unknown>, message: string): void;
  };
}

export interface ForumShutdownState {
  forced: boolean;
}

interface ShutdownOptions {
  app: ShutdownApp;
  exit?: (code: number) => void;
  watchdogMs?: number;
  state?: ForumShutdownState;
}

/** Creates an idempotent signal handler with a hard fail-closed deadline. */
export function createForumShutdown({
  app,
  exit = (code) => process.exit(code),
  watchdogMs = TRANSPORT_WATCHDOG_MS,
  state = { forced: false },
}: ShutdownOptions): (signal: string) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited || (state.forced && code === 0)) return;
    exited = true;
    exit(code);
  };

  return (signal: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      const startedAt = Date.now();
      app.log.info({ signal, elapsedMs: 0, forcedTransport: state.forced }, 'Shutting down forum server');
      const watchdog = setTimeout(() => {
        state.forced = true;
        app.log.error(
          { signal, watchdogMs, elapsedMs: Date.now() - startedAt, forcedTransport: state.forced },
          'Forum shutdown exceeded its hard deadline; forcing transports closed and exiting nonzero'
        );
        try {
          app.server.closeAllConnections();
        } catch (err) {
          app.log.error({ err }, 'Forum transport close failed');
        } finally {
          // Keep this in the watchdog callback. Fastify may resolve close() and
          // enter onClose while an untracked finite handler is still pending.
          exitOnce(1);
        }
      }, watchdogMs);

      try {
        await app.close();
        clearTimeout(watchdog);
        if (state.forced) return;
        app.log.info(
          { signal, elapsedMs: Date.now() - startedAt, forcedTransport: state.forced },
          'Forum durable shutdown completed'
        );
        exitOnce(0);
      } catch (err) {
        clearTimeout(watchdog);
        app.log.error(
          { err, signal, elapsedMs: Date.now() - startedAt, forcedTransport: state.forced },
          'Forum shutdown failed'
        );
        exitOnce(1);
      }
    })();

    return shutdownPromise;
  };
}
