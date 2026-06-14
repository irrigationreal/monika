export type CliCommand =
  | { name: 'forums.list' }
  | { name: 'forums.create'; nameValue: string; description?: string }
  | { name: 'topics.list'; forumId: string }
  | { name: 'topics.create'; forumId: string; title: string; body: string }
  | { name: 'topics.get'; topicId: string }
  | { name: 'posts.reply'; topicId: string; body: string; parentPostId?: string }
  | { name: 'identities.list'; topicId: string }
  | { name: 'identities.get'; identityId: string }
  | { name: 'externals.list'; topicId: string }
  | { name: 'sessions.get'; sessionId: string }
  | { name: 'sessions.inspect'; sessionId: string }
  | { name: 'state.get'; topicId: string };

export interface CliRunner {
  run(command: CliCommand): Promise<void>;
}
