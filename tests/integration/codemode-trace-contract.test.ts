import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrate } from '../../services/forum/packages/server/src/db.ts';
import { EchsBridge } from '../../services/forum/packages/server/src/echsBridge.ts';
import { ForumStore } from '../../services/forum/packages/server/src/store.ts';
import { parseNestedToolCallsJson } from '../../services/forum/packages/server/src/toolTraceMetadata.ts';

const requireForum = createRequire(new URL('../../services/forum/package.json', import.meta.url));
const Database = requireForum('better-sqlite3');
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = new URL('../../', import.meta.url);

test('native codemode → agentd → forum persists the same metadata-only trace after reload', async () => {
  const sdk = await nativeImport(new URL('services/agentd/node_modules/@earendil-works/pi-coding-agent/dist/index.js', repo).href);
  const ai = await nativeImport(new URL('services/agentd/node_modules/@earendil-works/pi-ai/dist/index.js', repo).href);
  const { handlePiEvent } = await nativeImport(new URL('services/agentd/src/pi-event-bridge.mjs', repo).href);
  const root = await mkdtemp(join(tmpdir(), 'codemode-contract-'));
  const db = new Database(join(root, 'forum.sqlite'));
  let session: any;
  try {
    const agentDir = join(root, 'agent'); await mkdir(agentDir);
    migrate(db); const store = new ForumStore(db);
    const forum = store.createForum('Integration'); const admin = store.createIdentity('Admin', 'admin');
    const { topic, post } = store.createTopic({ forumId: forum.id, title: 'Codemode', body: 'collect', authorId: admin.id });
    const forumSession = store.ensureSession({ topicId: topic.id });
    const wire: any[] = []; const streamRows: any[] = [];
    const bridge = new EchsBridge(store, { emit(_topic: string, event: any) { if (event.type === 'tool_run') streamRows.push(event.data); }, subscribe() {} } as any, { model: 'fixture', workDir: root, echs: { baseUrl: 'http://invalid.invalid' } });
    (bridge as any).threadMap.set('conv', { topicId: topic.id, sessionId: forumSession.id, activeThreadId: 'conv', lastUserPostId: post.id,
      turnParentPostId: post.id, planId: null, reasoningSummary: '', reasoningBackfillAttempted: false, reasoningBackfillRetries: 0,
      model: 'fixture', reasoningEffort: null, currentTurnId: null, turnStartedAt: Date.now(), lastUsage: null,
      totalInputTokens: 0, totalOutputTokens: 0, activeSubagents: new Map(), lastStreamEventAt: null, reasoningCheckpoints: [] });
    const runtime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'), modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false });
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let requests = 0;
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'fixture', baseUrl: 'http://invalid.invalid',
      models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 100000, maxTokens: 1000, cost: usage.cost }],
      streamSimple() {
        const message = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: Date.now(), usage,
          content: requests++ === 0 ? [{ type: 'toolCall', id: 'root', name: 'codemode', arguments: { code: 'const r = await Promise.all(Array.from({length:24},()=>tools.sample({secret:"PRIVATE_ARGUMENT"}))); text(r[0].value);' } }] : [{ type: 'text', text: 'done' }],
          stopReason: requests === 1 ? 'toolUse' : 'stop' };
        const stream = ai.createAssistantMessageEventStream(); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
      } });
    const services = await sdk.createAgentSessionServices({ cwd: root, agentDir, modelRuntime: runtime,
      settingsManager: sdk.SettingsManager.inMemory({ packages: [], defaultTools: ['+codemode'], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }), additionalExtensionPaths: [new URL('config/extensions/codemode.ts', repo).pathname],
        extensionFactories: [(pi: any) => pi.registerTool({ name: 'sample', label: 'Sample', description: 'Fixture', parameters: ai.Type.Object({ secret: ai.Type.String() }),
          outputSchema: ai.Type.Object({ value: ai.Type.Number() }), async execute() { return { content: [{ type: 'text', text: 'PRIVATE_RESULT' }], details: {}, structuredContent: { value: 7 } }; } })] } });
    ({ session } = await sdk.createAgentSessionFromServices({ services, sessionManager: sdk.SessionManager.create(root, join(root, 'sessions')), model: runtime.getModel('fixture', 'fixture'), thinkingLevel: 'off' }));
    await session.bindExtensions({}); const conv = { id: 'conv', current: null, session };
    session.subscribe((event: any) => handlePiEvent(conv, event, (_conv: any, name: string, data: any) => {
      wire.push({ event: name, data });
      // Only tool events are needed for this projection contract; no outward
      // assistant publication or dispatch lifecycle is exercised here.
      if (['item_started', 'tool_updated', 'tool_completed'].includes(name)) (bridge as any).handleEvent('conv', { event: name, data });
    }));
    await session.prompt('collect');
    const runs = store.listToolRuns(topic.id, 100);
    assert.equal(store.listToolRuns(topic.id, 100).length, 25);
    const parent = runs.find((r: any) => r.call_id === 'root')!;
    const child = runs.find((r: any) => r.call_id === 'root/1')!;
    assert.ok(child.finished_at); assert.equal(child.call_id, 'root/1');
    const nested = parseNestedToolCallsJson(parent.nested_calls_json)!;
    assert.equal(streamRows.findLast(row => row.callId === 'root').nestedCalls.complete, true);
    assert.equal(nested.complete, true); assert.equal(nested.calls[0]?.status, 'ok');
    assert.match(parent.output_summary!, /7/);
    assert.ok(!child.command!.includes('PRIVATE_ARGUMENT'));
    assert.ok(!JSON.stringify(runs).includes('PRIVATE_RESULT'));
    // Root script text intentionally contains its explicit source; nested args
    // must be redacted independently of what the parent source itself names.
    const childWire = wire.filter(e => e.data.parent_call_id || e.data.item?.parent_call_id);
    assert.ok(!JSON.stringify(childWire).includes('PRIVATE_ARGUMENT'));
    assert.ok(!JSON.stringify(childWire).includes('PRIVATE_RESULT'));
    const replayStart = wire.find(e => e.data.item?.parent_call_id);
    (bridge as any).handleEvent('conv', replayStart);
    const reopened = new Database(join(root, 'forum.sqlite'));
    try {
      const persisted = new ForumStore(reopened).listToolRuns(topic.id, 100);
      assert.equal(persisted.length, 25);
      assert.deepEqual(parseNestedToolCallsJson(persisted.find((r: any) => r.call_id === 'root')!.nested_calls_json), nested);
    } finally { reopened.close(); }
  } finally { session?.dispose(); db.close(); await rm(root, { recursive: true, force: true }); }
});
