const SUBAGENT_SESSION_ROOT = '/app/.pi/agent/sessions/subagent';

export type PiSessionIdentity = {
  kind?: string | null;
  path?: string | null;
};

function normalizedSessionPath(path: string | null | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isSubagentPiSession(summary: PiSessionIdentity): boolean {
  const kind = summary.kind?.trim().toLowerCase();
  if (kind === 'subagent') return true;
  const path = normalizedSessionPath(summary.path);
  return path === SUBAGENT_SESSION_ROOT || path.startsWith(`${SUBAGENT_SESSION_ROOT}/`);
}

export function omitSubagentPiSessions<T extends PiSessionIdentity>(sessions: T[]): T[] {
  return sessions.filter((session) => !isSubagentPiSession(session));
}
