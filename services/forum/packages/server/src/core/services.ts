import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ForumServiceImpl,
  TopicServiceImpl,
  PostServiceImpl,
  IdentityServiceImpl,
  type ForumService,
  type TopicService,
  type PostService,
  type IdentityService
} from '@irrigationreal/codex-forum-core';
import { nowIso } from '../db';
import {
  SqliteForumRepository,
  SqliteTopicRepository,
  SqlitePostRepository,
  SqliteIdentityRepository
} from './sqliteRepositories';

export interface CoreServices {
  forums: ForumService;
  topics: TopicService;
  posts: PostService;
  identities: IdentityService;
}

export function createCoreServices(db: Database.Database): CoreServices {
  const clock = { now: () => nowIso() };
  const ids = { nextId: () => randomUUID() };
  const forums = new SqliteForumRepository(db);
  const topics = new SqliteTopicRepository(db);
  const posts = new SqlitePostRepository(db);
  const identities = new SqliteIdentityRepository(db);

  return {
    forums: new ForumServiceImpl({ forums, clock, ids }),
    topics: new TopicServiceImpl({ topics, posts, forums, identities, clock, ids }),
    posts: new PostServiceImpl({ posts, topics, identities, clock, ids }),
    identities: new IdentityServiceImpl(identities)
  };
}
