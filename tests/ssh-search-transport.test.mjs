import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPositionalSshInput, POSITIONAL_REMOTE_WRAPPER } from "../config/extensions/ssh-lock.mjs";
import { REMOTE_ATOMIC_WRITE_SCRIPT, REMOTE_FIND_SCRIPT, REMOTE_GREP_SCRIPT } from "../config/extensions/ssh-relocate.mjs";

const root = mkdtempSync(path.join(tmpdir(), "ssh-search-transport-"));
const bin = path.join(root, "bin");
const argsFile = path.join(root, "rg-args");
spawnSync("mkdir", ["-p", bin]);
const fakeRg = path.join(bin, "rg");
writeFileSync(fakeRg, `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$FAKE_RG_ARGS"
case "$FAKE_RG_MODE" in
  no-match) exit 1 ;;
  invalid) printf 'invalid regex\\n' >&2; exit 2 ;;
  find) printf 'src/a.ts\\nsrc/b.ts\\n'; exit 0 ;;
  context)
    printf '%s\\n' \\
      '{"type":"context","data":{"path":{"text":"src/a.ts"},"line_number":1,"lines":{"text":"before\\n"}}}' \\
      '{"type":"match","data":{"path":{"text":"src/a.ts"},"line_number":2,"lines":{"text":"hit\\n"}}}' \\
      '{"type":"context","data":{"path":{"text":"src/a.ts"},"line_number":3,"lines":{"text":"after\\n"}}}' \\
      '{"type":"match","data":{"path":{"text":"src/a.ts"},"line_number":4,"lines":{"text":"second\\n"}}}'; exit 0 ;;
  *) printf '%s\\n' '{"type":"match","data":{"path":{"text":"src/a.ts"},"line_number":1,"lines":{"text":"hit\\n"}}}'; exit 0 ;;
esac
`);
chmodSync(fakeRg, 0o755);

function run(script, args, mode, input, extraEnv = {}) {
  return spawnSync("bash", ["-c", POSITIONAL_REMOTE_WRAPPER], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RG_ARGS: argsFile, FAKE_RG_MODE: mode, ...extraEnv },
    input: buildPositionalSshInput(script, args.map(String), input),
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function recordedArgs() {
  return readFileSync(argsFile).toString().split("\0").filter(Boolean);
}

test("stdin positional transport preserves empty, trailing-newline, and large arguments", () => {
  const large = "x".repeat(256 * 1024);
  const result = run("printf '<%s>\\n' \"$@\"", ["", "tail\n", large], "");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("<>\n<tail\n>\n<"));
  assert.ok(result.stdout.endsWith(`${large}>\n`));
});

test("remote write streams large complete-file payloads over stdin rather than argv", () => {
  const target = path.join(root, "large-edit-target.txt");
  writeFileSync(target, "old");
  const payload = Buffer.alloc(256 * 1024, "x");
  const result = run(REMOTE_ATOMIC_WRITE_SCRIPT, [target, digest(payload)], "", payload.toString("base64"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(target), payload);
});

test("remote write rejects a valid but truncated base64 payload without replacing the destination", () => {
  const target = path.join(root, "truncated-write-target.txt");
  writeFileSync(target, "original");
  const payload = Buffer.alloc(256 * 1024, "q");
  const truncated = payload.toString("base64").slice(0, -8);
  const result = run(REMOTE_ATOMIC_WRITE_SCRIPT, [target, digest(payload)], "", truncated);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(target, "utf8"), "original");
});

test("remote write rejects symlinked parent directories", () => {
  const outside = path.join(root, "outside");
  const inside = path.join(root, "inside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(inside, { recursive: true });
  symlinkSync(outside, path.join(inside, "link"));
  const target = path.join(inside, "link", "escaped.txt");
  const content = Buffer.from("ESCAPED");
  const result = run(REMOTE_ATOMIC_WRITE_SCRIPT, [target, digest(content)], "", content.toString("base64"));
  assert.notEqual(result.status, 0);
  assert.equal(spawnSync("test", ["-e", path.join(outside, "escaped.txt")]).status, 1);
});

test("remote write rejects a parent swapped to a symlink between validation and open", () => {
  const raceRoot = path.join(root, "race");
  const parent = path.join(raceRoot, "parent");
  const outside = path.join(raceRoot, "outside");
  mkdirSync(parent, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const fakeRealpath = path.join(bin, "realpath");
  writeFileSync(fakeRealpath, `#!/usr/bin/env bash
out=$(/usr/bin/realpath "$@") || exit $?
printf '%s\\n' "$out"
if [ -n "$SWAP_PARENT" ] && [ ! -e "$SWAP_PARENT.moved" ]; then
  mv -- "$SWAP_PARENT" "$SWAP_PARENT.moved"
  ln -s -- "$SWAP_OUTSIDE" "$SWAP_PARENT"
fi
`);
  chmodSync(fakeRealpath, 0o755);
  const target = path.join(parent, "escaped.txt");
  const result = run(
    REMOTE_ATOMIC_WRITE_SCRIPT,
    [target, digest(Buffer.from("ESCAPED"))],
    "",
    Buffer.from("ESCAPED").toString("base64"),
    { SWAP_PARENT: parent, SWAP_OUTSIDE: outside },
  );
  assert.notEqual(result.status, 0);
  assert.equal(spawnSync("test", ["-e", path.join(outside, "escaped.txt")]).status, 1);
});

test("remote grep passes hostile patterns positionally without command substitution", () => {
  const marker = path.join(root, "must-not-exist");
  const pattern = `literal $(touch ${marker}) \`touch ${marker}\` $HOME\nnext`;
  const result = run(REMOTE_GREP_SCRIPT, [0, 1, "*.ts", pattern, root, 0, 2, 4096, ""], "match");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync("test", ["-e", marker]).status, 1);
  const args = recordedArgs();
  assert.ok(args.includes(pattern));
  assert.ok(args.includes("--fixed-strings"));
  assert.ok(args.includes("--"));
});

test("remote grep producer bounds matches without dropping leading context or the match", () => {
  const result = run(REMOTE_GREP_SCRIPT, [0, 0, "", "hit", root, 2, 1, 4096, ""], "context");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"type":"context"/);
  assert.match(result.stdout, /"type":"match".*"line_number":2/);
  assert.doesNotMatch(result.stdout, /"line_number":4/);
});

test("remote grep treats no-match as success and invalid input as failure", () => {
  assert.equal(run(REMOTE_GREP_SCRIPT, [0, 0, "", "missing", root, 0, 2, 4096, ""], "no-match").status, 0);
  const invalid = run(REMOTE_GREP_SCRIPT, [0, 0, "", "(", root, 0, 2, 4096, ""], "invalid");
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /invalid regex/);
});

test("remote find passes glob positionally, handles no-match, and bounds production", () => {
  const glob = "$(touch /tmp/no)-`echo no`-*.ts";
  const found = run(REMOTE_FIND_SCRIPT, [root, glob, 2, 1024, ""], "find");
  assert.equal(found.status, 0, found.stderr);
  assert.deepEqual(recordedArgs(), ["--files", "--hidden", "-g", glob]);
  assert.equal(found.stdout.trim().split("\n").length, 2);
  assert.equal(run(REMOTE_FIND_SCRIPT, [root, "*.none", 2, 1024, ""], "no-match").status, 0);
});
