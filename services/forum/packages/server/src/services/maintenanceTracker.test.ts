import { describe, expect, it, vi } from 'vitest';

import { MaintenanceTracker } from './maintenanceTracker';

describe('MaintenanceTracker', () => {
  it('joins active maintenance and rejects new scheduling after close', async () => {
    const tracker = new MaintenanceTracker();
    let release!: () => void;
    const active = new Promise<void>((resolve) => (release = resolve));
    const late = vi.fn(async () => {});
    tracker.run(() => active);
    tracker.close();
    tracker.run(late);

    let joined = false;
    const joining = tracker.waitForIdle().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(late).not.toHaveBeenCalled();

    release();
    await joining;
    expect(joined).toBe(true);
  });
});
