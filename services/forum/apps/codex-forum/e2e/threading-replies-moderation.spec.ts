import { expect, test } from '@playwright/test';

import type {
  CompactionOperationDto,
  ForumDto,
  ForumLastPostDto,
  IdentityDto,
  MessageDraftDto,
  MessageTemplateDto,
  PostDto,
  RecentPostDto,
  RobotStateDto,
  SessionContextDto,
  TopicDto,
  TopicOperationalEventDto,
} from '@irrigationreal/codex-forum-contracts';
import type { BrowserContext, Page, Request, Route } from '@playwright/test';

type ForumRecord = ForumDto;
type TopicRecord = TopicDto;
type PostRecord = PostDto;
type IdentityRecord = IdentityDto;

type FixtureResponse = {
  forumId: string;
  secondaryForumId: string;
  topicId: string;
  lockedTopicId: string | null;
  archivedTopicId: string | null;
  regularToken: string;
  moderatorToken: string;
  regularIdentityId: string;
  moderatorIdentityId: string;
};

type FixtureRequest = {
  postCount?: number;
  includeLocked?: boolean;
  includeArchived?: boolean;
};

type MockState = {
  baseTime: number;
  tick: number;
  topicSeq: number;
  postSeq: number;
  forums: ForumRecord[];
  topics: Record<string, TopicRecord>;
  postsByTopic: Record<string, PostRecord[]>;
  identities: Record<string, IdentityRecord>;
  permissionsByIdentity: Record<string, string[]>;
  tokens: Record<string, string>;
  fixture: FixtureResponse | null;
  lastMoveRequest: { topicId: string; forumId: string; silent: boolean } | null;
  operationalEventsByTopic: Record<string, TopicOperationalEventDto[]>;
  compactionOperations: Record<string, CompactionOperationDto>;
  compactionRequests: Array<Record<string, unknown>>;
  messageTemplates: MessageTemplateDto[];
  drafts: Record<string, MessageDraftDto>;
  quickReplyDockedByDefault: boolean;
  authDelayMs: number;
  topicHydrationDelayMs: number;
  topicHydrationPending: boolean;
  draftHydrationDelayMs: number;
  draftHydrationPending: boolean;
  sessionHydrationDelayMs: number;
  sessionHydrationPending: boolean;
  stateStreamOpened: boolean;
  robotActivity: RobotStateDto['activity'];
  sessionContext: SessionContextDto | null;
};

const REGULAR_TOKEN = 'token-regular';
const MODERATOR_TOKEN = 'token-moderator';
const REGULAR_ID = 'identity-regular';
const MODERATOR_ID = 'identity-moderator';

function createMockState(): MockState {
  const baseTime = Date.UTC(2024, 0, 2, 12, 0, 0);
  const now = new Date(baseTime).toISOString();

  const identities: Record<string, IdentityRecord> = {
    [REGULAR_ID]: {
      id: REGULAR_ID,
      tenantId: null,
      displayName: 'Regular User',
      kind: 'human',
      parentIdentityId: null,
      avatarUrl: null,
      location: 'Testville',
      signature: 'Stay curious.',
      theme: 'classic-light',
      postCount: 0,
      rank: 'Member',
      joinDate: now,
      createdAt: now,
      updatedAt: now,
    },
    [MODERATOR_ID]: {
      id: MODERATOR_ID,
      tenantId: null,
      displayName: 'Moderator',
      kind: 'admin',
      parentIdentityId: null,
      avatarUrl: null,
      location: 'Moderation Deck',
      signature: 'Keep it tidy.',
      theme: 'classic-light',
      postCount: 0,
      rank: 'Moderator',
      joinDate: now,
      createdAt: now,
      updatedAt: now,
    },
  };

  return {
    baseTime,
    tick: 0,
    topicSeq: 0,
    postSeq: 0,
    forums: [],
    topics: {},
    postsByTopic: {},
    identities,
    permissionsByIdentity: {
      [REGULAR_ID]: ['read', 'write'],
      [MODERATOR_ID]: ['read', 'write', 'mod.all', 'admin.all'],
    },
    tokens: {
      [REGULAR_TOKEN]: REGULAR_ID,
      [MODERATOR_TOKEN]: MODERATOR_ID,
    },
    fixture: null,
    lastMoveRequest: null,
    operationalEventsByTopic: {},
    compactionOperations: {},
    compactionRequests: [],
    quickReplyDockedByDefault: false,
    authDelayMs: 0,
    topicHydrationDelayMs: 0,
    topicHydrationPending: false,
    draftHydrationDelayMs: 0,
    draftHydrationPending: false,
    sessionHydrationDelayMs: 0,
    sessionHydrationPending: false,
    stateStreamOpened: false,
    robotActivity: 'idle',
    sessionContext: null,
    messageTemplates: [
      {
        id: 'template-reply',
        scope: 'personal',
        name: 'Review approval',
        category: 'Review',
        body: 'Approved after review.',
        threadTitle: null,
        forumScope: 'all',
        forumIds: [],
        contexts: ['reply'],
        enabled: true,
        sortOrder: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'template-thread',
        scope: 'system',
        name: 'Project kickoff',
        category: 'Project',
        body: 'Kickoff details for this project.',
        threadTitle: 'Project kickoff thread',
        forumScope: 'all',
        forumIds: [],
        contexts: ['new_thread'],
        enabled: true,
        sortOrder: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    drafts: {},
  };
}

function nextTimestamp(state: MockState): string {
  const timestamp = new Date(state.baseTime + state.tick * 1000).toISOString();
  state.tick += 1;
  return timestamp;
}

function seedFixtures(state: MockState, request: FixtureRequest = {}): FixtureResponse {
  state.forums = [];
  state.topics = {};
  state.postsByTopic = {};
  state.operationalEventsByTopic = {};
  state.compactionOperations = {};
  state.compactionRequests = [];
  state.drafts = {};
  state.tick = 0;
  state.topicSeq = 0;
  state.postSeq = 0;

  const forumId = 'forum-1';
  const secondaryForumId = 'forum-2';
  const createdAt = nextTimestamp(state);

  state.forums.push({
    id: forumId,
    tenantId: null,
    parentForumId: null,
    category: 'Main',
    name: 'General Discussion',
    description: 'Mock forum for threading E2E coverage.',
    status: 'active',
    visibility: 'public',
    archivedAt: null,
    threadCount: 0,
    postCount: 0,
    lastPost: null,
    createdAt,
    updatedAt: createdAt,
  });

  state.forums.push({
    id: secondaryForumId,
    tenantId: null,
    parentForumId: null,
    category: 'Support',
    name: 'Help Desk',
    description: 'Secondary forum for moderation move tests.',
    status: 'active',
    visibility: 'public',
    archivedAt: null,
    threadCount: 0,
    postCount: 0,
    lastPost: null,
    createdAt,
    updatedAt: createdAt,
  });

  const normalTopicId = addTopic(state, {
    forumId,
    title: 'Baseline Thread',
    status: 'open',
    tags: [],
    createdBy: REGULAR_ID,
    postCount: request.postCount ?? 2,
  });

  const anchorPostId = state.postsByTopic[normalTopicId]?.[0]?.id ?? null;
  state.operationalEventsByTopic[normalTopicId] = [
    {
    id: 'overflow-event-1',
    topicId: normalTopicId,
    anchorPostId,
    type: 'turn_error',
    category: 'assistant',
    status: 'failed',
    summary: 'Assistant response failed.',
    detail: {
      category: 'context_overflow',
        error:
          'Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.',
    },
    sourceKind: 'echs_turn',
    sourceId: 'pi-message-1',
      createdAt: nextTimestamp(state),
    },
  ];

  const lockedTopicId = request.includeLocked
    ? addTopic(state, {
      forumId,
      title: 'Locked Thread',
      status: 'locked',
      tags: [],
      createdBy: REGULAR_ID,
        postCount: 1,
    })
    : null;

  const archivedTopicId = request.includeArchived
    ? addTopic(state, {
      forumId,
      title: 'Archived Thread',
      status: 'archived',
      tags: [],
      createdBy: REGULAR_ID,
        postCount: 1,
    })
    : null;

  recomputeForumStats(state, forumId);
  recomputeForumStats(state, secondaryForumId);

  const fixture: FixtureResponse = {
    forumId,
    secondaryForumId,
    topicId: normalTopicId,
    lockedTopicId,
    archivedTopicId,
    regularToken: REGULAR_TOKEN,
    moderatorToken: MODERATOR_TOKEN,
    regularIdentityId: REGULAR_ID,
    moderatorIdentityId: MODERATOR_ID,
  };
  state.fixture = fixture;
  return fixture;
}

function addTopic(
  state: MockState,
  input: {
    forumId: string;
    title: string;
    status: TopicDto['status'];
    tags: string[];
    createdBy: string;
    postCount: number;
  }
): string {
  state.topicSeq += 1;
  const topicId = `topic-${state.topicSeq}`;
  const createdAt = nextTimestamp(state);
  const createdByName = state.identities[input.createdBy]?.displayName ?? 'Unknown';
  const posts: PostRecord[] = [];

  for (let i = 0; i < input.postCount; i += 1) {
    posts.push(
      createPostRecord(state, {
      topicId,
      authorId: input.createdBy,
        body: i === 0 ? `Opening message for ${input.title}.` : `Follow-up ${i} for ${input.title}.`,
      })
    );
  }

  const lastPost = posts[posts.length - 1];

  state.topics[topicId] = {
    id: topicId,
    forumId: input.forumId,
    tenantId: null,
    title: input.title,
    status: input.status,
    tags: [...input.tags],
    robotMode: 'auto',
    createdBy: input.createdBy,
    createdByName,
    createdAt,
    updatedAt: lastPost.createdAt,
    postCount: posts.length,
    lastPostAuthorId: lastPost.authorId,
    lastPostAuthorName: state.identities[lastPost.authorId]?.displayName ?? 'Unknown',
    lastPostAt: lastPost.createdAt,
  };

  state.postsByTopic[topicId] = posts;
  return topicId;
}

function createPostRecord(
  state: MockState,
  input: {
    topicId: string;
    authorId: string;
    body: string;
    silent?: boolean;
  }
): PostRecord {
  const createdAt = nextTimestamp(state);
  state.postSeq += 1;
  const postId = `post-${state.postSeq}`;
  const identity = state.identities[input.authorId];
  if (identity) {
    identity.postCount += 1;
    identity.updatedAt = createdAt;
  }
  return {
    id: postId,
    topicId: input.topicId,
    tenantId: null,
    parentPostId: null,
    authorId: input.authorId,
    body: input.body,
    sourceMessageId: null,
    silent: input.silent ?? false,
    createdAt,
    editedAt: null,
    deletedAt: null,
    reactionCounts: [],
  };
}

function recomputeForumStats(state: MockState, forumId: string): void {
  const forum = state.forums.find((item) => item.id === forumId);
  if (!forum) return;
  const topics = Object.values(state.topics).filter((topic) => topic.forumId === forumId);
  forum.threadCount = topics.length;
  forum.postCount = topics.reduce((total, topic) => total + topic.postCount, 0);

  let lastPost: ForumLastPostDto | null = null;
  for (const topic of topics) {
    const posts = state.postsByTopic[topic.id] ?? [];
    const candidate = posts[posts.length - 1];
    if (!candidate) continue;
    if (!lastPost || candidate.createdAt > lastPost.createdAt) {
      lastPost = {
        postId: candidate.id,
        topicId: topic.id,
        topicTitle: topic.title,
        authorId: candidate.authorId,
        authorName: state.identities[candidate.authorId]?.displayName ?? 'Unknown',
        createdAt: candidate.createdAt,
      };
    }
  }

  forum.lastPost = lastPost;
  forum.updatedAt = lastPost?.createdAt ?? forum.updatedAt;
}

function listTopicsForForum(state: MockState, forumId: string): TopicRecord[] {
  return Object.values(state.topics)
    .filter((topic) => topic.forumId === forumId)
    .sort((a, b) => (a.lastPostAt > b.lastPostAt ? -1 : 1));
}

function listRecentPosts(state: MockState, limit: number): RecentPostDto[] {
  const allPosts = Object.values(state.postsByTopic).flat();
  return allPosts
    .slice()
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
    .slice(0, limit)
    .map((post) => {
      const topic = state.topics[post.topicId];
      const forum = state.forums.find((item) => item.id === topic.forumId);
      return {
        postId: post.id,
        topicId: post.topicId,
        topicTitle: topic.title,
        forumId: topic.forumId,
        forumName: forum?.name ?? 'Forum',
        authorId: post.authorId,
        authorName: state.identities[post.authorId]?.displayName ?? 'Unknown',
        body: post.body,
        createdAt: post.createdAt,
      };
    });
}

async function attachMockApi(target: Page | BrowserContext, state: MockState): Promise<void> {
  await target.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    const method = request.method().toUpperCase();
    const payload = await readJson(request);

    if (path === '/api/test/fixtures' && method === 'POST') {
      const fixture = seedFixtures(state, payload ?? {});
      await fulfillJson(route, 200, fixture);
      return;
    }

    if (path === '/api/auth/me' && method === 'GET') {
      if (state.authDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.authDelayMs));
      const identity = identityFromRequest(state, request);
      await fulfillJson(route, 200, {
        identity: identity
          ? {
            ...identity,
              hasPrivateEmail: false,
              quickReplyDockedByDefault: state.quickReplyDockedByDefault,
          }
          : null,
      });
      return;
    }

    if (path === '/api/me/preferences/quick-reply' && method === 'PATCH') {
      state.quickReplyDockedByDefault = Boolean(payload?.quickReplyDockedByDefault);
      await fulfillJson(route, 200, {
        ok: true,
        quickReplyDockedByDefault: state.quickReplyDockedByDefault,
      });
      return;
    }

    if (path === '/api/identities/' + REGULAR_ID + '/permissions' && method === 'GET') {
      await fulfillJson(route, 200, { permissions: state.permissionsByIdentity[REGULAR_ID] ?? [] });
      return;
    }

    if (path === '/api/identities/' + MODERATOR_ID + '/permissions' && method === 'GET') {
      await fulfillJson(route, 200, { permissions: state.permissionsByIdentity[MODERATOR_ID] ?? [] });
      return;
    }

    if (path === '/api/forums' && method === 'GET') {
      await fulfillJson(route, 200, state.forums);
      return;
    }

    if (path === '/api/drafts' && method === 'GET') {
      await fulfillJson(route, 200, { drafts: Object.values(state.drafts) });
      return;
    }

    const draftMatch = path.match(/^\/api\/drafts\/([^/]+)$/);
    if (draftMatch) {
      const id = draftMatch[1];
      const current = id ? state.drafts[id] : undefined;
      if (method === 'GET') {
        await fulfillJson(route, current ? 200 : 404, { draft: current ?? null });
        return;
      }
      if (method === 'DELETE') {
        const revision = Number(url.searchParams.get('revision'));
        if (current && current.revision !== revision) {
          await fulfillJson(route, 409, { message: 'Draft changed in another session' });
          return;
        }
        if (id && current) delete state.drafts[id];
        await fulfillJson(route, current ? 200 : 404, current ? { ok: true } : { message: 'Draft not found' });
        return;
      }
      if (method === 'PUT' && id && current) {
        if (current.revision !== Number(payload?.expectedRevision)) {
          await fulfillJson(route, 409, { message: 'Draft changed in another session' });
          return;
        }
        const updated = {
          ...current,
          title: payload?.title ?? null,
          body: payload?.body ?? '',
          revision: current.revision + 1,
          updatedAt: nextTimestamp(state),
        };
        state.drafts[id] = updated;
        await fulfillJson(route, 200, { draft: updated });
        return;
      }
    }

    const forumDraftMatch = path.match(/^\/api\/forums\/([^/]+)\/drafts$/);
    if (forumDraftMatch) {
      const forumId = forumDraftMatch[1] ?? '';
      if (method === 'GET') {
        await fulfillJson(route, 200, {
          drafts: Object.values(state.drafts).filter(
            (item) => item.context === 'new_thread' && item.forumId === forumId
          ),
        });
        return;
      }
      if (method === 'POST') {
        if (Number(payload?.expectedRevision) !== 0) {
          await fulfillJson(route, 409, { message: 'Draft changed in another session' });
          return;
        }
        const id = `draft-${Object.keys(state.drafts).length + 1}`;
        const now = nextTimestamp(state);
        const created: MessageDraftDto = {
          id,
          context: 'new_thread',
          forumId,
          topicId: null,
          title: payload?.title ?? null,
          body: payload?.body ?? '',
          revision: 1,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(Date.parse(now) + 30 * 86400000).toISOString(),
          destinationName: state.forums.find((item) => item.id === forumId)?.name ?? null,
          canContinue: true,
        };
        state.drafts[id] = created;
        await fulfillJson(route, 200, { draft: created });
        return;
      }
    }

    const replyDraftMatch = path.match(/^\/api\/topics\/([^/]+)\/draft$/);
    if (replyDraftMatch) {
      const topicId = replyDraftMatch[1] ?? '';
      const current =
        Object.values(state.drafts).find((item) => item.context === 'reply' && item.topicId === topicId) ?? null;
      if (method === 'GET') {
        state.draftHydrationPending = true;
        if (state.draftHydrationDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.draftHydrationDelayMs));
        }
        await fulfillJson(route, 200, { draft: current });
        state.draftHydrationPending = false;
        return;
      }
      if (method === 'PUT') {
        if (Number(payload?.expectedRevision) !== (current?.revision ?? 0)) {
          await fulfillJson(route, 409, { message: 'Draft changed in another session' });
          return;
        }
        const now = nextTimestamp(state);
        const id = current?.id ?? `draft-${Object.keys(state.drafts).length + 1}`;
        const updated: MessageDraftDto = {
          id,
          context: 'reply',
          forumId: null,
          topicId,
          title: null,
          body: payload?.body ?? '',
          revision: (current?.revision ?? 0) + 1,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
          expiresAt: new Date(Date.parse(now) + 30 * 86400000).toISOString(),
          destinationName: state.topics[topicId]?.title ?? null,
          canContinue: true,
        };
        state.drafts[id] = updated;
        await fulfillJson(route, 200, { draft: updated });
        return;
      }
    }

    if (path === '/api/message-templates/effective' && method === 'GET') {
      const context = url.searchParams.get('context');
      await fulfillJson(route, 200, {
        templates: state.messageTemplates.filter(
          (template) => template.enabled && template.contexts.includes(context as 'reply' | 'new_thread')
        ),
      });
      return;
    }

    if (path === '/api/message-templates/mine' && method === 'GET') {
      await fulfillJson(route, 200, {
        templates: state.messageTemplates.filter((template) => template.scope === 'personal'),
      });
      return;
    }

    if (path.startsWith('/api/forums/') && path.endsWith('/topics')) {
      const forumId = path.split('/')[3];
      if (method === 'GET') {
        await fulfillJson(route, 200, {
          page: 1,
          pageSize: 50,
          total: listTopicsForForum(state, forumId).length,
          items: listTopicsForForum(state, forumId),
        });
        return;
      }
      if (method === 'POST') {
        const title = payload?.title ?? 'Untitled';
        const body = payload?.body ?? '';
        const author = identityFromRequest(state, request) ?? state.identities[REGULAR_ID];
        const draftReference = payload?.draft as { id?: string; revision?: number } | undefined;
        const publicationDraft = draftReference?.id ? state.drafts[draftReference.id] : undefined;
        if (
          draftReference &&
          (!publicationDraft ||
            publicationDraft.context !== 'new_thread' ||
            publicationDraft.forumId !== forumId ||
            publicationDraft.revision !== draftReference.revision)
        ) {
          await fulfillJson(route, 409, { message: 'Draft changed in another session' });
          return;
        }
        const topicId = addTopic(state, {
          forumId,
          title,
          status: 'open',
          tags: [],
          createdBy: author.id,
          postCount: 1,
        });
        state.postsByTopic[topicId][0].body = body;
        const topic = state.topics[topicId];
        if (draftReference?.id) delete state.drafts[draftReference.id];
        recomputeForumStats(state, forumId);
        await fulfillJson(route, 200, topic);
        return;
      }
    }

    if (path === '/api/posts/recent' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '3');
      await fulfillJson(route, 200, listRecentPosts(state, limit));
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/posts')) {
      const topicId = path.split('/')[3];
      if (method === 'GET') {
        state.topicHydrationPending = true;
        if (state.topicHydrationDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.topicHydrationDelayMs));
        }
        const posts = state.postsByTopic[topicId] ?? [];
        await fulfillJson(route, 200, {
          page: 1,
          pageSize: 50,
          total: posts.length,
          items: posts,
        });
        state.topicHydrationPending = false;
        return;
      }
      if (method === 'POST') {
        const topicRecord = state.topics[topicId];
        if (topicRecord && topicRecord.status !== 'open') {
          await fulfillJson(route, 403, { message: 'Cannot reply to a locked or archived topic.' });
          return;
        }
        const author = identityFromRequest(state, request) ?? state.identities[REGULAR_ID];
        const body = payload?.body ?? '';
        const draftReference = payload?.draft as { id?: string; revision?: number } | undefined;
        const publicationDraft = draftReference?.id ? state.drafts[draftReference.id] : undefined;
        if (
          draftReference &&
          (!publicationDraft ||
            publicationDraft.context !== 'reply' ||
            publicationDraft.topicId !== topicId ||
            publicationDraft.revision !== draftReference.revision)
        ) {
          await fulfillJson(route, 409, { message: 'Draft changed in another session' });
          return;
        }
        const post = createPostRecord(state, {
          topicId,
          authorId: author.id,
          body,
          silent: payload?.silent ?? false,
        });
        const posts = state.postsByTopic[topicId] ?? [];
        posts.push(post);
        state.postsByTopic[topicId] = posts;
        if (topicRecord) {
          topicRecord.postCount = posts.length;
          topicRecord.lastPostAt = post.createdAt;
          topicRecord.lastPostAuthorId = post.authorId;
          topicRecord.lastPostAuthorName = state.identities[post.authorId]?.displayName ?? 'Unknown';
          topicRecord.updatedAt = post.createdAt;
        }
        if (draftReference?.id) delete state.drafts[draftReference.id];
        recomputeForumStats(state, topicRecord?.forumId ?? '');
        await fulfillJson(route, 200, post);
        return;
      }
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/operational-events') && method === 'GET') {
      const topicId = path.split('/')[3];
      await fulfillJson(route, 200, { items: state.operationalEventsByTopic[topicId] ?? [] });
      return;
    }

    if (/^\/api\/topics\/[^/]+\/compactions$/.test(path) && method === 'GET') {
      const topicId = path.split('/')[3];
      const operations = Object.values(state.compactionOperations).filter((operation) => operation.topicId === topicId);
      const latest = operations.at(-1) ?? null;
      const active =
        operations.find((operation) => operation.status === 'pending' || operation.status === 'running') ?? null;
      await fulfillJson(route, 200, {
        active,
        latest,
        checkpointDispatch: latest?.recoveryPostId ? { status: 'dispatched', errorMessage: null } : null,
      });
      return;
    }

    if (/^\/api\/topics\/[^/]+\/compactions$/.test(path) && method === 'POST') {
      const topicId = path.split('/')[3];
      const requestPayload = (payload ?? {}) as unknown as Record<string, unknown>;
      state.compactionRequests.push(requestPayload);
      const operationId = String(requestPayload['operationId'] ?? 'missing-operation-id');
      const operation: CompactionOperationDto = {
        id: operationId,
        topicId,
        sessionId: 'session-1',
        initiatedBy: MODERATOR_ID,
        expectedLeafId: 'leaf-1',
        customInstructions: null,
        recoveryPrompt: String(requestPayload['recoveryPrompt'] ?? ''),
        status: 'succeeded',
        eventId: 'compaction-event-1',
        recoveryPostId: 'recovery-post-1',
        errorMessage: null,
        createdAt: nextTimestamp(state),
        startedAt: nextTimestamp(state),
        finishedAt: nextTimestamp(state),
      };
      state.compactionOperations[operationId] = operation;
      await fulfillJson(route, 202, operation);
      return;
    }

    if (/^\/api\/topics\/[^/]+\/compactions\/[^/]+\/retry-checkpoint$/.test(path) && method === 'POST') {
      const operationId = path.split('/')[5];
      const operation = state.compactionOperations[operationId] ?? null;
      await fulfillJson(route, operation ? 200 : 404, {
        active: null,
        latest: operation,
        checkpointDispatch: operation ? { status: 'pending', errorMessage: null } : null,
      });
      return;
    }

    if (/^\/api\/topics\/[^/]+\/compactions\/[^/]+$/.test(path) && method === 'GET') {
      const operationId = path.split('/')[5];
      const operation = state.compactionOperations[operationId];
      await fulfillJson(route, operation ? 200 : 404, operation ?? { message: 'Compaction not found.' });
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/status') && method === 'PATCH') {
      const topicId = path.split('/')[3];
      const topic = state.topics[topicId];
      if (!topic) {
        await fulfillJson(route, 404, { message: 'Topic not found.' });
        return;
      }
      topic.status = payload?.status ?? topic.status;
      topic.updatedAt = nextTimestamp(state);
      await fulfillJson(route, 200, topic);
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/tags') && method === 'PATCH') {
      const topicId = path.split('/')[3];
      const topic = state.topics[topicId];
      if (!topic) {
        await fulfillJson(route, 404, { message: 'Topic not found.' });
        return;
      }
      const sticky = Boolean(payload?.sticky);
      topic.tags = sticky
        ? Array.from(new Set([...topic.tags, 'sticky']))
        : topic.tags.filter((tag) => tag !== 'sticky');
      topic.updatedAt = nextTimestamp(state);
      await fulfillJson(route, 200, topic);
      return;
    }

    if (path.startsWith('/api/topics/') && method === 'PATCH' && path.split('/').length === 4) {
      const topicId = path.split('/')[3];
      const topic = state.topics[topicId];
      if (!topic) {
        await fulfillJson(route, 404, { message: 'Topic not found.' });
        return;
      }
      if (typeof payload?.title === 'string') {
        topic.title = payload.title;
        topic.updatedAt = nextTimestamp(state);
        const forum = state.forums.find((item) => item.id === topic.forumId);
        if (forum?.lastPost?.topicId === topic.id) {
          forum.lastPost.topicTitle = payload.title;
        }
      }
      await fulfillJson(route, 200, topic);
      return;
    }

    if (path.startsWith('/api/topics/') && method === 'GET' && path.split('/').length === 4) {
      const topicId = path.split('/')[3];
      const topic = state.topics[topicId];
      if (!topic) {
        await fulfillJson(route, 404, { message: 'Topic not found.' });
        return;
      }
      await fulfillJson(route, 200, topic);
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/identities') && method === 'GET') {
      const topicId = path.split('/')[3];
      const posts = state.postsByTopic[topicId] ?? [];
      const unique = Array.from(new Set(posts.map((post) => post.authorId)));
      const items = unique.map((id) => state.identities[id]).filter(Boolean);
      await fulfillJson(route, 200, { page: 1, pageSize: 50, total: items.length, items });
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/personas') && method === 'GET') {
      await fulfillJson(route, 200, { items: [] });
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/state') && method === 'GET') {
      const topicId = path.split('/')[3];
      const statePayload: RobotStateDto = {
        topicId,
        sessionId: 'session-1',
        activity: state.robotActivity,
        model: null,
        reasoningEffort: null,
        lastUpdatedAt: nextTimestamp(state),
        currentPlan: null,
        context: state.sessionContext,
        recentToolRuns: [],
      };
      await fulfillJson(route, 200, statePayload);
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/session') && method === 'GET') {
      state.sessionHydrationPending = true;
      if (state.sessionHydrationDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.sessionHydrationDelayMs));
      }
      await fulfillJson(route, 200, null);
      state.sessionHydrationPending = false;
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/state/stream')) {
      state.stateStreamOpened = true;
      const topicId = path.split('/')[3];
      const streamState: RobotStateDto = {
        topicId,
        sessionId: 'session-1',
        activity: state.robotActivity,
        model: null,
        reasoningEffort: null,
        lastUpdatedAt: nextTimestamp(state),
        currentPlan: null,
        context: state.sessionContext,
        recentToolRuns: [],
      };
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `event: state\ndata: ${JSON.stringify(streamState)}\n\n`,
      });
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/attachments') && method === 'GET') {
      await fulfillJson(route, 200, { itemsByPostId: {} });
      return;
    }

    if (path.startsWith('/api/posts/') && path.endsWith('/attachments') && method === 'GET') {
      await fulfillJson(route, 200, []);
      return;
    }

    if (path.startsWith('/api/posts/') && method === 'PATCH') {
      const postId = path.split('/')[3];
      for (const posts of Object.values(state.postsByTopic)) {
        const post = posts.find((item) => item.id === postId);
        if (post) {
          post.body = payload?.body ?? post.body;
          post.editedAt = nextTimestamp(state);
          await fulfillJson(route, 200, post);
          return;
        }
      }
      await fulfillJson(route, 404, { message: 'Post not found.' });
      return;
    }

    if (path.startsWith('/api/posts/') && method === 'DELETE') {
      const postId = path.split('/')[3];
      for (const [topicId, posts] of Object.entries(state.postsByTopic)) {
        const index = posts.findIndex((item) => item.id === postId);
        if (index >= 0) {
          const [removed] = posts.splice(index, 1);
          const topic = state.topics[topicId];
          if (topic) {
            topic.postCount = posts.length;
            const lastPost = posts[posts.length - 1];
            if (lastPost) {
              topic.lastPostAt = lastPost.createdAt;
              topic.lastPostAuthorId = lastPost.authorId;
              topic.lastPostAuthorName = state.identities[lastPost.authorId]?.displayName ?? 'Unknown';
              topic.updatedAt = lastPost.createdAt;
            }
            recomputeForumStats(state, topic.forumId);
          }
          await fulfillJson(route, 200, removed);
          return;
        }
      }
      await fulfillJson(route, 404, { message: 'Post not found.' });
      return;
    }

    if (path.startsWith('/api/admin/topics/') && path.endsWith('/move') && method === 'POST') {
      const topicId = path.split('/')[4];
      const forumId = payload?.forumId;
      const topic = state.topics[topicId];
      if (!topic) {
        await fulfillJson(route, 404, { message: 'Topic not found.' });
        return;
      }
      const oldForumId = topic.forumId;
      state.lastMoveRequest = { topicId, forumId, silent: Boolean(payload?.silent) };
      topic.forumId = forumId;
      topic.updatedAt = nextTimestamp(state);
      recomputeForumStats(state, oldForumId);
      recomputeForumStats(state, forumId);
      await fulfillJson(route, 200, {
        topic,
        move: {
          id: `move-${topicId}`,
          topicId,
          fromForumId: oldForumId,
          toForumId: forumId,
          movedBy: 'admin',
          movedAt: topic.updatedAt,
          markerPostId: null,
          needsReprompt: !payload?.silent,
          silent: Boolean(payload?.silent),
        },
      });
      return;
    }

    await fulfillJson(route, 500, { message: `Unmocked request: ${method} ${path}` });
  });
}

function identityFromRequest(state: MockState, request: Request): IdentityRecord | null {
  const cookie = request.headers()['cookie'] ?? '';
  const token = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('cforum_session='))
    ?.slice('cforum_session='.length);
  const identityId = token ? state.tokens[token] : null;
  return identityId ? (state.identities[identityId] ?? null) : null;
}

async function readJson(request: Request): Promise<FixtureRequest | null> {
  const body = request.postData();
  if (!body) return null;
  try {
    return JSON.parse(body) as FixtureRequest;
  } catch {
    return null;
  }
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createFixture(page: Page, payload: FixtureRequest): Promise<FixtureResponse> {
  return await page.evaluate(async (fixturePayload) => {
    const res = await fetch('/api/test/fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixturePayload),
    });
    if (!res.ok) {
      throw new Error(`Fixture request failed: ${res.status}`);
    }
    return res.json();
  }, payload);
}

async function setAuthTokens(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript((value) => {
      document.cookie = `cforum_session=${value}; path=/; SameSite=Lax`;
  }, token);
}

async function expectAdminToolsHidden(page: Page): Promise<void> {
  await expect(page.locator('button', { hasText: 'Admin Tools' })).toHaveCount(0);
}

function topicRowForTitle(page: Page, title: string) {
  return page.locator('.vb-table-row', { has: page.locator('.vb-thread-title', { hasText: title }) });
}

function postTextList(page: Page) {
  return page.locator('.vb-post-text');
}

function quickReplyBox(page: Page) {
  return page.locator('.vb-quick-reply textarea');
}

async function themedStyleSnapshot(
  page: Page,
  selector: string,
  tokens: { background?: string; color?: string; border?: string }
): Promise<{ actual: Record<string, string>; expected: Record<string, string> }> {
  return page.locator(selector).evaluate((element, requestedTokens) => {
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.pointerEvents = 'none';
    const requestedEntries = Object.entries(requestedTokens).filter((entry): entry is [string, string] =>
      Boolean(entry[1])
    );
    for (const [property, token] of requestedEntries) {
      probe.style.setProperty(`--resolved-${property}`, `var(${token})`);
    }
    if (requestedTokens.background) probe.style.background = `var(${requestedTokens.background})`;
    if (requestedTokens.color) probe.style.color = `var(${requestedTokens.color})`;
    if (requestedTokens.border) probe.style.border = `1px solid var(${requestedTokens.border})`;
    document.body.appendChild(probe);
    const actualStyle = getComputedStyle(element);
    const expectedStyle = getComputedStyle(probe);
    const unresolvedTokens = requestedEntries
      .filter(([property]) => !expectedStyle.getPropertyValue(`--resolved-${property}`).trim())
      .map(([, token]) => token);
    if (unresolvedTokens.length) {
      probe.remove();
      throw new Error(`CSS custom properties resolved empty: ${unresolvedTokens.join(', ')}`);
    }
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    if (requestedTokens.background) {
      actual['backgroundColor'] = actualStyle.backgroundColor;
      expected['backgroundColor'] = expectedStyle.backgroundColor;
    }
    if (requestedTokens.color) {
      actual['color'] = actualStyle.color;
      expected['color'] = expectedStyle.color;
    }
    if (requestedTokens.border) {
      actual['borderColor'] = actualStyle.borderLeftColor;
      expected['borderColor'] = expectedStyle.borderLeftColor;
    }
    probe.remove();
    return { actual, expected };
  }, tokens);
}

async function expectThemedStyle(
  page: Page,
  selector: string,
  tokens: { background?: string; color?: string; border?: string }
): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await themedStyleSnapshot(page, selector, tokens);
        return Object.keys(snapshot.expected)
          .filter((property) => snapshot.actual[property] !== snapshot.expected[property])
          .map((property) => `${property}: ${snapshot.actual[property]} !== ${snapshot.expected[property]}`);
      },
      { message: `${selector} should use requested theme tokens` }
    )
    .toEqual([]);
}

test.describe('Threading and reply flows', () => {
  test.describe.configure({ mode: 'serial' });
  test('create new thread with preview, BBCode insertions, validation, and cancel confirmation', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    await page.goto(`/forums/${fixture.forumId}/newthread`);
    await expect(page).toHaveURL(new RegExp(`/forums/${fixture.forumId}/newthread`));

    await page.fill('#thread-title', 'Hi');
    await page.fill('.vb-editor-textarea', 'short');
    await expect(page.locator('.vb-form-error', { hasText: 'Title must be at least 3 characters.' })).toBeVisible();
    await expect(page.locator('.vb-form-error', { hasText: 'Message must be at least 10 characters.' })).toBeVisible();
    await expect(page.locator('.vb-btn-primary', { hasText: 'Submit New Thread' })).toBeDisabled();

    await page.fill('.vb-editor-textarea', '');
    await page.click('.vb-editor-btn[title="Bold"]');
    await expect(page.locator('.vb-editor-textarea')).toHaveValue('[B][/B]');
    await page.click('.vb-editor-btn[title="Insert Link"]');
    await expect(page.locator('.vb-editor-textarea')).toHaveValue(/\[URL=/);

    const editor = page.locator('.vb-editor-textarea');
    await editor.fill('prefix value suffix');
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(7, 12));
    await page.click('.vb-editor-btn[title="Code"]');
    await expect(editor).toHaveValue(['prefix ', '```', 'value', '```', ' suffix'].join('\n'));

    await page.fill('.vb-editor-textarea', 'Preview content for the thread.');
    await page.click('button:has-text("Show Preview")');
    await expect(page.locator('.vb-preview-panel')).toBeVisible();
    await expect(page.locator('.vb-preview-body')).toContainText('Preview content for the thread.');

    await expect(page).toHaveURL(new RegExp(`/forums/${fixture.forumId}/newthread\\?draft=draft-`));
    await page.getByRole('button', { name: 'Discard draft' }).click();
    const discardDialog = page.getByRole('dialog', { name: 'Discard draft?' });
    await expect(discardDialog).toBeVisible();
    await expect(discardDialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await discardDialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('.vb-editor-textarea')).toHaveValue('Preview content for the thread.');

    await page.getByRole('button', { name: 'Discard draft' }).click();
    await discardDialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(page.locator('.vb-editor-textarea')).toHaveValue('');

    await page.goto(`/forums/${fixture.forumId}`);
    await page.click('button:has-text("New Thread")');
    await expect(page).toHaveURL(new RegExp(`/forums/${fixture.forumId}/newthread`));

    await page.click('button:has-text("Back (keep draft)")');
    await expect(page).toHaveURL(new RegExp(`/forums/${fixture.forumId}$`));

    await page.goto(`/forums/${fixture.forumId}/newthread`);
    await page.fill('#thread-title', 'Shipping Roadmap Q1');
    await page.fill('.vb-editor-textarea', 'Here is the full thread body with enough detail.');
    await page.click('button:has-text("Show Preview")');
    await expect(page.locator('.vb-preview-panel')).toBeVisible();

    await page.click('button:has-text("Submit New Thread")');
    await expect(page).toHaveURL(/\/topics\/topic-\d+$/);
    await expect(page.locator('.vb-thread-titlebar h2')).toContainText('Shipping Roadmap Q1');
    await expect(postTextList(page).first()).toContainText('Here is the full thread body');

    await page.goto(`/forums/${fixture.forumId}`);
    await page.reload();
    const topicRow = topicRowForTitle(page, 'Shipping Roadmap Q1');
    await expect(topicRow).toBeVisible();
    await expect(topicRow.locator('.vb-lastpost-author').first()).toContainText('Regular User');
  });

  test('My Drafts requires forum confirmation before permanent deletion', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    await page.goto(`/forums/${fixture.forumId}/newthread`);
    await page.fill('#thread-title', 'Draft awaiting review');
    await page.fill('.vb-editor-textarea', 'This draft should remain until deletion is explicitly confirmed.');
    await expect.poll(() => Object.keys(state.drafts).length).toBe(1);

    await page.goto('/profile/drafts');
    const draftCard = page.locator('.vb-draft-card', { hasText: 'Draft awaiting review' });
    await expect(draftCard).toBeVisible();
    await draftCard.getByRole('button', { name: 'Delete' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete draft?' });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Keep draft' }).click();
    await expect(draftCard).toBeVisible();
    expect(Object.keys(state.drafts)).toHaveLength(1);

    await draftCard.getByRole('button', { name: 'Delete' }).click();
    await deleteDialog.getByRole('button', { name: 'Delete draft', exact: true }).click();
    await expect(draftCard).toHaveCount(0);
    expect(Object.keys(state.drafts)).toHaveLength(0);
  });

  test('fenced code blocks form one themed shell across light, dark, and narrow layouts', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 1 });
    const firstPost = state.postsByTopic[fixture.topicId]?.[0];
    if (!firstPost) throw new Error('Code-block fixture post unavailable');
    firstPost.body = ['````markdown', '```js', 'console.log("inside")', '```', '````'].join('\n');

    await page.goto(`/topics/${fixture.topicId}`);
    const block = page.locator('.vb-code-block');
    await expect(block).toHaveCount(1);
    await expect(block.locator('.vb-code-content')).toContainText('```js');
    await expect(block.locator('.vb-code-content')).toContainText('console.log("inside")');

    for (const theme of ['classic-dark', 'classic-light']) {
      await page.evaluate((themeKey) => document.documentElement.setAttribute('data-theme', themeKey), theme);
      await expectThemedStyle(page, '.vb-code-block', {
        background: '--bg-code',
        color: '--text-code',
        border: '--border-default',
      });
      await expectThemedStyle(page, '.vb-code-toolbar', { background: '--bg-code' });
      await expectThemedStyle(page, 'pre.vb-code', { background: '--bg-code', color: '--text-code' });
      await expect(block.locator('.vb-code-content')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }

    await page.setViewportSize({ width: 390, height: 800 });
    const blockBox = await block.boundingBox();
    const contentBox = await page.locator('.vb-post-content').first().boundingBox();
    expect(blockBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    if (!blockBox || !contentBox) throw new Error('Code-block responsive layout boxes unavailable');
    expect(blockBox.width).toBeLessThanOrEqual(contentBox.width + 1);
  });

  test('docked Quick Reply appears before slow topic enrichment and never flashes inline', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    state.quickReplyDockedByDefault = true;
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    const deepLinkPage = await context.newPage();
    await attachMockApi(deepLinkPage, state);
    await deepLinkPage.addInitScript(() => {
      (window as any).__quickReplyFirstClass = null;
      const capture = () => {
        const composer = document.getElementById('quick-reply-composer');
        if (composer && !(window as any).__quickReplyFirstClass) {
          (window as any).__quickReplyFirstClass = composer.className;
        }
      };
      const observe = () => {
        new MutationObserver(capture).observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        capture();
      };
      if (document.documentElement) observe();
      else document.addEventListener('DOMContentLoaded', observe, { once: true });
    });
    state.authDelayMs = 350;
    state.topicHydrationDelayMs = 2500;
    state.draftHydrationDelayMs = 2500;
    state.sessionHydrationDelayMs = 2500;

    const navigation = deepLinkPage.goto(`/topics/${fixture.topicId}`);
    const composer = deepLinkPage.locator('#quick-reply-composer');
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    expect(state.topicHydrationPending).toBe(true);
    await expect.poll(() => state.draftHydrationPending).toBe(true);
    await composer.getByRole('button', { name: 'Expand' }).click();
    await quickReplyBox(deepLinkPage).fill('Typed before draft hydration');
    const firstClass = await deepLinkPage.evaluate(() => (window as any).__quickReplyFirstClass as string | null);
    expect(firstClass).toContain('vb-quick-reply--docked');
    expect(firstClass).toContain('vb-quick-reply--collapsed');
    expect(firstClass).not.toContain('vb-quick-reply--expanded');
    await navigation;
    await expect.poll(() => state.topicHydrationPending).toBe(false);
    await expect.poll(() => state.draftHydrationPending).toBe(false);
    await expect(quickReplyBox(deepLinkPage)).toHaveValue('Typed before draft hydration');
    await expect.poll(() => state.stateStreamOpened).toBe(true);
    expect(state.sessionHydrationPending).toBe(true);
    await expect.poll(() => state.sessionHydrationPending).toBe(false);

    await deepLinkPage.goto(`/topics/${fixture.topicId}/reply`);
    await expect(deepLinkPage.locator('.vb-editor-textarea')).toBeVisible();
    state.stateStreamOpened = false;
    await deepLinkPage.getByRole('button', { name: 'Back (keep draft)' }).click();
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await expect.poll(() => state.stateStreamOpened).toBe(true);
    await deepLinkPage.close();
  });

  test('topic edge controls scroll within the current page without changing navigation', async ({ page, context }) => {
    const state = createMockState();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 12 });
    await page.addInitScript(() => {
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) {
        const calls = ((window as any).__topicScrollIntoViewCalls ??= []);
        calls.push({ id: (this as HTMLElement).id, options });
        return originalScrollIntoView.call(this, options);
      };

      const originalScrollTo = window.scrollTo;
      window.scrollTo = function (...args: Parameters<typeof window.scrollTo>) {
        ((window as any).__topicScrollToCalls ??= []).push(args);
        return originalScrollTo.apply(window, args);
      };
    });
    await page.goto(`/topics/${fixture.topicId}`);

    const upperPager = page.locator('.vb-controls:not(.vb-controls-bottom) .vb-pagination-controls');
    const lowerPager = page.locator('.vb-controls-bottom .vb-pagination-controls');
    await expect(upperPager.locator('.vb-page-btn').first()).toHaveText('Bottom');
    await expect(lowerPager.locator('.vb-page-btn').first()).toHaveText('Top');
    await expect(upperPager.locator('.vb-page-btn').nth(1)).toHaveText('« Prev');
    await expect(lowerPager.locator('.vb-page-btn').nth(1)).toHaveText('« Prev');
    await expect(upperPager.locator('.vb-page-btn').last()).toHaveText('»»');
    await expect(lowerPager.locator('.vb-page-btn').last()).toHaveText('»»');

    const initialUrl = page.url();
    await upperPager.getByRole('button', { name: 'Scroll to bottom of current page' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__topicScrollIntoViewCalls?.at(-1)?.id)).toBe('8');
    expect(await page.evaluate(() => (window as any).__topicScrollIntoViewCalls.at(-1).options)).toMatchObject({
      behavior: 'auto',
      block: 'start',
    });
    expect(page.url()).toBe(initialUrl);

    await page.getByRole('button', { name: 'Search this Thread' }).click();
    await page.getByPlaceholder('Search posts...').fill('Follow-up 2');
    await upperPager.getByRole('button', { name: 'Scroll to bottom of current page' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__topicScrollIntoViewCalls?.at(-1)?.id)).toBe('3');
    expect(page.url()).toBe(initialUrl);

    state.robotActivity = 'thinking';
    await page.reload();
    await upperPager.locator('.vb-page-btn', { hasText: '2' }).click();
    await expect(page).toHaveURL(/\?page=2$/);
    const pageTwoUrl = page.url();
    await upperPager.getByRole('button', { name: 'Scroll to bottom of current page' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__topicScrollIntoViewCalls?.at(-1)?.id)).toBe('13');
    expect(page.url()).toBe(pageTwoUrl);

    await lowerPager.getByRole('button', { name: 'Scroll to top of page' }).click();
    expect(await page.evaluate(() => (window as any).__topicScrollToCalls.at(-1)[0])).toMatchObject({
      top: 0,
      behavior: 'auto',
    });
    expect(page.url()).toBe(pageTwoUrl);

    await page.setViewportSize({ width: 390, height: 600 });
    expect(await upperPager.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await lowerPager.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  test('latest-post controls follow an active response onto its tentative page', async ({ page, context }) => {
    const state = createMockState();
    state.robotActivity = 'thinking';
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 8 });
    await page.addInitScript(() => {
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) {
        const calls = ((window as any).__topicScrollIntoViewCalls ??= []);
        calls.push({ id: (this as HTMLElement).id, options });
        return originalScrollIntoView.call(this, options);
      };
    });
    await page.goto(`/topics/${fixture.topicId}?page=1#3`);

    const upperLatest = page
      .locator('.vb-controls:not(.vb-controls-bottom) .vb-pagination-controls')
      .getByRole('button', { name: 'Jump to response in progress' });
    const lowerLatest = page
      .locator('.vb-controls-bottom .vb-pagination-controls')
      .getByRole('button', { name: 'Jump to response in progress' });
    await expect(upperLatest).toBeEnabled();
    await expect(lowerLatest).toBeEnabled();

    await upperLatest.click();

    await expect(page).toHaveURL(new RegExp(`/topics/${fixture.topicId}\\?page=2$`));
    await expect(page.locator('.vb-live-turn')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__topicScrollIntoViewCalls?.at(-1)?.id)).toBe('9');
    expect(await page.evaluate(() => (window as any).__topicScrollIntoViewCalls.at(-1).options)).toMatchObject({
      behavior: 'auto',
      block: 'start',
    });
  });

  test('quick reply dock preserves controls, scroll chaining, focus, files, and layout across presentations', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    state.quickReplyDockedByDefault = true;
    state.sessionContext = {
      model: 'openai/gpt-5.2',
      provider: 'openai',
      modelId: 'gpt-5.2',
      thinkingLevel: 'high',
      contextWindowTokens: 200_000,
      usedTokens: 48_000,
      remainingTokens: 152_000,
      percent: 24,
      exact: true,
      source: 'e2e-fixture',
      asOfPiMessageId: 'pi-message-context',
    };
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 12, includeLocked: true });
    const topic = state.topics[fixture.topicId];
    if (!topic) throw new Error('Quick Reply topic fixture unavailable');
    topic.robotMode = 'mention';

    await page.goto(`/topics/${fixture.topicId}`);
    const composer = page.locator('#quick-reply-composer');
    const textarea = quickReplyBox(page);
    const scrollRegion = composer.locator('.vb-quick-reply-scroll-region');
    const submit = composer.getByRole('button', { name: 'Post Quick Reply' });
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await expect(textarea).toBeHidden();
    await expect(textarea).toHaveCount(1);
    await composer.getByRole('button', { name: 'Expand' }).click();
    await expect(composer).toHaveClass(/vb-quick-reply--expanded/);
    await expect(textarea).toBeVisible();
    await expect(page.getByRole('button', { name: 'Quick Reply', exact: true })).toHaveCount(0);

    const options = composer.getByRole('button', { name: 'Options' });
    await expect(options).toHaveAttribute('aria-expanded', 'false');
    const controlledIds = (await options.getAttribute('aria-controls'))?.split(/\s+/).filter(Boolean) ?? [];
    expect(controlledIds).toEqual([
      'quick-reply-template',
      'quick-reply-attachment-picker',
      'quick-reply-auto-compact',
    ]);
    for (const id of controlledIds) {
      const controlled = composer.locator(`#${id}`);
      await expect(controlled, `aria-controls target #${id}`).toHaveCount(1);
      await expect(controlled).toBeHidden();
    }
    await expect(textarea).toBeVisible();
    await expect(composer.locator('#quick-reply-model-options')).toBeVisible();
    await expect(composer.locator('#quick-reply-context')).toBeVisible();
    await expect(composer.getByRole('link', { name: 'Open full editor' })).toBeHidden();
    await expect(submit).toBeVisible();
    await options.click();
    await expect(options).toHaveAttribute('aria-expanded', 'true');
    await expect(composer.getByRole('link', { name: 'Open full editor' })).toBeVisible();
    const orderedControls = await composer
      .locator(
        'label[for="quick-reply-message"], #quick-reply-template, .vb-draft-status, #quick-reply-message, #quick-reply-attachment-picker, .vb-attachment-selected, #quick-reply-model-options, .vb-reply-options-callout, #quick-reply-auto-compact, #quick-reply-context, .vb-quick-reply-submit'
      )
      .evaluateAll((elements) => elements.map((element) => element.id || element.className || element.tagName));
    expect(orderedControls[0]).toBe('LABEL');
    expect(orderedControls[1]).toBe('quick-reply-template');
    expect(orderedControls[2]).toContain('vb-draft-status');
    expect(orderedControls.slice(3, 10)).toEqual([
      'quick-reply-message',
      'quick-reply-attachment-picker',
      'quick-reply-model-options',
      'vb-reply-options-callout',
      'quick-reply-auto-compact',
      'quick-reply-context',
      'vb-btn vb-quick-reply-submit',
    ]);

    await textarea.fill('Dock state survives');
    await expect(composer).toContainText('Draft saved');
    await composer.locator('input[type="file"]').setInputFiles({
      name: 'dock-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('dock attachment'),
    });
    await expect(composer.locator('.vb-attachment-selected')).toContainText('dock-note.txt');

    const footerBox = await composer.locator('.vb-quick-reply-footer').boundingBox();
    const submitBox = await submit.boundingBox();
    const scrollBox = await scrollRegion.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    if (!footerBox || !submitBox || !scrollBox) throw new Error('Quick Reply dock boxes unavailable');
    expect(submitBox.width).toBeGreaterThanOrEqual(footerBox.width - 22);
    expect(submitBox.y).toBeGreaterThanOrEqual(scrollBox.y + scrollBox.height - 1);
    expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(footerBox.y + footerBox.height + 1);

    await page.evaluate(() => window.scrollTo(0, 0));
    await scrollRegion.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await scrollRegion.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await composer.getByRole('button', { name: 'Collapse' }).click();
    const expand = composer.getByRole('button', { name: 'Expand' });
    await expect(expand).toBeFocused();
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await expect(composer.locator('.vb-quick-reply-compact-status')).toContainText('Draft saved');
    await expect(textarea).toBeHidden();
    await expect(textarea).toHaveCount(1);

    await page.getByRole('button', { name: 'Quote' }).first().click();
    await expect(composer).toHaveClass(/vb-quick-reply--expanded/);
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue(/\[QUOTE=/);
    await expect(composer.locator('.vb-attachment-selected')).toContainText('dock-note.txt');

    await page.evaluate(() => {
      const elementPrototype = Element.prototype as any;
      const originalScrollIntoView = elementPrototype.scrollIntoView;
      elementPrototype.scrollIntoView = function (options?: ScrollIntoViewOptions) {
        (window as any).__quickReplyScrollOptions = options;
        return originalScrollIntoView.call(this, options);
      };
    });
    await composer.getByRole('button', { name: 'Undock' }).click();
    await expect(composer).not.toHaveClass(/vb-quick-reply--docked/);
    await expect(composer.getByRole('button', { name: 'Keep Quick Reply visible while reading' })).toBeFocused();
    await expect.poll(() => page.evaluate(() => (window as any).__quickReplyScrollOptions?.behavior)).toBe('auto');
    await scrollRegion.hover();
    const inlineBeforeWheel = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, -300);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(inlineBeforeWheel);

    await page.getByRole('button', { name: 'Quote' }).nth(1).click();
    await expect(composer).not.toHaveClass(/vb-quick-reply--docked/);
    await expect(textarea).toBeFocused();

    await composer.getByRole('button', { name: 'Keep Quick Reply visible while reading' }).click();
    await expect(composer).toHaveClass(/vb-quick-reply--expanded/);
    await page.getByRole('button', { name: 'Quote' }).nth(2).click();
    await expect(composer).toHaveClass(/vb-quick-reply--expanded/);
    await expect(textarea).toBeFocused();

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Selected files are not saved with drafts');
      await dialog.dismiss();
    });
    await composer.getByRole('link', { name: 'Open full editor' }).click();
    await expect(page).toHaveURL(new RegExp(`/topics/${fixture.topicId}$`));
    await expect(composer.locator('.vb-attachment-selected')).toContainText('dock-note.txt');

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const scrollTop = page.locator('.vb-scroll-top');
    await expect(scrollTop).toHaveClass(/visible/);
    const transitionProperties = await scrollTop.evaluate((element) =>
      getComputedStyle(element)
        .transitionProperty.split(',')
        .map((property) => property.trim())
    );
    expect(transitionProperties).not.toContain('all');
    expect(transitionProperties).not.toContain('bottom');
    const dockBox = await composer.boundingBox();
    const scrollTopBox = await scrollTop.boundingBox();
    expect(dockBox).not.toBeNull();
    expect(scrollTopBox).not.toBeNull();
    if (!dockBox || !scrollTopBox) throw new Error('Quick Reply dock layout boxes unavailable');
    expect(scrollTopBox.y + scrollTopBox.height).toBeLessThanOrEqual(dockBox.y + 1);
    const reservedBottom = await page
      .locator('.vb-topic-with-reply-dock--expanded')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
    expect(reservedBottom).toBeCloseTo(dockBox.height + 12, 0);

    await expect(options).toHaveAttribute('aria-expanded', 'true');
    await composer.locator('input[type="file"]').setInputFiles([]);
    await textarea.fill('Post and return to reading');
    await submit.click();
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await expect(textarea).toHaveValue('');
    await composer.getByRole('button', { name: 'Expand' }).click();
    await expect(options).toHaveAttribute('aria-expanded', 'false');
    await expect(composer.locator('#quick-reply-model-options')).toBeVisible();
    await expect(composer.locator('#quick-reply-context')).toBeVisible();

    expect(fixture.lockedTopicId).not.toBeNull();
    await page.goto(`/topics/${fixture.lockedTopicId}`);
    await expect(page.locator('.vb-locked-badge')).toBeVisible();
    await expect(composer).not.toHaveClass(/vb-quick-reply--docked/);
    await expect(composer.getByRole('button', { name: 'Keep Quick Reply visible while reading' })).toHaveCount(0);
    await page.goto(`/topics/${fixture.topicId}`);
    await expect(page.locator('.vb-locked-badge')).toHaveCount(0);
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);

    state.robotActivity = 'thinking';
    await page.reload();
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await composer.getByRole('button', { name: 'Expand' }).click();
    await options.click();
    await textarea.fill('@robot steer without closing the composer');
    const steer = composer.getByRole('button', { name: 'Steer Reply' });
    await expect(steer).toBeVisible();
    await steer.click();
    await expect(composer).toHaveClass(/vb-quick-reply--expanded/);
    await expect(options).toHaveAttribute('aria-expanded', 'false');
    await expect(textarea).toHaveValue('');

    state.robotActivity = 'idle';
    await page.setViewportSize({ width: 390, height: 800 });
    await page.reload();
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await expect(textarea).toBeHidden();
    await page.getByRole('button', { name: 'Quote' }).first().click();
    await expect(composer).toHaveClass(/vb-quick-reply--expanded/);
    await expect(textarea).toBeFocused();
    const mobileFooterBox = await composer.locator('.vb-quick-reply-footer').boundingBox();
    const mobileSubmitBox = await composer.getByRole('button', { name: 'Post Quick Reply' }).boundingBox();
    expect(mobileFooterBox).not.toBeNull();
    expect(mobileSubmitBox).not.toBeNull();
    if (!mobileFooterBox || !mobileSubmitBox) throw new Error('Mobile Quick Reply action boxes unavailable');
    expect(mobileSubmitBox.width).toBeGreaterThanOrEqual(mobileFooterBox.width - 22);
  });

  test('quick reply dock keeps header and full-width action reachable below 288px viewport height', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    state.quickReplyDockedByDefault = true;
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.setViewportSize({ width: 568, height: 240 });
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 3 });

    await page.goto(`/topics/${fixture.topicId}`);
    const composer = page.locator('#quick-reply-composer');
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await composer.getByRole('button', { name: 'Expand' }).click();

    const options = composer.getByRole('button', { name: 'Options' });
    const controlledIds = (await options.getAttribute('aria-controls'))?.split(/\s+/).filter(Boolean) ?? [];
    expect(controlledIds).toEqual([
      'quick-reply-template',
      'quick-reply-attachment-picker',
      'quick-reply-auto-compact',
    ]);
    for (const id of controlledIds) {
      const controlled = composer.locator(`#${id}`);
      await expect(controlled, `aria-controls target #${id}`).toHaveCount(1);
      await expect(controlled).toBeHidden();
    }

    const header = composer.locator('.vb-quick-reply-header');
    const collapse = composer.getByRole('button', { name: 'Collapse' });
    const undock = composer.getByRole('button', { name: 'Undock' });
    const footer = composer.locator('.vb-quick-reply-footer');
    const submit = composer.getByRole('button', { name: 'Post Quick Reply' });
    await expect(collapse).toBeVisible();
    await expect(undock).toBeVisible();
    await expect(submit).toBeVisible();

    const [composerBox, headerBox, collapseBox, undockBox, footerBox, submitBox] = await Promise.all([
      composer.boundingBox(),
      header.boundingBox(),
      collapse.boundingBox(),
      undock.boundingBox(),
      footer.boundingBox(),
      submit.boundingBox(),
    ]);
    if (!composerBox || !headerBox || !collapseBox || !undockBox || !footerBox || !submitBox) {
      throw new Error('Short-viewport Quick Reply boxes unavailable');
    }
    expect(composerBox.y).toBeGreaterThanOrEqual(11);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(241);
    expect(footerBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
    expect(collapseBox.y).toBeGreaterThanOrEqual(headerBox.y);
    expect(undockBox.y).toBeGreaterThanOrEqual(headerBox.y);
    expect(collapseBox.y + collapseBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height + 1);
    expect(undockBox.y + undockBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height + 1);
    expect(submitBox.width).toBeGreaterThanOrEqual(footerBox.width - 22);
    expect(submitBox.y).toBeGreaterThanOrEqual(footerBox.y);
    expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(footerBox.y + footerBox.height + 1);

    await collapse.click();
    await expect(composer).toHaveClass(/vb-quick-reply--collapsed/);
    await composer.getByRole('button', { name: 'Undock' }).click();
    await expect(composer.getByRole('button', { name: 'Keep Quick Reply visible while reading' })).toBeFocused();
  });

  test('autosaved reply is shared by quick and full composers and consumed on post', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    await page.goto(`/topics/${fixture.topicId}`);
    await quickReplyBox(page).fill('Crash-safe shared reply');
    await expect(page.locator('.vb-quick-reply')).toContainText('Draft saved');
    await page.goto(`/topics/${fixture.topicId}/reply`);
    await expect(page.locator('.vb-editor-textarea')).toHaveValue('Crash-safe shared reply');
    await page.locator('.vb-editor-textarea').fill('Updated from full reply');
    await expect
      .poll(() => Object.values(state.drafts).find((item) => item.context === 'reply')?.body)
      .toBe('Updated from full reply');
    await page.goto(`/topics/${fixture.topicId}`);
    await expect(quickReplyBox(page)).toHaveValue('Updated from full reply');
    await page.locator('.vb-quick-reply button', { hasText: 'Post Quick Reply' }).click();
    await expect.poll(() => Object.keys(state.drafts).length).toBe(0);
  });

  test('message template insertion autosaves and follows the shared reply draft into full reply', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    await page.goto(`/topics/${fixture.topicId}`);
    await page.locator('.vb-quick-reply').getByRole('button', { name: 'Options' }).click();
    const quickPicker = page.locator('.vb-quick-reply [data-testid="message-template-picker"]');
    await quickPicker.locator('[data-testid="message-template-select"]').selectOption('template-reply');
    await quickPicker.locator('[data-testid="message-template-insert"]').click();
    await expect(quickReplyBox(page)).toHaveValue('Approved after review.');

    await page.click('button:has-text("Post Reply")');
    const fullPicker = page.locator('.vb-newthread-form [data-testid="message-template-picker"]');
    await expect(fullPicker).toBeVisible();
    await expect(page.locator('.vb-editor-textarea')).toHaveValue('Approved after review.');
  });

  test('new-thread template fills body and preserves a non-empty title', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 1 });
    await page.goto(`/forums/${fixture.forumId}/newthread`);
    await page.fill('#thread-title', 'My existing title');
    const picker = page.locator('[data-testid="message-template-picker"]');
    await picker.locator('[data-testid="message-template-select"]').selectOption('template-thread');
    await picker.locator('[data-testid="message-template-insert"]').click();
    await expect(page.locator('.vb-editor-textarea')).toHaveValue('Kickoff details for this project.');
    await expect(page.locator('#thread-title')).toHaveValue('My existing title');

    await page.fill('#thread-title', '');
    await page.fill('.vb-editor-textarea', '');
    await picker.locator('[data-testid="message-template-insert"]').click();
    await expect(page.locator('#thread-title')).toHaveValue('Project kickoff thread');
  });

  test('message template controls follow theme tokens and remain aligned', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 1 });

    for (const theme of ['classic-dark', 'classic-light', 'cn-portal-2000s']) {
      await page.goto(`/topics/${fixture.topicId}`);
      await page.locator('.vb-quick-reply').getByRole('button', { name: 'Options' }).click();
      await expect(page.locator('[data-testid="message-template-select"]')).toBeEnabled();
      await page.evaluate((themeKey) => document.documentElement.setAttribute('data-theme', themeKey), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectThemedStyle(page, '[data-testid="message-template-select"]', {
        background: '--bg-input',
        color: '--text-primary',
        border: '--border-strong',
      });
      await expectThemedStyle(page, '.vb-template-label', { color: '--text-primary' });
      await expectThemedStyle(page, '.vb-template-manage', { color: '--text-primary' });
      await page.locator('[data-testid="message-template-select"]').selectOption('template-reply');
      await expectThemedStyle(page, '.vb-template-preview-heading', {
        background: '--bg-surface-muted',
        color: '--text-primary',
      });

      await page.goto('/profile/message-templates');
      await expect(page.locator('[data-testid="message-template-manager"]')).toBeVisible();
      await page.evaluate((themeKey) => document.documentElement.setAttribute('data-theme', themeKey), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectThemedStyle(page, '[data-testid="message-template-name"]', {
        background: '--bg-input',
        color: '--text-primary',
        border: '--border-strong',
      });
      await expectThemedStyle(page, '[data-testid="message-templates-panel"]', {
        background: '--bg-surface-alt',
        color: '--text-primary',
        border: '--border-muted',
      });
      await expectThemedStyle(page, '.vb-template-name', { color: '--text-primary' });
      await expectThemedStyle(page, '.vb-template-preview-label', {
        background: '--bg-surface-muted',
        color: '--text-primary',
      });
    }

    const enabledLabel = page.locator('.vb-template-enabled');
    expect(await enabledLabel.evaluate((element) => getComputedStyle(element).display)).toMatch(/^(inline-)?flex$/);
    await expect(enabledLabel).toHaveCSS('align-items', 'center');
    const checkboxBox = await page.locator('[data-testid="message-template-enabled"]').boundingBox();
    const labelBox = await page.locator('[data-testid="message-template-enabled-label"]').boundingBox();
    expect(checkboxBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    if (!checkboxBox || !labelBox) throw new Error('Enabled checkbox alignment boxes unavailable');
    expect(Math.abs(checkboxBox.y + checkboxBox.height / 2 - (labelBox.y + labelBox.height / 2))).toBeLessThan(3);

    await page.setViewportSize({ width: 375, height: 800 });
    const managerOverflow = await page
      .locator('[data-testid="message-template-manager"]')
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(managerOverflow).toBeLessThanOrEqual(1);
  });

  test('quick reply, full reply view, edit, and delete update the post list in order', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    await page.goto(`/topics/${fixture.topicId}`);
    await expect(page).toHaveURL(new RegExp(`/topics/${fixture.topicId}`));

    const initialPosts = await postTextList(page).allTextContents();
    expect(initialPosts[0]).toContain('Opening message');
    expect(initialPosts[1]).toContain('Follow-up');

    const quickReplyMessage = 'Quick reply from regular user.';
    await quickReplyBox(page).fill(quickReplyMessage);
    await page.click('button:has-text("Post Quick Reply")');
    await expect(postTextList(page).last()).toContainText(quickReplyMessage);

    await page.click('button:has-text("Post Reply")');
    await expect(page).toHaveURL(new RegExp(`/topics/${fixture.topicId}/reply`));

    const fullReplyMessage = 'Full reply view message.';
    await page.fill('.vb-editor-textarea', fullReplyMessage);
    await page.click('button:has-text("Submit Reply")');
    await expect(page).toHaveURL(new RegExp(`/topics/${fixture.topicId}`));
    await expect(postTextList(page).last()).toContainText(fullReplyMessage);

    const editablePost = page.locator('.vb-post', { hasText: quickReplyMessage });
    await editablePost.locator('button', { hasText: 'Edit' }).click();
    await page.fill('.vb-modal-textarea', 'Edited quick reply body.');
    await page.click('button:has-text("Save Changes")');
    await expect(page.locator('.vb-post-text', { hasText: 'Edited quick reply body.' })).toBeVisible();

    const editedPost = page.locator('.vb-post', { hasText: 'Edited quick reply body.' });
    await editedPost.locator('button', { hasText: 'Delete' }).click();
    const deleteConfirm = editedPost.locator('.vb-delete-confirm');
    await expect(deleteConfirm).toBeVisible();
    await deleteConfirm.locator('button', { hasText: 'Yes, Delete' }).click();
    await expect(page.locator('.vb-post-text', { hasText: 'Edited quick reply body.' })).toHaveCount(0);

    await page.goto(`/forums/${fixture.forumId}`);
    const topicRow = topicRowForTitle(page, 'Baseline Thread');
    await expect(topicRow.locator('.vb-lastpost-author').first()).toContainText('Regular User');
  });

  test('moderation controls update badges, sticky placement, and forum breadcrumb after move', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    await page.goto(`/topics/${fixture.topicId}`);
    await page.click('button:has-text("Admin Tools")');

    // Updating the title should refresh the thread header and breadcrumb so moderators can verify the change.
    await page.click('button:has-text("Edit Title")');
    await page.fill('.vb-modal input[type="text"]', 'Moderated Thread Title');
    await page.click('button:has-text("Save")');
    await expect(page.locator('.vb-thread-titlebar h2')).toContainText('Moderated Thread Title');
    await expect(page.locator('.vb-breadcrumb-current')).toContainText('Moderated Thread Title');

    // Sticky threads must move into the sticky section to keep pinned announcements separated from normal traffic.
    await page.click('button:has-text("Sticky")');
    await page.goto(`/forums/${fixture.forumId}`);
    const stickyRow = topicRowForTitle(page, 'Moderated Thread Title');
    await expect(page.locator('tr.vb-table-section', { hasText: 'Sticky Threads' })).toBeVisible();
    await expect(stickyRow).toBeVisible();

    await page.goto(`/topics/${fixture.topicId}`);
    await page.click('button:has-text("Admin Tools")');

    // Locking should disable replies and show the locked badge so moderators can cool down heated threads.
    await page.click('button:has-text("Lock Topic")');
    await expect(page.locator('.vb-locked-badge')).toContainText('Locked');
    await expect(page.locator('.vb-quick-reply .vb-locked-notice')).toBeVisible();

    // Unlock restores posting to ensure moderators can reopen discussions.
    await page.click('button:has-text("Unlock Topic")');
    await expect(page.locator('.vb-locked-badge')).toHaveCount(0);
    await expect(page.locator('.vb-quick-reply textarea')).toBeVisible();

    // Archive hides replies and shows an archived badge so moderators can freeze historical threads.
    await page.click('button:has-text("Archive Topic")');
    await expect(page.locator('.vb-locked-badge')).toContainText('Archived');
    await expect(page.locator('.vb-quick-reply .vb-locked-notice')).toBeVisible();

    // Unarchive to allow the move operation in the UI.
    await page.click('button:has-text("Unarchive Topic")');
    await expect(page.locator('.vb-locked-badge')).toHaveCount(0);

    // Move thread should update the forum breadcrumb to the destination forum for navigational clarity.
    await page.click('button:has-text("Move Thread")');
    await page.selectOption('#move-forum-select', fixture.secondaryForumId);
    await expect(page.getByTestId('move-silent-checkbox')).not.toBeChecked();
    await page.getByTestId('move-silent-checkbox').check();
    await page.getByTestId('move-confirm-checkbox').check();
    await page.click('button:has-text("Move Thread")');
    expect(state.lastMoveRequest).toEqual({
      topicId: fixture.topicId,
      forumId: fixture.secondaryForumId,
      silent: true,
    });
    await expect(page.locator('.vb-breadcrumb-link', { hasText: 'Help Desk' })).toBeVisible();

    await page.goto(`/forums/${fixture.secondaryForumId}`);
    await expect(page.locator('.vb-forum-name')).toContainText('Help Desk');
    await expect(topicRowForTitle(page, 'Moderated Thread Title')).toBeVisible();

    await page.goto(`/forums/${fixture.forumId}`);
    await page.reload();
    await expect(topicRowForTitle(page, 'Moderated Thread Title')).toHaveCount(0);
  });

  test('locked/archived topics block replies and non-moderators cannot access admin tools', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { includeLocked: true, includeArchived: true });

    await page.goto(`/topics/${fixture.lockedTopicId}`);
    await page.waitForResponse(
      (response) =>
      response.url().includes(`/api/topics/${fixture.lockedTopicId}`) && response.request().method() === 'GET'
    );
    await expect(page.locator('.vb-locked-badge')).toContainText('Locked');
    await expect(page.locator('.vb-quick-reply .vb-locked-notice')).toBeVisible();
    await expect(page.locator('.vb-controls .vb-btn', { hasText: 'Post Reply' }).first()).toBeDisabled();
    await expect(page.locator('.vb-quick-reply textarea')).toHaveCount(0);
    await expect(page.locator('button', { hasText: 'Post Quick Reply' })).toHaveCount(0);

    await page.goto(`/topics/${fixture.lockedTopicId}/reply`);
    await expect(page.locator('.vb-editor-textarea')).toBeVisible();
    await page.evaluate(() => {
      const textarea = document.querySelector('.vb-editor-textarea') as HTMLTextAreaElement | null;
      const button = Array.from(document.querySelectorAll('button')).find((el) =>
        el.textContent?.includes('Submit Reply')
      ) as HTMLButtonElement | undefined;
      if (textarea) {
        textarea.removeAttribute('disabled');
        textarea.value = 'Trying to reply while locked.';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (button) {
        button.removeAttribute('disabled');
        button.click();
      }
    });
    await expect(
      page.locator('.vb-login-error', { hasText: 'Cannot reply to a locked or archived topic.' })
    ).toBeVisible();

    await page.goto(`/topics/${fixture.archivedTopicId}`);
    await expect(page.locator('.vb-locked-badge')).toContainText('Archived');
    await expect(page.locator('.vb-quick-reply .vb-locked-notice')).toBeVisible();
    await expect(page.locator('.vb-controls .vb-btn', { hasText: 'Post Reply' }).first()).toBeDisabled();
    await expect(page.locator('.vb-quick-reply textarea')).toHaveCount(0);
    await expect(page.locator('button', { hasText: 'Post Quick Reply' })).toHaveCount(0);

    await page.goto(`/topics/${fixture.archivedTopicId}/reply`);
    await expect(page.locator('.vb-editor-textarea')).toBeVisible();
    await page.evaluate(() => {
      const textarea = document.querySelector('.vb-editor-textarea') as HTMLTextAreaElement | null;
      const button = Array.from(document.querySelectorAll('button')).find((el) =>
        el.textContent?.includes('Submit Reply')
      ) as HTMLButtonElement | undefined;
      if (textarea) {
        textarea.removeAttribute('disabled');
        textarea.value = 'Trying to reply while archived.';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (button) {
        button.removeAttribute('disabled');
        button.click();
      }
    });
    await expect(
      page.locator('.vb-login-error', { hasText: 'Cannot reply to a locked or archived topic.' })
    ).toBeVisible();

    await expectAdminToolsHidden(page);
  });

  test('context overflow recovery submits with the HTTP-compatible operation id fallback', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    await context.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    });
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });
    await page.goto(`/topics/${fixture.topicId}`);

    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
    const recoverAction = page.getByRole('button', { name: 'Compact and recover' });
    await expect(recoverAction).toHaveCount(1);
    await recoverAction.click();
    await expect(page.getByText('Compact Session and Recover', { exact: true })).toBeVisible();

    await page.getByLabel('I understand that compaction is destructive and may lose context.').check();
    await page.locator('.vb-compaction-modal').getByRole('button', { name: 'Compact and recover' }).click();

    await expect(page.getByText('Compact Session and Recover', { exact: true })).toHaveCount(0);
    expect(state.compactionRequests).toHaveLength(1);
    expect(state.compactionRequests[0]?.['operationId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test('compaction dialog remains reachable in short mobile portrait with advanced options', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });
    await page.goto(`/topics/${fixture.topicId}`);
    const compactTrigger = page.getByRole('button', { name: 'Compact', exact: true }).first();
    await compactTrigger.click();
    await expect(page.getByRole('dialog', { name: 'Compact Session and Recover' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close compaction dialog' })).toBeFocused();
    await page.getByRole('button', { name: 'Advanced options' }).click();

    const dialog = page.getByRole('dialog', { name: 'Compact Session and Recover' });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(box!.y + box!.height).toBeLessThanOrEqual(667);
    await expect(dialog.getByRole('button', { name: 'Compact and recover' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(compactTrigger).toBeFocused();
  });

  test('compaction dialog keeps its actions reachable in short mobile landscape', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);
    await page.setViewportSize({ width: 667, height: 375 });

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });
    await page.goto(`/topics/${fixture.topicId}`);
    await page.getByRole('button', { name: 'Compact', exact: true }).first().click();
    await page.getByRole('button', { name: 'Advanced options' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compact Session and Recover' });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(375);
    await expect(dialog.getByRole('button', { name: 'Compact and recover' })).toBeVisible();
    await dialog
      .getByLabel('Custom summary instructions (optional)')
      .fill('Preserve the current implementation state.');
  });

  test('reload hydrates a server-owned compaction without trapping the topic in a modal', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });
    state.compactionOperations['op-active'] = {
      id: 'op-active',
      topicId: fixture.topicId,
      sessionId: 'session-1',
      initiatedBy: MODERATOR_ID,
      expectedLeafId: 'leaf-1',
      customInstructions: null,
      recoveryPrompt: 'recover',
      status: 'running',
      eventId: null,
      recoveryPostId: null,
      errorMessage: null,
      createdAt: nextTimestamp(state),
      startedAt: nextTimestamp(state),
      finishedAt: null,
    };

    await page.goto(`/topics/${fixture.topicId}`);
    await expect(page.getByText('Compaction is running on the server.')).toBeVisible();
    await expect(page.getByText('You may leave or close this page.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Post Reply' }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Post Quick Reply' })).toBeDisabled();
  });

  test('lost acceptance and reconciliation responses retain a conservative durable intent', async ({
    page,
    context,
  }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });
    await page.goto(`/topics/${fixture.topicId}`);
    await page.route('**/api/topics/*/compactions**', async (route) => {
      await route.abort('connectionfailed');
    });
    await page.getByRole('button', { name: 'Compact', exact: true }).first().click();
    await page.getByLabel('I understand that compaction is destructive and may lose context.').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Compact and recover' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Compaction is running on the server.')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('The outcome is unknown; do not retry');
    await expect(page.getByRole('button', { name: 'Compact', exact: true }).first()).toBeDisabled();
    const persisted = await page.evaluate(
      (topicId) => localStorage.getItem(`codex-forum:compaction-intent:${topicId}`),
      fixture.topicId
    );
    expect(persisted).toContain(fixture.topicId);
  });

  test('compaction capability failures are surfaced in the modal', async ({ page, context }) => {
    const state = createMockState();
    await context.addInitScript(() => {
      Object.defineProperties(globalThis.crypto, {
        randomUUID: { value: undefined, configurable: true },
        getRandomValues: { value: undefined, configurable: true },
      });
    });
    await attachMockApi(page, state);
    await setAuthTokens(context, MODERATOR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });
    await page.goto(`/topics/${fixture.topicId}`);
    await page.getByRole('button', { name: 'Compact', exact: true }).first().click();
    await page.getByLabel('I understand that compaction is destructive and may lose context.').check();
    await page.locator('.vb-compaction-modal').getByRole('button', { name: 'Compact and recover' }).click();

    await expect(page.getByRole('alert')).toContainText(
      'Secure random number generation is unavailable in this browser.'
    );
    expect(state.compactionRequests).toHaveLength(0);
  });

  test('concurrent replies keep pagination and forum index last post in sync', async ({ browser }) => {
    const state = createMockState();
    const context = await browser.newContext();
    await setAuthTokens(context, REGULAR_TOKEN);
    await attachMockApi(context, state);

    const pageA = await context.newPage();
    await pageA.goto('/');
    const fixture = await createFixture(pageA, { postCount: 8 });

    const pageB = await context.newPage();
    await pageA.goto(`/topics/${fixture.topicId}`);
    await pageB.goto(`/topics/${fixture.topicId}`);

    await quickReplyBox(pageA).fill('Reply from page A');
    await expect(pageA.locator('.vb-quick-reply')).toContainText('Draft saved');
    await quickReplyBox(pageB).fill('Reply from page B');
    await expect(pageB.locator('.vb-quick-reply')).toContainText('Draft changed in another tab or device');

    await pageA.click('button:has-text("Post Quick Reply")');
    await pageB.getByRole('button', { name: 'Keep my version' }).click();
    await expect(pageB.locator('.vb-quick-reply')).toContainText('Draft changed in another tab or device');
    await pageB.getByRole('button', { name: 'Keep my version' }).click();
    await expect(pageB.locator('.vb-quick-reply')).toContainText('Draft saved');
    await pageB.click('button:has-text("Post Quick Reply")');

    const apiBodies = await pageA.evaluate(async (topicId) => {
      const res = await fetch(`/api/topics/${topicId}/posts`);
      const data = await res.json();
      return (data.items as Array<{ body: string }>).map((post) => post.body);
    }, fixture.topicId);
    expect(apiBodies).toContain('Reply from page A');
    expect(apiBodies).toContain('Reply from page B');
    const apiTail = apiBodies.slice(-2).map((body) => body.trim());
    await pageA.goto(`/topics/${fixture.topicId}`);
    await pageA.locator('.vb-pagination-controls').first().locator('.vb-page-btn', { hasText: '2' }).click();
    await expect(
      pageA.locator('.vb-pagination-controls').first().locator('.vb-page-btn', { hasText: '2' })
    ).toHaveClass(/vb-page-active/);
    const pageTwoBodies = (await postTextList(pageA).allTextContents()).map((body) => body.trim());
    expect(pageTwoBodies).toEqual(expect.arrayContaining(apiTail));
    expect(pageTwoBodies.slice(-2)).toEqual(apiTail);

    await pageA.goto(`/forums/${fixture.forumId}`);
    const topicRow = topicRowForTitle(pageA, 'Baseline Thread');
    await expect(topicRow.locator('.vb-lastpost-author').first()).toContainText('Regular User');
    await expect(topicRow.locator('.vb-thread-title')).toContainText('Baseline Thread');
    await expect(topicRow.locator('.vb-lastpost-time')).toBeVisible();
    await pageA.reload();
    await expect(topicRow.locator('.vb-lastpost-author').first()).toContainText('Regular User');

    await context.close();
  });
});
