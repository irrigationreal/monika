#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(path.join(root, 'services/forum/packages/server/package.json'));
const Database = require('better-sqlite3');

const args = new Set(process.argv.slice(2));
const mode = args.has('verify') ? 'verify' : 'migrate';
const runtime = path.resolve(process.env.MONIKA_RUNTIME_DIR ?? path.join(root, 'runtime'));
const safeCwd = process.env.MONIKA_STANDALONE_SAFE_CWD ?? '/workspace/monika';
const forbiddenSessionPrefix = '/home/monika/.pi/agent/sessions';

function log(msg) { console.log(`[stanza-migrate] ${msg}`); }
function exists(p) { return fs.existsSync(p); }

function rewritePath(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;
  out = out.split('/home/monika/.pi/agent/sessions').join('/app/.pi/agent/sessions');
  out = out.split('/home/monika/.pi').join('/app/.pi');
  out = out.split('/home/monika/repos').join('/workspace');
  out = out.split('/home/monika/Repos').join('/workspace');
  if (out === '/home/monika' || out.startsWith('/persist/')) out = safeCwd;
  return out;
}

function tableExists(db, table) {
  return Boolean(db.prepare("select name from sqlite_master where type='table' and name = ?").get(table));
}
function columns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`pragma table_info(${table})`).all().map((r) => r.name));
}
function updateTextColumn(db, table, column, transform = rewritePath) {
  const cols = columns(db, table);
  if (!cols.has(column)) return 0;
  const rows = db.prepare(`select rowid as __rowid, ${column} as value from ${table} where ${column} is not null`).all();
  const stmt = db.prepare(`update ${table} set ${column} = ? where rowid = ?`);
  let changed = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const next = transform(row.value);
      if (next !== row.value) {
        stmt.run(next, row.__rowid);
        changed++;
      }
    }
  });
  tx();
  return changed;
}

async function rewriteJsonFile(file) {
  if (!exists(file)) return 0;
  const raw = await fsp.readFile(file, 'utf8');
  const next = rewritePath(raw);
  if (next !== raw) {
    await fsp.writeFile(file, next);
    return 1;
  }
  return 0;
}

async function rewriteSessionHeaders() {
  const sessionsRoot = path.join(runtime, 'pi-agent/sessions');
  if (!exists(sessionsRoot)) return 0;
  let changed = 0;
  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const raw = await fsp.readFile(p, 'utf8');
        const nl = raw.indexOf('\n');
        const first = nl >= 0 ? raw.slice(0, nl) : raw;
        try {
          const header = JSON.parse(first);
          let touched = false;
          for (const key of ['cwd', 'parentSession']) {
            if (typeof header[key] === 'string') {
              const next = rewritePath(header[key]);
              if (next !== header[key]) { header[key] = next; touched = true; }
            }
          }
          if (touched) {
            const rest = nl >= 0 ? raw.slice(nl) : '\n';
            await fsp.writeFile(p, JSON.stringify(header) + rest);
            changed++;
          }
        } catch {}
      }
    }
  }
  await walk(sessionsRoot);
  return changed;
}

function migrateForumDb() {
  const dbPath = path.join(runtime, 'forum/data.db');
  if (!exists(dbPath)) { log('forum DB missing; skipping forum DB rewrite'); return; }
  const db = new Database(dbPath);
  try {
    const integrity = db.prepare('pragma integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') throw new Error(`forum DB integrity check failed: ${JSON.stringify(integrity)}`);
    let changed = 0;
    changed += updateTextColumn(db, 'pi_session_links', 'pi_session_path');
    changed += updateTextColumn(db, 'pi_session_links', 'parent_pi_session_path');
    changed += updateTextColumn(db, 'pi_session_links', 'cwd');
    changed += updateTextColumn(db, 'pi_session_links', 'metadata_json');
    changed += updateTextColumn(db, 'forums', 'cwd');
    changed += updateTextColumn(db, 'sessions', 'agent_thread_id');
    log(`forum DB rewritten rows/fields: ${changed}`);
    const after = db.prepare('pragma integrity_check').get();
    if (!after || after.integrity_check !== 'ok') throw new Error(`forum DB post-migration integrity check failed: ${JSON.stringify(after)}`);
  } finally { db.close(); }
}

function migrateMemstoreDb() {
  const dbPath = path.join(runtime, 'data/memstore/memory.db');
  if (!exists(dbPath)) { log('memstore DB missing; skipping memstore DB rewrite'); return; }
  const db = new Database(dbPath);
  try {
    const integrity = db.prepare('pragma integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') throw new Error(`memstore DB integrity check failed: ${JSON.stringify(integrity)}`);
    const changed = updateTextColumn(db, 'entries', 'origin');
    log(`memstore origins rewritten: ${changed}`);
    const after = db.prepare('pragma integrity_check').get();
    if (!after || after.integrity_check !== 'ok') throw new Error(`memstore DB post-migration integrity check failed: ${JSON.stringify(after)}`);
  } finally { db.close(); }
}

async function writeStandaloneTaxonomy() {
  const taxonomy = {
    version: 1,
    defaults: { target: { name: 'General' }, cwd: '/workspace/monika', homeCwds: ['/workspace', '/workspace/monika'] },
    system: { parent: 'System', cwd: '/workspace/monika', sleep: { name: 'Sleep' }, delegate: { name: 'Delegates' }, fork: { name: 'Forks' } },
    rules: [
      { target: { name: 'The Zeta Directive' }, cwd: '/workspace/TheZetaDirective', cwdPrefixes: ['/workspace/TheZetaDirective'] },
      { target: { name: 'Monika Runtime' }, cwd: '/workspace/monika', cwdPrefixes: ['/workspace/monika', '/app/.pi'], homeKeywords: ['.pi', 'pi upgrade', 'pi config', 'stateful-memory', 'memory system', 'memstore', 'agentd', 'monika container', 'container runtime', 'codex forum'] },
      { target: { name: 'Vesper' }, cwd: '/workspace/vesper', cwdPrefixes: ['/workspace/vesper'] },
      { target: { name: 'OpenStarbound' }, cwd: '/workspace/OpenStarbound', cwdPrefixes: ['/workspace/OpenStarbound'] },
      { target: { name: 'neosynth-arise' }, cwd: '/workspace/neosynth-arise', cwdPrefixes: ['/workspace/neosynth-arise'] }
    ]
  };
  const p = path.join(runtime, 'forum/taxonomy.local.json');
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(taxonomy, null, 2) + '\n');
  log(`wrote ${p}`);
}

async function assertNoSymlinks() {
  let found = [];
  async function walk(dir) {
    if (!exists(dir)) return;
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) found.push(p);
      else if (st.isDirectory()) await walk(p);
    }
  }
  await walk(runtime);
  if (found.length) throw new Error(`runtime contains symlinks:\n${found.slice(0, 20).join('\n')}${found.length > 20 ? '\n...' : ''}`);
}

function countSessions() {
  const dir = path.join(runtime, 'pi-agent/sessions');
  let n = 0;
  function walk(d) {
    if (!exists(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) n++;
    }
  }
  walk(dir);
  return n;
}

function verifyDbPaths() {
  const forum = path.join(runtime, 'forum/data.db');
  if (exists(forum)) {
    const db = new Database(forum, { readonly: true });
    try {
      for (const [table, col] of [['pi_session_links','pi_session_path'], ['pi_session_links','parent_pi_session_path'], ['pi_session_links','cwd'], ['forums','cwd']]) {
        if (columns(db, table).has(col)) {
          const row = db.prepare(`select count(*) as n from ${table} where ${col} like ?`).get(`${forbiddenSessionPrefix}%`);
          if (row.n > 0) throw new Error(`${table}.${col} still contains ${row.n} old session paths`);
        }
      }
    } finally { db.close(); }
  }
  const memstore = path.join(runtime, 'data/memstore/memory.db');
  if (exists(memstore)) {
    const db = new Database(memstore, { readonly: true });
    try {
      const row = db.prepare('select count(*) as n from entries where origin like ?').get(`${forbiddenSessionPrefix}%`);
      if (row.n > 0) throw new Error(`memstore entries.origin still contains ${row.n} old session paths`);
    } finally { db.close(); }
  }
}

async function migrate() {
  log(`runtime=${runtime}`);
  await writeStandaloneTaxonomy();
  migrateForumDb();
  migrateMemstoreDb();
  const headerCount = await rewriteSessionHeaders();
  log(`session headers rewritten: ${headerCount}`);
  await rewriteJsonFile(path.join(runtime, 'data/memstore/origin-map.json'));
  await rewriteJsonFile(path.join(runtime, 'persona/recent-sessions.json'));
  await verify();
}

async function verify() {
  if (!exists(runtime)) throw new Error(`runtime does not exist: ${runtime}`);
  await assertNoSymlinks();
  const sessions = countSessions();
  if (sessions <= 0) throw new Error('no Pi JSONL sessions found in runtime/pi-agent/sessions');
  if (!exists(path.join(runtime, 'data/memstore/memory.db'))) throw new Error('runtime/data/memstore/memory.db missing');
  if (!exists(path.join(runtime, 'forum/data.db'))) throw new Error('runtime/forum/data.db missing');
  if (!exists(path.join(runtime, 'forum/taxonomy.local.json'))) throw new Error('runtime/forum/taxonomy.local.json missing');
  verifyDbPaths();
  log(`verification ok (${sessions} Pi sessions)`);
}

try {
  if (mode === 'verify') await verify();
  else await migrate();
} catch (err) {
  console.error(`[stanza-migrate] ERROR: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
