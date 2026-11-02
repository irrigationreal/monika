import { describe, expect, it } from 'vitest';

import { resolveTopicReplySelection } from './replyModelSelection';

describe('resolveTopicReplySelection', () => {
  it('prefers the topic state over the new-topic fallback', () => {
    expect(
      resolveTopicReplySelection(
        { model: 'topic-model', reasoningEffort: 'high' },
        { model: 'last-used-model', reasoningEffort: 'medium' }
      )
    ).toEqual({ model: 'topic-model', reasoningEffort: 'high' });
  });

  it('falls back independently when the topic has no setting', () => {
    expect(
      resolveTopicReplySelection(
        { model: null, reasoningEffort: null },
        { model: 'last-used-model', reasoningEffort: 'medium' }
      )
    ).toEqual({ model: 'last-used-model', reasoningEffort: 'medium' });
  });

  it('handles an unavailable topic state', () => {
    expect(resolveTopicReplySelection(undefined, { model: 'last-used-model', reasoningEffort: null })).toEqual({
      model: 'last-used-model',
      reasoningEffort: null,
    });
  });
});
