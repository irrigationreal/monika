import type { SessionLog, SessionLogEntry, SessionLogMatch } from './sessionLog';

export type SessionCaptureEntry = {
  method: string;
  url: string;
  match?: SessionLogMatch;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  repeat?: boolean;
};

export type SessionCapture = {
  meta?: {
    capturedAt: string;
    baseUrl?: string;
    description?: string;
  };
  entries: SessionCaptureEntry[];
  defaultResponse?: SessionLog['defaultResponse'];
};

const resolvePath = (url: string): { path: string; pathWithQuery: string } => {
  const parsed = new URL(url, 'http://localhost');
  const path = parsed.pathname;
  const pathWithQuery = `${parsed.pathname}${parsed.search}`;
  return { path, pathWithQuery };
};

export function createSessionLogFromCapture(capture: SessionCapture): SessionLog {
  const entries: SessionLogEntry[] = capture.entries.map((entry) => {
    const match = entry.match ?? 'path+query';
    let path = entry.url;
    if (match !== 'regex') {
      const { path: rawPath, pathWithQuery } = resolvePath(entry.url);
      path = match === 'path' ? rawPath : pathWithQuery;
    }
    const result: SessionLogEntry = {
      method: entry.method,
      path,
      match
    };
    if (entry.status !== undefined) result.status = entry.status;
    if (entry.body !== undefined) result.body = entry.body;
    if (entry.headers !== undefined) result.headers = entry.headers;
    if (entry.delayMs !== undefined) result.delayMs = entry.delayMs;
    if (entry.repeat !== undefined) result.repeat = entry.repeat;
    return result;
  });

  const log: SessionLog = { entries };
  if (capture.defaultResponse !== undefined) log.defaultResponse = capture.defaultResponse;
  return log;
}
