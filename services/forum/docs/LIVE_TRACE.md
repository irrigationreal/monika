# Live trace and saved trace architecture

This document owns the forum component's live and persisted trace pipeline.
The cross-service Pi/session projection contract lives in
[`../../../docs/forum.md`](../../../docs/forum.md).

### Trace visibility boundary

Topic visibility controls access to final conversation content. Trace visibility is a separate server-side policy because plans, reasoning, tool calls, commands, paths, usage metadata, and live assistant drafts are operational details, not public post content.

Current policy:

- Unauthenticated readers of public topics may see final posts and a neutral live placeholder only: "Response in progress…".
- Authenticated users may receive detailed live state and stream events for visible topics.
- Saved trace history remains behind the admin-only session inspector surface.

The `/topics/:topicId/state` route redacts unauthenticated responses to a minimal busy/idle shape and ignores `view=full` / `include=plan,toolRuns` for public readers. The `/topics/:topicId/state/stream` route filters SSE events per subscriber: public readers receive redacted `state` events and stripped `assistant_message` completion signals, while reasoning deltas, assistant deltas, tool events, and error details are suppressed. Do not rely on Vue-only hiding for trace secrecy.

### Pi agent loop event flow

A forum dispatch triggers a Pi agent loop that may span multiple LLM turns and
persist multiple channel-neutral outward utterances:

```
Turn 1: thinking → text → tool_call(s)
  ↓ tools execute
Turn 2: outward assistant item A → tool_call(s)
  ↓ tools execute
Turn N: outward assistant item B → Pi agent_settled → wire turn_completed
```

Each turn is one LLM call. Within a turn, the model produces thinking tokens,
visible text tokens, and tool-use blocks. An outward item is published only after
its canonical Pi message exists. It is not an aggregate of the loop's text.

**Important timing note:** For operations like "write a large file," the model
generates the file content during the **thinking phase** (which can take 10-30
seconds), then calls the Write tool which executes in **milliseconds**. The slow
part is thinking, not tool execution.

### SSE event pipeline

```
Pi SDK events → agentd (server.mjs) → echsBridge (forum server) → SSE bus → browser
```

Key events emitted to the browser SSE stream:

| Event               | Source                                         | Purpose                                                                         |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `state`             | echsBridge.emitState()                         | Full robot state snapshot including `recentToolRuns` (last 20)                  |
| `reasoning_delta`   | Pi thinking_delta → agentd → echsBridge        | Incremental reasoning/thinking text                                             |
| `assistant_delta`   | Pi text_delta → agentd turn_delta → echsBridge | Incremental visible assistant text                                              |
| `tool_started`      | echsBridge item_started handler                | Per-tool notification when a tool run is created                                |
| `assistant_reset`   | echsBridge.dispatchUserMessage()               | Start of new response (reason: `new_turn`) or interrupt (reason: `interrupted`) |
| `assistant_message` | canonical item projection completion           | One persisted outward utterance and its handoffs became a forum post            |

Agentd does not translate Pi's `agent_end` into a synthetic response. An agent run
may retry, compact and retry, emit several persisted outward items, or emit none.
Each canonical item is forwarded separately. Pi's internal `agent_settled` marks
the idle boundary and agentd maps it to wire `turn_completed`. The forum's shared
live/sync projection service applies the same outbound tamper, persona, parent/follow-up,
and attachment-handoff semantics before `assistant_message`, so a sync race cannot
publish raw content while live publishes transformed content.

### Live trace: append-only committed segments

The live trace uses an **append-only committed-segment model**. Once content is
rendered, it never moves — new content only appears at the tail.

**Data model (`useForumState.ts`):**

```typescript
type TraceSegment =
  | { kind: "reasoning"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool"; toolRunId: string };
```

`committedSegments` is an ordered array of frozen segments. `reasoningDraft` and
`assistantDraft` are the live tail — text currently being streamed that hasn't
been committed yet.

**Commit flow:**

1. Reasoning/assistant deltas arrive → buffered via `requestAnimationFrame` →
   flushed into `reasoningDraft`/`assistantDraft`.
2. `tool_started` SSE event fires → `flushPendingDeltas()` synchronously drains
   buffers → current `reasoningDraft` committed as a reasoning segment → current
   `assistantDraft` committed as a text segment → tool segment pushed → both
   drafts cleared (fresh start for next inter-tool gap).
3. Each `assistant_message` fires only after its canonical post/handoffs finalize.
   Any remaining tail text is flushed and the projected post takes over. The idle
   boundary separately clears activity; multiple canonical items can arrive before
   that boundary. Explicit subagent `follow_up` items carry their own parent and
   badge without relabelling an earlier ordinary item.

**Rendering (`liveTurnItems` computed in `TopicView.vue`):**

Iterates committed segments (stable, ordered) plus the pending tail drafts
(live, growing). For each tool segment, looks up the tool run from
`activityLog`. If the tool data hasn't arrived yet (race between `tool_started`
and `state`), renders a "Running tool…" placeholder.

`LiveAssistantTurn.vue` treats the current status item as pinned panel state and
renders only the latest 15 chronological live trace items beneath it. This is a
presentation-only cap: `committedSegments`, draft text, server checkpoints, and
saved Trace History remain complete. When a new chronological item arrives past
the cap, Vue transition classes fade the oldest visible item out at the top and
fade the newest item in at the bottom. Page refreshes during an active response
reconstruct the current state first, then immediately show the latest 15-item
window without inventing removal animations for cards the browser never saw.

### Interrupt handling

When the user clicks Stop:

1. `assistant_reset` fires with `reason: 'interrupted'`
2. Client flushes buffered deltas, freezes even a text-only draft tail, sets `interruptedTrace = true`, and stops accumulating new content
3. Committed and newly frozen text segments are preserved (not cleared)
4. The trace header changes to "■ Response stopped" / "STOPPED"
5. The frozen trace remains visible until the next response starts

### Saved trace: server-side checkpoints

The echsBridge stores checkpoint data for post-completion trace reconstruction:

- `ctx.reasoningSummary` accumulates all reasoning text server-side
- `ctx.assistantText` accumulates all assistant text server-side
- When each tool starts, both lengths are recorded as checkpoints
- `reasoning_checkpoints_json` is stored in the `plans` table (migration 29)
- `assistantCheckpoints` + `assistantText` are included in the SSE state response

**Saved rendering (`PostTracePanel.vue`):**

If `reasoningCheckpoints` is available from the session inspector API, the
component splits the raw plan text at checkpoint boundaries, parses each segment
with `parseReasoningSteps`, and interleaves with tools sorted by `startedAt`.
Falls back to a compact non-interleaved view when checkpoints are absent
(pre-existing data or imported sessions).

**Refresh resilience:** On page refresh or reconnect mid-response,
`reconstructSegmentsFromState()` rebuilds committed segments from server state
using the stored checkpoints and accumulated text. A successful Stop persists
`activity = 'stopped'`; hydration or SSE state therefore freezes the reconstructed
trace even if the client missed `assistant_reset`. Fresh accepted dispatch clears
that boundary with the normal new-turn reset. Reconstruction only runs while
`activity !== 'idle'` and there is current live content (`currentPlan` or live
assistant text), including explicit initial state loads. Server state treats
`activity = 'idle'` or `stopped` as an invariant that clears `current_plan_id`; queued/waiting
turns also start without inheriting the previous plan. This keeps stale completed
plans from resurrecting the live panel or appearing at the start of the next live
turn.

### `parseReasoningSteps` and markdown handling

The reasoning parser splits text on `**bold**` markers to identify step boundaries.
Only `**...**` at the **start of a line** (after newline + optional whitespace) is
treated as a step boundary. Inline bold like `- **Gold** as currency` is kept as
detail text within the current step, not split into a separate card.

Fallback title for untitled reasoning: "Thinking" (not "Activity").

### Critical footguns

**SSE event buffering:** `reasoning_delta` and `assistant_delta` are buffered
client-side via `requestAnimationFrame`. `tool_started` and `state` events
process synchronously. Always call `flushPendingDeltas()` before committing
segments or recording checkpoints.

**`recentToolRuns` batching:** The `state` event's `recentToolRuns` array
contains all recent tools (up to the last 20 from the DB), not incremental additions. Tool
segments must be committed from `tool_started` events (which fire per-tool in
real time), not by diffing `recentToolRuns`.

**`activityLog` mutations:** Use immutable array updates
(`activityLog.value = [...activityLog.value, item]`) not `.push()`. In-place
mutations may not trigger Vue computed re-evaluation reliably through
intermediate computed refs.

**`assistant_reset` scope:** Fires once per user message dispatch (`new_turn`)
or on interrupt (`interrupted`). Does NOT fire between Pi turns within the same
agent loop. A single forum reply spans multiple Pi turns.

**Tool name casing:** Pi sends capitalised names (`Bash`, `Read`, `Edit`). The
DB `tool` column is normalised lowercase (`exec`, `read`, `apply_patch`). The
`command` column preserves the original. Use `kind` for formatting branches and
lowercase names for sub-type checks.

**Timeout units:** Pi's Bash tool sends `timeout` in seconds. Other tools may
use `timeoutMs` (milliseconds). `extractTimeoutMs` handles both conventions.

**Clock skew:** `ToolElapsedTimer` uses client-relative timing (records
`Date.now()` at mount). No `liveTurnStartedAt` timestamp filter exists — the
append-only model handles turn boundaries via `assistant_reset`.

**Imported/synced sessions:** Sessions imported from Pi JSONL files won't have
reasoning checkpoints (nullable column). `PostTracePanel` falls back gracefully.

### Debugging the trace pipeline

When investigating trace rendering issues, the event pipeline has multiple
stages where data can be lost or misordered. Use these debug techniques:

**Server-side SSE capture:** Capture the raw SSE stream to see what events the
server actually sends:

```bash
curl -sS -c /tmp/forum.cookies -H 'content-type: application/json' \
  -d '{"username":"admin","password":"..."}' .../api/auth/login
timeout 30 curl -sN -b /tmp/forum.cookies ".../api/topics/$TOPIC/state/stream" | grep '^event:'
```

Verify `tool_started` events appear between `state` events, and that
`assistant_delta` bursts arrive between tool events.

**Client-side console logging:** Add temporary `console.warn` in:

- `syncToolActivity` — verify tools are added/updated in `activityLog`
- `tool_started` handler — verify segments are committed
- `liveTurnItems` computed — verify items are produced (log count + types)
- `LiveAssistantTurn` component — verify props are received (use a `watch`)
- `resetRobotActivity` — add `new Error().stack` to identify the caller

**Common patterns:**

- Items produced but not rendered → Vue reactivity issue (check immutable updates)
- `tool_started` not firing → SSE stream not connected or wrong topic
- Tools "updated" but never "added NEW" → tools already in `activityLog` from
  initial `loadState`, or `recentToolRuns` includes old tools
- Segments cleared mid-response → unexpected `resetRobotActivity` call (check
  stack trace to find caller: `assistant_reset`, plan-ID transition, or
  `handleAssistantMessage`)
