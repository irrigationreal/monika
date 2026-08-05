# Monika-specific forum behavior

This document owns forum-component behavior that is specific to the Monika deployment.
Cross-service canonical-session and agentd integration contracts live in
[`../../../docs/forum.md`](../../../docs/forum.md).

## Homepage snapshot freshness

The Vue forum state is module-scoped and survives client-side route changes. The
homepage therefore refreshes its active forums, archived forums, and three recent
posts on every route entry instead of treating non-empty arrays as permanently
fresh caches. Existing values remain rendered while their replacements load.
Each loader uses latest-request-wins assignment so an older overlapping response
cannot replace a newer snapshot.

This is deliberately route-entry refresh rather than polling or a homepage SSE
subscription. It bounds network and listener lifetimes to ordinary navigation,
while migration 34's partial `idx_posts_recent_created_at` index keeps the global
undeleted-post recency query efficient as post history grows.

## Provenance

The forum service lives at `services/forum`. It was imported from the archived
Monika-specific forum repository after PR https://github.com/irrigationreal/monika-forum/pull/1,
merge commit `bba058013b1a59d295373f949f4d4f25100e174b`.

That repository repurposed the Irrigate Collective Codex Forum project as the
Monika frontend. Upstream project: https://github.com/irrigationreal/codex-forum

Future development should happen in this repository. The old `monika-forum`
repository is retained as historical provenance.
