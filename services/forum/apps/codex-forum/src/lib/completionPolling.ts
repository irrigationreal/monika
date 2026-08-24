export interface CompletionPoller {
  refresh(): Promise<void>;
  refreshAfterCurrent(): Promise<void>;
  start(): void;
  stop(): void;
}

/** Completion-scheduled, visibility-aware polling with one shared refresh. */
export function createCompletionPoller(options: {
  task: () => Promise<void>;
  intervalMs: number;
  document: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}): CompletionPoller {
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let started = false;

  const clearTimer = () => {
    if (timer !== null) cancelTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (!started || options.document.hidden) return;
    timer = scheduleTimeout(() => {
      timer = null;
      void refresh();
    }, options.intervalMs);
  };
  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    clearTimer();
    inFlight = options.task().finally(() => {
      inFlight = null;
      schedule();
    });
    return inFlight;
  };
  const refreshAfterCurrent = async (): Promise<void> => {
    const current = inFlight;
    if (current) await current;
    return refresh();
  };
  const visibilityChanged = () => {
    clearTimer();
    if (!started || options.document.hidden) return;
    void refreshAfterCurrent();
  };
  return {
    refresh,
    refreshAfterCurrent,
    start() {
      if (started) return;
      started = true;
      options.document.addEventListener('visibilitychange', visibilityChanged);
      if (!options.document.hidden) void refresh();
    },
    stop() {
      if (!started) return;
      started = false;
      clearTimer();
      options.document.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
}
