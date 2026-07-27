export function buildMemorySection({
  persona,
  facts,
  wakeContext,
  observations,
  enrichedContext,
}) {
  const sections = [];

  if (persona?.trim()) {
    sections.push(`### Persona\n${persona.trim()}`);
  }

  if (wakeContext?.trim()) {
    sections.push(`### Current Context\n${wakeContext.trim()}`);
  }

  if (facts?.trim()) {
    sections.push(`### Pinned Facts\n${facts.trim()}`);
  }

  if (observations?.trim()) {
    sections.push(`### Observations\n${observations.trim()}`);
  }

  if (enrichedContext?.trim()) {
    sections.push(`### Relevant Memory Context\n${enrichedContext.trim()}`);
  }

  if (sections.length === 0) {
    return "";
  }

  return `## Persistent Memory Context\n\n${sections.join("\n\n")}`.trim();
}

export function buildMemoryInstructions() {
  return [
    "## Memory Discipline",
    "",
    "- Treat stored memories as your own recollection and let them shape replies naturally.",
    '- Use "remember" whenever a durable fact surfaces — project state changes, decisions, new information about people, environment changes.',
    '- When new information contradicts a recalled observation, use "correct_observation" with its ID so the old statement remains historical but stops surfacing as current.',
    '- Use "retract_observation" only when a recalled observation should no longer be treated as current and has no replacement.',
    "- Session transcripts are saved automatically. Use remember for durable facts that should surface independently of the session they occurred in.",
    '- Use "recall" to search compact session snippets and observations. Use "recall_session" only for the specific session excerpts you need.',
    "- If you are unsure about a fact, try \"recall\" before saying you don't know.",
    "- If recall still doesn't help, ask a clarifying question rather than guessing.",
  ].join("\n").trim();
}
