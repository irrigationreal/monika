import { fireEvent, render, screen } from '@testing-library/vue';
import { describe, expect, it } from 'vitest';

import OperationalEventBar from './OperationalEventBar.vue';

import type { TopicOperationalEventDto } from '../lib/apiClient';

function event(overrides: Partial<TopicOperationalEventDto> = {}): TopicOperationalEventDto {
  return {
    id: 'event-1',
    topicId: 'topic-1',
    anchorPostId: 'post-1',
    type: 'turn_error',
    category: 'assistant',
    status: 'failed',
    summary: 'The model exceeded its context window.',
    detail: { error: 'context length overflow: 200001 tokens' },
    sourceKind: 'echs_turn',
    sourceId: 'turn-1',
    createdAt: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('OperationalEventBar', () => {
  it('keeps raw error detail collapsed and offers context recovery', async () => {
    const view = render(OperationalEventBar, { props: { event: event(), canRecover: true, recoverDisabled: false } });

    expect(view.container.querySelector('.vb-operational-event--error')).toBeTruthy();
    expect(screen.getByText('Raw error detail').closest('details')?.open).toBe(false);
    expect(screen.getByText('context length overflow: 200001 tokens')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Compact and recover' }));
    expect(view.emitted()['recover']).toHaveLength(1);
  });

  it('uses the structured category for the provider wording seen in production', () => {
    render(OperationalEventBar, {
      props: {
        event: event({
          summary: 'Assistant response failed.',
          detail: {
            category: 'context_overflow',
            error: 'Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.',
          },
        }),
        canRecover: true,
      },
    });

    expect(screen.getByRole('button', { name: 'Compact and recover' })).toBeTruthy();
  });

  it('recognizes legacy overflow wording when structured detail is unavailable', () => {
    render(OperationalEventBar, {
      props: {
        event: event({
          summary: 'The input exceeds the context window.',
          detail: null,
        }),
        canRecover: true,
      },
    });

    expect(screen.getByRole('button', { name: 'Compact and recover' })).toBeTruthy();
  });

  it('does not expose a recovery action for redacted public detail without an overflow summary', () => {
    render(OperationalEventBar, {
      props: { event: event({ summary: 'The response failed.', detail: null }), canRecover: true },
    });

    expect(screen.queryByText('Raw error detail')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compact and recover' })).toBeNull();
  });

  it.each([
    { status: 'failed', tone: 'error', label: 'Compaction failed' },
    { status: 'succeeded', tone: 'success', label: 'Session compacted' },
  ] as const)('uses the $tone theme tone for $status compaction', ({ status, tone, label }) => {
    const view = render(OperationalEventBar, {
      props: {
        event: event({ type: 'compaction', status, summary: `Compaction ${status}.`, detail: null }),
      },
    });

    expect(view.container.querySelector(`.vb-operational-event--${tone}`)).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
  });
});
