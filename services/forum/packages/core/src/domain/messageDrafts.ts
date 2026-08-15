import type { ForumId, IdentityId, TopicId } from './ids';
import type { NotepadDraftOptions } from './notepad';

export const MessageDraftContextValues = ['reply', 'new_thread', 'notepad'] as const;
export type MessageDraftContext = (typeof MessageDraftContextValues)[number];

export interface MessageDraft {
  id: string;
  ownerIdentityId: IdentityId;
  context: MessageDraftContext;
  forumId: ForumId | null;
  topicId: TopicId | null;
  title: string | null;
  body: string;
  options: NotepadDraftOptions | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MessageDraftWriteInput {
  title?: string | null;
  body: string;
  options?: NotepadDraftOptions | null;
}

export const MESSAGE_DRAFT_LIMITS = {
  titleCharacters: 255,
  bodyUtf8Bytes: 65536,
  activePerIdentity: 500,
  retentionDays: 30,
} as const;

export class MessageDraftConflictError extends Error {}
export class MessageDraftNotFoundError extends Error {}
export class MessageDraftQuotaError extends Error {}
export class MessageDraftValidationError extends Error {}
