# Redeployment safety

Monika runtime redeploys are gated on application-level quiescence rather than Docker process state alone. The runtime must not replace containers while Pi is producing a turn, while forum robot dispatch is queued/running, or while memstore/forum persistence work is active.

## Safety contract

### Monika / agentd

`agentd` exposes deployment state at:

- `GET /v1/admin/quiescence`
- `POST /v1/admin/drain`
- `POST /v1/admin/drain/cancel`

`/v1/admin/quiescence` reports active turns, loaded conversations, memstore save queue state, and whether the container is immediately safe to stop. Active turns and busy/unreachable memstore are hard blockers. Idle loaded conversations are not hard blockers, but they require a drain because closing them triggers Pi session shutdown and memory save.

`/v1/admin/drain` marks agentd as draining, rejects new conversation/message requests, closes idle loaded conversations, and reports the resulting quiescence state. Automation should defer if the response still contains blockers.

### memstore

memstore reports save queue state through `memstore_status` and `queue_status`, including queue depth, whether a save is currently processing, and the current job metadata. On SIGTERM, memstore stops accepting new socket connections and waits for the save processor to finish any in-flight job before allowing the SQLite handle to close.

### Forum

The forum reports deploy safety in:

- `GET /api/deploy/quiescence`
- `GET /api/healthz` under the `deployment` field
- `GET /api/admin/deploy/status` for authenticated admin views

Forum deploy blockers include active robot turns, queued turns, non-idle robot states, and a currently running Pi session sync. On SIGTERM/Fastify close, the server stops the Pi sync timer, waits for an in-flight sync to finish, stops robot/ECHS timers and SSE subscriptions, closes Redis if enabled, and closes the forum SQLite database.

## Host script

`scripts/deploy-if-safe` is the repo-tracked orchestration entry point for stanza-style deployments. It:

1. Checks forum quiescence.
2. Drains agentd idle conversations.
3. Defers with exit code `75` (`EX_TEMPFAIL`) if either service is blocked.
4. Pulls and applies the `:main` Monika and forum images with Docker Compose.

The script intentionally orchestrates only Docker and image tags. The knowledge of whether stopping is safe lives in agentd/forum APIs so the same contract can be reused by admin UI, timers, Watchtower hooks, or future tooling.
