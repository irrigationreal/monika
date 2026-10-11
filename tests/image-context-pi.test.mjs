import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const sdkPath = process.env.MONIKA_PI_SDK_PATH ?? '/opt/agentd/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const extension = process.env.MONIKA_IMAGE_CONTEXT_EXTENSION ?? new URL('../config/extensions/image-context.ts', import.meta.url).pathname;

test('installed Pi loads extension and bounds full provider replay without editing canonical history', { skip: !fs.existsSync(sdkPath) }, async () => {
 const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(sdkPath));
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-context-pi-test-'));
 fs.chmodSync(dir, 0o700);
 let session, runtime;
 try {
  // Synthetic credential used only to reach payload construction. onPayload
  // throws before any transport starts; this suite never makes an API request.
  const key = 'test.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url') + '.test';
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { codex: { baseUrl: 'http://127.0.0.1:1/backend-api', apiKey: key, api: 'openai-codex-responses', models: [{ id: 'synthetic', name: 'Synthetic', input: ['text', 'image'], contextWindow: 1000000, maxTokens: 256, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}', { mode: 0o600 });
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [extension] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  runtime = await ModelRuntime.create({ agentDir: dir, modelsPath: path.join(dir, 'models.json'), authPath: path.join(dir, 'auth.json'), offline: true });
  const model = runtime.getModels('codex').find(m => m.id === 'synthetic');
  assert.ok(model);
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: 'user', content: 'Inspect these images', timestamp: 1 });
  for (let i = 0; i < 10; i++) {
   manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `call_${i}|fc_${i}`, name: 'read', arguments: { path: `/tmp/image-${i}.png` } }], provider: 'codex', api: 'openai-codex-responses', model: 'synthetic', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 + i * 2 });
   manager.appendMessage({ role: 'toolResult', toolCallId: `call_${i}|fc_${i}`, toolName: 'read', content: [{ type: 'text', text: 'Synthetic image note' }, { type: 'image', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' }], isError: false, timestamp: 3 + i * 2 });
  }
  const originals = manager.getEntries().filter(e => e.type === 'message');
  const before = JSON.stringify(originals);
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, sessionManager: manager, settingsManager, resourceLoader, noTools: true, tools: [] }));
  await session.bindExtensions({});
  session.setActiveToolsByName([]);
  let captured;
  const previous = session.agent.streamFunction;
  session.agent.streamFunction = (m, context, options) => previous(m, context, { ...options, transport: 'sse', onPayload: payload => { captured = payload; throw Error('IMAGE_PROJECTION_CAPTURE'); } });
  await session.prompt('Interrupt prior tasks. Reply briefly without tools.');
  assert.equal(session.messages.findLast(m => m.role === 'assistant').errorMessage, 'IMAGE_PROJECTION_CAPTURE');
  assert.ok(captured.instructions.length);
  assert.equal((captured.tools ?? []).length, 0);
  const outputs = captured.input.filter(item => item.type === 'function_call_output');
  assert.equal(outputs.length, 10);
  const blocks = outputs.flatMap(item => Array.isArray(item.output) ? item.output : []);
  assert.equal(blocks.filter(b => b.type === 'input_image').length, 4);
  const text = JSON.stringify(outputs);
  assert.equal((text.match(/Image omitted from this model request/g) ?? []).length, 6);
  assert.match(text, /image-0.png/);
  assert.ok(Buffer.byteLength(JSON.stringify(captured)) < 9 * 1024 * 1024);
  assert.equal(JSON.stringify(manager.getEntries().filter(e => originals.some(o => o.id === e.id))), before);
 } finally {
  session?.dispose();
  await runtime?.dispose?.();
  fs.rmSync(dir, { recursive: true, force: true });
 }
});
