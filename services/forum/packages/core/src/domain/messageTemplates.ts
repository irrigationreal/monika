import type { ForumId, IdentityId } from './ids';

export const MessageTemplateContextValues = ['reply', 'new_thread'] as const;
export type MessageTemplateContext = (typeof MessageTemplateContextValues)[number];

export const MessageTemplateScopeValues = ['personal', 'system'] as const;
export type MessageTemplateScope = (typeof MessageTemplateScopeValues)[number];

export const MessageTemplateForumScopeValues = ['all', 'selected'] as const;
export type MessageTemplateForumScope = (typeof MessageTemplateForumScopeValues)[number];

export interface MessageTemplate {
  id: string;
  scope: MessageTemplateScope;
  ownerIdentityId: IdentityId | null;
  name: string;
  category: string | null;
  body: string;
  threadTitle: string | null;
  forumScope: MessageTemplateForumScope;
  forumIds: ForumId[];
  contexts: MessageTemplateContext[];
  enabled: boolean;
  sortOrder: number;
  revision: number;
  createdBy: IdentityId | null;
  updatedBy: IdentityId | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTemplateWriteInput {
  name: string;
  category?: string | null;
  body: string;
  threadTitle?: string | null;
  forumScope: MessageTemplateForumScope;
  forumIds: ForumId[];
  contexts: MessageTemplateContext[];
  enabled: boolean;
}

export const MESSAGE_TEMPLATE_LIMITS = {
  nameCharacters: 80,
  categoryCharacters: 40,
  threadTitleCharacters: 255,
  bodyUtf8Bytes: 65536,
  personalCount: 200,
  systemCount: 500,
} as const;

export class MessageTemplateConflictError extends Error {}
export class MessageTemplateNotFoundError extends Error {}
export class MessageTemplateQuotaError extends Error {}
export class MessageTemplateValidationError extends Error {}
