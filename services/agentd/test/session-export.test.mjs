import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveActiveBranchMetadata, reconcileActiveBranchMetadata } from '../src/session-export.mjs';

test('derives active branch leaf and entry IDs from the latest persisted branch', () => {
  const entries = [
    { type: 'message', id: 'root', parentId: null },
    { type: 'message', id: 'old-leaf', parentId: 'root' },
    { type: 'message', id: 'new-leaf', parentId: 'root' },
    { type: 'custom', id: 'provenance', parentId: 'new-leaf' },
  ];
  assert.deepEqual(deriveActiveBranchMetadata(entries), {
    leaf_entry_id: 'provenance',
    active_entry_ids: ['root', 'new-leaf', 'provenance'],
  });
  assert.deepEqual(deriveActiveBranchMetadata(entries, 'new-leaf'), {
    leaf_entry_id: 'new-leaf',
    active_entry_ids: ['root', 'new-leaf'],
  });
});

test('prefers a persisted descendant over a stale loaded manager leaf', () => {
  const entries = [
    { type: 'message', id: 'root', parentId: null },
    { type: 'message', id: 'cached-leaf', parentId: 'root' },
    { type: 'compaction', id: 'compact', parentId: 'cached-leaf' },
    { type: 'message', id: 'cli-user', parentId: 'compact' },
    { type: 'message', id: 'cli-assistant', parentId: 'cli-user' },
  ];
  assert.deepEqual(reconcileActiveBranchMetadata(entries, {
    leaf_entry_id: 'cached-leaf',
    active_entry_ids: ['root', 'cached-leaf'],
  }), {
    leaf_entry_id: 'cli-assistant',
    active_entry_ids: ['root', 'cached-leaf', 'compact', 'cli-user', 'cli-assistant'],
    source: 'disk_descendant',
    live_leaf_entry_id: 'cached-leaf',
    external_advance: true,
  });
});

test('detects disk advancement from a loaded empty session', () => {
  assert.deepEqual(reconcileActiveBranchMetadata([
    { type: 'message', id: 'first-message', parentId: null },
  ], {
    leaf_entry_id: null,
    active_entry_ids: [],
  }), {
    leaf_entry_id: 'first-message',
    active_entry_ids: ['first-message'],
    source: 'disk_descendant',
    live_leaf_entry_id: null,
    external_advance: true,
  });
});

test('surfaces true branch divergence without changing the loaded branch', () => {
  const entries = [
    { type: 'message', id: 'root', parentId: null },
    { type: 'message', id: 'live-leaf', parentId: 'root' },
    { type: 'message', id: 'disk-leaf', parentId: 'root' },
  ];
  assert.deepEqual(reconcileActiveBranchMetadata(entries, {
    leaf_entry_id: 'live-leaf',
    active_entry_ids: ['root', 'live-leaf'],
  }), {
    leaf_entry_id: 'live-leaf',
    active_entry_ids: ['root', 'live-leaf'],
    source: 'live_divergence',
    disk_leaf_entry_id: 'disk-leaf',
    branch_conflict: true,
  });
});
