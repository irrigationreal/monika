# Claude Code compatibility — `claude-code-use.ts`

This runtime-owned extension makes requests destined for Anthropic look like Claude Code requests. The pool is only a routing layer: `claude/...` requests receive the same compatibility shaping before the pool forwards them upstream. Native `anthropic/...` requests receive it as well.

Requests for other providers are left unchanged.

## Scope

The extension targets only models where:

- `api === "anthropic-messages"`; and
- `provider` is `claude` (the Monika pool) or `anthropic` (Pi's native route).

The provider allowlist is intentional. The API format alone is not enough to identify an Anthropic destination.

## Compatibility behavior

For an eligible request the extension:

- adds the Claude Code identity preamble to the system prompt;
- rewrites the small set of Pi-identifying phrases used by the upstream compatibility package;
- rewrites textual and array-form system prompt blocks without discarding metadata such as `cache_control`;
- rewrites the `Available tools:` section using the same names that appear in the tool declarations;
- exposes non-core extension tools as deterministic `mcp__<namespace>__<tool>` aliases;
- filters unknown flat tool names from the outbound payload;
- rewrites `tool_choice` and historical `tool_use` blocks consistently;
- preserves Anthropic-native typed tools and Claude Code core tools;
- applies Claude Code request headers when the running Pi version emits the `before_provider_headers` hook.

The header profile currently sends:

- `accept: application/json`
- `anthropic-dangerous-direct-browser-access: true`
- `anthropic-beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14`
- `user-agent: claude-code/<version>`
- `x-app: cli`

Authentication headers are not replaced. The pool's credentials, native API key, or OAuth bearer token remains responsible for authentication. The Claude Code version can be changed with `PI_CLAUDE_CODE_USE_VERSION`; the default is `2.1.275`.

Pi versions before the header hook still receive payload and prompt compatibility, but cannot receive these headers through this extension. Upgrade Pi before relying on header-level compatibility.

## Tool execution

Pi's public tool metadata intentionally omits execute functions. To delegate MCP aliases back to their original tools, the extension temporarily observes tool registrations through a guarded `Map.prototype.set` patch while extensions load, then restores the original method during `session_start`. This is retained for compatibility with the current Pi extension API.

The debug log records missing execute captures and alias registration failures when enabled. A future public execute-lookup API should replace this private-runtime adapter.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_CLAUDE_CODE_USE_VERSION` | Claude Code version placed in the compatibility user-agent header. |
| `PI_CLAUDE_CODE_USE_DEBUG_LOG=/path` | Writes before/after payloads and alias lifecycle diagnostics. Never enable this with sensitive production traffic unless the log is protected. |
| `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` | Disables flat-tool filtering for debugging. This is not a solution for direct Anthropic OAuth, which may reject those names. |

## Maintenance and upgrade checks

After a Pi upgrade, verify:

1. The extension loads without errors.
2. `before_provider_headers` is emitted if header compatibility is required.
3. An Anthropic pool request contains MCP aliases and Claude Code headers.
4. A native Anthropic request behaves the same way.
5. A non-Anthropic request does not contain aliases, prompt rewrites, or header changes.
6. An MCP alias executes the original extension tool successfully.

The extension is deliberately kept in `config/extensions/` rather than installed as `pi-anthropic-oauth`: that package owns OAuth login, refresh, and a complete custom stream provider, while this runtime already owns provider routing and authentication. Its current headers and prompt shaping are used as compatibility references, not vendored as a second transport implementation.
