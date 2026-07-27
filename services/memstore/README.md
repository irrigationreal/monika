# Memstore

Memstore is the container-owned SQLite FTS5 backend for Monika's session transcripts and
entity observations. It exposes newline-delimited JSON-RPC over a Unix socket. The
stateful-memory Pi extension is its primary client.

## Data model

- `entries` stores normalized Pi session transcripts. `entries_fts` indexes title, body,
  and tags. Search returns metadata plus an FTS matching snippet; complete bodies require
  `memstore_show_entry`.
- `observations` stores concise entity-scoped statements. `observations_fts` indexes entity
  name, body, and entity type.
- `observation_relations` stores append-only lifecycle edges. A `superseded_by` edge points
  from an old observation to its replacement; a `retracted` edge has no replacement.
  Original observations are not edited or deleted by lifecycle operations.

Current observation search/list operations exclude observations with lifecycle edges.
Pass `include_historical: true` to inspect superseded or retracted history, including a
replacement ID or persisted retraction reason where applicable.

## Relevant tools

| Tool | Purpose |
|---|---|
| `memstore_search` | Rank session transcripts and return compact snippets |
| `memstore_show_entry` | Fetch one complete transcript by ID |
| `memstore_add_observation` | Add an observation; optional `supersedes_id` records a correction atomically |
| `memstore_search_observations` | Search current observations; optionally include history |
| `memstore_list_observations` | List current observations by recency/entity |
| `memstore_retract_observation` | Mark an observation non-current without deleting it |

`memstore_delete_observation` remains an administrative operation. It is not exposed as a
Pi memory tool, and foreign-key constraints prevent deleting observations participating in
lifecycle history.

## Development

```bash
nix-shell -p go gcc --run \
  'cd services/memstore && CGO_ENABLED=1 go test -tags fts5 ./...'
```

The schema is created with `CREATE TABLE IF NOT EXISTS`, so adding the lifecycle table is
an additive migration when an existing runtime starts the new binary.
