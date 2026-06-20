# Route Access Matrix — Public-Facing Forum Audit

This matrix covers the routes reviewed in the initial public-facing audit. `Public-visible` means unauthenticated access is acceptable only for public forums/topics/posts.

| Route / surface | Current gate | Public exposure assessment | Notes |
|---|---:|---|---|
| `GET /forums` | optional auth + `canViewForum` filter | Acceptable | Filters public/members/admin forums by requester identity. |
| `GET /forums/:forumId/topics` | `requireForumVisible` | Acceptable | Public forums visible; members/admin forums hidden. |
| `GET /topics/:topicId` | `canViewTopic` | Acceptable | Returns 404 for non-visible topics. |
| `GET /topics/:topicId/posts` | `canViewTopic` | Acceptable for post bodies only | The route itself is fine; UI/API trace adjacency needs separate gating. |
| `GET /posts/recent` | optional auth + forum visibility filter | Acceptable | Filters recent posts by forum visibility. |
| `GET /leaders` | optional auth + include flags | Acceptable | Excludes members/admin forums for unauthenticated users. |
| `POST /forums/:forumId/topics` | `requireScope(write)` + `canCreateTopic` | Authenticated only | Trusted-user surface; can dispatch robot depending on robot mode. |
| `POST /topics/:topicId/posts` | `requireScope(write)` + `canPostTopic` | Authenticated only | Trusted-user surface; can dispatch robot depending on robot mode. |
| `POST /posts/:postId/dispatch` | `requireScope(write)` + post/topic checks | Authenticated only | Follow-up if untrusted non-agent accounts are introduced. |
| Robot control routes (`interrupt`, `close`, `continue`) | `requireScope(write)` + topic post permission | Authenticated only | Trusted-user surface; not exposed unauthenticated. |
| Auto-run management | admin via `canManageAutoRun` | Admin-only | Looks appropriately gated. |
| `GET /topics/:topicId/state` | `requireTopicVisible` only | **Finding F-02** | Public topics expose plan/tool/live state when detailed includes are requested. |
| `GET /topics/:topicId/state/stream` | `requireTopicVisible` only | **Finding F-02** | Public topics expose live trace events to unauthenticated readers. |
| Session inspector routes | `requireAdmin` | Admin-only | Powerful but not unauthenticated. |
| `GET /attachments/:attachmentId` | `requireTopicVisible` via containing post | Acceptable | Allows public attachments for public posts and blocks private topic attachments. |
| `GET /posts/:postId/attachments` | `requirePostVisible` | Acceptable | Visibility tied to containing post/topic. |
| Regular/chunked attachment upload | `requireScope(write)` + author + 5-min window | Authenticated only | Reasonable trusted-user gate. |
| User files | `requireScope(read/write)` + owner/moderator | Authenticated only | Not public. |
| `POST /agent/topics/:topicId/pending-attachments` | optional internal token | **Finding F-03** | Fails open when `CODEX_FORUM_INTERNAL_API_TOKEN` is unset. |
| `POST /auth/login` | public credential endpoint | Needs hardening | Rate limiting disabled in compose example. |
| `POST /auth/register` | auth feature enabled only | **Finding F-01** | Needs registration mode; currently allows public identity creation. |
| `GET /auth/verify/:token` | possession of token | Coupled to F-01 | One-time verification is expected, but public registration returns the URL. |
| API key / impersonation routes | `requireAdmin` | Admin-only | Impersonation tokens are blocked from token management. |
| `GET /search` | feature flag + post-filter visibility | Parking lot | Prepared statements; should push visibility into SQL before public enablement. |
| `GET /healthz` | none | **Finding F-04** | Exposes backend/deploy/build state. |
| `GET /deploy/quiescence` | none | **Finding F-04** | Exposes deploy blockers and robot state. |
| `GET /models` | none | **Finding F-04** | Exposes model catalog. |
| `GET /build` | none | Medium/accepted if minimized | Footer may need build label; avoid operational detail. |
| `GET /openapi.json`, `/postman/collection.json`, `/docs` | none | Usually acceptable | Consider whether public API docs are desired. |
