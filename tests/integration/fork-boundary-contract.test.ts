import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrate } from "../../services/forum/packages/server/src/db.ts";
import { EchsClient } from "../../services/forum/packages/server/src/echsClient.ts";
import { ForkService } from "../../services/forum/packages/server/src/services/forkService.ts";
import { ForumStore } from "../../services/forum/packages/server/src/store.ts";

const requireFromForum = createRequire(
  new URL("../../services/forum/package.json", import.meta.url),
);
const Database = requireFromForum("better-sqlite3") as new (
  path: string,
) => any;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate test port"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForHealth(baseUrl: string, exited: Promise<never>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await Promise.race([fetch(`${baseUrl}/healthz`), exited]);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for isolated agentd");
}

function message(role: "user" | "assistant", text: string, timestamp: number) {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
    ...(role === "assistant"
      ? {
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          api: "test",
          provider: "test",
          model: "test",
        }
      : {}),
  };
}

test("every forum-advertised canonical boundary executes against the same agentd snapshot", async () => {
  const nativeImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<Record<string, any>>;
  const repoRoot = new URL("../../", import.meta.url);
  const { SessionManager } = await nativeImport(
    new URL(
      "services/agentd/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      repoRoot,
    ).href,
  );
  const {
    ForumForkLedger,
    forkConversationBeforeUser,
    readForumForkBoundarySnapshot,
  } = await nativeImport(
    new URL("services/agentd/src/forum-fork-operation.mjs", repoRoot).href,
  );
  const root = await mkdtemp(join(tmpdir(), "fork-boundary-contract-"));
  const db = new Database(":memory:");
  const services: ForkService[] = [];
  try {
    const agentDir = join(root, "agent");
    const manager = SessionManager.create(root, join(agentDir, "sessions", "integration"));
    const inheritedUser = manager.appendMessage(
      message("user", "inherited prompt", 1),
    );
    const inheritedAssistant = manager.appendMessage(
      message("assistant", "inherited answer", 2),
    );
    const selectedUser = manager.appendMessage(
      message("user", "opening that failed", 3),
    );
    const failed = message("assistant", "partial progress before failure", 4);
    failed.stopReason = "error";
    failed.errorMessage = "synthetic failure";
    manager.appendMessage(failed);

    migrate(db);
    const store = new ForumStore(db);
    const forum = store.createForum("Integration", undefined, root);
    const admin = store.createIdentity("Admin", "admin");
    const robot = store.createIdentity("Robot", "robot");
    const created = store.createTopic({
      forumId: forum.id,
      title: "Source",
      body: "inherited prompt",
      authorId: admin.id,
    });
    const answer = store.createPost({
      topicId: created.topic.id,
      body: "inherited answer",
      authorId: robot.id,
    });
    const selected = store.createPost({
      topicId: created.topic.id,
      body: "opening that failed",
      authorId: admin.id,
    });
    const session = store.ensureSession({ topicId: created.topic.id });
    store.upsertPiSessionLink({
      piSessionId: manager.getSessionId(),
      piSessionPath: manager.getSessionFile()!,
      topicId: created.topic.id,
      sessionId: session.id,
      cwd: root,
      metadata: { source: "integration-test" },
    });

    const branch = manager.getBranch();
    for (const entry of branch) {
      const role =
        entry.type === "message" ? (entry.message?.role ?? null) : null;
      const visible =
        entry.type === "message" &&
        Array.isArray(entry.message?.content) &&
        entry.message.content.some(
          (part: any) => part?.type === "text" && part.text?.trim(),
        );
      db.prepare(
        `insert into pi_entry_index
         (pi_session_id, entry_id, parent_entry_id, entry_type, role, custom_type, has_visible_text, first_indexed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        manager.getSessionId(),
        entry.id,
        entry.parentId ?? null,
        entry.type,
        role,
        entry.type === "custom" ? entry.customType : null,
        visible ? 1 : 0,
        new Date().toISOString(),
      );
    }
    for (const [entryId, post, role] of [
      [inheritedUser, created.post, "user"],
      [inheritedAssistant, answer, "assistant"],
      [selectedUser, selected, "user"],
    ] as const) {
      store.createPiMessageLink({
        piSessionId: manager.getSessionId(),
        piMessageId: entryId,
        postId: post.id,
        role,
        metadata:
          role === "user"
            ? { contributorPostIds: [post.id] }
            : { linkedBy: "assistant-projection" },
      });
    }
    let canonicalSnapshot = readForumForkBoundarySnapshot({
      piSessionId: manager.getSessionId(),
      sessionPath: manager.getSessionFile(),
      cwd: root,
    });

    const port = await freePort();
    let stoppingAgentd = false;
    let agentdOutput = "";
    const agentd = spawn(process.execPath, [new URL("../../services/agentd/src/server.mjs", import.meta.url).pathname], {
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENT_RUNTIME_ROOT: join(root, "subagents", "runtime"),
        PI_SUBAGENT_SESSION_ROOT: join(root, "subagents", "sessions"),
        PI_SUBAGENT_OPERATOR_ROOT: join(root, "subagents", "operator"),
        MONIKA_RUNTIME_INSTANCE_FILE: join(root, "runtime-instance.json"),
        MONIKA_AGENTD_HOST: "127.0.0.1",
        MONIKA_AGENTD_PORT: String(port),
        MONIKA_AGENTD_MODEL_REFRESH_INTERVAL_MS: "0",
        PI_OFFLINE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    agentd.stdout.on("data", (chunk) => (agentdOutput += chunk.toString()));
    agentd.stderr.on("data", (chunk) => (agentdOutput += chunk.toString()));
    const unexpectedExit = new Promise<never>((_resolve, reject) => {
      agentd.once("exit", (code, signal) => {
        if (!stoppingAgentd) reject(new Error(`Isolated agentd exited ${code ?? signal}: ${agentdOutput}`));
      });
    });
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(baseUrl, unexpectedExit);
      const client = new EchsClient({ baseUrl });
      const opened = await client.openConversation({
        piSessionId: manager.getSessionId(),
        piSessionPath: manager.getSessionFile(),
        cwd: root,
      });
      await assert.doesNotReject(async () => {
        const remoteSnapshot = await client.getForkBoundarySnapshot(opened.conversation_id);
        assert.deepEqual(
          remoteSnapshot.eligible_boundary_entry_ids,
          canonicalSnapshot.eligible_boundary_entry_ids,
        );
        assert.deepEqual(
          remoteSnapshot.active_entry_ids.slice(0, canonicalSnapshot.active_entry_ids.length),
          canonicalSnapshot.active_entry_ids,
        );
        canonicalSnapshot = remoteSnapshot;
      });
    } finally {
      stoppingAgentd = true;
      agentd.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (agentd.exitCode !== null || agentd.signalCode !== null) resolve();
        else agentd.once("exit", () => resolve());
      });
    }

    db.prepare(
      "insert into pi_session_heads(pi_session_id, leaf_entry_id, active_entry_ids_json, observed_at) values(?,?,?,?)",
    ).run(
      manager.getSessionId(),
      canonicalSnapshot.leaf_entry_id,
      JSON.stringify(canonicalSnapshot.active_entry_ids),
      new Date().toISOString(),
    );
    store.upsertRobotState({
      topicId: created.topic.id,
      sessionId: session.id,
      activity: "idle",
      currentPlanId: null,
    });

    const ledger = new ForumForkLedger(join(root, "ledger"));
    const conv = {
      piSessionId: manager.getSessionId(),
      sessionPath: manager.getSessionFile(),
      cwd: root,
    };
    const service = new ForkService(
      store,
      {
        getTopicForkBoundarySnapshot: async () =>
          readForumForkBoundarySnapshot(conv),
        forkTopicConversation: async (_topicId, input) =>
          forkConversationBeforeUser({
            conv,
            input: {
              operation_id: input.operationId,
              expected_leaf_id: input.expectedLeafId,
              boundary_entry_id: input.boundaryEntryId,
            },
            ledger,
          }),
        acknowledgeFork: async (operationId, childSessionId) => {
          assert.equal(
            await ledger.acknowledge(operationId, childSessionId),
            true,
          );
        },
      },
      { wake() {} },
      {
        intervalMs: 60_000,
        uploadsDir: join(root, "uploads"),
        refreshBoundaries: async () => {},
      },
    );
    services.push(service);
    service.start();

    const advertised = await service.boundaries(created.topic.id);
    assert.deepEqual(
      advertised.map((boundary) => boundary.entryId),
      [selectedUser],
    );
    await service.enqueue({
      operationId: "integration-fork",
      topicId: created.topic.id,
      boundaryPostId: selected.id,
      initiatedBy: admin.id,
      title: "Forked source",
      openingBody: "replacement opening",
    });
    await service.waitForIdle();

    const operation = service.get(created.topic.id, "integration-fork");
    assert.equal(operation.status, "succeeded");
    assert.equal(operation.expectedLeafId, canonicalSnapshot.leaf_entry_id);
    const childPosts = store.listPosts(operation.childTopicId!, 1, 100);
    assert.deepEqual(
      childPosts.map((post) => post.body),
      ["inherited prompt", "inherited answer", "replacement opening"],
    );
    const childLink = store.getPiSessionLinkByTopic(operation.childTopicId!);
    assert.ok(childLink);
    const child = SessionManager.open(childLink.pi_session_path);
    assert.equal(
      child.getBranch().some((entry: any) => entry.id === selectedUser),
      false,
    );
  } finally {
    await Promise.all(services.map((service) => service.stop()));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
