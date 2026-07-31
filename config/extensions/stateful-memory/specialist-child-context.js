import { buildSpecialistChildContext, registerChildAutoCompaction } from "./child-context.js";

const SPECIALIST_MEMORY_BOUNDARY = "This specialist has no durable-memory role. Do not access memstore, its socket or database, stateful-memory files, or memory lifecycle through shell or filesystem tools.";

// Child-only prompt seam. It registers no tools, commands, memory hooks,
// session saves, or persistence lifecycle.
export default function specialistChildContext(pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    const addendum = await buildSpecialistChildContext({
      query: event.prompt,
      cwd: ctx.cwd,
    });
    return {
      systemPrompt: `${event.systemPrompt}\n\n${[addendum, SPECIALIST_MEMORY_BOUNDARY].filter(Boolean).join("\n\n")}`.trim(),
    };
  });
  registerChildAutoCompaction(
    pi,
    "Preserve the specialist task, project constraints, evidence, conclusions, validation state, and remaining work.",
  );
}

export { SPECIALIST_MEMORY_BOUNDARY };
