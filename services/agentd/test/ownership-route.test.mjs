import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const repositoryExtension = new URL('../../../config/extensions/00-session-ownership.ts', import.meta.url);
const extensionSource = existsSync(repositoryExtension)
  ? repositoryExtension
  : new URL('file:///app/.pi/agent/extensions/00-session-ownership.ts');
const extension = readFileSync(extensionSource, 'utf8');

function functionSource(name, nextName) {
  const start = server.indexOf(`async function ${name}`);
  const end = server.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source must remain identifiable`);
  return server.slice(start, end);
}

test('ownership claim resolves the extension canonical path exactly once inside its mutation lock', () => {
  const source = functionSource('claimExternalSession', 'reserveExternalSession');
  assert.equal((source.match(/findSession\(/g) ?? []).length, 1);
  assert.match(source, /withOwnershipAdmission\(\(\) => withMutableSessionOperation\(sessionRef, async \(\) => \{\s*if \(draining\)[\s\S]*const session = await findSession\(sessionRef, sessionPath\)/);
  assert.match(source, /sessionOwnership\.claim\(session\.id, clientId\)/);
});

test('reserve, claim, promote, and drain share one serialized acquisition barrier', () => {
  for (const [name, nextName] of [
    ['claimExternalSession', 'reserveExternalSession'],
    ['reserveExternalSession', 'promoteExternalSession'],
    ['promoteExternalSession', 'exportSession'],
  ]) {
    const source = functionSource(name, nextName);
    assert.match(source, /withOwnershipAdmission\(\(\) => withMutableSessionOperation/);
    assert.match(source, /if \(draining\) return \{ status: 503/);
  }
  const drain = server.slice(server.indexOf('url.pathname === "/v1/admin/drain"'), server.indexOf('url.pathname === "/v1/admin/drain/cancel"'));
  assert.match(drain, /await withOwnershipAdmission\(async \(\) => \{\s*setDraining\(true/);
});

test('canonical ID heartbeat and release stay scan-free while legacy paths use exact normalization', () => {
  const start = server.indexOf('// Canonical ID capability operations remain O(1)');
  const end = server.indexOf('const piExportMatch', start);
  assert.ok(start >= 0 && end > start);
  const source = server.slice(start, end);
  assert.match(source, /normalizeOwnershipSessionRef\(sessionRef\)/);
  assert.match(source, /sessionOwnership\.heartbeat\(capabilitySessionId, body\.lease_token\)/);
  assert.match(source, /sessionOwnership\.release\(capabilitySessionId, body\.lease_token\)/);
  assert.doesNotMatch(source, /findSession|scanSessions|readKnownSession/);
  assert.match(server, /normalizeOwnershipSessionRef[\s\S]*path\.isAbsolute[\s\S]*directSession\(sessionRef\)/);
});

test('fresh TUI startup stays request-free until input reserves, while resume claims first', () => {
  const start = extension.indexOf('pi.on("session_start"');
  const input = extension.indexOf('pi.on("input"', start);
  const switchHook = extension.indexOf('pi.on("session_before_switch"');
  assert.ok(start >= 0 && input > start && switchHook >= 0);
  const startup = extension.slice(start, input);
  assert.match(startup, /intendedLauncher = \{ sessionId, sessionFile \}/);
  assert.match(startup, /protectionState = "launcher"/);
  const launcherBranch = startup.slice(startup.indexOf('if (isMissingFile(error))'), startup.indexOf('\n\t\tconst result'));
  assert.doesNotMatch(launcherBranch, /fetch\(|showOwnershipGate|setStatus|notify/);
  assert.match(extension, /const ensureLauncherOwnership[\s\S]*showOwnershipGate\(ctx, intended\.sessionFile, "reservation", intended\.sessionId\)/);
  assert.match(extension.slice(input, extension.indexOf('pi.on("tool_call"', input)), /ensureLauncherOwnership\(ctx\)/);
  assert.match(extension, /pi\.on\("user_bash"[\s\S]*ensureLauncherOwnership\(ctx\)/);
  assert.match(extension.slice(switchHook, start), /showOwnershipGate\(ctx, event\.targetSessionFile\)/);
});

test('pending ownership promotes at persisted lifecycle boundaries', () => {
  assert.match(extension, /ownershipUrl\(lease\.sessionId, "promote"\)/);
  for (const event of ['tool_execution_start', 'turn_end', 'agent_end', 'agent_settled']) {
    assert.match(extension, new RegExp(`pi\\.on\\("${event}"`));
  }
});

test('first-input reservation failure is closed and shutdown releases pending or durable capability', () => {
  const unavailable = extension.slice(extension.indexOf('const showUnavailable'), extension.indexOf('const attemptClaim'));
  assert.match(unavailable, /if \(mode !== "reservation" && mode !== "promotion"\) actions\.push/);
  const launcherGate = extension.slice(extension.indexOf('const ensureLauncherOwnership'), extension.indexOf('pi.on("input"'));
  assert.match(launcherGate, /result\.kind !== "claimed"[\s\S]*ctx\.shutdown\(\)[\s\S]*return false/);
  const inputStart = extension.indexOf('pi.on("input"');
  const inputEnd = extension.indexOf('const promoteAtPersistedBoundary', inputStart);
  assert.match(extension.slice(inputStart, inputEnd), /!await ensureLauncherOwnership\(ctx\)[\s\S]*action: "handled"/);
  const shutdownStart = extension.indexOf('pi.on("session_shutdown"');
  assert.ok(shutdownStart >= 0);
  assert.match(extension.slice(shutdownStart), /await releaseCurrentLease\(ctx\)/);
  assert.match(extension, /obsolete success must never repaint protection/);
});

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startAgentd(root, port) {
  const agentDir = path.join(root, 'agent');
  for (const directory of [
    path.join(agentDir, 'sessions', '2026-01-01'), path.join(root, 'runtime'),
    path.join(root, 'subsessions'), path.join(root, 'operator'), path.join(root, 'forks'), path.join(root, 'creations'),
  ]) await mkdir(directory, { recursive: true });
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENT_RUNTIME_ROOT: path.join(root, 'runtime'),
      PI_SUBAGENT_SESSION_ROOT: path.join(root, 'subsessions'),
      PI_SUBAGENT_OPERATOR_ROOT: path.join(root, 'operator'),
      MONIKA_RUNTIME_INSTANCE_FILE: path.join(root, 'instance.json'),
      MONIKA_AGENTD_FORUM_FORK_OPERATION_ROOT: path.join(root, 'forks'),
      MONIKA_AGENTD_FORUM_CREATION_OPERATION_ROOT: path.join(root, 'creations'),
      MONIKA_AGENTD_DRAIN_STATE_FILE: path.join(root, 'drain.json'),
      MONIKA_AGENTD_PORT: String(port),
      MONIKA_AGENTD_HOST: '127.0.0.1',
      MONIKA_AGENTD_IDLE_REAP_ENABLED: '0',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`agentd exited during startup: ${stderr}`);
    try {
      const result = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (result.ok) return child;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill('SIGTERM');
  throw new Error(`agentd did not become ready: ${stderr}`);
}

async function stopAgentd(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function request(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('legacy encoded absolute ownership routes normalize to canonical identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ownership-legacy-routes-'));
  const port = await unusedPort();
  const child = await startAgentd(root, port);
  t.after(async () => {
    await stopAgentd(child);
    await rm(root, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const sessionPath = path.join(root, 'agent', 'sessions', '2026-01-01', `day_${sessionId}.jsonl`);
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: root })}\n`);
  const legacyOwnershipPath = `/v1/pi/sessions/${encodeURIComponent(sessionPath)}/ownership`;

  const claimed = await request(port, 'POST', `${legacyOwnershipPath}/claim`, { client_id: 'legacy-route-client' });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.session_id, sessionId);
  const described = await request(port, 'GET', legacyOwnershipPath);
  assert.equal(described.status, 200);
  assert.equal(described.body.session_id, sessionId);
  assert.equal(described.body.state, 'leased');
  assert.equal((await request(port, 'POST', `${legacyOwnershipPath}/heartbeat`, {
    lease_token: claimed.body.lease_token,
  })).status, 200);
  assert.equal((await request(port, 'POST', `${legacyOwnershipPath}/release`, {
    lease_token: claimed.body.lease_token,
  })).status, 200);
});

test('concurrent drain and ownership acquisition serialize at the route admission barrier', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ownership-drain-race-'));
  const port = await unusedPort();
  const child = await startAgentd(root, port);
  t.after(async () => {
    await stopAgentd(child);
    await rm(root, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const sessionId = randomUUID();
    const sessionPath = path.join(root, 'agent', 'sessions', '2026-01-01', `pending_${sessionId}.jsonl`);
    const [reserved, drained] = await Promise.all([
      request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/reserve`, {
        client_id: `race-client-${attempt}`, session_path: sessionPath,
      }),
      request(port, 'POST', '/v1/admin/drain', { timeout_ms: 1, auto_cancel_ms: 60_000 }),
    ]);

    if (reserved.status === 200) {
      assert.equal(drained.status, 409, 'a preceding reservation must be visible to drain');
      assert.ok(drained.body.interactive_pi_sessions.some((lease) => lease.session_id === sessionId));
      assert.equal((await request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/release`, {
        lease_token: reserved.body.lease_token,
      })).status, 200);
    } else {
      assert.equal(reserved.status, 503, 'a preceding drain must reject the acquisition');
      assert.equal(drained.status, 200);
    }
    assert.equal((await request(port, 'POST', '/v1/admin/drain/cancel', {})).status, 200);
  }
});

test('real ownership routes durably restore pending fencing and reject acquisitions after drain', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ownership-routes-'));
  const port = await unusedPort();
  let child = await startAgentd(root, port);
  t.after(async () => {
    await stopAgentd(child);
    await rm(root, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const sessionPath = path.join(root, 'agent', 'sessions', '2026-01-01', `day_${sessionId}.jsonl`);
  assert.equal((await request(port, 'GET', '/healthz')).body.interactive_pi_sessions, 0);
  const reserved = await request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/reserve`, {
    client_id: 'route-test', session_path: sessionPath,
  });
  assert.equal(reserved.status, 200);
  assert.equal((await request(port, 'GET', '/healthz')).body.interactive_pi_sessions, 1);
  const pendingState = await request(port, 'GET', '/v1/admin/quiescence');
  assert.equal(pendingState.body.interactive_pi_sessions[0].pending, true);

  await stopAgentd(child);
  child = await startAgentd(root, port);
  const heartbeat = await request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/heartbeat`, {
    lease_token: reserved.body.lease_token,
  });
  assert.equal(heartbeat.status, 200, 'pending capability survives process restart');
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: root, timestamp: new Date().toISOString() })}\n`);
  const promoted = await request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/promote`, {
    session_path: sessionPath, lease_token: reserved.body.lease_token,
  });
  assert.equal(promoted.status, 200);
  await stopAgentd(child);
  child = await startAgentd(root, port);
  const retriedPromotion = await request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/promote`, {
    session_path: sessionPath, lease_token: reserved.body.lease_token,
  });
  assert.equal(retriedPromotion.status, 200, 'promotion is idempotent after a committed response is lost across restart');
  assert.equal((await request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/claim`, {
    client_id: 'competing-client', session_path: sessionPath,
  })).status, 409, 'promoted record durably fences competing writers');

  const pendingId = randomUUID();
  const pendingPath = path.join(path.dirname(sessionPath), `day_${pendingId}.jsonl`);
  const second = await request(port, 'POST', `/v1/pi/sessions/${pendingId}/ownership/reserve`, {
    client_id: 'pending-client', session_path: pendingPath,
  });
  assert.equal(second.status, 200);
  const drained = await request(port, 'POST', '/v1/admin/drain', { timeout_ms: 1, auto_cancel_ms: 60_000 });
  assert.equal(drained.body.draining, true);
  assert.equal((await request(port, 'POST', `/v1/pi/sessions/${randomUUID()}/ownership/reserve`, {
    client_id: 'late-client', session_path: path.join(path.dirname(sessionPath), `day_${randomUUID()}.jsonl`),
  })).status, 503);
  assert.equal((await request(port, 'POST', `/v1/pi/sessions/${sessionId}/ownership/claim`, {
    client_id: 'late-client', session_path: sessionPath,
  })).status, 503);
  await writeFile(pendingPath, `${JSON.stringify({ type: 'session', id: pendingId })}\n`);
  assert.equal((await request(port, 'POST', `/v1/pi/sessions/${pendingId}/ownership/promote`, {
    session_path: pendingPath, lease_token: second.body.lease_token,
  })).status, 503);
  assert.equal((await request(port, 'POST', `/v1/pi/sessions/${pendingId}/ownership/heartbeat`, {
    lease_token: second.body.lease_token,
  })).status, 200, 'heartbeat remains allowed while draining');
  assert.equal((await request(port, 'POST', `/v1/pi/sessions/${pendingId}/ownership/release`, {
    lease_token: second.body.lease_token,
  })).status, 200, 'release remains allowed while draining');
});
