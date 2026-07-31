import { buildSpecialistChildContext, registerChildAutoCompaction } from "./child-context.js";

// Child-only, read-only prompt seam. It registers no tools, commands, memory
// hooks, session saves, or persistence lifecycle.
export default function specialistChildContext(pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    const addendum = await buildSpecialistChildContext({
      query: event.prompt,
      cwd: ctx.cwd,
    });
    if (!addendum) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${addendum}`.trim() };
  });
  registerChildAutoCompaction(
    pi,
    "Preserve the specialist task, project constraints, evidence, conclusions, validation state, and remaining work.",
  );
}
