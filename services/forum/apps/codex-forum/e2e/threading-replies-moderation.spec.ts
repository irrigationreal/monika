import { test, expect, type BrowserContext, type Page, type Route, type Request } from '@playwright/test';
import type {
  CompactionOperationDto,
  ForumDto,
  ForumLastPostDto,
  IdentityDto,
  MessageTemplateDto,
  PostDto,
  RecentPostDto,
  RobotStateDto,
  TopicDto,
  TopicOperationalEventDto
} from '@irrigationreal/codex-forum-contracts';

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
      updatedAt: now
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
      updatedAt: now
    }
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
      [MODERATOR_ID]: ['read', 'write', 'mod.all', 'admin.all']
    },
    tokens: {
      [REGULAR_TOKEN]: REGULAR_ID,
      [MODERATOR_TOKEN]: MODERATOR_ID
    },
    fixture: null,
    lastMoveRequest: null,
    operationalEventsByTopic: {},
    compactionOperations: {},
    compactionRequests: [],
    messageTemplates: [
      { id: 'template-reply', scope: 'personal', name: 'Review approval', category: 'Review', body: 'Approved after review.', threadTitle: null, forumScope: 'all', forumIds: [], contexts: ['reply'], enabled: true, sortOrder: 0, revision: 1, createdAt: now, updatedAt: now },
      { id: 'template-thread', scope: 'system', name: 'Project kickoff', category: 'Project', body: 'Kickoff details for this project.', threadTitle: 'Project kickoff thread', forumScope: 'all', forumIds: [], contexts: ['new_thread'], enabled: true, sortOrder: 0, revision: 1, createdAt: now, updatedAt: now }
    ]
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
    updatedAt: createdAt
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
    updatedAt: createdAt
  });

  const normalTopicId = addTopic(state, {
    forumId,
    title: 'Baseline Thread',
    status: 'open',
    tags: [],
    createdBy: REGULAR_ID,
    postCount: request.postCount ?? 2
  });

  const anchorPostId = state.postsByTopic[normalTopicId]?.[0]?.id ?? null;
  state.operationalEventsByTopic[normalTopicId] = [{
    id: 'overflow-event-1',
    topicId: normalTopicId,
    anchorPostId,
    type: 'turn_error',
    category: 'assistant',
    status: 'failed',
    summary: 'Assistant response failed.',
    detail: {
      category: 'context_overflow',
      error: 'Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.'
    },
    sourceKind: 'echs_turn',
    sourceId: 'pi-message-1',
    createdAt: nextTimestamp(state)
  }];

  const lockedTopicId = request.includeLocked
    ? addTopic(state, {
      forumId,
      title: 'Locked Thread',
      status: 'locked',
      tags: [],
      createdBy: REGULAR_ID,
      postCount: 1
    })
    : null;

  const archivedTopicId = request.includeArchived
    ? addTopic(state, {
      forumId,
      title: 'Archived Thread',
      status: 'archived',
      tags: [],
      createdBy: REGULAR_ID,
      postCount: 1
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
    moderatorIdentityId: MODERATOR_ID
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
    posts.push(createPostRecord(state, {
      topicId,
      authorId: input.createdBy,
      body: i === 0
        ? `Opening message for ${input.title}.`
        : `Follow-up ${i} for ${input.title}.`
    }));
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
    lastPostAt: lastPost.createdAt
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
    reactionCounts: []
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
        createdAt: candidate.createdAt
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
        createdAt: post.createdAt
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
      const identity = identityFromRequest(state, request);
      await fulfillJson(route, 200, {
        identity: identity
          ? {
            ...identity,
            hasPrivateEmail: false
          }
          : null
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

    if (path === '/api/message-templates/effective' && method === 'GET') {
      const context = url.searchParams.get('context');
      await fulfillJson(route, 200, { templates: state.messageTemplates.filter((template) => template.enabled && template.contexts.includes(context as 'reply' | 'new_thread')) });
      return;
    }

    if (path.startsWith('/api/forums/') && path.endsWith('/topics')) {
      const forumId = path.split('/')[3];
      if (method === 'GET') {
        await fulfillJson(route, 200, {
          page: 1,
          pageSize: 50,
          total: listTopicsForForum(state, forumId).length,
          items: listTopicsForForum(state, forumId)
        });
        return;
      }
      if (method === 'POST') {
        const title = payload?.title ?? 'Untitled';
        const body = payload?.body ?? '';
        const author = identityFromRequest(state, request) ?? state.identities[REGULAR_ID];
        const topicId = addTopic(state, {
          forumId,
          title,
          status: 'open',
          tags: [],
          createdBy: author.id,
          postCount: 1
        });
        state.postsByTopic[topicId][0].body = body;
        const topic = state.topics[topicId];
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
        const posts = state.postsByTopic[topicId] ?? [];
        await fulfillJson(route, 200, {
          page: 1,
          pageSize: 50,
          total: posts.length,
          items: posts
        });
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
        const post = createPostRecord(state, {
          topicId,
          authorId: author.id,
          body,
          silent: payload?.silent ?? false
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
        finishedAt: nextTimestamp(state)
      };
      state.compactionOperations[operationId] = operation;
      await fulfillJson(route, 200, operation);
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
        activity: 'idle',
        model: null,
        reasoningEffort: null,
        lastUpdatedAt: nextTimestamp(state),
        currentPlan: null,
        recentToolRuns: []
      };
      await fulfillJson(route, 200, statePayload);
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/session') && method === 'GET') {
      await fulfillJson(route, 200, null);
      return;
    }

    if (path.startsWith('/api/topics/') && path.endsWith('/state/stream')) {
      const topicId = path.split('/')[3];
      const streamState: RobotStateDto = {
        topicId,
        sessionId: 'session-1',
        activity: 'idle',
        model: null,
        reasoningEffort: null,
        lastUpdatedAt: nextTimestamp(state),
        currentPlan: null,
        recentToolRuns: []
      };
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `event: state\ndata: ${JSON.stringify(streamState)}\n\n`
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
          silent: Boolean(payload?.silent)
        }
      });
      return;
    }

    await fulfillJson(route, 500, { message: `Unmocked request: ${method} ${path}` });
  });
}

function identityFromRequest(state: MockState, request: Request): IdentityRecord | null {
  const header = request.headers()['authorization'];
  if (!header) return null;
  const token = header.replace('Bearer ', '').trim();
  const identityId = state.tokens[token];
  return identityId ? state.identities[identityId] ?? null : null;
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
    body: JSON.stringify(body)
  });
}

async function createFixture(page: Page, payload: FixtureRequest): Promise<FixtureResponse> {
  return await page.evaluate(async (fixturePayload) => {
    const res = await fetch('/api/test/fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixturePayload)
    });
    if (!res.ok) {
      throw new Error(`Fixture request failed: ${res.status}`);
    }
    return res.json();
  }, payload);
}

async function setAuthTokens(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript(
    (value) => {
      localStorage.setItem('cforum_auth_token', value);
      localStorage.setItem('cforum_refresh_token', 'refresh-token');
    },
    token
  );
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

test.describe('Threading and reply flows', () => {
  test.describe.configure({ mode: 'serial' });
  test('create new thread with preview, BBCode insertions, validation, and cancel confirmation', async ({ page, context }) => {
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

    await page.fill('.vb-editor-textarea', 'Preview content for the thread.');
    await page.click('button:has-text("Show Preview")');
    await expect(page.locator('.vb-preview-panel')).toBeVisible();
    await expect(page.locator('.vb-preview-body')).toContainText('Preview content for the thread.');

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Are you sure you want to cancel');
      dialog.dismiss();
    });
    await page.click('button:has-text("Cancel")');
    await expect(page).toHaveURL(new RegExp(`/forums/${fixture.forumId}/newthread`));

    await page.goto(`/forums/${fixture.forumId}`);
    await page.click('button:has-text("New Thread")');
    await expect(page).toHaveURL(new RegExp(`/forums/${fixture.forumId}/newthread`));

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Are you sure you want to cancel');
      dialog.accept();
    });
    await page.click('button:has-text("Cancel")');
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

  test('message template inserts in quick and full reply without submitting', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);
    await page.goto('/');
    const fixture = await createFixture(page, { postCount: 2 });

    await page.goto(`/topics/${fixture.topicId}`);
    const quickPicker = page.locator('.vb-quick-reply [data-testid="message-template-picker"]');
    await quickPicker.locator('[data-testid="message-template-select"]').selectOption('template-reply');
    await quickPicker.locator('[data-testid="message-template-insert"]').click();
    await expect(quickReplyBox(page)).toHaveValue('Approved after review.');

    await page.click('button:has-text("Post Reply")');
    const fullPicker = page.locator('.vb-newthread-form [data-testid="message-template-picker"]');
    await fullPicker.locator('[data-testid="message-template-select"]').selectOption('template-reply');
    await fullPicker.locator('[data-testid="message-template-insert"]').click();
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

  test('moderation controls update badges, sticky placement, and forum breadcrumb after move', async ({ page, context }) => {
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
    expect(state.lastMoveRequest).toEqual({ topicId: fixture.topicId, forumId: fixture.secondaryForumId, silent: true });
    await expect(page.locator('.vb-breadcrumb-link', { hasText: 'Help Desk' })).toBeVisible();

    await page.goto(`/forums/${fixture.secondaryForumId}`);
    await expect(page.locator('.vb-forum-name')).toContainText('Help Desk');
    await expect(topicRowForTitle(page, 'Moderated Thread Title')).toBeVisible();

    await page.goto(`/forums/${fixture.forumId}`);
    await page.reload();
    await expect(topicRowForTitle(page, 'Moderated Thread Title')).toHaveCount(0);
  });

  test('locked/archived topics block replies and non-moderators cannot access admin tools', async ({ page, context }) => {
    const state = createMockState();
    await attachMockApi(page, state);
    await setAuthTokens(context, REGULAR_TOKEN);

    await page.goto('/');
    const fixture = await createFixture(page, { includeLocked: true, includeArchived: true });

    await page.goto(`/topics/${fixture.lockedTopicId}`);
    await page.waitForResponse((response) =>
      response.url().includes(`/api/topics/${fixture.lockedTopicId}`) && response.request().method() === 'GET'
    );
    await expect(page.locator('.vb-locked-badge')).toContainText('Locked');
    await expect(page.locator('.vb-quick-reply .vb-locked-notice')).toBeVisible();
    await expect(page.locator('.vb-controls .vb-btn', { hasText: 'Post Reply' }).first()).toBeDisabled();
    await expect(page.locator('.vb-quick-reply textarea')).toHaveCount(0);
    await expect(page.locator('button', { hasText: 'Post Quick Reply' })).toHaveCount(0);

    await page.goto(`/topics/${fixture.lockedTopicId}/reply`);
    await page.evaluate(() => {
      const textarea = document.querySelector('.vb-editor-textarea') as HTMLTextAreaElement | null;
      const button = Array.from(document.querySelectorAll('button'))
        .find((el) => el.textContent?.includes('Submit Reply')) as HTMLButtonElement | undefined;
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
    await expect(page.locator('.vb-login-error', { hasText: 'Cannot reply to a locked or archived topic.' })).toBeVisible();

    await page.goto(`/topics/${fixture.archivedTopicId}`);
    await expect(page.locator('.vb-locked-badge')).toContainText('Archived');
    await expect(page.locator('.vb-quick-reply .vb-locked-notice')).toBeVisible();
    await expect(page.locator('.vb-controls .vb-btn', { hasText: 'Post Reply' }).first()).toBeDisabled();
    await expect(page.locator('.vb-quick-reply textarea')).toHaveCount(0);
    await expect(page.locator('button', { hasText: 'Post Quick Reply' })).toHaveCount(0);

    await page.goto(`/topics/${fixture.archivedTopicId}/reply`);
    await page.evaluate(() => {
      const textarea = document.querySelector('.vb-editor-textarea') as HTMLTextAreaElement | null;
      const button = Array.from(document.querySelectorAll('button'))
        .find((el) => el.textContent?.includes('Submit Reply')) as HTMLButtonElement | undefined;
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
    await expect(page.locator('.vb-login-error', { hasText: 'Cannot reply to a locked or archived topic.' })).toBeVisible();

    await expectAdminToolsHidden(page);
  });

  test('context overflow recovery submits with the HTTP-compatible operation id fallback', async ({ page, context }) => {
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

  test('compaction capability failures are surfaced in the modal', async ({ page, context }) => {
    const state = createMockState();
    await context.addInitScript(() => {
      Object.defineProperties(globalThis.crypto, {
        randomUUID: { value: undefined, configurable: true },
        getRandomValues: { value: undefined, configurable: true }
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

    await expect(page.getByRole('alert')).toContainText('Secure random number generation is unavailable in this browser.');
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
    await quickReplyBox(pageB).fill('Reply from page B');

    await Promise.all([
      pageA.click('button:has-text("Post Quick Reply")'),
      pageB.click('button:has-text("Post Quick Reply")')
    ]);

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
    await expect(pageA.locator('.vb-pagination-controls').first().locator('.vb-page-btn', { hasText: '2' })).toHaveClass(/vb-page-active/);
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
