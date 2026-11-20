import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { handlePiEvent } from '../src/pi-event-bridge.mjs';

const local = new URL('../../../config/extensions/codemode.ts', import.meta.url);
const extension = fileURLToPath(existsSync(local) ? local : new URL('file:///app/.pi/agent/extensions/codemode.ts'));
const core = await import(new URL('./codemode-core.mjs', `file://${extension}`));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, scripts, { block = false, active = true, dataExecute } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codemode-test-'));
  await mkdir(join(root, 'agent'));
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'), modelsStorePath: join(root, 'store.json'), allowModelNetwork: false });
  const contexts = []; let step = 0; let executions = 0;
  modelRuntime.registerProvider('codemode-fixture', { api: 'openai-completions', baseUrl: 'https://invalid.invalid', apiKey: 'fixture',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: usage.cost }],
    streamSimple(_model, context) {
      contexts.push(context);
      const script = scripts[step++];
      const message = { role: 'assistant', api: 'openai-completions', provider: 'codemode-fixture', model: 'fixture', usage, timestamp: Date.now(),
        content: script === undefined ? [{ type: 'text', text: 'finished' }] : [{ type: 'toolCall', id: `code-${step}`, name: 'codemode', arguments: { code: script } }],
        stopReason: script === undefined ? 'stop' : 'toolUse' };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ packages: [], defaultTools: ['+codemode'], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const services = await createAgentSessionServices({ cwd: root, agentDir: join(root, 'agent'), modelRuntime, settingsManager,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }), additionalExtensionPaths: [extension], extensionFactories: [pi => {
        pi.registerTool({ name: 'fixture_data', label: 'Fixture', description: 'Return structured fixture', parameters: { type: 'object', properties: { token: { type: 'string' } } }, outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
          async execute(...args) { executions++; if (dataExecute) return dataExecute(...args); return { content: [{ type: 'text', text: 'PRIVATE_INTERMEDIATE_RESULT' }], structuredContent: { count: 7 }, details: { private: 'PRIVATE_INTERMEDIATE_DETAILS' } }; } });
        for (const name of ['subagent', 'bg_wait', 'subagents_enable']) pi.registerTool({ name, label: 'Control', description: 'Must not execute nested', parameters: { type: 'object', properties: {} }, async execute() { throw Error('CONTROL_EXECUTED'); } });
        if (block) pi.on('tool_call', event => event.toolName === 'fixture_data' ? { block: true, reason: 'fixture blocked' } : undefined);
      }] } });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: modelRuntime.getModel('codemode-fixture', 'fixture'), thinkingLevel: 'off' });
  t.after(async () => { session.dispose(); await rm(root, { recursive: true, force: true }); });
  await session.bindExtensions({});
  if (!active) session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== 'fixture_data'));
  const wire = []; const events = []; const conv = { id: 'fixture', current: null, session };
  session.subscribe(event => { events.push(event); handlePiEvent(conv, event, (_c, event, data) => wire.push({ event, data })); });
  return { root, session, manager, contexts, wire, events, executions: () => executions };
}
const toolResults = manager => manager.getBranch().filter(e => e.message?.role === 'toolResult').map(e => e.message);

test('shared native extension registers in SDK, filters intermediate data and persists nested provenance', async t => {
  const f = await fixture(t, ['const r = await tools.fixture_data({}); store("cursor", r.count); text({count:r.count, models:typeof models, control:ALL_TOOLS.some(t=>t.name === "subagent")});']);
  assert.ok(f.session.getActiveToolNames().includes('codemode'));
  await f.session.prompt('collect');
  assert.equal(f.executions(), 1);
  const result = toolResults(f.manager)[0];
  assert.match(result.content.map(b => b.text).join(''), /"count":7/);
  assert.match(result.content.map(b => b.text).join(''), /"models":"undefined"/);
  assert.match(result.content.map(b => b.text).join(''), /"control":false/);
  assert.equal(result.nestedCalls.calls[0].name, 'fixture_data');
  assert.equal(result.nestedCalls.complete, true);
  assert.equal(f.manager.getBranch().find(e => e.customType === 'codemode-store').data.set.cursor, 7);
  assert.ok(!JSON.stringify(f.contexts.at(-1)).includes('PRIVATE_INTERMEDIATE'));
  assert.ok(!JSON.stringify(f.wire).includes('PRIVATE_INTERMEDIATE'));
  const child = f.wire.find(e => e.event === 'item_started' && e.data.item.parent_call_id);
  assert.equal(child.data.item.parent_call_id, 'code-1');
  assert.deepEqual(child.data.item.arguments, { redacted: true });
  const canonical = f.wire.findLast(e => e.event === 'tool_updated' && e.data.nested_calls);
  assert.equal(canonical.data.nested_calls.complete, true);
  assert.equal(canonical.data.nested_calls.calls[0].status, 'ok');
});

test('nested validation/hooks apply, partial successes survive and failed scripts do not persist store', async t => {
  const f = await fixture(t, ['store("failed", 1); await tools.fixture_data({});'], { block: true });
  await f.session.prompt('collect');
  assert.equal(f.executions(), 0);
  assert.equal(toolResults(f.manager)[0].isError, true);
  assert.match(JSON.stringify(toolResults(f.manager)[0].content), /fixture blocked/);
  assert.ok(!f.manager.getBranch().some(e => e.customType === 'codemode-store'));
  assert.ok(!JSON.stringify(f.wire).includes('fixture blocked'));
  assert.ok(JSON.stringify(f.wire).includes('Script failed; inspect canonical Pi diagnostics'));
});

test('inactive direct tools stay unreachable from scripts', async t => {
  const f = await fixture(t, ['text(typeof tools.fixture_data);'], { active: false });
  await f.session.prompt('collect');
  assert.equal(f.executions(), 0);
  assert.match(JSON.stringify(toolResults(f.manager)[0].content), /does not exist/);
});

test('CPU-bound scripts hit the native hard deadline without blocking the host', async t => {
  const f = await fixture(t, ['// @options: {"timeout_ms":20}\nwhile (true) {}']);
  await f.session.prompt('collect');
  assert.equal(toolResults(f.manager)[0].isError, true);
  assert.match(JSON.stringify(toolResults(f.manager)[0].content), /timeout|timed out|deadline/i);
});

test('small state is restored on resume and isolated on branch navigation', async t => {
  const f = await fixture(t, ['store("cursor", 4);', 'text(load("cursor"));']);
  await f.session.prompt('store then load');
  assert.match(JSON.stringify(toolResults(f.manager)[1].content), /4/);
  const opened = SessionManager.open(f.manager.getSessionFile());
  assert.equal(opened.getBranch().find(e => e.customType === 'codemode-store').data.set.cursor, 4);
  const before = opened.getBranch().find(e => e.message?.role === 'user');
  opened.branch(before.id);
  assert.ok(!opened.getBranch().some(e => e.customType === 'codemode-store'));
});

test('script policy applies finite bounds and rejects invalid/oversized options', () => {
  assert.match(core.boundCodemodeSource('text(1)'), /"timeout_ms":60000,"max_output_tokens":2000/);
  for (const code of ['// @options: {"timeout_ms":120001}\ntext(1)', '// @options: {"max_output_tokens":0}\ntext(1)', '// @options: null\ntext(1)', 'x'.repeat(131073)]) assert.throws(() => core.boundCodemodeSource(code));
  assert.equal(core.isDirectOnlyTool('mcp__pi-subagents__subagent'), true);
  assert.equal(core.isDirectOnlyTool('mcp__ssh__relocate'), true);
  for (const name of ['bg_wait', 'subagents_enable', 'mcp__pi-subagents__bg_wait', 'mcp__pi-subagents__subagents_enable']) assert.equal(core.isDirectOnlyTool(name), true);
});

test('per-script call count and concurrency are bounded while normal tool execution remains delegated', async () => {
  let active = 0; let maximum = 0; const releases = [];
  const ctx = core.boundedToolContext({ tools: [{ name: 'fixture' }, { name: 'subagent' }], async executeTool() { active++; maximum = Math.max(maximum, active); await new Promise(resolve => releases.push(resolve)); active--; return { isError: false }; } });
  assert.deepEqual(ctx.tools.map(t => t.name), ['fixture']);
  const calls = Array.from({ length: 64 }, () => ctx.executeTool('fixture', {}));
  await assert.rejects(ctx.executeTool('fixture', {}), /at most 64/);
  while (releases.length || active) { releases.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all(calls);
  assert.equal(maximum, 8);
  await assert.rejects(ctx.executeTool('mcp__foo__subagent', {}), /directly/);
});

test('allSettled retains successful values when sibling argument validation fails', async t => {
  const f = await fixture(t, ['const r = await Promise.allSettled([tools.fixture_data({}), tools.fixture_data({token:{}})]); text(r.map(x=>x.status));']);
  await f.session.prompt('collect');
  assert.equal(f.executions(), 1);
  const result = toolResults(f.manager)[0];
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /fulfilled/);
  assert.match(JSON.stringify(result.content), /rejected/);
  assert.deepEqual(result.nestedCalls.calls.map(c => c.status).sort(), ['error', 'ok']);
});

test('abort propagates to an in-flight nested tool and settles the parent', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; }); let aborted = false;
  const f = await fixture(t, ['await tools.fixture_data({});'], { dataExecute: async (_id, _params, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
  } });
  const prompt = f.session.prompt('collect');
  await ready;
  await f.session.abort(); await prompt;
  assert.equal(aborted, true);
  assert.equal(f.session.isIdle, true);
  assert.ok(f.wire.some(e => e.event === 'turn_completed' && e.data.aborted));
});

test('a script ending without awaiting cancels its pending tool instead of detaching it', async t => {
  let aborted = false;
  const f = await fixture(t, ['tools.fixture_data({}); return "done";'], { dataExecute: async (_id, _params, signal) => {
    await new Promise((_resolve, reject) => {
      if (signal.aborted) { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }
      else signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  } });
  await f.session.prompt('collect');
  assert.equal(aborted, true);
  assert.equal(f.session.isIdle, true);
});

test('representative batch-read trial returns a compact comparison instead of full source data', async t => {
  const f = await fixture(t, ['const rows = await Promise.all([0,1,2,3].map(async i => JSON.parse(await tools.read({path:`source-${i}.json`})))); text(rows.map(({id,enabled})=>({id,enabled})));']);
  const sources = Array.from({ length: 4 }, (_, id) => JSON.stringify({ id, enabled: id % 2 === 0, irrelevant: 'bulk-source-data '.repeat(1000) }));
  await Promise.all(sources.map((source, i) => writeFile(join(f.root, `source-${i}.json`), source)));
  await f.session.prompt('compare flags');
  const result = toolResults(f.manager)[0];
  assert.equal(result.isError, false);
  assert.equal(result.nestedCalls.calls.length, 4);
  assert.ok(JSON.stringify(result.content).length < sources.join('').length / 100);
  assert.ok(!JSON.stringify(f.contexts.at(-1)).includes('bulk-source-data'));
  assert.ok(!JSON.stringify(f.wire).includes('bulk-source-data'));
});

for (const name of ['bg_wait', 'subagents_enable']) {
  test(`${name} stays outside native codemode's catalog and nested execution`, async t => {
    const f = await fixture(t, [`text(ALL_TOOLS.some(tool => tool.name === "${name}"));`, `await tools.${name}({});`]);
    await f.session.prompt('check orchestration boundary');
    const results = toolResults(f.manager);
    assert.match(JSON.stringify(results[0].content), /false/);
    assert.equal(results[1].isError, true);
    assert.doesNotMatch(JSON.stringify(results[1].content), /CONTROL_EXECUTED/);
    const direct = core.boundedToolContext({ tools: [], executeTool() { throw Error('CONTROL_EXECUTED'); } });
    await assert.rejects(direct.executeTool(name, {}), /must be called directly/);
  });
}
