import type { ForumId, IdentityId, TopicId } from './ids';

export const ACCESS_RULE_SCOPE_KINDS = ['forum', 'topic'] as const;
// Back-compat: contracts historically imported these `*Values` constants from core.
export const AccessRuleScopeKindValues: typeof ACCESS_RULE_SCOPE_KINDS = ACCESS_RULE_SCOPE_KINDS;
export type AccessRuleScopeKind = (typeof ACCESS_RULE_SCOPE_KINDS)[number];

export const ACCESS_RULE_PRINCIPAL_KINDS = ['all', 'logged_in', 'identity', 'role'] as const;
export const AccessRulePrincipalKindValues: typeof ACCESS_RULE_PRINCIPAL_KINDS = ACCESS_RULE_PRINCIPAL_KINDS;
export type AccessRulePrincipalKind = (typeof ACCESS_RULE_PRINCIPAL_KINDS)[number];

export const ACCESS_RULE_ACTIONS = ['view', 'post', 'topic.create', 'moderate'] as const;
export const AccessRuleActionValues: typeof ACCESS_RULE_ACTIONS = ACCESS_RULE_ACTIONS;
export type AccessRuleAction = (typeof ACCESS_RULE_ACTIONS)[number];

export const ACCESS_RULE_EFFECTS = ['allow', 'deny'] as const;
export const AccessRuleEffectValues: typeof ACCESS_RULE_EFFECTS = ACCESS_RULE_EFFECTS;
export type AccessRuleEffect = (typeof ACCESS_RULE_EFFECTS)[number];

export interface AccessRule {
  id: string;
  scopeKind: AccessRuleScopeKind;
  scopeId: ForumId | TopicId;
  principalKind: AccessRulePrincipalKind;
  principalId?: IdentityId | string | null;
  action: AccessRuleAction;
  effect: AccessRuleEffect;
  createdAt: string;
}
