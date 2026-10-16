import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryCore = new URL('../../../config/extensions/claude-code-use-core.mjs', import.meta.url);
const bundledCore = existsSync(repositoryCore)
  ? repositoryCore
  : new URL('file:///app/.pi/agent/extensions/claude-code-use-core.mjs');

const {
  CLAUDE_CODE_ROUTE_BETAS,
  claudeCodeCompatibilityMode,
  mergeCommaHeader,
  parseClaudeCodeUseEnabled,
} = await import(bundledCore.href);

const repositoryExtension = new URL('../../../config/extensions/claude-code-use.ts', import.meta.url);
const extensionPath = fileURLToPath(existsSync(repositoryExtension)
  ? repositoryExtension
  : new URL('file:///app/.pi/agent/extensions/claude-code-use.ts'));
const agentdDir = fileURLToPath(new URL('..', import.meta.url));

function runExtensionProbe(enabled) {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
    const loaded = await discoverAndLoadExtensions([process.argv[1]], process.cwd(), '/tmp/claude-code-use-test-no-agent');
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const handlers = extension.handlers;
    if (process.env.PI_CLAUDE_CODE_USE_ENABLED === '0') {
      assert.deepEqual([...handlers.keys()], []);
      process.exit(0);
    }

    let activeTools = ['remember'];
    const originalTool = {
      name: 'remember',
      label: 'Remember',
      description: 'Store a memory',
      parameters: { type: 'object', properties: {} },
      exposure: 'direct',
      sourceInfo: { path: '/app/.pi/agent/extensions/stateful-memory/extension.js', baseDir: '/app/.pi/agent/extensions/stateful-memory' },
    };
    loaded.runtime.getAllTools = () => [
      originalTool,
      ...[...extension.tools.values()].map(entry => ({ ...entry.definition, sourceInfo: entry.sourceInfo })),
    ];
    loaded.runtime.getActiveTools = () => [...activeTools];
    loaded.runtime.setActiveTools = names => { activeTools = [...names]; };
    loaded.runtime.refreshTools = () => {};
    await handlers.get('session_start')[0]({}, {});
    await new Promise(resolve => setImmediate(resolve));
    const alias = [...extension.tools.values()].find(entry => entry.definition.name === 'mcp__stateful-memory__remember');
    assert.ok(alias);
    assert.equal(alias.definition.defaultActive, false);

    const context = (provider, usingOAuth) => ({
      model: { api: 'anthropic-messages', provider, id: 'claude-opus-5-5' },
      modelRegistry: { isUsingOAuth: () => usingOAuth },
    });
    const header = handlers.get('before_provider_headers')[0];
    const request = handlers.get('before_provider_request')[0];

    const poolHeaders = { 'Anthropic-Beta': 'mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01' };
    await header({ type: 'before_provider_headers', headers: poolHeaders }, context('claude', false));
    assert.equal(poolHeaders['user-agent'], 'claude-code/2.1.280');
    assert.match(poolHeaders['Anthropic-Beta'], /mid-conversation-output-config-2026-07-01/);
    assert.match(poolHeaders['Anthropic-Beta'], /thinking-binding-controls-2026-08-01/);
    assert.match(poolHeaders['Anthropic-Beta'], /claude-code-20250219/);
    assert.match(poolHeaders['Anthropic-Beta'], /oauth-2025-04-20/);

    const apiKeyContext = context('anthropic', false);
    await handlers.get('before_agent_start')[0]({}, apiKeyContext);
    assert.deepEqual(activeTools, ['remember']);

    const poolContext = context('claude', false);
    await handlers.get('before_agent_start')[0]({}, poolContext);
    assert.ok(activeTools.includes('mcp__stateful-memory__remember'));

    activeTools = ['mcp__stateful-memory__remember'];
    await handlers.get('before_agent_start')[0]({}, poolContext);
    assert.deepEqual(activeTools, ['mcp__stateful-memory__remember']);
    await handlers.get('before_agent_start')[0]({}, apiKeyContext);
    assert.deepEqual(activeTools, []);
    activeTools = ['remember'];

    const poolPayload = await request(
      { type: 'before_provider_request', payload: { system: 'pi itself', tools: [{ name: 'Read' }] } },
      context('claude', false),
    );
    assert.match(poolPayload.system, /You are Claude Code/);
    assert.match(poolPayload.system, /the cli itself/);

    const oauthPayload = await request(
      { type: 'before_provider_request', payload: { system: 'pi itself', tools: [{ name: 'Read' }] } },
      context('anthropic', true),
    );
    assert.equal(oauthPayload.system, 'pi itself');
    assert.deepEqual(oauthPayload.tools, [{ name: 'Read' }]);

    const apiKeyPayload = { system: 'Pi system', tools: [{ name: 'remember' }] };
    const apiKeyResult = await request(
      { type: 'before_provider_request', payload: apiKeyPayload },
      context('anthropic', false),
    );
    assert.equal(apiKeyResult, undefined);
    assert.deepEqual(apiKeyPayload, { system: 'Pi system', tools: [{ name: 'remember' }] });

    const oauthHeaders = { 'anthropic-beta': 'pi-owned-beta', 'user-agent': 'claude-cli/2.1.280' };
    await header({ type: 'before_provider_headers', headers: oauthHeaders }, context('anthropic', true));
    assert.deepEqual(oauthHeaders, { 'anthropic-beta': 'pi-owned-beta', 'user-agent': 'claude-cli/2.1.280' });
    process.exit(0);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, extensionPath], {
    cwd: agentdDir,
    encoding: 'utf8',
    env: { ...process.env, PI_CLAUDE_CODE_USE_ENABLED: enabled },
  });
}

test('Claude Code compatibility is enabled by default and parses strict deployment booleans', () => {
  assert.equal(parseClaudeCodeUseEnabled(undefined), true);
  assert.equal(parseClaudeCodeUseEnabled(''), true);
  assert.equal(parseClaudeCodeUseEnabled('1'), true);
  assert.equal(parseClaudeCodeUseEnabled(' TRUE '), true);
  assert.equal(parseClaudeCodeUseEnabled('0'), false);
  assert.equal(parseClaudeCodeUseEnabled('false'), false);
  assert.throws(() => parseClaudeCodeUseEnabled('yes'), /PI_CLAUDE_CODE_USE_ENABLED/);
});

test('route policy separates pool, native OAuth, and native API-key requests', () => {
  assert.equal(
    claudeCodeCompatibilityMode({ api: 'anthropic-messages', provider: 'claude' }, false),
    'pool-full',
  );
  assert.equal(
    claudeCodeCompatibilityMode({ api: 'anthropic-messages', provider: 'anthropic' }, true),
    'native-oauth-tools',
  );
  assert.equal(
    claudeCodeCompatibilityMode({ api: 'anthropic-messages', provider: 'anthropic' }, false),
    'off',
  );
  assert.equal(
    claudeCodeCompatibilityMode({ api: 'anthropic-messages', provider: 'other-proxy' }, true),
    'off',
  );
  assert.equal(
    claudeCodeCompatibilityMode({ api: 'openai-completions', provider: 'claude' }, true),
    'off',
  );
});

test('pool header merging preserves Pi feature betas and removes case-insensitive duplicates', () => {
  const headers = {
    'Anthropic-Beta': 'mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01,CLAUDE-CODE-20250219',
  };
  const value = mergeCommaHeader(headers, 'anthropic-beta', CLAUDE_CODE_ROUTE_BETAS);
  assert.equal(
    value,
    'mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01,CLAUDE-CODE-20250219,oauth-2025-04-20',
  );
  assert.deepEqual(Object.keys(headers), ['Anthropic-Beta']);
});

test('the loaded extension gates native API keys, preserves Pi betas, and can disable cleanly', () => {
  for (const enabled of ['1', '0']) {
    const result = runExtensionProbe(enabled);
    assert.equal(result.status, 0, `probe ${enabled} failed:\n${result.stdout}\n${result.stderr}`);
  }
});
