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

    expect(screen.getByText('Raw error detail').closest('details')?.open).toBe(false);
    expect(screen.getByText('context length overflow: 200001 tokens')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Compact and recover' }));
    expect(view.emitted()['recover']).toHaveLength(1);
  });

  it('does not expose a recovery action for redacted public detail without an overflow summary', () => {
    render(OperationalEventBar, {
      props: { event: event({ summary: 'The response failed.', detail: null }), canRecover: true },
    });

    expect(screen.queryByText('Raw error detail')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compact and recover' })).toBeNull();
  });
});
