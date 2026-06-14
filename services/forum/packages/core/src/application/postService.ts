import type { CreatePostInput, PostCreationResult, PostService } from '../interfaces/services';
import type { IdentityRepository, PostRepository, TopicRepository } from '../interfaces/repositories';
import type { Post, Topic } from '../domain/entities';
import type { Clock, IdGenerator } from './types';

export class PostServiceImpl implements PostService {
  constructor(
    private readonly deps: {
      posts: PostRepository;
      topics?: TopicRepository;
      identities?: IdentityRepository;
      clock: Clock;
      ids: IdGenerator;
    }
  ) {}

  listPosts(topicId: Post['topicId'], page?: number, pageSize?: number): Promise<Post[]> {
    return this.deps.posts.listByTopic(topicId, page, pageSize);
  }

  async createPost(input: CreatePostInput): Promise<PostCreationResult> {
    let topic: Topic | null = null;
    if (this.deps.topics) {
      topic = await this.deps.topics.getById(input.topicId);
      if (!topic) {
        throw new Error('topic not found');
      }
    }

    if (this.deps.identities) {
      const identity = await this.deps.identities.getById(input.authorId);
      if (!identity) {
        throw new Error('author not found');
      }
    }

    const now = this.deps.clock.now();
    const tenantId = input.tenantId ?? topic?.tenantId ?? null;
    const silent = Boolean(input.silent) || Boolean(input.attachmentsPending);

    const post: Post = {
      id: this.deps.ids.nextId(),
      topicId: input.topicId,
      tenantId,
      parentPostId: input.parentPostId ?? null,
      authorId: input.authorId,
      body: input.body,
      sourceMessageId: input.sourceMessageId ?? null,
      silent,
      createdAt: now,
      editedAt: null,
      deletedAt: null
    };

    await this.deps.posts.create(post);

    return { post };
  }
}
