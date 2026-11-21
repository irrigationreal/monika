#!/usr/bin/env node
/**
 * Disposable, provider-independent candidate canary.
 *
 * Usage: node tests/smoke/subagents-workflow.mjs <runtime-image>
 *
 * The image is run with an isolated /data bind mount and a local strict
 * Responses fixture. No host state, provider secret, or live database is
 * mounted. The fixture drives two real agentd/Pi workflow scripts: one
 * successful Promise.all+conditional workflow claimed by bg_wait, followed by
 * a second workflow cancelled through canonical conversation Stop Robot.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const image = process.argv[2];
const timeoutMs = Number(process.env.SUBAGENTS_CANARY_TIMEOUT_MS ?? 180_000);
if (!image || process.argv.includes('--help')) {
  console.error('Usage: node tests/smoke/subagents-workflow.mjs <runtime-image>');
  process.exit(image ? 0 : 2);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'monika-subagents-canary-'));
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const fixture = path.join(scriptDir, 'subagents-mock-openai-responses.cjs');
const network = `monika-subagents-canary-net-${process.pid}`;
const modelContainer = `monika-subagents-canary-model-${process.pid}`;
const runtimeContainer = `monika-subagents-canary-runtime-${process.pid}`;
const forumContainer = `monika-subagents-canary-forum-${process.pid}`;
const forumImage = process.env.SUBAGENTS_CANARY_FORUM_IMAGE;
const secrets = path.join(root, 'secrets');
const data = path.join(root, 'data');
const logs = path.join(root, 'logs');
let port;
let cleaned = false;

async function docker(args, options = {}) {
  return exec('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...options });
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await docker(['rm', '-fv', forumContainer]).catch(() => {});
  await docker(['rm', '-fv', runtimeContainer]).catch(() => {});
  await docker(['rm', '-fv', modelContainer]).catch(() => {});
  await docker(['network', 'rm', network]).catch(() => {});
  await docker(['run', '--rm', '--entrypoint', 'chown', '-v', `${root}:/cleanup`, image, '-R', `${process.getuid()}:${process.getgid()}`, '/cleanup']).catch(() => {});
  if (process.env.SUBAGENTS_CANARY_KEEP === '1') console.log(`Retained isolated canary evidence: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(143); });

async function sleep(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function request(method, route, body, requestTimeout = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, signal: controller.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text}`);
    return parsed;
  } finally { clearTimeout(timer); }
}
async function waitFor(label, fn, limit = 90_000) {
  const deadline = Date.now() + limit;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
async function runtimeExec(script) {
  return (await docker(['exec', runtimeContainer, 'sh', '-eu', '-c', script])).stdout;
}

try {
  await Promise.all([mkdir(secrets, { recursive: true }), mkdir(data, { recursive: true }), mkdir(logs, { recursive: true })]);
  await writeFile(path.join(secrets, 'models.json'), JSON.stringify({ providers: {
    'mock-openai': { baseUrl: 'http://mock-model:7777/v1', apiKey: 'canary-only', api: 'openai-responses', models: [{
      id: 'schema-smoke', name: 'Subagent Workflow Schema Canary', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStrictMode: true },
    }] },
  } }, null, 2));
  await Promise.all([writeFile(path.join(root, 'placeholder'), ''), writeFile(path.join(logs, 'placeholder'), '')]);
  await docker(['network', 'create', network]);
  await docker(['run', '-d', '--name', modelContainer, '--network', network, '--network-alias', 'mock-model', '--entrypoint', 'node',
    '-v', `${fixture}:/mock/server.cjs:ro`, '-v', `${root}:/output`, image, '/mock/server.cjs']);
  await waitFor('mock provider', async () => {
    try { await docker(['exec', modelContainer, 'node', '-e', "fetch('http://127.0.0.1:7777/healthz').then(r=>{if(!r.ok)process.exit(1)})"]); return true; } catch { return false; }
  }, 30_000);

  await docker(['run', '-d', '--name', runtimeContainer, '--network', network, '-p', '127.0.0.1::7724',
    '-e', 'HOME=/app', '-e', 'MEMSTORE_SOCKET=/tmp/memstore.sock', '-e', 'MEMSTORE_DATA_DIR=/data/memstore',
    '-e', 'MONIKA_AGENTD_HOST=0.0.0.0', '-e', 'MONIKA_AGENTD_PORT=7724', '-e', 'AGENTLOGS_HOME=/tmp/agentlogs',
    '-e', 'PI_SUBAGENT_EXECUTION_TARGET_ROOT=/tmp/pi-subagent-targets',
    '-e', 'PI_SUBAGENTS_HOST_ACK_RESULTS=1', '-e', 'PI_SUBAGENTS_DEFAULT_DELIVERY_DISPOSITION=awaited',
    '-e', 'PI_SUBAGENTS_FORCE_ASYNC=1',
    '-v', `${secrets}:/runtime/secrets:ro`, '-v', `${data}:/data`, image]);
  port = Number((await docker(['port', runtimeContainer, '7724/tcp'])).stdout.trim().split(':').pop());
  assert.ok(port > 0, 'Docker did not publish agentd');
  await waitFor('agentd health', async () => {
    try { const health = await request('GET', '/healthz'); return health.ok === true ? health : false; } catch { return false; }
  }, 60_000);
  console.log(`✓ isolated runtime ready (${image}, agentd :${port})`);

  const created = await request('POST', '/v1/conversations', { cwd: '/tmp', model: 'mock-openai/schema-smoke', creation_id: `canary-create-${process.pid}` });
  const conversation = created.conversation;
  assert.ok(conversation?.conversation_id && conversation.session_id && conversation.session_path, `conversation identity missing: ${JSON.stringify(created)}`);
  const provenance = { origin: 'forum', version: 2, topicId: 'canary-topic', postId: 'canary-post', utteranceIds: ['canary-utterance'], executionOrigins: [] };
  await request('POST', `/v1/conversations/${encodeURIComponent(conversation.conversation_id)}/messages`, {
    message_id: 'canary-message-1', dispatch_id: 'canary-dispatch-1', generation: 0,
    content: 'SUBAGENTS_CANARY_PARENT_V2: run the bounded workflow canary and report CANARY_OK.', provenance,
  });
  const terminal = await waitFor('workflow turn completion', async () => {
    const history = await request('GET', `/v1/conversations/${encodeURIComponent(conversation.conversation_id)}/history`);
    const completed = history.items?.some(item => item.event === 'turn_completed');
    return completed ? history : false;
  }, 120_000);
  const assistantText = terminal.items.flatMap(item => item.data?.item?.content ?? [])
    .filter(item => item.type === 'text').map(item => item.text).join('');
  assert.match(assistantText, /CANARY_OK/, `unexpected final assistant text: ${assistantText}`);
  console.log('✓ real Pi/agentd turn completed two workflows and returned CANARY_OK');

  const activeWorkflow = await waitFor('stoppable workflow inventory', async () => {
    const value = await request('GET', '/v1/admin/subagents');
    const runs = value.runs ?? [];
    return runs.length >= 2 && runs.some(run => ['active', 'running', 'queued'].includes(run.execution_state) || run.execution_state === 'active') ? value : false;
  }, 60_000);
  const activeRuns = activeWorkflow.runs ?? [];
  assert.ok(activeRuns.some(run => run.mode === 'workflow' || run.run_mode === 'workflow'), 'agentd did not expose workflow runs');
  assert.ok(activeRuns.some(run => run.origin?.topic_id === 'canary-topic' || run.origin?.topicId === 'canary-topic'), 'workflow origin was not captured');
  console.log(`✓ agentd custody inventory: ${activeRuns.length} runs, including the host-stoppable workflow`);

  // Stop Robot is the canonical conversation cancellation boundary. Do not use
  // a model subagent({action:"stop"}) call as a substitute for host control.
  const stopped = await request('POST', `/v1/conversations/${encodeURIComponent(conversation.conversation_id)}/interrupt`, {
    operation_id: `canary-stop-${process.pid}`,
  }, 60_000);
  const cancellation = stopped.ok ? stopped : await waitFor('Stop Robot settlement', async () => {
    const value = await request('GET', `/v1/pi/sessions/${encodeURIComponent(conversation.session_id)}/cancellation?operation_id=${encodeURIComponent(stopped.operation_id)}`, undefined, 60_000);
    return value.ok === true && value.state === 'stopped' ? value : false;
  }, 45_000);
  assert.equal(cancellation.ok, true, `canonical Stop Robot did not stop the workflow: ${JSON.stringify(cancellation)}`);
  const workload = await waitFor('terminal workflow inventory', async () => {
    const value = await request('GET', '/v1/admin/subagents');
    return (value.runs ?? []).length >= 2 && (value.runs ?? []).every(run => !['active', 'running', 'queued'].includes(run.execution_state) && run.execution_state !== 'active') ? value : false;
  }, 60_000);
  const runs = workload.runs ?? [];
  assert.ok(runs.some(run => run.mode === 'workflow' || run.run_mode === 'workflow'), 'agentd did not expose workflow runs');
  assert.ok(runs.some(run => run.origin?.topic_id === 'canary-topic' || run.origin?.topicId === 'canary-topic'), 'workflow origin was not captured');
  console.log(`✓ canonical Stop Robot reached terminal custody for ${runs.length} runs`);

  const ledger = await runtimeExec("find /data/pi-subagents/async-subagent-runs -name status.json -type f -print -exec cat {} \\\;");
  assert.match(ledger, /\"deliveryDisposition\"\s*:\s*\"awaited\"/, 'awaited lifecycle evidence missing');
  assert.match(ledger, /"workflowGraph"\s*:/, 'persisted workflow graph inventory missing');
  assert.match(ledger, /"workflowKey"\s*:\s*"first-conditional"/, 'conditional child did not execute');
  assert.doesNotMatch(ledger, /"workflowKey"\s*:\s*"stop-conditional"/, 'cancellation failed to fence conditional child dispatch');
  assert.match(ledger, /\"state\"\s*:\s*\"stopped\"|\"execution_state\"\s*:\s*\"terminal\"/, 'durable stop terminal evidence missing');
  const claimText = await runtimeExec("find /data/pi-subagents/async-subagent-runs -name result-claim.json -type f -exec cat {} \\;");
  const claims = claimText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(claims.some(claim => claim.kind === 'pi-subagents.result-claim' && claim.version === 1
    && claim.deliveryDisposition === 'awaited' && claim.runKey === `top:${claim.runId}`
    && /^[a-f0-9]{64}$/.test(claim.resultSha256) && claim.resultSizeBytes > 0), 'exact awaited result claim missing');
  console.log('✓ durable ledger contains an exact awaited claim, workflow graph, and stopped controller evidence');

  const settledHistory = await request('GET', `/v1/conversations/${encodeURIComponent(conversation.conversation_id)}/history`);
  const noticesBefore = settledHistory.items.filter(item => item.data?.item?.customType === 'subagent-notify').length;
  assert.ok(noticesBefore <= 1, `modern completion notification duplicated (${noticesBefore})`);
  const readCanonical = async () => (await docker(['exec', runtimeContainer, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", conversation.session_path])).stdout;
  const historyBytes = await readCanonical();
  await docker(['restart', runtimeContainer]);
  port = Number((await docker(['port', runtimeContainer, '7724/tcp'])).stdout.trim().split(':').pop());
  await waitFor('passive restart health', async () => {
    try { const health = await request('GET', '/healthz'); return health.ok === true ? health : false; } catch { return false; }
  }, 60_000);
  assert.equal(await readCanonical(), historyBytes, 'passive restart changed canonical history or replayed a notice');
  const quiescence = await request('GET', '/v1/admin/quiescence');
  assert.equal(quiescence.blockers?.some(blocker => blocker.code === 'active_subagent_runs'), false, 'scanner retained active runs after restart');
  console.log('✓ passive restart is inventory-only; notification count and scanner quiescence are stable');

  if (forumImage) {
    await docker(['run', '-d', '--name', forumContainer, '--network', network,
      '-e', `MONIKA_AGENTD_BASE_URL=http://${runtimeContainer}:7724`,
      '-e', 'CODEX_FORUM_ENABLE_AUTH=0', '-e', 'MONIKA_PI_SYNC_ENABLED=0', forumImage]);
    await waitFor('forum health', async () => {
      try { await docker(['exec', forumContainer, 'node', '-e', "fetch('http://127.0.0.1:4310/healthz').then(r=>{if(!r.ok)process.exit(1)})"]); return true; } catch { return false; }
    }, 60_000);
    const importArgs = ['exec', forumContainer, '/app/node_modules/.bin/tsx', '/app/src/cli/importPiSessions.ts',
      '--agentd', `http://${runtimeContainer}:7724`, '--db', '/var/lib/codex-forum/data.db'];
    await docker(importArgs);
    await docker(importArgs); // Idempotent projection, not a second conversation.
    const { stdout } = await docker(['exec', forumContainer, 'node', '-e',
      "const db=require('better-sqlite3')('/var/lib/codex-forum/data.db'); console.log(JSON.stringify(db.prepare('select pi_session_id, topic_id from pi_session_links').all())); db.close();"]);
    const links = JSON.parse(stdout.trim());
    assert.equal(links.length, 1, `child sessions leaked into forum projection: ${stdout}`);
    assert.equal(links[0].pi_session_id, conversation.session_id);
    console.log('✓ disposable forum imports the canonical parent exactly once and excludes child sessions');
  }

  const drained = await request('POST', '/v1/admin/drain', { timeout_ms: 30_000 });
  assert.equal(drained.ok, true, `drain did not complete: ${JSON.stringify(drained)}`);
  assert.equal(drained.status, 'safe_to_stop');
  console.log('✓ agentd drain reaches safe_to_stop after workflow stop');
} catch (error) {
  console.error(`subagents workflow canary failed: ${error?.stack ?? error}`);
  try { console.error((await docker(['logs', runtimeContainer])).stdout); } catch {}
  try { console.error((await docker(['logs', modelContainer])).stdout); } catch {}
  process.exitCode = 1;
} finally {
  await cleanup();
}
