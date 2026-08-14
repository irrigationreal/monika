import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyTextToClipboard } from './clipboard';

describe('copyTextToClipboard', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('passes text to the Clipboard API without rewriting whitespace or markup', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const source = '  ## Heading\n\n[QUOTE=neon]\nbody\n[/QUOTE]\n';

    await copyTextToClipboard(source, { clipboard: { writeText }, document });

    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
  });

  it('falls back to a temporary textarea and restores focus when Clipboard API access is denied', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const execCommand = vi.fn((command: string) => {
      expect(command).toBe('copy');
      expect((document.activeElement as HTMLTextAreaElement).value).toBe('exact source');
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    await copyTextToClipboard('exact source', { clipboard: { writeText }, document });

    expect(writeText).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledOnce();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('reports failure when neither clipboard path succeeds', async () => {
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    await expect(copyTextToClipboard('source', { clipboard: null, document })).rejects.toThrow(
      'Clipboard access is unavailable in this browser.'
    );
    expect(document.querySelector('textarea')).toBeNull();
  });
});
