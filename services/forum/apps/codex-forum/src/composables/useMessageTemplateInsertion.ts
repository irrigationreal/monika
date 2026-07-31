import { nextTick } from 'vue';

import type { Ref } from 'vue';

export interface InsertionResult {
  value: string;
  caret: number;
}

export function insertTemplateText(current: string, template: string, start: number, end: number): InsertionResult {
  if (!current.length) return { value: template, caret: template.length };
  const safeStart = Math.max(0, Math.min(start, current.length));
  void end;
  return {
    value: current.slice(0, safeStart) + template + current.slice(safeStart),
    caret: safeStart + template.length,
  };
}

export async function applyTemplateToTextarea(input: {
  body: Ref<string>;
  textarea: Ref<HTMLTextAreaElement | null>;
  templateBody: string;
  replace?: boolean;
}): Promise<void> {
  const textarea = input.textarea.value;
  if (input.replace || !input.body.value.length) {
    input.body.value = input.templateBody;
    await nextTick();
    input.textarea.value?.focus();
    input.textarea.value?.setSelectionRange(input.templateBody.length, input.templateBody.length);
    return;
  }
  const start = textarea?.selectionStart ?? input.body.value.length;
  const end = textarea?.selectionEnd ?? start;
  const result = insertTemplateText(input.body.value, input.templateBody, start, end);
  input.body.value = result.value;
  await nextTick();
  input.textarea.value?.focus();
  input.textarea.value?.setSelectionRange(result.caret, result.caret);
}
