export type DeploymentAdmissionState = 'idle' | 'preparing' | 'acquired';

export type DeploymentAdmissionOutcome = DeploymentAdmissionState | 'blocked' | 'revoked' | 'expired' | 'cancelled';

export type DeploymentBlocker = Record<string, unknown> & { code: string };

export interface DeploymentAdmissionAcquireInput {
  operationId: string;
  waitTimeoutMs: number;
  leaseMs: number;
}

export interface DeploymentAdmissionResult {
  acquired: boolean;
  operationId: string;
  state: DeploymentAdmissionOutcome;
  blockers: DeploymentBlocker[];
  expiresAt: string | null;
}

export interface DeploymentAdmissionStatus {
  state: DeploymentAdmissionState;
  operationId: string | null;
  expiresAt: string | null;
}
