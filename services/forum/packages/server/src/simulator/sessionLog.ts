export type SessionLogMatch = 'path' | 'path+query' | 'prefix' | 'regex';

export type SessionLogEntry = {
  method: string;
  path: string;
  match?: SessionLogMatch;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  repeat?: boolean;
};

export type SessionLog = {
  entries: SessionLogEntry[];
  defaultResponse?: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  };
};

export type SessionLogRequest = {
  method: string;
  url: string;
};

export type SessionLogResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
};

const normalizeMethod = (method: string): string => method.trim().toUpperCase();

const resolvePath = (url: string): { path: string; pathWithQuery: string } => {
  const parsed = new URL(url, 'http://localhost');
  const path = parsed.pathname;
  const pathWithQuery = `${parsed.pathname}${parsed.search}`;
  return { path, pathWithQuery };
};

const matchesEntry = (entry: SessionLogEntry, request: SessionLogRequest): boolean => {
  if (normalizeMethod(entry.method) !== normalizeMethod(request.method)) {
    return false;
  }
  const { path, pathWithQuery } = resolvePath(request.url);
  const match = entry.match ?? (entry.path.includes('?') ? 'path+query' : 'path');
  switch (match) {
    case 'regex':
      return new RegExp(entry.path).test(pathWithQuery);
    case 'prefix':
      return pathWithQuery.startsWith(entry.path);
    case 'path+query':
      return pathWithQuery === entry.path;
    case 'path':
    default:
      return path === entry.path;
  }
};

export function createSessionLogSimulator(log: SessionLog) {
  const entries = log.entries.slice();

  return {
    handle(request: SessionLogRequest): SessionLogResponse | null {
      const matchIndex = entries.findIndex((entry) => matchesEntry(entry, request));
      if (matchIndex < 0) {
        if (log.defaultResponse) {
          const resp: SessionLogResponse = {
            status: log.defaultResponse.status,
            body: log.defaultResponse.body
          };
          if (log.defaultResponse.headers !== undefined) resp.headers = log.defaultResponse.headers;
          return resp;
        }
        return null;
      }

      const entry = entries[matchIndex]!;
      if (!entry.repeat) {
        entries.splice(matchIndex, 1);
      }
      const resp: SessionLogResponse = {
        status: entry.status ?? 200,
        body: entry.body ?? null
      };
      if (entry.headers !== undefined) resp.headers = entry.headers;
      if (entry.delayMs !== undefined) resp.delayMs = entry.delayMs;
      return resp;
    },
    remaining(): number {
      return entries.length;
    }
  };
}
