import type { TamperConfigRow } from '../db';

export function parseTamperConfigJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface SerializedTamperConfig {
  id: string;
  forumId: string | null;
  pluginKey: string;
  enabled: boolean;
  priority: number;
  direction: string | null;
  onlyFirstMessage: boolean | null;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeTamperConfig(row: TamperConfigRow): SerializedTamperConfig {
  return {
    id: row.id,
    forumId: row.forum_id,
    pluginKey: row.plugin_key,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    direction: row.direction,
    onlyFirstMessage: row.only_first_message === null ? null : Boolean(row.only_first_message),
    config: parseTamperConfigJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getTamperPluginDirections(stages: string[]): Array<'inbound' | 'outbound'> {
  const directions = new Set<'inbound' | 'outbound'>();
  for (const stage of stages) {
    if (stage.startsWith('inbound.')) directions.add('inbound');
    if (stage.startsWith('outbound.')) directions.add('outbound');
  }
  return Array.from(directions.values());
}

export function normalizeTamperDirection(value: unknown): 'inbound' | 'outbound' | 'both' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'inbound' || normalized === 'outbound' || normalized === 'both') {
    return normalized;
  }
  return null;
}
