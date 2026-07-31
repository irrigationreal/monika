export function requestedAutoCompaction(config = {}) {
  const value =
    config.auto_compact ?? config.autoCompact ?? config.auto_compact_enabled;
  if (value === undefined) return null;
  if (typeof value !== "boolean")
    throw new TypeError("auto_compact must be a boolean");
  return value;
}

/** Apply a conversation-local override without calling Pi's persistence-writing setter. */
export function applyAutoCompactionOverride(settingsManager, config = {}) {
  const enabled = requestedAutoCompaction(config);
  if (enabled === null) return null;
  settingsManager.applyOverrides({ compaction: { enabled } });
  return enabled;
}
