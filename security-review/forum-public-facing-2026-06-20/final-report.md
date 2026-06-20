# Public-Facing vMonika Forum Security Audit — Initial Report

Date: 2026-06-20  
Scope: `services/forum` public read-only exposure before putting the forum on the internet.

## Executive summary

The forum already has a sensible visibility model for normal forum content: public forums are visible without auth, members/admin forums are hidden, and post/attachment downloads generally route through topic visibility checks. I did not find evidence, in this initial static pass, that ordinary `/forums`, `/topics`, `/posts`, or `/attachments` endpoints directly leak private forum content when called unauthenticated.

The main blockers for internet exposure are around adjacent surfaces: public registration is currently open whenever auth is enabled; live/saved trace details are exposed to anyone who can view a public topic; an internal agent upload endpoint becomes unauthenticated if `CODEX_FORUM_INTERNAL_API_TOKEN` is unset; and several operational endpoints expose deployment/model/runtime status without auth. These are fixable, but I would not expose the forum publicly until the first three are addressed.

## Validated findings

### F-01 — Public registration is enabled whenever auth is enabled

**Severity:** High  
**Status:** Validated

Unauthenticated users can create a human identity through `POST /auth/register` when `CODEX_FORUM_ENABLE_AUTH=1`. In the non-invite branch, the endpoint creates an identity, issues a one-time login link, and returns `verifyUrl` directly in the API response. The caller can then call `GET /auth/verify/:token` and receive access/refresh tokens.

This violates the launch policy: internet users must not be able to register accounts.

**Chain of exploitation**

- **Entry point:** `POST /api/auth/register`
- **Untrusted input:** unauthenticated request body with display name and optional email
- **Transformations:** `RegisterRequestSchema` parse → identity creation → one-time link issue
- **Gate(s) + status:** only gated by `featureFlags.enableAuth`; compose enables auth for deployed forum
- **Sink:** authenticated session issuance through verification URL
- **Impact:** arbitrary public users can become authenticated users; depending on forum visibility and permissions, this expands the attack surface to posting, profile/signature content, user files, and possibly robot-triggering paths.
- **Evidence:**
  - `services/forum/packages/server/src/config.ts:15-21` loads `CODEX_FORUM_ENABLE_AUTH` only; there is no registration-mode flag.
  - `compose.yaml.example:95` sets `CODEX_FORUM_ENABLE_AUTH: "1"`.
  - `services/forum/packages/server/src/routes/authRoutes.ts:304-390` implements `/auth/register`; lines 373-389 create an identity, issue a link, and return `verifyUrl`.
  - `services/forum/packages/server/src/routes/authRoutes.ts:394-418` verifies that token and returns session tokens.

**Recommended fix**

Add a single registration mode env var, e.g. `CODEX_FORUM_REGISTRATION_MODE=disabled|invite-only|public`, defaulting to `disabled` for production examples. Behavior:

- `disabled`: `/auth/register` always 403; `/auth/invite/:code` may also 404/403.
- `invite-only`: only invite-code + username + password registration is allowed.
- `public`: current passwordless/email flow allowed if you still want it later.

Also consider not returning `verifyUrl` directly except in explicit development mode.

---

### F-02 — Trace/live robot state is visible to unauthenticated readers of public topics

**Severity:** High  
**Status:** Validated

Robot state and live trace endpoints only require topic visibility. For a public topic, unauthenticated users can call `GET /topics/:topicId/state` and request detailed plan/tool information with `view=full` or `include=plan,toolRuns`. They can also subscribe to `GET /topics/:topicId/state/stream`, which relays raw stream events for the topic. The emitted state includes plan content/summary, recent tool commands and summaries, usage metadata, live assistant text, and assistant checkpoints.

This violates the launch policy: public readers may see public posts, but must not see saved trace history or live trace details.

**Chain of exploitation**

- **Entry point:** `GET /api/topics/:topicId/state?view=full`, `GET /api/topics/:topicId/state/stream`
- **Untrusted input:** unauthenticated request for a public topic id
- **Transformations:** topic visibility check only → plan/tool/live state serialization → HTTP/SSE response
- **Gate(s) + status:** `requireTopicVisible()` passes for public forums; no auth/admin gate for trace details
- **Sink:** operational trace data returned to public users
- **Impact:** public users can see file paths, command strings, tool summaries, current plans/reasoning summaries, live assistant text, and other runtime details that are not meant as public content.
- **Evidence:**
  - `services/forum/packages/server/src/routes/robotRoutes.ts:95-160` returns detailed state after only `requireTopicVisible(topicId, request)`.
  - `services/forum/packages/server/src/routes/robotRoutes.ts:104-115` enables plan/tool inclusion via query params.
  - `services/forum/packages/server/src/routes/robotRoutes.ts:131-157` serializes plan content and tool run command/output summary.
  - `services/forum/packages/server/src/routes/robotRoutes.ts:347-368` exposes the SSE stream after only topic visibility.
  - `services/forum/packages/server/src/echsBridge.ts:2112-2147` emits current plan, recent tool runs, usage, assistant checkpoints, and live assistant text.
  - `services/forum/apps/codex-forum/src/views/TopicView.vue:1842-1853` and `1975-1986` render `PostTracePanel` when trace exists.

**Recommended fix**

Separate *topic visibility* from *trace visibility*.

- For unauthenticated users: hide all plan/tool/reasoning/live trace details.
- For public UI: show a neutral placeholder such as “Response in progress” with a spinner.
- Initial simple policy: trace details require an authenticated user. A stricter policy would make trace admin-only.
- Server-side enforcement matters: do not only hide trace in Vue. `/state`, `/state/stream`, and any saved trace DTOs should redact trace data for unauthenticated requests.

---

### F-03 — Internal pending-attachment upload route is unauthenticated if `CODEX_FORUM_INTERNAL_API_TOKEN` is unset

**Severity:** High  
**Status:** Validated

`POST /agent/topics/:topicId/pending-attachments` is intended as an internal agent endpoint, but `requireInternalAgent()` returns successfully when `CODEX_FORUM_INTERNAL_API_TOKEN` is unset. The compose example does not set this token. If the forum is exposed publicly in that state, any unauthenticated internet user can upload pending attachments to any non-locked topic id they know.

Even if the uploaded file is not immediately attached to a post without a later robot reference, this is still an unauthenticated write endpoint and disk/database DoS surface on the public forum.

**Chain of exploitation**

- **Entry point:** `POST /api/agent/topics/:topicId/pending-attachments`
- **Untrusted input:** unauthenticated multipart file upload
- **Transformations:** optional internal-token check → topic lookup → write file to pending attachments dir → DB row creation
- **Gate(s) + status:** token gate is disabled when env var is absent
- **Sink:** filesystem write and DB row creation
- **Impact:** unauthenticated upload/storage consumption; potential later attachment linkage if a matching pending id is referenced in agent output.
- **Evidence:**
  - `services/forum/packages/server/src/routes/attachmentRoutes.ts:57-63` allows the request if `INTERNAL_API_TOKEN` is unset.
  - `services/forum/packages/server/src/runtimeConfig.ts:190-192` defaults `CODEX_FORUM_INTERNAL_API_TOKEN` to `null`.
  - `compose.yaml.example:83-97` does not set `CODEX_FORUM_INTERNAL_API_TOKEN`.
  - `services/forum/packages/server/src/routes/attachmentRoutes.ts:442-485` accepts the upload and creates a pending attachment.
  - `services/forum/packages/server/src/echsBridge.ts:2418-2442` later converts pending attachments into normal attachments when referenced by id in agent output.

**Recommended fix**

Make this endpoint fail closed:

- Require `CODEX_FORUM_INTERNAL_API_TOKEN` in production when this route is enabled.
- If the token is missing, return 503/500 or disable route registration entirely.
- Add the token to compose secret/env documentation.
- Consider restricting by network layer too, but do not rely on network placement as the only control.

---

### F-04 — Public operational endpoints expose runtime/deployment information

**Severity:** Medium  
**Status:** Validated

Several unauthenticated system endpoints expose operational data useful for reconnaissance. `/healthz` returns agent backend health, deployment state, active/queued robot turn counts, Pi sync status, and build data. `/deploy/quiescence` exposes deploy blockers and robot activity. `/models` returns model catalog details. `/build` returns build metadata.

Some build label information may be acceptable publicly, but detailed health/deployment/model data does not need to be public for a read-only showcase forum.

**Evidence:**

- `services/forum/packages/server/src/routes/systemRoutes.ts:83-91` returns health, ECHS/agent health, deployment state, and build info.
- `services/forum/packages/server/src/routes/systemRoutes.ts:94-100` exposes `/build` and `/deploy/quiescence` without auth.
- `services/forum/packages/server/src/routes/systemRoutes.ts:103-107` exposes model catalog without auth.
- `services/forum/packages/server/src/server.ts:427-444` constructs deployment blocker data including active/queued turns and Pi sync state.

**Recommended fix**

- Keep unauthenticated `/healthz` minimal: `{ ok: true }` only.
- Move deployment quiescence/status and model catalog behind admin auth.
- Keep `/build` minimal if the footer needs it, or serve only commit label/date without runtime health.

---

### F-05 — Rate limiting is implemented but disabled in the deployment example

**Severity:** Medium  
**Status:** Validated

The server supports Fastify rate limiting and route-specific login/registration/post limits, but `compose.yaml.example` sets `CODEX_FORUM_ENABLE_RATE_LIMITING: "0"`. For an internet-facing service with password login, this makes credential stuffing and registration probing easier than necessary.

**Evidence:**

- `services/forum/packages/server/src/config.ts:15-21` loads `CODEX_FORUM_ENABLE_RATE_LIMITING`.
- `services/forum/packages/server/src/server.ts:409-415` registers global rate limiting only when the feature flag is enabled.
- `services/forum/packages/server/src/routes/authRoutes.ts:304-310` applies a registration-specific limiter only when the feature flag is enabled.
- `compose.yaml.example:96` disables rate limiting.

**Recommended fix**

Enable rate limiting for the internet-facing deployment. Keep limits conservative enough not to annoy trusted users, but protect at least:

- `/auth/login`
- `/auth/refresh`
- `/auth/register` if any mode allows it
- upload endpoints
- search when enabled

Turnstile can be added later, but it should be a supplemental control, not the baseline.

## Validated positive controls

- Normal forum listing and topic/post read routes filter or require visibility before returning content: `forumRoutes.ts:114-158`, `250-295`, `384-398`, `672-708`.
- Public attachment downloads require the containing post/topic to be visible: `attachmentRoutes.ts:658-680`.
- Private user files require authenticated owner or moderator access: `attachmentRoutes.ts:537-556`.
- Regular attachment upload requires authenticated write scope, topic visibility, author ownership, and a five-minute post window: `attachmentRoutes.ts:580-655`.
- Search uses prepared statements for user query input: `store.ts:2597-2619`; I did not find SQL injection in the basic search path.
- The Markdown/BBCode renderer has a custom sanitizer with explicit scheme blocking, dangerous attribute stripping, forbidden tag removal, and tests for common XSS payloads: `useMarkdown.ts:434-459`, `539-589`, `638-723`; `useMarkdown.sanitize.test.ts:4-141`.

## Parking-lot / follow-up items

- **Search completeness/privacy:** search queries all topics/posts first and filters by visibility afterward (`searchRoutes.ts:49-65`, `store.ts:2597-2619`). This does not expose counts directly, but private matches can consume the `limit` before public results are filtered, producing incomplete public results. Prefer visibility-aware SQL before enabling public search.
- **Query token support:** auth supports tokens in query params for SSE (`utils/access.ts:48-53`). This is practical for EventSource, but tokens can leak through URLs, browser history, proxy logs, or referrers. If SSE auth is needed, prefer short-lived stream tokens.
- **CSP is disabled:** Helmet is used, but `contentSecurityPolicy: false` (`server.ts:352-356`). The sanitizer is doing most of the XSS work. A future CSP would provide defense-in-depth, but it may need careful tuning for Vue/assets.
- **Sanitizer maintenance risk:** the custom sanitizer appears reasonably covered by tests, but because `v-html` is used in several places, future formatting changes can reopen XSS. Consider DOMPurify or expand sanitizer fuzz/regression tests.

## Recommended remediation order before public exposure

1. Add registration mode and deploy with `disabled`.
2. Gate/redact trace state and SSE details for unauthenticated users; add public “Response in progress” placeholder.
3. Make internal agent pending-attachment route fail closed when the internal token is unset.
4. Minimize or auth-protect operational endpoints.
5. Enable internet-facing rate limits.
6. Make search visibility-aware before enabling it publicly.
