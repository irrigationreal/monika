export interface ClipboardEnvironment {
  clipboard: Pick<Clipboard, 'writeText'> | null;
  document: Document | null;
}

function browserClipboardEnvironment(): ClipboardEnvironment {
  const runtimeNavigator: { clipboard?: Clipboard } | null = typeof navigator === 'undefined' ? null : navigator;
  return {
    clipboard: runtimeNavigator?.clipboard ?? null,
    document: typeof document === 'undefined' ? null : document,
  };
}

/**
 * Copies text without rewriting it, with a fallback for browsers where the
 * asynchronous Clipboard API is unavailable or denied.
 */
export async function copyTextToClipboard(
  text: string,
  environment: ClipboardEnvironment = browserClipboardEnvironment()
): Promise<void> {
  if (environment.clipboard) {
    try {
      await environment.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard access can be denied outside a secure context. Try the
      // browser's legacy synchronous path before reporting failure.
    }
  }

  const documentRef = environment.document;
  if (!documentRef) throw new Error('Clipboard access is unavailable in this browser.');

  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';

  const previouslyFocused = documentRef.activeElement as HTMLElement | null;
  let copied = false;
  documentRef.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    // The deprecated command is intentionally isolated as a fallback for
    // browsers and non-secure contexts without the asynchronous Clipboard API.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    copied = documentRef.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus();
  }

  if (!copied) throw new Error('Clipboard access is unavailable in this browser.');
}
