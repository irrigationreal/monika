# Claude Code compatibility — `claude-code-use.ts`

This runtime-owned extension preserves Claude Code compatibility where Monika actually needs it without changing ordinary Anthropic API-key traffic.

## Route policy

The extension has three request modes:

| Route | Authentication | Behavior |
|---|---|---|
| `claude/...` pool provider using `anthropic-messages` | Pool credential | Full Claude Code prompt, tool, and header compatibility |
| Native `anthropic/...` using `anthropic-messages` | OAuth selected by Pi | MCP-style tool aliases and tool-name synchronization only |
| Native `anthropic/...` | API key, header-owned auth, or workload identity | No extension changes |
| Any other provider or API | Any | No extension changes |

Pi's `ModelRegistry.isUsingOAuth()` is the authentication-mode authority. The extension never inspects credential values or infers authentication from request headers.

The distinction matters because Pi already owns Claude Code identity, model capability betas, and current headers for native Anthropic OAuth. Reapplying an independent static profile there can remove required feature gates or make API-key requests falsely identify as Claude Code.

## Pool compatibility

Pi sees the pool credential as an API key, so it does not activate Pi's native OAuth compatibility path. For `claude/...` pool requests the extension therefore:

- adds the Claude Code identity preamble;
- rewrites the small set of Pi-identifying phrases inherited from the upstream compatibility package;
- rewrites textual and array-form system prompt blocks without discarding metadata such as `cache_control`;
- exposes non-core extension tools as deterministic `mcp__<namespace>__<tool>` aliases;
- filters unknown flat tool names from the outbound payload;
- rewrites the `Available tools:` section, `tool_choice`, and historical `tool_use` blocks consistently;
- preserves Anthropic-native typed tools and Claude Code core tools;
- applies the pool's Claude Code request headers.

The pool header profile sends:

- `accept: application/json`
- `anthropic-dangerous-direct-browser-access: true`
- `user-agent: claude-code/<version>`
- `x-app: cli`

It appends `claude-code-20250219` and `oauth-2025-04-20` to the existing `anthropic-beta` header. It never replaces Pi's assembled value. Model-specific gates—including managed-effort, thinking, tool-change, and future Pi-managed betas—remain Pi's responsibility and survive the merge.

The reviewed default compatibility version is `2.1.280`, matching the minimum observed for Claude Opus 5.5 and the compatibility fingerprint in bundled Pi 1.1.0. `PI_CLAUDE_CODE_USE_VERSION` remains an operator override for controlled compatibility testing; advertising a version does not prove support for behavior the runtime has not validated.

## Native Anthropic OAuth

For native OAuth, Pi supplies the identity, OAuth betas, model-specific feature gates, and headers. This extension only keeps Monika's non-core tools usable through MCP aliases and synchronizes the prompt/history tool names with the declarations sent to Anthropic.

The extension does not modify native OAuth `user-agent`, `x-app`, or `anthropic-beta` headers and does not add another identity preamble.

## Native Anthropic API keys

Native API-key requests receive no aliases, prompt rewrites, payload filtering, identity, version, OAuth beta, or header changes from this extension. When a session switches to such a route, every extension-owned MCP alias is removed from the active tool set, including an alias selected explicitly on an earlier compatible route. The request then uses Pi's ordinary Anthropic adapter unchanged.

## Tool execution

Pi's public tool metadata intentionally omits execute functions. To delegate MCP aliases back to their original tools, the enabled extension temporarily observes tool registrations through a guarded `Map.prototype.set` patch while extensions load, then restores the original method during `session_start`.

The debug log records missing execute captures and alias registration failures when enabled. A future public execute-lookup API should replace this private-runtime adapter.

When the extension is disabled, its factory returns before installing the temporary patch, registering aliases, or registering event handlers.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_CLAUDE_CODE_USE_ENABLED` | `1`/`true` enables the adapter; `0`/`false` disables it completely. Default: enabled. Invalid values fail extension loading visibly. |
| `PI_CLAUDE_CODE_USE_VERSION` | Claude Code version placed in the pool compatibility user-agent. Default: `2.1.280`. |
| `PI_CLAUDE_CODE_USE_DEBUG_LOG=/path` | Writes before/after payloads and alias lifecycle diagnostics. Never enable this with sensitive production traffic unless the log is protected. |
| `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` | Disables flat-tool filtering for debugging. This may make pool or OAuth requests fail and is not a compatibility solution. |

The Compose template exposes `PI_CLAUDE_CODE_USE_ENABLED` as a non-secret deployment option. Disabling the adapter may make custom Monika tools unusable on the pool and native Anthropic OAuth routes.

## Maintenance and upgrade checks

After a Pi or provider upgrade, verify all of the following:

1. Disabled mode registers no adapter hooks or aliases.
2. A pool request receives MCP aliases and the reviewed Claude Code headers.
3. Pool beta merging preserves every beta Pi generated for the selected model.
4. Native OAuth receives tool aliases while its identity and headers remain Pi-owned.
5. Native Anthropic API-key payloads and headers are unchanged.
6. A non-Anthropic request receives no aliases, prompt rewrites, or header changes.
7. An MCP alias executes the original extension tool successfully.
8. Every newly enabled Claude model passes text and tool-result canaries through the exact route that will serve it.

The extension remains in `config/extensions/` rather than installing `pi-anthropic-oauth`: that package owns OAuth login, refresh, and a complete custom stream provider, while this runtime already owns provider routing and authentication.
