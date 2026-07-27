package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// helper: send JSON-RPC and read response
func rpcCall(t *testing.T, conn net.Conn, msg map[string]any) map[string]any {
	t.Helper()
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_, err = conn.Write(append(b, '\n'))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 1*1024*1024), 16*1024*1024)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if !scanner.Scan() {
		t.Fatalf("no response (err: %v)", scanner.Err())
	}

	var resp map[string]any
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v\nraw: %s", err, scanner.Bytes())
	}
	return resp
}

// rpcCallOnScanner reuses an existing scanner (for multiple calls on same conn)
func rpcCallOnScanner(t *testing.T, conn net.Conn, scanner *bufio.Scanner, msg map[string]any) map[string]any {
	t.Helper()
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_, err = conn.Write(append(b, '\n'))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if !scanner.Scan() {
		t.Fatalf("no response (err: %v)", scanner.Err())
	}

	var resp map[string]any
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v\nraw: %s", err, scanner.Bytes())
	}
	return resp
}

func TestMemstore(t *testing.T) {
	// Set up temp dirs
	tmpDir := t.TempDir()
	dataDir := filepath.Join(tmpDir, "data")
	os.MkdirAll(dataDir, 0755)
	sockPath := filepath.Join(tmpDir, "memstore.sock")

	// Create and start the proxy
	p := newProxy(sockPath, dataDir)
	if err := p.openDB(); err != nil {
		t.Fatalf("openDB: %v", err)
	}
	defer p.db.Close()

	p.loadOriginMap()
	p.loadSaveQueue()
	go p.processSaveJobs()

	// Listen
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go p.handleClient(conn)
		}
	}()

	// Connect
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 1*1024*1024), 16*1024*1024)

	// --- Test initialize ---
	resp := rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-03-26",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "test", "version": "1.0.0"},
		},
	})
	result := resp["result"].(map[string]any)
	serverInfo := result["serverInfo"].(map[string]any)
	if serverInfo["name"] != "memstore" {
		t.Errorf("expected server name 'memstore', got %v", serverInfo["name"])
	}

	// --- Test add entries ---
	// Entry 1: depth 1, tagged "infrastructure"
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_add_entry",
			"arguments": map[string]any{
				"body":   "NixOS rebuild completed successfully on stanza. All services running.",
				"title":  "Stanza rebuild",
				"depth":  1,
				"tags":   []string{"infrastructure"},
				"origin": "/sessions/test-001",
			},
		},
	})
	sc := resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	entry1 := sc["entry"].(map[string]any)
	entry1ID := int(entry1["id"].(float64))
	if entry1ID <= 0 {
		t.Errorf("expected positive entry ID, got %d", entry1ID)
	}

	// Entry 2: depth 2, tagged "project"
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_add_entry",
			"arguments": map[string]any{
				"body":  "Vesper MLS convergence bug still unresolved. Three-stage overhaul planned.",
				"title": "Vesper MLS status",
				"tags":  []string{"project", "vesper"},
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	entry2 := sc["entry"].(map[string]any)
	entry2ID := int(entry2["id"].(float64))

	// Entry 3: depth 0, tagged "infrastructure"
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_add_entry",
			"arguments": map[string]any{
				"body":  "Pi upgraded to version 0.67.68. Extensions compatible.",
				"title": "Pi upgrade",
				"depth": 0,
				"tags":  []string{"infrastructure", "pi"},
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	entry3 := sc["entry"].(map[string]any)
	entry3ID := int(entry3["id"].(float64))

	// --- Test search ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      5,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_search",
			"arguments": map[string]any{
				"query": "NixOS rebuild stanza",
				"limit": 5,
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	searchEntries := sc["entries"].([]any)
	if len(searchEntries) == 0 {
		t.Errorf("search returned 0 results, expected at least 1")
	} else {
		firstResult := searchEntries[0].(map[string]any)
		if int(firstResult["id"].(float64)) != entry1ID {
			t.Errorf("expected first search result to be entry %d, got %v", entry1ID, firstResult["id"])
		}
	}

	// Search with depth filter
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      6,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_search",
			"arguments": map[string]any{
				"query": "infrastructure upgrade",
				"depth": 0,
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	depthFiltered := sc["entries"].([]any)
	for _, e := range depthFiltered {
		em := e.(map[string]any)
		if int(em["depth"].(float64)) > 0 {
			t.Errorf("depth filter broken: got entry with depth %v", em["depth"])
		}
	}

	// Search with tag filter
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_search",
			"arguments": map[string]any{
				"query": "convergence MLS vesper",
				"tag":   "vesper",
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	tagFiltered := sc["entries"].([]any)
	if len(tagFiltered) != 1 {
		t.Errorf("expected 1 result with tag 'vesper', got %d", len(tagFiltered))
	}

	// --- Test show entry ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      8,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "memstore_show_entry",
			"arguments": map[string]any{"id": entry2ID},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	shown := sc["entry"].(map[string]any)
	if shown["title"] != "Vesper MLS status" {
		t.Errorf("show entry title mismatch: %v", shown["title"])
	}
	if shown["body"] != "Vesper MLS convergence bug still unresolved. Three-stage overhaul planned." {
		t.Errorf("show entry body mismatch: %v", shown["body"])
	}

	// --- Test list entries ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      9,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "memstore_list_entries",
			"arguments": map[string]any{},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	listed := sc["entries"].([]any)
	if len(listed) != 3 {
		t.Errorf("expected 3 entries in list, got %d", len(listed))
	}

	// List with tag filter
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      10,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "memstore_list_entries",
			"arguments": map[string]any{"tag": "infrastructure"},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	infraEntries := sc["entries"].([]any)
	if len(infraEntries) != 2 {
		t.Errorf("expected 2 infrastructure entries, got %d", len(infraEntries))
	}

	// --- Test status ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      11,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "memstore_status",
			"arguments": map[string]any{},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	totalEntries := int(sc["total_entries"].(float64))
	if totalEntries != 3 {
		t.Errorf("expected 3 total entries, got %d", totalEntries)
	}
	byDepth := sc["by_depth"].(map[string]any)
	if int(byDepth["0"].(float64)) != 1 {
		t.Errorf("expected 1 entry at depth 0")
	}
	byTag := sc["by_tag"].(map[string]any)
	if int(byTag["infrastructure"].(float64)) != 2 {
		t.Errorf("expected 2 infrastructure entries in by_tag")
	}

	// --- Test delete ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      12,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "memstore_delete_entry",
			"arguments": map[string]any{"id": entry3ID},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	if sc["deleted"] != true {
		t.Errorf("expected deleted=true")
	}

	// Verify deleted — search shouldn't find it
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      13,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_search",
			"arguments": map[string]any{
				"query": "Pi upgraded version",
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	afterDelete := sc["entries"].([]any)
	if len(afterDelete) != 0 {
		t.Errorf("expected 0 results after delete, got %d", len(afterDelete))
	}

	// Delete non-existent
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      14,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "memstore_delete_entry",
			"arguments": map[string]any{"id": 99999},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	if sc["deleted"] != false {
		t.Errorf("expected deleted=false for non-existent entry")
	}

	// --- Test submit_save ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      15,
		"method":  "proxy/submit_save",
		"params": map[string]any{
			"body":   "Session summary: discussed memstore architecture and SQLite FTS5.",
			"origin": "/sessions/test-save-001",
			"tags":   []string{"session"},
			"title":  "Session test-save-001",
			"depth":  2,
		},
	})
	saveResult := resp["result"].(map[string]any)
	if saveResult["queued"] != true {
		t.Errorf("expected queued=true")
	}
	jobID := saveResult["job_id"].(string)
	if jobID == "" {
		t.Errorf("expected non-empty job_id")
	}

	// Wait for save to process
	time.Sleep(500 * time.Millisecond)

	// Check queue status — should be empty now
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      16,
		"method":  "proxy/queue_status",
	})
	queueResult := resp["result"].(map[string]any)
	queueDepth := int(queueResult["queue_depth"].(float64))
	if queueDepth != 0 {
		t.Errorf("expected queue_depth=0 after processing, got %d", queueDepth)
	}

	// Verify the saved entry exists
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      17,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_search",
			"arguments": map[string]any{
				"query": "memstore architecture SQLite",
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	savedEntries := sc["entries"].([]any)
	if len(savedEntries) != 1 {
		t.Errorf("expected 1 saved entry, got %d", len(savedEntries))
	}

	// --- Test save with origin dedup (submit another save with same origin) ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      18,
		"method":  "proxy/submit_save",
		"params": map[string]any{
			"body":   "Replacement content: xylophone zephyr quasar uniquetoken.",
			"origin": "/sessions/test-save-001",
			"tags":   []string{"session"},
			"title":  "Session test-save-001 (updated)",
			"depth":  2,
		},
	})

	time.Sleep(500 * time.Millisecond)

	// Verify the new entry exists
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      19,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_search",
			"arguments": map[string]any{
				"query": "xylophone zephyr quasar uniquetoken",
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	dedupEntries := sc["entries"].([]any)
	if len(dedupEntries) != 1 {
		t.Errorf("expected 1 entry after dedup, got %d", len(dedupEntries))
	}

	// Verify the old entry was replaced (search for old-only content should return 0)
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      20,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "memstore_search",
			"arguments": map[string]any{
				"query": "discussed architecture SQLite FTS5",
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	oldEntries := sc["entries"].([]any)
	if len(oldEntries) != 0 {
		t.Errorf("expected 0 results for old content after dedup, got %d", len(oldEntries))
	}

	// Verify origin map was persisted
	originMapPath := filepath.Join(dataDir, "origin-map.json")
	if _, err := os.Stat(originMapPath); os.IsNotExist(err) {
		t.Errorf("origin-map.json not created")
	}

	// --- Final status check ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0",
		"id":      21,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "memstore_status",
			"arguments": map[string]any{},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	finalTotal := int(sc["total_entries"].(float64))
	// 3 original - 1 deleted + 1 saved - 1 dedup replaced + 1 new = 3
	if finalTotal != 3 {
		t.Errorf("expected 3 total entries at end, got %d", finalTotal)
	}

	// --- Test append-only observation lifecycle ---
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 22, "method": "tools/call",
		"params": map[string]any{
			"name": "memstore_add_observation",
			"arguments": map[string]any{
				"entity_type": "sophont", "entity_name": "Neon",
				"body": "Neon's favorite test color is red.",
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	oldObservationID := int(sc["observation"].(map[string]any)["id"].(float64))

	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 23, "method": "tools/call",
		"params": map[string]any{
			"name": "memstore_add_observation",
			"arguments": map[string]any{
				"body":          "Neon's favorite test color is blue.",
				"supersedes_id": oldObservationID,
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	newObservationID := int(sc["observation"].(map[string]any)["id"].(float64))

	// Current search hides the superseded observation.
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 24, "method": "tools/call",
		"params": map[string]any{
			"name":      "memstore_search_observations",
			"arguments": map[string]any{"query": "favorite test color", "limit": 10},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	currentObservations := sc["observations"].([]any)
	if len(currentObservations) != 1 || int(currentObservations[0].(map[string]any)["id"].(float64)) != newObservationID {
		t.Fatalf("expected only replacement observation %d in current search, got %#v", newObservationID, currentObservations)
	}

	// Historical search retains both and identifies the replacement edge.
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 25, "method": "tools/call",
		"params": map[string]any{
			"name": "memstore_search_observations",
			"arguments": map[string]any{
				"query": "favorite test color", "limit": 10, "include_historical": true,
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	historicalObservations := sc["observations"].([]any)
	if len(historicalObservations) != 2 {
		t.Fatalf("expected 2 historical observations, got %d", len(historicalObservations))
	}
	foundSuperseded := false
	for _, raw := range historicalObservations {
		observation := raw.(map[string]any)
		if int(observation["id"].(float64)) == oldObservationID {
			foundSuperseded = observation["lifecycle"] == "superseded_by" &&
				int(observation["replacement_id"].(float64)) == newObservationID
		}
	}
	if !foundSuperseded {
		t.Errorf("historical search did not expose supersession edge")
	}

	// Retraction removes the replacement from current views without deleting it.
	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 26, "method": "tools/call",
		"params": map[string]any{
			"name":      "memstore_retract_observation",
			"arguments": map[string]any{"id": newObservationID, "reason": "test cleanup"},
		},
	})
	if resp["result"].(map[string]any)["isError"] == true {
		t.Fatalf("retraction failed: %#v", resp)
	}

	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 27, "method": "tools/call",
		"params": map[string]any{
			"name": "memstore_list_observations", "arguments": map[string]any{},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	if len(sc["observations"].([]any)) != 0 {
		t.Errorf("expected no current observations after retraction")
	}

	resp = rpcCallOnScanner(t, conn, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 28, "method": "tools/call",
		"params": map[string]any{
			"name": "memstore_search_observations",
			"arguments": map[string]any{
				"query": "favorite test color", "limit": 10, "include_historical": true,
			},
		},
	})
	sc = resp["result"].(map[string]any)["structuredContent"].(map[string]any)
	foundRetractionReason := false
	for _, raw := range sc["observations"].([]any) {
		observation := raw.(map[string]any)
		if int(observation["id"].(float64)) == newObservationID {
			foundRetractionReason = observation["lifecycle"] == "retracted" &&
				observation["lifecycle_reason"] == "test cleanup"
		}
	}
	if !foundRetractionReason {
		t.Errorf("historical search did not expose retraction reason")
	}

	fmt.Printf("All tests passed. Final entry count: %d\n", finalTotal)
}
