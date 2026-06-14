import type { MessageTamperContext, MessageTamperPlugin } from '@irrigationreal/codex-forum-core';
import type { ForumStore } from './store';
import { renderPersonaGuideMarkdown } from './personaPrompt';
import {
  applyPromptEnhancer,
  normalizePromptEnhancerConfig,
  type PromptEnhancerConfig
} from './promptEnhancer';

export interface TamperPluginCatalogEntry {
  key: string;
  label: string;
  description: string;
  stages: string[];
  defaultDirection?: 'inbound' | 'outbound' | 'both';
  defaultOnlyFirstMessage?: boolean;
  defaultConfig?: Record<string, unknown> | null;
}

export interface PersonaPrefaceConfig {
  maxChars?: number;
  includeDescriptions?: boolean;
  includeSoulPaths?: boolean;
}

const PROMPT_ENHANCER_KEY = 'prompt.enhancer';
const PERSONA_PREFACE_KEY = 'persona.preface';

export function getTamperPluginCatalog(): TamperPluginCatalogEntry[] {
  return [
    {
      key: PROMPT_ENHANCER_KEY,
      label: 'Skill/Kb preface',
      description: 'Adds a local skills/kb context preface to the first inbound message.',
      stages: ['inbound.user_to_codex'],
      defaultDirection: 'inbound',
      defaultOnlyFirstMessage: true,
      defaultConfig: normalizePromptEnhancerConfig() as unknown as Record<string, unknown>
    }
  ];
}

export function createPromptEnhancerPlugin(options: {
  store: ForumStore;
  enabledByDefault: boolean;
  defaultPriority?: number;
  defaultOnlyFirstMessage?: boolean;
}): MessageTamperPlugin<MessageTamperContext> {
  const { store, enabledByDefault, defaultPriority, defaultOnlyFirstMessage } = options;
  return {
    key: PROMPT_ENHANCER_KEY,
    description: 'Inject a local skills/kb context preface into inbound messages.',
    priority: defaultPriority ?? 5,
    resolvePriority: ({ context, direction }) => {
      const forumId = context.forumId ?? null;
      const config = store.resolveTamperConfig(forumId, PROMPT_ENHANCER_KEY, direction);
      if (!config) return defaultPriority ?? 5;
      return config.priority;
    },
    stages: ['inbound.user_to_codex'],
    tamper: async ({ text, context, direction }) => {
      const forumId = context.forumId ?? null;
      const configRow = store.resolveTamperConfig(forumId, PROMPT_ENHANCER_KEY, direction);
      const enabled = configRow ? Boolean(configRow.enabled) : enabledByDefault;
      if (!enabled) {
        return { text, notes: { skipped: 'disabled' } };
      }
      const isFirstMessage = Boolean(context.metadata?.['isFirstMessage']);
      const config = parseConfig<PromptEnhancerConfig>(configRow?.config_json);
      const fallbackOnlyFirst =
        typeof config?.onlyFirstMessage === 'boolean' ? config.onlyFirstMessage : defaultOnlyFirstMessage ?? true;
      const onlyFirstMessage = resolveOnlyFirstMessage(configRow, fallbackOnlyFirst);
      if (onlyFirstMessage && !isFirstMessage) {
        return { text, notes: { skipped: 'not_first_message' } };
      }
      const resolvedConfig: PromptEnhancerConfig = {
        ...(config ?? {}),
        onlyFirstMessage
      };
      const result = applyPromptEnhancer({
        text,
        config: resolvedConfig,
        isFirstMessage
      });
      if (!result.preface) {
        return {
          text: result.cleanedText,
          notes: {
            skipped: result.skippedReason ?? 'no_preface',
            docs: result.docs.map((d) => d.path),
            usedTrigger: result.usedTrigger
          }
        };
      }
      return {
        text: `${result.preface}\n\n${result.cleanedText}`,
        notes: {
          docs: result.docs.map((d) => d.path),
          usedTrigger: result.usedTrigger,
          prefaceChars: result.preface.length
        }
      };
    }
  };
}

export function createPersonaPrefacePlugin(options: {
  store: ForumStore;
  enabledByDefault: boolean;
  defaultPriority?: number;
  defaultOnlyFirstMessage?: boolean;
}): MessageTamperPlugin<MessageTamperContext> {
  const { store, enabledByDefault, defaultPriority, defaultOnlyFirstMessage } = options;
  return {
    key: PERSONA_PREFACE_KEY,
    description: 'Inject persona usage guidance into inbound messages.',
    priority: defaultPriority ?? 4,
    resolvePriority: ({ context, direction }) => {
      const forumId = context.forumId ?? null;
      const config = store.resolveTamperConfig(forumId, PERSONA_PREFACE_KEY, direction);
      if (!config) return defaultPriority ?? 4;
      return config.priority;
    },
    stages: ['inbound.user_to_codex'],
    tamper: async ({ text, context, direction }) => {
      const forumId = context.forumId ?? null;
      if (!forumId) {
        return { text, notes: { skipped: 'no_forum' } };
      }
      const configRow = store.resolveTamperConfig(forumId, PERSONA_PREFACE_KEY, direction);
      const enabled = configRow ? Boolean(configRow.enabled) : enabledByDefault;
      if (!enabled) {
        return { text, notes: { skipped: 'disabled' } };
      }

      const onlyFirstMessage = resolveOnlyFirstMessage(configRow, defaultOnlyFirstMessage ?? true);
      const isFirstMessage = Boolean(context.metadata?.['isFirstMessage']);
      if (onlyFirstMessage && !isFirstMessage) {
        return { text, notes: { skipped: 'not_first_message' } };
      }

      const personas = store.listRobotPersonas(forumId);
      if (personas.length === 0) {
        return { text, notes: { skipped: 'no_personas' } };
      }

      const config = parseConfig<PersonaPrefaceConfig>(configRow?.config_json);
      const maxChars =
        Number.isFinite(config?.maxChars ?? NaN) ? Math.max(200, Number(config?.maxChars)) : undefined;
      const guideOptions: Parameters<typeof renderPersonaGuideMarkdown>[1] = {
        includeDescriptions: config?.includeDescriptions ?? true,
        includeSoulPaths: config?.includeSoulPaths ?? true
      };
      if (maxChars !== undefined) guideOptions!.maxChars = maxChars;
      const preface = renderPersonaGuideMarkdown(personas, guideOptions);
      if (!preface) {
        return { text, notes: { skipped: 'empty_preface' } };
      }

      return {
        text: `${preface}\n\n${text}`,
        notes: {
          personaKeys: personas.map((p) => p.key),
          prefaceChars: preface.length
        }
      };
    }
  };
}

export function createPromptEnhancerTestPlugin(options: {
  config?: PromptEnhancerConfig | null;
  priority?: number;
}): MessageTamperPlugin<MessageTamperContext> {
  return {
    key: PROMPT_ENHANCER_KEY,
    description: 'Test skill/kb preface with ad-hoc config.',
    priority: options.priority ?? 5,
    stages: ['inbound.user_to_codex'],
    tamper: async ({ text, context }) => {
      const result = applyPromptEnhancer({
        text,
        config: options.config ?? null,
        isFirstMessage: Boolean(context.metadata?.['isFirstMessage'])
      });
      if (!result.preface) {
        return {
          text: result.cleanedText,
          notes: {
            skipped: result.skippedReason ?? 'no_preface',
            docs: result.docs.map((d) => d.path),
            usedTrigger: result.usedTrigger
          }
        };
      }
      return {
        text: `${result.preface}\n\n${result.cleanedText}`,
        notes: {
          docs: result.docs.map((d) => d.path),
          usedTrigger: result.usedTrigger,
          prefaceChars: result.preface.length,
          mode: 'test'
        }
      };
    }
  };
}

function parseConfig<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function resolveOnlyFirstMessage(
  configRow: { only_first_message: number | null } | null | undefined,
  fallback: boolean
): boolean {
  if (!configRow) return fallback;
  if (configRow.only_first_message === null || configRow.only_first_message === undefined) return fallback;
  return Boolean(configRow.only_first_message);
}
