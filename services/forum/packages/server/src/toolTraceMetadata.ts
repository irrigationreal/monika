import type { NestedToolCallsDto } from '@irrigationreal/codex-forum-contracts';

const MAX_NESTED_CALLS = 64;
const MAX_CALL_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const NESTED_CALL_STATUSES = new Set(['ok', 'error', 'unfinished']);

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

/**
 * Select only the bounded nested-call metadata that the forum is allowed to
 * persist. Tool arguments and result bodies are deliberately ignored.
 */
export function normalizeNestedToolCalls(value: unknown): NestedToolCallsDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['calls'])) return null;

  const calls: NestedToolCallsDto['calls'] = [];
  const seen = new Set<string>();
  for (const rawCall of record['calls'].slice(0, MAX_NESTED_CALLS)) {
    if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) continue;
    const call = rawCall as Record<string, unknown>;
    const id = boundedString(call['id'], MAX_CALL_ID_LENGTH);
    const name = boundedString(call['name'], MAX_TOOL_NAME_LENGTH);
    const status = call['status'];
    if (!id || !name || typeof status !== 'string' || !NESTED_CALL_STATUSES.has(status) || seen.has(id)) continue;
    seen.add(id);

    const durationValue = call['duration_ms'] ?? call['durationMs'];
    const durationMs =
      typeof durationValue === 'number' && Number.isFinite(durationValue) && durationValue >= 0 ? durationValue : null;
    calls.push({
      id,
      name,
      status: status as NestedToolCallsDto['calls'][number]['status'],
      ...(durationMs !== null ? { durationMs } : {}),
    });
  }

  return {
    calls,
    complete:
      record['complete'] === true &&
      calls.length === record['calls'].length &&
      calls.every((call) => call.status !== 'unfinished'),
  };
}

export function nestedToolCommand(toolName: unknown): string {
  const name = boundedString(toolName, MAX_TOOL_NAME_LENGTH) ?? 'tool';
  return `${name} {"redacted":true}`;
}

export function nestedToolResultSummary(value: unknown): string {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const status = record['status'];
  const durationValue = record['duration_ms'] ?? record['durationMs'];
  return JSON.stringify({
    redacted: true,
    ...(typeof status === 'string' && NESTED_CALL_STATUSES.has(status) ? { status } : {}),
    duration_ms:
      typeof durationValue === 'number' && Number.isFinite(durationValue) && durationValue >= 0 ? durationValue : null,
  });
}

export function nestedToolCallsJson(value: unknown): string | null {
  const normalized = normalizeNestedToolCalls(value);
  return normalized ? JSON.stringify(normalized) : null;
}

export function parseNestedToolCallsJson(value: string | null | undefined): NestedToolCallsDto | null {
  if (!value) return null;
  try {
    return normalizeNestedToolCalls(JSON.parse(value));
  } catch {
    return null;
  }
}
