import type { SessionLog } from '../sessionLog';

const now = new Date().toISOString();

export const mockForumSessionLog: SessionLog = {
  entries: [
    {
      method: 'GET',
      path: '/api/forums',
      match: 'path',
      repeat: true,
      body: [
        {
          id: 'forum-1',
          tenantId: null,
          parentForumId: null,
          category: null,
          name: 'Codex Forum',
          description: 'Mocked forum data for contract-driven UI tests.',
          status: 'active',
          visibility: 'public',
          archivedAt: null,
          threadCount: 1,
          postCount: 1,
          lastPost: {
            postId: 'post-1',
            topicId: 'topic-1',
            topicTitle: 'Welcome to the mock thread',
            authorId: 'identity-1',
            authorName: 'pp',
            createdAt: now
          },
          createdAt: now,
          updatedAt: now
        }
      ]
    },
    {
      method: 'GET',
      path: '/api/posts/recent',
      match: 'prefix',
      repeat: true,
      body: [
        {
          postId: 'post-1',
          topicId: 'topic-1',
          topicTitle: 'Welcome to the mock thread',
          forumId: 'forum-1',
          forumName: 'Codex Forum',
          authorId: 'identity-1',
          authorName: 'pp',
          body: 'Recent post from the mock API.',
          createdAt: now
        }
      ]
    },
    {
      method: 'GET',
      path: '/api/forums/forum-1/topics',
      match: 'prefix',
      repeat: true,
      body: {
        page: 1,
        pageSize: 50,
        total: 1,
        items: [
          {
            id: 'topic-1',
            forumId: 'forum-1',
            tenantId: null,
            title: 'Welcome to the mock thread',
            status: 'open',
            tags: [],
            robotMode: 'auto',
            createdBy: 'identity-1',
            createdByName: 'pp',
            createdAt: now,
            updatedAt: now,
            postCount: 1,
            lastPostAuthorId: 'identity-1',
            lastPostAuthorName: 'pp',
            lastPostAt: now
          }
        ]
      }
    },
    {
      method: 'GET',
      path: '/api/topics/topic-1',
      match: 'path',
      repeat: true,
      body: {
        id: 'topic-1',
        forumId: 'forum-1',
        tenantId: null,
        title: 'Welcome to the mock thread',
        status: 'open',
        tags: [],
        robotMode: 'auto',
        createdBy: 'identity-1',
        createdByName: 'pp',
        createdAt: now,
        updatedAt: now,
        postCount: 1,
        lastPostAuthorId: 'identity-1',
        lastPostAuthorName: 'pp',
        lastPostAt: now
      }
    },
    {
      method: 'GET',
      path: '/api/topics/topic-1/posts',
      match: 'prefix',
      repeat: true,
      body: {
        page: 1,
        pageSize: 50,
        total: 1,
        items: [
          {
            id: 'post-1',
            topicId: 'topic-1',
            tenantId: null,
            parentPostId: null,
            authorId: 'identity-1',
            body: 'Hello from the mock server simulator.',
            sourceMessageId: null,
            silent: false,
            createdAt: now,
            editedAt: null,
            deletedAt: null,
            reactionCounts: []
          }
        ]
      }
    },
    {
      method: 'GET',
      path: '/api/topics/topic-1/state',
      match: 'path',
      repeat: true,
      body: {
        topicId: 'topic-1',
        sessionId: 'session-1',
        activity: 'idle',
        model: null,
        reasoningEffort: null,
        lastUpdatedAt: now,
        currentPlan: null,
        recentToolRuns: []
      }
    },
    {
      method: 'GET',
      path: '/api/topics/topic-1/session',
      match: 'path',
      repeat: true,
      body: null
    },
    {
      method: 'GET',
      path: '/api/topics/topic-1/identities',
      match: 'prefix',
      repeat: true,
      body: {
        page: 1,
        pageSize: 50,
        total: 1,
        items: [
          {
            id: 'identity-1',
            tenantId: null,
            displayName: 'pp',
            kind: 'human',
            parentIdentityId: null,
            avatarUrl: null,
            location: null,
            signature: null,
            theme: null,
            createdAt: now,
            updatedAt: now
          }
        ]
      }
    },
    {
      method: 'GET',
      path: '/api/topics/topic-1/personas',
      match: 'path',
      repeat: true,
      body: { items: [] }
    }
  ],
  defaultResponse: {
    status: 404,
    body: { message: 'No mock response found for request.' }
  }
};
