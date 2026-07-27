const FULL_EXCERPT_MAX_BYTES = 45 * 1024;

const EXCERPT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
  "could", "did", "do", "does", "for", "from", "had", "has", "have", "how",
  "i", "if", "in", "is", "it", "its", "me", "my", "not", "of", "on", "or",
  "our", "should", "that", "the", "their", "then", "there", "these", "they",
  "this", "those", "to", "up", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "you", "your",
]);

export function isDelegateSession(entry) {
  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  const originSegments = String(entry?.origin ?? "").split(/[\\/]+/);
  return Number(entry?.depth) >= 3 ||
    tags.includes("delegate") ||
    tags.includes("fork") ||
    originSegments.includes("forks");
}

/**
 * Preserve search rank while preventing fork transcripts from crowding out the
 * trunk. If enough trunk results exist, at most one delegate is returned. When
 * delegates contain the only useful hits, they fill the remaining slots.
 */
export function selectDiverseSessionEntries(entries, limit = 5) {
  const ranked = Array.isArray(entries) ? entries : [];
  if (limit <= 0) return [];

  const trunkCount = ranked.filter((entry) => !isDelegateSession(entry)).length;
  const delegateLimit = trunkCount >= limit - 1 ? 1 : Math.max(1, limit - trunkCount);
  const selected = [];
  const deferredDelegates = [];
  let delegateCount = 0;

  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (isDelegateSession(entry)) {
      if (delegateCount >= delegateLimit) {
        deferredDelegates.push(entry);
        continue;
      }
      delegateCount += 1;
    }
    selected.push(entry);
  }

  for (const entry of deferredDelegates) {
    if (selected.length >= limit) break;
    selected.push(entry);
  }
  return selected;
}

export function tokenizeExcerptQuery(query) {
  const tokens = String(query ?? "")
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(tokens.filter((token) => token.length > 1 && !EXCERPT_STOPWORDS.has(token)))];
}

function avoidSplitSurrogate(text, index) {
  let boundary = Math.max(0, Math.min(index, text.length));
  if (boundary > 0 && boundary < text.length) {
    const previous = text.charCodeAt(boundary - 1);
    const current = text.charCodeAt(boundary);
    if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) {
      boundary -= 1;
    }
  }
  return boundary;
}

function utf8PrefixWithinBytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text.length;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return avoidSplitSurrogate(text, low);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTokenPositions(text, token, start, limit = 101) {
  const positions = [];
  const exact = new RegExp(escapeRegExp(token), "giu");
  exact.lastIndex = Math.max(0, start);
  let match;
  while ((match = exact.exec(text)) && positions.length < limit) {
    positions.push(match.index);
  }
  if (positions.length > 0 || token.length < 5) return positions;

  // FTS5 uses Porter stemming. When an exact surface form is absent, use a
  // conservative four-character word prefix so ranked hits such as
  // "decisions" → "decide" still produce a relevant excerpt window. Case
  // folding happens per word so length-changing folds cannot corrupt offsets.
  const root = token.slice(0, 4);
  const words = /[\p{L}\p{N}_]+/gu;
  words.lastIndex = Math.max(0, start);
  while ((match = words.exec(text)) && positions.length < limit) {
    const word = match[0].toLowerCase();
    if (word.length >= 5 && word.slice(0, 4) === root) positions.push(match.index);
  }
  return positions;
}

export function truncateCharactersSafe(text, maxChars, suffix = "...") {
  const value = String(text ?? "");
  const limit = Math.max(0, Number(maxChars) || 0);
  if (value.length <= limit) return value;
  if (limit <= suffix.length) return suffix.slice(0, limit);
  const take = avoidSplitSurrogate(value, limit - suffix.length);
  return value.slice(0, take) + suffix;
}

function mergeRanges(ranges, gap = 240) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (range.start <= current.end + gap) {
      current.end = Math.max(current.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Return bounded query-relevant windows from a transcript. offset is a source
 * character offset, so callers can continue through later matches without
 * retrieving the complete document.
 */
export function buildRelevantExcerpt(body, {
  query = "",
  offset = 0,
  maxChars = 8000,
  full = false,
} = {}) {
  const text = String(body ?? "");
  const safeOffset = avoidSplitSurrogate(
    text,
    Math.max(0, Math.min(Number(offset) || 0, text.length)),
  );
  const safeMax = Math.max(1000, Math.min(Number(maxChars) || 8000, 12000));

  if (full) {
    const remaining = text.slice(safeOffset);
    const take = utf8PrefixWithinBytes(remaining, FULL_EXCERPT_MAX_BYTES);
    const end = safeOffset + take;
    return {
      text: remaining.slice(0, take),
      sourceRanges: [{ start: safeOffset, end }],
      nextOffset: end < text.length ? end : null,
      truncated: end < text.length,
    };
  }

  const tokens = tokenizeExcerptQuery(query);
  if (tokens.length === 0) {
    const end = avoidSplitSurrogate(text, Math.min(text.length, safeOffset + safeMax));
    return {
      text: text.slice(safeOffset, end),
      sourceRanges: [{ start: safeOffset, end }],
      nextOffset: end < text.length ? end : null,
      truncated: end < text.length,
    };
  }

  const ranges = [];
  const cappedTokens = [];
  for (const token of tokens) {
    // Scan backward far enough to recover the unreturned tail of a match window
    // when offset came from a partially emitted previous excerpt.
    const scanStart = Math.max(0, safeOffset - 1400);
    const positions = findTokenPositions(text, token, scanStart, 101);
    for (const position of positions.slice(0, 100)) {
      const end = avoidSplitSurrogate(
        text,
        Math.min(text.length, position + token.length + 1300),
      );
      if (end > safeOffset) {
        ranges.push({
          start: avoidSplitSurrogate(text, Math.max(safeOffset, position - 900)),
          end,
        });
      }
    }
    if (positions.length > 100) cappedTokens.push(token);
  }

  const merged = mergeRanges(ranges);
  if (merged.length === 0) {
    const end = avoidSplitSurrogate(text, Math.min(text.length, safeOffset + safeMax));
    return {
      text: text.slice(safeOffset, end),
      sourceRanges: [{ start: safeOffset, end }],
      nextOffset: end < text.length ? end : null,
      truncated: end < text.length,
    };
  }

  const output = [];
  const included = [];
  let used = 0;
  let nextOffset = null;
  for (const range of merged) {
    const label = `[source characters ${range.start}-${range.end}]\n`;
    const separator = output.length > 0 ? "\n\n---\n\n" : "";
    const available = safeMax - used - label.length - separator.length;
    if (available <= 0) {
      nextOffset = range.start;
      break;
    }
    const segment = text.slice(range.start, range.end);
    const take = avoidSplitSurrogate(segment, Math.min(segment.length, available));
    output.push(`${separator}${label}${segment.slice(0, take)}`);
    included.push({ start: range.start, end: range.start + take });
    used += separator.length + label.length + take;
    if (take < segment.length) {
      nextOffset = range.start + take;
      break;
    }
  }

  if (nextOffset == null && included.length < merged.length) {
    nextOffset = merged[included.length].start;
  }
  if (nextOffset == null && cappedTokens.length > 0) {
    const coveredEnd = included.reduce((max, range) => Math.max(max, range.end), safeOffset);
    const pendingOffsets = cappedTokens
      .flatMap((token) => findTokenPositions(text, token, coveredEnd, 1))
      .filter((position) => position >= 0);
    if (pendingOffsets.length > 0) nextOffset = Math.min(...pendingOffsets);
  }

  return {
    text: output.join(""),
    sourceRanges: included,
    nextOffset,
    truncated: nextOffset != null,
  };
}

export function joinWithinBudget(sections, maxBytes = 6000, separator = "\n\n---\n\n") {
  const budget = Math.max(0, Number(maxBytes) || 0);
  const accepted = [];
  let used = 0;
  for (const section of sections.filter(Boolean)) {
    const prefix = accepted.length > 0 ? separator : "";
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    const available = budget - used - prefixBytes;
    if (available <= 0) break;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (sectionBytes <= available) {
      accepted.push(prefix + section);
      used += prefixBytes + sectionBytes;
    } else {
      const marker = "\n(truncated)";
      const markerBytes = Buffer.byteLength(marker, "utf8");
      if (available < markerBytes) break;
      const take = utf8PrefixWithinBytes(section, available - markerBytes);
      accepted.push(prefix + section.slice(0, take) + marker);
      break;
    }
  }
  return accepted.join("");
}
