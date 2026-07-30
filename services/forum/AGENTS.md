# Monika Forum Service

Purpose: forum frontend for Monika/Pi sessions. This service was imported from
`irrigationreal/monika-forum`, which repurposed the Irrigate Collective
`codex-forum` project for Monika.

The forum remains a UI/API/projection layer. It must not embed Pi and must not
talk directly to memstore. It talks to Monika through `agentd` using
`MONIKA_AGENTD_BASE_URL`.

Repo-level operating rules, live checkout/worktree discipline, container restart
safety, and autodeploy policy live in the root `AGENTS.md`. Do not duplicate or
override them here.

Primary packages:
- `@irrigationreal/codex-forum-core`
- `@irrigationreal/codex-forum-contracts`
- `@irrigationreal/codex-forum-adapters`
- `@irrigationreal/codex-forum-server`
- `@irrigationreal/codex-forum-cli`

App:
- `apps/codex-forum` (Vue)

## Architecture constraints

- Pi JSONL sessions are canonical conversation state.
- Forum SQLite is projection/metadata/blob metadata only.
- One forum topic maps to one canonical Pi session.
- Memory save/dedupe identity uses canonical Pi session id/path.
- Close/save lifecycle goes forum → agentd → Pi `session_shutdown` → stateful-memory.

## Git workflow

After making changes, commit and push. Commit messages must include the URL to
the forum thread/post that requested the change.

### Attribution policy

- Default: do **not** add `Co-authored-by:` trailers or any other attribution trailers.
- Exception: if `.codex-forum/requester.json` exists and includes a forum requester
  with a robot-only email address, add exactly one trailer:
  - `Co-authored-by: <forum_username> <requester_email>`
- If requester email is missing/unset, use no trailer.

## Clean architecture rules

**Single source of truth**
- Core (`packages/core`) owns domain vocabulary: enums/unions, IDs, entities, read-models, policies, and service interfaces/implementations.
- Contracts (`packages/contracts`) owns the API boundary: DTOs + Zod schemas. Reuse core primitives instead of redefining enums/unions.
- Server (`packages/server`) is infra + wiring: DB rows, repositories, adapters, routes. It must not redefine domain types already in core/contracts.

**Layering discipline**
1. Domain/application logic lives in core.
2. Repositories and adapters live in server.
3. Routes call services + mappers, not store/SQL directly.
4. Contracts schemas are enforced at the HTTP boundary.

**Mapping rules**
- Only two mapping layers: DB ↔ Domain, and Domain ↔ DTO.
- Never hand-build DTOs in routes; use mappers.
- Never parse/shape DB rows in routes; use DB→domain mappers.

**Type hygiene**
- Do not re-declare shared enums/types in server/app/tests.
- If you need a convenience type, alias from core/contracts.
- Run `pnpm guardrails:types` before final commit when touching shared types.

## CI expectations

Forum container build checks live at `.github/workflows/ci-forum-container.yml` and expose `forum-container-checks` as the branch-protection gate. Cross-service agentd/forum compatibility belongs in `.github/workflows/ci-integration.yml`; it is currently a placeholder gate named `integration-checks`.

The forum image definition is `services/forum/Containerfile`. The `Image / Forum`, `Release / Nightly`, and `Release / Stable` workflows publish or promote `ghcr.io/irrigationreal/monika-forum` images from this repo.

## Testing

Run from `services/forum`:

```bash
pnpm test
```

On stanza, use `nix-shell` if pnpm is not on PATH:

```bash
nix-shell -p nodejs_22 pnpm --run 'CODEX_FORUM_UPLOADS_DIR=/tmp/codex-forum-test-uploads pnpm test'
```

Unit/integration tests live under:
- `packages/*/src/**/*.test.ts`
- `apps/codex-forum/src/**/*.test.ts`

E2E tests live under:
- `apps/codex-forum/e2e/**/*.spec.ts`

Do not add new tests unless explicitly instructed, unless the change is large or high-risk enough that you should recommend tests first.

## Pi session reconciliation

- Forum-created, imported, and hybrid topics all project one canonical Pi JSONL session. Topic tags are taxonomy, not permanent writer ownership.
- Agentd-authored `monika.message.provenance` custom entries and canonical Pi message IDs are the primary forum-turn identity. Text matching is a legacy fallback.
- Sync projects visible messages from the active Pi branch only. Preserve posts that later leave that branch and record divergence; never delete projected history automatically.
- Real active-branch Pi CLI user and assistant messages belong in the topic after settlement. Do not classify content by how meaningful it looks.
- Exclude posts already present in canonical Pi from later catch-up envelopes or the forum will feed imported CLI messages back into the same session.
- A `pi_message_links` row with `post_id = null` is unresolved state, not a terminal dedupe marker. Rescans must revisit it.

## Operational events and compaction

Turn failures and manual compactions are durable topic operational events, not
posts. Keep them out of post numbering, search, pagination counts, and Pi catch-up
context. Raw diagnostics follow the same authenticated trace-visibility boundary.
Manual compaction must remain admin-only and idle-only, use the canonical Pi leaf
as an optimistic concurrency guard, and create the recovery-checkpoint post only
after Pi compaction succeeds. See `docs/forum.md` for the complete workflow.

Key files:

- `packages/core/src/domain/operationalEvents.ts` — domain vocabulary
- `packages/server/src/services/compactionService.ts` — durable forum workflow
- `packages/server/src/echsBridge.ts` — terminal error ingestion and conversation reopening
- `apps/codex-forum/src/components/OperationalEventBar.vue` — inter-post event rendering

## Live trace and Trace History

The forum renders robot responses as a chronological trace of reasoning, text,
and tool calls for authenticated users. Unauthenticated public readers must only
see final public posts plus a neutral "Response in progress…" placeholder while
a reply is active. Understanding the event pipeline and server-side redaction
boundary is essential before modifying trace rendering.

### Key files

| File | Role |
|---|---|
| `apps/codex-forum/src/composables/useForumState.ts` | SSE event handling, checkpoint recording, activity state |
| `apps/codex-forum/src/views/TopicView.vue` | `liveTurnItems` computed builds the interleaved live trace |
| `apps/codex-forum/src/components/LiveAssistantTurn.vue` | Renders the live trace UI |
| `apps/codex-forum/src/components/ToolElapsedTimer.vue` | Self-contained elapsed timer for running tools |
| `apps/codex-forum/src/components/PostTracePanel.vue` | Renders saved "Trace History" after response completes |
| `apps/codex-forum/src/components/ToolTimeline.vue` | Tool timeline with density/filter/burst grouping |
| `apps/codex-forum/src/components/ToolTimelineEvent.vue` | Individual tool event in saved timeline |
| `apps/codex-forum/src/lib/toolMiniView.ts` | Tool parsing: name detection, kind classification, detail extraction |
| `apps/codex-forum/src/lib/toolTimeline.ts` | Timeline building: events, bursts, agent frames |
| `apps/codex-forum/src/lib/reasoning.ts` | `parseReasoningSteps`: splits `**bold**`-delimited reasoning text |
| `packages/server/src/echsBridge.ts` | Server-side: maps Pi events, creates tool runs, emits SSE, stores checkpoints |
| `packages/server/src/streamBus.ts` | SSE event type registry |

### Footguns to know before modifying trace code

1. **Trace visibility is server-side.** Topic visibility is not trace visibility.
   Public unauthenticated readers must not receive plan, reasoning, tool, command,
   usage, live assistant text, or error detail payloads from `/state` or
   `/state/stream`. Hide details in Vue for UX, but enforce redaction in server
   route/SSE serialization.

1. **Append-only segments.** The live trace uses committed segments that never
   change once pushed. When `tool_started` fires, current drafts are committed
   as frozen segments and cleared. New content only appears at the tail. Never
   retroactively modify or reorder committed segments.

2. **Live trace capping is presentation-only.** `LiveAssistantTurn.vue` pins the
   status item and renders only the latest 15 chronological live trace cards. Do
   not trim `committedSegments`, draft text, server checkpoints, or saved Trace
   History.

3. **Flush before commit.** `reasoning_delta` and `assistant_delta` are
   rAF-buffered. `tool_started` events process synchronously. Call
   `flushPendingDeltas()` before committing segments or the text will be stale.

4. **Use `tool_started`, not `recentToolRuns`.** The `state` SSE event carries all
   recent tools at once — there's no incremental tool-by-tool progression. Tool
   segments must be committed from per-tool `tool_started` events.

5. **Immutable `activityLog` updates.** Use `activityLog.value = [...]` not
   `.push()`. In-place mutations may not trigger Vue computed re-evaluation
   reliably through intermediate computed refs.

6. **Use `kind` for formatting, not tool names.** Pi tool names are capitalised
   (`Bash`, `Read`). The `tool` DB column is normalised lowercase (`exec`, `read`).
   Branch on `kind` (from `toolKindFromName`), and lowercase names for sub-type checks.

7. **Timeout is seconds from Pi, milliseconds elsewhere.** `extractTimeoutMs`
   handles both. Don't add new timeout extraction without checking units.

8. **Elapsed timers must use client-relative time.** `ToolElapsedTimer` records
   `Date.now()` at mount. Never use `Date.now() - serverTimestamp` for live display.

9. **`assistant_reset` fires once per dispatch or interrupt.** `reason: 'new_turn'`
   clears everything. `reason: 'interrupted'` preserves committed segments as a
   frozen trace. A single reply spans multiple Pi turns — don't add mid-response resets.

10. **Idle state has no live plan.** `activity === 'idle'` must imply
   `current_plan_id === null`; completion, interruption, startup cleanup, and
   queued-turn paths must not preserve a previous turn's plan as live state.

11. **Completion suppresses reconstruction.** `assistant_message` is authoritative:
   once the final post is committed, the live trace must disappear. Completion
   reloads, initial idle loads, and queued/waiting states without live plan/text
   must not reconstruct committed segments from stale plan/tool state.

12. **`parseReasoningSteps` only splits at line starts.** Inline bold like
   `- **Gold** as currency` is NOT a step boundary. Only `**...**` at the start
   of a line (after newline + optional whitespace) creates a new step.

13. **Saved trace checkpoints are nullable.** Old data and imported sessions won't
    have `reasoning_checkpoints_json`. Always handle the fallback path.


See `docs/forum.md` § "Live trace and saved trace architecture" for the full event
pipeline and checkpoint design.
