import type {
  IdentityRow,
  PostRow,
  ReactionRow,
  RobotStateRow,
  SessionMessageRow,
  SessionRow,
  TopicRow
} from '../db';
import type { TopicStatus } from '@irrigationreal/codex-forum-core';
import type { CreateSessionInput, ReactionCount, UpdatePostInput } from '../store';
import { ForumStore } from '../store';

export interface ForumRuntime {
  getRobotIdentity(): IdentityRow | null;
  ensureSession(input: CreateSessionInput): SessionRow;
  createSessionMessage(sessionId: string, role: string, content: string, visibility: string): SessionMessageRow;
  getRobotState(topicId: string): RobotStateRow | null;
  setRobotActivity(topicId: string, activity: string): RobotStateRow | null;
  getSessionByTopic(topicId: string): SessionRow | null;
  getPost(postId: string): PostRow | null;
  setPostSilent(postId: string, silent: boolean): PostRow;
  updatePost(postId: string, input: UpdatePostInput): PostRow;
  softDeletePost(postId: string): PostRow;
  updateTopicStatus(topicId: string, status: TopicStatus): import('../db').TopicRow;
  updateTopicTitle(topicId: string, title: string): import('../db').TopicRow;
  updateTopicTags(topicId: string, tags: string[]): import('../db').TopicRow;
  deleteTopic(topicId: string): void;
  listReactionsByPost(postId: string): ReactionRow[];
  addReaction(postId: string, identityId: string, emoji: string): ReactionRow;
  removeReaction(postId: string, identityId: string, emoji: string): void;
  getReactionCounts(postId: string): ReactionCount[];
}

export class ForumStoreRuntime implements ForumRuntime {
  constructor(private readonly store: ForumStore) {}

  getRobotIdentity(): IdentityRow | null {
    return this.store.getIdentityByKind('robot');
  }

  ensureSession(input: CreateSessionInput): SessionRow {
    return this.store.ensureSession(input);
  }

  createSessionMessage(sessionId: string, role: string, content: string, visibility: string): SessionMessageRow {
    return this.store.createSessionMessage(sessionId, role, content, visibility);
  }

  getRobotState(topicId: string): RobotStateRow | null {
    return this.store.getRobotState(topicId);
  }

  setRobotActivity(topicId: string, activity: string): RobotStateRow | null {
    return this.store.setRobotActivity(topicId, activity);
  }

  getSessionByTopic(topicId: string): SessionRow | null {
    return this.store.getSessionByTopic(topicId);
  }

  getPost(postId: string): PostRow | null {
    return this.store.getPost(postId);
  }

  setPostSilent(postId: string, silent: boolean): PostRow {
    return this.store.setPostSilent(postId, silent);
  }

  updatePost(postId: string, input: UpdatePostInput): PostRow {
    return this.store.updatePost(postId, input);
  }

  softDeletePost(postId: string): PostRow {
    return this.store.softDeletePost(postId);
  }

  updateTopicStatus(topicId: string, status: TopicStatus): TopicRow {
    return this.store.updateTopicStatus(topicId, status);
  }

  updateTopicTitle(topicId: string, title: string): TopicRow {
    return this.store.updateTopicTitle(topicId, title);
  }

  updateTopicTags(topicId: string, tags: string[]): TopicRow {
    return this.store.updateTopicTags(topicId, tags);
  }

  deleteTopic(topicId: string): void {
    this.store.deleteTopic(topicId);
  }

  listReactionsByPost(postId: string): ReactionRow[] {
    return this.store.listReactionsByPost(postId);
  }

  addReaction(postId: string, identityId: string, emoji: string): ReactionRow {
    return this.store.addReaction(postId, identityId, emoji);
  }

  removeReaction(postId: string, identityId: string, emoji: string): void {
    this.store.removeReaction(postId, identityId, emoji);
  }

  getReactionCounts(postId: string): ReactionCount[] {
    return this.store.getReactionCounts(postId);
  }
}
