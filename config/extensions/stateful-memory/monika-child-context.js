import { buildMonikaChildContext, registerChildAutoCompaction } from "./child-context.js";

// Explicit identity-bearing child seam. This intentionally loads only the
// stable persona trio and routed topic addenda: no autobiography, memstore,
// tools, sleep command, or shutdown save hooks.
export default function monikaChildContext(pi) {
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
    "Preserve the delegated task, project constraints, decisions, edits, validation state, and remaining work. Do not invent autobiographical context.",
  );
}
