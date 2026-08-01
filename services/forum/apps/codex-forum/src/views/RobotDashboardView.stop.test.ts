import { ref } from 'vue';

import { flushPromises, shallowMount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RobotDashboardView from './RobotDashboardView.vue';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  getRobotDashboard: vi.fn(),
  getDeployStatus: vi.fn(),
  interruptRobot: vi.fn(),
  continueRobot: vi.fn(),
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../composables/useForumState', () => ({
  useForumState: () => ({ currentUser: ref({ kind: 'admin' }) }),
}));
vi.mock('../lib/apiClient', async (original) => {
  const actual = await original();
  return { ...(actual as Record<string, unknown>), api: {
    getRobotDashboard: mocks.getRobotDashboard,
    getDeployStatus: mocks.getDeployStatus,
    interruptRobot: mocks.interruptRobot,
    continueRobot: mocks.continueRobot,
  } };
});

function dashboard(activity: 'thinking' | 'uncertain') {
  return { jobs: [{ topicId: 'topic-1', sessionId: 'forum-session', activity, lastUpdatedAt: new Date(0).toISOString(),
    threadLoaded: false, activeTurnId: null }], queue: [] };
}

describe('Robot Dashboard Stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRobotDashboard.mockResolvedValue(dashboard('uncertain'));
    mocks.getDeployStatus.mockResolvedValue(null);
    mocks.interruptRobot.mockResolvedValue({ ok: false, operationId: 'op-1', generation: 2, state: 'uncertain', targets: 1,
      unresolved: [{}], effectsUnknown: [{}], errors: [], message: 'Stop remains uncertain.' });
  });

  it('offers canonical Stop for an unloaded parent and disables Continue while unresolved', async () => {
    const wrapper = shallowMount(RobotDashboardView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(wrapper.text()).toContain('not loaded; canonical stop available');
    const buttons = wrapper.findAll('button');
    const stop = buttons.find((button) => button.text() === 'Stop');
    const continueButton = buttons.find((button) => button.text() === 'Continue');
    expect(stop?.attributes('disabled')).toBeUndefined();
    expect(continueButton?.attributes('disabled')).toBeDefined();
    await stop?.trigger('click'); await flushPromises();
    expect(mocks.interruptRobot).toHaveBeenCalledWith('topic-1');
    expect(wrapper.text()).toContain('Stop remains uncertain.');
    wrapper.unmount();
  });
});
