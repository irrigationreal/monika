#!/usr/bin/env node
const args = process.argv.slice(2);
const baseRaw = process.env.CODEX_FORUM_API_BASE_URL || 'http://localhost:4310';
const base = baseRaw.replace(/\/$/, '');
const token = process.env.CODEX_FORUM_TOKEN;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(
    'Usage: forums list | topics list --forum <id> [--page <n>] [--pageSize <n>] | topics get --topic <id> | topics create --forum <id> --title <title> --body <body> [--model <model>] [--reasoning <effort>] | posts list --topic <id> [--page <n>] [--pageSize <n>] | posts reply --topic <id> --body <body> [--parentPostId <id>] | robot wait --topic <id> [--topic <id> ...] [--topics <id,id>] [--timeout <ms>] [--poll <ms>]'
  );
  process.exit(1);
}

function getFlagValue(flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function getFlagValues(flag) {
  const values = [];
  args.forEach((value, index) => {
    if (value === flag && args[index + 1]) {
      values.push(args[index + 1]);
    }
  });
  return values;
}

function getNumericFlag(flag, fallback) {
  const raw = getFlagValue(flag);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function request(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!headers['Content-Type'] && options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { ...options, headers });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    console.error(JSON.stringify({ status: res.status, body: data }, null, 2));
    process.exit(1);
  }
  if (!options.silent && data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  return data;
}

async function requestJson(path, options = {}) {
  return request(path, { ...options, silent: true });
}

async function fetchRobotIdentityId(topicId) {
  const pageSize = 200;
  const res = await requestJson(`/topics/${topicId}/identities?page=1&pageSize=${pageSize}`);
  const robot = res?.items?.find((item) => item.kind === 'robot');
  return robot?.id ?? null;
}

async function fetchRobotState(topicId) {
  return requestJson(`/topics/${topicId}/state`);
}

async function fetchLastPost(topicId) {
  const firstPage = await requestJson(`/topics/${topicId}/posts?page=1&pageSize=1`);
  const total = Number(firstPage?.total ?? 0);
  if (!total) return null;
  const lastPage = total;
  const last = await requestJson(`/topics/${topicId}/posts?page=${lastPage}&pageSize=1`);
  return last?.items?.[0] ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const [resource, action] = args;
  if (!resource || !action) usage();

  if (resource === 'forums' && action === 'list') {
    return request('/forums');
  }

  if (resource === 'topics' && action === 'list') {
    const forumId = getFlagValue('--forum');
    if (!forumId) usage('Missing forum id');
    const page = getNumericFlag('--page');
    const pageSize = getNumericFlag('--pageSize');
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (pageSize) params.set('pageSize', String(pageSize));
    const suffix = params.toString() ? `?${params}` : '';
    return request(`/forums/${forumId}/topics${suffix}`);
  }

  if (resource === 'topics' && action === 'get') {
    const topicId = getFlagValue('--topic');
    if (!topicId) usage('Missing topic id');
    return request(`/topics/${topicId}`);
  }

  if (resource === 'topics' && action === 'create') {
    const forumId = getFlagValue('--forum');
    const title = getFlagValue('--title');
    const body = getFlagValue('--body');
    const model = getFlagValue('--model');
    const reasoning = getFlagValue('--reasoning') || getFlagValue('--reasoningEffort');
    if (!forumId || !title || !body) usage('Missing required fields');
    const payload = { title, body };
    if (model) payload.model = model;
    if (reasoning) payload.reasoningEffort = reasoning;
    return request(`/forums/${forumId}/topics`, { method: 'POST', body: JSON.stringify(payload) });
  }

  if (resource === 'posts' && action === 'list') {
    const topicId = getFlagValue('--topic');
    if (!topicId) usage('Missing topic id');
    const page = getNumericFlag('--page');
    const pageSize = getNumericFlag('--pageSize');
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (pageSize) params.set('pageSize', String(pageSize));
    const suffix = params.toString() ? `?${params}` : '';
    return request(`/topics/${topicId}/posts${suffix}`);
  }

  if (resource === 'posts' && action === 'reply') {
    const topicId = getFlagValue('--topic');
    const body = getFlagValue('--body');
    const parentPostId = getFlagValue('--parentPostId');
    if (!topicId || !body) usage('Missing required fields');
    const payload = { body };
    if (parentPostId) payload.parentPostId = parentPostId;
    return request(`/topics/${topicId}/posts`, { method: 'POST', body: JSON.stringify(payload) });
  }

  if (resource === 'robot' && action === 'wait') {
    const topics = new Set([
      ...getFlagValues('--topic'),
      ...getFlagValues('--topics')
        .flatMap((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
    ]);
    if (topics.size === 0) usage('Missing topic ids');

    const timeoutMs = getNumericFlag('--timeout', 10 * 60 * 1000);
    const pollMs = getNumericFlag('--poll', 2000);
    const startTime = Date.now();

    const topicState = new Map();
    for (const topicId of topics) {
      const [robotId, lastPost, state] = await Promise.all([
        fetchRobotIdentityId(topicId),
        fetchLastPost(topicId),
        fetchRobotState(topicId)
      ]);
      const activity = state?.activity ?? 'idle';
      topicState.set(topicId, {
        robotId,
        lastPostId: lastPost?.id ?? null,
        lastPostAt: lastPost?.createdAt ?? null,
        lastActivity: activity
      });
      console.log(
        JSON.stringify(
          {
            topicId,
            robotId,
            activity,
            lastPostId: lastPost?.id ?? null,
            lastPostAt: lastPost?.createdAt ?? null
          },
          null,
          2
        )
      );
    }

    const pending = new Set(topics);
    const results = [];
    while (pending.size > 0 && Date.now() - startTime < timeoutMs) {
      for (const topicId of Array.from(pending)) {
        const info = topicState.get(topicId);
        const [state, lastPost] = await Promise.all([
          fetchRobotState(topicId),
          fetchLastPost(topicId)
        ]);
        const activity = state?.activity ?? 'idle';
        if (activity !== info.lastActivity) {
          info.lastActivity = activity;
          console.log(JSON.stringify({ topicId, activity }, null, 2));
        }
        if (
          lastPost &&
          info.robotId &&
          lastPost.authorId === info.robotId &&
          lastPost.id !== info.lastPostId
        ) {
          pending.delete(topicId);
          results.push({ topicId, postId: lastPost.id, createdAt: lastPost.createdAt });
          console.log(
            JSON.stringify(
              { topicId, status: 'robot_reply', postId: lastPost.id, createdAt: lastPost.createdAt },
              null,
              2
            )
          );
        }
      }
      if (pending.size > 0) {
        await sleep(pollMs);
      }
    }

    if (pending.size > 0) {
      console.error(
        JSON.stringify(
          {
            status: 'timeout',
            pending: Array.from(pending),
            waitedMs: Date.now() - startTime
          },
          null,
          2
        )
      );
      process.exit(2);
    }
    console.log(JSON.stringify({ status: 'ok', results }, null, 2));
    return;
  }

  usage('Unknown command');
})();
