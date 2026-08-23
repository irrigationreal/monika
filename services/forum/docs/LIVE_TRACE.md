# Canonical topic Trace architecture

This document owns the forum's live and persisted reasoning/tool projection. The cross-service Pi/session contract lives
in [`../../../docs/forum.md`](../../../docs/forum.md).

## Product surface

The forum exposes one trace visualization: the admin-only topic **Trace**.

- During an active response, the draft-post position shows admins the latest three chronological reasoning/tool cards
  from that response and a spinning activity indicator beside the current state once cards are available. Before the
  first card, only the existing “Starting response…” spinner is shown. **Open Trace** opens the complete session trace
  newest-first by default and offers a temporary oldest-first view; **Stop Robot** uses the shared destructive-action
  confirmation.
- Guests and authenticated non-admins see only a neutral “Response in progress…” placeholder.
- Completed posts contain conversation content only. There is no per-post Trace History.
- Trace remains available while idle from Admin Tools.
- Trace, Session Diagnostics, and Auto-Director share one fixed, non-modal Admin Workspace. Session Diagnostics combines
  robot activity/context controls with canonical session metadata, and the solid themed workspace stays beneath a docked
  Quick Reply so steering remains usable.

`TopicTraceViewer.vue` is the canonical renderer for both preview and workspace modes. Preview mode only selects the
active response's three-card tail and always presents those cards chronologically. The complete workspace applies its
selected display direction without changing the canonical chronological trace model or maintaining a second card
implementation.

## Authorization boundary

Topic visibility and trace visibility are separate policies. `GET /topics/:topicId/state`, its SSE stream, and
`GET /topics/:topicId/trace` enforce trace authorization server-side.

Only admins receive plans, reasoning, tool calls, commands, paths, live assistant drafts, raw error details,
usage/context, and stream diagnostics. Every non-admin—including an authenticated member—receives a minimal busy/idle
state and stripped completion/reset signals sufficient to show and dismiss the neutral placeholder.

The dedicated admin trace endpoint returns complete persisted plans and tool runs without querying or transporting
session messages. The legacy session inspector endpoint remains available for API compatibility but no longer drives the
topic UI.

## Event flow

```text
Pi SDK events → agentd → echsBridge → forum StreamBus → browser
```

Important browser events:

| Event               | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `state`             | Robot snapshot, current plan, recent tool snapshots, context |
| `reasoning_delta`   | Buffered live reasoning text                                 |
| `tool_started`      | Per-tool ordering boundary                                   |
| `assistant_reset`   | New dispatch or interruption boundary                        |
| `assistant_message` | One canonical outward item has been projected                |

`assistant_message` is not the idle boundary. One settled agent loop may project several outward items. The later
`state` emitted from wire `turn_completed` determines idle state.

Topic navigation is an ownership boundary for browser state. The shared forum store clears the previous topic's posts,
robot state, context, trace, attachments, and enrichment before fetching the destination record, leaving a neutral
“Loading topic…” shell until that record is selected. Each topic selection and EventSource has a monotonic generation;
topic-hydration completions, stream callbacks, reconnect timers, and assistant-message reloads commit only while both
their captured topic and generation remain current. Robot-state hydration also captures the live-state revision, so an
HTTP snapshot cannot overwrite a newer event from the active stream. Reconnect waits for the replacement subscription's
open boundary before starting reconciliation hydration; replacement events invalidate that older snapshot. Closing an
EventSource is not treated as sufficient cancellation because an event may already be queued by the browser. This
transition is local and does not add another hydration request or stream—the destination uses the same request sequence
as ordinary topic selection.

## Append-only live ordering

The browser maintains frozen committed segments plus a live reasoning tail:

```typescript
type TraceSegment = { kind: 'reasoning'; text: string } | { kind: 'tool'; toolRunId: string };
```

Reasoning deltas are buffered through `requestAnimationFrame`. When `tool_started` arrives synchronously,
`flushPendingDeltas()` must run before committing the current reasoning and tool boundary. Once committed, a segment
never moves; new work is appended.

`recentToolRuns` is a batched state snapshot, not an incremental event stream. Never infer tool ordering by diffing it.
Tool segment order comes from `tool_started`; snapshot tools supply the card data.

Refresh during an active response reconstructs committed segments from the current plan, checkpoints, accumulated text,
and tools. A durable stopped state freezes the reconstructed trace even if the browser missed the interruption event.

## Persisted trace

The bridge stores:

- complete plan reasoning;
- character-offset reasoning checkpoints at tool starts;
- complete session tool rows with bounded/redacted summaries.

`buildPersistedTraceItems()` splits reasoning at checkpoints and interleaves tools deterministically. Nullable
checkpoints are expected for old or imported sessions; fallback rendering places parsed reasoning before chronologically
ordered tools.

The canonical trace model remains chronological within each response. The full workspace defaults to a globally
newest-first display: newest response first and newest card first within each response. Its **Order** control can
reverse both levels to oldest-first for the lifetime of the open Trace view. The direction is deliberately not
persisted, so closing and reopening Trace or navigating to another topic restores the operational newest-first default.

The active preview is independent of that temporary workspace direction. It takes only the final three cards from the
active response, presents them chronologically, and never fills empty slots with stale cards from an earlier response.
The “Starting response…” spinner is the only spinner before cards exist. When the first trace card replaces that state,
the header spinner takes over and remains mounted for the rest of the active preview.

## Reasoning and tool presentation

Reasoning is visible by default in the full workspace. Its preference is stored under
`codex-forum:trace:show-reasoning`, with a fallback read of the former Tool Usage preference key. The active preview
always includes reasoning because it must remain informative before the first tool starts.

Reasoning detail is sanitized Markdown. `parseReasoningSteps()` recognizes bold headings only at line starts; inline
bold text is not a step boundary.

Tool output remains a bounded, redacted summary. The browser cannot expand beyond what the bridge persisted. Formatting
branches use normalized tool kinds rather than raw, inconsistently cased tool names.

## Admin Workspace behavior

The workspace is fixed and independently scrollable, but deliberately not a modal: Quick Reply/Steer remains interactive
above it. Opening moves focus to the workspace; Escape or Close dismisses it and returns focus to the launcher. Its
bottom inset tracks expanded and collapsed dock heights through `--quick-reply-dock-height`.

Stop Robot remains a two-step destructive operation. Every Stop entry point invokes the existing `requestStopRobot()`
confirmation and never interrupts directly.

## Invariants to preserve

1. Admin enrichment never blocks base topic selection, Quick Reply readiness, or SSE startup.
2. Non-admin state and SSE payloads contain no trace details.
3. Preview capping never truncates source state or persisted history.
4. Interruption preserves buffered reasoning before clearing drafts; delayed projection completion and hydration cannot
   erase the newer frozen boundary.
5. Idle state cannot retain a live current plan.
6. Completion reloads cannot resurrect stale trace state.
7. Topic navigation clears the outgoing projection before destination hydration, and stale HTTP/SSE generations cannot
   mutate a later selection—even after navigating away and back to the same topic ID.
8. Equal tool timestamps use deterministic storage ordering.
9. One renderer and one canonical chronological ordering model serve preview and complete Trace; workspace direction is
   an immutable presentation projection only.

## Tests

Coverage belongs in:

- `packages/server/src/routes/robotRoutes.access.test.ts` for admin/non-admin state and trace projection access;
- `apps/codex-forum/src/lib/unifiedTrace.test.ts` for live/persisted ordering and checkpoint fallback;
- `apps/codex-forum/src/views/TopicView.traceWorkspace.test.ts` for canonical surface and dead-implementation removal;
- `apps/codex-forum/src/views/TopicView.quickReplyDock.test.ts` for non-blocking admin enrichment;
- `apps/codex-forum/src/composables/useForumState.topic-selection.test.ts` and
  `useForumState.topic-stream-isolation.test.ts` for navigation reset, request-generation, and EventSource isolation;
- Robot UI Playwright coverage for mobile containment, fixed chronological preview ordering, temporary workspace
  direction, workspace tabs, focus, and confirmed Stop behavior.
