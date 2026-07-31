import { loadConfig } from "./config.js";
import { MemstoreClient } from "./memstore-client.js";
import {
  buildRelevantExcerpt,
  isDelegateSession,
  joinWithinBudget,
  selectDiverseSessionEntries,
  truncateCharactersSafe,
} from "./recall-utils.js";

function extractSessionDate(body) {
  const match = body?.match?.(/^# Date:\s*(.+)$/m);
  if (!match) return null;
  const value = match[1].trim();
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function formatSessionDate(value) {
  if (!value) return "unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const HARD_MAX_SESSION_RESULTS = 5;
const HARD_MAX_OBSERVATION_RESULTS = 3;
const HARD_MAX_SEARCH_BYTES = 10_000;
const HARD_MAX_SESSION_CHARS = 12_000;

function boundedNumber(value, fallback, maximum) {
  return Math.max(1, Math.min(maximum, Number.isFinite(value) ? Math.floor(value) : fallback));
}

/** Register bounded memstore reads without any mutation or session-ingestion path. */
export function registerReadonlyRecallTools(pi, {
  configLoader = loadConfig,
  clientFactory = (config) => new MemstoreClient({ socketPath: config.memstoreSocketPath || undefined }),
} = {}) {
  let client = null;
  let configPromise = null;

  async function resources(cwd) {
    const config = await (configPromise ??= configLoader(cwd));
    if (!client) client = clientFactory(config);
    await client.connect();
    return { client, config };
  }

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Read-only search of past parent sessions and current observations. Use recall_session for bounded detail.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or context to recall." },
        include_historical_observations: { type: "boolean", description: "Include superseded or retracted observations. Defaults to current observations only." },
        include_all_delegate_sessions: { type: "boolean", description: "Disable historical fork-result diversification for exhaustive research." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client: memstore, config } = await resources(ctx.cwd);
        const [searchResults, observationResults] = await Promise.all([
          memstore.search(params.query, { limit: 12 }),
          memstore.searchObservations(params.query, {
            limit: boundedNumber(config.recallObservationResults, 3, HARD_MAX_OBSERVATION_RESULTS),
            include_historical: params.include_historical_observations ?? false,
          }).catch(() => ({ observations: [] })),
        ]);
        const sessionLimit = boundedNumber(config.recallSessionResults, 5, HARD_MAX_SESSION_RESULTS);
        const topEntries = params.include_all_delegate_sessions
          ? (searchResults.entries || []).slice(0, sessionLimit)
          : selectDiverseSessionEntries(searchResults.entries, sessionLimit);
        const sessionLines = topEntries.map((entry) => {
          const kind = isDelegateSession(entry) ? " | delegate/fork" : "";
          const tags = (entry.tags || []).join(", ") || "none";
          const snippet = entry.snippet ? truncateCharactersSafe(entry.snippet, 800) : "(no snippet)";
          return `### Session #${entry.id}: ${entry.title}\n*${formatSessionDate(entry.created_at)} | depth ${entry.depth}${kind} | tags: ${tags}*\n\n${snippet}`;
        });
        const observations = observationResults.observations || [];
        const observationLines = observations.map((observation) => {
          const lifecycle = observation.lifecycle === "superseded_by"
            ? ` | superseded by #${observation.replacement_id}`
            : observation.lifecycle === "retracted" ? " | retracted" : "";
          const reason = observation.lifecycle_reason ? `\nLifecycle reason: ${observation.lifecycle_reason}` : "";
          return `**Observation #${observation.id}: ${observation.entity_name}** (${observation.entity_type}) — *${formatSessionDate(observation.created_at)}${lifecycle}*\n${truncateCharactersSafe(observation.body, 1200)}${reason}`;
        });
        const sections = [];
        if (sessionLines.length) sections.push(`## Session Search Results\n\n${sessionLines.join("\n\n---\n\n")}\n\nUse \`recall_session\` with a session ID and query for bounded excerpts.`);
        if (observationLines.length) sections.push(`## Observation Search Results\n\n${observationLines.join("\n\n---\n\n")}`);
        return {
          content: [{ type: "text", text: joinWithinBudget(sections, boundedNumber(config.recallSearchMaxBytes, 10_000, HARD_MAX_SEARCH_BYTES), "\n\n") || "No relevant memories found." }],
          details: { entries: topEntries, observationIds: observations.map((item) => item.id), readOnly: true },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Memory store unavailable: ${error.message}` }], details: { readOnly: true } };
      }
    },
  });

  pi.registerTool({
    name: "recall_session",
    label: "Recall Session",
    description: "Read-only bounded excerpts from one parent session returned by recall.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Session entry ID returned by recall." },
        query: { type: "string", description: "Terms used to select relevant windows." },
        offset: { type: "integer", minimum: 0, description: "Source character offset to continue from." },
        max_chars: { type: "integer", minimum: 1000, maximum: 12000, description: "Maximum returned characters." },
        full: { type: "boolean", description: "Page raw transcript content, still bounded below the tool-output limit." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client: memstore, config } = await resources(ctx.cwd);
        const { entry } = await memstore.show(params.id);
        const excerpt = buildRelevantExcerpt(entry.body, {
          query: params.query || "",
          offset: params.offset || 0,
          maxChars: boundedNumber(params.max_chars ?? config.recallMaxSessionChars, 8000, HARD_MAX_SESSION_CHARS),
          full: params.full || false,
        });
        const continuation = excerpt.nextOffset == null ? "" : `\n\n*More matching content is available. Continue with offset ${excerpt.nextOffset}.*`;
        const text = `## Session #${entry.id}: ${entry.title}\n*${formatSessionDate(extractSessionDate(entry.body) || entry.created_at)} | depth ${entry.depth} | tags: ${(entry.tags || []).join(", ") || "none"}*\n\n${excerpt.text}${continuation}`;
        return {
          content: [{ type: "text", text: joinWithinBudget([text], 48 * 1024, "") }],
          details: { id: entry.id, sourceRanges: excerpt.sourceRanges, nextOffset: excerpt.nextOffset, truncated: excerpt.truncated, readOnly: true },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to recall session: ${error.message}` }], details: { error: error.message, readOnly: true } };
      }
    },
  });
}
