import type { ForumId, IdentityId, PostId, SessionId, TopicId } from '../domain/ids';

/**
 * A "tamper layer" is an ordered set of plugins that can inspect and modify
 * message text as it flows between the forum and the robot runtime.
 *
 * This is intentionally interface-first; concrete implementations live in
 * adapters/server.
 */

export type MessageTamperDirection = 'inbound' | 'outbound';

/**
 * Stages are named hooks where tamper plugins can run.
 *
 * - inbound.user_to_codex:
 *   Text is about to be sent into the robot runtime for a turn (origin: user/forum).
 *
 * - outbound.codex_to_forum:
 *   Text just came out of the robot runtime (origin: robot) but has not yet been posted.
 *
 * - outbound.forum_post_body:
 *   Text is about to be persisted/broadcast as a forum post (final outbound).
 */
export type MessageTamperStage =
  | 'inbound.user_to_codex'
  | 'outbound.codex_to_forum'
  | 'outbound.forum_post_body';

export interface MessageTamperContext {
  topicId?: TopicId | null;
  forumId?: ForumId | null;
  sessionId?: SessionId | null;
  postId?: PostId | null;
  actorId?: IdentityId | null;

  /**
   * Optional pointer to the post that triggered this run (eg the user post
   * the robot is replying to).
   */
  parentPostId?: PostId | null;

  /**
   * Free-form metadata for adapters to pass through.
   */
  metadata?: Record<string, unknown>;
}

export interface MessageTamperRequest<TContext extends MessageTamperContext = MessageTamperContext> {
  stage: MessageTamperStage;
  direction: MessageTamperDirection;
  text: string;
  context: TContext;
}

export interface MessageTamperResponse {
  text: string;
  /**
   * If true, stop running additional plugins for this stage.
   */
  stop?: boolean;
  /**
   * Optional plugin-provided notes (for debugging/auditing).
   */
  notes?: Record<string, unknown>;
}

export interface MessageTamperPlugin<TContext extends MessageTamperContext = MessageTamperContext> {
  /**
   * Unique, stable key (eg "prompt.enhancer" or "security.redact").
   */
  key: string;
  /**
   * Human-readable description (admin/debug UI).
   */
  description?: string | null;
  /**
   * Higher number runs earlier.
   */
  priority?: number;
  /**
   * Optional dynamic priority resolver. When provided, it overrides `priority`.
   */
  resolvePriority?: (request: MessageTamperRequest<TContext>) => number | null | undefined;
  /**
   * Which stages this plugin should run on.
   */
  stages: MessageTamperStage[];
  tamper(request: MessageTamperRequest<TContext>): Promise<MessageTamperResponse>;
}

export interface MessageTamperTrailEntry {
  pluginKey: string;
  pluginPriority: number;
  stage: MessageTamperStage;
  direction: MessageTamperDirection;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputText: string;
  outputText: string;
  changed: boolean;
  error?: string | null;
  notes?: Record<string, unknown>;
}

export interface MessageTamperResult {
  text: string;
  tampered: boolean;
  trail: MessageTamperTrailEntry[];
}

export interface MessageTamperLayer<TContext extends MessageTamperContext = MessageTamperContext> {
  register(plugin: MessageTamperPlugin<TContext>): void;
  list(): MessageTamperPlugin<TContext>[];
  run(request: MessageTamperRequest<TContext>): Promise<MessageTamperResult>;
}
