import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPiSessionImport, type PiSessionImportArgs } from './importPiSessions';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function args(): PiSessionImportArgs {
  const dir = mkdtempSync(join(tmpdir(), 'pi-session-import-'));
  tempDirs.push(dir);
  return {
    agentdBaseUrl: 'http://agentd.test',
    dbPath: join(dir, 'forum.db'),
    resetDb: false,
    dryRun: false,
    limit: null,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('historical Pi session importer child omission', () => {
  it('omits child listings before export', async () => {
    const options = args();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      sessions: [
        { id: 'child-kind', kind: 'subagent', path: '/tmp/child.jsonl' },
        { id: 'child-path', kind: null, path: '/app/.pi/agent/sessions/subagent/run/child.jsonl' },
      ],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runPiSessionImport(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const db = new Database(options.dbPath, { readonly: true });
    expect(db.prepare('select count(*) as count from topics').get()).toEqual({ count: 0 });
    db.close();
  });

  it('omits a child identified only by the exported session', async () => {
    const options = args();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        sessions: [{ id: 'late-child', kind: 'normal', path: '/tmp/apparently-normal.jsonl' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        session: {
          id: 'late-child',
          kind: null,
          path: '/app/.pi/agent/sessions/subagent/run/late-child.jsonl',
          cwd: '/workspace/monika',
        },
        entries: [{ type: 'message', id: 'u1', role: 'user', text: 'private delegated task', hasVisibleText: true }],
      }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runPiSessionImport(options);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const db = new Database(options.dbPath, { readonly: true });
    expect(db.prepare('select count(*) as count from topics').get()).toEqual({ count: 0 });
    expect(db.prepare('select sessions_imported, posts_imported, status from pi_import_runs').get()).toEqual({
      sessions_imported: 0,
      posts_imported: 0,
      status: 'completed',
    });
    db.close();
  });
});
