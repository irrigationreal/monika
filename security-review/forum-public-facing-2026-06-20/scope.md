# Public-Facing vMonika Forum Security Audit Scope

Requested from forum topic `fb7aa1eb-ec6f-47ff-b931-9e942f4c9c49`, post `128e9e89-3b66-487a-852e-658f7f8ce043`.

Threat model:
- Forum will become internet-facing, likely through Cloudflare Tunnel.
- Only the forum service should be exposed. agentd/monika backend must not be exposed directly.
- Unauthenticated users may read only public forums/topics/posts and attachments belonging to public content.
- Unauthenticated users must not see members-only/admin-only forums/topics/posts, private attachments, saved trace history, or live trace details.
- Public registration should be disabled for launch. Desired future shape: registration mode env var with disabled/invite-only/public.
- Authenticated users are trusted initially, but auth/admin functionality must not be accidentally reachable by unauthenticated users.
- Search should eventually be enabled for all users and must filter to public-visible content for unauthenticated users.
- Operational hardening should prioritize low-friction easy wins: rate limits for auth, minimal public health/build metadata, no reliance on Turnstile as core control.

Review priorities:
1. Auth bypass / unauthenticated access to authenticated functionality.
2. Broken access controls for private/members/admin content and trace history.
3. SQL/SQLite injection reachable without auth, especially search.
4. Stored XSS reachable through public content or future public search.
5. Attachment/file path traversal and private attachment leakage.
6. Agent runtime safety: public users must not trigger tools or inspect operational trace.
