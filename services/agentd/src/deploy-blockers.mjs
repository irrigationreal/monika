const DEFAULT_BLOCKER_ITEM_LIMIT = 20;

function compareRunIdentity(left, right) {
  return String(left.run_key ?? '').localeCompare(String(right.run_key ?? ''))
    || String(left.run_id ?? '').localeCompare(String(right.run_id ?? ''));
}

/** Build a bounded, opaque diagnostic projection without leaking run payloads or paths. */
export function subagentRunBlocker(code, runs, count, predicate, limit = DEFAULT_BLOCKER_ITEM_LIMIT) {
  const cappedLimit = Math.max(1, Math.trunc(limit));
  const items = runs
    .filter(predicate)
    .sort(compareRunIdentity)
    .slice(0, cappedLimit)
    .map((run) => ({
      run_key: run.run_key ?? null,
      run_id: run.run_id ?? null,
      execution_state: run.execution_state ?? (run.blocking ? 'active' : 'terminal'),
      effects_state: run.effects_state ?? null,
    }));
  return {
    code,
    count,
    items,
    item_limit: cappedLimit,
    truncated: count > items.length,
    omitted_count: Math.max(0, count - items.length),
  };
}
