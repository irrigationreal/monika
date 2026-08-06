import { render, screen, waitFor } from '@testing-library/vue';
import { describe, expect, it, vi } from 'vitest';

import { enhanceMermaidDirective } from '../lib/mermaidEnhancement';
import LiveAssistantTurn from './LiveAssistantTurn.vue';

import type { LiveTurnItem } from './LiveAssistantTurn.vue';

function reasoningItem(index: number): LiveTurnItem {
  return {
    id: `reasoning:${String(index)}`,
    type: 'reasoning',
    title: `Step ${String(index)}`,
    status: 'done',
    markdown: `Detail ${String(index)}`,
  };
}

describe('LiveAssistantTurn', () => {
  it('pins status and renders only the latest 15 chronological trace items', () => {
    const items: LiveTurnItem[] = [{ id: 'status:activity', type: 'status', title: 'Thinking', status: 'running' }];
    for (let index = 1; index <= 20; index += 1) items.push(reasoningItem(index));

    const { container } = render(LiveAssistantTurn, {
      props: { items, activity: 'thinking', active: true },
    });

    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.queryByText('Step 5')).toBeNull();
    expect(screen.getByText('Step 6')).toBeTruthy();
    expect(screen.getByText('Step 20')).toBeTruthy();
    expect(container.querySelectorAll('.vb-live-turn-item--reasoning')).toHaveLength(15);
  });

  it('runs Mermaid enhancement through the real live-assistant Vue surface', async () => {
    const observed = new Set<Element>();
    class FakeIntersectionObserver {
      observe(element: Element): void {
        observed.add(element);
      }
      unobserve(element: Element): void {
        observed.delete(element);
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    const items: LiveTurnItem[] = [
      {
        id: 'assistant:1',
        type: 'assistant_text',
        text: ['```mermaid', 'flowchart LR', '  Forum --> Pi', '```'].join('\n'),
      },
    ];
    const rendered = render(LiveAssistantTurn, {
      props: { items, activity: 'responding', active: true },
      global: { directives: { 'enhance-mermaid': enhanceMermaidDirective } },
    });

    const block = rendered.container.querySelector('.vb-mermaid-block');
    expect(block).not.toBeNull();
    if (!block) throw new Error('Expected a Mermaid enhancement placeholder.');
    await waitFor(() => {
      expect(observed.has(block)).toBe(true);
    });

    rendered.unmount();
    expect(observed.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
