import { expect, test } from '@playwright/test';

import { createSessionLogSimulator } from '../../../packages/server/src/simulator/sessionLog';

import type {
  AdminForumDto,
  AdminSkillListResponseDto,
  AdminUserDto,
  AuthIdentityDto,
  DiscordBridgeStatusDto,
  ForumDto,
  ForumLastPostDto,
  IdentityDto,
  MatrixBridgeStatusDto,
  PostDto,
  RobotAutomationDto,
  RobotAutomationRunDto,
  RobotJobDto,
  RobotQueueItemDto,
  RobotSettingsDto,
  RobotStateDto,
  ToolRunDto,
  TopicDto,
} from '@irrigationreal/codex-forum-contracts';
import type { Page, Route } from '@playwright/test';

import type { SessionLog } from '../../../packages/server/src/simulator/sessionLog';

type UserKind = 'human' | 'admin';

type MockContext = {
  now: string;
  forum: ForumDto;
  user: IdentityDto;
  identities: Record<string, IdentityDto>;
  topics: Map<string, TopicDto>;
  postsByTopic: Map<string, PostDto[]>;
  robotStates: Map<string, RobotStateDto>;
  queueCount: number;
  jobs: RobotJobDto[];
  automations: RobotAutomationDto[];
  automationRuns: RobotAutomationRunDto[];
  automationRunsQueryCount: number;
  interruptCount: number;
};

const mockPassword = 'secret';

function buildMockContext(kind: UserKind): MockContext {
  const now = new Date().toISOString();
  const forum: ForumDto = {
    id: 'forum-1',
    tenantId: null,
    parentForumId: null,
    category: null,
    name: 'Codex Forum',
    description: 'Robot workflows testing forum.',
    status: 'active',
    visibility: 'public',
    archivedAt: null,
    threadCount: 2,
    postCount: 2,
    lastPost: null,
    createdAt: now,
    updatedAt: now,
  };
  const userId = kind === 'admin' ? 'identity-admin' : 'identity-user';
  const user: IdentityDto = {
    id: userId,
    displayName: kind === 'admin' ? 'admin' : 'pp',
    kind,
    tenantId: null,
    parentIdentityId: null,
    avatarUrl: null,
    location: 'Somerville, MA',
    signature: 'Ship it.',
    theme: 'classic-light',
    postCount: 42,
    rank: kind === 'admin' ? 'Admin' : 'Member',
    joinDate: now,
    createdAt: now,
    updatedAt: now,
  };
  const identities: MockContext['identities'] = {
    [userId]: user,
  };

  const topics = new Map<string, TopicDto>();
  const postsByTopic = new Map<string, PostDto[]>();
  const robotStates = new Map<string, RobotStateDto>();

  const mentionTopic: TopicDto = {
    id: 'topic-mention',
    forumId: forum.id,
    title: 'Mention-only robot thread',
    robotMode: 'mention',
    status: 'open',
    tags: [],
    createdBy: userId,
    createdByName: user.displayName,
    createdAt: now,
    updatedAt: now,
    postCount: 1,
    lastPostAuthorId: userId,
    lastPostAuthorName: user.displayName,
    lastPostAt: now,
  };

  const offTopic: TopicDto = {
    id: 'topic-off',
    forumId: forum.id,
    title: 'Robot disabled thread',
    robotMode: 'off',
    status: 'open',
    tags: [],
    createdBy: userId,
    createdByName: user.displayName,
    createdAt: now,
    updatedAt: now,
    postCount: 1,
    lastPostAuthorId: userId,
    lastPostAuthorName: user.displayName,
    lastPostAt: now,
  };

  topics.set(mentionTopic.id, mentionTopic);
  topics.set(offTopic.id, offTopic);

  postsByTopic.set(mentionTopic.id, [
    {
      id: 'post-mention-1',
      topicId: mentionTopic.id,
      tenantId: null,
      parentPostId: null,
      authorId: userId,
      body: 'Let us see how mention mode behaves.',
      sourceMessageId: null,
      silent: false,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      reactionCounts: [],
    },
  ]);

  postsByTopic.set(offTopic.id, [
    {
      id: 'post-off-1',
      topicId: offTopic.id,
      tenantId: null,
      parentPostId: null,
      authorId: userId,
      body: 'Robots are disabled here.',
      sourceMessageId: null,
      silent: false,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      reactionCounts: [],
    },
  ]);

  const idleState = (topicId: string): RobotStateDto => ({
    topicId,
    sessionId: `session-${topicId}`,
    activity: 'idle',
    model: null,
    reasoningEffort: null,
    lastUpdatedAt: now,
    currentPlan: null,
    recentToolRuns: [],
  });

  robotStates.set(mentionTopic.id, idleState(mentionTopic.id));
  robotStates.set(offTopic.id, idleState(offTopic.id));

  return {
    now,
    forum,
    user,
    identities,
    topics,
    postsByTopic,
    robotStates,
    queueCount: 0,
    jobs: [],
    automations: [],
    automationRuns: [],
    automationRunsQueryCount: 0,
    interruptCount: 0,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200, headers?: Record<string, string>) {
  await route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

function extractTopicId(pathname: string): string | null {
  const match = /^\/api\/topics\/([^/]+)(?:\/|$)/.exec(pathname);
  return match ? match[1] : null;
}

function hasRobotMention(body: string): boolean {
  return /(^|[^\w])@robot(\b|$)/i.test(body);
}

function toAuthIdentity(identity: IdentityDto, includePrivateEmail = false): AuthIdentityDto {
  return {
    id: identity.id,
    displayName: identity.displayName,
    kind: identity.kind,
    parentIdentityId: identity.parentIdentityId ?? null,
    avatarUrl: identity.avatarUrl ?? null,
    location: identity.location ?? null,
    signature: identity.signature ?? null,
    theme: identity.theme ?? null,
    hasPrivateEmail: includePrivateEmail ? false : undefined,
  };
}

function createBaseSessionLog(context: MockContext): SessionLog {
  return {
    entries: [
      {
        method: 'POST',
        path: '/api/auth/login',
        repeat: true,
        body: {
          identity: toAuthIdentity(context.user),
        },
      },
      {
        method: 'GET',
        path: '/api/auth/me',
        repeat: true,
        body: {
          identity: toAuthIdentity(context.user, true),
        },
      },
      {
        method: 'GET',
        path: '/api/auth/registration',
        repeat: true,
        body: {
          mode: 'disabled',
          registrationEnabled: false,
          inviteRegistrationEnabled: false,
          publicRegistrationEnabled: false,
          passwordLoginEnabled: true,
        },
      },
      {
        method: 'GET',
        path: `/api/identities/${context.user.id}/permissions`,
        repeat: true,
        body: {
          permissions: context.user.kind === 'admin' ? ['admin.all'] : ['read', 'write'],
        },
      },
      {
        method: 'GET',
        path: '/api/posts/recent?limit=3',
        repeat: true,
        body: [],
      },
      {
        method: 'GET',
        path: '/api/admin/deploy/status',
        repeat: true,
        body: {
          enabled: true,
          running: false,
          lastStartedAt: null,
          commitSha: 'deadbeefcafebabe',
        },
      },
    ],
    defaultResponse: {
      status: 500,
      body: { message: 'Unmocked request' },
    },
  };
}

async function attachMockApi(page: Page, context: MockContext) {
  const simulator = createSessionLogSimulator(createBaseSessionLog(context));
  let loggedIn = false;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === '/api/auth/login' && method === 'POST') {
      loggedIn = true;
      await fulfillJson(route, { identity: toAuthIdentity(context.user) });
      return;
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      loggedIn = false;
      await fulfillJson(route, { ok: true });
      return;
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      await fulfillJson(route, { identity: loggedIn ? toAuthIdentity(context.user, true) : null });
      return;
    }

    if (pathname === '/api/forums' && method === 'GET') {
      const lastPost: ForumLastPostDto = {
        postId: Array.from(context.postsByTopic.values())[0]?.[0]?.id ?? 'post-1',
        topicId: Array.from(context.topics.values())[0]?.id ?? 'topic-1',
        topicTitle: Array.from(context.topics.values())[0]?.title ?? 'Thread',
        authorId: context.user.id,
        authorName: context.user.displayName,
        createdAt: context.now,
      };
      await fulfillJson(route, [
        {
          ...context.forum,
          threadCount: context.topics.size,
          postCount: Array.from(context.postsByTopic.values()).reduce((acc, posts) => acc + posts.length, 0),
          lastPost,
        },
      ]);
      return;
    }

    if (pathname === `/api/forums/${context.forum.id}/topics` && method === 'GET') {
      const items = Array.from(context.topics.values());
      await fulfillJson(route, {
        page: 1,
        pageSize: 50,
        total: items.length,
        items,
      });
      return;
    }

    if (pathname === `/api/forums/${context.forum.id}/topics` && method === 'POST') {
      const payload = request.postDataJSON() as { title: string; body: string; robotMode?: 'auto' | 'mention' | 'off' };
      const topicId = `topic-auto-${context.topics.size}`;
      const createdAt = new Date().toISOString();
      const topic: TopicDto = {
        id: topicId,
        forumId: context.forum.id,
        title: payload.title,
        robotMode: payload.robotMode ?? 'auto',
        status: 'open',
        tags: [],
        createdBy: context.user.id,
        createdByName: context.user.displayName,
        createdAt,
        updatedAt: createdAt,
        postCount: 1,
        lastPostAuthorId: context.user.id,
        lastPostAuthorName: context.user.displayName,
        lastPostAt: createdAt,
      };
      context.topics.set(topicId, topic);
      const post: PostDto = {
        id: `post-${topicId}-1`,
        topicId,
        tenantId: null,
        parentPostId: null,
        authorId: context.user.id,
        body: payload.body,
        sourceMessageId: null,
        silent: false,
        createdAt,
        editedAt: null,
        deletedAt: null,
        reactionCounts: [],
      };
      context.postsByTopic.set(topicId, [post]);

      const planSummary = '**Collect context** Reviewing the thread.\n**Draft response** Assemble reply.';
      const toolRuns: ToolRunDto[] = [
        {
          id: `tool-${topicId}-2`,
          tool: 'web',
          parentPostId: post.id,
          startedAt: createdAt,
          finishedAt: null,
          exitCode: null,
          command: 'search_query: robot activity',
          filesTouched: [],
          outputSummary: 'Searching for updates',
          redactionsApplied: false,
          visibility: 'public' as const,
        },
        {
          id: `tool-${topicId}-1`,
          tool: 'shell',
          parentPostId: post.id,
          startedAt: createdAt,
          finishedAt: createdAt,
          exitCode: 0,
          command: 'ls -la',
          filesTouched: [],
          outputSummary: 'Listed 12 files',
          redactionsApplied: false,
          visibility: 'public' as const,
        },
      ];
      context.robotStates.set(topicId, {
        topicId,
        sessionId: `session-${topicId}`,
        activity: 'thinking',
        model: 'gpt-5.2',
        reasoningEffort: 'medium',
        lastUpdatedAt: createdAt,
        currentPlan: {
          id: `plan-${topicId}`,
          content: planSummary,
          summary: planSummary,
          parentPostId: post.id,
          visibility: 'public',
          createdAt: createdAt,
          updatedAt: createdAt,
        },
        recentToolRuns: toolRuns,
      });

      await fulfillJson(route, topic);
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/posts') && method === 'POST') {
      const topicId = extractTopicId(pathname);
      if (!topicId) {
        await route.fulfill({ status: 404 });
        return;
      }
      const payload = request.postDataJSON() as { body: string };
      const createdAt = new Date().toISOString();
      const post: PostDto = {
        id: `post-${topicId}-${Date.now()}`,
        topicId,
        tenantId: null,
        parentPostId: null,
        authorId: context.user.id,
        body: payload.body,
        sourceMessageId: null,
        silent: false,
        createdAt,
        editedAt: null,
        deletedAt: null,
        reactionCounts: [],
      };
      const posts = context.postsByTopic.get(topicId) ?? [];
      posts.push(post);
      context.postsByTopic.set(topicId, posts);
      const topic = context.topics.get(topicId);
      if (topic) {
        topic.postCount = posts.length;
        topic.lastPostAt = createdAt;
        topic.lastPostAuthorId = context.user.id;
        topic.lastPostAuthorName = context.user.displayName;
        topic.updatedAt = createdAt;
      }

      if (hasRobotMention(payload.body)) {
        const planSummary = '**Handle mention** Responding to the tagged request.';
        context.robotStates.set(topicId, {
          topicId,
          sessionId: `session-${topicId}`,
          activity: 'thinking',
          model: 'gpt-5.2',
          reasoningEffort: 'medium',
          lastUpdatedAt: createdAt,
          currentPlan: {
            id: `plan-${topicId}-mention`,
            content: planSummary,
            summary: planSummary,
            parentPostId: post.id,
            visibility: 'public',
            createdAt,
            updatedAt: createdAt,
          },
          recentToolRuns: [],
        });
      }

      context.queueCount += 1;

      await fulfillJson(route, post);
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/robot/interrupt') && method === 'POST') {
      const topicId = extractTopicId(pathname);
      context.interruptCount += 1;
      if (topicId) {
        const current = context.robotStates.get(topicId);
        context.robotStates.set(topicId, {
          topicId,
          sessionId: current?.sessionId ?? `session-${topicId}`,
          activity: 'stopped',
          model: current?.model ?? null,
          reasoningEffort: current?.reasoningEffort ?? null,
          lastUpdatedAt: new Date().toISOString(),
          currentPlan: null,
          recentToolRuns: current?.recentToolRuns ?? [],
        });
      }
      await fulfillJson(route, {
        ok: true,
        operationId: `stop-${context.interruptCount}`,
        generation: context.interruptCount,
        state: 'stopped',
        targets: 1,
        unresolvedCount: 0,
        effectsUnknownCount: 0,
        errorCount: 0,
        message: 'Stopped.',
      });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/state') && method === 'GET') {
      const topicId = extractTopicId(pathname);
      const state = topicId ? context.robotStates.get(topicId) : null;
      const fallbackState: RobotStateDto = {
        topicId: topicId ?? 'unknown',
        sessionId: 'session-missing',
        activity: 'idle',
        model: null,
        reasoningEffort: null,
        lastUpdatedAt: context.now,
        currentPlan: null,
        recentToolRuns: [],
      };
      await fulfillJson(route, state ?? fallbackState);
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/state/stream') && method === 'GET') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ': ping\n\n',
      });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/posts') && method === 'GET') {
      const topicId = extractTopicId(pathname);
      const items = topicId ? (context.postsByTopic.get(topicId) ?? []) : [];
      await fulfillJson(route, {
        page: 1,
        pageSize: 50,
        total: items.length,
        items,
      });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/identities') && method === 'GET') {
      await fulfillJson(route, {
        page: 1,
        pageSize: 100,
        total: Object.keys(context.identities).length,
        items: Object.values(context.identities),
      });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/personas') && method === 'GET') {
      await fulfillJson(route, { items: [] });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/attachments') && method === 'GET') {
      await fulfillJson(route, { itemsByPostId: {} });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/operational-events') && method === 'GET') {
      await fulfillJson(route, { items: [] });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/compactions') && method === 'GET') {
      await fulfillJson(route, { active: null, latest: null, checkpointDispatch: null });
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/session') && method === 'GET') {
      await fulfillJson(route, null);
      return;
    }

    if (pathname.startsWith('/api/topics/') && pathname.endsWith('/trace') && method === 'GET') {
      const topicId = pathname.split('/')[3] ?? '';
      await fulfillJson(route, { topicId, sessionId: null, toolRuns: [], plans: [] });
      return;
    }

    if (pathname.startsWith('/api/topics/') && method === 'GET') {
      const topicId = extractTopicId(pathname);
      if (topicId && context.topics.has(topicId)) {
        await fulfillJson(route, context.topics.get(topicId));
        return;
      }
    }

    if (pathname.startsWith('/api/posts/') && pathname.endsWith('/attachments') && method === 'GET') {
      await fulfillJson(route, []);
      return;
    }

    if (pathname === '/api/admin/robot/dashboard' && method === 'GET') {
      const jobs = context.jobs;
      const queue: RobotQueueItemDto[] = Array.from({ length: context.queueCount }).map((_, idx) => ({
        position: idx + 1,
        queuedAt: context.now,
        topicId: jobs[0]?.topicId ?? 'topic-queue',
        topicTitle: jobs[0]?.topicTitle ?? 'Queued robot topic',
        forumId: context.forum.id,
        forumName: context.forum.name,
        parentPostId: null,
        sessionId: `session-queue-${idx}`,
      }));
      await fulfillJson(route, {
        jobs,
        queue,
        settings: {
          maxConcurrentTurns: 2,
          activeTurnsCount: jobs.filter((job) => job.activity !== 'idle' && job.activity !== 'waiting').length,
        },
      });
      return;
    }

    if (pathname === '/api/admin/robot/automations' && method === 'GET') {
      await fulfillJson(route, { items: context.automations });
      return;
    }

    if (pathname === '/api/admin/robot/automations' && method === 'POST') {
      await fulfillJson(route, {});
      return;
    }

    if (pathname.startsWith('/api/admin/robot/automations/') && pathname.endsWith('/run') && method === 'POST') {
      const automationId = pathname.split('/')[5];
      const run: RobotAutomationRunDto = {
        id: `run-${Date.now()}`,
        automationId,
        worker: 'echs' as const,
        model: 'gpt-5.2',
        reasoningEffort: 'medium',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        outputSummary: 'Starting run',
        lastMessage: null,
      };
      context.automationRuns.unshift(run);
      context.automations = context.automations.map((automation) =>
        automation.id === automationId ? { ...automation, lastRunAt: run.startedAt } : automation
      );
      await fulfillJson(route, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/admin/robot/automations/') && pathname.endsWith('/runs') && method === 'GET') {
      context.automationRunsQueryCount += 1;
      if (context.automationRunsQueryCount > 1 && context.automationRuns[0]) {
        context.automationRuns[0] = {
          ...context.automationRuns[0],
          status: 'succeeded',
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          outputSummary: 'Automation completed',
        };
      }
      await fulfillJson(route, { items: context.automationRuns });
      return;
    }

    if (pathname === '/api/admin/forums' && method === 'GET') {
      const adminForum: AdminForumDto = {
        id: context.forum.id,
        parentForumId: context.forum.parentForumId ?? null,
        category: context.forum.category ?? null,
        name: context.forum.name,
        description: context.forum.description ?? null,
        cwd: '/tmp/forum',
        prePrompt: null,
        status: context.forum.status ?? 'active',
        visibility: context.forum.visibility ?? 'public',
        archivedAt: context.forum.archivedAt ?? null,
        topicCount: context.topics.size,
        createdAt: context.forum.createdAt,
        updatedAt: context.forum.updatedAt,
      };
      await fulfillJson(route, {
        items: [adminForum],
      });
      return;
    }

    if (pathname.startsWith('/api/admin/users') && method === 'GET') {
      const adminUser: AdminUserDto = {
        id: context.user.id,
        displayName: context.user.displayName,
        username: context.user.displayName,
        kind: context.user.kind,
        avatarUrl: null,
        createdAt: context.user.createdAt,
      };
      await fulfillJson(route, {
        page: 1,
        pageSize: 50,
        total: 1,
        items: [adminUser],
      });
      return;
    }

    if (pathname.startsWith('/api/invites') && method === 'GET') {
      await fulfillJson(route, {
        page: 1,
        pageSize: 50,
        total: 0,
        items: [],
      });
      return;
    }

    if (pathname === '/api/adapters/discord/status' && method === 'GET') {
      const status: DiscordBridgeStatusDto = {
        connected: false,
        guildId: undefined,
        guildName: undefined,
        channelMappings: [],
      };
      await fulfillJson(route, status);
      return;
    }

    if (pathname === '/api/adapters/matrix/status' && method === 'GET') {
      const status: MatrixBridgeStatusDto = {
        connected: false,
        homeserverUrl: null,
        userId: null,
        roomMappings: [],
      };
      await fulfillJson(route, status);
      return;
    }

    if (pathname === '/api/admin/skills' && method === 'GET') {
      const response: AdminSkillListResponseDto = {
        generatedAt: context.now,
        promptEnhancerEnabledByDefault: false,
        defaultSkillsRoot: '/opt/skills',
        roots: [],
        items: [],
      };
      await fulfillJson(route, response);
      return;
    }

    if (pathname === '/api/admin/robot/settings' && method === 'PATCH') {
      const settings: RobotSettingsDto = { maxConcurrentTurns: 2 };
      await fulfillJson(route, settings);
      return;
    }

    const response = simulator.handle({ method, url: request.url() });
    if (!response) {
      await route.fulfill({
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: `Unmocked request: ${method} ${pathname}` }),
      });
      return;
    }
    if (response.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
      body: JSON.stringify(response.body),
    });
  });
}

async function login(page: Page, username: string) {
  await page.locator('.vb-welcome-links .vb-link-btn', { hasText: 'Log In' }).click();
  await page.locator('.vb-modal input[type="text"]').fill(username);
  await page.locator('.vb-modal input[type="password"]').fill(mockPassword);
  const meResponse = page.waitForResponse((response) => response.url().includes('/api/auth/me'));
  await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
  await meResponse;
  await expect(page.locator('.vb-welcome')).toContainText(username);
}

// Test ordering note:
// These mocked tests rely on deterministic API responses and state transitions.
// Robot activity is injected via /topics/:id/state responses (no live SSE dependencies),
// and the UI waits on specific selectors instead of timing-based sleeps.
// Any event-stream calls are satisfied with a no-op SSE response to keep the
// state machine stable without flakiness.

test.describe('Robot UI (mocked)', () => {
  test('non-admin auto mode shows only the neutral response placeholder', async ({ page }) => {
    const context = buildMockContext('human');
    await attachMockApi(page, context);

    await page.goto('/');
    await login(page, context.user.displayName);

    const forumTitle = page.locator('.vb-forum-title', { hasText: context.forum.name }).first();
    await expect(forumTitle).toBeVisible();
    await forumTitle.click();
    await page.waitForURL(/\/forums\//);
    await expect(page.locator('.vb-forum-name')).toContainText(context.forum.name);
    const newThreadButton = page.getByRole('button', { name: 'New Thread' }).first();
    await expect(newThreadButton).toBeVisible();
    await newThreadButton.click();
    await page.locator('#thread-title').fill('Auto robot thread');
    await page.locator('.vb-editor-textarea').fill('Kick off auto robot flow.');
    await page.locator('.vb-btn', { hasText: 'Submit New Thread' }).click();

    await expect(page).toHaveURL(/\/topics\/topic-auto/);
    await expect(page.locator('.vb-steer-notice')).toBeVisible();
    await page.locator('.vb-quick-reply textarea').fill('Posting to trigger robot draft.');
    await page.locator('.vb-quick-reply .vb-btn', { hasText: /Reply/ }).click();

    const draftPanel = page.locator('.vb-post--draft');
    await expect(draftPanel).toBeVisible();
    await expect(draftPanel).toContainText('Response in progress…');
    await expect(draftPanel).not.toContainText('Draft response');
    await expect(draftPanel).not.toContainText('List -la');
    await expect(page.getByRole('button', { name: 'Open Trace' })).toHaveCount(0);
  });

  test('keeps long tool details and controls inside the mobile viewport', async ({ page }) => {
    const context = buildMockContext('admin');
    const topicId = 'topic-mention';
    const state = context.robotStates.get(topicId);
    const topic = context.topics.get(topicId);
    if (!state || !topic) throw new Error('missing mocked topic state');
    context.topics.set(topicId, { ...topic, robotMode: 'auto' });

    const longPath = `/${'deeply-nested-directory/'.repeat(20)}document.md`;
    const reasoning = '**Inspect the path**\nConfirm the long path before reading it.';
    context.robotStates.set(topicId, {
      ...state,
      activity: 'running_tools',
      currentPlan: {
        id: `plan-${topicId}-tool-usage`,
        content: reasoning,
        summary: reasoning,
        parentPostId: `post-${topicId}-1`,
        reasoningCheckpoints: [reasoning.length],
        visibility: 'internal',
        createdAt: context.now,
        updatedAt: context.now,
      },
      recentToolRuns: [
        {
          id: `tool-${topicId}-long-read`,
          tool: 'read',
          parentPostId: `post-${topicId}-1`,
          startedAt: context.now,
          finishedAt: context.now,
          exitCode: 0,
          command: `read ${JSON.stringify({ path: longPath, offset: 1, limit: 2000 })}`,
          filesTouched: [],
          outputSummary: 'Read document',
          redactionsApplied: false,
          visibility: 'public',
        },
        {
          id: `tool-${topicId}-older`,
          tool: 'shell',
          parentPostId: `post-${topicId}-older`,
          startedAt: new Date(Date.parse(context.now) - 60_000).toISOString(),
          finishedAt: new Date(Date.parse(context.now) - 59_000).toISOString(),
          exitCode: 0,
          command: 'ls -la',
          filesTouched: [],
          outputSummary: 'Listed files',
          redactionsApplied: false,
          visibility: 'public',
        },
      ],
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await attachMockApi(page, context);
    await page.goto('/');
    await login(page, context.user.displayName);
    await page.goto(`/topics/${topicId}`);

    await page.getByRole('button', { name: 'Admin Tools' }).click();
    await page.locator('.vb-admin-panel').getByRole('button', { name: 'Open Trace' }).click();
    const workspace = page.locator('.vb-admin-workspace');
    await expect(workspace).toBeVisible();
    const reasoningToggle = workspace.getByRole('button', { name: 'Reasoning: On' });
    const reasoningItem = workspace.locator('.vb-tool-item--reasoning');
    const traceItems = workspace.locator('.vb-tool-response .vb-tool-item');
    await expect(reasoningToggle).toBeVisible();
    await expect(reasoningItem).toContainText('Inspect the path');
    await expect(workspace.locator('.vb-tool-response-label')).toHaveCount(2);
    await expect(traceItems).toHaveCount(3);

    await reasoningToggle.click();
    await expect(reasoningItem).toHaveCount(0);
    await expect(traceItems).toHaveCount(2);
    await page.reload();
    await page.getByRole('button', { name: 'Admin Tools' }).click();
    await page.locator('.vb-admin-panel').getByRole('button', { name: 'Open Trace' }).click();
    await expect(workspace.getByRole('button', { name: 'Reasoning: Off' })).toBeVisible();

    await workspace.getByRole('button', { name: 'Reasoning: Off' }).click();
    await expect(reasoningItem).toContainText('Inspect the path');
    await expect(traceItems).toHaveCount(3);

    const reasoningPill = reasoningItem.locator('.vb-tool-pill');
    const completedToolPill = workspace
      .locator('.vb-tool-response .vb-tool-item:not(.vb-tool-item--reasoning) .vb-tool-pill')
      .first();
    await expect(reasoningPill).toHaveClass(/vb-trace-tool-status--ok/);
    await expect(completedToolPill).toHaveClass(/vb-trace-tool-status--ok/);
    const [reasoningPillBox, completedToolPillBox] = await Promise.all([
      reasoningPill.boundingBox(),
      completedToolPill.boundingBox(),
    ]);
    if (!reasoningPillBox || !completedToolPillBox) throw new Error('trace status pills have no layout box');
    expect(
      Math.abs(reasoningPillBox.x + reasoningPillBox.width - (completedToolPillBox.x + completedToolPillBox.width))
    ).toBeLessThanOrEqual(1);

    await reasoningItem.locator('.vb-tool-toggle').click();
    await expect(reasoningItem.locator('.vb-tool-reasoning-detail')).toContainText(
      'Confirm the long path before reading it.'
    );

    const toolToggle = workspace.locator('.vb-tool-item:not(.vb-tool-item--reasoning) .vb-tool-toggle').first();
    const toolControls = toolToggle.locator('.vb-tool-toggle-right');
    const tableDetail = toolToggle.locator('.vb-tool-mini-detail--table');
    await expect(toolToggle).toBeVisible();
    await expect(toolControls).toBeVisible();
    await expect(tableDetail).toBeVisible();

    const [toggleBox, controlsBox] = await Promise.all([toolToggle.boundingBox(), toolControls.boundingBox()]);
    if (!toggleBox || !controlsBox) throw new Error('tool usage controls have no layout box');
    expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(toggleBox.x + toggleBox.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    const surfaceColors = await toolToggle.evaluate((toggle) => {
      const detail = toggle.querySelector<HTMLElement>('.vb-tool-mini-detail--table');
      if (!detail) throw new Error('table detail not found');
      return {
        toggle: getComputedStyle(toggle).backgroundColor,
        detail: getComputedStyle(detail).backgroundColor,
        detailBorderStyle: getComputedStyle(detail).borderStyle,
        detailBorderWidth: getComputedStyle(detail).borderWidth,
      };
    });
    expect(surfaceColors.detail).toBe(surfaceColors.toggle);
    expect(surfaceColors.detailBorderStyle).toBe('solid');
    expect(surfaceColors.detailBorderWidth).toBe('1px');
  });

  test('requires a mobile-safe confirmation from both topic Stop controls', async ({ page }) => {
    const context = buildMockContext('admin');
    const topicId = 'topic-mention';
    const initialState = context.robotStates.get(topicId);
    const topic = context.topics.get(topicId);
    if (!initialState || !topic) throw new Error('missing mocked topic state');
    context.topics.set(topicId, { ...topic, robotMode: 'auto' });
    context.robotStates.set(topicId, { ...initialState, activity: 'thinking' });
    await page.setViewportSize({ width: 390, height: 720 });
    await attachMockApi(page, context);

    await page.goto('/');
    await login(page, context.user.displayName);
    await page.locator('.vb-forum-title', { hasText: context.forum.name }).first().click();
    await page.getByRole('button', { name: /Mention-only robot thread/ }).click();
    await page.waitForURL(`/topics/${topicId}`);
    await page.locator('.vb-quick-reply textarea').fill('(@robot) keep working');

    const quickStop = page.locator('.vb-quick-reply').getByRole('button', { name: 'Stop Robot' });
    await expect(quickStop).toBeVisible();
    await quickStop.click();
    expect(context.interruptCount).toBe(0);

    const dialog = page.getByRole('dialog', { name: 'Stop robot?' });
    await expect(dialog).toBeVisible();
    const keepRunning = dialog.getByRole('button', { name: 'Keep running' });
    await expect(keepRunning).toBeFocused();
    const box = await dialog.boundingBox();
    if (!box) throw new Error('confirmation dialog has no layout box');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(720);
    const keepRunningBox = await keepRunning.boundingBox();
    if (!keepRunningBox) throw new Error('safe action has no layout box');
    expect(keepRunningBox.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close Stop robot?' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(context.interruptCount).toBe(0);

    const previewStop = page.locator('.vb-topic-trace--preview').getByRole('button', { name: 'Stop Robot' });
    await previewStop.click();
    expect(context.interruptCount).toBe(0);
    await page
      .getByRole('dialog', { name: 'Stop robot?' })
      .getByRole('button', { name: 'Stop robot', exact: true })
      .click();
    await expect.poll(() => context.interruptCount).toBe(1);
  });

  test('mention/off modes gate robot dispatch and block non-admin dashboard access', async ({ page }) => {
    const context = buildMockContext('human');
    await attachMockApi(page, context);

    await page.goto('/');
    await login(page, context.user.displayName);

    await page.goto('/admin/robot-dashboard');
    await expect(page).toHaveURL('/');

    const forumTitle = page.locator('.vb-forum-title', { hasText: context.forum.name }).first();
    await forumTitle.click();

    const mentionTopic = page.locator('.vb-thread-title', { hasText: 'Mention-only robot thread' }).first();
    await mentionTopic.click();
    await page.waitForURL(/\/topics\/topic-mention/);
    await expect(page.locator('.vb-quick-reply textarea')).toBeVisible();
    await expect(page.locator('.vb-robot-mode-pill')).toContainText('@mention');

    await page.locator('.vb-quick-reply textarea').fill('No mention here.');
    await expect(page.locator('.vb-quick-reply textarea')).toHaveValue('No mention here.');
    const mentionReplyButton = page.locator('.vb-quick-reply .vb-btn', { hasText: 'Post Quick Reply' });
    await expect(mentionReplyButton).toBeEnabled();
    await mentionReplyButton.click();
    await expect(page.locator('.vb-quick-reply textarea')).toHaveValue('');
    await expect(page.locator('.vb-post-body', { hasText: 'No mention here.' })).toBeVisible();
    await page.goto(`/forums/${context.forum.id}`);
    await page.locator('.vb-thread-title', { hasText: 'Mention-only robot thread' }).first().click();
    await page.waitForURL(/\/topics\/topic-mention/);
    await expect(page.locator('.vb-quick-reply textarea')).toBeVisible();
    await expect(page.locator('.vb-post--draft')).toHaveCount(0);

    await page.locator('.vb-quick-reply textarea').fill('Contact me at email@robot.com');
    await expect(page.locator('.vb-quick-reply textarea')).toHaveValue('Contact me at email@robot.com');
    await expect(mentionReplyButton).toBeEnabled();
    await mentionReplyButton.click();
    await expect(page.locator('.vb-post-body', { hasText: 'email@robot.com' })).toBeVisible();
    await page.goto(`/forums/${context.forum.id}`);
    await page.locator('.vb-thread-title', { hasText: 'Mention-only robot thread' }).first().click();
    await page.waitForURL(/\/topics\/topic-mention/);
    await expect(page.locator('.vb-post--draft')).toHaveCount(0);

    await page.locator('.vb-quick-reply textarea').fill('(@robot) please respond');
    await expect(page.locator('.vb-quick-reply textarea')).toHaveValue('(@robot) please respond');
    await expect(mentionReplyButton).toBeEnabled();
    await mentionReplyButton.click();
    await expect(page.locator('.vb-quick-reply textarea')).toHaveValue('');

    await page.goto(`/forums/${context.forum.id}`);
    await page.locator('.vb-thread-title', { hasText: 'Mention-only robot thread' }).first().click();
    await expect(page.locator('.vb-post--draft')).toBeVisible();

    await page.goto(`/forums/${context.forum.id}`);
    await page.locator('.vb-thread-title', { hasText: 'Robot disabled thread' }).first().click();
    await expect(page.locator('.vb-quick-reply textarea')).toBeVisible();
    await expect(page.locator('.vb-robot-mode-pill')).toContainText('off');
    await expect(page.locator('.vb-reply-options-callout')).toContainText('Robot replies are disabled');
    await page.locator('.vb-quick-reply textarea').fill('Robots should stay quiet.');
    const offReplyButton = page.locator('.vb-quick-reply .vb-btn', { hasText: 'Post Quick Reply' });
    await expect(offReplyButton).toBeEnabled();
    await offReplyButton.click();
    await expect(page.locator('.vb-post--draft')).toHaveCount(0);
  });

  test('admin dashboard, automations, and queued turns stay in sync', async ({ page }) => {
    const context = buildMockContext('admin');
    const queueTopicId = 'topic-queue';
    const createdAt = context.now;
    const queueTopic: TopicDto = {
      id: queueTopicId,
      forumId: context.forum.id,
      title: 'Queue stress test',
      robotMode: 'auto',
      status: 'open',
      tags: [],
      createdBy: context.user.id,
      createdByName: context.user.displayName,
      createdAt,
      updatedAt: createdAt,
      postCount: 1,
      lastPostAuthorId: context.user.id,
      lastPostAuthorName: context.user.displayName,
      lastPostAt: createdAt,
    };
    context.topics.set(queueTopicId, queueTopic);
    context.postsByTopic.set(queueTopicId, [
      {
        id: `post-${queueTopicId}-1`,
        topicId: queueTopicId,
        tenantId: null,
        parentPostId: null,
        authorId: context.user.id,
        body: 'Seed post for queue test.',
        sourceMessageId: null,
        silent: false,
        createdAt,
        editedAt: null,
        deletedAt: null,
        reactionCounts: [],
      },
    ]);
    context.robotStates.set(queueTopicId, {
      topicId: queueTopicId,
      sessionId: `session-${queueTopicId}`,
      activity: 'running_tools',
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
      lastUpdatedAt: createdAt,
      currentPlan: {
        id: `plan-${queueTopicId}`,
        content: '**Queue processing** Working through the backlog.',
        summary: '**Queue processing** Working through the backlog.',
        parentPostId: `post-${queueTopicId}-1`,
        visibility: 'public',
        createdAt,
        updatedAt: createdAt,
      },
      recentToolRuns: [
        {
          id: `tool-${queueTopicId}-1`,
          tool: 'shell',
          parentPostId: `post-${queueTopicId}-1`,
          startedAt: createdAt,
          finishedAt: null,
          exitCode: null,
          command: 'queue_check',
          filesTouched: [],
          outputSummary: 'Inspecting queue',
          redactionsApplied: false,
          visibility: 'public',
        },
      ],
    });
    context.jobs = [
      {
        topicId: queueTopicId,
        topicTitle: queueTopic.title,
        topicStatus: 'open',
        forumId: context.forum.id,
        forumName: context.forum.name,
        sessionId: `session-${queueTopicId}`,
        activity: 'running_tools',
        model: 'gpt-5.2',
        reasoningEffort: 'medium',
        lastUpdatedAt: createdAt,
        activeTurnId: 'turn-1',
        threadLoaded: true,
      },
    ];
    context.automations = [
      {
        id: 'automation-1',
        name: 'Daily triage',
        forumId: context.forum.id,
        prompt: 'Summarize new posts.',
        enabled: true,
        worker: 'echs',
        model: 'gpt-5.2',
        reasoningEffort: 'medium',
        runMode: 'manual',
        intervalMinutes: null,
        lastRunAt: null,
        createdAt: createdAt,
        updatedAt: createdAt,
      },
    ];

    await attachMockApi(page, context);

    await page.goto('/');
    await login(page, context.user.displayName);

    await page.evaluate(async (topicId) => {
      const payloads = ['Queue reply one', 'Queue reply two'];
      for (const body of payloads) {
        await fetch(`/api/topics/${topicId}/posts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body }),
        });
      }
    }, queueTopicId);

    await page.goto('/');
    await expect(page.locator('.vb-forum-title', { hasText: context.forum.name }).first()).toBeVisible();
    await expect(page.locator('.vb-tools').getByText('Robot Dashboard', { exact: true })).toHaveCount(0);
    await expect(page.locator('.vb-tools').getByText('Analytics', { exact: true })).toHaveCount(0);
    await expect(page.locator('.vb-nav-items a')).toHaveText([
      'Forum Home',
      'Admin',
      'Robot Dashboard',
      'Analytics',
      'Chat',
      'Developers',
      'API Docs',
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/admin/robot/dashboard')),
      page.locator('.vb-nav-items').getByText('Robot Dashboard', { exact: true }).click(),
    ]);
    const robotLoadPanel = page.locator('.vb-panel', { hasText: 'Robot Load' });
    await expect(robotLoadPanel.locator('.vb-kv', { hasText: 'Busy' })).toContainText('1');
    await expect(robotLoadPanel.locator('.vb-kv', { hasText: 'Queued' })).toContainText('2');

    await page.evaluate(() => {
      document.cookie = 'cforum_session=mock-access-token; path=/; SameSite=Lax';
    });
    await page.goto('/admin');
    await expect(page.locator('.vb-admin-tabs')).toBeVisible();
    const robotAutomationsTab = page.locator('.vb-admin-tab', { hasText: 'Robot Automations' });
    await expect(robotAutomationsTab).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/admin/robot/automations')),
      robotAutomationsTab.click(),
    ]);
    await expect(page.locator('.vb-form-hint', { hasText: 'Currently active' })).toContainText('1 / 2');

    await page.locator('.vb-admin-table').getByRole('button', { name: 'Run' }).first().click();
    await page.locator('.vb-admin-table').getByRole('button', { name: 'Runs' }).first().click();
    const runsModal = page.locator('.vb-modal', { hasText: 'Automation Runs' });
    await expect(runsModal.locator('tbody tr')).toHaveCount(1);
    await expect(runsModal.locator('tbody tr td').first()).toContainText('running');
    await runsModal.locator('.vb-btn', { hasText: 'Close' }).click();

    await page.locator('.vb-admin-table').getByRole('button', { name: 'Runs' }).first().click();
    await expect(runsModal.locator('tbody tr td').first()).toContainText('succeeded');

    context.robotStates.set(queueTopicId, {
      topicId: queueTopicId,
      sessionId: `session-${queueTopicId}`,
      activity: 'idle',
      model: null,
      reasoningEffort: null,
      lastUpdatedAt: new Date().toISOString(),
      currentPlan: null,
      recentToolRuns: [],
    });
    context.queueCount = 0;
    context.jobs = context.jobs.map((job) => ({
      ...job,
      activity: 'idle',
      lastUpdatedAt: new Date().toISOString(),
    }));

    await page.goto('/admin');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/admin/robot/automations')),
      page.locator('.vb-admin-tab', { hasText: 'Robot Automations' }).click(),
    ]);
    await expect(page.locator('.vb-form-hint', { hasText: 'Currently active' })).toContainText('0 / 2');
  });
});

test.describe('Robot UI (live backend smoke)', () => {
  const liveUsername = process.env['E2E_LIVE_USERNAME'];
  const livePassword = process.env['E2E_LIVE_PASSWORD'];
  const shouldRun = Boolean(process.env['E2E_LIVE_BACKEND']);

  test('creates a topic and reply against the live backend when enabled', async ({ page }) => {
    test.skip(!shouldRun, 'Set E2E_LIVE_BACKEND=1 with credentials to run against the live backend.');
    test.skip(!liveUsername || !livePassword, 'Set E2E_LIVE_USERNAME/E2E_LIVE_PASSWORD to run live flow.');

    await page.goto('/');
    await login(page, liveUsername!);

    await page.locator('.vb-forum-title', { hasText: 'Codex Forum' }).first().click();
    await page.getByRole('button', { name: 'New Thread' }).first().click();

    const title = `Live robot auto ${Date.now()}`;
    await page.locator('#thread-title').fill(title);
    await page.locator('.vb-editor-textarea').fill('Live backend auto robot flow.');
    await page.locator('.vb-btn', { hasText: 'Submit New Thread' }).click();

    await expect(page.locator('h2')).toContainText(title);
    await page.locator('.vb-quick-reply textarea').fill('Live reply to trigger robot.');
    await page.locator('.vb-quick-reply .vb-btn', { hasText: /Reply/ }).click();
    await expect(page.locator('.vb-post-body')).toContainText('Live reply to trigger robot.');
  });

  test('posts a mention in mention-only mode and waits for a robot reply when enabled', async ({ page }) => {
    test.skip(!shouldRun, 'Set E2E_LIVE_BACKEND=1 with credentials to run against the live backend.');
    test.skip(!liveUsername || !livePassword, 'Set E2E_LIVE_USERNAME/E2E_LIVE_PASSWORD to run live flow.');

    await page.goto('/');
    await login(page, liveUsername!);

    await page.locator('.vb-forum-title', { hasText: 'Codex Forum' }).first().click();
    await page.getByRole('button', { name: 'New Thread' }).first().click();

    const title = `Live robot mention ${Date.now()}`;
    await page.locator('#thread-title').fill(title);
    await page.locator('#thread-robot-mode-select').selectOption('mention');
    await page.locator('.vb-editor-textarea').fill('Mention-only live thread.');
    await page.locator('.vb-btn', { hasText: 'Submit New Thread' }).click();

    await expect(page.locator('h2')).toContainText(title);
    await page.locator('.vb-quick-reply textarea').fill('(@robot) hello from live smoke');
    await page.locator('.vb-quick-reply .vb-btn', { hasText: /Reply/ }).click();
    await expect(page.locator('.vb-post-body')).toContainText('(@robot) hello from live smoke');
    await expect(page.locator('.vb-post .vb-user-name', { hasText: 'Forum Robot' })).toBeVisible({ timeout: 90000 });
  });
});
