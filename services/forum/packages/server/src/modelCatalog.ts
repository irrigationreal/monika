import type { EchsClient } from './echsClient';

export type ModelFamily = 'echs' | 'unknown' | string;

export interface ModelInfo {
  id: string;
  family: ModelFamily;
  label?: string | null;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  defaultReasoning?: string | null;
  contextWindowTokens?: number | null;
  maxTokens?: number | null;
  inputModalities?: string[] | null;
}

export interface ModelCatalogSnapshot {
  items: ModelInfo[];
  updatedAt: string;
  defaultModel?: string | null;
}

export interface ModelCatalogConfig {
  echsClient?: EchsClient | null;
  fallbackModels?: string[] | null;
  cacheTtlMs?: number;
}

const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.2': 200_000,
  'gpt-5.1': 128_000
};

export function inferModelFamily(_modelId: string): ModelFamily {
  return 'echs';
}

export function normalizeModelInfo(input: ModelInfo | string): ModelInfo {
  if (typeof input === 'string') {
    const contextWindowTokens = DEFAULT_CONTEXT_WINDOWS[input] ?? null;
    return {
      id: input,
      family: 'echs',
      supportsReasoning: true,
      supportsTools: true,
      contextWindowTokens
    };
  }
  const family = input.family ?? inferModelFamily(input.id);
  const contextWindowTokens = normalizeContextWindowTokens(input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOWS[input.id]);
  return {
    id: input.id,
    family,
    label: input.label ?? null,
    supportsReasoning: input.supportsReasoning ?? true,
    supportsTools: input.supportsTools ?? true,
    defaultReasoning: input.defaultReasoning ?? null,
    contextWindowTokens,
    maxTokens: input.maxTokens ?? null,
    inputModalities: input.inputModalities ?? null
  };
}

function normalizeRemoteModel(item: unknown): ModelInfo | null {
  if (typeof item === 'string') {
    return normalizeModelInfo(item);
  }
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const idRaw = record['id'] ?? record['model'] ?? record['name'] ?? record['slug'];
  if (!idRaw) return null;
  const id = String(idRaw);
  const info: ModelInfo = {
    id,
    family: typeof record['family'] === 'string' ? record['family'] : 'echs',
    label: typeof record['label'] === 'string' ? record['label'] : typeof record['displayName'] === 'string' ? record['displayName'] : null,
    supportsReasoning: typeof record['supportsReasoning'] === 'boolean' ? record['supportsReasoning'] : true,
    supportsTools: typeof record['supportsTools'] === 'boolean' ? record['supportsTools'] : true,
    defaultReasoning: typeof record['defaultReasoning'] === 'string' ? record['defaultReasoning'] : null,
    contextWindowTokens: normalizeContextWindowTokens(
      record['contextWindowTokens'] ??
        record['context_window_tokens'] ??
        record['contextWindow'] ??
        record['context_window'] ??
        DEFAULT_CONTEXT_WINDOWS[id]
    ),
    maxTokens: normalizeContextWindowTokens(record['maxTokens'] ?? record['max_tokens']),
    inputModalities: Array.isArray(record['inputModalities'])
      ? record['inputModalities'].map(String)
      : Array.isArray(record['input'])
        ? record['input'].map(String)
        : null
  };
  return normalizeModelInfo(info);
}

function normalizeRemoteModelList(payload: unknown): ModelInfo[] {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.map(normalizeRemoteModel).filter((model): model is ModelInfo => Boolean(model));
  }
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record['items'])) {
      return record['items'].map(normalizeRemoteModel).filter((model): model is ModelInfo => Boolean(model));
    }
    if (Array.isArray(record['models'])) {
      return record['models'].map(normalizeRemoteModel).filter((model): model is ModelInfo => Boolean(model));
    }
  }
  return [];
}

function dedupeModels(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const model of models) {
    if (!model?.id) continue;
    const existing = byId.get(model.id);
    byId.set(model.id, existing ? normalizeModelInfo({ ...existing, ...model }) : normalizeModelInfo(model));
  }
  return Array.from(byId.values());
}

function normalizeContextWindowTokens(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

export function createModelCatalog(config: ModelCatalogConfig): { listModels: () => Promise<ModelCatalogSnapshot> } {
  const cacheTtlMs = Math.max(1000, Math.floor(config.cacheTtlMs ?? 60_000));
  let cachedAt = 0;
  let cached: ModelCatalogSnapshot = { items: [], updatedAt: new Date().toISOString() };

  const buildStaticModels = () => {
    const fallback = config.fallbackModels && config.fallbackModels.length > 0 ? config.fallbackModels : [];
    return dedupeModels(fallback.map((id) => normalizeModelInfo(id)));
  };

  const refresh = async () => {
    const models: ModelInfo[] = [];
    let defaultModel: string | null = null;
    let sawRemoteModels = false;
    if (config.echsClient) {
      try {
        const payload = await config.echsClient.listModels();
        if (payload) {
          const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
          if (typeof record?.['default_model'] === 'string') defaultModel = record['default_model'];
          if (typeof record?.['defaultModel'] === 'string') defaultModel = record['defaultModel'];
          const remoteModels = normalizeRemoteModelList(payload);
          if (remoteModels.length > 0) {
            sawRemoteModels = true;
            models.push(...remoteModels);
          }
        }
      } catch {
        // ignore remote model list failures
      }
    }
    if (!sawRemoteModels) models.push(...buildStaticModels());
    const items = dedupeModels(models);
    cached = {
      items,
      updatedAt: new Date().toISOString(),
      defaultModel: defaultModel ?? items[0]?.id ?? null
    };
    cachedAt = Date.now();
    return cached;
  };

  const listModels = async (): Promise<ModelCatalogSnapshot> => {
    if (Date.now() - cachedAt < cacheTtlMs && cached.items.length > 0) {
      return cached;
    }
    return await refresh();
  };

  return { listModels };
}

