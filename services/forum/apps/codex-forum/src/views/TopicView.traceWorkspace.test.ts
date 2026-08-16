import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const topicSource = readFileSync(resolve(process.cwd(), 'src/views/TopicView.vue'), 'utf8');
const traceSource = readFileSync(resolve(process.cwd(), 'src/components/TopicTraceViewer.vue'), 'utf8');

describe('canonical topic Trace workspace', () => {
  it('uses one shared trace viewer for the live preview and full admin workspace', () => {
    expect(topicSource).toContain('<TopicTraceViewer\n          v-if="isAdmin"\n          preview');
    expect(topicSource).toContain('<TopicTraceViewer :topic-id="routeTopicId" />');
    expect(traceSource).toContain('previewCardLimit?: number;');
    expect(traceSource).toContain('group.cards.slice(-props.previewCardLimit)');
    expect(traceSource).toContain('buildLiveTraceItems');
    expect(traceSource).toContain('buildPersistedTraceItems');
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
    expect(topicSource).toContain("type AdminWorkspaceTab = 'trace' | 'robot' | 'session' | 'auto';");
    expect(topicSource).toContain('aria-label="Admin workspace"');
    expect(topicSource).toContain('Robot Diagnostics');
    expect(topicSource).toContain('Session Details');
    expect(topicSource).toContain('Auto-Director');
  });
});
