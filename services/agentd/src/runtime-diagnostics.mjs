// SDK hosts do not inherit the CLI's diagnostic presentation. Keep these
// operator-only: extension errors can contain workspace paths and private text.
const reportedFallbacks = new WeakMap();

export function reportRuntimeDiagnostics(runtime, log = console.warn) {
  const diagnostics = runtime.takeUnreportedDiagnostics();
  const fallback = runtime.modelFallbackMessage;
  if (fallback) {
    let seen = reportedFallbacks.get(runtime);
    if (!seen) reportedFallbacks.set(runtime, seen = new Set());
    if (!seen.has(fallback)) {
      seen.add(fallback);
      diagnostics.push({ type: 'warning', message: fallback });
    }
  }
  for (const diagnostic of diagnostics) {
    const message = String(diagnostic.message).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').slice(0, 4096);
    log(`[agentd] Pi runtime ${diagnostic.type}: ${message}`);
  }
}
