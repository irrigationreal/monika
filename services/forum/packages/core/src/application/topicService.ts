import type {
  CreateTopicInput,
  TopicCreationResult,
  TopicService
} from '../interfaces/services';
import type {
  ForumRepository,
  TopicRepository,
  PostRepository,
  IdentityRepository
} from '../interfaces/repositories';
import type { Topic, Post } from '../domain/entities';
import type { Clock, IdGenerator } from './types';

export class TopicServiceImpl implements TopicService {
  constructor(
    private readonly deps: {
      topics: TopicRepository;
      posts: PostRepository;
      clock: Clock;
      ids: IdGenerator;
      forums?: ForumRepository;
      identities?: IdentityRepository;
    }
  ) {}

  listTopics(forumId: Topic['forumId'], page?: number, pageSize?: number): Promise<Topic[]> {
    return this.deps.topics.listByForum(forumId, page, pageSize);
  }

  getTopic(topicId: Topic['id']): Promise<Topic | null> {
    return this.deps.topics.getById(topicId);
  }

  async createTopic(input: CreateTopicInput): Promise<TopicCreationResult> {
    const forum = this.deps.forums ? await this.deps.forums.getById(input.forumId) : null;
    if (this.deps.forums && !forum) {
      throw new Error('forum not found');
    }

    if (this.deps.identities) {
      const identity = await this.deps.identities.getById(input.authorId);
      if (!identity) {
        throw new Error('author not found');
      }
    }

    const now = this.deps.clock.now();
    const tenantId = input.tenantId ?? forum?.tenantId ?? null;
    const topic: Topic = {
      id: this.deps.ids.nextId(),
      forumId: input.forumId,
      tenantId,
      title: input.title,
      status: 'open',
      robotMode: input.robotMode ?? 'auto',
      tags: [],
      createdBy: input.authorId,
      createdAt: now,
      updatedAt: now
    };

    const silent = Boolean(input.silent) || Boolean(input.attachmentsPending);
    const post: Post = {
      id: this.deps.ids.nextId(),
      topicId: topic.id,
      tenantId,
      parentPostId: null,
      authorId: input.authorId,
      body: input.body,
      sourceMessageId: null,
      silent,
      createdAt: now,
      editedAt: null,
      deletedAt: null
    };

    await this.deps.topics.create(topic);
    await this.deps.posts.create(post);

    return { topic, post };
  }
}
