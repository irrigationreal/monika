import type { Page, Route, Request } from '@playwright/test';
import type {
  ForumDto,
  ForumLastPostDto,
  IdentityDto,
  PostDto,
  RecentPostDto,
  TopicDto
} from '../../src/lib/apiClient';

type ForumRecord = ForumDto;
type TopicRecord = TopicDto;

type ForumFixtureInput = {
  name: string;
  description?: string | null;
  category?: string | null;
  visibility?: ForumDto['visibility'];
  parentForumId?: string | null;
};

type TopicFixtureInput = {
  forumId: string;
  title: string;
  createdBy: string;
  tags?: string[];
  status?: TopicDto['status'];
  createdAt?: string;
  postCount?: number;
  bodyPrefix?: string;
};

type PostFixtureInput = {
  topicId: string;
  authorId: string;
  body: string;
  createdAt?: string;
};

type ApiResponse = { status: number; body: unknown };

const toIso = (date: Date): string => date.toISOString();
const AUTH_TOKEN_KEY = 'cforum_auth_token';

const parseJsonBody = (request: Request): Record<string, unknown> | null => {
  const raw = request.postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export type ForumFixture = ReturnType<typeof createForumFixture>;

export function createForumFixture() {
  let forumCounter = 1;
  let topicCounter = 1;
  let postCounter = 1;
  let identityCounter = 1;
  const forums = new Map<string, ForumRecord>();
  const topics = new Map<string, TopicRecord>();
  const posts = new Map<string, PostDto>();
  const identities = new Map<string, IdentityDto>();
  const topicsByForum = new Map<string, string[]>();
  const postsByTopic = new Map<string, string[]>();
  const sessions = new Map<string, IdentityDto>();

  const now = new Date();
  const nowMs = now.getTime();
  const isoOffsetMinutes = (minutes: number) => toIso(new Date(nowMs + minutes * 60000));

  const makeId = (prefix: string, counter: number) => `${prefix}-${counter}`;

  const createIdentity = (displayName: string, kind: IdentityDto['kind'] = 'human'): IdentityDto => {
    const id = makeId('identity', identityCounter++);
    const identity: IdentityDto = {
      id,
      displayName,
      kind,
      tenantId: null,
      parentIdentityId: null,
      avatarUrl: null,
      location: null,
      signature: null,
      theme: null,
      postCount: 0,
      rank: 'Member'
    };
    identities.set(id, identity);
    return identity;
  };

  const createSession = (identity: IdentityDto, token?: string): string => {
    const sessionToken = token ?? `token-${identity.id}`;
    sessions.set(sessionToken, identity);
    return sessionToken;
  };

  const createForum = ({
    name,
    description = null,
    category = null,
    visibility = 'public',
    parentForumId = null
  }: ForumFixtureInput): ForumRecord => {
    const id = makeId('forum', forumCounter++);
    const timestamp = isoOffsetMinutes(-90 + forumCounter * 2);
    const forum: ForumRecord = {
      id,
      tenantId: null,
      parentForumId,
      category,
      name,
      description,
      status: 'active',
      visibility,
      archivedAt: null,
      threadCount: 0,
      postCount: 0,
      lastPost: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    forums.set(id, forum);
    topicsByForum.set(id, []);
    return forum;
  };

  const createPost = ({ topicId, authorId, body, createdAt }: PostFixtureInput): PostDto => {
    const topic = topics.get(topicId);
    if (!topic) {
      throw new Error(`Topic not found for post: ${topicId}`);
    }
    const forum = forums.get(topic.forumId);
    if (!forum) {
      throw new Error(`Forum not found for post: ${topic.forumId}`);
    }
    const postId = makeId('post', postCounter++);
    const createdAtIso = createdAt ?? isoOffsetMinutes(postCounter);
    const post: PostDto = {
      id: postId,
      topicId,
      tenantId: null,
      parentPostId: null,
      authorId,
      body,
      createdAt: createdAtIso,
      editedAt: null,
      deletedAt: null,
      reactionCounts: []
    };
    posts.set(postId, post);
    const list = postsByTopic.get(topicId) ?? [];
    list.push(postId);
    postsByTopic.set(topicId, list);

    topic.postCount = list.length;
    topic.lastPostAt = createdAtIso;
    topic.lastPostAuthorId = authorId;
    topic.lastPostAuthorName = identities.get(authorId)?.displayName ?? 'Unknown';
    topic.updatedAt = createdAtIso;

    forum.postCount += 1;
    const lastPost: ForumLastPostDto = {
      postId,
      topicId,
      topicTitle: topic.title,
      authorId,
      authorName: identities.get(authorId)?.displayName ?? 'Unknown',
      createdAt: createdAtIso
    };
    if (!forum.lastPost || forum.lastPost.createdAt <= createdAtIso) {
      forum.lastPost = lastPost;
    }
    forum.updatedAt = createdAtIso;

    const identity = identities.get(authorId);
    if (identity) {
      identity.postCount = (identity.postCount ?? 0) + 1;
    }

    return post;
  };

  const createTopic = ({
    forumId,
    title,
    createdBy,
    tags = [],
    status = 'open',
    createdAt,
    postCount = 1,
    bodyPrefix = 'Post'
  }: TopicFixtureInput): TopicRecord => {
    const forum = forums.get(forumId);
    if (!forum) {
      throw new Error(`Forum not found for topic: ${forumId}`);
    }
    const topicId = makeId('topic', topicCounter++);
    const createdAtIso = createdAt ?? isoOffsetMinutes(-60 + topicCounter * 3);
    const topic: TopicRecord = {
      id: topicId,
      forumId,
      tenantId: null,
      title,
      status,
      tags,
      robotMode: 'auto',
      createdBy,
      createdByName: identities.get(createdBy)?.displayName ?? 'Unknown',
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
      postCount: 0,
      lastPostAuthorId: createdBy,
      lastPostAuthorName: identities.get(createdBy)?.displayName ?? 'Unknown',
      lastPostAt: createdAtIso
    };
    topics.set(topicId, topic);
    const forumTopics = topicsByForum.get(forumId) ?? [];
    forumTopics.push(topicId);
    topicsByForum.set(forumId, forumTopics);
    forum.threadCount += 1;

    const createdAtBase = new Date(createdAtIso).getTime();
    for (let index = 0; index < postCount; index += 1) {
      const offsetMs = index * 60_000;
      const createdAtPost = new Date(createdAtBase + offsetMs).toISOString();
      createPost({
        topicId,
        authorId: createdBy,
        body: `${bodyPrefix} ${index + 1} in ${title}`,
        createdAt: createdAtPost
      });
    }

    return topics.get(topicId)!;
  };

  const canViewForum = (forum: ForumRecord, identity: IdentityDto | null): boolean => {
    if (forum.visibility === 'public') return true;
    if (forum.visibility === 'members') return Boolean(identity);
    if (forum.visibility === 'admin') return identity?.kind === 'admin';
    return true;
  };

  const listForums = (params: Record<string, string | null | undefined>, identity: IdentityDto | null): ForumRecord[] => {
    let list = Array.from(forums.values());
    const status = params['status'] as ForumStatus | undefined;
    const includeArchived = params['includeArchived'] === 'true' || params['includeArchived'] === '1';
    const parentForumId = params['parentForumId'] === undefined
      ? undefined
      : params['parentForumId'] === '' || params['parentForumId'] === 'null'
        ? null
        : params['parentForumId'];

    if (status) {
      list = list.filter((forum) => forum.status === status);
    } else if (!includeArchived) {
      list = list.filter((forum) => forum.status === 'active');
    }

    if (parentForumId !== undefined) {
      list = list.filter((forum) => forum.parentForumId === parentForumId);
    }

    return list.filter((forum) => canViewForum(forum, identity));
  };

  const listRecentPosts = (limit: number, identity: IdentityDto | null): RecentPostDto[] => {
    const items = Array.from(posts.values())
      .filter((post) => {
        const topic = topics.get(post.topicId);
        const forum = topic ? forums.get(topic.forumId) : null;
        return forum ? canViewForum(forum, identity) : false;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return items.map((post) => {
      const topic = topics.get(post.topicId);
      const forum = topic ? forums.get(topic.forumId) : null;
      const author = identities.get(post.authorId);
      return {
        postId: post.id,
        topicId: post.topicId,
        topicTitle: topic?.title ?? 'Unknown topic',
        forumId: topic?.forumId ?? 'unknown',
        forumName: forum?.name ?? 'Unknown forum',
        authorId: post.authorId,
        authorName: author?.displayName ?? 'Unknown',
        body: post.body,
        createdAt: post.createdAt
      };
    });
  };

  const listTopics = (forumId: string, identity: IdentityDto | null) => {
    const forum = forums.get(forumId);
    if (!forum || !canViewForum(forum, identity)) {
      return null;
    }
    const topicIds = topicsByForum.get(forumId) ?? [];
    const items = topicIds.map((topicId) => topics.get(topicId)).filter(Boolean) as TopicRecord[];
    return { page: 1, pageSize: items.length || 1, total: items.length, items };
  };

  const listPosts = (topicId: string) => {
    const topic = topics.get(topicId);
    if (!topic) return null;
    const ids = postsByTopic.get(topicId) ?? [];
    const items = ids.map((id) => posts.get(id)).filter(Boolean) as PostDto[];
    return { page: 1, pageSize: items.length || 1, total: items.length, items };
  };

  const listIdentities = (topicId: string) => {
    const ids = postsByTopic.get(topicId) ?? [];
    const uniqueIds = new Set(ids.map((id) => posts.get(id)?.authorId).filter(Boolean) as string[]);
    const items = Array.from(uniqueIds).map((id) => identities.get(id)).filter(Boolean) as IdentityDto[];
    return { page: 1, pageSize: items.length || 1, total: items.length, items };
  };

  const resolveIdentity = (request: Request): IdentityDto | null => {
    const authHeader = request.headers()['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.slice(7);
    return sessions.get(token) ?? null;
  };

  const handleRequest = async (request: Request): Promise<ApiResponse | null> => {
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method().toUpperCase();
    const segments = path.split('/').filter(Boolean);
    const identity = resolveIdentity(request);

    if (method === 'GET' && path === '/auth/me') {
      return { status: 200, body: { identity } };
    }

    if (method === 'GET' && path === '/forums') {
      return { status: 200, body: listForums(Object.fromEntries(url.searchParams.entries()), identity) };
    }

    if (method === 'GET' && path === '/posts/recent') {
      const limit = Number(url.searchParams.get('limit') ?? '3');
      return { status: 200, body: listRecentPosts(Number.isFinite(limit) ? limit : 3, identity) };
    }

    if (segments[0] === 'forums' && segments[2] === 'topics') {
      const forumId = segments[1];
      if (method === 'GET') {
        const list = listTopics(forumId, identity);
        if (!list) {
          return { status: 404, body: { message: 'Forum not found' } };
        }
        return { status: 200, body: list };
      }
      if (method === 'POST') {
        const body = parseJsonBody(request) ?? {};
        const title = String(body['title'] ?? 'New Topic');
        const author = Array.from(identities.values())[0];
        const topic = createTopic({
          forumId,
          title,
          createdBy: author?.id ?? createIdentity('Seeder').id,
          postCount: 1,
          bodyPrefix: 'Seeded'
        });
        return { status: 200, body: topic };
      }
    }

    if (segments[0] === 'topics' && segments.length === 2 && method === 'GET') {
      const topic = topics.get(segments[1]);
      const forum = topic ? forums.get(topic.forumId) : null;
      if (!topic || !forum || !canViewForum(forum, identity)) {
        return { status: 404, body: { message: 'Topic not found' } };
      }
      return { status: 200, body: topic };
    }

    if (segments[0] === 'topics' && segments[2] === 'posts') {
      const topicId = segments[1];
      if (method === 'GET') {
        const topic = topics.get(topicId);
        const forum = topic ? forums.get(topic.forumId) : null;
        if (!topic || !forum || !canViewForum(forum, identity)) {
          return { status: 404, body: { message: 'Topic not found' } };
        }
        const list = listPosts(topicId);
        if (!list) {
          return { status: 404, body: { message: 'Topic not found' } };
        }
        return { status: 200, body: list };
      }
      if (method === 'POST') {
        const topic = topics.get(topicId);
        if (!topic) {
          return { status: 404, body: { message: 'Topic not found' } };
        }
        const body = parseJsonBody(request) ?? {};
        const author = Array.from(identities.values())[0];
        const post = createPost({
          topicId,
          authorId: author?.id ?? createIdentity('Seeder').id,
          body: String(body['body'] ?? 'Seeded reply'),
          createdAt: isoOffsetMinutes(5)
        });
        return { status: 200, body: post };
      }
    }

    if (segments[0] === 'topics' && segments[2] === 'identities' && method === 'GET') {
      const topic = topics.get(segments[1]);
      const forum = topic ? forums.get(topic.forumId) : null;
      if (!topic || !forum || !canViewForum(forum, identity)) {
        return { status: 404, body: { message: 'Topic not found' } };
      }
      return { status: 200, body: listIdentities(segments[1]) };
    }

    if (segments[0] === 'topics' && segments[2] === 'personas' && method === 'GET') {
      return { status: 200, body: { items: [] } };
    }

    if (segments[0] === 'topics' && segments[2] === 'state' && method === 'GET') {
      return { status: 200, body: null };
    }

    if (segments[0] === 'posts' && segments[2] === 'attachments' && method === 'GET') {
      return { status: 200, body: [] };
    }

    return null;
  };

  const attach = async (page: Page): Promise<void> => {
    await page.route('**/api/**', async (route: Route) => {
      const response = await handleRequest(route.request());
      if (!response) {
        await route.fulfill({
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'Not found' })
        });
        return;
      }
      await route.fulfill({
        status: response.status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(response.body)
      });
    });
  };

  return {
    attach,
    now,
    AUTH_TOKEN_KEY,
    createIdentity,
    createSession,
    createForum,
    createTopic,
    createPost,
    getForum: (forumId: string) => forums.get(forumId) ?? null,
    getTopic: (topicId: string) => topics.get(topicId) ?? null,
    listForums: () => Array.from(forums.values()),
    listTopics: () => Array.from(topics.values()),
    listPosts: () => Array.from(posts.values())
  };
}
