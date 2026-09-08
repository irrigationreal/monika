import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TopicView duplicate-thread controls', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');
  const menu = readFileSync(resolve(process.cwd(), 'src/components/BranchMenu.vue'), 'utf8');

  it('uses the Branch disclosure in both action rows while leaving the other actions direct', () => {
    expect(source.match(/<BranchMenu/g)).toHaveLength(2);
    expect(source.match(/@duplicate="openDuplicateModal"/g)).toHaveLength(2);
    expect(source.match(/@fork="openForkModal"/g)).toHaveLength(2);
    expect(menu).toContain('Duplicate current thread');
    expect(menu).toContain('Fork from an earlier message');
    expect(menu).toContain('aria-haspopup="menu"');
    expect(menu).toContain('@media (max-width: 600px)');
    expect(source.match(/\n\s+Handoff\n/g)).toHaveLength(2);
    expect(source).toContain('@click="openCompactionModal">Compact</button>');
    expect(source).toContain('@click="goHome">Back to Forum</button>');
  });

  it('defaults the editable title and persists intent before an idempotent submit', () => {
    expect(source).toContain('`Copy of ${state.selectedTopic.value?.title');
    expect(source).toContain('codex-forum:clone-intent:');
    expect(source).toContain('persistCloneIntent(intent);');
    const submit = source.slice(
      source.indexOf('async function submitDuplicate'),
      source.indexOf('function forkIntentKey')
    );
    expect(submit.indexOf('persistCloneIntent(intent);')).toBeLessThan(submit.indexOf('await api.createClone('));
    expect(source).toContain('await api.getCloneState(topicId)');
    expect(source).toContain('await api.getClone(topicId, intent.operationId)');
  });

  it('polls ambiguous operations, exposes manual review as a source fence, and navigates only for matching local intent', () => {
    expect(source).toContain('The outcome is unknown; the same durable operation will be reconciled automatically.');
    expect(source).toContain("operation.status === 'needs_manual_review'");
    expect(source).toContain('Duplicate needs operator review; the source remains fenced.');
    expect(source).toContain(
      'Replies are paused because a duplicate needs operator review; the canonical source remains fenced.'
    );
    expect(source).toContain('const initiatedLocally = intent?.operationId === operation.id;');
    expect(source).toContain('if (!initiatedLocally) return;');
    expect(source.indexOf('if (!initiatedLocally) return;')).toBeLessThan(
      source.indexOf("await router.push({ name: 'topic.view', params: { topicId: operation.childTopicId } });")
    );
    expect(source).toContain('if (!operation.childTopicId)');
    expect(source).toContain('params: { topicId: operation.childTopicId }');
    expect(source).not.toContain('params: { topicId: operation.childSessionId }');
  });

  it('labels explicit clone lineage distinctly from fork and handoff', () => {
    expect(source).toContain("if (kind === 'clone') return 'Duplicated from parent thread';");
  });
});
