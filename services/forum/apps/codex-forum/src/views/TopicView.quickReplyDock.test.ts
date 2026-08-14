import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TopicView persistent Quick Reply dock', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');

  it('keeps one composer and one textarea across inline, expanded, and collapsed presentation states', () => {
    expect(source).toContain("ref<'inline' | 'docked-expanded' | 'docked-collapsed'>('inline')");
    expect(source.match(/id="quick-reply-composer"/g)).toHaveLength(1);
    expect(source.match(/id="quick-reply-message"/g)).toHaveLength(1);
    expect(source).toContain('v-show="!quickReplyDocked || quickReplyExpanded"');
    expect(source).not.toContain('window.open(');
  });

  it('offers explicit accessible launch, focus-preserving presentation controls, and compact status', () => {
    expect(source.match(/@click="activateQuickReply\(true\)"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source.match(/:aria-expanded="!quickReplyDocked \|\| quickReplyExpanded"/g)).toHaveLength(2);
    expect(source).toContain('@click="collapseQuickReply"');
    expect(source).toContain('quickReplyExpandButtonRef.value?.focus()');
    expect(source).toContain('@click="returnQuickReplyInline"');
    expect(source).toContain('quickReplyTextareaRef.value?.focus({ preventScroll: true })');
    expect(source).toContain('class="vb-quick-reply-compact-status"');
    expect(source).toContain('aria-controls="quick-reply-dock-body"');
    expect(source).toContain('label for="quick-reply-message"');
  });

  it('expands and focuses after quoting while applying preferences only for an eligible loaded topic', () => {
    expect(source).toContain('if (!canDockQuickReply.value) return;');
    expect(source).toContain('v-if="!quickReplyDocked && canDockQuickReply"');
    expect(source).toContain('if (!canDockQuickReply.value && quickReplyDocked.value) resetQuickReplyPresentation();');
    expect(source).toContain('await activateQuickReply(true);');
    expect(source).toContain('topic.id === routeTopicId.value');
    expect(source).toContain("topic.status === 'open'");
    expect(source).toContain('if (routeTopicId.value !== topicId) return;');
    expect(source).toContain("quickReplyPresentation.value = window.matchMedia('(max-width: 600px)').matches");
    expect(source).not.toContain('applyQuickReplyDefault(true)');
  });

  it('stops stale topic-load continuations before topic-specific side effects', () => {
    const selection = source.indexOf('await state.selectTopicById(topicId);');
    const fence = source.indexOf(
      'if (routeTopicId.value !== topicId || state.selectedTopic.value?.id !== topicId) return;',
      selection
    );
    const compactionRefresh = source.indexOf('await refreshCompactionState(topicId);', selection);
    expect(selection).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(selection);
    expect(compactionRefresh).toBeGreaterThan(fence);
  });

  it('keeps exceptional attachment state outside the one optional-controls container', () => {
    const optionsStart = source.indexOf('id="quick-reply-options"');
    const optionsEnd = source.indexOf('<DraftStatus', optionsStart);
    const recovery = source.indexOf('Reply posted; attachment upload is incomplete.');
    const selected = source.indexOf('class="vb-attachment-selected"');
    expect(optionsStart).toBeGreaterThan(-1);
    expect(source.indexOf('ref="replyFileInputRef"')).toBeLessThan(optionsEnd);
    expect(source.indexOf('id="model-select"')).toBeLessThan(optionsEnd);
    expect(source.indexOf('<AutoCompactOption', optionsStart)).toBeLessThan(optionsEnd);
    expect(recovery).toBeGreaterThan(optionsEnd);
    expect(selected).toBeGreaterThan(optionsEnd);
    expect(source).toContain("if (isUploadingReply.value) return 'Uploading attachments…';");
    expect(source).toContain(
      "if (quickReplyHasAttachmentRecovery.value) return 'Reply posted — attachment recovery required';"
    );
    expect(source.match(/id="quick-reply-options"/g)).toHaveLength(1);
    expect(source).toContain('onBeforeRouteLeave(async () =>');
    expect(source).toContain('return confirmReplyFileNavigation();');
  });
});
