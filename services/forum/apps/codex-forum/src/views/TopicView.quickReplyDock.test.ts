import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TopicView persistent Quick Reply dock', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');
  const stateSource = readFileSync(resolve(process.cwd(), 'src/composables/useForumState.ts'), 'utf8');
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

  it('keeps the selected inline or docked style fixed while exposing collapse and expand within docked mode', () => {
    expect(source.match(/>\s*Quick Reply\s*</g)).toHaveLength(1);
    expect(source).toContain('@click="collapseQuickReply"');
    expect(source).toContain('quickReplyExpandButtonRef.value?.focus()');
    expect(source).toContain('@click="activateQuickReply"');
    expect(source).not.toContain('Keep visible');
    expect(source).not.toContain('Undock');
    expect(source).not.toContain('undockQuickReply');
    expect(source).not.toContain('quickReplyKeepVisibleButtonRef');
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

  it('keeps operational state visible and hides only ancillary controls behind truthful disclosure', () => {
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
    expect(source.match(/v-show="quickReplyOptionsOpen"/g)).toHaveLength(3);
    expect(source).toContain(
      'aria-controls="quick-reply-template quick-reply-attachment-picker quick-reply-auto-compact"'
    );
    expect(source).toContain('id="quick-reply-model-options" class="vb-reply-options"');
    expect(source).toContain('v-if="sessionContext" id="quick-reply-context"');
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

  it('reveals one resolved initial presentation and never reapplies the preference beneath an active draft', () => {
    expect(source).toContain('const quickReplyPresentationReady = ref(false);');
    expect(source).toContain('v-if="quickReplyPresentationReady"');
    expect(source).toContain('quickReplyPresentationReady.value = false;');
    expect(source).toContain('const baseTopicReady = Boolean(authChecked && topicId && selectedTopicId === topicId);');
    expect(source).toContain('applyQuickReplyDefault();\n      quickReplyPresentationReady.value = true;');
    expect(source).toContain('@input="quickReplyPresentationTouched = true"');
    const routeLoad = source.slice(
      source.indexOf('watch(\n  routeTopicId,'),
      source.indexOf('watch(\n  [', source.indexOf('watch(\n  routeTopicId,'))
    );
    expect(routeLoad).not.toContain('quickReplyPresentationReady.value = true;');
    expect(routeLoad).not.toContain('autosavedReply.load');
    expect(source).toContain('},\n  { immediate: true }\n);');
    expect(source).not.toContain('() => state.currentUser.value?.quickReplyDesktopMode,');
    expect(source).not.toContain('() => state.currentUser.value?.quickReplyMobileMode,');
    expect(source).toContain('if (!canDockQuickReply.value) return;');
    expect(source).toContain('canDockQuickReply.value && quickReplyPreferenceNeedsReapply');
    expect(source).toContain('resetQuickReplyPresentation({ reapplyPreference: true });');
    expect(source).toContain('topic.id === routeTopicId.value');
    expect(source).toContain("topic.status === 'open'");
    expect(source).toContain('if (routeTopicId.value !== topicId) return;');
    expect(source).toContain('resolveQuickReplyMode(state.currentUser.value, isMobileQuickReplyViewport())');
    expect(source).toContain("mode === 'docked' ? 'docked-collapsed' : 'inline'");
    expect(source).toContain('onBeforeRouteLeave(async () =>');
    expect(source).toContain('return confirmReplyFileNavigation();');
    expect(source).not.toContain('applyQuickReplyDefault(true)');
  });

  it('resets options after successful submissions and collapses posts without collapsing steers', () => {
    expect(source).toContain('const wasSteeringRobot = quickReplyWillSteerRobot.value;');
    expect(source).toContain('quickReplyOptionsOpen.value = false;');
    expect(source).toContain('if (quickReplyDocked.value && !wasSteeringRobot) await collapseQuickReply();');
    expect(
      source.indexOf('quickReplyOptionsOpen.value = false;', source.indexOf('async function reply()'))
    ).toBeGreaterThan(source.indexOf("scrollToAnchor('smooth');", source.indexOf('async function reply()')));
  });

  it('keeps admin Trace enrichment off the topic and live-stream critical path', () => {
    expect(stateSource).toContain('const adminEnrichmentLoading = ref(false);');
    expect(stateSource).toContain('const adminEnrichmentError = ref<string | null>(null);');
    expect(stateSource).not.toContain('await loadAdminEnrichment');
    expect(stateSource).toContain('openStream(topic.id);\n        void loadAdminEnrichment(topic.id);');
    expect(stateSource).toContain('Promise.all([api.getSessionByTopic(topicId), api.getTopicTrace(topicId)])');
    expect(source).toContain('state.adminEnrichmentLoading.value && !state.sessionInfo.value');
    expect(source).toContain('Session metadata unavailable: {{ state.adminEnrichmentError.value }}');
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
