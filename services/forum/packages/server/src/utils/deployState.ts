import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type DeployState = {
  lastStartedAt?: string | null;
  lastFinishedAt?: string | null;
  lastExitCode?: number | null;
  lastError?: string | null;
  deployOnFinishRequestedAt?: string | null;
  deployOnFinishLastCheckedAt?: string | null;
  deployOnFinishLastError?: string | null;
  /**
   * Git commit SHA that the *server process* believes it's running.
   * Typically set at deploy time (env var) or inferred from a local checkout.
   */
  commitSha?: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readDeployState(stateFile: string): DeployState | null {
  try {
    const raw = readFileSync(stateFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;

    const state: DeployState = {};
    if (typeof parsed['lastStartedAt'] === 'string' || parsed['lastStartedAt'] === null) {
      state.lastStartedAt = parsed['lastStartedAt'] as string | null;
    }
    if (typeof parsed['lastFinishedAt'] === 'string' || parsed['lastFinishedAt'] === null) {
      state.lastFinishedAt = parsed['lastFinishedAt'] as string | null;
    }
    if (typeof parsed['lastExitCode'] === 'number' || parsed['lastExitCode'] === null) {
      state.lastExitCode = parsed['lastExitCode'] as number | null;
    }
    if (typeof parsed['lastError'] === 'string' || parsed['lastError'] === null) {
      state.lastError = parsed['lastError'] as string | null;
    }
    for (const key of ['deployOnFinishRequestedAt', 'deployOnFinishLastCheckedAt', 'deployOnFinishLastError'] as const) {
      if (typeof parsed[key] === 'string' || parsed[key] === null) state[key] = parsed[key] as string | null;
    }
    if (typeof parsed['commitSha'] === 'string' || parsed['commitSha'] === null) {
      state.commitSha = parsed['commitSha'] as string | null;
    }

    return state;
  } catch {
    return null;
  }
}

export function writeDeployState(stateFile: string, state: DeployState): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });

  const tmpFile = `${stateFile}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmpFile, stateFile);
}

