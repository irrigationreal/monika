import { buildMonikaChildContext, registerChildAutoCompaction } from "./child-context.js";
import { registerReadonlyRecallTools } from "./readonly-recall.js";

// Explicit identity-bearing child seam. This loads the stable persona trio,
// routed topic addenda, and bounded read-only memory retrieval. It has no
// memory mutation, session ingestion, sleep command, or shutdown save hooks.
export default function monikaChildContext(pi) {
  registerReadonlyRecallTools(pi);
  pi.on("before_agent_start", async (event, ctx) => {
    const addendum = await buildMonikaChildContext({
      query: event.prompt,
      cwd: ctx.cwd,
    });
    return { systemPrompt: `${event.systemPrompt}\n\n${addendum}`.trim() };
  });

  // The parent runtime disables automatic compaction globally. Restore bounded
  // child-local compaction without adding persistence or autobiographical state.
  registerChildAutoCompaction(
    pi,
    "Preserve the delegated task, project constraints, supplied and deliberately recalled context, decisions, edits, validation state, and remaining work. Do not invent autobiographical context.",
  );
}
