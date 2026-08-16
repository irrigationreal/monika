# Forum component deployment

The canonical Monika deployment uses the repository-root [`compose.yaml.example`](../../../compose.yaml.example), which
wires this forum to `agentd` with the `monika-pi` backend. Start with
[the complete runtime deployment guide](../../../docs/deployment.md). This component-local document covers forum
configuration, authentication, data, and network behavior; it does not define a second standalone production topology.

## Configuration surfaces

The deployment deliberately has two configuration surfaces:

1. `runtime/secrets/forum.env` is loaded into the application containers with Compose `env_file`. It owns bootstrap
   credentials, shared internal/deploy tokens, and forum variables not explicitly overridden by Compose.
2. The ignored root `.env`, exported host variables, or ignored `compose.yaml` supply values used by Compose `${...}`
   interpolation. An `env_file` cannot supply interpolation values, and explicitly declared `environment` entries take
   precedence over it.

Initialize the secret file from the repository root:

```bash
cp docs/examples/forum.env.example runtime/secrets/forum.env
```

Generate independent random values for:

```text
CODEX_FORUM_INTERNAL_API_TOKEN
CODEX_FORUM_DEPLOY_TOKEN
```

The first authorizes internal pending-attachment uploads from Monika. The second authorizes host-side deployment
quiescence diagnostics and the deployment-admission acquire/cancel boundary. Neither token belongs in Git.

Configure these through root `.env`, the host shell, or ignored Compose as needed:

```env
CODEX_FORUM_BASE_URL=https://forum.example.com
CODEX_FORUM_AGENT_BACKEND=monika-pi
CODEX_FORUM_AGENT_MODEL=codex/gpt-5.6-sol
CODEX_FORUM_PASSWORD_LOGIN_ENABLED=1
CODEX_FORUM_REGISTRATION_MODE=disabled
CODEX_FORUM_WEBAUTHN_RP_NAME=Monika Forum
```

The tracked Compose template supplies the private Docker-network runtime URL:

```text
MONIKA_AGENTD_BASE_URL=http://monika:7724
```

Do not replace it with a public endpoint. Agentd is internal infrastructure.

The full environment schema is implemented in
[`packages/server/src/runtimeConfig.ts`](../packages/server/src/runtimeConfig.ts). Exact source and Compose values
remain authoritative over prose inventories.

## First startup

Start the complete runtime from the repository root:

```bash
cp compose.yaml.example compose.yaml
mkdir -p runtime/secrets
cp docs/examples/forum.env.example runtime/secrets/forum.env
export MONIKA_WORKSPACE="$(dirname "$(pwd -P)")"
docker compose pull
docker compose up -d
```

The forum binds to host loopback port 4310 by default and reaches agentd only over the private `backend` network. Check
it from the host:

```bash
curl -fsS http://127.0.0.1:4310/healthz
curl -fsS http://127.0.0.1:4310/api/healthz
curl -fsS http://127.0.0.1:4310/readyz
curl -fsS http://127.0.0.1:4310/api/readyz
```

Health is intentionally minimal liveness and can succeed without agentd. Readiness is also public and minimal, but
returns HTTP 503 with `{ "ok": false }` when the selected Monika Pi backend is unreachable, draining, or unhealthy; the
integrated Compose health check uses this surface. Its two-second backend probe calls agentd's lightweight health route,
which does not traverse lifecycle/session archives or wait for canonical-session work. Operational deployment safety
still requires authenticated deployment admission. `GET /api/deploy/quiescence` is diagnostic; the host uses
operation-scoped `POST /api/deploy/admission/acquire` and `/cancel`, with `CODEX_FORUM_DEPLOY_TOKEN`, to pause/wait Pi
sync and fence robot-eligible durable dispatch. Model catalog and administrative routes require an authenticated forum
identity.

## Persistent data

The root Compose deployment bind-mounts:

```text
runtime/forum/data.db     -> /forum/data.db
runtime/forum/uploads/    -> /forum/uploads/
```

The upload volume contains canonical User Files blobs, post associations' bytes, temporary staging files, pending agent
attachments, and avatars. Keep SQLite and this volume in the same backup/restore set. Startup and minute maintenance
reconcile missing blobs, legacy hashes, expired standalone custody, stale staging files, `gc_pending` blobs, and the
durable pending-path deletion queue used by expiry/topic deletion; do not manually remove individual files from the
volume.

Forum SQLite owns forum metadata and projection state. Pi JSONL remains canonical conversation history, and memstore
remains behind agentd. Back up and restore the whole Monika runtime rather than treating the forum database as a
complete agent backup. See [`../../../docs/backups.md`](../../../docs/backups.md).

The forum container currently runs as root to tolerate host-owned bind mounts. This is a known trusted-deployment
compromise, not a claim that arbitrary public container execution is safe.

## Bootstrap and registration

When authentication is enabled, these values in `forum.env` may create the first administrator on an empty database:

```env
CODEX_FORUM_BOOTSTRAP_ADMIN_USERNAME=admin
CODEX_FORUM_BOOTSTRAP_ADMIN_PASSWORD=<long-random-password>
CODEX_FORUM_BOOTSTRAP_ADMIN_DISPLAY_NAME=Admin
```

Registration is separately controlled by `CODEX_FORUM_REGISTRATION_MODE`:

- `disabled` — no public account creation;
- `invite-only` — registration requires a valid invite;
- `public` — public registration is enabled deliberately.

Internet-facing deployments should remain `disabled` unless account creation is intentionally open. Invite lookup
returns not found while registration is disabled so callers cannot probe invite codes.

## Passwords, passkeys, cookies, and CSRF

`CODEX_FORUM_PASSWORD_LOGIN_ENABLED=1` enables password login and password creation/change paths. Before setting it to
`0`, enroll and verify an administrator passkey. Startup fails closed when password login is disabled and the database
has no passkey-capable administrator.

Set `CODEX_FORUM_BASE_URL` to the exact public URL. WebAuthn pins that exact origin and defaults its RP ID to the
hostname. A deliberate `CODEX_FORUM_WEBAUTHN_RP_ID` override must be a valid registrable suffix; changing it makes
credentials created for the old RP ID unusable. User verification is required and credentials are discoverable.

Browser sessions use random opaque HttpOnly, `SameSite=Lax`, path `/` cookies. Cookies are `Secure` when the configured
base URL uses HTTPS. Only a session hash is stored. Password and passkey changes revoke other sessions.

The first-party browser SDK is same-origin. Unsafe cookie-authenticated requests must carry the exact configured
`Origin`. API keys and impersonation tokens remain explicit bearer credentials for automation; credentials are never
placed in SSE query strings.

Users enroll and name passkeys from User CP. Login is usernameless. An account cannot remove its final passkey unless
password login remains enabled and the account has a password.

### Legacy external-identity migration

The authentication migration refuses to drop a nonempty `external_identities` table. Before applying it:

1. stop forum writes and back up SQLite;
2. inventory and unlink or migrate every legacy external identity;
3. restart and verify the migration;
4. migrate browser clients from legacy token storage to same-origin cookies, and automation to API-key token storage.

A nonzero row count leaves the migration unapplied and visible in startup logs. Restore the backup for rollback rather
than editing migration state manually.

## Search, rate limiting, and trusted proxies

Public search should be paired with `CODEX_FORUM_ENABLE_RATE_LIMITING=1`. Limits are route-specific: login,
registration, topic creation, replies, and search are limited, while ordinary authenticated reads are not globally
throttled.

Set `CODEX_FORUM_TRUST_PROXY` only when the origin is private behind the exact trusted proxy or tunnel. Trusting
forwarded headers while the origin remains public lets clients spoof IP identity and bypass anonymous limits.

## Public ingress

The generic deployment binds the forum to loopback. The production Monika model uses an outbound-only Cloudflare Tunnel
on a separate Compose network; the connector cannot resolve agentd. See
[`../../../docs/public-ingress.md`](../../../docs/public-ingress.md) for the canonical host, redirects, token custody,
cache policy, and verification.

For another reverse proxy, preserve:

- the exact `CODEX_FORUM_BASE_URL` origin;
- WebSocket/SSE streaming without response buffering;
- request body limits appropriate to the reviewed upload policy;
- private origin access when forwarded client IPs are trusted;
- no route from public ingress to agentd.

## Updates and recovery

Do not recreate the forum or Monika container in the middle of Pi work. The root
[`deploy-if-safe`](../../../scripts/deploy-if-safe) flow acquires the forum's expiring process-local admission lease before backup or drain,
then revalidates and renews the same owned lease immediately before Compose. Admission pauses/waits Pi sync and checks
current actionable durable dispatch, pending/running fork, compaction, tracked direct agent/model work, projection,
agentd, memstore, interactive ownership, and delegated work before replacing containers. A lost/expired renewal fails
closed. Compose begins while the old forum lease exists; forum replacement clears that process-local fence, so the
post-readiness cancel is an idempotent no-op. Monika-only and backup-only explicitly cancel the surviving lease, and the
trap uses bounded best-effort cancellation on abort.

See:

- [`../../../docs/redeployment.md`](../../../docs/redeployment.md) for quiescence;
- [`../../../docs/autodeploy.md`](../../../docs/autodeploy.md) for host automation;
- [`../../../docs/backups.md`](../../../docs/backups.md) for backup and restore;
- [`../../../docs/forum.md`](../../../docs/forum.md) for canonical projection and cross-service lifecycle.

## Local component development

For forum-only development from `services/forum/`:

```bash
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install
pnpm test
```

The root deployment remains the integration target. Local Vite/Fastify processes may use development configuration, but
they do not redefine production ownership or canonical-session rules.
