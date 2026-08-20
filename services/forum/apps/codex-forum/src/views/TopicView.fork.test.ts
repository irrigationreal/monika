import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TopicView fork controls', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');
  const dialog = readFileSync(resolve(process.cwd(), 'src/components/ForkTopicDialog.vue'), 'utf8');

  it('keeps Fork admin-only beside Handoff and Compact', () => {
    expect(source).toContain(
      '<button v-if="isAdmin" class="vb-btn" :disabled="!canFork" @click="openForkModal">Fork</button>'
    );
    expect(source.indexOf('>Handoff</button>')).toBeLessThan(source.indexOf('@click="openForkModal">Fork</button>'));
    expect(source.indexOf('@click="openForkModal">Fork</button>')).toBeLessThan(
      source.indexOf('@click="openCompactionModal">Compact</button>')
    );
  });

  it('displays forum post numbers while selecting and submitting stable post ids', () => {
    expect(dialog).toContain(':value="boundary.postId"');
    expect(dialog).toContain('#{{ boundary.postNumber }}');
    expect(source).toContain('boundaryPostId: forkBoundaryPostId.value');
  });

  it('persists and reconciles the same durable operation across ambiguous responses and reload', () => {
    expect(source).toContain('codex-forum:fork-intent:');
    expect(source).toContain('persistForkIntent(intent)');
    expect(source).toContain('await api.getForkState(topicId)');
    expect(source).toContain('operationId: intent.operationId');
  });

  it('renders manual review as an active source fence without polling or blind retry', () => {
    expect(source).toContain("operation?.status === 'needs_manual_review'");
    expect(source).toContain('Fork needs operator review; the source remains fenced.');
    expect(source).toContain(
      'Replies are paused because a fork needs operator review; the canonical source remains fenced.'
    );
    expect(source).toContain("if (operation.status === 'pending' || operation.status === 'running') scheduleForkPoll");
  });

  it('mounts the dedicated dialog with canonical refresh and authoritative submit state', () => {
    expect(source).toContain('<ForkTopicDialog');
    expect(source).toContain(':loading="forkBoundariesLoading"');
    expect(source).toContain(':can-submit="canSubmitFork"');
    expect(source).toContain('requestGeneration !== forkBoundaryRequestGeneration');
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-describedby="fork-modal-description"');
    expect(dialog).toContain("event.key === 'Escape'");
  });
});
