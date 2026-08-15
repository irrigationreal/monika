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
- Forum SQLite is projection/metadata/blob metadata for conversations and may be authoritative only for explicitly private,
  non-conversation account state such as drafts and Notepad entries.
- One forum topic maps to one canonical Pi session; private Notepad entries are not topics.
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

The forum image definition is `services/forum/Containerfile`. `Image / Forum` publishes path-filtered development images. `Release / Nightly` builds a coordinated Monika and Forum candidate from one commit, and `Release / Stable` promotes its exact digest after the soak policy documented in `docs/releases.md`.

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
- Agentd-authored `monika.message.provenance` custom entries and canonical Pi message IDs are primary. V1 is legacy forum identity; v2 carries ordered contributors and normalized origins. Text matching is a legacy fallback.
- Canonical utterances are channel-neutral. Persist every outward Pi message separately and in order; Pi's internal `agent_settled` maps to wire `turn_completed` as an idle boundary, not an aggregate/raw-completion publication signal.
- Group only consecutive durable dispatches with the same normalized origin, and preserve the original contributor order across retry. Never leak one external/forum origin into another origin's envelope.
- Live and sync must use the same deterministic projection/handoff service so body, metadata, parent, follow-up state, attachment custody, and completion delivery converge in either race order.
- Sync projects visible messages from the active Pi branch only. Preserve posts that later leave that branch and record divergence; never delete projected history automatically.
- Real active-branch Pi CLI user and assistant messages belong in the topic only after settlement and idle gating. Never publish raw completion text or classify content by how meaningful it looks.
- Exclude posts already present in canonical Pi from later catch-up envelopes or the forum will feed imported CLI messages back into the same session.
- A `pi_message_links` row with `post_id = null` is unresolved state, not a terminal dedupe marker. Rescans must revisit it.

## Robot dashboard and nested work

The Robot Dashboard is an admin projection of parent forum requests plus agentd-owned
subagent workload. Agentd owns `awaited`/`follow_up`/`silent` disposition, exact
claim versus canonical settlement, and scoped nested custody; the forum only
projects those facts. Explicit `follow_up` posts retain their origin parent and UI
badge, while passive recovery never wakes a model. Disposable children must not become robot identities, topics,
or forum sessions. Fetch execution state through agentd's internal API; never read
`/data/pi-subagents` from the forum container. Treat `uncertain` and an unavailable
workload endpoint as operationally visible/fail-closed states. Present deployment-
safety blockers—including inactive effects-unknown records—separately from pending
completion delivery/manual recovery and collapsed terminal history; agentd
`active_count`/`uncertain_count` and effects-unknown count remain authoritative.
Show agentd's cached retention inventory as an informational dry-run only. Forum UI
must not infer cleanup eligibility or expose casual bulk discard controls; only
agentd can validate scoped identity, delivery proof, resumability, leases, and safe
paths.
Deploy on Finish must retain its durable request after exit 75.

Stop Robot is a canonical-session cancellation barrier, not a fire-and-forget
interrupt. The forum fences dispatch first and must preserve agentd's typed
`stopping`/`stopped`/`uncertain` result, including for unloaded parents. Do not
allow fresh dispatch while cancellation is unresolved or collapse SSH effects
uncertainty into local termination. A successful Stop remains durable as `stopped`
across hydration and reconnect, and a new attributable forum post clears that
boundary. Interrupted live traces freeze
buffered text even when no tool boundary has committed a segment. Public Stop
responses expose safe counts/state/message only; raw run diagnostics remain admin-only.
Scheduled subagent runs are disabled and are
not covered by the current cancellation descendant model.

Forum startup conversation reconciliation is passive: call `getConversation` only,
reattach already-loaded conversations, and clear stale links for missing ones.
Durable cancellation reconciliation is the exception: query the canonical Pi session
so agentd actively re-runs its latest operation without loading the conversation.
Never call `openTopicConversation`, bind a newly loaded Pi runtime, consume recovered
results, or dispatch a turn merely because forum/agentd restarted. Preserve
`stopping`/`uncertain` until that canonical reconciliation proves `stopped`. Reconcile
durable post dispatch generations before starting `PostDispatchService`; the first
interrupt advances the topic generation and cancels older queued work, while an
unresolved retry reuses the current generation/operation. Apply cancellation results
only when their generation still matches the topic.

Key files:

- `packages/server/src/routes/adminRoutes.ts` — dashboard and deploy scheduler
- `packages/server/src/echsClient.ts` — typed agentd workload/quiescence client
- `apps/codex-forum/src/views/RobotDashboardView.vue` — admin presentation

## Operational events and compaction

Turn failures and manual compactions are durable topic operational events, not
posts. Keep them out of post numbering, search, pagination counts, and Pi catch-up
context. Raw diagnostics follow the same authenticated trace-visibility boundary.
Manual compaction must remain admin-only and idle-only, use the canonical Pi leaf
as an optimistic concurrency guard, and create the recovery-checkpoint post only
after Pi compaction succeeds. The forum must durably accept work before returning,
execute it outside the request lifecycle, resume pending/interrupted work at startup,
and keep checkpoint dispatch independently retryable. See `../../docs/forum.md` for
the complete cross-service workflow.

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

11. **Canonical-item completion is not turn idle.** Each `assistant_message` is
   authoritative for one persisted outward item, and one agent settlement may emit
   several. Queue/coalesce post reloads without dropping an arrival during an
   in-flight reload. Clear the completed item's live trace, but do not force robot
   activity idle; wait for the subsequent server `state` emitted at the wire
   `turn_completed` boundary. Completion reloads must not reconstruct stale trace.

12. **`parseReasoningSteps` only splits at line starts.** Inline bold like
   `- **Gold** as currency` is NOT a step boundary. Only `**...**` at the start
   of a line (after newline + optional whitespace) creates a new step.

13. **Saved trace checkpoints are nullable.** Old data and imported sessions won't
    have `reasoning_checkpoints_json`. Always handle the fallback path.


See `docs/LIVE_TRACE.md` for the full event pipeline and checkpoint design.
