import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateAnalytics,
  AnalyticsQueryError,
  AnalyticsTtlCache,
  analyticsBuildInfo,
  analyticsErrorCategories,
  normalizeToolOperation,
  validateAnalyticsQuery,
} from '../src/analytics.mjs';

const at = (day, time = '00:00:00.000') => `2026-01-${String(day).padStart(2, '0')}T${time}Z`;

function query(overrides = {}) {
  return {
    from: at(1),
    to: at(4),
    bucket: 'day',
    pi_session_ids: ['session-secret'],
    min_tool_samples: 1,
    ...overrides,
  };
}

function fixtureSession() {
  return {
    parseErrors: 2,
    entries: [
      { type: 'session', id: 'session-secret', timestamp: at(1) },
      { type: 'message', id: 'root', parentId: null, timestamp: at(1, '00:10:00.000'), message: { role: 'user', content: 'private prompt' } },
      // This sibling is not on the latest root-to-leaf branch and must not count.
      { type: 'message', id: 'discarded', parentId: 'root', timestamp: at(1, '00:20:00.000'), message: { role: 'assistant', content: [{ type: 'text', text: 'discarded private answer' }], stopReason: 'stop', usage: { totalTokens: 999 }, provider: 'discarded', model: 'discarded-model' } },
      { type: 'message', id: 'answer-1', parentId: 'root', timestamp: at(1, '01:00:00.000'), message: { role: 'assistant', content: [{ type: 'text', text: 'private answer' }], stopReason: 'stop', usage: { input: 60, output: 40 }, provider: 'Anthropic', model: 'Claude-Analytics' } },
      // Visible text does not make a tool-calling assistant response terminal analytics data.
      { type: 'message', id: 'calls', parentId: 'answer-1', timestamp: at(2, '01:00:00.000'), message: { role: 'assistant', content: [
        { type: 'text', text: 'I will inspect /private/a' },
        { type: 'toolCall', id: 'call-private-1', name: 'Read', arguments: { path: '/private/a' } },
        { type: 'toolCall', id: 'call-private-2', name: 'subagent', arguments: { action: 'wait', runId: 'run-private' } },
      ], stopReason: 'stop', usage: { totalTokens: 50 }, provider: 'Anthropic', model: 'Claude-Analytics' } },
      { type: 'message', id: 'result-1', parentId: 'calls', timestamp: at(2, '01:00:01.000'), message: { role: 'toolResult', toolCallId: 'call-private-1', toolName: 'Read', isError: true, content: 'Timed out opening /private/a: raw secret', details: { backend: 'relocated_ssh', outcome: 'timeout', privatePath: '/private/a' } } },
      { type: 'message', id: 'result-2', parentId: 'result-1', timestamp: at(2, '01:00:09.500'), message: { role: 'toolResult', toolCallId: 'call-private-2', toolName: 'subagent', isError: false, content: 'run-private finished' } },
      { type: 'message', id: 'provider-error', parentId: 'result-2', timestamp: at(2, '02:00:00.000'), message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 invalid API key secret-value', provider: 'Anthropic', model: 'Claude-Analytics' } },
      { type: 'custom', id: 'lifecycle', parentId: 'provider-error', timestamp: at(2, '03:00:00.000'), customType: 'monika.subagent.run', data: { version: 1, runId: 'run-private', completedAt: at(2, '03:00:00.000'), outcome: 'failed', profile: 'Tracer', mode: 'Async', asyncDir: '/private/runtime' } },
      { type: 'message', id: 'zero-usage', parentId: 'lifecycle', timestamp: at(2, '04:00:00.000'), message: { role: 'assistant', content: [{ type: 'text', text: 'not measured' }], stopReason: 'stop', usage: { totalTokens: 0 }, provider: 'OpenAI', model: 'gpt-zero' } },
      { type: 'message', id: 'answer-2', parentId: 'zero-usage', timestamp: at(3, '01:00:00.000'), message: { role: 'assistant', content: [{ type: 'text', text: 'another private answer' }], stopReason: 'length', usage: { totalTokens: 200 }, provider: 'OpenAI', model: 'GPT-Test' } },
    ],
  };
}

test('reports only validated immutable build identity', () => {
  assert.deepEqual(analyticsBuildInfo({ MONIKA_BUILD_COMMIT: 'ABCDEF1234567', MONIKA_BUILD_DATE: '2026-08-01T10:00:00Z' }), {
    commit: 'abcdef1234567',
    created_at: '2026-08-01T10:00:00.000Z',
  });
  assert.deepEqual(analyticsBuildInfo({ MONIKA_BUILD_COMMIT: 'latest/private', MONIKA_BUILD_DATE: 'not-a-date' }), {
    commit: null,
    created_at: null,
  });
});

test('validates and canonicalizes analytics queries', () => {
  const validated = validateAnalyticsQuery(query({ pi_session_ids: [' one ', 'one', 'two'], min_tool_samples: undefined }));
  assert.equal(validated.minToolSamples, 5);
  assert.deepEqual(validated.piSessionIds, ['one', 'two']);
  assert.equal(validated.requestedSessionCount, 3);
  assert.equal(validated.from, at(1));

  const invalid = [
    query({ bucket: 'month' }),
    query({ from: at(4), to: at(1) }),
    query({ from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' }),
    query({ pi_session_ids: 'session-secret' }),
    query({ pi_session_ids: Array.from({ length: 5001 }, (_, index) => String(index)) }),
    query({ pi_session_ids: [''] }),
    query({ min_tool_samples: 0 }),
    query({ min_tool_samples: 1.5 }),
  ];
  for (const input of invalid) assert.throws(() => validateAnalyticsQuery(input), AnalyticsQueryError);
});

test('normalizes tool operations without exposing arguments', () => {
  assert.equal(normalizeToolOperation('Read', { path: '/secret/path' }), 'read');
  assert.equal(normalizeToolOperation('subagent', { action: 'WAIT', runId: 'secret' }), 'subagent_wait');
  assert.equal(normalizeToolOperation('subagent', { action: 'customer_api_key_123' }), 'subagent_other');
  assert.equal(normalizeToolOperation('mcp__pi-subagents__subagent_wait'), 'subagent_wait');
  assert.equal(normalizeToolOperation('mcp__pi-subagents__subagent', { action: 'WAIT' }), 'subagent_wait');
  assert.equal(normalizeToolOperation('bash', { command: 'cd /secret && pnpm test' }), 'bash:pnpm');
  assert.equal(normalizeToolOperation('bash', { command: 'rg one .; rg two .' }), 'bash:mixed');
  assert.equal(normalizeToolOperation('relocate', {}), 'relocate_status');
  assert.equal(normalizeToolOperation('relocate', { target: 'local' }), 'relocate_local');
  assert.equal(normalizeToolOperation('relocate', { target: 'private-host:/private/path' }), 'relocate_remote');
  assert.equal(normalizeToolOperation('bash', { command: '/private/secret-command --token shh' }), 'bash:other');
  assert.equal(normalizeToolOperation('odd tool!', { command: 'cat /secret' }), 'odd_tool');
});

test('aggregates only the active branch and emits privacy-safe canonical metrics', () => {
  const result = aggregateAnalytics([fixtureSession()], query());

  assert.equal(result.schema_version, 2);
  assert.match(result.generated_at, /^20\d\d-/);
  assert.deepEqual(result.build, analyticsBuildInfo());
  assert.deepEqual(result.coverage, {
    requested_sessions: 1,
    unique_allowlisted_sessions: 1,
    scanned_sessions: 1,
    missing_sessions: 0,
    parse_errors: 2,
    active_branch_entries: 9,
    paired_tool_results: 2,
    unpaired_tool_calls: 0,
    unpaired_tool_results: 0,
    unknown_tool_outcomes: 0,
    excluded_wait_durations: 0,
    earliest_observation_at: at(1, '01:00:00.000'),
    latest_observation_at: at(3, '01:00:00.000'),
  });
  assert.equal(result.buckets.length, 3);
  assert.deepEqual(
    result.buckets.map((bucket) => ({
      start: bucket.start,
      end: bucket.end,
      observedFrom: bucket.observed_from,
      observedTo: bucket.observed_to,
      partial: bucket.is_partial,
    })),
    [1, 2, 3].map((day) => ({
      start: at(day),
      end: at(day + 1),
      observedFrom: at(day),
      observedTo: at(day + 1),
      partial: false,
    })),
  );
  assert.deepEqual(result.totals.token_footprint, { samples: 2, median: 150 });
  assert.equal(result.totals.successful_terminal_responses, 2);
  assert.deepEqual(result.totals.model_vendors.map((row) => [row.vendor, row.response_count]), [
    ['Anthropic', 1],
    ['OpenAI', 1],
  ]);
  assert.equal(result.totals.model_vendors[0].models[0].model, 'claude-analytics');

  assert.equal(result.totals.tool_operations.paired, 2);
  assert.equal(result.totals.tool_operations.failures, 1);
  assert.equal(result.totals.tool_operations.failure_rate, 0.5);
  assert.deepEqual(result.totals.tool_operations.worst_qualifying_operation, {
    operation: 'read', backend: 'relocated_ssh', samples: 1, failures: 1, outcomes: { timeout: 1 }, failure_rate: 1,
  });
  assert.deepEqual(result.totals.subagent_wait, { samples: 1, p95_elapsed_ms: 9500 });

  const errors = result.totals.error_clusters;
  assert.deepEqual(errors, [
    { source: 'provider', category: 'authentication', operation: null, affected_turns: 1 },
    { source: 'subagent', category: 'tool_execution', operation: null, affected_turns: 1 },
    { source: 'tool', category: 'timeout', operation: 'read', affected_turns: 1 },
  ]);
  assert.equal(analyticsErrorCategories.includes('authentication'), true);

  assert.deepEqual(result.totals.subagent_lifecycle, {
    records: 1,
    outcomes_observed: 1,
    unsuccessful: 1,
    unsuccessful_rate: 1,
    by_profile: [{ profile: 'tracer', observed: 1, unsuccessful: 1, unsuccessful_rate: 1 }],
    by_mode: [{ mode: 'async', observed: 1, unsuccessful: 1, unsuccessful_rate: 1 }],
    by_profile_mode: [{ profile: 'tracer', mode: 'async', observed: 1, unsuccessful: 1, unsuccessful_rate: 1 }],
  });

  const serialized = JSON.stringify(result);
  for (const privateValue of [
    'session-secret', 'private prompt', 'private answer', '/private', 'raw secret',
    'call-private', 'run-private', 'invalid API key', 'discarded-model',
  ]) assert.equal(serialized.includes(privateValue), false, `response leaked ${privateValue}`);
});

test('honors a reconciled live branch and excludes uncertain lifecycle outcomes', () => {
  const session = fixtureSession();
  session.activeBranch = { active_entry_ids: ['root', 'discarded'] };
  session.lifecycleRecords = [{
    run_id: 'uncertain-run', parent_session_id: 'session-secret', state: 'failed',
    execution_state: 'uncertain', updated_at: at(2), profile: 'worker', mode: 'async',
  }];
  const result = aggregateAnalytics([session], query());
  assert.equal(result.totals.successful_terminal_responses, 1);
  assert.equal(result.totals.model_vendors[0].vendor, 'Other');
  assert.equal(result.totals.subagent_lifecycle.outcomes_observed, 0);
  assert.equal(result.totals.subagent_lifecycle.records, 1);
});

test('keeps calendar bucket identity while marking clipped daily and weekly intervals partial', () => {
  const daily = aggregateAnalytics([], query({
    from: at(1, '12:00:00.000'),
    to: at(3, '12:00:00.000'),
  }));
  assert.deepEqual(daily.buckets.map((bucket) => [bucket.start, bucket.end, bucket.observed_from, bucket.observed_to, bucket.is_partial]), [
    [at(1), at(2), at(1, '12:00:00.000'), at(2), true],
    [at(2), at(3), at(2), at(3), false],
    [at(3), at(4), at(3), at(3, '12:00:00.000'), true],
  ]);

  const weekly = aggregateAnalytics([], query({
    from: '2026-01-07T12:00:00.000Z',
    to: '2026-01-14T12:00:00.000Z',
    bucket: 'week',
  }));
  assert.deepEqual(weekly.buckets.map((bucket) => [bucket.start, bucket.end, bucket.is_partial]), [
    ['2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.000Z', true],
    ['2026-01-12T00:00:00.000Z', '2026-01-19T00:00:00.000Z', true],
  ]);
});

test('reports missing coverage, empty buckets, and null rates without inventing data', () => {
  const result = aggregateAnalytics([], query({ pi_session_ids: ['missing-a', 'missing-b'], min_tool_samples: 3 }));
  assert.equal(result.coverage.scanned_sessions, 0);
  assert.equal(result.coverage.missing_sessions, 2);
  assert.equal(result.buckets.length, 3);
  assert.equal(result.totals.token_footprint.median, null);
  assert.equal(result.totals.tool_operations.failure_rate, null);
  assert.equal(result.totals.tool_operations.worst_qualifying_operation, null);
  assert.equal(result.totals.subagent_wait.p95_elapsed_ms, null);
  assert.equal(result.totals.subagent_lifecycle.unsuccessful_rate, null);
});

test('uses nearest-rank p95 and applies the minimum sample threshold', () => {
  const entries = [
    { type: 'session', id: 's' },
    { type: 'message', id: 'root', parentId: null, timestamp: at(1), message: { role: 'user', content: 'x' } },
  ];
  let parentId = 'root';
  for (let index = 1; index <= 20; index += 1) {
    const callId = `c${index}`;
    const callEntryId = `a${index}`;
    entries.push({
      type: 'message',
      id: callEntryId,
      parentId,
      timestamp: at(1, `01:00:${String(index).padStart(2, '0')}.000`),
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { action: 'wait' } }],
        stopReason: 'stop',
        usage: { totalTokens: 1 },
      },
    });
    const resultId = `r${index}`;
    entries.push({ type: 'message', id: resultId, parentId: callEntryId, timestamp: Date.parse(at(1, `01:00:${String(index).padStart(2, '0')}.000`)) + index * 1000, message: { role: 'toolResult', toolCallId: callId, isError: index <= 2, content: index <= 2 ? 'tool failed' : 'ok' } });
    parentId = resultId;
  }
  const result = aggregateAnalytics([{ entries, parseErrors: 0 }], query({ pi_session_ids: ['s'], min_tool_samples: 20 }));
  assert.equal(result.totals.subagent_wait.p95_elapsed_ms, 19_000);
  assert.equal(result.totals.tool_operations.worst_qualifying_operation.operation, 'subagent_wait');
  assert.equal(result.totals.tool_operations.worst_qualifying_operation.failure_rate, 0.1);
});

test('TTL cache expires values and evicts least-recently-used entries', () => {
  let now = 100;
  const cache = new AnalyticsTtlCache({ ttlMs: 10, maxEntries: 2, now: () => now });
  cache.set('a', { value: 1 });
  cache.set('b', { value: 2 });
  assert.equal(cache.get('a').value, 1); // a is now most recently used
  cache.set('c', { value: 3 });
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a').value, 1);
  now = 111;
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('c'), null);
});
