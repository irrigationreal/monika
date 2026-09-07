import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callMemstoreTool } from "../src/memstore-rpc.mjs";

async function socketServer(t, reply) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memstore-rpc-"));
  const socketPath = path.join(root, "memstore.sock");
  const server = net.createServer((socket) => socket.once("data", () => reply(socket)));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return socketPath;
}

test("memstore RPC enforces an optional response byte limit before JSON parsing", async (t) => {
  const socketPath = await socketServer(t, (socket) => socket.end(`${JSON.stringify({ result: { structuredContent: { body: "x".repeat(2_000) } } })}\n`));
  assert.equal(await callMemstoreTool(socketPath, "memstore_show_entry", { id: 1 }, 1_000, { maxBytes: 512 }), null);
});

test("memstore RPC preserves unbounded-by-default behavior for existing callers", async (t) => {
  const expected = { body: "x".repeat(2_000) };
  const socketPath = await socketServer(t, (socket) => socket.end(`${JSON.stringify({ result: { structuredContent: expected } })}\n`));
  assert.deepEqual(await callMemstoreTool(socketPath, "memstore_status", {}, 1_000), expected);
});
