# Monika Forum Service

Purpose: forum frontend for Monika/Pi sessions. This service was imported from `irrigationreal/monika-forum`, which
repurposed the Irrigate Collective `codex-forum` project for Monika.

The forum remains a UI/API/projection layer. It must not embed Pi and must not talk directly to memstore. It talks to
Monika through `agentd` using `MONIKA_AGENTD_BASE_URL`.

Repo-level operating rules, live checkout/worktree discipline, container restart safety, and autodeploy policy live in
the root `AGENTS.md`. Do not duplicate or override them here.

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
- Forum SQLite is projection/metadata/blob metadata for conversations and may be authoritative only for explicitly
  private, non-conversation account state such as drafts and Notepad entries.
- One forum topic maps to one canonical Pi session; private Notepad entries are not topics.
- Memory save/dedupe identity uses canonical Pi session id/path.
- Close/save lifecycle goes forum → agentd → Pi `session_shutdown` → stateful-memory.

## Git workflow

After making changes, commit and push. Commit messages must include the URL to the forum thread/post that requested the
change.

### Attribution policy

- Default: do **not** add `Co-authored-by:` trailers or any other attribution trailers.
- Exception: if `.codex-forum/requester.json` exists and includes a forum requester with a robot-only email address, add
  exactly one trailer:
  - `Co-authored-by: <forum_username> <requester_email>`
- If requester email is missing/unset, use no trailer.

## Clean architecture rules

**Single source of truth**

- Core (`packages/core`) owns domain vocabulary: enums/unions, IDs, entities, read-models, policies, and service
  interfaces/implementations.
- Contracts (`packages/contracts`) owns the API boundary: DTOs + Zod schemas. Reuse core primitives instead of
  redefining enums/unions.
- Server (`packages/server`) is infra + wiring: DB rows, repositories, adapters, routes. It must not redefine domain
  types already in core/contracts.

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

Forum container build checks live at `.github/workflows/ci-forum-container.yml` and expose `forum-container-checks` as
the branch-protection gate. Cross-service agentd/forum compatibility belongs in `.github/workflows/ci-integration.yml`;
it is currently a placeholder gate named `integration-checks`.

The forum image definition is `services/forum/Containerfile`. `Image / Forum` publishes path-filtered development
images. `Release / Nightly` builds a coordinated Monika and Forum candidate from one commit, and `Release / Stable`
promotes its exact digest after the soak policy documented in `docs/releases.md`.

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

Do not add new tests unless explicitly instructed, unless the change is large or high-risk enough that you should
recommend tests first.

## Pi session reconciliation

- Forum-created, imported, and hybrid topics all project one canonical Pi JSONL session. Topic tags are taxonomy, not
  permanent writer ownership.
- Agentd-authored `monika.message.provenance` custom entries and canonical Pi message IDs are primary. V1 is legacy
  forum identity; v2 carries ordered contributors and normalized origins. Text matching is a legacy fallback.
- Canonical utterances are channel-neutral. Persist every outward Pi message separately and in order; Pi's internal
  `agent_settled` maps to wire `turn_completed` as an idle boundary, not an aggregate/raw-completion publication signal.
- Group only consecutive durable dispatches with the same normalized origin, and preserve the original contributor order
  across retry. Never leak one external/forum origin into another origin's envelope.
- Live and sync must use the same deterministic projection/handoff service so body, metadata, parent, follow-up state,
  attachment custody, and completion delivery converge in either race order.
- Sync projects visible messages from the active Pi branch only. Preserve posts that later leave that branch and record
  divergence; never delete projected history automatically.
- Real active-branch Pi CLI user and assistant messages belong in the topic only after settlement and idle gating. Never
  publish raw completion text or classify content by how meaningful it looks.
- Exclude posts already present in canonical Pi from later catch-up envelopes or the forum will feed imported CLI
  messages back into the same session.
- A `pi_message_links` row with `post_id = null` is unresolved state, not a terminal dedupe marker. Rescans must revisit
  it.

## Robot dashboard and nested work

The Robot Dashboard is an admin projection of parent forum requests plus agentd-owned subagent workload. Agentd owns
`awaited`/`follow_up`/`silent` disposition, exact claim versus canonical settlement, and scoped nested custody; the
forum only projects those facts. Dashboard refresh is single-flight, completion-scheduled, and paused while the document
is hidden. Workload and retention reads are composed concurrently with independent degradation. Explicit `follow_up` posts retain their origin parent and UI badge, while passive
recovery never wakes a model. Disposable children must not become robot identities, topics, or forum sessions. Fetch
execution state through agentd's internal API; never read `/data/pi-subagents` from the forum container. Treat
`uncertain` and an unavailable workload endpoint as operationally visible/fail-closed states. Present deployment- safety
blockers—including inactive effects-unknown records—separately from pending completion delivery/manual recovery and
collapsed terminal history; agentd `active_count`/`uncertain_count` and effects-unknown count remain authoritative. Show
agentd's cached retention inventory as an informational dry-run only. Forum UI must not infer cleanup eligibility or
expose casual bulk discard controls; only agentd can validate scoped identity, delivery proof, resumability, leases, and
safe paths. Deploy on Finish must retain its durable request after exit 75.

Stop Robot is a canonical-session cancellation barrier, not a fire-and-forget interrupt. The forum fences dispatch first
and must preserve agentd's typed `stopping`/`stopped`/`uncertain` result, including for unloaded parents. Do not allow
fresh dispatch while cancellation is unresolved or collapse SSH effects uncertainty into local termination. A successful
Stop remains durable as `stopped` across hydration and reconnect, and a new attributable forum post clears that
boundary. Interrupted live traces freeze buffered text even when no tool boundary has committed a segment. Public Stop
responses expose safe counts/state/message only; raw run diagnostics remain admin-only. Scheduled subagent runs are
disabled and are not covered by the current cancellation descendant model.

Forum startup conversation reconciliation is passive: call `getConversation` only, reattach already-loaded
conversations, and clear only transient loaded-thread references when agentd authoritatively reports that conversation
absent. Never remove a canonical Pi session link because of list omission, timeout, aborted request, backend outage, or
an ambiguous missing response; accepted/ambiguous missing history requires manual review. Durable cancellation
reconciliation is the exception: query the canonical Pi session so agentd actively re-runs its latest operation without
loading the conversation. Never call `openTopicConversation`, bind a newly loaded Pi runtime, consume recovered results,
or dispatch a turn merely because forum/agentd restarted. Preserve `stopping`/`uncertain` until that canonical
reconciliation proves `stopped`. Reconcile durable post dispatch generations before starting `PostDispatchService`; the
first interrupt advances the topic generation and cancels older queued work, while an unresolved retry reuses the
current generation/operation. Aborted/reset/markerless-5xx transport outcomes keep the same dispatch ID, generation, and
ordered contributors pending indefinitely at deterministic progressive backoff (about 30s, 60s, 2m, then a 5m cap); they
never authorize link cleanup or fresh canonical work. Agentd errors explicitly marked
`dispatch_acceptance: "not_accepted"` are lifecycle failures; only an additional `dispatch_retry: "safe"` marker permits
indefinite exact-identity automatic retry. Other marked setup failures are terminal/manual. Never infer either rule from
status. Older delayed heads order-fence newer topic dispatches. Attempt claims and outcomes are append-only audit
history, and only admins may receive the topic-scoped diagnostic projection. Apply cancellation results only when their
generation still matches the topic.

Key files:

- `packages/server/src/routes/adminRoutes.ts` — dashboard and deploy scheduler
- `packages/server/src/echsClient.ts` — typed agentd workload/quiescence client
- `apps/codex-forum/src/views/RobotDashboardView.vue` — admin presentation

## Operational events and compaction

Turn failures and manual compactions are durable topic operational events, not posts. Keep them out of post numbering,
search, pagination counts, and Pi catch-up context. Raw diagnostics follow the same admin-only trace-visibility
boundary. Manual compaction must remain admin-only and idle-only, use the canonical Pi leaf as an optimistic concurrency
guard, and create the recovery-checkpoint post only after Pi compaction succeeds. The forum must durably accept work
before returning, execute it outside the request lifecycle, resume pending/interrupted work at startup, and keep a
failed current-generation checkpoint dispatch independently retryable. Superseded/abandoned checkpoints are cancellation
outcomes and must never be resurrected or keep the topic fenced. See `../../docs/forum.md` for the complete
cross-service workflow.

Key files:

- `packages/core/src/domain/operationalEvents.ts` — domain vocabulary
- `packages/server/src/services/compactionService.ts` — durable forum workflow
- `packages/server/src/echsBridge.ts` — terminal error ingestion and conversation reopening
- `apps/codex-forum/src/components/OperationalEventBar.vue` — inter-post event rendering

## Canonical admin Trace

The forum has one reasoning/tool visualization: the admin-only topic **Trace**. While a response is starting, admins see
one spinner in the empty preview; once trace cards arrive, that movement hands off to a persistent spinner beside the
current state in the chronological three-card preview. Admins can open the complete Trace in the viewport Admin
Workspace. The complete Trace opens newest-first and can be reversed temporarily; its direction never persists across
Trace views or topics. Non-admins, including authenticated members, receive and render only a neutral "Response in
progress…" placeholder. Completed posts never embed trace history.

Trace, Session Diagnostics, and Auto-Director are secondary operational surfaces in the Admin Workspace. Session
Diagnostics combines robot activity/context controls with canonical session metadata so closely related operational
state can be inspected together. Quick Reply retains immediate model/context, steering, failure, and confirmed Stop
Robot controls.

### Key files

| File                                                   | Role                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `apps/codex-forum/src/components/TopicTraceViewer.vue` | Shared three-card preview and complete Trace presentation                     |
| `apps/codex-forum/src/composables/useForumState.ts`    | SSE buffering, append-only segments, refresh reconstruction, admin enrichment |
| `apps/codex-forum/src/views/TopicView.vue`             | Neutral placeholder, Admin Workspace, diagnostics/session/auto-director tabs  |
| `apps/codex-forum/src/lib/unifiedTrace.ts`             | Shared live and persisted reasoning/tool ordering                             |
| `apps/codex-forum/src/lib/toolMiniView.ts`             | Tool parsing and compact card presentation                                    |
| `apps/codex-forum/src/lib/reasoning.ts`                | Reasoning-step parsing                                                        |
| `packages/server/src/routes/robotRoutes.ts`            | Admin trace projection and server-side state/SSE redaction                    |
| `packages/server/src/echsBridge.ts`                    | Pi event mapping, reasoning checkpoints, tool persistence, SSE emission       |

### Footguns

1. **Trace authorization is server-side.** Only admins may receive plans, reasoning, tools, commands, live drafts,
   usage, errors, or stream diagnostics. Vue hiding is never a security boundary.
2. **Append-only ordering is canonical.** Flush buffered deltas before every synchronous `tool_started` commit. Never
   reconstruct incremental progression by diffing batched `recentToolRuns` snapshots.
3. **Preview capping and workspace direction are presentation-only.** The three-card preview takes the chronological
   tail of the active response. The workspace reverses copied groups/cards only; never reverse or trim committed
   segments, persisted plans, checkpoints, or the canonical chronological trace model.
4. **Admin enrichment stays off the critical path.** Quick Reply and SSE startup must not await session metadata or
   persisted trace hydration.
5. **Missing checkpoints are valid.** Imported and older sessions fall back to reasoning followed by deterministically
   ordered tools.
6. **`assistant_reset` is dispatch-scoped.** A single response may span multiple Pi turns. Interrupt freezes the current
   trace; a new dispatch clears it.
7. **Canonical item completion is not idle.** `assistant_message` projects one persisted outward item. Wait for the
   later state/turn-completed boundary to conclude robot activity.
8. **Reasoning headings split only at line starts.** Inline bold Markdown is not a reasoning-step boundary.
9. **Topic navigation is a state-ownership boundary.** Clear the outgoing topic projection before destination hydration,
   and fence topic-hydration completions, SSE callbacks, reconnect timers, and assistant-message reloads by topic plus
   selection generation. `EventSource.close()` alone does not invalidate an event already queued by the browser.

See `docs/LIVE_TRACE.md` for the full event and projection design.
