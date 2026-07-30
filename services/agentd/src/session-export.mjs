/** Derive the active root-to-leaf entry IDs from parsed session entries. */
export function deriveActiveBranchMetadata(entries, leafId = null) {
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const fallbackLeaf = entries.findLast((entry) => entry.id) ?? null;
  const leaf = (leafId ? byId.get(leafId) : null) ?? fallbackLeaf;
  const activeEntryIds = [];
  const seen = new Set();
  let cursor = leaf;
  while (cursor?.id && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    activeEntryIds.push(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  activeEntryIds.reverse();
  return {
    leaf_entry_id: leaf?.id ?? null,
    active_entry_ids: activeEntryIds,
  };
}

/**
 * Reconcile a loaded SessionManager branch with the append-only JSONL. A direct
 * Pi continuation can advance the file while agentd still has an idle runtime
 * cached. When the disk leaf is a strict descendant of the live leaf, choosing
 * disk is unambiguous. True sibling divergence keeps the live branch and is
 * surfaced explicitly for operators instead of silently changing branches.
 */
export function reconcileActiveBranchMetadata(entries, liveBranch = null) {
  const disk = deriveActiveBranchMetadata(entries);
  if (!liveBranch) return { ...disk, source: 'disk' };
  if (!liveBranch.leaf_entry_id) {
    return disk.leaf_entry_id
      ? { ...disk, source: 'disk_descendant', live_leaf_entry_id: null, external_advance: true }
      : { ...disk, source: 'live' };
  }

  const liveLeaf = liveBranch.leaf_entry_id;
  if (disk.leaf_entry_id !== liveLeaf && disk.active_entry_ids.includes(liveLeaf)) {
    return {
      ...disk,
      source: 'disk_descendant',
      live_leaf_entry_id: liveLeaf,
      external_advance: true,
    };
  }

  if (disk.leaf_entry_id !== liveLeaf) {
    return {
      ...liveBranch,
      source: 'live_divergence',
      disk_leaf_entry_id: disk.leaf_entry_id,
      branch_conflict: true,
    };
  }

  return { ...liveBranch, source: 'live' };
}
