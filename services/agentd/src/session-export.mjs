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
