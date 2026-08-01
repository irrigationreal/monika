import { ref } from 'vue';

import { flushPromises, shallowMount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConfirmationDialog from '../components/ConfirmationDialog.vue';
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
    await stop?.trigger('click');
    expect(mocks.interruptRobot).not.toHaveBeenCalled();
    const confirmation = wrapper.findComponent(ConfirmationDialog);
    expect(confirmation.props('open')).toBe(true);
    confirmation.vm.$emit('confirm');
    await flushPromises();
    expect(mocks.interruptRobot).toHaveBeenCalledTimes(1);
    expect(mocks.interruptRobot).toHaveBeenCalledWith('topic-1');
    expect(wrapper.text()).toContain('Stop remains uncertain.');
    wrapper.unmount();
  });

  it('keeps polling separate from confirmation and revalidates a stale target', async () => {
    const wrapper = shallowMount(RobotDashboardView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    const stop = wrapper.findAll('button').find((button) => button.text() === 'Stop');
    await stop?.trigger('click');

    let resolveRefresh!: (value: { jobs: never[]; queue: never[] }) => void;
    mocks.getRobotDashboard.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    const refresh = wrapper.findAll('button').find((button) => button.text() === 'Refresh');
    await refresh?.trigger('click');
    const confirmation = wrapper.findComponent(ConfirmationDialog);
    expect(confirmation.props('pending')).toBe(false);

    resolveRefresh({ jobs: [], queue: [] });
    await flushPromises();
    confirmation.vm.$emit('confirm');
    await flushPromises();
    expect(mocks.interruptRobot).not.toHaveBeenCalled();
    expect(confirmation.props('open')).toBe(false);
    wrapper.unmount();
  });
});
