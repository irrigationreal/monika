import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TopicView persistent Quick Reply dock', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');
  const styles = readFileSync(resolve(process.cwd(), 'src/styles/posts.css'), 'utf8');
  const responsiveStyles = readFileSync(resolve(process.cwd(), 'src/styles/responsive.css'), 'utf8');
  const componentStyles = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');

  it('keeps one composer, textarea, and action across presentation states', () => {
    expect(source).toContain("ref<'inline' | 'docked-expanded' | 'docked-collapsed'>('inline')");
    expect(source.match(/id="quick-reply-composer"/g)).toHaveLength(1);
    expect(source.match(/id="quick-reply-message"/g)).toHaveLength(1);
    expect(source.match(/class="vb-btn vb-quick-reply-submit"/g)).toHaveLength(1);
    expect(source).toContain('v-show="!quickReplyDocked || quickReplyExpanded"');
    expect(source).not.toContain('window.open(');
  });

  it('uses Keep visible as the sole docking entry and exposes collapse, expand, and undock controls', () => {
    expect(source.match(/>\s*Quick Reply\s*</g)).toHaveLength(1);
    expect(source).toContain('aria-label="Keep Quick Reply visible while reading"');
    expect(source).toContain('@click="collapseQuickReply"');
    expect(source).toContain('quickReplyExpandButtonRef.value?.focus()');
    expect(source).toContain('@click="undockQuickReply"');
    expect(source).toContain('@click="undockQuickReply">Undock</button>');
    expect(source).toContain('ref="quickReplyKeepVisibleButtonRef"');
    expect(source).toContain('quickReplyKeepVisibleButtonRef.value?.focus({ preventScroll: true })');
    expect(source).not.toContain('Return inline');
    expect(source).toContain('class="vb-quick-reply-compact-status"');
    expect(source).toContain('aria-controls="quick-reply-dock-body"');
    expect(source).toContain('label for="quick-reply-message"');
  });

  it('preserves presentation when quoting and honors reduced motion for inline scrolling', () => {
    expect(source).toContain("if (quickReplyPresentation.value === 'inline')");
    expect(source).toContain("} else if (quickReplyPresentation.value === 'docked-collapsed') {");
    expect(source).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(source).toContain("behavior: prefersReducedMotion() ? 'auto' : 'smooth'");
    expect(source).toContain('await scrollInlineQuickReply();');
    expect(source).toContain('quickReplyTextareaRef.value?.focus({ preventScroll: true })');
  });

  it('keeps the pre-dock control order and hides only optional controls behind truthful discontiguous disclosure', () => {
    const order = [
      'for="quick-reply-message"',
      'id="quick-reply-template"',
      '<DraftStatus',
      'id="quick-reply-message"',
      'id="quick-reply-attachment-picker"',
      'class="vb-attachment-selected"',
      'id="quick-reply-model-options"',
      'id="quick-reply-auto-compact"',
      'id="quick-reply-context"',
      'v-if="compactionFence"',
      'class="vb-btn vb-quick-reply-submit"',
    ].map((needle) => source.indexOf(needle, source.indexOf('id="quick-reply-composer"')));
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    for (const id of [
      'quick-reply-template',
      'quick-reply-attachment-picker',
      'quick-reply-model-options',
      'quick-reply-auto-compact',
      'quick-reply-context',
    ]) {
      expect(source).toContain(`id="${id}"`);
    }
    expect(source.match(/v-show="quickReplyOptionsOpen"/g)).toHaveLength(5);
    expect(source).toContain(
      "'quick-reply-template quick-reply-attachment-picker quick-reply-model-options quick-reply-auto-compact quick-reply-context'"
    );
    const templateStart = source.indexOf('id="quick-reply-template"');
    const templateEnd = source.indexOf('</div>', templateStart);
    expect(source.indexOf('Open full editor', templateStart)).toBeLessThan(templateEnd);

    const modelOptions = source.indexOf('id="quick-reply-model-options"');
    const robotNotice = source.indexOf('v-if="robotModeNotice"', modelOptions);
    const autoCompact = source.indexOf('id="quick-reply-auto-compact"', modelOptions);
    const context = source.indexOf('id="quick-reply-context"', modelOptions);
    expect(robotNotice).toBeGreaterThan(modelOptions);
    expect(robotNotice).toBeLessThan(autoCompact);
    expect(autoCompact).toBeLessThan(context);
  });

  it('scopes one chainable scrolling middle to the expanded dock and shares one clamped height', () => {
    expect(styles).toContain('--quick-reply-dock-height: min(');
    expect(styles).toContain('calc(100dvh - env(safe-area-inset-bottom) - 12px)');
    expect(styles).toContain('height: var(--quick-reply-dock-height)');
    expect(styles).toContain('padding-bottom: calc(var(--quick-reply-dock-height) + 12px)');
    expect(styles).toContain('bottom: calc(var(--quick-reply-dock-height) + 32px)');
    expect(responsiveStyles).toContain('--quick-reply-dock-height: min(');
    expect(responsiveStyles).toContain('calc(100dvh - env(safe-area-inset-bottom) - 12px)');
    expect(styles).toMatch(/\.vb-quick-reply--expanded \.vb-quick-reply-scroll-region\s*\{[^}]*overflow-y: auto/s);
    expect(styles).not.toMatch(/\.vb-quick-reply-dock-body\s*\{[^}]*overflow-y/s);
    expect(styles).not.toMatch(/\.vb-quick-reply[^}]*\{[^}]*overscroll-behavior/s);
    expect(styles).toContain('.vb-quick-reply-submit {\n  width: 100%;');
  });

  it('does not animate scroll-to-top bottom changes through the dock', () => {
    const scrollTopRule = /\.vb-scroll-top\s*\{(?<rule>[^}]*)\}/s.exec(componentStyles)?.groups?.['rule'] ?? '';
    expect(scrollTopRule).not.toContain('transition: all');
    expect(scrollTopRule).not.toMatch(/transition:[^;]*bottom/s);
    expect(scrollTopRule).toContain('opacity var(--transition-normal)');
    expect(scrollTopRule).toContain('transform var(--transition-normal)');
  });

  it('applies preferences only for an eligible loaded topic and preserves stale-load and attachment guards', () => {
    expect(source).toContain('if (!canDockQuickReply.value) return;');
    expect(source).toContain('v-if="!quickReplyDocked && canDockQuickReply"');
    expect(source).toContain('if (!canDockQuickReply.value && quickReplyDocked.value) resetQuickReplyPresentation();');
    expect(source).toContain('topic.id === routeTopicId.value');
    expect(source).toContain("topic.status === 'open'");
    expect(source).toContain('if (routeTopicId.value !== topicId) return;');
    expect(source).toContain("quickReplyPresentation.value = window.matchMedia('(max-width: 600px)').matches");
    expect(source).toContain('onBeforeRouteLeave(async () =>');
    expect(source).toContain('return confirmReplyFileNavigation();');
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
});
