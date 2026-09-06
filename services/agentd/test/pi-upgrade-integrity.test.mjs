import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import {
  createAgentSessionFromServices, createAgentSessionServices, createReadTool,
  ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { handlePiEvent } from '../src/pi-event-bridge.mjs';

const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content, stopReason = 'stop') {
  return { role: 'assistant', content, stopReason, usage, timestamp: Date.now(),
    api: 'openai-completions', provider: 'integrity-test', model: 'fixture' };
}
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'monika-pi-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('resuming JSONL without a trailing newline preserves both entries', async (t) => {
  const root = await temporary(t);
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage(user('before'));
  manager.appendMessage(assistant([{ type: 'text', text: 'answer' }]));
  const file = manager.getSessionFile();
  const before = (await readFile(file, 'utf8')).trimEnd();
  await writeFile(file, before);
  const resumed = SessionManager.open(file);
  resumed.appendMessage(user('after'));
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, before.split('\n').length + 1);
  assert.equal(SessionManager.open(file).getBranch().at(-1).message.content[0].text, 'after');
});

test('fork remaps the compaction boundary and does not resurrect discarded context', async (t) => {
  const root = await temporary(t);
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage(user('discarded'));
  manager.appendMessage(assistant([{ type: 'text', text: 'old answer' }]));
  manager.appendLabelChange(manager.getLeafId(), 'checkpoint');
  const boundaryLabel = manager.getLeafId();
  const kept = manager.appendMessage(user('retained'));
  manager.appendMessage(assistant([{ type: 'text', text: 'recent answer' }]));
  manager.appendCompaction('summary of old context', boundaryLabel, 10000);
  const leaf = manager.appendMessage(user('next task'));
  const sourcePath = manager.getSessionFile();
  const source = await readFile(sourcePath);
  const child = SessionManager.open(manager.createBranchedSession(leaf));
  const compaction = child.getBranch().find((entry) => entry.type === 'compaction');
  assert.equal(compaction.firstKeptEntryId, kept);
  assert.notEqual(compaction.firstKeptEntryId, boundaryLabel);
  assert.equal(child.getEntry(compaction.firstKeptEntryId).message.content[0].text, 'retained');
  const texts = child.buildSessionContext().messages.flatMap((message) => message.content ?? [])
    .filter((block) => block.type === 'text').map((block) => block.text);
  assert.ok(texts.includes('retained'));
  assert.ok(texts.includes('recent answer'));
  assert.ok(texts.includes('next task'));
  assert.ok(!texts.includes('discarded'));
  assert.deepEqual(await readFile(sourcePath), source);
});

test('built-in read honors execution cwd and retains the explicit factory fallback', async (t) => {
  const root = await temporary(t);
  const factoryCwd = join(root, 'factory');
  const executionCwd = join(root, 'execution');
  await mkdir(factoryCwd); await mkdir(executionCwd);
  await writeFile(join(factoryCwd, 'marker'), 'factory');
  await writeFile(join(executionCwd, 'marker'), 'execution');
  const tool = createReadTool(factoryCwd);
  const result = await tool.execute('read-1', { path: 'marker' }, undefined, undefined, { cwd: executionCwd });
  assert.equal(result.content[0].text, 'execution');
  // Monika's SSH wrappers resolve their own cwd and call the four-argument form.
  const fallback = await tool.execute('read-2', { path: 'marker' });
  assert.equal(fallback.content[0].text, 'factory');
});

test('real Pi loop defers extension notices past tool results and compacts before requesting again', async (t) => {
  const root = await temporary(t);
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  let requests = 0;
  const order = [];
  modelRuntime.registerProvider('integrity-test', {
    api: 'openai-completions', baseUrl: 'https://invalid.invalid', apiKey: 'test-only',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 2000, maxTokens: 100, cost: usage.cost }],
    streamSimple(model, context) {
      requests += 1;
      assert.ok(requests <= 2, 'unexpected additional provider request');
      order.push(`request-${requests}`);
      if (requests === 2) {
        assert.ok(order.includes('compaction_end'), 'compaction must finish before the second request');
        assert.ok(context.messages.some((message) => JSON.stringify(message).includes('fixture summary')));
      }
      const message = requests === 1
        ? assistant([{ type: 'toolCall', id: 'tool-1', name: 'large_result', arguments: {} }], 'toolUse')
        : assistant([{ type: 'text', text: 'finished' }]);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    retry: { enabled: false }, packages: [],
  });
  const services = await createAgentSessionServices({
    cwd: root, agentDir, modelRuntime, settingsManager,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [(pi) => {
        pi.registerTool({ name: 'large_result', label: 'Large result', description: 'Fixture tool',
          parameters: Type.Object({}),
          async execute() {
            pi.sendMessage({ customType: 'fixture-notice', content: 'context notice', display: false }, { triggerTurn: false });
            return { content: [{ type: 'text', text: 'x'.repeat(12000) }], details: {} };
          },
        });
        pi.on('session_before_compact', (event) => ({ compaction: {
          summary: 'fixture summary', firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } }));
      }],
    },
  });
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
    model: modelRuntime.getModel('integrity-test', 'fixture'), thinkingLevel: 'off', tools: ['large_result'] });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  const wire = [];
  const conv = { id: 'fixture-conversation', current: null, session };
  session.subscribe((event) => {
    order.push(event.type);
    if (event.type === 'compaction_end') {
      assert.equal(event.aborted, false);
      assert.ok(!event.errorMessage);
      assert.equal(wire.some((item) => item.event === 'turn_completed'), false);
    }
    handlePiEvent(conv, event, (_conv, name, data) => wire.push({ event: name, data, piEvent: event.type }), () => 'fixture-turn');
  });
  await session.prompt('Run the fixture tool.');
  assert.equal(requests, 2);
  const branch = manager.getBranch();
  const toolIndex = branch.findIndex((entry) => entry.message?.role === 'toolResult');
  const noticeIndex = branch.findIndex((entry) => entry.customType === 'fixture-notice');
  assert.ok(toolIndex >= 0 && noticeIndex > toolIndex, 'notice must follow the canonical tool result');
  assert.equal(branch.filter((entry) => entry.customType === 'fixture-notice').length, 1);
  assert.equal(order.filter((name) => name === 'compaction_end').length, 1);
  assert.equal(order.filter((name) => name === 'agent_settled').length, 1);
  assert.deepEqual(wire.filter((item) => item.event === 'turn_completed').map((item) => item.piEvent), ['agent_settled']);
  assert.ok(order.indexOf('request-2') < order.indexOf('agent_settled'));
  assert.equal(session.isIdle, true);
});
