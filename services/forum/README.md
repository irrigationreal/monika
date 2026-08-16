# codex-forum

Forum frontend and projection service for Monika's canonical Pi sessions. The service keeps discussion, forum metadata,
robot presentation state, and adapter events in one place while all agent execution and memory remain behind `agentd` in
the Monika container.

![Codex topic view](docs/screenshots/product-topic-codex-tall-1600.png)

## What it is

Codex Forum is a vBulletin-style forum UI + API. In this repository, one topic projects one canonical Pi JSONL session;
forum posts and SQLite metadata are not a second conversation authority. Forums act like folders with optional
pre-prompts that shape the agent context. The server tracks forums, topics, posts, identities, projection links, robot
state, and tool runs; adapters map external events into topics; and the UI renders the live agent trace and moderation
controls.

Key capabilities:

- **Canonical Pi session projection**: each topic maps to one durable Pi session with forum posts, attachments, and
  robot activity projected around it.
- **Private Notepad**: each browser-session account has an owner-only reverse-chronological note feed with unified
  autosaved capture drafts, tags, search, pinning, and hard expiration/deletion. Notes are forum-native account data,
  not topics or Pi sessions.
- **Unified User Files and attachments**: owner-scoped content blobs are SHA-256 deduplicated across an account's
  standalone uploads and human-authored post attachments. Logical post associations retain opaque compatible URLs and
  deletion tombstones; arbitrary robot-output filesystem paths are never a public attachment surface.
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
- Robot orchestration is handled by the Monika Pi bridge, which calls `agentd` over HTTP/SSE and reconciles canonical Pi
  provenance into forum state. Ambiguous disconnect/5xx outages retain the exact durable dispatch identity at bounded
  backoff; definite failures remain terminal, and superseded/abandoned work cannot be manually resurrected. Ordinary
  durable post-dispatch creation also supplies that identity as agentd `creation_id` with `durable_session: true`, so a
  lost create response reopens the same anchored session. Non-dispatch operations never manufacture a missing canonical link; they may repair
  one only from a currently loaded conversation carrying canonical session ID and path.
- A canonical utterance is channel-neutral. One agent run may persist zero, one, or several ordered assistant messages;
  Pi's internal `agent_settled` is idle-only, and agentd maps it to wire `turn_completed`; neither asks the forum to
  publish a raw aggregate.
- Provenance v1 preserves legacy forum post identity. V2 adds the durable ordered contributor set and normalized origin.
  Same-origin events can group; retries retain that original order and never absorb a different origin.
- Live SSE and background sync share one deterministic projection/handoff service, including outbound tamper, default
  persona, parent/follow-up metadata, attachment dedupe, crash recovery, and exactly-once Pi-message claiming.
- Discord/Matrix adapters are best effort beyond the local transaction boundary. Forum SQLite cannot turn a remote send
  or acknowledgement into canonical Pi settlement.
- Feature flags (auth, rate limiting, search, Redis stream bus) are toggled via env vars.

### Web UI

- Vue 3 app in `apps/codex-forum` with classic forum UI.
- The header separates account navigation from forum navigation: the welcome strip owns personal pages, authentication
  actions, and theme selection, while the primary navbar owns forum, admin, chat, developer, and API destinations.
  Account links remain a single horizontally scrollable row on narrow viewports; forum links use the mobile menu.
- Topic view exposes live reasoning + tool runs and supports inline moderation. Explicit delayed `follow_up` subagent
  continuations render beneath their origin with a **Follow-up** badge; `awaited` work stays part of the claiming parent
  synthesis and `silent` work creates no public continuation.
- Completed `mermaid` fences render all built-in Mermaid diagram types in an isolated, website-themed sandbox with
  source access and sanitized SVG open/download actions.
- Developer Portal provides API documentation for logged-in users and API key + impersonation token management for
  admins.

## Quick start (local)

> Requires Node 22.13+ and pnpm 11.21.0.

```bash
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install
```

### Run server + UI

Option A: Docker (recommended)

```bash
# Build and start the application
CODEX_FORUM_BASE_URL=http://localhost:4310 \
  docker compose up -d
```

Each architecture-native image build validates that the production deployment can load Sharp and libvips and complete a
JPEG transform. The forum runtime smoke repeats that transform against the final image.

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

The **User Files** page is cursor-paginated through `GET /user-files/page`, defaults to standalone uploads, and can also
show all files or post attachments only. The original `GET /user-files` array response remains available for existing
REST and SDK consumers and lists the standalone library. New standalone uploads are private and expire after one month
by default, with the same retention presets as Notepad; existing uploads are grandfathered as private/never. Owners can
choose private, members, or public access, reset retention, follow post-association permalinks, remove standalone
custody, or detach one post association. Private owner-library listing and mutation reject impersonation credentials;
private downloads do not treat impersonation as owner authority. Members visibility is tenant-scoped when the owner has
a tenant. Post visibility is evaluated live and any visible active association grants access. Bytes are reclaimed by
restart-safe garbage collection only after standalone custody and every post association are gone; pending paths removed
by expiry or topic deletion use the same durable retry loop.

Post bodies and previews support Markdown and legacy BBCode. Each visible post footer provides **Copy**, which writes
the exact stored forum source to the clipboard without trimming or converting it; this deliberately preserves Markdown,
legacy BBCode, whitespace, code fences, and persona wrappers. Separately uploaded attachments and post metadata are not
added to the copied source. The action remains available in locked topics and to any viewer authorized to read the post.

Fenced Markdown code blocks accept backtick or tilde fences of three or more markers. To display a fenced block inside
another code block, make the outer fence longer than every run of the same marker in its content—for example, use four
backticks around text containing triple-backtick fences. The composer Code button calculates this delimiter length from
the selection automatically. Unclosed fences extend to the current end of input, so partial robot responses remain
literal and use the same deterministic renderer as completed posts. Code contents are HTML-escaped and bypass Markdown,
BBCode, and typographic-ligature processing.

A completed fence whose first info-string token is `mermaid` is progressively enhanced into a website-themed diagram.
The full Mermaid package supplies all built-in diagram grammars. Diagrams render in permissionless sandbox frames,
retain a source disclosure and failure fallback, and provide sanitized SVG open/download actions. Forum rendering limits
apply without rejecting or rewriting stored post source. Author-controlled Mermaid initialization/configuration is
blocked while normal diagram syntax and `accTitle`/`accDescr` remain available. See `docs/MERMAID.md` for supported
surfaces, limits, security boundaries, export behavior, and upgrade validation.

## Persistent Quick Reply dock

Topic pages keep a single Quick Reply composer that can remain inline or be docked to the bottom of the viewport. **Keep
visible** is the sole docking entry; the dock can be expanded for writing, collapsed to a compact bar, or undocked without
remounting the editor, pausing autosave, clearing attachments, or changing publication behavior. Quote preserves the
current presentation: it scrolls to an inline composer, expands a collapsed dock, or focuses an expanded dock. The
collapsed bar reports draft save and conflict status. Model, reasoning level, and Pi context remain visible whenever the
composer is expanded because they describe the operational state of the next robot dispatch. **Options** discloses only
templates, attachment selection, auto-compact, and the full-editor link in their normal composer order; the editor, draft
status, selected files, upload recovery, robot-mode notices, fences, and Post/Steer action also remain visible. Successful
submissions hide Options. A successful ordinary Post collapses a docked composer so the topic and live trace regain the
viewport; a successful Steer leaves it expanded for iterative guidance. Failed or partially completed submissions retain
the current presentation and recovery controls. Expanded docks use one scrolling middle between a fixed header and
full-width action footer. On narrow viewports the dock is a safe-area-aware bottom drawer.

The private account preference **Quick Reply Style** is managed in User CP with **Inline** and **Docked** choices and is
persisted by `PATCH /me/preferences/quick-reply`. It defaults to Inline; Docked opens each eligible topic with the dock
collapsed on both desktop and mobile. Authentication and matching base-topic metadata resolve before the composer is
revealed, so its initial layout never changes underneath an active draft. The composer does not wait for posts,
attachments, robot/session enrichment, or the admin-only Tool Usage inspector; those continue loading independently,
while race-safe draft hydration permits immediate typing. The preference is returned only from authenticated self
APIs—not public profiles. Temporary expand, collapse, and undock actions never rewrite it. Expanded docks reserve enough
topic space to keep the final content and scroll-to-top control unobscured.

## Private autosaved drafts

Authenticated browser users receive private server-side autosave for quick replies, full replies, new threads, and the
Notepad capture composer. Reply composers share one draft per account/topic; new threads may have multiple ID-addressed
drafts; Notepad has one account-wide capture draft. Forum publication drafts contain only literal title/body text, while
the Notepad draft also retains structured tags and its expiration preset. Drafts never retain attachments,
model/reasoning, robot settings, or preview state, and expire 30 days after their last material edit. Opening or saving
identical content does not renew retention. Publishing atomically consumes the exact saved revision; ordinary navigation
preserves it. A successfully published composer resets its consumed revision before accepting the next draft. Explicit
discard and deletion from **My Drafts** require the forum's accessible confirmation dialog before permanently deleting
the saved revision.

Ordinary autosave scheduling runs only while the composer document is visible and focused. When it loses visibility or
window focus, the client stops that scheduling and immediately attempts one final revision-checked save. When the
document becomes visible and focused again (including after a back/forward-cache restore), it reconciles with the server
before resuming: an unchanged local editor adopts the latest saved draft automatically, while unsaved local text is
preserved and shown as a conflict if the saved revision changed elsewhere. Posting remains unavailable until initial
draft loading finishes, and editor mutations are frozen while publication is in flight. Browser lifecycle events and
networks cannot guarantee a final request after a crash or forced process termination, so the normal debounced autosave
and server-side optimistic revision checks remain the durability and conflict-safety boundaries.

`/profile/drafts` lists only the signed-in user's drafts. Draft endpoints reject API keys and impersonation tokens, have
no administrator browsing surface, use `Cache-Control: no-store`, and never project draft content into posts, search,
streams, webhooks, analytics, Pi sessions, or agentd. Direct database/backup operators remain inside the trusted
infrastructure boundary. Selected browser files are tab-local and are not backed up with drafts. Draft endpoints use
`401` for missing authentication, `403` for unsupported credentials or destination access, `404` for missing/foreign
IDs, and `409` for stale optimistic revisions.

## Private Notepad

`/notepad` is a browser-session-only private capture surface. The composer appears above a reverse-chronological feed
and uses the unified draft service; publishing atomically consumes the exact Notepad draft revision. Notes support
optional titles, normalized structured tags, owner-scoped text search, clickable frequency-sorted tag filters, one
pinned note per account, source/preview rendering, copy, explicit revision-checked editing, and permanent deletion.
Pinned notes are shown once above the ordinary feed and retain their chosen expiration.

New notes default to 30-day expiration and may instead use 1 day, 1 week, 2 weeks, 6 months, 1 year, or never. Editing
keeps the existing absolute expiration unless the user explicitly chooses a new preset, which is calculated from the
successful edit time. A one-minute server cleanup hard-deletes due notes and tag rows; read APIs do not hide notes
before that transaction succeeds, and already-open browser snapshots remain stale until an ordinary refresh. Deletion
creates no tombstone. Live deletion cannot promise immediate erasure from SQLite free pages, WAL files, or retained
backups.

Notepad routes use owner-qualified repository queries, `Cache-Control: no-store`, and generic `404` responses for
foreign IDs. They reject API keys and impersonation tokens and provide no administrator browsing surface. Notepad
content never enters ordinary posts/topics, recent activity, public profiles, global forum search, analytics, streams,
notifications, webhooks, Pi sessions, agentd, or memstore. Plaintext notes remain readable to trusted database/backup
operators; the UI states that they are not end-to-end encrypted.

Entries carry a versioned `content_format` (`plaintext-v1` initially) so a future additive format can store an opaque
per-entry ciphertext envelope. Services must not assume every future payload is searchable prose. Future encrypted notes
will need explicit client key management, metadata/search decisions, and a disclosure boundary before decrypted text is
copied into canonical agent context.

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
| `CODEX_FORUM_UPLOADS_DIR`                  | Unified file blob, attachment, staging, and avatar storage root                                                                 | `/mnt/storage/forum-attachments` |
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

Public `/healthz` and `/api/healthz` responses are intentionally minimal liveness checks. Minimal `/readyz` and
`/api/readyz` return only `{ok}` and HTTP 503 unless the selected Monika Pi backend is reachable, healthy, and undrained;
the standalone Compose deployment uses readiness for container health. Operational deploy state is available through
`/api/deploy/quiescence` only with `CODEX_FORUM_DEPLOY_TOKEN`, while `/api/models` requires an authenticated forum user.

For full deployment guidance, see `docs/DEPLOYMENT.md`.

## Development notes

- The repo is intentionally interface-first: most packages define types and boundaries so the system can evolve safely.
- The Admin Panel is available under `/admin`. Its responsive section navigation is URL-backed with
  `/admin?section=<section>` links (the Forums section uses canonical `/admin`), and unknown section values fall back to
  Forums. Admin section data is loaded on demand; wide management tables scroll inside their labelled table regions
  rather than widening the page. Logged-in users can access the Developer Portal under `/developers`, API docs under
  `/docs/api`, and chat under `/chat`.
- The UI and browser SDK use same-origin first-party cookie sessions for JSON, uploads, and EventSource. API keys and
  impersonation tokens are bearer credentials for automation; bearer-authenticated SSE requires a caller-provided
  authorization-capable EventSource transport and never uses query-string credentials.
- Manual **Compact and recover** is an admin-only durable request projection: the forum returns `202 Accepted`, resumes
  pending or interrupted requests after restart, and exposes state across reloads. Agentd owns the idle/expected-leaf
  claim and Pi settlement; the forum creates a recovery checkpoint only after canonical compaction succeeds. A failed
  checkpoint dispatch can be retried independently without repeating compaction. The mobile dialog is dynamic-viewport
  bounded and internally scrollable.
- **Fork** is an admin-only, idle-only native Pi branch operation. The administrator selects an eligible forum-numbered
  user post, edits the replay, and receives a new topic containing independent copies of the inherited active-branch
  posts and attachments plus a non-numbered fork boundary. Agentd preserves the parent runtime, canonical dispatch
  generation, and crash-safe child quarantine; the forum resumes pending operations after reload and keeps ambiguous
  recovery fenced for operator review. V1 creation remains in the same forum and cwd; finalized parent and child topics
  move independently.
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
- Repository-root Docker Compose is the primary deployment path. See `docs/DEPLOYMENT.md` for forum authentication and
  network details.

## License

Copyright (c) 2026 Irrigate Collective.

Except for the separately identified components in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), the Monika Forum
service is licensed under the [GNU Affero General Public License version 3 or later](LICENSE).
