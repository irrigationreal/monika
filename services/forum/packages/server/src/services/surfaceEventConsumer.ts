import type { ForumCoreEvent, RobotMode, RobotMentionIdentity } from '@irrigationreal/codex-forum-core';
import { hasRobotMention } from '@irrigationreal/codex-forum-core';
import type { AgentBridge } from '../agentBridge';
import type { ForumStore } from '../store';
import type { WebhookService } from './webhookService';
import type { InMemoryEventStore } from './eventStore';

/**
 * Inline dispatch decision logic (not re-exported from core index to avoid
 * naming conflicts with domain/access).
 */
function evaluateDispatchDecision(input: {
  robotMode: RobotMode;
  hasRobotMention: boolean;
  silent?: boolean;
  attachmentsPending?: boolean;
}): { shouldDispatch: boolean } {
  const silent = Boolean(input.silent);
  const deferRobot = Boolean(input.attachmentsPending) && !silent;
  const shouldDispatch =
    !silent &&
    !deferRobot &&
    input.robotMode !== 'off' &&
    (input.robotMode !== 'mention' || input.hasRobotMention);
  return { shouldDispatch };
}

export class WebSurfaceEventConsumer {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: ForumStore,
    private readonly codex: AgentBridge,
    private readonly webhookService: WebhookService,
    private readonly eventStore: InMemoryEventStore
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventStore.onEvent((event) => {
      void this.handleEvent(event);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private async handleEvent(event: ForumCoreEvent): Promise<void> {
    if (event.source.surfaceKind !== 'web') {
      return;
    }

    if (event.type === 'post.created') {
      await this.handlePostCreated(event);
      return;
    }

    if (event.type === 'topic.created') {
      await this.handleTopicCreated(event);
    }
  }

  private async handlePostCreated(event: Extract<ForumCoreEvent, { type: 'post.created' }>): Promise<void> {
    const { postId, topicId } = event.payload;
    const post = this.store.getPost(postId);
    const topic = this.store.getTopic(topicId);
    if (!post || !topic) {
      return;
    }

    this.webhookService.dispatch('post.created', {
      post: {
        id: post.id,
        topicId: post.topic_id,
        parentPostId: post.parent_post_id,
        authorId: post.author_id,
        body: post.body,
        createdAt: post.created_at
      }
    });

    const metadata = event.metadata as {
      shouldDispatchRobot?: boolean | null;
      model?: string | null;
      reasoningEffort?: string | null;
    } | null | undefined;

    const shouldDispatchRobot = this.resolveShouldDispatchRobot({
      explicit: metadata?.shouldDispatchRobot ?? null,
      topicRobotMode: topic.robot_mode,
      body: post.body,
      silent: Boolean(post.silent)
    });

    if (!shouldDispatchRobot) {
      return;
    }

    const replyRobotState = this.store.getRobotState(topicId);
    const shouldSteerReply = replyRobotState && !['idle', 'stopped'].includes(replyRobotState.activity);
    if (shouldSteerReply) {
      await this.codex.steerUserMessage(topicId, post.body, post.id, {
        model: metadata?.model ?? null,
        reasoningEffort: metadata?.reasoningEffort ?? null
      });
    } else {
      await this.codex.sendUserMessage(topicId, post.body, post.id, {
        model: metadata?.model ?? null,
        reasoningEffort: metadata?.reasoningEffort ?? null
      });
    }
  }

  private async handleTopicCreated(event: Extract<ForumCoreEvent, { type: 'topic.created' }>): Promise<void> {
    const { topicId, firstPostId } = event.payload;
    const topic = this.store.getTopic(topicId);
    const post = this.store.getPost(firstPostId);
    if (!topic || !post) {
      return;
    }

    this.webhookService.dispatch('topic.created', {
      topic: {
        id: topic.id,
        forumId: topic.forum_id,
        title: topic.title,
        status: topic.status,
        createdBy: topic.created_by,
        createdAt: topic.created_at
      },
      post: {
        id: post.id,
        topicId: post.topic_id,
        authorId: post.author_id,
        body: post.body,
        createdAt: post.created_at
      }
    });

    const metadata = event.metadata as {
      shouldDispatchRobot?: boolean | null;
      model?: string | null;
      reasoningEffort?: string | null;
    } | null | undefined;

    const shouldDispatchRobot = this.resolveShouldDispatchRobot({
      explicit: metadata?.shouldDispatchRobot ?? null,
      topicRobotMode: topic.robot_mode,
      body: post.body,
      silent: Boolean(post.silent)
    });

    if (!shouldDispatchRobot) {
      return;
    }

    const topicRobotState = this.store.getRobotState(topicId);
    const shouldSteer = topicRobotState && !['idle', 'stopped'].includes(topicRobotState.activity);
    if (shouldSteer) {
      await this.codex.steerUserMessage(topicId, post.body, post.id, {
        model: metadata?.model ?? null,
        reasoningEffort: metadata?.reasoningEffort ?? null
      });
    } else {
      await this.codex.sendUserMessage(topicId, post.body, post.id, {
        model: metadata?.model ?? null,
        reasoningEffort: metadata?.reasoningEffort ?? null
      });
    }
  }

  private resolveShouldDispatchRobot({
    explicit,
    topicRobotMode,
    body,
    silent
  }: {
    explicit: boolean | null;
    topicRobotMode: string | null;
    body: string | null;
    silent: boolean;
  }): boolean {
    if (explicit !== null && explicit !== undefined) {
      return explicit;
    }
    const robotMode = this.resolveRobotMode(topicRobotMode);
    const dispatchDecision = evaluateDispatchDecision({
      robotMode,
      silent,
      hasRobotMention: hasRobotMention(body ?? '', this.getRobotMentionIdentity())
    });
    return dispatchDecision.shouldDispatch;
  }

  private resolveRobotMode(value: string | null): RobotMode {
    if (value === 'mention' || value === 'off' || value === 'auto') {
      return value;
    }
    return 'auto';
  }

  private getRobotMentionIdentity(): RobotMentionIdentity | null {
    const robotIdentity = this.store.getIdentityByKind('robot');
    return robotIdentity
      ? {
          username: robotIdentity.username ?? null,
          displayName: robotIdentity.display_name ?? null
        }
      : null;
  }
}
