import { deriveActiveBranchMetadata } from './session-export.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export function analyticsBuildInfo(env = process.env) {
  const rawCommit = typeof env.MONIKA_BUILD_COMMIT === 'string' ? env.MONIKA_BUILD_COMMIT.trim() : '';
  const rawDate = typeof env.MONIKA_BUILD_DATE === 'string' ? env.MONIKA_BUILD_DATE.trim() : '';
  const commit = /^[a-f0-9]{7,64}$/i.test(rawCommit) ? rawCommit.toLowerCase() : null;
  const timestamp = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
  return { commit, created_at: timestamp };
}
const MAX_RANGE_MS = 366 * DAY_MS;
const ERROR_CATEGORIES = Object.freeze([
  'authentication',
  'rate_limit',
  'context_overflow',
  'permission',
  'timeout',
  'not_found',
  'validation',
  'cancelled',
  'provider',
  'tool_execution',
  'unknown',
]);
const UNSUCCESSFUL_OUTCOMES = new Set([
  'failed', 'failure', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out', 'stopped', 'aborted', 'killed',
  'interrupted', 'quarantined',
]);
const SUCCESSFUL_OUTCOMES = new Set(['completed', 'complete', 'success', 'succeeded', 'ok']);

export class AnalyticsQueryError extends TypeError {}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function finiteTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Pi timestamps are milliseconds, but tolerate epoch seconds in imported fixtures.
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : null;
}

function entryTimestamp(entry) {
  return finiteTimestamp(entry?.timestamp ?? entry?.message?.timestamp ?? null);
}

function positiveTokens(usage) {
  const value = record(usage);
  if (!value) return null;
  const direct = value.totalTokens ?? value.total_tokens ?? value.total;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  const fields = ['input', 'input_tokens', 'output', 'output_tokens', 'cacheRead', 'cache_read', 'cacheWrite', 'cache_write'];
  const total = fields.reduce((sum, field) => {
    const part = value[field];
    return sum + (typeof part === 'number' && Number.isFinite(part) && part > 0 ? part : 0);
  }, 0);
  return total > 0 ? total : null;
}

function contentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((part) => record(part)) : [];
}

function hasVisibleText(content) {
  return contentParts(content).some((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim());
}

function toolCalls(entry) {
  if (entry?.type !== 'message' || entry?.message?.role !== 'assistant') return [];
  return contentParts(entry.message.content).flatMap((part) => {
    if (part.type !== 'toolCall' && part.type !== 'tool_call') return [];
    const id = part.id ?? part.toolCallId ?? part.tool_call_id;
    const name = part.name ?? part.toolName ?? part.tool_name;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return [];
    return [{ id, name, arguments: record(part.arguments ?? part.args ?? part.input), timestamp: entryTimestamp(entry), turnKey: entry.id ?? id }];
  });
}

function normalizeToken(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized && normalized.length <= 64 ? normalized : null;
}

const SAFE_COMMAND_FAMILIES = new Set([
  'git', 'gh', 'pnpm', 'npm', 'npx', 'node', 'python', 'python3', 'pytest', 'nix-shell',
  'docker', 'curl', 'ssh', 'grep', 'rg', 'find', 'ls', 'sed', 'perl', 'jq', 'cargo', 'go', 'mix',
]);
const SAFE_SUBAGENT_ACTIONS = new Set(['list', 'status', 'stop', 'resume', 'steer', 'interrupt', 'doctor', 'wait']);

function commandFamily(command) {
  if (typeof command !== 'string') return null;
  const words = command.trim().split(/\s+/).map((word) => word.replace(/^['"]|['";|&]+$/g, ''));
  const candidates = words.filter((word) => SAFE_COMMAND_FAMILIES.has(word));
  if (candidates.length > 1) return 'mixed';
  return candidates[0] ?? null;
}

/** Return a bounded, non-sensitive operation label. Raw arguments are never returned. */
export function normalizeToolOperation(name, args = null) {
  const normalizedName = normalizeToken(name) ?? 'other';
  const tool = normalizedName === 'mcp__pi-subagents__subagent_wait' ? 'subagent_wait'
    : normalizedName === 'mcp__pi-subagents__subagent' ? 'subagent'
      : normalizedName;
  const values = record(args);
  if (tool === 'relocate') {
    if (!values || values.target === undefined) return 'relocate_status';
    return typeof values.target === 'string' && values.target.trim() === 'local' ? 'relocate_local' : 'relocate_remote';
  }
  const action = normalizeToken(values?.action ?? values?.operation ?? values?.op ?? values?.method);
  if (action && (tool === 'subagent' || tool === 'subagents')) {
    return `subagent_${SAFE_SUBAGENT_ACTIONS.has(action) ? action : 'other'}`;
  }
  if ((tool === 'bash' || tool === 'exec') && typeof values?.command === 'string') {
    return `${tool}:${commandFamily(values.command) ?? 'other'}`;
  }
  if (tool === 'browser' && typeof values?.command === 'string') {
    const verb = normalizeToken(values.command.trim().split(/\s+/, 1)[0]);
    return `browser:${verb && ['open', 'click', 'fill', 'type', 'select', 'press', 'scroll', 'snapshot', 'screenshot', 'wait'].includes(verb) ? verb : 'other'}`;
  }
  return tool;
}

function classifyError(value, fallback = 'unknown') {
  const text = String(value ?? '').toLowerCase();
  if (/rate.?limit|too many requests|\b429\b|quota/.test(text)) return 'rate_limit';
  if (/context.{0,20}(limit|length|window)|maximum context|too many tokens/.test(text)) return 'context_overflow';
  if (/unauth|authentication|invalid api.?key|\b401\b/.test(text)) return 'authentication';
  if (/forbidden|permission|access denied|\b403\b|not allowed/.test(text)) return 'permission';
  if (/timed?.?out|timeout|deadline exceeded/.test(text)) return 'timeout';
  if (/not found|no such file|\b404\b/.test(text)) return 'not_found';
  if (/invalid|validation|malformed|bad request|\b400\b/.test(text)) return 'validation';
  if (/cancelled|canceled|aborted|interrupted/.test(text)) return 'cancelled';
  if (/provider|overloaded|service unavailable|network|connection|econn|dns|socket|fetch failed|\b50[0234]\b/.test(text)) return 'provider';
  return ERROR_CATEGORIES.includes(fallback) ? fallback : 'unknown';
}

const TOOL_BACKENDS = new Set(['local', 'relocated_ssh', 'locked_ssh', 'unknown']);
const TOOL_OUTCOMES = new Set(['success', 'no_match', 'invalid_input', 'not_found', 'dependency', 'transport', 'cancelled', 'timeout', 'tool_execution']);

function toolBackend(details, operation) {
  const value = normalizeToken(record(details)?.backend);
  if (TOOL_BACKENDS.has(value)) return value;
  if (operation === 'relocate_remote') return 'relocated_ssh';
  if (operation === 'relocate_local') return 'local';
  return 'unknown';
}

function toolOutcome(isError, details, content) {
  const explicit = normalizeToken(record(details)?.outcome);
  if (TOOL_OUTCOMES.has(explicit)) return explicit;
  if (!isError) return 'success';
  const category = classifyError(content, 'tool_execution');
  if (category === 'validation') return 'invalid_input';
  if (category === 'not_found') return 'not_found';
  if (category === 'cancelled') return 'cancelled';
  if (category === 'timeout') return 'timeout';
  if (category === 'provider') return 'transport';
  if (/not available|unavailable|command not found|dependency/i.test(String(content ?? ''))) return 'dependency';
  return 'tool_execution';
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function safeDimension(value) {
  return normalizeToken(value) ?? 'unknown';
}

function modelVendor(provider, model) {
  const haystack = `${provider ?? ''}/${model ?? ''}`.toLowerCase();
  if (/claude|anthropic/.test(haystack)) return 'Anthropic';
  if (/\b(gpt|chatgpt|codex|openai)|\bo[134](?:\b|-)/.test(haystack)) return 'OpenAI';
  if (/minimax/.test(haystack)) return 'MiniMax';
  if (/gemini|google/.test(haystack)) return 'Google';
  if (/grok|xai/.test(haystack)) return 'xAI';
  if (/qwen|alibaba/.test(haystack)) return 'Alibaba/Qwen';
  if (/kimi|moonshot/.test(haystack)) return 'Moonshot/Kimi';
  if (/glm|zhipu/.test(haystack)) return 'Zhipu/GLM';
  if (/mistral/.test(haystack)) return 'Mistral';
  if (/deepseek/.test(haystack)) return 'DeepSeek';
  return 'Other';
}

function modelCoordinates(message) {
  let provider = message?.provider ?? message?.vendor ?? null;
  let model = message?.model ?? message?.modelId ?? message?.model_id ?? null;
  if (!provider && typeof model === 'string' && model.includes('/')) [provider, model] = model.split('/', 2);
  return { vendor: modelVendor(provider, model), model: safeDimension(model) };
}

function createAccumulator() {
  return {
    responses: [],
    tools: [],
    errors: new Map(),
    waits: [],
    lifecycles: [],
  };
}

function summarizeModels(responses) {
  const vendors = new Map();
  for (const response of responses) {
    const vendor = vendors.get(response.vendor) ?? { vendor: response.vendor, response_count: 0, total_tokens: 0, tokens: [], models: new Map() };
    vendor.response_count += 1;
    vendor.total_tokens += response.tokens;
    vendor.tokens.push(response.tokens);
    const model = vendor.models.get(response.model) ?? { model: response.model, response_count: 0, total_tokens: 0, tokens: [] };
    model.response_count += 1;
    model.total_tokens += response.tokens;
    model.tokens.push(response.tokens);
    vendor.models.set(response.model, model);
    vendors.set(response.vendor, vendor);
  }
  return [...vendors.values()].map((vendor) => ({
    vendor: vendor.vendor,
    response_count: vendor.response_count,
    total_tokens: vendor.total_tokens,
    token_footprint: { samples: vendor.tokens.length, median: median(vendor.tokens) },
    models: [...vendor.models.values()].map((model) => ({
      model: model.model,
      response_count: model.response_count,
      total_tokens: model.total_tokens,
      token_footprint: { samples: model.tokens.length, median: median(model.tokens) },
    })).sort((a, b) => b.response_count - a.response_count || a.model.localeCompare(b.model)),
  })).sort((a, b) => b.response_count - a.response_count || a.vendor.localeCompare(b.vendor));
}

function summarizeTools(tools, minToolSamples) {
  const operations = new Map();
  for (const tool of tools) {
    const key = `${tool.operation}:${tool.backend}`;
    const operation = operations.get(key) ?? { operation: tool.operation, backend: tool.backend, samples: 0, failures: 0, outcomes: {} };
    operation.samples += 1;
    if (tool.failed) operation.failures += 1;
    operation.outcomes[tool.outcome] = (operation.outcomes[tool.outcome] ?? 0) + 1;
    operations.set(key, operation);
  }
  const rows = [...operations.values()].map((operation) => ({
    ...operation,
    failure_rate: rate(operation.failures, operation.samples),
  })).sort((a, b) => b.samples - a.samples || a.operation.localeCompare(b.operation) || a.backend.localeCompare(b.backend));
  const qualifying = rows.filter((operation) => operation.samples >= minToolSamples)
    .sort((a, b) => b.failure_rate - a.failure_rate || b.failures - a.failures || b.samples - a.samples || a.operation.localeCompare(b.operation) || a.backend.localeCompare(b.backend));
  const failures = tools.filter((tool) => tool.failed).length;
  return {
    paired: tools.length,
    failures,
    failure_rate: rate(failures, tools.length),
    operations: rows,
    worst_qualifying_operation: qualifying[0] ?? null,
  };
}

function lifecycleOutcome(data) {
  if (data?.success === true) return 'successful';
  if (data?.success === false) return 'unsuccessful';
  const explicitOutcome = safeDimension(data?.outcome);
  if (SUCCESSFUL_OUTCOMES.has(explicitOutcome)) return 'successful';
  if (UNSUCCESSFUL_OUTCOMES.has(explicitOutcome)) return 'unsuccessful';
  const state = safeDimension(data?.state ?? data?.status);
  if (UNSUCCESSFUL_OUTCOMES.has(state)) return 'unsuccessful';
  if (SUCCESSFUL_OUTCOMES.has(state) && record(data?.processTerminal)?.state === 'observed') return 'successful';
  return null;
}

function summarizeLifecycle(items) {
  const observed = items.filter((item) => item.outcome);
  const unsuccessful = observed.filter((item) => item.outcome === 'unsuccessful').length;
  const breakdown = (key) => {
    const values = new Map();
    for (const item of observed) {
      const label = item[key];
      const row = values.get(label) ?? { [key]: label, observed: 0, unsuccessful: 0 };
      row.observed += 1;
      if (item.outcome === 'unsuccessful') row.unsuccessful += 1;
      values.set(label, row);
    }
    return [...values.values()].map((row) => ({ ...row, unsuccessful_rate: rate(row.unsuccessful, row.observed) }))
      .sort((a, b) => b.observed - a.observed || a[key].localeCompare(b[key]));
  };
  const pairs = new Map();
  for (const item of observed) {
    const key = `${item.profile}:${item.mode}`;
    const row = pairs.get(key) ?? { profile: item.profile, mode: item.mode, observed: 0, unsuccessful: 0 };
    row.observed += 1;
    if (item.outcome === 'unsuccessful') row.unsuccessful += 1;
    pairs.set(key, row);
  }
  const byProfileMode = [...pairs.values()]
    .map((row) => ({ ...row, unsuccessful_rate: rate(row.unsuccessful, row.observed) }))
    .sort((a, b) => b.observed - a.observed || a.profile.localeCompare(b.profile) || a.mode.localeCompare(b.mode));
  return {
    records: items.length,
    outcomes_observed: observed.length,
    unsuccessful,
    unsuccessful_rate: rate(unsuccessful, observed.length),
    by_profile: breakdown('profile'),
    by_mode: breakdown('mode'),
    by_profile_mode: byProfileMode,
  };
}

function summarizeErrors(errors) {
  return [...errors.values()].map(({ turnKeys, ...row }) => ({ ...row, affected_turns: turnKeys.size }))
    .sort((a, b) => b.affected_turns - a.affected_turns
      || a.source.localeCompare(b.source) || a.category.localeCompare(b.category));
}

function summarize(accumulator, minToolSamples) {
  const tokens = accumulator.responses.map((response) => response.tokens);
  return {
    successful_terminal_responses: accumulator.responses.length,
    token_footprint: { samples: tokens.length, median: median(tokens) },
    model_vendors: summarizeModels(accumulator.responses),
    tool_operations: summarizeTools(accumulator.tools, minToolSamples),
    error_clusters: summarizeErrors(accumulator.errors),
    subagent_wait: { samples: accumulator.waits.length, p95_elapsed_ms: percentile95(accumulator.waits) },
    subagent_lifecycle: summarizeLifecycle(accumulator.lifecycles),
  };
}

function bucketStart(timestamp, bucket) {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  if (bucket === 'week') {
    const daysFromMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysFromMonday);
  }
  return date.getTime();
}

function addObservation(target, observation) {
  if (observation.kind === 'response') target.responses.push(observation);
  else if (observation.kind === 'tool') target.tools.push(observation);
  else if (observation.kind === 'error') {
    const key = `${observation.source}:${observation.category}:${observation.operation ?? ''}`;
    const row = target.errors.get(key) ?? {
      source: observation.source,
      category: observation.category,
      operation: observation.operation ?? null,
      turnKeys: new Set(),
    };
    row.turnKeys.add(observation.turnKey ?? `${observation.timestamp}:${observation.source}`);
    target.errors.set(key, row);
  } else if (observation.kind === 'wait') target.waits.push(observation.elapsed);
  else if (observation.kind === 'lifecycle') target.lifecycles.push(observation);
}

export function validateAnalyticsQuery(body) {
  if (!record(body)) throw new AnalyticsQueryError('request body must be an object');
  const fromMs = finiteTimestamp(body.from);
  const toMs = finiteTimestamp(body.to);
  if (fromMs == null || toMs == null) throw new AnalyticsQueryError('from and to must be valid timestamps');
  if (toMs <= fromMs) throw new AnalyticsQueryError('to must be later than from');
  if (toMs - fromMs > MAX_RANGE_MS) throw new AnalyticsQueryError('date range must not exceed 366 days');
  if (body.bucket !== 'day' && body.bucket !== 'week') throw new AnalyticsQueryError('bucket must be day or week');
  if (!Array.isArray(body.pi_session_ids)) throw new AnalyticsQueryError('pi_session_ids must be an array');
  if (body.pi_session_ids.length > 5000) throw new AnalyticsQueryError('pi_session_ids must contain at most 5000 entries');
  if (body.pi_session_ids.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new AnalyticsQueryError('pi_session_ids entries must be non-empty strings');
  }
  const minToolSamples = body.min_tool_samples === undefined ? 5 : body.min_tool_samples;
  if (!Number.isInteger(minToolSamples) || minToolSamples < 1) throw new AnalyticsQueryError('min_tool_samples must be a positive integer');
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    bucket: body.bucket,
    piSessionIds: [...new Set(body.pi_session_ids.map((id) => id.trim()))],
    requestedSessionCount: body.pi_session_ids.length,
    minToolSamples,
  };
}

function activeEntries(entries, activeBranch = null) {
  const normalized = entries.map((entry) => ({ ...entry, parentId: entry?.parentId ?? entry?.parent_id ?? null }));
  const branch = activeBranch?.active_entry_ids ? activeBranch : deriveActiveBranchMetadata(normalized);
  const ids = new Set(branch.active_entry_ids);
  return { entries: normalized.filter((entry) => entry?.id && ids.has(entry.id)), branch };
}

function observationsFromSession(session, query) {
  const branch = activeEntries(Array.isArray(session?.entries) ? session.entries : [], session?.activeBranch);
  const observations = [];
  const calls = new Map();
  const results = new Map();
  const lifecycles = new Map();
  const coverage = { pairedTools: 0, unpairedToolCalls: 0, unpairedToolResults: 0, unknownToolOutcomes: 0, excludedWaits: 0 };
  let responseCycleTokens = 0;

  for (const entry of branch.entries) {
    const timestamp = entryTimestamp(entry);
    const message = record(entry.message);
    for (const call of toolCalls(entry)) calls.set(call.id, call);
    if (entry.type === 'message' && message?.role === 'toolResult') {
      const id = message.toolCallId ?? message.tool_call_id;
      if (typeof id === 'string' && id) results.set(id, { message, timestamp });
    }
    if (entry.type === 'message' && message?.role === 'user') responseCycleTokens = 0;

    if (entry.type === 'message' && message?.role === 'assistant') {
      responseCycleTokens += positiveTokens(message.usage) ?? 0;
      const parts = contentParts(message.content);
      if (timestamp != null && timestamp >= query.fromMs && timestamp < query.toMs
        && hasVisibleText(message.content) && responseCycleTokens > 0
        && (message.stopReason === 'stop' || message.stopReason === 'length')
        && !parts.some((part) => part.type === 'toolCall' || part.type === 'tool_call')) {
        observations.push({ kind: 'response', timestamp, tokens: responseCycleTokens, ...modelCoordinates(message) });
        responseCycleTokens = 0;
      }
      if (timestamp != null && timestamp >= query.fromMs && timestamp < query.toMs
        && (message.stopReason === 'error' || message.stopReason === 'aborted' || message.errorMessage)) {
        observations.push({ kind: 'error', source: 'provider', timestamp, category: classifyError(message.errorMessage), turnKey: entry.id });
        responseCycleTokens = 0;
      }
    }

    if (entry.type === 'custom' && entry.customType === 'monika.subagent.run') {
      const data = record(entry.data);
      const lifecycleTimestamp = finiteTimestamp(data?.completedAt ?? data?.updatedAt ?? data?.startedAt) ?? timestamp;
      if (data && lifecycleTimestamp != null) {
        const key = typeof data.runId === 'string' && data.runId ? data.runId : entry.id;
        const previous = lifecycles.get(key);
        if (!previous || lifecycleTimestamp >= previous.timestamp) {
          lifecycles.set(key, {
            kind: 'lifecycle',
            timestamp: lifecycleTimestamp,
            outcome: lifecycleOutcome(data) ?? previous?.outcome ?? null,
            profile: safeDimension(data.profile ?? data.agentProfile ?? data.agent_profile ?? previous?.profile),
            mode: safeDimension(data.mode ?? data.executionMode ?? data.execution_mode ?? previous?.mode),
            turnKey: key,
          });
        }
      }
    }
  }

  for (const data of Array.isArray(session?.lifecycleRecords) ? session.lifecycleRecords : []) {
    const timestamp = finiteTimestamp(data?.completed_at ?? data?.updated_at ?? data?.started_at);
    if (timestamp == null) continue;
    const key = typeof data.run_id === 'string' ? data.run_id : `artifact-${lifecycles.size}`;
    lifecycles.set(key, {
      kind: 'lifecycle', timestamp,
      outcome: data.execution_state === 'uncertain' || data.execution_state === 'active'
        ? null
        : lifecycleOutcome({
          success: data.success,
          state: data.execution_state === 'interrupted' || data.execution_state === 'quarantined'
            ? data.execution_state : data.state,
          processTerminal: data.processTerminal,
        }),
      profile: safeDimension(data.profile),
      mode: safeDimension(data.mode),
      turnKey: key,
    });
  }

  for (const lifecycle of lifecycles.values()) {
    if (lifecycle.timestamp >= query.fromMs && lifecycle.timestamp < query.toMs) {
      observations.push(lifecycle);
      if (lifecycle.outcome === 'unsuccessful') observations.push({ kind: 'error', source: 'subagent', category: 'tool_execution', timestamp: lifecycle.timestamp, turnKey: lifecycle.turnKey });
    }
  }

  for (const [id, call] of calls) {
    const result = results.get(id);
    if (call.timestamp == null || call.timestamp < query.fromMs || call.timestamp >= query.toMs) continue;
    if (!result) {
      coverage.unpairedToolCalls += 1;
      continue;
    }
    coverage.pairedTools += 1;
    const rawOutcome = typeof result.message.isError === 'boolean' ? result.message.isError
      : typeof result.message.is_error === 'boolean' ? result.message.is_error : null;
    const operation = normalizeToolOperation(call.name, call.arguments);
    if (rawOutcome == null) {
      coverage.unknownToolOutcomes += 1;
    } else {
      const content = typeof result.message.content === 'string'
        ? result.message.content
        : contentParts(result.message.content).map((part) => part.text ?? part.content ?? '').join(' ');
      observations.push({
        kind: 'tool', timestamp: call.timestamp, operation, failed: rawOutcome,
        backend: toolBackend(result.message.details, operation),
        outcome: toolOutcome(rawOutcome, result.message.details, content),
      });
      if (rawOutcome) {
        observations.push({ kind: 'error', source: 'tool', operation, timestamp: call.timestamp, category: classifyError(content, 'tool_execution'), turnKey: call.turnKey });
      }
    }
    if (operation === 'subagent_wait' && result.timestamp != null) {
      const elapsed = result.timestamp - call.timestamp;
      if (elapsed >= 0 && elapsed <= DAY_MS) observations.push({ kind: 'wait', timestamp: call.timestamp, elapsed });
      else coverage.excludedWaits += 1;
    }
  }
  for (const [id, result] of results) {
    if (calls.has(id) || result.timestamp == null || result.timestamp < query.fromMs || result.timestamp >= query.toMs) continue;
    coverage.unpairedToolResults += 1;
  }
  return { observations, activeEntryCount: branch.entries.length, coverage };
}

/** Aggregate already-read canonical Pi JSONL entries. This function performs no I/O. */
export function aggregateAnalytics(sessions, queryInput) {
  const query = queryInput?.fromMs != null ? queryInput : validateAnalyticsQuery(queryInput);
  const overall = createAccumulator();
  const bucketAccumulators = new Map();
  let activeBranchEntries = 0;
  let parseErrors = 0;
  const metricCoverage = { pairedTools: 0, unpairedToolCalls: 0, unpairedToolResults: 0, unknownToolOutcomes: 0, excludedWaits: 0 };
  let earliest = null;
  let latest = null;

  for (const session of Array.isArray(sessions) ? sessions : []) {
    parseErrors += Number.isInteger(session?.parseErrors) ? session.parseErrors : 0;
    const result = observationsFromSession(session, query);
    activeBranchEntries += result.activeEntryCount;
    for (const key of Object.keys(metricCoverage)) metricCoverage[key] += result.coverage[key];
    for (const observation of result.observations) {
      addObservation(overall, observation);
      earliest = earliest == null ? observation.timestamp : Math.min(earliest, observation.timestamp);
      latest = latest == null ? observation.timestamp : Math.max(latest, observation.timestamp);
      const start = bucketStart(observation.timestamp, query.bucket);
      const accumulator = bucketAccumulators.get(start) ?? createAccumulator();
      addObservation(accumulator, observation);
      bucketAccumulators.set(start, accumulator);
    }
  }

  const buckets = [];
  const firstBucket = bucketStart(query.fromMs, query.bucket);
  const step = query.bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  for (let start = firstBucket; start < query.toMs; start += step) {
    const end = start + step;
    buckets.push({
      start: new Date(Math.max(start, query.fromMs)).toISOString(),
      end: new Date(Math.min(end, query.toMs)).toISOString(),
      ...summarize(bucketAccumulators.get(start) ?? createAccumulator(), query.minToolSamples),
    });
  }

  const scannedSessions = Array.isArray(sessions) ? sessions.length : 0;
  return {
    schema_version: 1,
    from: query.from,
    to: query.to,
    bucket: query.bucket,
    min_tool_samples: query.minToolSamples,
    build: analyticsBuildInfo(),
    coverage: {
      requested_sessions: query.requestedSessionCount ?? query.piSessionIds?.length ?? scannedSessions,
      unique_allowlisted_sessions: query.piSessionIds?.length ?? scannedSessions,
      scanned_sessions: scannedSessions,
      missing_sessions: Math.max(0, (query.piSessionIds?.length ?? scannedSessions) - scannedSessions),
      parse_errors: parseErrors,
      active_branch_entries: activeBranchEntries,
      paired_tool_results: metricCoverage.pairedTools,
      unpaired_tool_calls: metricCoverage.unpairedToolCalls,
      unpaired_tool_results: metricCoverage.unpairedToolResults,
      unknown_tool_outcomes: metricCoverage.unknownToolOutcomes,
      excluded_wait_durations: metricCoverage.excludedWaits,
      earliest_observation_at: earliest == null ? null : new Date(earliest).toISOString(),
      latest_observation_at: latest == null ? null : new Date(latest).toISOString(),
    },
    totals: summarize(overall, query.minToolSamples),
    buckets,
  };
}

/** Small process-local cache; values disappear on restart and are never persisted. */
export class AnalyticsTtlCache {
  constructor({ ttlMs = 30_000, maxEntries = 128, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (!(this.ttlMs > 0) || !(this.maxEntries > 0)) return value;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return value;
  }
}

export const analyticsErrorCategories = ERROR_CATEGORIES;
