import { describe, expect, it } from 'vitest';
import { getToolMiniModel } from './toolMiniView';
import type { ToolRunDto } from './apiClient';

/**
 * Minimal ToolRunDto factory for testing. Only the fields that getToolMiniModel
 * reads need to be populated; everything else is stubbed.
 */
function makeToolRun(overrides: Partial<ToolRunDto> & Pick<ToolRunDto, 'tool' | 'command'>): ToolRunDto {
  return {
    id: 'test-id',
    parentPostId: null,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    exitCode: 0,
    filesTouched: null,
    outputSummary: null,
    redactionsApplied: false,
    visibility: 'internal',
    ...overrides,
  } as ToolRunDto;
}

describe('getToolMiniModel', () => {
  describe('Pi-style capitalised tool names', () => {
    it('parses Bash command from Pi-format exec tool', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'exec',
          command: 'Bash {"command":"echo hello","timeout":15}',
        })
      );

      expect(model.kind).toBe('exec');
      expect(model.summary).toBe('echo hello');
    });

    it('parses Read tool with capitalised name', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'read',
          command: 'Read {"path":"/tmp/test.txt"}',
        })
      );

      expect(model.kind).toBe('read');
      expect(model.summary).toBe('/tmp/test.txt');
    });

    it('parses Edit/Write as apply_patch kind', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'apply_patch',
          command: 'Edit {"path":"/tmp/test.txt","new_text":"hello"}',
        })
      );

      expect(model.kind).toBe('apply_patch');
    });

    it('parses Grep tool with capitalised name', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'read',
          command: 'Grep {"pattern":"TODO","path":"/workspace"}',
        })
      );

      expect(model.kind).toBe('read');
      expect(model.summary).toBe('TODO');
    });
  });

  describe('timeout extraction with unit conversion', () => {
    it('extracts timeout in seconds and converts to milliseconds', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'exec',
          command: 'Bash {"command":"sleep 10","timeout":15}',
        })
      );

      expect(model.meta.timeoutMs).toBe(15000);
    });

    it('extracts timeoutMs as-is (already milliseconds)', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'exec',
          command: 'Bash {"command":"sleep 10","timeoutMs":5000}',
        })
      );

      expect(model.meta.timeoutMs).toBe(5000);
    });

    it('extracts timeout_ms as-is (already milliseconds)', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'exec',
          command: 'Bash {"command":"sleep 10","timeout_ms":8000}',
        })
      );

      expect(model.meta.timeoutMs).toBe(8000);
    });

    it('returns no timeout when field is absent', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'exec',
          command: 'Bash {"command":"echo hello"}',
        })
      );

      expect(model.meta.timeoutMs).toBeUndefined();
    });

    it('returns no timeout for zero or negative values', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'exec',
          command: 'Bash {"command":"echo hello","timeout":0}',
        })
      );

      expect(model.meta.timeoutMs).toBeUndefined();
    });
  });

  describe('fallback for unknown tools', () => {
    it('classifies unknown tool via toolType fallback', () => {
      const model = getToolMiniModel(
        makeToolRun({
          tool: 'other',
          command: 'CustomTool {"action":"do_thing"}',
        })
      );

      expect(model.kind).toBe('other');
      expect(model.name).toBe('CustomTool');
    });
  });
});
