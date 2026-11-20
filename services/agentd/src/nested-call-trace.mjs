// Projection-safe metadata only. Pi JSONL remains the canonical bounded record;
// nested arguments, results, errors and codemode previews must not enter SSE.
const MAX_CALLS = 256;
const bounded = value => typeof value === 'string' ? value.slice(0, 256) : '';
export const isCodemodeTool = name => String(name ?? '').split('__').at(-1) === 'codemode';
export function nestedCallTrace(value) {
  if (!value || !Array.isArray(value.calls)) return null;
  const calls = value.calls.slice(0, MAX_CALLS).flatMap(call => {
    if (!call || typeof call.id !== 'string' || typeof call.name !== 'string') return [];
    const status = call.status === 'ok' || call.status === 'error' ? call.status : 'unfinished';
    const duration = call.durationMs ?? call.duration_ms;
    return [{ id: bounded(call.id), name: bounded(call.name), status,
      ...(Number.isFinite(duration) && duration >= 0 ? { duration_ms: duration } : {}) }];
  });
  return { calls, complete: value.complete !== false && calls.length === value.calls.length
    && calls.every(call => call.status !== 'unfinished') };
}
export function redactedNestedResult(event) {
  return { redacted: true, status: event.isError ? 'error' : 'ok',
    duration_ms: Number.isFinite(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null };
}
export function codemodeTraceResult(value, failed = false) {
  if (!value || typeof value !== 'object') return { redacted: true };
  // Native script errors embed nested tool error text. Keep those in canonical
  // model context, not the forum trace; no raw partial output on failed scripts.
  return { content: failed ? [{ type: 'text', text: 'Script failed; inspect canonical Pi diagnostics for details.' }]
      : (Array.isArray(value.content) ? value.content : []),
    ...(typeof value.isError === 'boolean' ? { isError: value.isError } : {}),
    details: { nested_calls: nestedCallTrace(value.details) } };
}
