export interface RobotMentionIdentity {
  username?: string | null;
  displayName?: string | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMentionToken(raw?: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return /^[a-z0-9_-]+$/i.test(trimmed) ? trimmed : null;
}

export function hasRobotMention(body: string, identity?: RobotMentionIdentity | null): boolean {
  const tokens = new Set<string>(['robot']);
  if (identity?.username) {
    tokens.add(identity.username);
  }
  const displayToken = normalizeMentionToken(identity?.displayName);
  if (displayToken) {
    tokens.add(displayToken);
  }
  for (const token of tokens) {
    // Allow common punctuation before @mentions (e.g. "(@robot)" or "hello,@robot"),
    // while avoiding matching inside email addresses / words.
    const pattern = new RegExp(`(^|[^\\w])@${escapeRegExp(token)}(\\b|$)`, 'i');
    if (pattern.test(body)) {
      return true;
    }
  }
  return false;
}
