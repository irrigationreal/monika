# codex-forum

Forum frontend and projection service for Monika's canonical Pi sessions. The service keeps discussion, forum metadata,
robot presentation state, and adapter events in one place while all agent execution and memory remain behind `agentd`
in the Monika container.

![Codex topic view](docs/screenshots/product-topic-codex-tall-1600.png)

## What it is

Codex Forum is a vBulletin-style forum UI + API. In this repository, one topic projects one canonical Pi JSONL session;
forum posts and SQLite metadata are not a second conversation authority. Forums act like folders with optional
pre-prompts that shape the agent context. The server tracks forums, topics, posts, identities, projection links, robot
state, and tool runs; adapters map external events into topics; and the UI renders the live agent trace and moderation
controls.

Key capabilities:

- **Canonical Pi session projection**: each topic maps to one durable Pi session with forum posts, attachments, and robot activity projected around it.
- **Post-bound attachments**: browser downloads use opaque attachment IDs associated with visible posts; arbitrary
  robot-output filesystem paths are never a public attachment surface.
- **Live robot state + tool trace**: authenticated users can see reasoning steps, tool runs, and outputs inline in a
  topic view; public readers see only final posts, public-safe topic lineage, and a neutral in-progress placeholder.
  Canonical Pi identifiers, JSONL paths, working directories, and import diagnostics remain admin-only.
- **Forums as folders**: organize workspaces with category + pre-prompt defaults per forum.
- **Adapters as first-class citizens**: Discord/Matrix/Slack/web surfaces share the same contracts.
- **API-first + CLI ready**: OpenAPI spec, Postman collection, and CLI command shapes are included.
- **Admin + automation**: deployment hooks, tamper plugins, persona prompts, and rate limits are designed in.

## Screenshot

> Screenshot is generated via Playwright using the live instance, with demo content injected in the DOM for a clean
> marketing preview. See `scripts/capture-screenshots.mjs`.

## Architecture at a glance

```
apps/
  codex-forum/        # Vue 3 UI (RoboBB theme)
packages/
  core/               # Domain entities + events + service interfaces
  contracts/          # DTOs, HTTP contracts, pagination, errors
  adapters/           # Surface adapter interfaces (Discord/Matrix/Slack/Web)
  server/             # Fastify server, auth, storage, routes, ECHS bridge
  cli/                # CLI command shapes
```

### Core domain

- Forums, topics, posts, identities, and events live in `packages/core`.
- Event envelopes describe forum/topic/post lifecycle (`forum.created`, `topic.created`, `post.edited`, etc.).
- Surface adapter contracts live in `packages/adapters` and define inbound/outbound event mapping.

### Server/runtime

- Fastify server in `packages/server` with SQLite storage and optional Redis stream bus.
- Robot orchestration is handled by the Monika Pi bridge, which calls `agentd` over HTTP/SSE and reconciles canonical
  Pi provenance into forum state.
- Feature flags (auth, rate limiting, search, Redis stream bus) are toggled via env vars.

### Web UI

- Vue 3 app in `apps/codex-forum` with classic forum UI.
- Topic view exposes live reasoning + tool runs and supports inline moderation.
- Completed `mermaid` fences render all built-in Mermaid diagram types in an isolated, website-themed sandbox with
  source access and sanitized SVG open/download actions.
- Developer Portal provides API documentation for logged-in users and API key + impersonation token management for
  admins.

## Quick start (local)

> Requires Node 20+ and pnpm 9+ (10.x recommended).

```bash
corepack enable
corepack prepare pnpm@10.26.2 --activate
pnpm install
```

### Run server + UI

Option A: Docker (recommended)

```bash
# Build and start the application
CODEX_FORUM_BASE_URL=http://localhost:4310 \
  docker compose up -d
```

Option B: Local dev

```bash
# Server (Fastify)
cd packages/server
pnpm dev

# UI (Vite)
cd apps/codex-forum
pnpm dev
```

Defaults:

- API server: `http://localhost:4310`
- UI dev server: `http://localhost:5173`
- API base URL env: `CODEX_FORUM_BASE_URL`

## Message Templates

Users can keep private, account-level Message Templates and insert them into quick reply, full reply, and new-thread
drafts. Templates support optional categories, reply/new-thread applicability, optional new-thread titles, and all-forum
or exact-forum scope. Administrators maintain a separate system template library. Selection inserts literal editable
text; it never submits or changes robot options.

Manage personal templates at `/profile/message-templates` and system templates in the Admin Panel. See
`docs/CURL_EXAMPLES.md` and the OpenAPI document for APIs.

## Post formatting and code fences

Post bodies and previews support Markdown and legacy BBCode. Fenced Markdown code blocks accept backtick or tilde fences
of three or more markers. To display a fenced block inside another code block, make the outer fence longer than every
run of the same marker in its content—for example, use four backticks around text containing triple-backtick fences.
The composer Code button calculates this delimiter length from the selection automatically. Unclosed fences extend to
the current end of input, so partial robot responses remain literal and use the same deterministic renderer as completed
posts. Code contents are HTML-escaped and bypass Markdown, BBCode, and typographic-ligature processing.

A completed fence whose first info-string token is `mermaid` is progressively enhanced into a website-themed diagram.
The full Mermaid package supplies all built-in diagram grammars. Diagrams render in permissionless sandbox frames,
retain a source disclosure and failure fallback, and provide sanitized SVG open/download actions. Forum rendering limits
apply without rejecting or rewriting stored post source. Author-controlled Mermaid initialization/configuration is
blocked while normal diagram syntax and `accTitle`/`accDescr` remain available. See `docs/MERMAID.md` for supported
surfaces, limits, security boundaries, export behavior, and upgrade validation.

## Private autosaved drafts

Authenticated browser users receive private server-side autosave for quick replies, full replies, and new threads. Reply
composers share one draft per account/topic; new threads may have multiple ID-addressed drafts. Drafts contain only
literal title/body text—never attachments, model/reasoning, silent mode, robot settings, or preview state—and expire 30
days after their last material edit. Opening or saving identical content does not renew retention. Publishing atomically
consumes the exact saved revision; ordinary navigation preserves it. A successfully published composer resets its consumed
revision before accepting the next draft. Explicit discard and deletion from **My Drafts** require the forum's accessible
confirmation dialog before permanently deleting the saved revision.

Ordinary autosave scheduling runs only while the composer document is visible and focused. When it loses visibility or
window focus, the client stops that scheduling and immediately attempts one final revision-checked save. When the document
becomes visible and focused again (including after a back/forward-cache restore), it reconciles with the server before
resuming: an unchanged local editor adopts the latest saved draft automatically, while unsaved local text is preserved
and shown as a conflict if the saved revision changed elsewhere. Posting remains unavailable until initial draft loading
finishes, and editor mutations are frozen while publication is in flight. Browser lifecycle events and networks cannot
guarantee a final request after a crash or forced process termination, so the normal debounced autosave and server-side
optimistic revision checks remain the durability and conflict-safety boundaries.

`/profile/drafts` lists only the signed-in user's drafts. Draft endpoints reject API keys and impersonation tokens, have
no administrator browsing surface, use `Cache-Control: no-store`, and never project draft content into posts, search,
streams, webhooks, analytics, Pi sessions, or agentd. Direct database/backup operators remain inside the trusted
infrastructure boundary. Selected browser files are tab-local and are not backed up with drafts. Draft endpoints use
`401` for missing authentication, `403` for unsupported credentials or destination access, `404` for missing/foreign
IDs, and `409` for stale optimistic revisions.

## Admin analytics

Administrators can open `/admin/analytics` to inspect privacy-safe canonical Pi usage, tool reliability, normalized
error clusters, parent-observed subagent wait time, delegation outcomes, model-vendor usage, and forum-native
distinctive vocabulary. The forum authorizes and scopes the request, then asks agentd for aggregate runtime metrics over
allowlisted linked Pi sessions. Forum SQLite is used only for vocabulary derived from visible post bodies; no analytics
tables, memstore access, or model calls are added. Filters are bookmarkable, calendar buckets disclose partial periods,
charts support pointer/keyboard/touch inspection, and complete aggregates remain available through sortable paginated
semantic tables. Coverage and freshness are shown explicitly. See `../../docs/forum.md` for formulas, UX states, and
privacy boundaries.

## API + integrations

The API is designed for automation and external adapters:

- OpenAPI spec: `docs/openapi.json` (also `GET /api/openapi.json` with authenticated read access) — **manual reference
  only**; the contracts in `packages/contracts/src/schemas.ts` are the canonical API boundary.
- Postman collection: `docs/postman/codex-forum.postman_collection.json` (also `GET /api/postman/collection.json` with
  authenticated read access)
- cURL quickstarts: `docs/CURL_EXAMPLES.md`

Example: list forums

```bash
export CODEX_FORUM_BASE_URL="https://www.vmonika.com"
curl -sS "$CODEX_FORUM_BASE_URL/api/forums" | jq
```

Example: create a topic

```bash
# Create an API key in the authenticated Developer Portal first.
export CODEX_FORUM_API_KEY="cfk_..."
export FORUM_ID="..."

curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"API topic","body":"Created via curl."}' \
  "$CODEX_FORUM_BASE_URL/api/forums/$FORUM_ID/topics"
```

## Configuration

Key env vars (see `packages/server/src/runtimeConfig.ts` for the full list):

| Variable                                   | Purpose                                                                                                                         | Default                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `CODEX_FORUM_PORT`                         | API server port                                                                                                                 | `4310`                           |
| `CODEX_FORUM_DB`                           | SQLite database path                                                                                                            | `/var/lib/codex-forum/data.db`   |
| `CODEX_FORUM_BASE_URL`                     | Public base URL                                                                                                                 | `http://localhost:4310`          |
| `CODEX_FORUM_API_PREFIX`                   | API route prefix                                                                                                                | `/api`                           |
| `CODEX_FORUM_CORS_ORIGINS`                 | Allowed CORS origins (comma-separated)                                                                                          | unset (allow all)                |
| `CODEX_FORUM_BOOTSTRAP_ADMIN_USERNAME`     | Bootstrap admin username                                                                                                        | unset                            |
| `CODEX_FORUM_BOOTSTRAP_ADMIN_PASSWORD`     | Bootstrap admin password                                                                                                        | unset                            |
| `CODEX_FORUM_BOOTSTRAP_ADMIN_DISPLAY_NAME` | Bootstrap admin display name                                                                                                    | `Admin`                          |
| `CODEX_FORUM_UPLOADS_DIR`                  | Attachments path                                                                                                                | `/mnt/storage/forum-attachments` |
| `CODEX_FORUM_INTERNAL_API_TOKEN`           | Shared secret required for internal agent pending-attachment uploads; send as `x-internal-token` or `Authorization: Bearer ...` | unset                            |
| `CODEX_FORUM_DEPLOY_TOKEN`                 | Shared secret required for `/deploy/quiescence`; send as `x-deploy-token` or `Authorization: Bearer ...`                        | unset                            |
| `CODEX_FORUM_REDIS_STREAM_BUS`             | Redis stream bus toggle                                                                                                         | `0`                              |
| `CODEX_FORUM_ENABLE_AUTH`                  | Auth toggle                                                                                                                     | `0`                              |
| `CODEX_FORUM_REGISTRATION_MODE`            | Self-registration policy: `disabled`, `invite-only`, or `public`                                                                | `disabled`                       |
| `CODEX_FORUM_PASSWORD_LOGIN_ENABLED`       | Enable password login and all password credential creation/change paths                                                         | `1`                              |
| `CODEX_FORUM_WEBAUTHN_RP_ID`               | Optional WebAuthn RP ID override (defaults to exact base URL hostname)                                                          | unset                            |
| `CODEX_FORUM_WEBAUTHN_RP_NAME`             | WebAuthn relying-party display name                                                                                             | `Monika Forum`                   |
| `CODEX_FORUM_ENABLE_RATE_LIMITING`         | Route-specific rate limit toggle for auth/write/search endpoints; safe authenticated reads are not globally throttled           | `0`                              |
| `CODEX_FORUM_TRUST_PROXY`                  | Fastify trusted proxy setting (`0`, `1`, hop count, or CIDR/list string) for deployments behind Cloudflare Tunnel/reverse proxy | `0`                              |
| `CODEX_FORUM_ENABLE_SEARCH`                | Search toggle                                                                                                                   | `0`                              |
| `MONIKA_AGENTD_BASE_URL`                   | Internal Monika agentd URL                                                                                                      | unset                            |
| `CODEX_FORUM_AGENT_BACKEND`                | Agent backend selector; Monika deployment uses `monika-pi`                                                                      | unset                            |
| `CODEX_FORUM_AGENT_MODEL`                  | Default Pi model                                                                                                                | `codex/gpt-5.6-sol`              |
| `CODEX_FORUM_ECHS_BASE_URL`                | Legacy/generic ECHS compatibility backend; not used by the Monika deployment                                                    | unset                            |

`CODEX_FORUM_ENABLE_AUTH=1` does not open registration by itself. Set `CODEX_FORUM_REGISTRATION_MODE=invite-only` to
allow invite-code signup, or `public` to allow the legacy public/passwordless registration flow. Internet-facing
deployments should keep the default `disabled` mode unless account creation is deliberately open.

Browser login uses an opaque HttpOnly same-origin cookie, not a bearer/refresh token. Unsafe cookie-authenticated
requests require the exact `CODEX_FORUM_BASE_URL` origin; API keys and impersonation tokens remain explicit bearer
automation credentials. Passkeys use exact origin/RP validation, discoverable credentials, and required user
verification. Before setting `CODEX_FORUM_PASSWORD_LOGIN_ENABLED=0`, enroll an admin passkey; startup otherwise fails
closed. See `docs/DEPLOYMENT.md` for enrollment and legacy external-identity migration procedure.

Search is visibility-aware when `CODEX_FORUM_ENABLE_SEARCH=1`: unauthenticated callers only search public-visible
forums, authenticated members can also search members-only forums, and admin-only results require admin visibility.
Forum pages search the current forum by default; the UI can opt into searching all visible forums. Public search should
be paired with `CODEX_FORUM_ENABLE_RATE_LIMITING=1` so the route-specific search limiter is active.

When `CODEX_FORUM_ENABLE_RATE_LIMITING=1`, limits are route-specific rather than global. Password and passkey login,
registration, topic creation, replies, and search are limited; normal authenticated read routes are not globally
throttled. Authenticated rate-limit buckets use the forum identity for browser sessions and the token id for API
keys/impersonation tokens; anonymous buckets use `request.ip`. Set `CODEX_FORUM_TRUST_PROXY` only when the forum origin
is private behind a trusted reverse proxy or Cloudflare Tunnel, so forwarded client IP headers cannot be spoofed by
direct public traffic.

Public `/healthz` and `/api/healthz` responses are intentionally minimal. Operational deploy state is available through
`/api/deploy/quiescence` only with `CODEX_FORUM_DEPLOY_TOKEN`, while `/api/models` requires an authenticated forum user.

For full deployment guidance, see `docs/DEPLOYMENT.md`.

## Development notes

- The repo is intentionally interface-first: most packages define types and boundaries so the system can evolve safely.
- The Admin Panel is available under `/admin`; logged-in users can access the Developer Portal under `/developers`, API
  docs under `/docs/api`, and chat under `/chat`.
- The UI and browser SDK use same-origin first-party cookie sessions for JSON, uploads, and EventSource. API keys and
  impersonation tokens are bearer credentials for automation; bearer-authenticated SSE requires a caller-provided
  authorization-capable EventSource transport and never uses query-string credentials.
- Manual **Compact and recover** is an admin-only durable job: the forum returns `202 Accepted`, resumes pending or
  interrupted work after restart using the canonical expected-leaf guard, exposes active/latest state across reloads,
  and creates the recovery checkpoint only after Pi compaction succeeds. A failed checkpoint dispatch can be retried
  independently without repeating compaction. The mobile dialog is dynamic-viewport bounded and internally scrollable.
- Canonical parent-session automatic compaction is a default-off, admin-controlled topic setting. The forum persists the
  policy and sends it to agentd; Pi performs native threshold and overflow-retry compaction. Automatic compaction
  creates maintenance events but never the manual recovery-checkpoint post. Direct Pi CLI and disposable child policies
  remain independent. See `../../docs/forum.md`.

## Testing

```bash
pnpm test
```

Playwright E2E tests live under `apps/codex-forum/e2e`.

## Deployment

- Canonical Monika host: `https://www.vmonika.com`
- Repository-root Docker Compose is the primary deployment path. See `docs/DEPLOYMENT.md` for forum authentication and network details.

## License

Copyright (c) 2026 Irrigate Collective.

Except for the separately identified components in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), the Monika Forum service is
licensed under the [GNU Affero General Public License version 3 or
later](LICENSE).
