import type {
  DeploymentAdmissionAcquireInput,
  DeploymentAdmissionResult,
  DeploymentAdmissionState,
  DeploymentBlocker,
} from '@irrigationreal/codex-forum-core';

import type { ForumStore } from '../store';

export type { DeploymentAdmissionResult, DeploymentAdmissionState, DeploymentBlocker };

export interface PausableSync {
  pause(): void;
  resume(): void;
  waitForIdle(timeoutMs?: number): Promise<boolean>;
}

const MAX_OPERATION_ID_LENGTH = 200;
const MAX_WAIT_TIMEOUT_MS = 5 * 60_000;
const MAX_LEASE_MS = 24 * 60 * 60_000;

function boundedPositiveMilliseconds(value: number, maximum: number, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${field} must be an integer greater than 0 and at most ${String(maximum)}`);
  }
  return value;
}

export class DispatchAdmissionFencedError extends Error {
  readonly statusCode = 503;
  readonly retryAfter = 1;

  constructor() {
    super('Robot work admission is temporarily closed for deployment');
    this.name = 'DispatchAdmissionFencedError';
  }
}

/**
 * Owns the short forum-side fence between a quiescence decision and container
 * replacement. State is intentionally process-local: replacing the forum
 * process removes the old fence, while the bounded lease prevents an abandoned
 * deployment attempt from leaving a surviving process closed indefinitely.
 */
export class DeploymentAdmissionCoordinator {
  private state: DeploymentAdmissionState = 'idle';
  private operationId: string | null = null;
  private expiresAtMs: number | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<DeploymentAdmissionResult> | null = null;
  private robotWorkInFlight = 0;
  private readonly completed = new Map<string, DeploymentAdmissionResult>();

  constructor(
    private readonly store: ForumStore,
    private readonly sync: PausableSync | null,
    private readonly getBlockers: () => DeploymentBlocker[]
  ) {
    store.setRobotWorkAdmissionGuard(() => this.beginRobotWork());
  }

  getStatus(): { state: DeploymentAdmissionState; operationId: string | null; expiresAt: string | null } {
    this.expireIfNeeded();
    return {
      state: this.state,
      operationId: this.operationId,
      expiresAt: this.expiresAtMs === null ? null : new Date(this.expiresAtMs).toISOString(),
    };
  }

  acquire(input: DeploymentAdmissionAcquireInput): Promise<DeploymentAdmissionResult> {
    const operationId = input.operationId.trim();
    if (!operationId || operationId.length > MAX_OPERATION_ID_LENGTH) {
      throw new RangeError(`operationId must contain 1-${String(MAX_OPERATION_ID_LENGTH)} characters`);
    }
    const waitTimeoutMs = boundedPositiveMilliseconds(input.waitTimeoutMs, MAX_WAIT_TIMEOUT_MS, 'waitTimeoutMs');
    const leaseMs = boundedPositiveMilliseconds(input.leaseMs, MAX_LEASE_MS, 'leaseMs');

    this.expireIfNeeded();
    const completed = this.completed.get(operationId);
    if (completed) return Promise.resolve(completed);
    if (this.operationId === operationId && this.inFlight) return this.inFlight;
    if (this.operationId === operationId && this.state === 'acquired') {
      this.renewLease(operationId, leaseMs);
      return Promise.resolve(this.result(true, 'acquired'));
    }
    if (this.state !== 'idle') {
      return Promise.resolve({
        acquired: false,
        operationId,
        state: 'blocked',
        blockers: [{ code: 'deployment_admission_owned', operationId: this.operationId }],
        expiresAt: this.expiresAtMs === null ? null : new Date(this.expiresAtMs).toISOString(),
      });
    }

    // PREPARING closes the gate synchronously before the first await. Robot
    // work arriving after this point revokes preparation and is admitted.
    this.state = 'preparing';
    this.operationId = operationId;
    this.sync?.pause();

    const acquisition = this.finishAcquire(operationId, waitTimeoutMs, leaseMs);
    this.inFlight = acquisition;
    return acquisition;
  }

  beginRobotWork(): () => void {
    this.expireIfNeeded();
    if (this.state === 'preparing' && this.operationId) {
      this.release('revoked', this.operationId, [{ code: 'robot_work_arrived' }]);
    } else if (this.state === 'acquired') {
      throw new DispatchAdmissionFencedError();
    }

    this.robotWorkInFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.robotWorkInFlight = Math.max(0, this.robotWorkInFlight - 1);
    };
  }

  cancel(operationIdInput: string): { ok: true; released: boolean; operationId: string } {
    const operationId = operationIdInput.trim();
    if (!operationId || operationId.length > MAX_OPERATION_ID_LENGTH) {
      throw new RangeError(`operationId must contain 1-${String(MAX_OPERATION_ID_LENGTH)} characters`);
    }
    this.expireIfNeeded();
    if (this.operationId && this.operationId !== operationId) {
      const error = new Error('Deployment admission is owned by another operation') as Error & { statusCode: number };
      error.statusCode = 409;
      throw error;
    }
    if (this.operationId === operationId) {
      this.release('cancelled', operationId);
      return { ok: true, released: true, operationId };
    }
    // Unknown and already-completed operations are safe idempotent no-ops. This
    // is also what the deploy script sees after replacing the forum process.
    return { ok: true, released: false, operationId };
  }

  close(): void {
    this.store.setRobotWorkAdmissionGuard(null);
    if (this.operationId) {
      this.release('cancelled', this.operationId);
      return;
    }
    this.clearExpiryTimer();
    this.sync?.resume();
  }

  private async finishAcquire(
    operationId: string,
    waitTimeoutMs: number,
    leaseMs: number
  ): Promise<DeploymentAdmissionResult> {
    let idle: boolean;
    try {
      idle = await (this.sync?.waitForIdle(waitTimeoutMs) ?? Promise.resolve(true));
    } catch {
      if (this.operationId !== operationId || this.state !== 'preparing') {
        return (
          this.completed.get(operationId) ?? {
            acquired: false,
            operationId,
            state: 'revoked',
            blockers: [{ code: 'robot_work_arrived' }],
            expiresAt: null,
          }
        );
      }
      return this.releaseWithBlockers(operationId, [{ code: 'pi_session_sync_wait_failed' }]);
    }
    if (this.operationId !== operationId || this.state !== 'preparing') {
      return (
        this.completed.get(operationId) ?? {
          acquired: false,
          operationId,
          state: 'revoked',
          blockers: [{ code: 'robot_work_arrived' }],
          expiresAt: null,
        }
      );
    }
    if (!idle) {
      return this.releaseWithBlockers(operationId, [{ code: 'pi_session_sync_wait_timeout' }]);
    }

    let blockers: DeploymentBlocker[];
    try {
      blockers = [...this.getBlockers()];
    } catch {
      return this.releaseWithBlockers(operationId, [{ code: 'forum_blocker_evaluation_failed' }]);
    }
    if (this.robotWorkInFlight > 0) {
      blockers.push({ code: 'in_flight_robot_work', count: this.robotWorkInFlight });
    }
    if (blockers.length > 0) return this.releaseWithBlockers(operationId, blockers);

    this.state = 'acquired';
    this.renewLease(operationId, leaseMs);
    this.inFlight = null;
    return this.result(true, 'acquired');
  }

  private renewLease(operationId: string, leaseMs: number): void {
    if (this.state !== 'acquired' || this.operationId !== operationId) {
      throw new DispatchAdmissionFencedError();
    }
    this.expiresAtMs = Date.now() + leaseMs;
    this.clearExpiryTimer();
    const expiryTimer = setTimeout(() => {
      if (this.operationId === operationId && this.state === 'acquired') this.release('expired', operationId);
    }, leaseMs);
    expiryTimer.unref();
    this.expiryTimer = expiryTimer;
  }

  private releaseWithBlockers(operationId: string, blockers: DeploymentBlocker[]): DeploymentAdmissionResult {
    return this.release('blocked', operationId, blockers);
  }

  private release(
    outcome: 'blocked' | 'revoked' | 'expired' | 'cancelled',
    operationId: string,
    blockers: DeploymentBlocker[] = []
  ): DeploymentAdmissionResult {
    const result: DeploymentAdmissionResult = {
      acquired: false,
      operationId,
      state: outcome,
      blockers,
      expiresAt: null,
    };
    this.completed.set(operationId, result);
    if (this.completed.size > 100) {
      const oldest = this.completed.keys().next();
      if (!oldest.done) this.completed.delete(oldest.value);
    }
    this.clearExpiryTimer();
    this.state = 'idle';
    this.operationId = null;
    this.expiresAtMs = null;
    this.inFlight = null;
    this.sync?.resume();
    return result;
  }

  private result(acquired: boolean, state: DeploymentAdmissionResult['state']): DeploymentAdmissionResult {
    if (!this.operationId) throw new Error('Deployment admission operation is missing');
    return {
      acquired,
      operationId: this.operationId,
      state,
      blockers: [],
      expiresAt: this.expiresAtMs === null ? null : new Date(this.expiresAtMs).toISOString(),
    };
  }

  private expireIfNeeded(): void {
    if (this.state === 'acquired' && this.expiresAtMs !== null && Date.now() >= this.expiresAtMs && this.operationId) {
      this.release('expired', this.operationId);
    }
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
}
