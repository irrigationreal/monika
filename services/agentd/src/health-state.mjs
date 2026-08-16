function count(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Maintain the exact number of loaded conversations with an active turn or
 * counted mutation. Reads are O(1); callers record the affected conversation
 * after each state transition rather than scanning the conversation registry.
 */
export function createActiveThreadHealthCache() {
  const statesById = new Map();
  const closedConversations = new WeakSet();
  let activeCount = 0;

  return {
    record(conversation) {
      if (!conversation || typeof conversation !== "object" || closedConversations.has(conversation)) return;
      const active = Boolean(conversation.current || conversation.pendingMutations > 0);
      const previous = statesById.get(conversation.id);
      if (previous?.conversation !== conversation) {
        if (previous?.active) activeCount -= 1;
        statesById.set(conversation.id, { conversation, active });
        if (active) activeCount += 1;
      } else if (previous.active !== active) {
        previous.active = active;
        activeCount += active ? 1 : -1;
      }
    },

    close(conversation) {
      if (!conversation || typeof conversation !== "object") return;
      closedConversations.add(conversation);
      const current = statesById.get(conversation.id);
      if (current?.conversation !== conversation) return;
      if (current.active) activeCount -= 1;
      statesById.delete(conversation.id);
    },

    count() {
      return activeCount;
    },
  };
}

/**
 * Cache the informational lifecycle counts exposed by liveness. Durable lifecycle
 * scans update this cache, but reading it never starts or waits for a scan.
 */
export function createSubagentHealthCache({ now = () => Date.now() } = {}) {
  let latest = null;

  return {
    record(snapshot) {
      latest = {
        active_count: count(snapshot?.active_count, 1),
        uncertain_count: count(snapshot?.uncertain_count, 1),
        effects_unknown_count: count(snapshot?.effects_unknown_count, 0),
        scanned_at_ms: now(),
      };
    },

    read() {
      if (!latest) {
        return {
          active_count: 1,
          uncertain_count: 1,
          effects_unknown_count: 0,
          freshness: {
            source: "not_yet_scanned",
            scanned_at_ms: null,
            age_ms: null,
          },
        };
      }
      return {
        active_count: latest.active_count,
        uncertain_count: latest.uncertain_count,
        effects_unknown_count: latest.effects_unknown_count,
        freshness: {
          source: "last_successful_scan",
          scanned_at_ms: latest.scanned_at_ms,
          age_ms: Math.max(0, now() - latest.scanned_at_ms),
        },
      };
    },
  };
}
