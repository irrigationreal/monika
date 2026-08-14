import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TopicView post copy action', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');

  it('copies exact stored post source and reports clipboard failures', () => {
    expect(source).toContain('await copyTextToClipboard(post.body);');
    expect(source).toContain("state.setError('Could not copy the post. Your browser denied clipboard access.');");
  });

  it('places Copy between Quote and Link and disables it only for deleted posts', () => {
    const quoteAction = source.indexOf('@click="quotePost(post)"');
    const copyAction = source.indexOf('@click="copyPostSource(post)"');
    const linkAction = source.indexOf('@click="copyPostLink(post)"');

    expect(quoteAction).toBeGreaterThan(-1);
    expect(copyAction).toBeGreaterThan(quoteAction);
    expect(linkAction).toBeGreaterThan(copyAction);

    const copyButton = source.slice(source.lastIndexOf('<button', copyAction), source.indexOf('</button>', copyAction));
    expect(copyButton).toContain(':disabled="!!post.deletedAt"');
    expect(copyButton).not.toContain('state.isTopicLocked()');
    expect(copyButton).toContain("copiedPostSourceId === post.id ? 'Copied' : 'Copy'");
  });
});
