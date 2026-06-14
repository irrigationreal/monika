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
 * Parse robot "summary reasoning" streams that look like:
 *   **Step title** optional detail... **Next title** ...
 *
 * The current robot output uses markdown `**...**` as *step boundaries*, not for
 * arbitrary bolding. The UI should treat these as a feed of discrete steps.
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
      steps.push({ title: 'Activity', detail: fallback });
    }
  }

  return steps;
}
