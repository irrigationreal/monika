import { randomUUID } from 'node:crypto';
import type {
  EventStore,
  ExternalRef,
  ForumCoreEvent,
  IdempotencyStore,
  SurfaceEvent,
  SurfaceEventIngestor,
  SurfaceIngestResult
} from '@irrigationreal/codex-forum-core';
import type { ForumStore } from '../store';
import { nowIso } from '../db';

const SUPPORTED_SURFACE = 'web' as const;
const SUPPORTED_EVENT = 'post.created' as const;
const SUPPORTED_TOPIC_EVENT = 'topic.created' as const;

type WebPostPayload = {
  type: typeof SUPPORTED_EVENT;
  body?: string | null;
  topicId?: string | null;
  authorId?: string | null;
  parentPostId?: string | null;
  parentExternalId?: string | null;
};

type WebTopicPayload = {
  type: typeof SUPPORTED_TOPIC_EVENT;
  title?: string | null;
  body?: string | null;
  forumId?: string | null;
  authorId?: string | null;
};

type WebSurfaceEvent = SurfaceEvent & {
  payload: WebPostPayload | WebTopicPayload;
};

export class WebSurfaceEventIngestor implements SurfaceEventIngestor {
  private sequenceCounter = 0;

  constructor(
    private readonly store: ForumStore,
    private readonly eventStore: EventStore,
    private readonly idempotencyStore?: IdempotencyStore | undefined
  ) {}

  async ingest(event: SurfaceEvent): Promise<SurfaceIngestResult> {
    if (event.surfaceKind !== SUPPORTED_SURFACE) {
      return { accepted: false, reason: `unsupported surface: ${event.surfaceKind}` };
    }

    if (event.payload.type !== SUPPORTED_EVENT && event.payload.type !== SUPPORTED_TOPIC_EVENT) {
      return { accepted: false, reason: `unsupported event type: ${event.payload.type}` };
    }

    if (event.payload.type === SUPPORTED_TOPIC_EVENT) {
      return this.ingestTopicCreated(event as WebSurfaceEvent & { payload: WebTopicPayload });
    }

    const payload = event.payload as WebPostPayload;
    const body = payload.body?.toString() ?? '';
    if (!body.trim()) {
      return { accepted: false, reason: 'missing body' };
    }

    const topicId = payload.topicId ?? event.subject.scope ?? null;
    if (!topicId) {
      return { accepted: false, reason: 'missing topic' };
    }

    const authorId = payload.authorId ?? event.actor?.externalId ?? null;
    if (!authorId) {
      return { accepted: false, reason: 'missing author' };
    }

    const author = this.store.getIdentity(authorId);
    if (!author) {
      return { accepted: false, reason: 'author not found' };
    }

    if (event.externalEventId && this.idempotencyStore) {
      const seen = await this.idempotencyStore.has(event.surfaceId, event.externalEventId);
      if (seen) {
        return { accepted: false, reason: 'duplicate event' };
      }
    }

    const metadata = event.metadata as {
      silent?: boolean;
      sourceMessageId?: string | null;
      shouldDispatchRobot?: boolean;
      model?: string | null;
      reasoningEffort?: string | null;
      robotMode?: string | null;
    } | undefined;
    const parentPostId = payload.parentPostId ?? payload.parentExternalId ?? null;
    if (this.store.hasCompactionFence(topicId)) {
      return { accepted: false, reason: 'compaction recovery in progress' };
    }

    const post = this.store.createPost({
      topicId,
      body,
      authorId,
      parentPostId,
      silent: Boolean(metadata?.silent),
      sourceMessageId: metadata?.sourceMessageId ?? null
    });

    this.ensureExternalRef(event.subject, {
      mappedTopicId: topicId,
      mappedPostId: post.id
    });

    if (event.actor) {
      this.ensureExternalRef(event.actor, {
        mappedIdentityId: authorId
      });
    }

    const coreEvent = this.buildPostCreatedEvent({
      event,
      topicId,
      postId: post.id,
      authorId,
      metadata: metadata ?? null
    });

    const appendResult = await this.eventStore.append(coreEvent);

    if (event.externalEventId && this.idempotencyStore) {
      await this.idempotencyStore.mark(event.surfaceId, event.externalEventId, appendResult.id);
    }

    return {
      accepted: true,
      eventId: appendResult.id,
      topicId,
      postId: post.id
    };
  }

  private buildPostCreatedEvent({
    event,
    topicId,
    postId,
    authorId,
    metadata
  }: {
    event: SurfaceEvent;
    topicId: string;
    postId: string;
    authorId: string;
    metadata?: {
      silent?: boolean;
      shouldDispatchRobot?: boolean;
      model?: string | null;
      reasoningEffort?: string | null;
      robotMode?: string | null;
    } | null;
  }): ForumCoreEvent {
    const sequence = (this.sequenceCounter += 1);

    const base = {
      id: randomUUID(),
      type: 'post.created' as const,
      sequence,
      occurredAt: event.occurredAt,
      ingestedAt: nowIso(),
      source: {
        surfaceId: event.surfaceId,
        surfaceKind: event.surfaceKind,
        externalEventId: event.externalEventId ?? null,
        externalRef: event.subject
      },
      actorId: authorId,
      actorExternalRef: event.actor ?? null,
      payload: {
        postId,
        topicId,
        authorId
      }
    };

    if (metadata) {
      return {
        ...base,
        metadata: {
          silent: metadata.silent ?? null,
          shouldDispatchRobot: metadata.shouldDispatchRobot ?? null,
          model: metadata.model ?? null,
          reasoningEffort: metadata.reasoningEffort ?? null,
          robotMode: metadata.robotMode ?? null
        }
      };
    }

    return base;
  }

  private async ingestTopicCreated(
    event: WebSurfaceEvent & { payload: WebTopicPayload }
  ): Promise<SurfaceIngestResult> {
    const payload = event.payload;
    const title = payload.title?.toString().trim() ?? '';
    const body = payload.body?.toString() ?? '';
    if (!title || !body.trim()) {
      return { accepted: false, reason: 'missing title or body' };
    }

    const forumId = payload.forumId ?? event.subject.scope ?? null;
    if (!forumId) {
      return { accepted: false, reason: 'missing forum' };
    }

    const forum = this.store.getForum(forumId);
    if (!forum) {
      return { accepted: false, reason: 'forum not found' };
    }

    const authorId = payload.authorId ?? event.actor?.externalId ?? null;
    if (!authorId) {
      return { accepted: false, reason: 'missing author' };
    }

    const author = this.store.getIdentity(authorId);
    if (!author) {
      return { accepted: false, reason: 'author not found' };
    }

    if (event.externalEventId && this.idempotencyStore) {
      const seen = await this.idempotencyStore.has(event.surfaceId, event.externalEventId);
      if (seen) {
        return { accepted: false, reason: 'duplicate event' };
      }
    }

    const metadata = event.metadata as {
      silent?: boolean;
      robotMode?: string | null;
      shouldDispatchRobot?: boolean;
      model?: string | null;
      reasoningEffort?: string | null;
      firstPostExternalId?: string | null;
    } | undefined;

    const { topic, post } = this.store.createTopic({
      forumId,
      title,
      body,
      authorId,
      silent: Boolean(metadata?.silent),
      ...(metadata?.robotMode != null ? { robotMode: metadata.robotMode as "auto" | "mention" | "off" } : {})
    });

    this.ensureExternalRef(event.subject, {
      mappedForumId: forumId,
      mappedTopicId: topic.id
    });

    if (event.actor) {
      this.ensureExternalRef(event.actor, {
        mappedIdentityId: authorId
      });
    }

    if (metadata?.firstPostExternalId) {
      this.ensureExternalRef(
        {
          id: `ref-web-post-${metadata.firstPostExternalId}`,
          surfaceId: event.surfaceId,
          surfaceKind: event.surfaceKind,
          externalId: metadata.firstPostExternalId,
          kind: 'post',
          scope: topic.id,
          scopeKind: 'topic'
        },
        {
          mappedTopicId: topic.id,
          mappedPostId: post.id
        }
      );
    }

    const coreEvent: ForumCoreEvent = {
      id: randomUUID(),
      type: 'topic.created',
      sequence: (this.sequenceCounter += 1),
      occurredAt: event.occurredAt,
      ingestedAt: nowIso(),
      source: {
        surfaceId: event.surfaceId,
        surfaceKind: event.surfaceKind,
        externalEventId: event.externalEventId ?? null,
        externalRef: event.subject
      },
      actorId: authorId,
      actorExternalRef: event.actor ?? null,
      payload: {
        topicId: topic.id,
        forumId,
        title: topic.title,
        createdBy: authorId,
        firstPostId: post.id
      },
      metadata: {
        silent: metadata?.silent ?? null,
        robotMode: metadata?.robotMode ?? null,
        shouldDispatchRobot: metadata?.shouldDispatchRobot ?? null,
        model: metadata?.model ?? null,
        reasoningEffort: metadata?.reasoningEffort ?? null
      }
    };

    const appendResult = await this.eventStore.append(coreEvent);

    if (event.externalEventId && this.idempotencyStore) {
      await this.idempotencyStore.mark(event.surfaceId, event.externalEventId, appendResult.id);
    }

    return {
      accepted: true,
      eventId: appendResult.id,
      topicId: topic.id,
      postId: post.id
    };
  }

  private ensureExternalRef(ref: ExternalRef, mapping: {
    mappedForumId?: string | null;
    mappedTopicId?: string | null;
    mappedPostId?: string | null;
    mappedIdentityId?: string | null;
  }): void {
    const existing = this.store.getExternalRefByExternal(ref.surfaceId, ref.surfaceKind, ref.externalId);
    if (existing) {
      return;
    }

    this.store.createExternalRef({
      surfaceId: ref.surfaceId,
      surfaceKind: ref.surfaceKind,
      externalId: ref.externalId,
      kind: ref.kind,
      scope: ref.scope ?? null,
      scopeKind: ref.scopeKind ?? null,
      mappedForumId: mapping.mappedForumId ?? null,
      mappedTopicId: mapping.mappedTopicId ?? null,
      mappedPostId: mapping.mappedPostId ?? null,
      mappedIdentityId: mapping.mappedIdentityId ?? null
    });
  }
}
