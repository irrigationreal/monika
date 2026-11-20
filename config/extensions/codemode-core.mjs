// Monika policy around Pi's native codemode. No alternate VM or tool executor.
export const CODEMODE_LIMITS = Object.freeze({
  timeoutMs: 60_000, maxTimeoutMs: 120_000,
  outputTokens: 2_000, maxOutputTokens: 8_000,
  maxSourceChars: 131_072, maxCalls: 64, concurrency: 8,
});

export function flatToolName(name) {
  return String(name ?? '').split('__').at(-1).toLowerCase();
}

const DIRECT_ONLY = new Set([
  'codemode', 'subagent', 'subagent_wait', 'subagent_supervisor', 'intercom',
  'relocate', 'pi_run', 'remember', 'remember_session', 'correct_observation', 'retract_observation',
]);
export function isDirectOnlyTool(name) { return DIRECT_ONLY.has(flatToolName(name)); }

export function boundCodemodeSource(source) {
  if (typeof source !== 'string' || source.length > CODEMODE_LIMITS.maxSourceChars) {
    throw new Error('Codemode source must be a string of at most 131072 characters');
  }
  let body = source;
  let options = {};
  const firstLine = source.split('\n', 1)[0];
  if (/^\s*\/\/\s*@options:/.test(firstLine)) {
    options = JSON.parse(firstLine.replace(/^\s*\/\/\s*@options:\s*/, ''));
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['timeout_ms', 'max_output_tokens'].includes(key))) {
      throw new Error('Invalid codemode options');
    }
    body = source.slice(firstLine.length + (source[firstLine.length] === '\n' ? 1 : 0));
  }
  const bounded = (value, fallback, max, label) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
    return value;
  };
  const timeout_ms = bounded(options.timeout_ms, CODEMODE_LIMITS.timeoutMs, CODEMODE_LIMITS.maxTimeoutMs, 'timeout_ms');
  const max_output_tokens = bounded(options.max_output_tokens, CODEMODE_LIMITS.outputTokens, CODEMODE_LIMITS.maxOutputTokens, 'max_output_tokens');
  return `// @options: ${JSON.stringify({ timeout_ms, max_output_tokens })}\n${body}`;
}

// Queue only this script's nested calls. Pi remains responsible for validation,
// hooks, execution-mode serialization, IDs, cancellation, usage and provenance.
export function boundedToolContext(ctx, signal) {
  let count = 0;
  let running = 0;
  const queue = [];
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
  const checkAbort = (callSignal) => {
    if (signal?.aborted) throw abortError();
    if (callSignal?.aborted) throw callSignal.reason instanceof Error ? callSignal.reason : new DOMException('Aborted', 'AbortError');
  };
  return {
    ...ctx,
    tools: ctx.tools.filter(tool => !isDirectOnlyTool(tool.name)),
    async executeTool(name, args, options = {}) {
      if (isDirectOnlyTool(name)) throw new Error(`${name} must be called directly, outside codemode`);
      if (++count > CODEMODE_LIMITS.maxCalls) throw new Error('Codemode permits at most 64 nested calls per script');
      checkAbort(options.signal);
      if (running >= CODEMODE_LIMITS.concurrency) await new Promise(resolve => queue.push(resolve));
      else running += 1;
      try {
        checkAbort(options.signal);
        return await ctx.executeTool(name, args, options);
      } finally {
        const next = queue.shift();
        if (next) next(); // Transfer the occupied slot; new arrivals cannot steal it.
        else running -= 1;
      }
    },
  };
}
