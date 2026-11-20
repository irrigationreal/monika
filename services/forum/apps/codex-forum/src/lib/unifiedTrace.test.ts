import { describe, expect, it } from 'vitest';

import { buildLiveTraceItems, buildPersistedTraceItems, liveTraceNeedsPersistedFallback } from './unifiedTrace';

import type { ToolRunDto } from './apiClient';

function tool(id: string, startedAt: string): ToolRunDto {
  return {
    id,
    tool: 'read',
    parentPostId: 'post-1',
    startedAt,
    finishedAt: startedAt,
    exitCode: 0,
    command: `read {"path":"${id}"}`,
    filesTouched: [],
    outputSummary: null,
    redactionsApplied: false,
    visibility: 'internal',
  };
}

describe('unified trace items', () => {
  it('uses full persisted checkpoints after reload when live reconstruction contains only recent children', () => {
    const rows = Array.from({ length: 65 }, (_, i) => tool(String(i), new Date(i).toISOString()));
    const live = buildLiveTraceItems({
      tools: rows,
      segments: rows.slice(-20).map((row) => ({ kind: 'tool', toolRunId: row.id })),
    });
    expect(live).toHaveLength(20);
    expect(liveTraceNeedsPersistedFallback(live, rows)).toBe(true);
    const hydrated = buildPersistedTraceItems({ tools: rows });
    expect(hydrated).toHaveLength(65);
    expect(hydrated[0]?.type === 'tool' && hydrated[0].tool.id).toBe('0');
    expect(liveTraceNeedsPersistedFallback(hydrated, rows)).toBe(false);
  });
  it('interleaves persisted reasoning with chronologically sorted tools at checkpoints', () => {
    const first = tool('first', '2026-01-01T00:00:01.000Z');
    const second = tool('second', '2026-01-01T00:00:02.000Z');
    const firstReasoning = '**Inspect**\nRead the source.\n';
    const secondReasoning = '**Compare**\nCheck the result.\n';
    const tailReasoning = '**Conclude**\nPrepare the answer.';
    const reasoningText = `${firstReasoning}${secondReasoning}${tailReasoning}`;

    const items = buildPersistedTraceItems({
      reasoningText,
      reasoningCheckpoints: [firstReasoning.length, firstReasoning.length + secondReasoning.length],
      tools: [second, first],
    });

    expect(items.map((item) => item.type)).toEqual(['reasoning', 'tool', 'reasoning', 'tool', 'reasoning']);
    expect(items.filter((item) => item.type === 'tool').map((item) => item.tool.id)).toEqual(['first', 'second']);
    expect(items.filter((item) => item.type === 'reasoning').map((item) => item.steps[0]?.title)).toEqual([
      'Inspect',
      'Compare',
      'Conclude',
    ]);
  });

  it('uses newest-first input order to break equal timestamp ties chronologically', () => {
    const first = tool('first', '2026-01-01T00:00:01.000Z');
    const second = tool('second', '2026-01-01T00:00:01.000Z');
    const firstReasoning = '**First**\nBefore the first tool.\n';
    const secondReasoning = '**Second**\nBefore the second tool.';

    const items = buildPersistedTraceItems({
      reasoningText: `${firstReasoning}${secondReasoning}`,
      reasoningCheckpoints: [firstReasoning.length, firstReasoning.length + secondReasoning.length],
      tools: [second, first],
    });

    expect(items.filter((item) => item.type === 'tool').map((item) => item.tool.id)).toEqual(['first', 'second']);
  });

  it('falls back to reasoning followed by tools when checkpoints are unavailable', () => {
    const items = buildPersistedTraceItems({
      reasoningText: '**Think**\nLegacy reasoning.',
      reasoningCheckpoints: null,
      tools: [tool('tool-1', '2026-01-01T00:00:01.000Z')],
    });

    expect(items.map((item) => item.type)).toEqual(['reasoning', 'tool']);
  });

  it('uses append-only live reasoning and tool segments', () => {
    const first = tool('first', '2026-01-01T00:00:01.000Z');
    const items = buildLiveTraceItems({
      segments: [
        { kind: 'reasoning', text: '**Inspect**\nRead the source.' },
        { kind: 'tool', toolRunId: first.id },
      ],
      reasoningDraft: '**Verify**\nCheck the output.',
      tools: [first],
    });

    expect(items.map((item) => item.type)).toEqual(['reasoning', 'tool', 'reasoning']);
    expect(items.filter((item) => item.type === 'reasoning').map((item) => item.steps[0]?.title)).toEqual([
      'Inspect',
      'Verify',
    ]);
  });
});
