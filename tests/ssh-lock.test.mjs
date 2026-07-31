import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ATOMIC_WRITE_SCRIPT,
  assertLockedDescriptorBinding,
  buildLockedSshArgv,
  classifyTransientTransport,
  executionTargetBindingDigest,
  isContained,
  lockCodeDigest,
  lockedInputDecision,
  parseCompletionTrailer,
  parseLockedDescriptor,
  runLockedSsh,
  withBoundedReadRetry,
} from "../config/extensions/ssh-lock.mjs";

const descriptor = {
  version: 1,
  name: "stanza",
  target: "deploy@stanza",
  hostname: "stanza",
  cwd: "/home/monika/repos/monika",
  allowedRoot: "/home/monika/repos",
  knownHosts: "/runtime/secrets/ssh/known_hosts",
};

test("locked descriptor is closed and contained", () => {
  assert.deepEqual(parseLockedDescriptor(JSON.stringify(descriptor)), descriptor);
  assert.throws(() => parseLockedDescriptor(JSON.stringify({ ...descriptor, extra: true })), /shape/);
  assert.throws(() => parseLockedDescriptor(JSON.stringify({ ...descriptor, cwd: "/etc" })), /containment/);
  assert.equal(isContained("/repos", "/repos/a"), true);
  assert.equal(isContained("/repos", "/repos-escape"), false);
});

test("package launch binding rejects changed descriptor name or digest", () => {
  const loaded = { descriptor, digest: "a".repeat(64) };
  assert.equal(assertLockedDescriptorBinding(loaded, "stanza", "a".repeat(64)), descriptor);
  assert.throws(() => assertLockedDescriptorBinding(loaded, "other", "a".repeat(64)), /name_mismatch/);
  assert.throws(() => assertLockedDescriptorBinding(loaded, "stanza", "b".repeat(64)), /digest_mismatch/);
});

test("target binding includes known_hosts and startup-attested lock code", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ssh-lock-integrity-"));
  const extension = path.join(root, "ssh.ts"); const helper = path.join(root, "ssh-lock.mjs");
  writeFileSync(extension, "extension-a"); writeFileSync(helper, "helper-a");
  const codeA = lockCodeDigest(extension, helper);
  writeFileSync(extension, "extension-b");
  const codeB = lockCodeDigest(extension, helper);
  assert.notEqual(codeA, codeB);
  const raw = Buffer.from(JSON.stringify(descriptor));
  assert.notEqual(executionTargetBindingDigest(raw, Buffer.from("host-a"), codeA), executionTargetBindingDigest(raw, Buffer.from("host-b"), codeA));
  assert.notEqual(executionTargetBindingDigest(raw, Buffer.from("host-a"), codeA), executionTargetBindingDigest(raw, Buffer.from("host-a"), codeB));
});

test("strict ssh argv pins known_hosts and encodes untrusted args", () => {
  const argv = buildLockedSshArgv(descriptor, "bash -s --", ["; touch /tmp/no"]);
  assert.ok(argv.includes("StrictHostKeyChecking=yes"));
  assert.ok(argv.includes("UserKnownHostsFile=/runtime/secrets/ssh/known_hosts"));
  assert.ok(argv.includes("ClearAllForwardings=yes"));
  assert.ok(!argv.includes("; touch /tmp/no"));
  assert.equal(argv.at(-1), Buffer.from("; touch /tmp/no").toString("base64"));
});

test("read retry is capped at two attempts and mutations have no retry wrapper", async () => {
  let attempts = 0;
  await assert.rejects(() => withBoundedReadRetry(async () => {
    attempts++;
    const error = new Error("connection reset");
    error.stderr = "Connection reset by peer";
    throw error;
  }, async () => {}));
  assert.equal(attempts, 2);
  assert.equal(classifyTransientTransport(new Error("permission denied")), false);
  assert.match(ATOMIC_WRITE_SCRIPT, /mktemp/);
  assert.match(ATOMIC_WRITE_SCRIPT, /sha256sum/);
  assert.match(ATOMIC_WRITE_SCRIPT, /parentcap="\/proc\/\$\$\/fd\/\$parentfd"/, "rename destination is bound to an open directory capability");
  assert.match(ATOMIC_WRITE_SCRIPT, /mv -f -- "\$tmp" "\$dest"/);
  assert.doesNotMatch(ATOMIC_WRITE_SCRIPT, /mv -f -- "\$tmp" "\$p"/);
});

test("atomic write fails closed and cleans up when its parent directory is substituted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ssh-lock-race-root-"));
  const escape = mkdtempSync(path.join(tmpdir(), "ssh-lock-race-escape-"));
  const parent = path.join(root, "parent"); const moved = path.join(escape, "moved-parent");
  mkdirSync(parent);
  const content = Buffer.from("race-safe\n"); const digest = createHash("sha256").update(content).digest("hex");
  const child = spawn("bash", ["-c", ATOMIC_WRITE_SCRIPT, "--", path.join(parent, "victim.txt"), root, digest], { stdio: ["pipe", "ignore", "pipe"] });
  for (let attempt = 0; attempt < 200 && !readdirSync(parent).some((name) => name.startsWith(".monika-write.")); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(readdirSync(parent).some((name) => name.startsWith(".monika-write.")), "writer reached its held-parent temporary file");
  renameSync(parent, moved); symlinkSync(escape, parent);
  child.stdin.end(content.toString("base64"));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.notEqual(code, 0);
  assert.equal(existsSync(path.join(escape, "victim.txt")), false);
  assert.equal(existsSync(path.join(moved, "victim.txt")), false, "failed post-check removes the capability-bound write");
});

test("pending and failed lock states consume input before provider startup", () => {
  assert.deepEqual(lockedInputDecision("locked-pending"), { action: "handled" });
  assert.deepEqual(lockedInputDecision("locked-failed"), { action: "handled" });
  assert.deepEqual(lockedInputDecision("locked-verified"), { action: "continue" });
});

test("injected ssh transport receives strict argv and mutation attempts are single-shot", async () => {
  let calls = 0;
  let argv;
  const spawnProcess = (_command, args) => {
    calls++;
    argv = args;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => { child.stderr.end("Connection reset by peer"); child.stdout.end(); child.emit("close", 255, null); });
    return child;
  };
  await assert.rejects(() => runLockedSsh(descriptor, "fixed script", ["unsafe;arg"], { spawnProcess }), /ssh_exit_255/);
  assert.equal(calls, 1);
  assert.ok(argv.includes("StrictHostKeyChecking=yes"));
  assert.ok(!argv.includes("unsafe;arg"));
});

test("completion trailer treats missing or malformed completion as effects unknown", () => {
  assert.deepEqual(parseCompletionTrailer("output", "abc"), {
    completion: "unknown", effects_state: "unknown", error: "ssh_transport_ambiguous",
  });
  const parsed = parseCompletionTrailer("hello\n__MONIKA_SSH_COMPLETE_abc__:7\n", "abc");
  assert.equal(parsed.completion, "known");
  assert.equal(parsed.exitCode, 7);
  assert.equal(parsed.effects_state, "confirmed");
});
