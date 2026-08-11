import { InMemoryMessageTamperLayer } from '../messageTamper';
import { extractRobotTtsMarker } from '../tts';

import type {
  MessageTamperContext,
  MessageTamperLayer,
  MessageTamperTrailEntry,
  UtteranceOrigin,
} from '@irrigationreal/codex-forum-core';
import type { AssistantProjectionRow } from '../db';
import type { AttachmentHandoffInput, ForumStore } from '../store';

export type ContinuationMetadata = {
  sourceKind: 'subagent-completion';
  runId: string | null;
  runIds: string[];
  origins: Array<{ runId: string | null; turnId: string | null; postId: string | null; topicId: string | null }>;
  originTurnId: string | null;
  originPostId: string | null;
  originTopicId: string | null;
};

export type AssistantProjectionInput = {
  piSessionId: string;
  piMessageId: string;
  utteranceId: string;
  topicId: string;
  sessionId: string;
  rawText: string;
  parentPostId?: string | null;
  continuation?: unknown;
  attachmentRefs?: unknown;
  origin?: UtteranceOrigin | Record<string, unknown> | null;
  completion?: { threadId?: string | null } | null;
};

export type AssistantProjectionResult = {
  projection: AssistantProjectionRow;
  text: string;
  requestedTts: boolean;
  tamperTrail: MessageTamperTrailEntry[];
};

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    if (key && value) attrs[key] = value;
  }
  return attrs;
}

export function parseLegacyAttachmentMarkers(text: string, piMessageId: string): { text: string; handoffs: AttachmentHandoffInput[] } {
  const handoffs: AttachmentHandoffInput[] = [];
  let artifactIndex = 0;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      const marker = run[0] as '`' | '~';
      if (!fence) {
        fence = { marker, length: run.length };
      } else {
        const closing = line.trim();
        if (marker === fence.marker && closing.length >= fence.length
          && [...closing].every((char) => char === marker)) fence = null;
      }
      lines.push(line);
      continue;
    }
    if (!fence) {
      const artifact = /^\s*\[artifact\s+([^\]]+)\]\s*$/i.exec(line);
      if (artifact) {
        const attrs = parseAttrs(artifact[1] ?? '');
        const artifactPath = attrs['path'] ?? attrs['file'];
        if (artifactPath) {
          handoffs.push({
            refEntryId: `legacy-artifact:${piMessageId}:${artifactIndex++}`,
            sourceKind: 'legacy-artifact',
            sourceRef: {
              path: artifactPath,
              filename: attrs['filename'] ?? attrs['name'] ?? null,
              mimeType: attrs['mime'] ?? attrs['mimeType'] ?? null,
            },
          });
          continue;
        }
      }
      const marker = /^\s*\[forum-attachment\s+([^\]]+)\]\s*$/i.exec(line);
      if (marker) {
        const attrs = parseAttrs(marker[1] ?? '');
        const pendingAttachmentId = attrs['id'] ?? attrs['pendingAttachmentId'];
        if (pendingAttachmentId) {
          handoffs.push({
            refEntryId: `legacy-marker:${piMessageId}:${pendingAttachmentId}`,
            sourceKind: 'legacy-marker',
            sourceRef: { pendingAttachmentId },
          });
          continue;
        }
      }
    }
    lines.push(line);
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), handoffs };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Normalize agentd live-wire and session-export continuation shapes exactly once. */
export function normalizeContinuationMetadata(value: unknown): ContinuationMetadata | null {
  const values = Array.isArray(value) ? value : [value];
  for (const raw of values) {
    const outer = record(raw);
    if (!outer) continue;
    const data = record(outer['continuation']) ?? outer;
    const sourceKind = data['sourceKind'] ?? data['source_kind']
      ?? (outer['origin'] === 'subagent-completion' ? outer['origin'] : null);
    if (sourceKind !== 'subagent-completion') continue;
    const explicitRunId = stringOrNull(data['runId'] ?? data['run_id']
      ?? data['subagentRunId'] ?? data['subagent_run_id']);
    const rawRunIds = data['runIds'] ?? data['run_ids']
      ?? data['subagentRunIds'] ?? data['subagent_run_ids'];
    const runIds = [...new Set([
      ...(Array.isArray(rawRunIds) ? rawRunIds.map(stringOrNull).filter((id): id is string => Boolean(id)) : []),
      ...(explicitRunId ? [explicitRunId] : []),
    ])].slice(0, 100);
    const origin = record(data['origin']);
    const rawOrigins = data['origins'] ?? data['subagentOrigins'] ?? data['subagent_origins'];
    const origins = (Array.isArray(rawOrigins) ? rawOrigins : []).slice(0, 100).flatMap((rawOrigin) => {
      const item = record(rawOrigin);
      return item ? [{
        runId: stringOrNull(item['runId'] ?? item['run_id']),
        turnId: stringOrNull(item['turnId'] ?? item['turn_id']),
        postId: stringOrNull(item['postId'] ?? item['post_id']),
        topicId: stringOrNull(item['topicId'] ?? item['topic_id']),
      }] : [];
    });
    return {
      sourceKind: 'subagent-completion',
      runId: explicitRunId ?? runIds[0] ?? null,
      runIds,
      origins,
      originTurnId: stringOrNull(data['originTurnId'] ?? data['origin_turn_id'] ?? origin?.['turnId'] ?? origin?.['turn_id']),
      originPostId: stringOrNull(data['originPostId'] ?? data['origin_post_id'] ?? origin?.['postId'] ?? origin?.['post_id']),
      originTopicId: stringOrNull(data['originTopicId'] ?? data['origin_topic_id'] ?? origin?.['topicId'] ?? origin?.['topic_id']),
    };
  }
  return null;
}

function structuredHandoffs(value: unknown): AttachmentHandoffInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const ref = raw as Record<string, unknown>;
    const pendingId = ref['pendingAttachmentId'] ?? ref['pending_attachment_id'];
    const refEntryId = ref['refEntryId'] ?? ref['ref_entry_id'];
    if (typeof pendingId !== 'string' || typeof refEntryId !== 'string' || !refEntryId.trim()) return [];
    return [{
      refEntryId: refEntryId.trim(),
      sourceKind: 'structured-pending' as const,
      sourceRef: { ...ref, pendingAttachmentId: pendingId },
      expectedSha256: typeof ref['sha256'] === 'string' ? ref['sha256'] : null,
      expectedSizeBytes: Number.isSafeInteger(ref['sizeBytes'] ?? ref['size_bytes'])
        ? Number(ref['sizeBytes'] ?? ref['size_bytes']) : null,
    }];
  });
}

export class AssistantProjectionService {
  private readonly tamperLayer: MessageTamperLayer<MessageTamperContext>;

  constructor(
    private readonly store: ForumStore,
    opts: {
      tamperLayer?: MessageTamperLayer<MessageTamperContext>;
      onProjectionBegun?: (projection: AssistantProjectionRow) => Promise<void>;
    } = {}
  ) {
    this.tamperLayer = opts.tamperLayer ?? new InMemoryMessageTamperLayer();
    this.onProjectionBegun = opts.onProjectionBegun;
  }

  private readonly onProjectionBegun?: (projection: AssistantProjectionRow) => Promise<void>;

  async project(input: AssistantProjectionInput): Promise<AssistantProjectionResult> {
    const topic = this.store.getTopic(input.topicId);
    const continuation = normalizeContinuationMetadata(input.continuation);
    const originPost = continuation?.originPostId
      && (!continuation.originTopicId || continuation.originTopicId === input.topicId)
      ? this.store.getPost(continuation.originPostId) : null;
    const parentPostId = originPost?.topic_id === input.topicId
      ? originPost.id : continuation ? null : (input.parentPostId ?? null);
    const context: MessageTamperContext = {
      topicId: input.topicId,
      sessionId: input.sessionId,
      forumId: topic?.forum_id ?? null,
      parentPostId,
      actorId: null,
    };
    const stage1 = await this.tamperLayer.run({
      stage: 'outbound.codex_to_forum', direction: 'outbound', text: input.rawText, context,
    });
    const withPersona = this.applyDefaultPersona(input.topicId, stage1.text);
    const stage2 = await this.tamperLayer.run({
      stage: 'outbound.forum_post_body', direction: 'outbound', text: withPersona, context,
    });
    const markers = parseLegacyAttachmentMarkers(stage2.text, input.piMessageId);
    const tts = extractRobotTtsMarker(markers.text);
    const robot = this.store.getIdentityByKind('robot');
    if (!robot) throw new Error('robot identity is required for assistant projection');
    const metadata = {
      canonicalOutward: true,
      linkedBy: 'assistant-projection',
      origin: input.origin ?? null,
      ...(continuation ?? {}),
    };
    const trail = [...stage1.trail, ...stage2.trail];
    const projection = this.store.beginAssistantProjection({
      piSessionId: input.piSessionId,
      piMessageId: input.piMessageId,
      utteranceId: input.utteranceId,
      topicId: input.topicId,
      sessionId: input.sessionId,
      body: tts.cleanedText,
      authorId: robot.id,
      parentPostId,
      origin: input.origin ?? null,
      metadata,
      completionPayload: input.completion ? {
        threadId: input.completion.threadId ?? null,
        topicId: input.topicId,
        sessionId: input.sessionId,
        text: tts.cleanedText,
        piMessageId: input.piMessageId,
        utteranceId: input.utteranceId,
        origin: input.origin ?? null,
        requestedTts: tts.requested,
        tamperTrail: trail,
      } : null,
      handoffs: [...structuredHandoffs(input.attachmentRefs), ...markers.handoffs],
    });
    if (this.onProjectionBegun) await this.onProjectionBegun(projection);
    return { projection: this.store.getAssistantProjectionById(projection.id) ?? projection, text: tts.cleanedText, requestedTts: tts.requested, tamperTrail: trail };
  }

  private applyDefaultPersona(topicId: string, text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return text;
    const topic = this.store.getTopic(topicId);
    if (!topic) return text;
    const personas = this.store.listRobotPersonas(topic.forum_id);
    if (personas.length !== 1 || /\[\[persona:[a-z0-9][a-z0-9_-]{0,63}\]\][\s\S]*?\[\[\/persona\]\]/i.test(text)) return text;
    const key = personas[0]?.key;
    return key ? `[[persona:${key}]]\n${trimmed}\n[[/persona]]` : text;
  }
}
