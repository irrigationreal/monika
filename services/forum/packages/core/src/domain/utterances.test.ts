import { describe, expect, it } from 'vitest';

import { normalizedOriginKey, originMatchesSurface } from './utterances';

const external = {
  utteranceId: 'post-1', originKind: 'external' as const, channelKind: 'discord', topicId: 'topic-1',
  postId: 'post-1', surfaceId: 'discord:guild', externalEventId: 'event-1', scope: 'thread-1', scopeKind: 'thread',
};

describe('utterance origins', () => {
  it('normalizes by transport subscription rather than event identity', () => {
    expect(normalizedOriginKey(external)).toBe(normalizedOriginKey({
      ...external, utteranceId: 'post-2', postId: 'post-2', externalEventId: 'event-2',
    }));
  });

  it('matches only the exact adapter surface and thread', () => {
    expect(originMatchesSurface(external, {
      channelKind: 'discord', surfaceId: 'discord:guild', scope: 'thread-1',
    })).toBe(true);
    expect(originMatchesSurface({ ...external, channelKind: 'web' }, {
      channelKind: 'discord', surfaceId: 'discord:guild', scope: 'thread-1',
    })).toBe(false);
    expect(originMatchesSurface(external, {
      channelKind: 'discord', surfaceId: 'discord:guild', scope: 'other-thread',
    })).toBe(false);
  });
});
