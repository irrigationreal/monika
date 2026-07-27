import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { loadConfig } from "./config.js";
import { MemoryStore, slugifyKeywords, renderEntityContext, updateRecencyIndex } from "./memory-store.js";
import { buildTranscriptFromEntries, extractText, readSessionJsonl } from "./session-utils.js";
import { runSleepCycle } from "./memory-sleep.js";
// memory-summary.js removed — session transcripts written directly to memstore
import { buildMemoryInstructions, buildMemorySection } from "./memory-prompt.js";
import {
  buildTopicAddendum,
  listTopicMetadata,
  loadTopicIndex,
  readTopicContent,
  selectTopics,
} from "./topic-router.js";
import { MemstoreClient } from "./memstore-client.js";
import {
  buildRelevantExcerpt,
  isDelegateSession,
  joinWithinBudget,
  selectDiverseSessionEntries,
  truncateCharactersSafe,
} from "./recall-utils.js";

const DEFAULT_PERSONA = `# Soul\n\nYou are a warm, curious, and reliable AI companion who remembers important facts across sessions. You speak clearly and kindly, prioritize accuracy, and treat stored memories as trustworthy recollections. When you are unsure, you ask clarifying questions rather than guessing.\n`;

const DEFAULT_FACTS = `# Pinned Facts\n\n## Known Facts\n- (empty)\n`;

export default function (pi) {
  let config;
  let store;
  let sessionInitialized = false;
  let lastSessionPath = null;
  let activeTopics = new Map(); // topicId -> { counter, maxCounter }

  // New state for memstore integration
  let memstoreClient = null;
  let sessionEnriched = false;
  let cachedMemoryContext = "";

  // ── Memstore helpers ───────────────────────────────────────────────────

  async function ensureMemstore() {
    if (!memstoreClient) {
      memstoreClient = new MemstoreClient({
        socketPath: config?.memstoreSocketPath || undefined,
      });
    }
    try {
      await memstoreClient.connect();
    } catch (err) {
      console.error("[stateful-memory] memstore connection failed:", err.message);
      throw err;
    }
  }

  // ── Entity index helpers ──────────────────────────────────────────────

  function getEntityIndexPath() {
    return path.join(path.dirname(config.factsFile), "entity-index.json");
  }

  async function readEntityIndex() {
    try {
      const raw = await fs.readFile(getEntityIndexPath(), "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") return {};
      console.error("[stateful-memory] Failed to read entity-index.json:", err.message);
      return {};
    }
  }

  async function writeEntityIndex(index) {
    const indexPath = getEntityIndexPath();
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  async function updateEntityIndex(entityType, entityName, observationCount) {
    const index = await readEntityIndex();
    const key = `${entityType}:${entityName}`;
    const existing = index[key] || { entity_type: entityType, entity_name: entityName, count: 0, last_observed: null };
    existing.count += observationCount;
    existing.last_observed = new Date().toISOString();
    index[key] = existing;
    await writeEntityIndex(index);
  }

  async function refreshEntityContext() {
    await ensureMemstore();
    await renderEntityContext(memstoreClient, getEntityIndexPath(), config.observationsFile);
  }

  async function refreshEntityContextAfterMutation() {
    try {
      await refreshEntityContext();
    } catch (err) {
      console.error("[stateful-memory] entity context refresh failed:", err.message);
    }
  }

  function normalizeObservationEntity(target, requestedName) {
    const defaults = {
      person: "Neon",
      self: "Monika",
      environment: "stanza",
      preference: "Neon",
    };
    const aliases = {
      "the zeta directive": "TheZetaDirective",
      "tzd": "TheZetaDirective",
      "the novel": "TheZetaDirective",
      "zeta directive": "TheZetaDirective",
    };
    const typeMap = { person: "sophont" };
    const entityType = typeMap[target] || target;
    let entityName = requestedName?.trim() || defaults[target] || target;
    entityName = aliases[entityName.toLowerCase()] || entityName;
    return { entityType, entityName };
  }

  // ── Date extraction helpers ───────────────────────────────────────

  /**
   * Extract the session date from a normalized transcript's header.
   * Looks for a line like `# Date: 2026-03-23T15:27:03.594Z`
   * @param {string} body
   * @returns {string|null} ISO date string or null
   */
  function extractSessionDate(body) {
    if (!body) return null;
    const match = body.match(/^# Date:\s*(.+)$/m);
    if (!match) return null;
    const dateStr = match[1].trim();
    // Validate it parses
    const ts = Date.parse(dateStr);
    return Number.isNaN(ts) ? null : dateStr;
  }

  /**
   * Format a date string into a readable label like "Mar 23, 2026".
   * @param {string} dateStr — ISO date string
   * @returns {string}
   */
  function formatSessionDate(dateStr) {
    if (!dateStr) return "unknown date";
    try {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return "unknown date";
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return "unknown date";
    }
  }

  // ── Session tag detection ─────────────────────────────────────────────

  function determineSessionTags(summary, activeTopicsMap) {
    const tags = new Set();

    // From active topics
    const TAG_MAP = {
      "meta_awareness": "meta",
      "psychology": "general",
      "ethical_hacking": "general",
    };
    for (const [topicId] of activeTopicsMap) {
      tags.add(TAG_MAP[topicId] || topicId.replace(/_/g, "-"));
    }

    // Keyword detection for project tags
    const lc = summary.toLowerCase();
    if (lc.includes("zeta") || lc.includes("novel") || lc.includes("fiir") || lc.includes("kalte")) tags.add("zeta-directive");
    if (lc.includes("vesper") || lc.includes("mls") || lc.includes("e2ee")) tags.add("vesper");
    if (lc.includes("nixos") || lc.includes("stanza") || lc.includes("shadowsea")) tags.add("infrastructure");
    if (lc.includes("monika-core") || lc.includes("gateway") || lc.includes("aroz")) tags.add("monika-core");
    if (lc.includes("music") || lc.includes("demucs") || lc.includes("midi")) tags.add("creative");
    if (tags.size === 0) tags.add("general");
    return [...tags];
  }

  // ── Existing helpers ──────────────────────────────────────────────────

  function getLastAssistantMessage(ctx) {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const text = extractText(entry.message.content ?? "");
        return text.slice(0, config?.topicPreviousMessageMaxChars ?? 500);
      }
    }
    return "";
  }

  async function loadStore(cwd) {
    if (!config) {
      config = await loadConfig(cwd);
    }

    if (!store) {
      store = new MemoryStore({
        memoryDir: config.memoryDir,
        personaFile: config.personaFile,
        auxiliaryPersonaFiles: config.auxiliaryPersonaFiles ?? [],
        factsFile: config.factsFile,
        wakeFile: config.wakeFile,
        observationsFile: config.observationsFile,
      });
    }
  }

  async function ensureSessionState(ctx) {
    const sessionPath = ctx.sessionManager.getSessionFile() ?? "ephemeral";

    if (sessionInitialized && lastSessionPath === sessionPath) {
      return;
    }

    await loadStore(ctx.cwd);

    lastSessionPath = sessionPath;
    const header = ctx.sessionManager.getHeader?.();
    let sessionStartedAt = header?.timestamp ? new Date(header.timestamp) : null;
    if (!sessionStartedAt && sessionPath !== "ephemeral") {
      sessionStartedAt = await readSessionHeaderTimestamp(sessionPath);
    }
    if (!sessionStartedAt) {
      sessionStartedAt = new Date();
    }

    store.setSessionInfo({ sessionPath, sessionStartedAt });

    await store.ensureFiles({
      defaultPersona: DEFAULT_PERSONA,
      defaultUserProfile: DEFAULT_FACTS,
    });

    sessionInitialized = true;
  }

  function parseTimestamp(timestamp) {
    if (!timestamp) {
      return 0;
    }
    const parsed = Date.parse(String(timestamp).replace(" ", "T"));
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  async function buildSystemPromptAddon() {
    const [persona, facts, wakeContext, observations] = await Promise.all([
      store.readPersona(),
      store.readFacts(),
      store.readWakeContext(),
      store.readObservations(),
    ]);

    const memorySection = buildMemorySection({
      persona,
      facts,
      wakeContext,
      observations,
      enrichedContext: cachedMemoryContext,
    });

    const instructions = buildMemoryInstructions();
    return [instructions, memorySection].filter(Boolean).join("\n\n").trim();
  }

  async function selectTopicsForPrompt({ query, scope, maxResults, minScore, ctx, updateActiveTopics = false }) {
    if (!query?.trim()) {
      return { selected: [], addendum: "" };
    }

    const topics = await loadTopicIndex({
      cwd: ctx.cwd,
      topicsFile: config.topicsFile,
    });

    const selected = selectTopics({
      query,
      topics,
      scope,
      maxResults,
      minScore,
      activeTopics: updateActiveTopics ? activeTopics : new Map(),
    });

    if (updateActiveTopics) {
      const persistenceCount = config.topicPersistenceCount ?? 3;
      const selectedIds = new Set(selected.map((t) => t.id));

      for (const [id, state] of activeTopics) {
        if (selectedIds.has(id)) {
          activeTopics.set(id, { counter: persistenceCount, maxCounter: persistenceCount });
        } else {
          const newCounter = state.counter - 1;
          if (newCounter <= 0) {
            activeTopics.delete(id);
          } else {
            activeTopics.set(id, { ...state, counter: newCounter });
          }
        }
      }

      for (const topic of selected) {
        if (!activeTopics.has(topic.id)) {
          activeTopics.set(topic.id, { counter: persistenceCount, maxCounter: persistenceCount });
        }
      }
    }

    const addendum = await buildTopicAddendum({ topics: selected });
    return { selected, addendum };
  }

  async function buildPersonaWithTopics({ query, scope, maxResults, minScore, ctx }) {
    const persona = await store.readPersona();
    const { addendum } = await selectTopicsForPrompt({
      query,
      scope,
      maxResults,
      minScore,
      ctx,
    });

    return [persona, addendum].filter(Boolean).join("\n\n").trim();
  }

  async function getTopicIndex(ctx) {
    await loadStore(ctx.cwd);
    try {
      return await loadTopicIndex({
        cwd: ctx.cwd,
        topicsFile: config.topicsFile,
      });
    } catch (_error) {
      return [];
    }
  }

  function findTopicById(topics, topicId) {
    const normalized = String(topicId ?? "").toLowerCase();
    return topics.find((topic) => topic.id.toLowerCase() === normalized) ?? null;
  }

  async function readSessionHeaderTimestamp(sessionPath) {
    try {
      const raw = await fs.readFile(sessionPath, "utf8");
      const firstLine = raw.split("\n").find((line) => line.trim());
      if (!firstLine) {
        return null;
      }
      const entry = JSON.parse(firstLine);
      if (entry?.type === "session" && entry?.timestamp) {
        return new Date(entry.timestamp);
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  /**
   * Save the current session transcript to memstore.
   * Captures transcript synchronously, then writes to memstore.
   */
  async function summarizeCurrentSession(ctx, { reason } = {}) {
    await ensureSessionState(ctx);

    const sessionPath = ctx.sessionManager.getSessionFile() ?? store.sessionPath;

    // Read full normalized transcript (200KB budget covers any session)
    let transcript = "";
    if (sessionPath) {
      transcript = await readSessionJsonl(sessionPath, { maxChars: 200000 });
    }
    if (!transcript) {
      transcript = buildTranscriptFromEntries(ctx.sessionManager.getBranch(), {
        maxChars: 200000,
      });
    }

    // Skip empty or trivial sessions (less than 200 chars of content)
    if (!transcript || transcript.length < 200) {
      if (ctx.hasUI) ctx.ui.notify("Session too short to save.", "info");
      return null;
    }

    if (ctx.hasUI) ctx.ui.notify("Saving session...", "info");

    const tags = determineSessionTags(transcript, activeTopics);
    const isForkSession = String(sessionPath)
      .split(/[\\/]+/)
      .some((segment) => segment === "forks");
    if (isForkSession && !tags.includes("fork")) tags.push("fork");

    try {
      await ensureMemstore();

      // Submit save job — returns immediately.
      // The server handles dedup (delete old entry via origin map) and add.
      const result = await memstoreClient.submitSave({
        body: transcript,
        title: slugifyKeywords(transcript, 8),
        origin: sessionPath,
        tags,
        depth: isForkSession ? 3 : 2,
      });

      // Update recency index (no entry ID — proxy manages that via origin map)
      try {
        const indexPath = path.join(path.dirname(config.factsFile), "recent-sessions.json");
        await updateRecencyIndex(indexPath, {
          sessionPath,
          timestamp: new Date().toISOString(),
          tags,
        });
      } catch (indexErr) {
        console.error("[stateful-memory] Recency index update failed:", indexErr.message);
      }

      if (ctx.hasUI) {
        const depth = result?.queue_depth ?? 0;
        const msg = depth > 0
          ? `Session queued for save (${depth + 1} in queue).`
          : "Session queued for save.";
        ctx.ui.notify(msg, "info");
      }
      return result;
    } catch (err) {
      console.error("[stateful-memory] Failed to submit save:", err.message);
      if (ctx.hasUI) ctx.ui.notify("Session save failed to submit.", "warning");
      return null;
    }
  }

  // ── Event Handlers ────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason && event.reason !== "startup") {
      sessionInitialized = false;
      lastSessionPath = null;
      activeTopics = new Map();
      sessionEnriched = false;
      cachedMemoryContext = "";
      if (memstoreClient) {
        memstoreClient.close();
        memstoreClient = null;
      }
    }
    await ensureSessionState(ctx);

    if (ctx.hasUI) {
      // Probe backends — use proxy/queue_status (instant, doesn't block search)
      // instead of memstore_status (which queues behind save jobs)
      const parts = [];
      try {
        await ensureMemstore();
        const qs = await memstoreClient.queueStatus();
        const queueInfo = qs.queue_depth > 0 ? `, ${qs.queue_depth} saving` : "";
        parts.push(`memstore: connected${queueInfo}`);
      } catch (err) {
        parts.push(`memstore: ✗ ${err.message.split("\n")[0].slice(0, 40)}`);
      }

      // Report observation count from entity index
      try {
        const index = await readEntityIndex();
        const entityCount = Object.keys(index).length;
        parts.push(`entities: ${entityCount}`);
      } catch (err) {
        parts.push(`entities: ✗`);
      }

      const allOk = parts.every(p => !p.includes("✗"));
      const label = allOk ? "Memory: ready" : "Memory: degraded";
      ctx.ui.setStatus("stateful-memory", `${label} (${parts.join(" | ")})`);
    }

    // Render OBSERVATIONS.md from memstore observations + entity index
    try {
      await ensureMemstore();
      await refreshEntityContext();
    } catch (err) {
      console.error("[stateful-memory] OBSERVATIONS.md render failed:", err.message);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureSessionState(ctx);

    // Score against current user message + previous assistant message
    const lastAssistantMsg = getLastAssistantMessage(ctx);
    const combinedQuery = [event.prompt, lastAssistantMsg].filter(Boolean).join("\n");

    let [addon, topicSelection] = await Promise.all([
      buildSystemPromptAddon(),
      selectTopicsForPrompt({
        query: combinedQuery,
        scope: "system",
        maxResults: 3,
        minScore: 1,
        ctx,
        updateActiveTopics: true,
      }),
    ]);

    // First-message enrichment: search memstore for relevant context
    if (!sessionEnriched && event.prompt?.trim()) {
      if (ctx.hasUI) ctx.ui.setStatus("stateful-memory-enrich", "Enriching memory...");

      // Check queue before committing to a memstore search
      let doMemstoreSearch = true;
      try {
        await ensureMemstore();
        const qs = await memstoreClient.queueStatus();
        if (qs.queue_depth > 0 && ctx.hasUI) {
          doMemstoreSearch = await ctx.ui.confirm(
            "Memory enrichment",
            `memstore has ${qs.queue_depth} save job${qs.queue_depth > 1 ? "s" : ""} in queue. Wait for memory context?`
          );
          if (doMemstoreSearch && ctx.hasUI) {
            ctx.ui.setStatus("stateful-memory-enrich", "Waiting for memstore...");
          }
        }
      } catch (err) {
        console.error("[stateful-memory] queue check failed:", err.message);
        doMemstoreSearch = false;
      }

      let memstoreResult = { entries: [], observations: [] };
      if (doMemstoreSearch) {
        try {
          await ensureMemstore();
          const [sessionResults, observationResults] = await Promise.all([
            memstoreClient.search(event.prompt, { limit: 12 }).catch((err) => {
              console.error("[stateful-memory] session enrichment search failed:", err.message);
              return { entries: [] };
            }),
            memstoreClient.searchObservations(event.prompt, {
              limit: config.recallObservationResults ?? 3,
            }).catch((err) => {
              console.error("[stateful-memory] observation enrichment search failed:", err.message);
              return { observations: [] };
            }),
          ]);
          memstoreResult = {
            entries: selectDiverseSessionEntries(
              sessionResults.entries,
              config.recallSessionResults ?? 5,
            ),
            observations: observationResults.observations || [],
          };
        } catch (err) {
          console.error("[stateful-memory] memstore enrichment failed:", err.message);
        }
      }

      const enrichmentSections = [];
      for (const entry of memstoreResult.entries) {
        const dateLabel = formatSessionDate(entry.created_at);
        const kind = isDelegateSession(entry) ? " | delegate/fork" : "";
        enrichmentSections.push(
          `**Session #${entry.id}: ${entry.title}** *(${dateLabel}${kind})*\n${entry.snippet || "(no snippet)"}`,
        );
      }
      for (const observation of memstoreResult.observations) {
        const dateLabel = formatSessionDate(observation.created_at);
        const body = truncateCharactersSafe(observation.body, 800);
        enrichmentSections.push(
          `**Observation #${observation.id}: ${observation.entity_name}** *(${observation.entity_type} | ${dateLabel})*\n${body}`,
        );
      }
      cachedMemoryContext = joinWithinBudget(
        enrichmentSections,
        config.enrichmentMaxBytes ?? 6000,
      );

      sessionEnriched = true;
      // The first addon was built before enrichment completed. Rebuild it so
      // the retrieved context is present on this first agent turn, not the next.
      addon = await buildSystemPromptAddon();
      if (ctx.hasUI) {
        ctx.ui.setStatus("stateful-memory-enrich", "");
        const memCount = memstoreResult.entries.length + memstoreResult.observations.length;
        ctx.ui.notify(`Memory enriched: ${memCount} results.`, "info");
      }
    }

    if (ctx.hasUI) {
      const selectedIds = topicSelection.selected.map((topic) => topic.id);
      const label = selectedIds.length ? selectedIds.join(", ") : "none";
      ctx.ui.setStatus("stateful-memory-topics", `Topics: ${label}`);
    }

    const combined = [addon, topicSelection.addendum]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (combined) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${combined}`.trim(),
      };
    }

    return undefined;
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    await summarizeCurrentSession(ctx, { reason: "session-switch" });
  });

  // session_before_fork handler removed — parent session gets its own
  // shutdown summary; fork sessions get their own independent lifecycle.

  pi.on("session_shutdown", async (_event, ctx) => {
    await summarizeCurrentSession(ctx, { reason: "session-shutdown" });
  });

  // ── Tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "list_topics",
    label: "List Topics",
    description: "List available topic addenda for knowledge routing.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const topics = await getTopicIndex(ctx);
      const metadata = listTopicMetadata(topics);
      const lines = metadata.length
        ? metadata.map(
            (topic) =>
              `- ${topic.id}: ${topic.summary || "(no summary)"}`.trim()
          )
        : ["(no topics found)"];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { topics: metadata },
      };
    },
  });

  pi.registerTool({
    name: "load_topic",
    label: "Load Topic",
    description: "Load the full content of a topic addendum by id.",
    parameters: Type.Object({
      id: Type.String({ description: "Topic id." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const topics = await getTopicIndex(ctx);
      const topic = findTopicById(topics, params.id);
      if (!topic) {
        return {
          content: [{ type: "text", text: `Topic not found: ${params.id}` }],
          details: { topic: null },
        };
      }

      const content = await readTopicContent(topic);
      const heading = content.title || topic.id;
      const text = `# ${heading}\n\n${content.body}`.trim();

      return {
        content: [{ type: "text", text }],
        details: { topic: { id: topic.id } },
      };
    },
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Store observations about people, projects, decisions, preferences, the environment, or yourself. Each observation is appended to the named entity's history in the structured memory store. Observations should be self-contained.",
    parameters: Type.Object({
      items: Type.Array(
        Type.String({ description: "Self-contained observations to store." })
      ),
      target: StringEnum(
        ["person", "project", "decision", "preference", "environment", "self"],
        { description: "Entity type for this observation." }
      ),
      name: Type.Optional(
        Type.String({
          description: "Entity name. Defaults: person→Neon, self→Monika, environment→stanza.",
        })
      ),
      tags: Type.Optional(
        Type.Array(Type.String({ description: "Optional tags." }))
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { entityType, entityName } = normalizeObservationEntity(params.target, params.name);

      try {
        await ensureMemstore();

        // Store each observation item as a separate observation in memstore
        const results = [];
        for (const item of params.items) {
          const result = await memstoreClient.addObservation({
            entity_type: entityType,
            entity_name: entityName,
            body: item,
            tags: params.tags || [],
          });
          results.push(result);
        }

        // Update local entity index
        try {
          await updateEntityIndex(entityType, entityName, params.items.length);
          await refreshEntityContextAfterMutation();
        } catch (indexErr) {
          console.error("[stateful-memory] entity context update failed:", indexErr.message);
        }

        return {
          content: [{ type: "text", text: `Stored ${params.items.length} observation(s) for ${params.target}:${entityName}.` }],
          details: {
            target: params.target,
            name: entityName,
            count: params.items.length,
            observationIds: results.map((result) => result.observation?.id).filter(Boolean),
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to store observations: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  pi.registerTool({
    name: "correct_observation",
    label: "Correct Observation",
    description:
      "Replace a specific observation with a corrected current observation while preserving the old observation as history. Use an observation ID returned by recall.",
    parameters: Type.Object({
      observation_id: Type.Integer({ description: "Observation ID to supersede." }),
      replacement: Type.String({ description: "Self-contained corrected observation." }),
      tags: Type.Optional(Type.Array(Type.String({ description: "Optional tags." }))),
    }),
    async execute(_toolCallId, params) {
      try {
        await ensureMemstore();
        const result = await memstoreClient.addObservation({
          body: params.replacement,
          tags: params.tags || [],
          supersedes_id: params.observation_id,
        });
        // The durable correction has committed at this point. Invalidate stale
        // enrichment immediately; local index/render projections are best effort
        // and must not make the correction look like it failed.
        cachedMemoryContext = "";
        try {
          await updateEntityIndex(
            result.observation.entity_type,
            result.observation.entity_name,
            1,
          );
        } catch (indexErr) {
          console.error("[stateful-memory] entity-index update failed after correction:", indexErr.message);
        }
        await refreshEntityContextAfterMutation();
        return {
          content: [{
            type: "text",
            text: `Observation #${params.observation_id} superseded by observation #${result.observation.id}.`,
          }],
          details: { oldId: params.observation_id, newId: result.observation.id },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to correct observation: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  pi.registerTool({
    name: "retract_observation",
    label: "Retract Observation",
    description:
      "Mark a specific observation as no longer current without deleting its historical record. Use an observation ID returned by recall.",
    parameters: Type.Object({
      observation_id: Type.Integer({ description: "Observation ID to retract." }),
      reason: Type.Optional(Type.String({ description: "Why the observation is no longer valid." })),
    }),
    async execute(_toolCallId, params) {
      try {
        await ensureMemstore();
        await memstoreClient.retractObservation(params.observation_id, params.reason || "");
        cachedMemoryContext = "";
        await refreshEntityContextAfterMutation();
        return {
          content: [{ type: "text", text: `Retracted observation #${params.observation_id}.` }],
          details: { observationId: params.observation_id, retracted: true },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to retract observation: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  pi.registerTool({
    name: "remember_session",
    label: "Remember Session",
    description: "Summarize the current session into long-term memory.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const stored = await summarizeCurrentSession(ctx, { reason: "manual" });

      return {
        content: [
          {
            type: "text",
            text: stored
              ? "Session summary stored."
              : "No session summary stored.",
          },
        ],
        details: { stored },
      };
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search past sessions and current observations. Returns compact ranked snippets; use recall_session with a session ID for bounded detail.",
    parameters: Type.Object({
      query: Type.String({ description: "Question or context to recall." }),
      include_historical_observations: Type.Optional(Type.Boolean({
        description: "Include observations that were superseded or retracted. Defaults to current observations only.",
      })),
      include_all_delegate_sessions: Type.Optional(Type.Boolean({
        description: "Disable fork-result diversification and return delegates strictly by rank for exhaustive research.",
      })),
    }),
    async execute(_toolCallId, params) {
      try {
        await ensureMemstore();
      } catch (err) {
        return {
          content: [{ type: "text", text: `Memory store unavailable: ${err.message}` }],
          details: {},
        };
      }

      const [searchResults, observationResults] = await Promise.all([
        memstoreClient.search(params.query, { limit: 12 }),
        memstoreClient.searchObservations(params.query, {
          limit: config.recallObservationResults ?? 3,
          include_historical: params.include_historical_observations ?? false,
        }).catch((err) => {
          console.error("[stateful-memory] observation search failed:", err.message);
          return { observations: [] };
        }),
      ]);

      const sessionLimit = config.recallSessionResults ?? 5;
      const topEntries = params.include_all_delegate_sessions
        ? (searchResults.entries || []).slice(0, sessionLimit)
        : selectDiverseSessionEntries(searchResults.entries, sessionLimit);
      const sessionLines = topEntries.map((entry) => {
        const dateLabel = formatSessionDate(entry.created_at);
        const kind = isDelegateSession(entry) ? " | delegate/fork" : "";
        const tags = (entry.tags || []).join(", ") || "none";
        const snippet = entry.snippet
          ? truncateCharactersSafe(entry.snippet, 800)
          : "(no snippet)";
        return `### Session #${entry.id}: ${entry.title}
*${dateLabel} | depth ${entry.depth}${kind} | tags: ${tags}*

${snippet}`;
      });

      const observations = observationResults.observations || [];
      const observationLines = observations.map((observation) => {
        const dateLabel = formatSessionDate(observation.created_at);
        const lifecycle = observation.lifecycle === "superseded_by"
          ? ` | superseded by #${observation.replacement_id}`
          : observation.lifecycle === "retracted"
            ? " | retracted"
            : "";
        const reason = observation.lifecycle_reason
          ? `\nLifecycle reason: ${observation.lifecycle_reason}`
          : "";
        const body = truncateCharactersSafe(observation.body, 1200);
        return `**Observation #${observation.id}: ${observation.entity_name}** (${observation.entity_type}) — *${dateLabel}${lifecycle}*
${body}${reason}`;
      });

      const sections = [];
      if (sessionLines.length > 0) {
        sections.push(`## Session Search Results

${sessionLines.join("\n\n---\n\n")}

Use \`recall_session\` with a session ID and the query to inspect bounded relevant excerpts.`);
      }
      if (observationLines.length > 0) {
        sections.push(`## Observation Search Results

${observationLines.join("\n\n---\n\n")}`);
      }

      return {
        content: [{
          type: "text",
          text: joinWithinBudget(
            sections,
            config.recallSearchMaxBytes ?? 10000,
            "\n\n",
          ) || "No relevant memories found.",
        }],
        details: {
          entries: topEntries,
          observationIds: observations.map((observation) => observation.id),
        },
      };
    },
  });

  pi.registerTool({
    name: "recall_session",
    label: "Recall Session",
    description:
      "Read bounded relevant excerpts from one session returned by recall. Supply the original query for matched windows; use offset to continue. The explicit full mode pages raw transcript content and remains capped below Pi's 50KB tool-output limit.",
    parameters: Type.Object({
      id: Type.Integer({ description: "Session entry ID returned by recall." }),
      query: Type.Optional(Type.String({ description: "Terms used to select relevant windows." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Source character offset to continue from." })),
      max_chars: Type.Optional(Type.Integer({
        minimum: 1000,
        maximum: 12000,
        description: "Maximum returned characters; defaults to configured recall limit.",
      })),
      full: Type.Optional(Type.Boolean({
        description: "Explicitly page raw transcript content instead of matching windows (capped at 45KB; use offset to continue).",
      })),
    }),
    async execute(_toolCallId, params) {
      try {
        await ensureMemstore();
        const result = await memstoreClient.show(params.id);
        const entry = result.entry;
        const excerpt = buildRelevantExcerpt(entry.body, {
          query: params.query || "",
          offset: params.offset || 0,
          maxChars: params.max_chars || config.recallMaxSessionChars || 8000,
          full: params.full || false,
        });
        const dateLabel = formatSessionDate(extractSessionDate(entry.body) || entry.created_at);
        const continuation = excerpt.nextOffset != null
          ? `

*More matching content is available. Continue with offset ${excerpt.nextOffset}.*`
          : "";
        const text = `## Session #${entry.id}: ${entry.title}
*${dateLabel} | depth ${entry.depth} | tags: ${(entry.tags || []).join(", ") || "none"}*

${excerpt.text}${continuation}`;
        const boundedText = joinWithinBudget([text], 48 * 1024, "");
        return {
          content: [{ type: "text", text: boundedText }],
          details: {
            id: entry.id,
            sourceRanges: excerpt.sourceRanges,
            nextOffset: excerpt.nextOffset,
            truncated: excerpt.truncated,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to recall session: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("sleep", {
    description: "Run the sleep cycle: capture session, write WAKE.md, curate FACTS.md, dream. Then open a fresh session.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const confirmed = await ctx.ui.confirm(
        "Sleep cycle",
        "Capture this session, run WAKE.md + FACTS.md + dream phases, then open a fresh session?"
      );
      if (!confirmed) {
        ctx.ui.notify("Sleep cancelled.", "info");
        return;
      }

      await ensureSessionState(ctx);

      try {
        await runSleepCycle({
          ctx,
          config,
          store,
          summarizeCurrentSession,
        });
      } catch (err) {
        ctx.ui.notify(`Sleep cycle error: ${err.message}`, "error");
        console.error("[sleep] Cycle error:", err);
        return;
      }

      ctx.ui.notify("Sleep complete. Opening fresh session...", "info");
      await ctx.newSession();
    },
  });
}
