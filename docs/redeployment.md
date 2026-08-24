# Redeployment safety

Monika runtime redeploys are gated on application-level quiescence rather than Docker process state alone. The runtime must not replace containers while Pi is producing a turn, while forum robot dispatch is queued/running, or while memstore/forum persistence work is active.

For the generic operator runbook and autodeploy lifecycle, see [`docs/autodeploy.md`](autodeploy.md). For off-host restic/WORM recovery and the emergency kit, see [`docs/backups.md`](backups.md).

## Safety contract

### Monika / agentd

`agentd` exposes deployment state at:

- `GET /v1/admin/quiescence`
- `POST /v1/admin/drain`
- `POST /v1/admin/drain/cancel`

`/v1/admin/quiescence` reports active turns, reconciled async-subagent execution, loaded conversations, interactive Pi ownership leases, memstore save queue state, and whether the container is immediately safe to stop. Active turns, active or uncertain subagent runners, interactive Pi sessions, and busy/unreachable memstore are hard blockers. Idle loaded conversations are not hard blockers, but they require a drain because closing them triggers Pi session shutdown and memory save. Interactive leases expire after a crashed terminal, but deploy automation must not override a live lease because recreating the container would terminate that administrator session. Agentd `GET /healthz` deliberately does not perform this scan: it uses bounded in-memory runtime state and last-successful lifecycle counts with explicit scan age so health remains responsive during canonical turns. Health is not evidence that the runtime is safe to stop.

Subagent execution state comes from the durable run ledger below `/data/pi-subagents/async-subagent-runs`, not stale loaded-memory flags. Stop Robot uses the same authority by canonical Pi session, including unloaded parents: dispatch is fenced before agentd performs scoped top-level/nested fixed-point cancellation. A stop response distinguishes accepted/still `stopping`, proven-local `stopped`, and `uncertain`; cancelled result bytes remain retained, and remote `effects_state=unknown` remains a deployment blocker. Continue stays disabled until reconciliation proves the barrier resolved. Scheduled package runs remain disabled and are not silently included in the cancellation claim. `GET /v1/admin/subagents` exposes a capped operational summary. Exact observed terminal proof, same-container PID/start-identity reconciliation, and container runtime epochs distinguish active, terminal, interrupted, and uncertain work. Pending result projection is durable delivery work, not a live execution blocker. Effects-unknown also does not claim a live process, but it blocks safe deployment and prohibits automatic replay or unaudited delivery dismissal until reconciled or operator-attested. Lifecycle traversal errors fail closed as `subagent_lifecycle_unavailable`.

`/v1/admin/drain` marks agentd as draining, rejects new conversation/message requests, installs a pi-subagents launch/completion barrier, closes idle loaded conversations, and reports the resulting quiescence state. Before reporting success it stores the deploy-drain reason and lease expiry in `/data/agentd-drain-state.json` (override with the absolute `MONIKA_AGENTD_DRAIN_STATE_FILE` path). A replacement container restores an unexpired lease and continues rejecting work until `/v1/admin/drain/cancel` clears both runtime and durable state; expired state is removed at startup. Automation should defer if the response still contains blockers. If automation drains agentd but does not proceed to restart the runtime, it should call `/v1/admin/drain/cancel` before exiting. The lease remains defense in depth across replacement: by default agentd auto-cancels 15 minutes after the original drain request unless the caller provides another `auto_cancel_ms` value. SIGTERM's internal shutdown fence does not create or extend a deploy-drain record.

Host-side deploy automation reaches agentd and forum administrative endpoints
through loopback-only Compose bindings:

```yaml
services:
  monika:
    ports:
      - "127.0.0.1:${MONIKA_AGENTD_PORT:-7724}:7724"
  forum:
    ports:
      - "${MONIKA_FORUM_BIND:-127.0.0.1:4310:4310}"
```

Do not publish agentd on a non-loopback host address unless the service has gained an external authentication/authorization boundary. When the forum trusts forwarded client IPs, public traffic must arrive only through its private Docker-network tunnel/proxy path; direct origin access would permit header spoofing. See [`public-ingress.md`](public-ingress.md).

### memstore

memstore reports save queue state through `memstore_status` and `queue_status`, including queue depth, whether a save is currently processing, and the current job metadata. On SIGTERM, memstore stops accepting new socket connections and waits for the save processor to finish any in-flight job before allowing the SQLite handle to close. PID 1 keeps memstore available while agentd drains, then reaps both children. An unexpected exit from either essential child terminates the container nonzero rather than advertising a partial runtime.

### Forum

The forum reports and acquires deploy safety through:

- `GET /api/deploy/quiescence` for authenticated diagnostic snapshots;
- `POST /api/deploy/admission/acquire` and `POST /api/deploy/admission/cancel` for host-side race-safe deployment admission, authenticated with `CODEX_FORUM_DEPLOY_TOKEN`;
- `GET /api/admin/deploy/status` for authenticated admin views.

`GET /api/healthz` is intentionally minimal public liveness (`{ "ok": true }`). Both `GET /readyz` (the exact Compose/autodeploy target) and `GET /api/readyz` share the same minimal handler and return 503 unless the configured Monika backend reports healthy and undrained. That bounded backend check calls agentd's lightweight `/healthz`; it does not substitute for either service's authenticated deployment-quiescence scan.

Forum deploy blockers include active robot turns, queued turns, non-idle robot states, pending/running manual compactions, and every current-generation actionable durable dispatch (`pending`, `dispatching`, or retryable `failed` with a non-null `next_attempt_at`). Terminal `failed` rows with no next attempt, superseded, abandoned, dispatched, and stale-generation rows do not block. Ordinary quiescence telemetry may report a running Pi sync, but admission itself first closes robot-work admission, pauses new sync cycles, and boundedly waits for an in-flight cycle before evaluating the real blockers. While acquisition is preparing, a newly eligible robot post wins: preparation is revoked, sync resumes, and the post plus durable dispatch commits atomically. Once acquired, eligible topic/reply/adapter/explicit-dispatch writes receive retryable HTTP 503 semantics before their transaction can commit; silent, robot-off, and non-mention cases remain intentional non-dispatch posts. The operation-scoped lease expires automatically, and blocked, revoked, cancelled, or expired attempts reopen admission and resume sync.

Deploy on Finish uses the same durable-dispatch blocker, also checks agentd, persists its intent across forum restart, and retains/retries that intent after the host script returns exit 75. The host script remains the final race-safe authority. On SIGTERM/Fastify close, the server synchronously stops new post-dispatch, compaction, and fork claims, waits for their in-flight operations and Pi sync to finish, stops robot/ECHS timers and SSE subscriptions, closes Redis if enabled, and closes the forum SQLite database. If the process instead crashes, startup requeues interrupted compactions and reconciles them through agentd's canonical expected-leaf proof. Ordinary post dispatches retain the same durable identity across ambiguous transport failures and remain pending at bounded backoff; startup/outage handling does not unlink sessions or manufacture replacement canonical work.

## Host script

`scripts/deploy-if-safe` is the repo-tracked orchestration entry point for host-side safe deployments. It:

1. Fetches and inspects the live git checkout without modifying it.
2. Defers if the checkout is dirty, detached, lacks an upstream, cannot fetch, or is behind upstream.
3. Reconciles optional public ingress, then selects the configured pair. Unset/main keeps the `:main` defaults; opt-in stable strictly resolves the latest release's `stable-manifests.json` to exact digest references. Paired explicit image overrides bypass channel resolution.
4. Pulls the selected Monika and forum images. Stable verifies OCI revision labels and rejects an unacknowledged older, unknown, missing, or divergent running revision before application quiescence; fresh installs and forward ancestry advances proceed.
5. Exits cleanly if the pulled image IDs already match the running containers.
6. Acquires an operation-ID-scoped forum admission lease, which pauses/waits Pi sync and atomically fences new eligible robot work.
7. If the `monika` image changed, drains agentd to reject new work before shutdown. The script POSTs `/v1/admin/drain` even when agentd already reports `safe_to_stop`; drain is a deploy lock, not only an idle-conversation cleanup step.
8. Defers with exit code `75` (`EX_TEMPFAIL`) if either admission or agentd is blocked, including while an interactive Pi TUI owns a session.
9. Creates and verifies a whole-repo `.tar.zst` runtime capsule backup.
10. If the `monika` image changed, re-checks/re-starts agentd drain immediately before Docker Compose runs.
11. Applies exactly the changed Monika/forum service with `--no-deps`. Hosts with `MONIKA_PUBLIC_INGRESS=1` reconcile the digest-pinned `cloudflared` connector independently before image comparison.
12. The replacement Monika container restores the unexpired durable drain; the script cancels it on the new agentd after Compose and waits for healthy/undrained state.
13. After every applied Monika or forum image change—including forum-only updates—waits a bounded interval for the forum's exact unprefixed `/readyz`. A readiness failure aborts before backup/image pruning. Monika updates cancel drain and prove agentd health first because forum readiness depends on the undrained backend.
14. Cancels/reopens forum admission after readiness (or after backup-only completion); the exit trap attempts both forum cancellation and agentd drain cancellation on every abort.
15. Prunes old redeploy backups by tiered retention bucket.
16. Prunes old dangling Docker image layers conservatively.

Forum-only image updates do not drain agentd because Docker Compose is not expected to recreate the `monika` container. Backup-only mode still drains and cancels agentd because its purpose is to create a quiescence-gated **local redeploy** runtime capsule. It does not run the tiered B2 writer. Off-host jobs take a read-only Btrfs capture independently and root executes only the immutable Shadowsea Nix-store program, never this writable checkout.

An exact `404` from admission acquire identifies the one-release bootstrap from a pre-admission forum image. Only then, the host boundedly polls the legacy authenticated quiescence snapshot and rechecks it immediately before Compose. Any other failure remains closed; after replacement, admission is mandatory.

Stable release metadata failure returns exit 75 before forum admission or agentd drain. The public-ingress repair remains before that resolution, after the unchanged git-current gate, so a temporary GitHub API outage cannot prevent connector reconciliation. A reviewed main-to-stable downgrade can be acknowledged for one invocation with `MONIKA_DEPLOY_ALLOW_STABLE_MIGRATION=1`; never persist this override in timer configuration.

The script intentionally orchestrates only Docker and coordinated image selection. The knowledge of whether stopping is safe lives in agentd/forum APIs so the same contract can be reused by admin UI, timers, or future tooling.

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
