import type { SessionCapture } from '../sessionCapture';
import type { SessionLog } from '../sessionLog';
import { createSessionLogFromCapture } from '../sessionCapture';

const now = new Date().toISOString();

export const sniffedForumSessionCapture: SessionCapture = {
  meta: {
    capturedAt: now,
    baseUrl: 'http://localhost:5173',
    description: 'Sniffed forum session used for mocked E2E runs.'
  },
  entries: [
    {
      method: 'GET',
      url: '^/api/forums(?:\\?.*)?$',
      match: 'regex',
      repeat: true,
      body: [
        {
          id: 'forum-1',
          tenantId: null,
          parentForumId: null,
          category: null,
          name: 'Codex Forum',
          description: 'Sniffed forum data for contract-driven UI tests.',
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
      url: 'http://localhost:5173/api/posts/recent?limit=3',
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
          body: 'Recent post from the sniffed session.',
          createdAt: now
        }
      ]
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/forums/forum-1/topics',
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
      url: 'http://localhost:5173/api/topics/topic-1',
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
      url: 'http://localhost:5173/api/topics/topic-1/posts',
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
            body: 'Hello from the sniffed session simulator.',
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
      url: 'http://localhost:5173/api/posts/post-1/attachments',
      repeat: true,
      body: []
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/topics/topic-1/state',
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
      url: 'http://localhost:5173/api/topics/topic-1/session',
      repeat: true,
      body: null
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/topics/topic-1/identities',
      repeat: true,
      body: {
        page: 1,
        pageSize: 100,
        total: 1,
        items: [
          {
            id: 'identity-1',
            tenantId: null,
            displayName: 'pp',
            kind: 'human',
            parentIdentityId: null,
            avatarUrl: null,
            location: 'Somerville, MA',
            signature: 'Ship it.',
            theme: 'classic-light',
            postCount: 42,
            rank: 'Member',
            joinDate: now,
            createdAt: now,
            updatedAt: now
          }
        ]
      }
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/topics/topic-1/personas',
      repeat: true,
      body: { items: [] }
    },
    {
      method: 'POST',
      url: 'http://localhost:5173/api/auth/login',
      repeat: true,
      body: {
        identity: {
          id: 'identity-1',
          displayName: 'pp',
          kind: 'human',
          parentIdentityId: null,
          avatarUrl: null,
          theme: 'classic-light'
        }
      }
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/auth/me',
      repeat: true,
      body: {
        identity: {
          id: 'identity-1',
          displayName: 'pp',
          kind: 'human',
          parentIdentityId: null,
          avatarUrl: null,
          location: 'Somerville, MA',
          signature: 'Ship it.',
          theme: 'classic-light',
          hasPrivateEmail: false
        }
      }
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/identities/identity-1/permissions',
      repeat: true,
      body: {
        permissions: ['read', 'write']
      }
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/profiles/identity-1',
      repeat: true,
      body: {
        id: 'identity-1',
        tenantId: null,
        displayName: 'pp',
        kind: 'human',
        parentIdentityId: null,
        avatarUrl: null,
        location: 'Somerville, MA',
        signature: 'Ship it.',
        theme: 'classic-light',
        postCount: 42,
        rank: 'Member',
        joinDate: now,
        createdAt: now,
        updatedAt: now
      }
    },
    {
      method: 'GET',
      url: 'http://localhost:5173/api/profiles/identity-1/posts?page=1&pageSize=25',
      match: 'prefix',
      repeat: true,
      body: {
        page: 1,
        pageSize: 25,
        total: 1,
        items: [
          {
            postId: 'post-1',
            topicId: 'topic-1',
            topicTitle: 'Welcome to the mock thread',
            forumId: 'forum-1',
            forumName: 'Codex Forum',
            createdAt: now,
            excerpt: 'Hello from the sniffed session simulator.'
          }
        ]
      }
    }
  ],
  defaultResponse: {
    status: 404,
    body: { message: 'No mock response found for request.' }
  }
};

export const sniffedForumSessionLog: SessionLog = createSessionLogFromCapture(sniffedForumSessionCapture);
