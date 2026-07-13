import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveActiveBranchMetadata } from '../src/session-export.mjs';

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
