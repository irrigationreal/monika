import { render, screen } from '@testing-library/vue';
import { describe, expect, it } from 'vitest';

import LiveAssistantTurn from './LiveAssistantTurn.vue';

import type { LiveTurnItem } from './LiveAssistantTurn.vue';

function reasoningItem(index: number): LiveTurnItem {
  return {
    id: `reasoning:${index}`,
    type: 'reasoning',
    title: `Step ${index}`,
    status: 'done',
    markdown: `Detail ${index}`,
  };
}

describe('LiveAssistantTurn', () => {
  it('pins status and renders only the latest 15 chronological trace items', () => {
    const items: LiveTurnItem[] = [
      { id: 'status:activity', type: 'status', title: 'Thinking', status: 'running' },
      ...Array.from({ length: 20 }, (_, index) => reasoningItem(index + 1)),
    ];

    const { container } = render(LiveAssistantTurn, {
      props: { items, activity: 'thinking', active: true },
    });

    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.queryByText('Step 5')).toBeNull();
    expect(screen.getByText('Step 6')).toBeTruthy();
    expect(screen.getByText('Step 20')).toBeTruthy();
    expect(container.querySelectorAll('.vb-live-turn-item--reasoning')).toHaveLength(15);
  });
});
