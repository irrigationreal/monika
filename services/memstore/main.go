// memstore is a SQLite FTS5-backed memory store with Unix socket multiplexer.
// It replaces the tagmem-proxy by handling all operations directly against SQLite
// instead of proxying to a subprocess.
//
// Build with: CGO_ENABLED=1 go build -tags fts5 -o memstore .
package main

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode"

	_ "github.com/mattn/go-sqlite3"
)

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

type rpcMessage struct {
	raw    json.RawMessage
	parsed map[string]json.RawMessage
}

func parseMessage(line []byte) (*rpcMessage, error) {
	m := &rpcMessage{raw: append(json.RawMessage{}, line...)}
	if err := json.Unmarshal(line, &m.parsed); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *rpcMessage) id() json.RawMessage { return m.parsed["id"] }

func (m *rpcMessage) method() string {
	raw, ok := m.parsed["method"]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func (m *rpcMessage) params() json.RawMessage {
	return m.parsed["params"]
}

// ---------------------------------------------------------------------------
// Save job
// ---------------------------------------------------------------------------

type saveJob struct {
	ID            string   `json:"id"`
	Body          string   `json:"body"`
	Origin        string   `json:"origin"`
	Tags          []string `json:"tags"`
	Title         string   `json:"title"`
	Depth         int      `json:"depth"`
	Status        string   `json:"status"`
	Error         string   `json:"error,omitempty"`
	ResultEntryID int      `json:"result_entry_id,omitempty"`
}

// ---------------------------------------------------------------------------
// Stopwords
// ---------------------------------------------------------------------------

var stopwords = map[string]bool{
	"a": true, "an": true, "the": true, "is": true, "are": true,
	"was": true, "were": true, "be": true, "been": true, "being": true,
	"have": true, "has": true, "had": true, "do": true, "does": true,
	"did": true, "will": true, "would": true, "shall": true, "should": true,
	"may": true, "might": true, "must": true, "can": true, "could": true,
	"of": true, "in": true, "to": true, "for": true, "on": true,
	"with": true, "at": true, "by": true, "from": true, "as": true,
	"into": true, "through": true, "during": true, "before": true,
	"after": true, "above": true, "below": true, "between": true,
	"out": true, "off": true, "over": true, "under": true, "again": true,
	"further": true, "then": true, "once": true, "here": true, "there": true,
	"when": true, "where": true, "why": true, "how": true, "all": true,
	"both": true, "each": true, "few": true, "more": true, "most": true,
	"other": true, "some": true, "such": true, "no": true, "nor": true,
	"not": true, "only": true, "own": true, "same": true, "so": true,
	"than": true, "too": true, "very": true, "just": true, "about": true,
	"also": true, "and": true, "but": true, "or": true, "if": true,
	"it": true, "its": true, "this": true, "that": true, "these": true,
	"those": true, "i": true, "me": true, "my": true, "we": true,
	"our": true, "you": true, "your": true, "he": true, "she": true,
	"they": true, "them": true, "him": true, "her": true, "his": true,
	"what": true, "which": true, "who": true, "whom": true, "up": true,
	"hey": true, "let": true, "us": true, "am": true,
}

// preprocessQuery tokenizes a natural language query for FTS5.
// Returns the FTS5 query string and a boolean indicating if the query is valid.
func preprocessQuery(query string) (string, bool) {
	// Tokenize: split on whitespace and punctuation
	tokens := tokenize(query)

	// Remove stopwords
	var filtered []string
	for _, t := range tokens {
		lower := strings.ToLower(t)
		if !stopwords[lower] && len(lower) > 0 {
			filtered = append(filtered, lower)
		}
	}

	if len(filtered) == 0 {
		return "", false
	}

	return strings.Join(filtered, " OR "), true
}

func tokenize(s string) []string {
	var tokens []string
	var current strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
			current.WriteRune(r)
		} else {
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
		}
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

// ---------------------------------------------------------------------------
// Proxy (server)
// ---------------------------------------------------------------------------

type proxy struct {
	sockPath string
	dataDir  string
	db       *sql.DB
	dbMu     sync.Mutex // serializes writes

	clientSeq atomic.Uint64

	// Save job queue
	saveQueue       []*saveJob
	saveMu          sync.Mutex
	saveNotify      chan struct{}
	processingSave  bool
	currentSaveJob  *saveJob
	saveProcessorWg sync.WaitGroup
	shutdownOnce    sync.Once

	// Origin map
	originMap   map[string]int
	originMapMu sync.Mutex

	done chan struct{}
}

func newProxy(sockPath, dataDir string) *proxy {
	return &proxy{
		sockPath:   sockPath,
		dataDir:    dataDir,
		saveNotify: make(chan struct{}, 1),
		originMap:  make(map[string]int),
		done:       make(chan struct{}),
	}
}

// ---------------------------------------------------------------------------
// SQLite setup
// ---------------------------------------------------------------------------

func (p *proxy) openDB() error {
	dbPath := filepath.Join(p.dataDir, "memory.db")
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_synchronous=NORMAL&_cache_size=-8000&_foreign_keys=ON")
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	p.db = db

	// Create schema
	schema := `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  depth INTEGER NOT NULL DEFAULT 2,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  origin TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body, tags,
  content=entries, content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

CREATE INDEX IF NOT EXISTS idx_entries_origin ON entries(origin);
CREATE INDEX IF NOT EXISTS idx_entries_depth ON entries(depth);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);

-- Observations table: structured entity observations (separate from session transcripts)
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  entity_name, body, entity_type,
  content=observations, content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, entity_name, body, entity_type) VALUES (new.id, new.entity_name, new.body, new.entity_type);
END;
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, entity_name, body, entity_type) VALUES ('delete', old.id, old.entity_name, old.body, old.entity_type);
END;
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, entity_name, body, entity_type) VALUES ('delete', old.id, old.entity_name, old.body, old.entity_type);
  INSERT INTO observations_fts(rowid, entity_name, body, entity_type) VALUES (new.id, new.entity_name, new.body, new.entity_type);
END;

CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_type, entity_name);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);

-- Append-only lifecycle edges. Original observations remain immutable; current
-- views exclude observations with a superseded_by or retracted edge.
CREATE TABLE IF NOT EXISTS observation_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE RESTRICT,
  target_observation_id INTEGER REFERENCES observations(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('superseded_by', 'retracted')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (relation_type = 'superseded_by' AND target_observation_id IS NOT NULL) OR
    (relation_type = 'retracted' AND target_observation_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_relations_source
  ON observation_relations(source_observation_id);
CREATE INDEX IF NOT EXISTS idx_observation_relations_target
  ON observation_relations(target_observation_id);
`
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}

	return nil
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

func (p *proxy) handleToolCall(name string, args json.RawMessage) (any, error) {
	switch name {
	case "memstore_search":
		return p.toolSearch(args)
	case "memstore_show_entry":
		return p.toolShowEntry(args)
	case "memstore_add_entry":
		return p.toolAddEntry(args)
	case "memstore_delete_entry":
		return p.toolDeleteEntry(args)
	case "memstore_status":
		return p.toolStatus()
	case "memstore_list_entries":
		return p.toolListEntries(args)
	case "memstore_add_observation":
		return p.toolAddObservation(args)
	case "memstore_search_observations":
		return p.toolSearchObservations(args)
	case "memstore_list_observations":
		return p.toolListObservations(args)
	case "memstore_delete_observation":
		return p.toolDeleteObservation(args)
	case "memstore_retract_observation":
		return p.toolRetractObservation(args)
	default:
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
}

func (p *proxy) toolSearch(args json.RawMessage) (any, error) {
	var params struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
		Depth *int   `json:"depth"`
		Tag   string `json:"tag"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.Query == "" {
		return nil, fmt.Errorf("query is required")
	}
	if params.Limit <= 0 {
		params.Limit = 10
	}

	ftsQuery, queryValid := preprocessQuery(params.Query)
	if !queryValid {
		// All tokens were stopwords — return empty results
		return map[string]any{"entries": []any{}}, nil
	}

	// Build query dynamically
	querySQL := `SELECT e.id, e.depth, e.title, e.origin, e.tags, e.created_at,
       bm25(entries_fts, 1.0, 5.0, 0.5) AS score,
       snippet(entries_fts, 1, '', '', '...', 40) AS snippet
FROM entries_fts
JOIN entries e ON e.id = entries_fts.rowid
WHERE entries_fts MATCH ?`

	queryArgs := []any{ftsQuery}

	if params.Depth != nil {
		querySQL += " AND e.depth <= ?"
		queryArgs = append(queryArgs, *params.Depth)
	}
	if params.Tag != "" {
		querySQL += ` AND EXISTS (SELECT 1 FROM json_each(e.tags) WHERE json_each.value = ?)`
		queryArgs = append(queryArgs, params.Tag)
	}

	querySQL += " ORDER BY score LIMIT ?"
	queryArgs = append(queryArgs, params.Limit)

	rows, err := p.db.Query(querySQL, queryArgs...)
	if err != nil {
		// FTS5 MATCH can fail on empty or invalid queries
		if strings.Contains(err.Error(), "fts5") {
			return map[string]any{"entries": []any{}}, nil
		}
		return nil, fmt.Errorf("search query: %w", err)
	}
	defer rows.Close()

	var entries []map[string]any
	for rows.Next() {
		var (
			id        int
			depth     int
			title     string
			origin    sql.NullString
			tagsJSON  string
			createdAt string
			score     float64
			snippet   string
		)
		if err := rows.Scan(&id, &depth, &title, &origin, &tagsJSON, &createdAt, &score, &snippet); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		var tags []string
		_ = json.Unmarshal([]byte(tagsJSON), &tags)
		if tags == nil {
			tags = []string{}
		}

		entry := map[string]any{
			"id":         id,
			"depth":      depth,
			"title":      title,
			"score":      score,
			"snippet":    snippet,
			"tags":       tags,
			"created_at": createdAt,
		}
		if origin.Valid {
			entry["origin"] = origin.String
		}
		entries = append(entries, entry)
	}
	if entries == nil {
		entries = []map[string]any{}
	}

	return map[string]any{"entries": entries}, nil
}

func (p *proxy) toolShowEntry(args json.RawMessage) (any, error) {
	var params struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.ID <= 0 {
		return nil, fmt.Errorf("id is required")
	}

	var (
		id        int
		depth     int
		title     string
		body      string
		origin    sql.NullString
		tagsJSON  string
		createdAt string
		updatedAt string
	)
	err := p.db.QueryRow(
		"SELECT id, depth, title, body, origin, tags, created_at, updated_at FROM entries WHERE id = ?",
		params.ID,
	).Scan(&id, &depth, &title, &body, &origin, &tagsJSON, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("entry %d not found", params.ID)
	}
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}

	var tags []string
	_ = json.Unmarshal([]byte(tagsJSON), &tags)
	if tags == nil {
		tags = []string{}
	}

	entry := map[string]any{
		"id":         id,
		"depth":      depth,
		"title":      title,
		"body":       body,
		"tags":       tags,
		"created_at": createdAt,
		"updated_at": updatedAt,
	}
	if origin.Valid {
		entry["origin"] = origin.String
	}

	return map[string]any{"entry": entry}, nil
}

func (p *proxy) toolAddEntry(args json.RawMessage) (any, error) {
	var params struct {
		Body      string   `json:"body"`
		Title     string   `json:"title"`
		Depth     *int     `json:"depth"`
		Tags      []string `json:"tags"`
		Origin    string   `json:"origin"`
		CreatedAt string   `json:"created_at"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.Body == "" {
		return nil, fmt.Errorf("body is required")
	}

	depth := 2
	if params.Depth != nil {
		depth = *params.Depth
	}
	if params.Tags == nil {
		params.Tags = []string{}
	}
	tagsJSON, _ := json.Marshal(params.Tags)

	p.dbMu.Lock()
	var result sql.Result
	var err error
	if params.CreatedAt != "" {
		result, err = p.db.Exec(
			"INSERT INTO entries (depth, title, body, origin, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			depth, params.Title, params.Body, nullString(params.Origin), string(tagsJSON), params.CreatedAt, params.CreatedAt,
		)
	} else {
		result, err = p.db.Exec(
			"INSERT INTO entries (depth, title, body, origin, tags) VALUES (?, ?, ?, ?, ?)",
			depth, params.Title, params.Body, nullString(params.Origin), string(tagsJSON),
		)
	}
	p.dbMu.Unlock()

	if err != nil {
		return nil, fmt.Errorf("insert: %w", err)
	}

	newID, _ := result.LastInsertId()
	return map[string]any{
		"entry": map[string]any{
			"id":    int(newID),
			"depth": depth,
			"title": params.Title,
		},
	}, nil
}

func (p *proxy) toolDeleteEntry(args json.RawMessage) (any, error) {
	var params struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.ID <= 0 {
		return nil, fmt.Errorf("id is required")
	}

	p.dbMu.Lock()
	result, err := p.db.Exec("DELETE FROM entries WHERE id = ?", params.ID)
	p.dbMu.Unlock()

	if err != nil {
		return nil, fmt.Errorf("delete: %w", err)
	}

	affected, _ := result.RowsAffected()
	return map[string]any{
		"deleted": affected > 0,
		"id":      params.ID,
	}, nil
}

func (p *proxy) toolStatus() (any, error) {
	var total int
	p.db.QueryRow("SELECT COUNT(*) FROM entries").Scan(&total)

	// By depth
	byDepth := map[string]int{}
	rows, err := p.db.Query("SELECT depth, COUNT(*) FROM entries GROUP BY depth")
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var d, c int
			rows.Scan(&d, &c)
			byDepth[fmt.Sprintf("%d", d)] = c
		}
	}

	// By tag — aggregate in Go
	byTag := map[string]int{}
	tagRows, err := p.db.Query("SELECT tags FROM entries")
	if err == nil {
		defer tagRows.Close()
		for tagRows.Next() {
			var tagsJSON string
			tagRows.Scan(&tagsJSON)
			var tags []string
			if json.Unmarshal([]byte(tagsJSON), &tags) == nil {
				for _, t := range tags {
					byTag[t]++
				}
			}
		}
	}

	// DB size
	dbPath := filepath.Join(p.dataDir, "memory.db")
	var dbSize int64
	if fi, err := os.Stat(dbPath); err == nil {
		dbSize = fi.Size()
	}

	// Observation stats
	var totalObs int
	p.db.QueryRow("SELECT COUNT(*) FROM observations").Scan(&totalObs)

	obsByType := map[string]int{}
	obsTypeRows, err := p.db.Query("SELECT entity_type, COUNT(*) FROM observations GROUP BY entity_type")
	if err == nil {
		defer obsTypeRows.Close()
		for obsTypeRows.Next() {
			var t string
			var c int
			obsTypeRows.Scan(&t, &c)
			obsByType[t] = c
		}
	}

	obsByEntity := map[string]int{}
	obsEntRows, err := p.db.Query("SELECT entity_name, COUNT(*) FROM observations GROUP BY entity_name")
	if err == nil {
		defer obsEntRows.Close()
		for obsEntRows.Next() {
			var n string
			var c int
			obsEntRows.Scan(&n, &c)
			obsByEntity[n] = c
		}
	}

	return map[string]any{
		"total_entries":          total,
		"by_depth":               byDepth,
		"by_tag":                 byTag,
		"db_size_bytes":          dbSize,
		"save_queue":             p.saveStatus(),
		"total_observations":     totalObs,
		"observations_by_type":   obsByType,
		"observations_by_entity": obsByEntity,
	}, nil
}

func (p *proxy) toolListEntries(args json.RawMessage) (any, error) {
	var params struct {
		Depth *int   `json:"depth"`
		Tag   string `json:"tag"`
		Limit int    `json:"limit"`
	}
	if args != nil {
		_ = json.Unmarshal(args, &params)
	}
	if params.Limit <= 0 {
		params.Limit = 50
	}

	querySQL := "SELECT id, depth, title, origin, tags, created_at FROM entries WHERE 1=1"
	var queryArgs []any

	if params.Depth != nil {
		querySQL += " AND depth <= ?"
		queryArgs = append(queryArgs, *params.Depth)
	}
	if params.Tag != "" {
		querySQL += ` AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)`
		queryArgs = append(queryArgs, params.Tag)
	}

	querySQL += " ORDER BY created_at DESC LIMIT ?"
	queryArgs = append(queryArgs, params.Limit)

	rows, err := p.db.Query(querySQL, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var entries []map[string]any
	for rows.Next() {
		var (
			id        int
			depth     int
			title     string
			origin    sql.NullString
			tagsJSON  string
			createdAt string
		)
		if err := rows.Scan(&id, &depth, &title, &origin, &tagsJSON, &createdAt); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		var tags []string
		_ = json.Unmarshal([]byte(tagsJSON), &tags)
		if tags == nil {
			tags = []string{}
		}

		entry := map[string]any{
			"id":         id,
			"depth":      depth,
			"title":      title,
			"tags":       tags,
			"created_at": createdAt,
		}
		if origin.Valid {
			entry["origin"] = origin.String
		}
		entries = append(entries, entry)
	}
	if entries == nil {
		entries = []map[string]any{}
	}

	return map[string]any{"entries": entries}, nil
}

// ---------------------------------------------------------------------------
// Observation tool handlers
// ---------------------------------------------------------------------------

func (p *proxy) toolAddObservation(args json.RawMessage) (any, error) {
	var params struct {
		EntityType   string   `json:"entity_type"`
		EntityName   string   `json:"entity_name"`
		Body         string   `json:"body"`
		Tags         []string `json:"tags"`
		CreatedAt    string   `json:"created_at"`
		SupersedesID int      `json:"supersedes_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.SupersedesID <= 0 && params.EntityType == "" {
		return nil, fmt.Errorf("entity_type is required")
	}
	if params.SupersedesID <= 0 && params.EntityName == "" {
		return nil, fmt.Errorf("entity_name is required")
	}
	if params.Body == "" {
		return nil, fmt.Errorf("body is required")
	}
	if params.Tags == nil {
		params.Tags = []string{}
	}
	tagsJSON, _ := json.Marshal(params.Tags)

	p.dbMu.Lock()
	defer p.dbMu.Unlock()
	tx, err := p.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin observation transaction: %w", err)
	}
	defer tx.Rollback()

	if params.SupersedesID > 0 {
		var oldType, oldName string
		if err := tx.QueryRow(
			"SELECT entity_type, entity_name FROM observations WHERE id = ?",
			params.SupersedesID,
		).Scan(&oldType, &oldName); err != nil {
			if err == sql.ErrNoRows {
				return nil, fmt.Errorf("observation %d not found", params.SupersedesID)
			}
			return nil, fmt.Errorf("read superseded observation: %w", err)
		}
		if params.EntityType == "" {
			params.EntityType = oldType
		}
		if params.EntityName == "" {
			params.EntityName = oldName
		}
		if oldType != params.EntityType || oldName != params.EntityName {
			return nil, fmt.Errorf("replacement must use the same entity type and name as observation %d", params.SupersedesID)
		}
		var relationCount int
		if err := tx.QueryRow(
			"SELECT COUNT(*) FROM observation_relations WHERE source_observation_id = ?",
			params.SupersedesID,
		).Scan(&relationCount); err != nil {
			return nil, fmt.Errorf("check observation lifecycle: %w", err)
		}
		if relationCount > 0 {
			return nil, fmt.Errorf("observation %d is already superseded or retracted", params.SupersedesID)
		}
	}

	var result sql.Result
	if params.CreatedAt != "" {
		result, err = tx.Exec(
			"INSERT INTO observations (entity_type, entity_name, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			params.EntityType, params.EntityName, params.Body, string(tagsJSON), params.CreatedAt, params.CreatedAt,
		)
	} else {
		result, err = tx.Exec(
			"INSERT INTO observations (entity_type, entity_name, body, tags) VALUES (?, ?, ?, ?)",
			params.EntityType, params.EntityName, params.Body, string(tagsJSON),
		)
	}
	if err != nil {
		return nil, fmt.Errorf("insert observation: %w", err)
	}

	newID, _ := result.LastInsertId()
	if params.SupersedesID > 0 {
		if _, err := tx.Exec(
			"INSERT INTO observation_relations (source_observation_id, target_observation_id, relation_type) VALUES (?, ?, 'superseded_by')",
			params.SupersedesID, newID,
		); err != nil {
			return nil, fmt.Errorf("record observation supersession: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit observation transaction: %w", err)
	}

	observation := map[string]any{
		"id":          int(newID),
		"entity_type": params.EntityType,
		"entity_name": params.EntityName,
	}
	if params.SupersedesID > 0 {
		observation["supersedes_id"] = params.SupersedesID
	}
	return map[string]any{"observation": observation}, nil
}

func (p *proxy) toolSearchObservations(args json.RawMessage) (any, error) {
	var params struct {
		Query             string `json:"query"`
		EntityType        string `json:"entity_type"`
		EntityName        string `json:"entity_name"`
		Limit             int    `json:"limit"`
		IncludeHistorical bool   `json:"include_historical"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.Query == "" {
		return nil, fmt.Errorf("query is required")
	}
	if params.Limit <= 0 {
		params.Limit = 10
	}

	ftsQuery, queryValid := preprocessQuery(params.Query)
	if !queryValid {
		return map[string]any{"observations": []any{}}, nil
	}

	querySQL := `SELECT o.id, o.entity_type, o.entity_name, o.body, o.tags, o.created_at,
       bm25(observations_fts, 1.0, 5.0, 0.5) AS score,
       COALESCE((SELECT r.relation_type FROM observation_relations r WHERE r.source_observation_id = o.id ORDER BY r.id DESC LIMIT 1), 'current') AS lifecycle,
       COALESCE((SELECT r.target_observation_id FROM observation_relations r WHERE r.source_observation_id = o.id ORDER BY r.id DESC LIMIT 1), 0) AS replacement_id,
       COALESCE((SELECT r.reason FROM observation_relations r WHERE r.source_observation_id = o.id ORDER BY r.id DESC LIMIT 1), '') AS lifecycle_reason
FROM observations_fts
JOIN observations o ON o.id = observations_fts.rowid
WHERE observations_fts MATCH ?`

	queryArgs := []any{ftsQuery}

	if !params.IncludeHistorical {
		querySQL += " AND NOT EXISTS (SELECT 1 FROM observation_relations r WHERE r.source_observation_id = o.id)"
	}
	if params.EntityType != "" {
		querySQL += " AND o.entity_type = ?"
		queryArgs = append(queryArgs, params.EntityType)
	}
	if params.EntityName != "" {
		querySQL += " AND o.entity_name = ?"
		queryArgs = append(queryArgs, params.EntityName)
	}

	querySQL += " ORDER BY score LIMIT ?"
	queryArgs = append(queryArgs, params.Limit)

	rows, err := p.db.Query(querySQL, queryArgs...)
	if err != nil {
		if strings.Contains(err.Error(), "fts5") {
			return map[string]any{"observations": []any{}}, nil
		}
		return nil, fmt.Errorf("search observations: %w", err)
	}
	defer rows.Close()

	var observations []map[string]any
	for rows.Next() {
		var (
			id              int
			entType         string
			entName         string
			body            string
			tagsJSON        string
			createdAt       string
			score           float64
			lifecycle       string
			lifecycleReason string
			replacementID   int
		)
		if err := rows.Scan(&id, &entType, &entName, &body, &tagsJSON, &createdAt, &score, &lifecycle, &replacementID, &lifecycleReason); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		var tags []string
		_ = json.Unmarshal([]byte(tagsJSON), &tags)
		if tags == nil {
			tags = []string{}
		}

		observation := map[string]any{
			"id":          id,
			"entity_type": entType,
			"entity_name": entName,
			"body":        body,
			"tags":        tags,
			"created_at":  createdAt,
			"score":       score,
			"lifecycle":   lifecycle,
		}
		if replacementID > 0 {
			observation["replacement_id"] = replacementID
		}
		if lifecycleReason != "" {
			observation["lifecycle_reason"] = lifecycleReason
		}
		observations = append(observations, observation)
	}
	if observations == nil {
		observations = []map[string]any{}
	}

	return map[string]any{"observations": observations}, nil
}

func (p *proxy) toolListObservations(args json.RawMessage) (any, error) {
	var params struct {
		EntityType        string `json:"entity_type"`
		EntityName        string `json:"entity_name"`
		Limit             int    `json:"limit"`
		Offset            int    `json:"offset"`
		IncludeHistorical bool   `json:"include_historical"`
	}
	if args != nil {
		_ = json.Unmarshal(args, &params)
	}
	if params.Limit <= 0 {
		params.Limit = 50
	}

	querySQL := "SELECT o.id, o.entity_type, o.entity_name, o.body, o.tags, o.created_at FROM observations o WHERE 1=1"
	var queryArgs []any

	if !params.IncludeHistorical {
		querySQL += " AND NOT EXISTS (SELECT 1 FROM observation_relations r WHERE r.source_observation_id = o.id)"
	}
	if params.EntityType != "" {
		querySQL += " AND o.entity_type = ?"
		queryArgs = append(queryArgs, params.EntityType)
	}
	if params.EntityName != "" {
		querySQL += " AND o.entity_name = ?"
		queryArgs = append(queryArgs, params.EntityName)
	}

	querySQL += " ORDER BY o.created_at DESC LIMIT ? OFFSET ?"
	queryArgs = append(queryArgs, params.Limit, params.Offset)

	rows, err := p.db.Query(querySQL, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var observations []map[string]any
	for rows.Next() {
		var (
			id        int
			entType   string
			entName   string
			body      string
			tagsJSON  string
			createdAt string
		)
		if err := rows.Scan(&id, &entType, &entName, &body, &tagsJSON, &createdAt); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		var tags []string
		_ = json.Unmarshal([]byte(tagsJSON), &tags)
		if tags == nil {
			tags = []string{}
		}

		observations = append(observations, map[string]any{
			"id":          id,
			"entity_type": entType,
			"entity_name": entName,
			"body":        body,
			"tags":        tags,
			"created_at":  createdAt,
		})
	}
	if observations == nil {
		observations = []map[string]any{}
	}

	// Also return total count for the applied filters
	countSQL := "SELECT COUNT(*) FROM observations o WHERE 1=1"
	var countArgs []any
	if !params.IncludeHistorical {
		countSQL += " AND NOT EXISTS (SELECT 1 FROM observation_relations r WHERE r.source_observation_id = o.id)"
	}
	if params.EntityType != "" {
		countSQL += " AND o.entity_type = ?"
		countArgs = append(countArgs, params.EntityType)
	}
	if params.EntityName != "" {
		countSQL += " AND o.entity_name = ?"
		countArgs = append(countArgs, params.EntityName)
	}
	var total int
	p.db.QueryRow(countSQL, countArgs...).Scan(&total)

	return map[string]any{"observations": observations, "total": total}, nil
}

func (p *proxy) toolDeleteObservation(args json.RawMessage) (any, error) {
	var params struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.ID <= 0 {
		return nil, fmt.Errorf("id is required")
	}

	p.dbMu.Lock()
	result, err := p.db.Exec("DELETE FROM observations WHERE id = ?", params.ID)
	p.dbMu.Unlock()

	if err != nil {
		return nil, fmt.Errorf("delete observation: %w", err)
	}

	affected, _ := result.RowsAffected()
	return map[string]any{
		"deleted": affected > 0,
		"id":      params.ID,
	}, nil
}

func (p *proxy) toolRetractObservation(args json.RawMessage) (any, error) {
	var params struct {
		ID     int    `json:"id"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if params.ID <= 0 {
		return nil, fmt.Errorf("id is required")
	}

	p.dbMu.Lock()
	defer p.dbMu.Unlock()
	tx, err := p.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin retraction: %w", err)
	}
	defer tx.Rollback()

	var exists int
	if err := tx.QueryRow("SELECT COUNT(*) FROM observations WHERE id = ?", params.ID).Scan(&exists); err != nil {
		return nil, fmt.Errorf("read observation: %w", err)
	}
	if exists == 0 {
		return nil, fmt.Errorf("observation %d not found", params.ID)
	}
	var relationCount int
	if err := tx.QueryRow("SELECT COUNT(*) FROM observation_relations WHERE source_observation_id = ?", params.ID).Scan(&relationCount); err != nil {
		return nil, fmt.Errorf("check observation lifecycle: %w", err)
	}
	if relationCount > 0 {
		return nil, fmt.Errorf("observation %d is already superseded or retracted", params.ID)
	}
	if _, err := tx.Exec(
		"INSERT INTO observation_relations (source_observation_id, relation_type, reason) VALUES (?, 'retracted', ?)",
		params.ID, params.Reason,
	); err != nil {
		return nil, fmt.Errorf("record observation retraction: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit retraction: %w", err)
	}
	return map[string]any{"retracted": true, "id": params.ID, "reason": params.Reason}, nil
}

// nullString converts an empty string to sql.NullString with Valid=false.
func nullString(s string) sql.NullString {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

// extractSessionDate parses the "# Date: ..." header from a normalized transcript.
// Returns the ISO date string if found and valid, otherwise "".
func extractSessionDate(body string) string {
	for _, line := range strings.SplitN(body, "\n", 10) {
		if strings.HasPrefix(line, "# Date: ") {
			dateStr := strings.TrimSpace(line[8:])
			if _, err := time.Parse(time.RFC3339Nano, dateStr); err == nil {
				return dateStr
			}
			// Try without fractional seconds
			if _, err := time.Parse(time.RFC3339, dateStr); err == nil {
				return dateStr
			}
			return ""
		}
		if !strings.HasPrefix(line, "#") && line != "" {
			break
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Client handling
// ---------------------------------------------------------------------------

func (p *proxy) handleClient(conn net.Conn) {
	defer conn.Close()

	clientID := p.clientSeq.Add(1)
	log.Printf("client %d connected", clientID)

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 1*1024*1024), 16*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		msg, err := parseMessage(line)
		if err != nil {
			log.Printf("client %d: invalid JSON: %v", clientID, err)
			continue
		}

		// Notification (no id) — ignore
		if msg.id() == nil {
			continue
		}

		method := msg.method()

		// MCP initialize → reply locally
		if method == "initialize" {
			resp := p.makeInitResponse(msg.id())
			_, _ = conn.Write(append(resp, '\n'))
			continue
		}

		// proxy/submit_save
		if method == "proxy/submit_save" {
			resp := p.handleSubmitSave(msg)
			_, _ = conn.Write(append(resp, '\n'))
			continue
		}

		// proxy/queue_status
		if method == "proxy/queue_status" {
			resp := p.handleQueueStatus(msg)
			_, _ = conn.Write(append(resp, '\n'))
			continue
		}

		// tools/call → route to handler
		if method == "tools/call" {
			resp := p.handleToolsCall(msg)
			_, _ = conn.Write(append(resp, '\n'))
			continue
		}

		// Unknown method
		errResp := map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(msg.id()),
			"error": map[string]any{
				"code":    -32601,
				"message": fmt.Sprintf("unknown method: %s", method),
			},
		}
		b, _ := json.Marshal(errResp)
		_, _ = conn.Write(append(b, '\n'))
	}

	log.Printf("client %d disconnected", clientID)
}

func (p *proxy) makeInitResponse(clientID json.RawMessage) []byte {
	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(clientID),
		"result": map[string]any{
			"protocolVersion": "2025-03-26",
			"capabilities":    map[string]any{},
			"serverInfo": map[string]any{
				"name":    "memstore",
				"version": "1.0.0",
			},
		},
	}
	b, _ := json.Marshal(resp)
	return b
}

func (p *proxy) handleToolsCall(msg *rpcMessage) []byte {
	// Parse params to extract tool name and arguments
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if raw := msg.params(); raw != nil {
		_ = json.Unmarshal(raw, &params)
	}

	result, err := p.handleToolCall(params.Name, params.Arguments)
	if err != nil {
		errResp := map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(msg.id()),
			"result": map[string]any{
				"isError": true,
				"content": []map[string]any{
					{"type": "text", "text": err.Error()},
				},
			},
		}
		b, _ := json.Marshal(errResp)
		return b
	}

	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(msg.id()),
		"result": map[string]any{
			"structuredContent": result,
		},
	}
	b, _ := json.Marshal(resp)
	return b
}

// ---------------------------------------------------------------------------
// Proxy commands: submit_save, queue_status
// ---------------------------------------------------------------------------

func (p *proxy) handleSubmitSave(msg *rpcMessage) []byte {
	var params struct {
		Body   string   `json:"body"`
		Origin string   `json:"origin"`
		Tags   []string `json:"tags"`
		Title  string   `json:"title"`
		Depth  int      `json:"depth"`
	}
	if raw := msg.params(); raw != nil {
		_ = json.Unmarshal(raw, &params)
	}

	jobID := fmt.Sprintf("save_%d", time.Now().UnixMilli())

	job := &saveJob{
		ID:     jobID,
		Body:   params.Body,
		Origin: params.Origin,
		Tags:   params.Tags,
		Title:  params.Title,
		Depth:  params.Depth,
		Status: "queued",
	}

	p.saveMu.Lock()
	p.saveQueue = append(p.saveQueue, job)
	p.persistSaveQueue()
	queueDepth := len(p.saveQueue)
	p.saveMu.Unlock()

	// Poke the processor
	select {
	case p.saveNotify <- struct{}{}:
	default:
	}

	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(msg.id()),
		"result": map[string]any{
			"job_id":      jobID,
			"queued":      true,
			"queue_depth": queueDepth,
		},
	}
	b, _ := json.Marshal(resp)
	return b
}

func (p *proxy) saveStatus() map[string]any {
	p.saveMu.Lock()
	defer p.saveMu.Unlock()

	jobs := make([]map[string]any, len(p.saveQueue))
	for i, j := range p.saveQueue {
		jobs[i] = map[string]any{
			"id": j.ID, "origin": j.Origin, "status": j.Status,
		}
	}

	var current map[string]any
	if p.currentSaveJob != nil {
		current = map[string]any{
			"id":     p.currentSaveJob.ID,
			"origin": p.currentSaveJob.Origin,
			"status": p.currentSaveJob.Status,
		}
	}

	return map[string]any{
		"queue_depth": len(p.saveQueue),
		"processing":  p.processingSave,
		"current_job": current,
		"jobs":        jobs,
	}
}

func (p *proxy) handleQueueStatus(msg *rpcMessage) []byte {
	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(msg.id()),
		"result":  p.saveStatus(),
	}
	b, _ := json.Marshal(resp)
	return b
}

// ---------------------------------------------------------------------------
// Save job processor
// ---------------------------------------------------------------------------

func (p *proxy) processSaveJobs() {
	for {
		select {
		case <-p.saveNotify:
		case <-p.done:
			return
		}

		for {
			p.saveMu.Lock()
			if len(p.saveQueue) == 0 {
				p.saveMu.Unlock()
				break
			}
			job := p.saveQueue[0]
			p.saveMu.Unlock()

			p.processOneJob(job)

			p.saveMu.Lock()
			if len(p.saveQueue) > 0 && p.saveQueue[0].ID == job.ID {
				p.saveQueue = p.saveQueue[1:]
			}
			p.persistSaveQueue()
			p.saveMu.Unlock()
		}
	}
}

func (p *proxy) processOneJob(job *saveJob) {
	p.saveMu.Lock()
	p.processingSave = true
	p.currentSaveJob = job
	p.saveMu.Unlock()
	defer func() {
		p.saveMu.Lock()
		p.processingSave = false
		p.currentSaveJob = nil
		p.saveMu.Unlock()
	}()

	// Check origin map for previous entry
	p.originMapMu.Lock()
	prevID, hasPrev := p.originMap[job.Origin]
	p.originMapMu.Unlock()

	job.Status = "adding"
	if job.Tags == nil {
		job.Tags = []string{}
	}
	tagsJSON, _ := json.Marshal(job.Tags)

	// Delete + insert in a single transaction to avoid data loss on insert failure
	p.dbMu.Lock()
	tx, txErr := p.db.Begin()
	if txErr != nil {
		p.dbMu.Unlock()
		job.Status = "failed"
		job.Error = txErr.Error()
		log.Printf("[save] begin tx failed for %s: %v", job.Origin, txErr)
		return
	}

	if hasPrev {
		_, _ = tx.Exec("DELETE FROM entries WHERE id = ?", prevID)
	}

	result, err := tx.Exec(
		"INSERT INTO entries (depth, title, body, origin, tags, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
		job.Depth, job.Title, job.Body, nullString(job.Origin), string(tagsJSON), extractSessionDate(job.Body),
	)
	if err != nil {
		_ = tx.Rollback()
		p.dbMu.Unlock()
		job.Status = "failed"
		job.Error = err.Error()
		log.Printf("[save] add failed for %s: %v", job.Origin, err)
		return
	}

	if txErr = tx.Commit(); txErr != nil {
		p.dbMu.Unlock()
		job.Status = "failed"
		job.Error = txErr.Error()
		log.Printf("[save] commit failed for %s: %v", job.Origin, txErr)
		return
	}
	p.dbMu.Unlock()

	newID, _ := result.LastInsertId()
	p.originMapMu.Lock()
	p.originMap[job.Origin] = int(newID)
	p.saveOriginMap()
	p.originMapMu.Unlock()

	job.Status = "done"
	job.ResultEntryID = int(newID)
	log.Printf("[save] completed for %s (entry %d)", job.Origin, newID)
}

// ---------------------------------------------------------------------------
// Persistence: origin map and save queue
// ---------------------------------------------------------------------------

func (p *proxy) loadOriginMap() {
	path := filepath.Join(p.dataDir, "origin-map.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &p.originMap)
}

func (p *proxy) saveOriginMap() {
	path := filepath.Join(p.dataDir, "origin-map.json")
	data, _ := json.MarshalIndent(p.originMap, "", "  ")
	if err := os.WriteFile(path, data, 0644); err != nil {
		log.Printf("[warn] failed to persist origin map: %v", err)
	}
}

func (p *proxy) loadSaveQueue() {
	path := filepath.Join(p.dataDir, "save-queue.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &p.saveQueue)
}

func (p *proxy) persistSaveQueue() {
	path := filepath.Join(p.dataDir, "save-queue.json")
	if len(p.saveQueue) == 0 {
		_ = os.Remove(path)
		return
	}
	data, _ := json.MarshalIndent(p.saveQueue, "", "  ")
	if err := os.WriteFile(path, data, 0644); err != nil {
		log.Printf("[warn] failed to persist save queue: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	defaultSock := fmt.Sprintf("/run/user/%d/memstore.sock", os.Getuid())
	defaultData := filepath.Join(os.Getenv("HOME"), ".pi", "memstore")

	var (
		sockPath string
		dataDir  string
	)

	flag.StringVar(&sockPath, "socket", defaultSock, "Unix domain socket path")
	flag.StringVar(&dataDir, "data-dir", defaultData, "Data directory for SQLite DB, origin map, save queue")
	flag.Parse()

	// Ensure data dir exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	p := newProxy(sockPath, dataDir)

	// Open database
	if err := p.openDB(); err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer p.db.Close()

	// Load persistent state
	p.loadOriginMap()
	p.loadSaveQueue()

	// Start save processor
	p.saveProcessorWg.Add(1)
	go func() {
		defer p.saveProcessorWg.Done()
		p.processSaveJobs()
	}()

	// Resume pending jobs
	if len(p.saveQueue) > 0 {
		log.Printf("resuming %d pending save jobs from previous run", len(p.saveQueue))
		select {
		case p.saveNotify <- struct{}{}:
		default:
		}
	}

	// Remove stale socket
	_ = os.Remove(sockPath)

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		log.Fatalf("listen %s: %v", sockPath, err)
	}
	_ = os.Chmod(sockPath, 0700)

	log.Printf("listening on %s (data: %s)", sockPath, dataDir)

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	shutdown := func() {
		p.shutdownOnce.Do(func() {
			log.Println("shutting down...")
			close(p.done)
			select {
			case p.saveNotify <- struct{}{}:
			default:
			}
			ln.Close()
			_ = os.Remove(sockPath)
		})
	}

	go func() {
		<-sigCh
		shutdown()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-p.done:
				// Clean return — wait for the save processor to finish any in-flight
				// write before deferred db.Close() runs and WAL checkpoint happens.
				p.saveProcessorWg.Wait()
				return
			default:
				log.Printf("accept: %v", err)
				continue
			}
		}
		go p.handleClient(conn)
	}
}
