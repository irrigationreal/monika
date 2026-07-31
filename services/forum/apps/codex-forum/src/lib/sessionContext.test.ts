import { describe, expect, it } from 'vitest';

import { retainSessionContext } from './sessionContext';

import type { SessionContextDto } from '../lib/apiClient';

const snapshot = (usedTokens: number): SessionContextDto => ({
  model: 'openai/gpt-5.2',
  provider: 'openai',
  modelId: 'gpt-5.2',
  thinkingLevel: 'high',
  contextWindowTokens: 200_000,
  usedTokens,
  remainingTokens: 200_000 - usedTokens,
  percent: (usedTokens / 200_000) * 100,
  exact: false,
  source: 'pi-runtime-estimate',
  asOfPiMessageId: null,
});

describe('retainSessionContext', () => {
  it('keeps the initial snapshot across unrelated state events and failed refreshes', () => {
    const initial = snapshot(40_000);
    expect(retainSessionContext(initial, undefined)).toBe(initial);
    expect(retainSessionContext(initial, null)).toBe(initial);
  });

  it('replaces the snapshot when a context update arrives', () => {
    const updated = snapshot(55_000);
    expect(retainSessionContext(snapshot(40_000), updated)).toBe(updated);
  });
});
