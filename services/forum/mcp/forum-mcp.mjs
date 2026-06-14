#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE_ENV = process.env.CODEX_FORUM_API_BASE_URL ?? 'http://localhost:4310';
const API_PREFIX_ENV = process.env.CODEX_FORUM_API_PREFIX ?? '/api';
const DEFAULT_TOKEN = process.env.CODEX_FORUM_MCP_TOKEN ?? process.env.CODEX_FORUM_TOKEN ?? null;

const normalizeBase = (value) => (value.endsWith('/') ? value.slice(0, -1) : value);
const normalizePrefix = (value) => {
  if (!value) return '';
  const trimmed = value.startsWith('/') ? value : `/${value}`;
  return trimmed === '/' ? '' : trimmed;
};

const API_BASE_URL = `${normalizeBase(API_BASE_ENV)}${normalizePrefix(API_PREFIX_ENV)}`;

const tokenCache = new Map();

const buildHeaders = (token, hasBody) => {
  const headers = {
    Accept: 'application/json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
};

const parseResponse = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const request = async (path, { method = 'GET', body, token } = {}) => {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = buildHeaders(token, body !== undefined);
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`API ${response.status} ${response.statusText}: ${detail}`);
  }
  return data;
};

const requireToken = (token) => {
  if (!token) {
    throw new Error(
      'Missing forum auth token. Set CODEX_FORUM_MCP_TOKEN or CODEX_FORUM_TOKEN in the MCP server env.'
    );
  }
  return token;
};

const getImpersonationToken = async (identityId) => {
  if (!identityId) return null;
  const cached = tokenCache.get(identityId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }
  const baseToken = requireToken(DEFAULT_TOKEN);
  const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
  const payload = {
    label: `mcp:${identityId}`,
    impersonatedIdentityId: identityId,
    scopes: ['read', 'write'],
    expiresAt
  };
  const response = await request('/impersonation-tokens', {
    method: 'POST',
    body: payload,
    token: baseToken
  });
  const token = response?.token;
  if (!token) {
    throw new Error('Failed to create impersonation token. Ensure the base token has admin scope.');
  }
  tokenCache.set(identityId, { token, expiresAt: new Date(expiresAt).getTime() - 5_000 });
  return token;
};

const withAuth = async (identityId) => {
  if (!identityId) return requireToken(DEFAULT_TOKEN);
  return getImpersonationToken(identityId);
};

const respond = (data, summary) => ({
  content: [{ type: 'text', text: summary ?? JSON.stringify(data, null, 2) }],
  structuredContent: data
});

const PaginationSchema = z
  .object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(200).default(50)
  })
  .strict();

const PageSchema = PaginationSchema.shape.page.optional();
const PageSizeSchema = PaginationSchema.shape.pageSize.optional();

const server = new McpServer({
  name: 'codex-forum-mcp-server',
  version: '1.0.0'
});

server.registerTool(
  'forum_list_forums',
  {
    title: 'List forums',
    description: 'List all forums visible to the current token.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async () => {
    const data = await request('/forums', { token: DEFAULT_TOKEN });
    return respond(data);
  }
);

server.registerTool(
  'forum_list_topics',
  {
    title: 'List topics',
    description: 'List topics within a forum.',
    inputSchema: z
      .object({
        forumId: z.string().min(1),
        page: PageSchema,
        pageSize: PageSizeSchema
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ forumId, page = 1, pageSize = 50 }) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const data = await request(`/forums/${forumId}/topics?${params}`, { token: DEFAULT_TOKEN });
    return respond(data);
  }
);

server.registerTool(
  'forum_get_topic',
  {
    title: 'Get topic',
    description: 'Fetch a single topic by id.',
    inputSchema: z.object({ topicId: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ topicId }) => {
    const data = await request(`/topics/${topicId}`, { token: DEFAULT_TOKEN });
    return respond(data);
  }
);

server.registerTool(
  'forum_list_posts',
  {
    title: 'List posts',
    description: 'List posts in a topic.',
    inputSchema: z
      .object({
        topicId: z.string().min(1),
        page: PageSchema,
        pageSize: PageSizeSchema
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ topicId, page = 1, pageSize = 50 }) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const data = await request(`/topics/${topicId}/posts?${params}`, { token: DEFAULT_TOKEN });
    return respond(data);
  }
);

server.registerTool(
  'forum_create_topic',
  {
    title: 'Create topic',
    description:
      'Create a new topic in a forum. Optionally impersonate another identity by providing authorIdentityId (requires admin token).',
    inputSchema: z
      .object({
        forumId: z.string().min(1),
        title: z.string().min(1),
        body: z.string().min(1),
        model: z.string().min(1).optional(),
        reasoningEffort: z.string().min(1).optional(),
        authorIdentityId: z.string().min(1).optional()
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  async ({ forumId, title, body, model, reasoningEffort, authorIdentityId }) => {
    const token = await withAuth(authorIdentityId);
    const payload = { title, body };
    if (model) payload.model = model;
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
    const data = await request(`/forums/${forumId}/topics`, {
      method: 'POST',
      body: payload,
      token
    });
    return respond(data, `Created topic ${data?.id ?? ''}`.trim());
  }
);

server.registerTool(
  'forum_reply',
  {
    title: 'Reply to topic',
    description:
      'Reply in a topic. Optionally impersonate another identity by providing authorIdentityId (requires admin token).',
    inputSchema: z
      .object({
        topicId: z.string().min(1),
        body: z.string().min(1),
        parentPostId: z.string().min(1).optional(),
        authorIdentityId: z.string().min(1).optional()
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  async ({ topicId, body, parentPostId, authorIdentityId }) => {
    const token = await withAuth(authorIdentityId);
    const payload = { body };
    if (parentPostId) payload.parentPostId = parentPostId;
    const data = await request(`/topics/${topicId}/posts`, {
      method: 'POST',
      body: payload,
      token
    });
    return respond(data, `Created post ${data?.id ?? ''}`.trim());
  }
);

server.registerTool(
  'forum_list_topic_identities',
  {
    title: 'List topic identities',
    description: 'List identities participating in a topic.',
    inputSchema: z
      .object({
        topicId: z.string().min(1),
        page: PageSchema,
        pageSize: PageSizeSchema
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ topicId, page = 1, pageSize = 200 }) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const data = await request(`/topics/${topicId}/identities?${params}`, { token: DEFAULT_TOKEN });
    return respond(data);
  }
);

server.registerTool(
  'forum_list_users',
  {
    title: 'List users',
    description:
      'List users (admin only). Use kind="robot" to filter robots. Set allPages=true to retrieve all pages.',
    inputSchema: z
      .object({
        page: PageSchema,
        pageSize: PageSizeSchema,
        kind: z.string().min(1).optional(),
        allPages: z.boolean().optional()
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ page = 1, pageSize = 50, kind, allPages }) => {
    const token = requireToken(DEFAULT_TOKEN);
    const results = [];
    let currentPage = page;
    while (true) {
      const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize) });
      const data = await request(`/admin/users?${params}`, { token });
      const items = Array.isArray(data?.items) ? data.items : [];
      results.push(...items);
      if (!allPages || items.length < pageSize) break;
      currentPage += 1;
    }
    const filtered = kind ? results.filter((item) => item.kind === kind) : results;
    return respond({ items: filtered, total: filtered.length, page, pageSize, kind: kind ?? null, allPages: Boolean(allPages) });
  }
);

server.registerTool(
  'forum_get_identity',
  {
    title: 'Get identity',
    description: 'Fetch a single identity by id.',
    inputSchema: z.object({ identityId: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ identityId }) => {
    const token = requireToken(DEFAULT_TOKEN);
    const data = await request(`/identities/${identityId}`, { token });
    return respond(data);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
