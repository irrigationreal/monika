# Redeployment safety

Monika runtime redeploys are gated on application-level quiescence rather than Docker process state alone. The runtime must not replace containers while Pi is producing a turn, while forum robot dispatch is queued/running, or while memstore/forum persistence work is active.

For the generic operator runbook and autodeploy lifecycle, see [`docs/autodeploy.md`](autodeploy.md).

## Safety contract

### Monika / agentd

`agentd` exposes deployment state at:

- `GET /v1/admin/quiescence`
- `POST /v1/admin/drain`
- `POST /v1/admin/drain/cancel`

`/v1/admin/quiescence` reports active turns, reconciled async-subagent execution, loaded conversations, interactive Pi ownership leases, memstore save queue state, and whether the container is immediately safe to stop. Active turns, active or uncertain subagent runners, interactive Pi sessions, and busy/unreachable memstore are hard blockers. Idle loaded conversations are not hard blockers, but they require a drain because closing them triggers Pi session shutdown and memory save. Interactive leases expire after a crashed terminal, but deploy automation must not override a live lease because recreating the container would terminate that administrator session.

Subagent execution state comes from the durable run ledger below `/data/pi-subagents/async-subagent-runs`, not stale loaded-memory flags. `GET /v1/admin/subagents` exposes a capped operational summary. Exact observed terminal proof, same-container PID/start-identity reconciliation, and container runtime epochs distinguish active, terminal, interrupted, and uncertain work. Pending result projection is durable delivery work, not a live execution blocker. Effects-unknown also does not claim a live process, but it blocks safe deployment and prohibits automatic replay or unaudited delivery dismissal until reconciled or operator-attested. Lifecycle traversal errors fail closed as `subagent_lifecycle_unavailable`.

`/v1/admin/drain` marks agentd as draining, rejects new conversation/message requests, installs a pi-subagents launch/completion barrier, closes idle loaded conversations, and reports the resulting quiescence state. Automation should defer if the response still contains blockers. If automation drains agentd but does not proceed to restart the runtime, it should call `/v1/admin/drain/cancel` before exiting. Drain also has a lease for defense in depth: by default agentd auto-cancels drain after 15 minutes without shutdown, unless the caller provides another `auto_cancel_ms` value or the process is handling SIGTERM.

Host-side deploy automation reaches agentd through the loopback-only compose binding:

```yaml
ports:
  - "127.0.0.1:${MONIKA_AGENTD_PORT:-7724}:7724"
```

Do not publish agentd on a non-loopback host address unless the service has gained an external authentication/authorization boundary.

### memstore

memstore reports save queue state through `memstore_status` and `queue_status`, including queue depth, whether a save is currently processing, and the current job metadata. On SIGTERM, memstore stops accepting new socket connections and waits for the save processor to finish any in-flight job before allowing the SQLite handle to close.

### Forum

The forum reports deploy safety in:

- `GET /api/deploy/quiescence` for host-side deploy automation, authenticated with `CODEX_FORUM_DEPLOY_TOKEN`
- `GET /api/admin/deploy/status` for authenticated admin views

`GET /api/healthz` is intentionally minimal and public (`{ "ok": true }`) so Docker and reverse-proxy health checks do not expose operational state.

Forum deploy blockers include active robot turns, queued turns, non-idle robot states, pending/running manual compactions, and a currently running Pi session sync. Deploy on Finish also checks agentd, persists its intent across forum restart, and retains/retries that intent after the host script returns exit 75. The host script remains the final race-safe authority. On SIGTERM/Fastify close, the server stops new post-dispatch and compaction claims, waits for an in-flight compaction and Pi sync to finish, stops robot/ECHS timers and SSE subscriptions, closes Redis if enabled, and closes the forum SQLite database. If the process instead crashes, startup requeues interrupted compactions and reconciles them through agentd's canonical expected-leaf proof.

## Host script

`scripts/deploy-if-safe` is the repo-tracked orchestration entry point for host-side safe deployments. It:

1. Fetches and inspects the live git checkout without modifying it.
2. Defers if the checkout is dirty, detached, lacks an upstream, cannot fetch, or is behind upstream.
3. Pulls the configured Monika and forum images.
4. Exits cleanly if the pulled image IDs already match the running containers.
5. Checks forum quiescence.
6. If the `monika` image changed, drains agentd to reject new work before shutdown. The script POSTs `/v1/admin/drain` even when agentd already reports `safe_to_stop`; drain is a deploy lock, not only an idle-conversation cleanup step.
7. Defers with exit code `75` (`EX_TEMPFAIL`) if either service is blocked, including while an interactive Pi TUI owns a session.
8. Creates and verifies a whole-repo `.tar.zst` runtime capsule backup.
9. If the `monika` image changed, re-checks/re-starts agentd drain immediately before Docker Compose runs.
10. Pulls and applies the configured Monika and forum images with Docker Compose.
11. If agentd was drained, cancels drain on the running agentd after Compose and waits for healthy/undrained state.
12. Prunes old redeploy backups by tiered retention bucket.
13. Prunes old dangling Docker image layers conservatively.

Forum-only image updates do not drain agentd because Docker Compose is not expected to recreate the `monika` container. Backup-only mode still drains and cancels agentd because its purpose is to create a quiescence-gated runtime capsule.

The script intentionally orchestrates only Docker and image tags. The knowledge of whether stopping is safe lives in agentd/forum APIs so the same contract can be reused by admin UI, timers, Watchtower hooks, or future tooling.

### Uncertain-run repair

Normal reconciliation never deletes or fabricates process proof. If a legacy or damaged run remains uncertain after runtime/PID reconciliation, inspect it with `GET /v1/admin/subagents`. The loopback-only `POST /v1/admin/subagents/<run-id>/quarantine` endpoint is an audited last resort: it requires the exact runner process-instance ID and a non-empty operator reason, refuses a matching live process, writes `operator-resolution.json`, and appends `operator-resolutions.jsonl`. Quarantine preserves all diagnostics. It is not part of normal autodeploy and must only follow independent process verification.

A terminal remote run with `effects_state: "unknown"` is quiescent but remains a deployment blocker until its mutation effects are investigated. After inspecting the target and operation evidence, an operator may post `{ "effects_state": "none"|"confirmed", "reason": "..." }` to `/v1/admin/subagents/<run-id>/resolve-effects`. The endpoint rejects active, uncertain, legacy, and conflicting already-resolved runs, then writes an audited `effects-resolution.json` attestation; an identical lost-response retry is idempotent. `none` means the investigation proved that the attempted operation made no change; `confirmed` means its resulting changes have been identified. Neither value asserts that those changes are desirable—review or revert them separately before redeployment.

Pending completion delivery is separate from execution safety. The container
exports `/data/pi-subagent-operator-state` and creates it privately before agentd
starts; failure to create that persistent authority fails container startup rather
than degrading retention or acknowledgement later. A
`PI_SUBAGENT_OPERATOR_ROOT` override must resolve to an absolute dedicated path
below a top-level mount; relative, filesystem-root, and mount-root values are
rejected before permissions are changed. Canonical completion provenance
is the only automatic acknowledgement proof. For an unresolved legacy result, an
operator can post `{ "action": "dismiss"|"supersede", "reason": "..." }`
to `/v1/admin/subagents/<run-id>/resolve-delivery`. The endpoint retains the exact
result under `${PI_SUBAGENT_OPERATOR_ROOT}/retained-results/` (by default
`/data/pi-subagent-operator-state/retained-results/`), publishes a no-follow
sidecar, durable delivery acknowledgement, and audit before removing
the pending source, and never creates an assistant completion. Partial failures
leave the source pending and retryable. Scoped nested run keys must be supplied
when a basename is ambiguous.

`GET /v1/admin/subagents/retention` is the operator dry run. Its digest,
counts, and byte totals are deterministic for the observed inventory. Applying
that exact preview uses `POST /v1/admin/subagents/retention` with
`{ "apply": true, "inventory_digest": "...", "reason": "..." }` and is rejected if the digest changed, any
parent is loaded/leased, agentd is draining, or lifecycle state is active or
uncertain. The endpoint cannot discard resumable or unproven histories; those
remain a deliberate manual-policy boundary rather than an unsafe bulk action.

Roll out agentd and forum together: forum startup is
passive, then reconciles dispatch generations before enabling retries. A forum-only
restart may reattach conversations still loaded in agentd; a full runtime restart
leaves historical Pi sessions unloaded until explicit work.

Use `--backup-only` to create a quiescence-gated backup without applying images:

```bash
./scripts/deploy-if-safe --backup-only
```
