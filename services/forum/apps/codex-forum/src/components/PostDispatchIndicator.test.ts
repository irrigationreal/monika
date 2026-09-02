import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PostDispatchIndicator from './PostDispatchIndicator.vue';

const projection = {
  topicId: 'topic-1',
  polling: true,
  current: [
    {
      dispatchId: 'dispatch-1',
      postId: 'post-1',
      status: 'pending' as const,
      attemptCount: 2,
      nextAttemptAt: '2025-01-01T00:01:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
  ],
  attempts: [
    {
      id: 'a2',
      dispatchId: 'dispatch-1',
      attemptNumber: 1,
      event: 'retry_scheduled' as const,
      classification: 'transport' as const,
      retryAt: '2025-01-01T00:01:00.000Z',
      errorMessage: 'connection reset',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
    {
      id: 'other',
      dispatchId: 'dispatch-2',
      attemptNumber: 1,
      event: 'terminal_failure' as const,
      classification: 'application' as const,
      retryAt: null,
      errorMessage: 'secret other error',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  ],
};

describe('PostDispatchIndicator', () => {
  it('renders a post-anchored delayed warning and bounded dispatch history', async () => {
    const wrapper = mount(PostDispatchIndicator, { props: { postId: 'post-1', projection } });
    expect(wrapper.text()).toContain('Dispatch delayed');
    expect(wrapper.text()).toContain('attempt 2');
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('connection reset');
    expect(wrapper.text()).not.toContain('secret other error');
  });

  it('exposes terminal retry with loading and error feedback', async () => {
    const failedProjection = {
      ...projection,
      current: [{ ...projection.current[0]!, status: 'failed' as const, nextAttemptAt: null }],
    };
    const wrapper = mount(PostDispatchIndicator, {
      props: { postId: 'post-1', projection: failedProjection, retrying: false, retryError: 'Retry was fenced' },
    });
    const retry = wrapper.get('button');
    expect(retry.text()).toBe('Retry');
    expect(wrapper.get('[role="alert"]').text()).toContain('Retry was fenced');
    await retry.trigger('click');
    expect(wrapper.emitted('retry')).toEqual([['post-1']]);

    await wrapper.setProps({ retrying: true });
    expect(wrapper.get('button').text()).toBe('Retrying…');
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
  });

  it('renders nothing after current delayed state is cleared', () => {
    const wrapper = mount(PostDispatchIndicator, {
      props: { postId: 'post-1', projection: { ...projection, current: [] } },
    });
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });
});
