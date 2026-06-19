export interface ReasoningStep {
  title: string;
  detail: string | null;
}

function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function cleanDetail(raw: string): string {
  return raw.trim();
}

/**
 * Check whether a `**...**` marker at position `start` is a step boundary
 * (a new reasoning step title) rather than inline emphasis.
 *
 * A step boundary is `**Title**` at the start of the text or at the start
 * of a line (after a newline + optional whitespace). Inline emphasis is
 * `**word**` preceded by non-whitespace on the same line, such as:
 *   - `- **Gold** as currency`  (list item bold)
 *   - `the **important** thing` (mid-sentence bold)
 *   - `> **Note**`             (blockquote bold)
 */
function isStepBoundary(text: string, start: number): boolean {
  if (start === 0) return true;

  // Walk backward from start to find the preceding newline or start of text.
  // If only whitespace exists between the newline and the `**`, it's a step.
  for (let i = start - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t') return false;
  }
  // Reached start of text through only whitespace
  return true;
}

/**
 * Parse robot "summary reasoning" streams that look like:
 *   **Step title** optional detail... **Next title** ...
 *
 * Only `**...**` markers at the start of a line are treated as step
 * boundaries. Inline bold (e.g. `- **Gold** as currency`) is left as
 * part of the current step's detail text.
 */
export function parseReasoningSteps(input: string | null | undefined): ReasoningStep[] {
  const text = input ?? '';
  if (!text.trim()) return [];

  const steps: ReasoningStep[] = [];
  const marker = '**';

  let cursor = 0;
  let activeStep: ReasoningStep | null = null;
  let detailStart = 0;

  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start === -1) break;
    const end = text.indexOf(marker, start + marker.length);
    if (end === -1) break;

    // Skip inline bold that isn't at the start of a line
    if (!isStepBoundary(text, start)) {
      cursor = end + marker.length;
      continue;
    }

    if (activeStep) {
      const detail = cleanDetail(text.slice(detailStart, start));
      if (detail) activeStep.detail = detail;
    } else {
      const preface = cleanDetail(text.slice(0, start));
      if (preface) {
        steps.push({ title: 'Context', detail: preface });
      }
    }

    const title = cleanTitle(text.slice(start + marker.length, end));
    if (title) {
      activeStep = { title, detail: null };
      steps.push(activeStep);
      detailStart = end + marker.length;
    }

    cursor = end + marker.length;
  }

  if (activeStep) {
    const tail = cleanDetail(text.slice(detailStart));
    if (tail) activeStep.detail = tail;
  } else {
    const fallback = cleanDetail(text);
    if (fallback) {
      steps.push({ title: 'Thinking', detail: fallback });
    }
  }

  return steps;
}
