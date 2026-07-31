# Stateful Memory — Extension Reference

The `stateful-memory` extension gives Pi persistent identity across sessions. It manages
persona injection, memory retrieval, entity observations, topic routing, and the sleep cycle.

## How It Works

### System Prompt Assembly

On every turn (`before_agent_start`), the extension builds the system prompt addon:

1. **Persona** — SOUL.md + STYLE.md + REGISTER.md + SLEEP.md
2. **Current Context** — WAKE.md (orientation from last sleep cycle)
3. **Pinned Facts** — FACTS.md (foundational grounding)
4. **Entity Context** — Recent observations + entity awareness index (rendered on session start)
5. **Memory Context** — enrichment results from memstore (first message only)
6. **Topic Addenda** — 0–3 topic files selected by the topic router

### Memory Enrichment (First Message)

When the first user message arrives:

1. Check memstore queue depth — if save jobs are pending, ask whether to wait.
2. Search session transcripts and current observations with the user's prompt.
3. Select up to five session snippets, preferring trunk sessions while retaining a
   historical custom-delegate or sleep-fork result when useful, plus up to three
   concise observations. Current pi-subagents child sessions never enter memstore.
4. Enforce a 6000-byte aggregate budget and cache the result for the session.
5. Rebuild the first turn's prompt addon after retrieval so enrichment is available
   immediately rather than one turn late.

Enrichment never hydrates complete session transcripts. Session search snippets come
from FTS5's matching window; observation bodies are capped independently.

### Session Saves

These hooks apply to normal stateful-memory sessions and the dedicated sleep forks.
Pi-subagents children do not load this extension, so they never submit child
transcripts to memstore and do not expose `remember_session` or other memory tools.

On session close or switch, the full session transcript is normalized (tool calls
stripped, text extracted) and submitted to memstore via `proxy/submit_save`. This
returns instantly (~1ms) — memstore queues the job and processes it in the background.

The save flow:

1. Read session JSONL → extract user/assistant text blocks
2. Generate a slug title from keywords
3. Detect project tags from content and active topics
4. Mark sessions under Pi's `sessions/forks/` directory with the `fork` tag and depth 3;
   trunk sessions remain depth 2.
5. Submit to memstore proxy (body, title, origin, tags, depth).
6. Update recency index (`recent-sessions.json`).

The memstore save job processor extracts the session date from the `# Date:` header
in the transcript body and uses it as `created_at`. This means re-saving a resumed
session preserves the original date. `updated_at` reflects when the entry was last
written.

### Entity Observations (memstore)

The `remember` tool writes observations to memstore's `observations` table — a separate
FTS5-indexed table distinct from session transcripts. Each observation is associated with
an entity (person, project, decision, preference, environment, self).

On session start, the entity context is rendered from two sources:

- **Recent observations** — six current observations, capped at two per entity so one
  active project cannot consume the section, with bodies truncated to ~150 chars
- **Entity awareness** — a compact listing of all known entities from `entity-index.json`,
  showing name, type, count, and last observation date

The `entity-index.json` file is a local cache maintained by the remember tool. If lost,
it can be rebuilt from memstore. It lives at `~/.pi/stateful-memory/entity-index.json`.

## Configuration

Config is loaded from `~/.pi/agent/stateful-memory.json` with defaults from `config.js`.

### Key config values

| Key | Description |
|---|---|
| `personaFile` | Primary persona file (SOUL.md) |
| `auxiliaryPersonaFiles` | Additional persona files (STYLE.md, REGISTER.md, SLEEP.md) |
| `factsFile` | Pinned facts (FACTS.md) |
| `wakeFile` | Orientation context (WAKE.md) |
| `observationsFile` | Entity context render (OBSERVATIONS.md) |
| `dreamsDir` | Dream journal directory |
| `topicsFile` | Topic index (PERSONALITY_MATRIX.md) |
| `memstoreSocketPath` | Unix socket for memstore (default: `$XDG_RUNTIME_DIR/memstore.sock`) |
| `recallSessionResults` | Session snippets returned by recall/enrichment (default 5) |
| `recallObservationResults` | Observation results returned by recall/enrichment (default 3) |
| `recallSearchMaxBytes` | Aggregate compact `recall` result budget (default 10000 bytes) |
| `recallMaxSessionChars` | Default bounded `recall_session` excerpt (default 8000 characters; hard max 12000) |
| `enrichmentMaxBytes` | Aggregate first-message enrichment budget (default 6000 bytes) |

### Path resolution

Config keys from the global config file resolve relative to `~/.pi/agent/`. Use absolute
paths to avoid cwd-relative surprises. The `PATH_KEYS` array in `config.js` controls
which keys get path-resolved.

## Tools

### `recall` — Search memory

Searches memstore and returns progressive, bounded results:

- Up to five ranked session snippets with entry IDs, dates, tags, and legacy
  fork/delegate labeling. If enough trunk matches exist, at most one such result is
  shown; historical delegates and sleep forks fill remaining slots when they contain
  the only useful matches.
- Up to three current observations with observation IDs, entity metadata, and dates.
- A 10000-byte aggregate ceiling across both result sections.

Complete transcripts are never returned by `recall`. Pass a returned session ID to
`recall_session`. Set `include_historical_observations` only when superseded or retracted
facts are relevant. The compatibility option `include_all_delegate_sessions` includes
all historical custom-delegate and fork memories for exhaustive research, bypassing the
normal diversity rule; it does not expose current pi-subagents child sessions.

### `recall_session` — Inspect one session

Returns query-relevant transcript windows under an 8000-character default and
12000-character hard maximum. Results include source character ranges and a continuation
offset. Without a query, the tool pages through the transcript from the requested offset.
The explicit `full` flag pages raw transcript content instead of matching windows, but each
call remains capped at 45KB—below Pi's 50KB custom-tool ceiling—and returns an offset when
more remains.

### `remember` — Store observations

Writes observations to memstore's observations table. Each observation is stored as a
separate FTS5-indexed entry with entity_type and entity_name. The local entity-index.json
is updated after each write. Entity type mapping: `person` → `sophont`. Default entity
names: person→Neon, self→Monika, environment→stanza, preference→Neon.

### `correct_observation` / `retract_observation` — Observation lifecycle

Corrections and retractions are append-only:

- `correct_observation` writes a replacement observation and a `superseded_by` edge from
  the old observation ID.
- `retract_observation` writes a `retracted` lifecycle edge without deleting the original.
- Current searches and entity context exclude observations with lifecycle edges. The
  rendered context is refreshed immediately after remember/correct/retract operations,
  and cached enrichment is cleared after corrections or retractions.
- Historical recall can include both the original and its replacement/retraction status.

Supersession is always explicit. The system does not guess that similarly worded facts
conflict, because an incorrect automatic supersession would silently hide valid memory.

### `remember_session` — Manual session save

Triggers an immediate session save to memstore (same as the automatic save on session close).

### `list_topics` / `load_topic` — Topic management

List available topic addenda or load a specific topic's full content.

## Topic Router

Topics are domain-specific addenda in `persona_topics/`. Each has triggers (keyword arrays)
defined in `PERSONALITY_MATRIX.md`. On each turn, the router scores topics against the
combined query (current user message + previous assistant message), selects the top 3
above a minimum score, and appends their content to the system prompt.

Topics persist across turns via a counter system. A freshly-selected topic gets a counter
of 3; each turn where it's not re-selected, the counter decrements. When it hits 0, the
topic drops. This prevents topics from vanishing after a single short reply that doesn't
restate the keywords.

## Child Context Boundaries

Pi-subagents is intentionally outside the normal stateful-memory lifecycle.
`subagents.defaultExtensions` is `[]`, and Monika's agent profiles opt into one of
two child-only prompt seams with no memory-mutation APIs, session saves, or sleep hooks:

- `specialist-child-context.js` selects up to three topic addenda from the current
  delegated task. It does not load persona, WAKE.md, FACTS.md, observations, or
  memstore context.
- `monika-child-context.js` is used only by the explicit `monika-delegate` profile.
  It loads the stable SOUL.md, STYLE.md, and REGISTER.md persona trio plus routed
  topic addenda, then registers bounded read-only `recall` and `recall_session`
  through `readonly-recall.js`. It does not inject WAKE.md, FACTS.md, observations,
  or recent sessions ambiently; relevant continuity must be supplied or deliberately
  retrieved.

Both seams restore bounded child-local auto-compaction because automatic compaction
is globally disabled for parent sessions. A forum topic may opt its canonical parent
runtime into Pi-native automatic compaction through an isolated agentd settings
overlay; that topic policy never propagates to children. Child compaction preserves
only task and validation state;
it does not add persistence. Fresh and fork-context child sessions are written
beneath `/app/.pi/agent/sessions/subagent/`, omitted from ongoing forum sync and
the standalone historical importer, and never saved to memstore. Useful outputs
return through the canonical parent transcript and enter
normal memory processing there; the parent remains the only authority that can
create or change durable observations through the memory API. This is not an OS
sandbox: shell-capable profiles retain runtime permissions and are explicitly
instructed not to bypass the boundary.

## Sleep Cycle

`/sleep` remains separate from pi-subagents and runs three sequential fork sessions:

1. **WAKE.md** — reads recent sessions and entity context via `recall`, writes orientation
2. **FACTS.md** — reads entity context and current FACTS.md, curates pinned facts
3. **Dreams** — reflective writing with proposed topic addenda changes

Each sleep fork is a full `createAgentSession()` with stateful-memory and the complete
persona. The sleep runner is local to `memory-sleep.js`; it does not call pi-subagents.
Forks use a retry system with model fallback (default model → Sonnet → others). Fork
sessions are written to `sessions/forks/`, and shutdown triggers a session save to
memstore.

## File Layout

```
~/.pi/agent/extensions/stateful-memory/
  extension.js          Main extension (event handlers, tools, commands)
  memstore-client.js    MemstoreClient — Unix socket JSON-RPC client
  config.js             Config loading and path resolution
  memory-store.js       File operations (persona, facts, entity context, recency index)
  memory-prompt.js      System prompt section builders
  memory-sleep.js       Sleep cycle orchestration and independent fork runner
  child-context.js      Shared routed-topic and stable-persona child prompt builders
  specialist-child-context.js  Topic-only pi-subagents child seam
  monika-child-context.js      Stable-persona pi-subagents child seam
  readonly-recall.js           Bounded child memory reads; no mutation or ingestion
  session-utils.js      JSONL parsing and transcript normalization
  topic-router.js       Topic scoring, selection, persistence, and addendum loading
  index.js              Package exports
```

## Backend Dependencies

- **memstore**: systemd user service on stanza. Socket at `$XDG_RUNTIME_DIR/memstore.sock`.
  Provides both session transcript storage (entries table) and entity observation storage
  (observations table), each with independent FTS5 indexes.
  See `/persist/shadowsea/services/stateful-memory/memstore/README.md`.
