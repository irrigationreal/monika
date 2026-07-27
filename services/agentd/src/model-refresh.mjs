const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

export function modelRefreshIntervalMs(value, fallbackMs = 4 * 60 * 60 * 1000) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run bounded, non-overlapping model catalog refreshes without delaying startup.
 * ModelRuntime keeps its previous provider catalog when a remote refresh fails.
 */
export function startModelCatalogRefresh(runtimePromise, options = {}) {
  const intervalMs = modelRefreshIntervalMs(options.intervalMs);
  if (intervalMs === 0) return { refresh: async () => undefined, stop() {} };

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_REFRESH_TIMEOUT_MS;
  const logger = options.logger ?? console;
  let inFlight = null;
  let timer = null;

  const refresh = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let timeout;
      try {
        const runtime = await runtimePromise;
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        timeout.unref?.();
        const result = await runtime.refresh({ allowNetwork: true, signal: controller.signal });
        if (result.aborted) {
          logger.warn(`[agentd] model catalog refresh aborted after ${timeoutMs}ms; keeping cached catalogs`);
        }
        for (const [provider, error] of result.errors) {
          logger.warn(`[agentd] model catalog refresh failed for ${provider}; keeping cached catalog: ${errorText(error)}`);
        }
        options.onRefresh?.(runtime, result);
        return result;
      } catch (error) {
        logger.warn(`[agentd] model catalog refresh failed; keeping cached catalogs: ${errorText(error)}`);
        return undefined;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  // Populate remote pi.dev catalogs in the background. ModelRuntime.create() is
  // deliberately configured for local/cache-only startup by the caller.
  void refresh();
  timer = setInterval(() => void refresh(), intervalMs);
  timer.unref?.();

  return {
    refresh,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
