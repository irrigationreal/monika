# Codemode

Monika exposes Pi 1.1.0's native codemode alongside ordinary tools in parent CLI
and agentd sessions. Use it to batch independent reads/searches, chain predictable
tool calls, or filter intermediate results before returning useful evidence to the
model. Simple calls should remain direct; reasoning, creative judgment and durable
subagent orchestration remain outside scripts.

## Ownership and activation

`config/extensions/codemode.ts` wraps Pi's public `createCodemodeExtension()`
factory. The same bundled extension is discovered by the CLI and SDK; agentd does
not rely on CLI built-in loading. Keep `-builtin:codemode` in settings to prevent
a duplicate CLI registration. `defaultTools: ["+codemode"]` activates the wrapper
additively, and native mode is fixed to `on`: ordinary tools stay declared.
MCP and tool search remain disabled and are not prerequisites.

Image-owned settings are reapplied at startup while deployment-owned package
choices remain persistent. No canonical session migration is required. A saved
`/tools` selection can keep codemode inactive on an existing branch; select it
again in the TUI to opt in. A one-shot CLI invocation can use
`--exclude-tools codemode` to opt out. Explicit child extension/tool allowlists
keep codemode out of specialist and Monika-delegate profiles; do not add it to
child profiles without revalidating their capability ceilings.

The Claude compatibility adapter supplies the stable
`mcp__codemode__codemode` alias and maps historical flat tool names and explicit
tool choice on compatible routes. Both the original and alias are model-only:
neither can recursively orchestrate another script.

## Script behavior and limits

Scripts are JavaScript async-function bodies. For example:

```js
const results = await Promise.allSettled([
  tools.read({ path: "package.json" }),
  tools.read({ path: "services/agentd/package.json" }),
]);
text(results.map(result => result.status === "fulfilled"
  ? { name: JSON.parse(result.value).name }
  : { error: String(result.reason) }));
```

Only explicitly emitted/returned output reaches the model. Tools with an output
schema return structured data; most extension tools return text. Check structured
error fields when a tool's schema represents failures rather than assuming every
failure throws.

Monika imposes these bounds around the native executor:

- 60-second script deadline by default, at most 120 seconds;
- 2,000 output tokens by default, at most 8,000;
- 131,072 source characters;
- at most 64 nested tool calls, with at most eight in flight per script;
- Pi's native 256 MiB VM limit and native output/store limits also apply.

An optional first line may request smaller bounds or raise them within the maxima:

```js
// @options: {"timeout_ms": 90000, "max_output_tokens": 4000}
```

The wrapper inserts defaults before handing source to Pi, so stack line numbers
include that options line. Pi spills truncated full output to temporary storage;
it is not a durable artifact. `store()`/`load()` hold small branch-aware JSON state,
committed only on successful script completion. They are not memstore or a
replacement for deliberate durable memory.

## Capabilities and side effects

The native QuickJS/WASM VM has no direct Node APIs, filesystem, network or timers.
External effects occur through the allowed tools, with normal validation,
`tool_call`/`tool_result` hooks, SSH routing, execution-mode rules and cancellation.
This does **not** make shell commands read-only or add a transaction around edits.
Calls completed before failure, timeout or cancellation are not rolled back.
Unawaited calls are cancelled when a script ends; cancellation remains cooperative
at the underlying tool boundary. Reconcile uncertain external effects before retry.
Sequence dependent mutations; do not put related edits in `Promise.all()`.

Delegation (`subagent`, wait and supervisor/intercom controls), execution/session
control (`relocate`, `pi_run`) and durable-memory mutation tools must be called
directly, including their Claude aliases. They are omitted from the script's tool
catalog and guarded at the nested-call boundary. This is a tool-level ceiling,
not an OS security boundary: shell access retains its existing privileges.

Direct classifier/image registry globals are disabled (`models: false`). Continue
to use `generate_image`, whose normal tool path retains validated saves, forum
publication, and publication-only retry without regenerating bytes.

`/tools` selects model declarations, not a universal capability allowlist. An
inactive ordinary direct tool is unreachable from scripts; tools with codemode or
deferred exposure can remain indirectly callable while undeclared. The TUI labels
that distinction. Pi tool exclusions remove reachability rather than merely a
declaration. MCP remains disabled in this deployment.

## Trace and canonical state

Pi JSONL is authoritative. Pi records bounded nested metadata on the parent tool
result, never separate nested tool-result transcript entries. Agentd preserves
`parent_call_id` on nested live events and projects `nested_calls` on parent
updates/completions. The final canonical tool-result event enriches the same row;
it must not create duplicate child tool runs.

The admin-only forum Trace persists nested identity/status/duration and indicates
incomplete records. Incremental tool DTOs keep high-cardinality live batches intact
after older rows leave the bounded recent-state snapshot. Nested arguments, result payloads and error text are not
forwarded to the forum; successful script output is visible as the parent result.
Failed parent scripts expose a generic failure rather than native exception text,
which can contain nested tool errors; full diagnostics remain canonical. This
also prevents raw intermediate reads and delegated/private results from bypassing
the existing trace boundary. Canonical nested arguments remain in Pi's own bounded
record. Forum reload reads its persisted projection and does not need a running VM.

## Validation and rollback

`services/agentd/test/codemode.test.mjs` runs the actual native VM and shared
extension with a synthetic provider and temporary state. It covers output
filtering, nested provenance, hook/argument restrictions, call/concurrency bounds,
CPU deadlines, cancellation, unawaited calls, state persistence and branch
selection. A representative four-file batch-read trial verifies over 100-fold
model-facing result reduction without retaining raw intermediate data in SSE.
This establishes the mechanism, not a general token-cost or latency forecast.
Claude adapter and forum projection/UI tests cover their respective boundaries;
the runtime smoke requires codemode in the real serialized SDK request. The
cross-service `tests/integration/codemode-trace-contract.test.ts` executes the
native VM through agentd into forum storage with 24 children and checks persisted
reload, final parent metadata, and metadata-only child events.

To roll back availability, remove `+codemode` from image defaults and exclude the
shared extension, then use ordinary quiescent deployment. Existing codemode result
entries and trace metadata remain readable. Do not restart the live container from
an active session.
