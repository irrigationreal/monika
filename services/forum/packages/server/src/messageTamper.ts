import type {
  MessageTamperContext,
  MessageTamperLayer,
  MessageTamperPlugin,
  MessageTamperRequest,
  MessageTamperResult,
  MessageTamperTrailEntry
} from '@irrigationreal/codex-forum-core';

export interface InMemoryMessageTamperLayerOptions {
  /**
   * If true, plugin exceptions will bubble up (fail-closed).
   * If false, exceptions are captured into the trail and the pipeline continues (fail-open).
   */
  throwOnError?: boolean;
}

/**
 * Simple in-process plugin registry + ordered pipeline runner.
 *
 * This is intentionally small and synchronous-ish at the orchestration layer;
 * plugins can do async work (call out to services, redact via a service, etc).
 */
export class InMemoryMessageTamperLayer<TContext extends MessageTamperContext = MessageTamperContext>
  implements MessageTamperLayer<TContext>
{
  private readonly plugins: Array<MessageTamperPlugin<TContext> & { _order: number }> = [];
  private orderSeq = 0;
  private readonly throwOnError: boolean;

  constructor(opts?: InMemoryMessageTamperLayerOptions) {
    this.throwOnError = Boolean(opts?.throwOnError);
  }

  register(plugin: MessageTamperPlugin<TContext>): void {
    // Replace by key (hot reload / idempotent registration).
    const idx = this.plugins.findIndex((p) => p.key === plugin.key);
    const entry = Object.assign(plugin, { _order: ++this.orderSeq });
    if (idx >= 0) {
      this.plugins[idx] = entry;
      return;
    }
    this.plugins.push(entry);
  }

  list(): MessageTamperPlugin<TContext>[] {
    return [...this.plugins].sort((a, b) => comparePlugins(a, b));
  }

  async run(request: MessageTamperRequest<TContext>): Promise<MessageTamperResult> {
    const eligible = this.plugins
      .filter((plugin) => plugin.stages.includes(request.stage))
      .map((plugin) => ({
        plugin,
        priority: resolvePriority(plugin, request)
      }))
      .sort((a, b) => comparePlugins(a.plugin, b.plugin, a.priority, b.priority));

    let currentText = request.text;
    const trail: MessageTamperTrailEntry[] = [];

    for (const entry of eligible) {
      const plugin = entry.plugin;
      const resolvedPriority = entry.priority;
      const startedAt = new Date().toISOString();
      const inputText = currentText;
      let outputText = inputText;
      let error: string | null = null;
      let notes: Record<string, unknown> | undefined;
      let stop = false;
      const startMs = Date.now();

      try {
        const response = await plugin.tamper({ ...request, text: currentText });
        outputText = response.text;
        stop = Boolean(response.stop);
        notes = response.notes;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (this.throwOnError) {
          throw err;
        }
        // Fail-open: keep prior text.
        outputText = inputText;
      }

      const finishedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - startMs);
      const changed = outputText !== inputText;

      trail.push({
        pluginKey: plugin.key,
        pluginPriority: resolvedPriority,
        stage: request.stage,
        direction: request.direction,
        startedAt,
        finishedAt,
        durationMs,
        inputText,
        outputText,
        changed,
        error,
        ...(notes !== undefined ? { notes } : {})
      });

      currentText = outputText;
      if (stop) break;
    }

    return {
      text: currentText,
      tampered: trail.some((entry) => entry.changed || Boolean(entry.error)),
      trail
    };
  }
}

function comparePlugins(
  a: MessageTamperPlugin<any> & { _order?: number },
  b: MessageTamperPlugin<any> & { _order?: number },
  priorityA?: number,
  priorityB?: number
): number {
  // Higher priority first.
  const pa = priorityA ?? a.priority ?? 0;
  const pb = priorityB ?? b.priority ?? 0;
  if (pa !== pb) return pb - pa;

  // Stable registration order next.
  const oa = a._order ?? 0;
  const ob = b._order ?? 0;
  if (oa !== ob) return oa - ob;

  // Finally, key.
  return a.key.localeCompare(b.key);
}

function resolvePriority(plugin: MessageTamperPlugin<any>, request: MessageTamperRequest<any>): number {
  if (typeof plugin.resolvePriority === 'function') {
    const resolved = plugin.resolvePriority(request);
    if (typeof resolved === 'number' && Number.isFinite(resolved)) {
      return resolved;
    }
  }
  return plugin.priority ?? 0;
}
