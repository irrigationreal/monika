import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TopicView fork controls', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');

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
    expect(source).toContain(':value="boundary.postId"');
    expect(source).toContain('#{{ boundary.postNumber }}');
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

  it('implements accessible dialog focus, keyboard trapping, and restoration', () => {
    expect(source).toContain('ref="forkModalRef"');
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('aria-labelledby="fork-modal-title"');
    expect(source).toContain('@keydown="handleForkKeydown"');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('restoreForkModalEnvironment()');
    expect(source).toContain('aria-label="Close fork dialog"');
  });
});
