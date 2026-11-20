import { createCodemodeExtension, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { boundCodemodeSource, boundedToolContext, isDirectOnlyTool } from './codemode-core.mjs';

/** Shared CLI/SDK registration. Keep -builtin:codemode to avoid a second copy. */
export default function codemodeExtension(pi: ExtensionAPI) {
  createCodemodeExtension({ mode: 'on', models: false })({
    ...pi,
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        // Orchestration must never itself be reachable from a script/alias.
        exposure: 'model-only',
        promptGuidelines: [
          ...(tool.promptGuidelines ?? []),
          'Use codemode for independent reads/searches and deterministic filtering. Use ordinary tools for simple calls and sequential tools for related mutations. Completed side effects are not rolled back on script failure.',
          'Scripts default to 60 seconds and 2000 output tokens; options may request at most 120000 ms and 8000 tokens. At most 64 nested tool calls run, with 8 in flight.',
          'Delegation, session/execution-target control and durable memory mutations must be direct tool calls. Use generate_image for images; models globals are not exposed.',
        ],
        async execute(id, params, signal, onUpdate, ctx) {
          const code = boundCodemodeSource(params.code);
          return tool.execute(id, { code }, signal, onUpdate, boundedToolContext(ctx, signal));
        },
      });
    },
  });
  // Also protect aliases and other tools using Pi's nested-call API. This is a
  // capability ceiling, not a read-only sandbox (bash still has normal rights).
  pi.on('tool_call', event => {
    if (event.parentToolCallId && isDirectOnlyTool(event.toolName)) {
      return { block: true, reason: `${event.toolName} must be called directly, outside codemode` };
    }
  });
}
