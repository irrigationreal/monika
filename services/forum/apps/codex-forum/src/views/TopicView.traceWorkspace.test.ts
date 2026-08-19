import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const topicSource = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');
const traceSource = readFileSync(resolve(process.cwd(), 'src/components/TopicTraceViewer.vue'), 'utf8');
const postsCss = readFileSync(resolve(process.cwd(), 'src/styles/posts.css'), 'utf8');

describe('canonical topic Trace workspace', () => {
  it('uses one shared trace viewer for the live preview and full admin workspace', () => {
    expect(topicSource).toContain('<TopicTraceViewer\n          v-if="isAdmin"\n          preview');
    expect(topicSource).toContain('<TopicTraceViewer :topic-id="routeTopicId" />');
    expect(traceSource).toContain('previewCardLimit?: number;');
    expect(traceSource).toContain('group.cards.slice(-props.previewCardLimit)');
    expect(traceSource).toContain("const traceDirection = ref<TraceDirection>('newest-first');");
    expect(traceSource).toContain("if (traceDirection.value === 'oldest-first') return [...groups].reverse();");
    expect(traceSource).toContain('cards: [...group.cards].reverse()');
    expect(traceSource).not.toContain('codex-forum:trace:order');
    expect(traceSource).toContain('buildLiveTraceItems');
    expect(traceSource).toContain('buildPersistedTraceItems');
  });

  it('hands off visible movement from startup to the active Trace preview', () => {
    expect(traceSource).toContain(
      '<strong>Trace</strong>\n        <span v-if="renderGroups.length > 0" class="vb-spinner vb-spinner-dark" aria-hidden="true"></span>\n        <span class="vb-status-pill">'
    );
    expect(traceSource).toContain(
      '<span class="vb-spinner vb-spinner-dark" aria-hidden="true"></span>\n        Starting response…'
    );
  });

  it('keeps destructive stop behind the shared confirmation workflow', () => {
    expect(topicSource).toContain('@stop="requestStopRobot"');
    expect(topicSource).toContain('function requestStopRobot(): void');
    expect(topicSource).toContain('showStopRobotConfirm.value = true;');
    expect(topicSource).toContain('title="Stop robot?"');
  });

  it('removes competing post, activity, and inspector trace presentations', () => {
    expect(topicSource).not.toContain('PostTracePanel');
    expect(topicSource).not.toContain('LiveAssistantTurn');
    expect(topicSource).not.toContain('Trace History');
    expect(topicSource).not.toContain('Tool Calls (session)');
    expect(topicSource).not.toContain('Messages (session)');
    expect(topicSource).not.toContain('<strong>Activity:</strong>');
  });

  it('places secondary operations in the shared admin workspace', () => {
    expect(topicSource).toContain("type AdminWorkspaceTab = 'trace' | 'diagnostics' | 'auto';");
    expect(topicSource).toContain('aria-label="Admin workspace"');
    expect(topicSource).toContain('Session Diagnostics');
    expect(topicSource).toContain('Robot State');
    expect(topicSource).toContain('Session Metadata');
    expect(topicSource).not.toContain('Robot Diagnostics');
    expect(topicSource).not.toContain('Session Details');
    expect(topicSource).toContain('Auto-Director');
  });

  it('uses a defined solid theme surface behind workspace content', () => {
    expect(postsCss).toMatch(/\.vb-admin-workspace \{[\s\S]*background: var\(--bg-surface\);/);
    expect(postsCss).not.toContain('background: var(--bg-primary);');
  });
});
