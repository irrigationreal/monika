# SSH extension and locked execution targets

`ssh.ts` has two deliberately separate modes.

## Locked subagent mode

The `subagent` tool accepts a named leaf target:

```json
{"agent":"worker","task":"inspect the repository","async":true,"executionTarget":{"kind":"ssh","name":"stanza"}}
```

SSH leaves require `async:true`; foreground launches are rejected before the first model turn because ambiguous remote effects must always enter the durable lifecycle ledger. Omission always means local; target selection never infers a parent relocation. A process already locked to an SSH target must explicitly reuse that same named target for nested delegation. Omission/local or a different name is rejected rather than inheriting or falling back. Invalid, missing, changed, or unreachable targets fail closed with no local fallback.

Administrators install descriptors under `PI_SUBAGENT_EXECUTION_TARGET_ROOT` (normally `/runtime/secrets/ssh/targets`). Deployments whose ignored `compose.yaml` predates this feature must copy the `PI_SUBAGENT_EXECUTION_TARGET_ROOT` and `PI_SUBAGENT_SSH_LOCK_EXTENSION` environment entries from `compose.yaml.example`; copying the example during initial setup is not an automatic migration. `<name>.json` is a closed version-1 object:

```json
{
  "version": 1,
  "name": "stanza",
  "target": "deploy@stanza",
  "hostname": "stanza",
  "cwd": "/home/monika/repos/monika",
  "allowedRoot": "/home/monika/repos",
  "knownHosts": "/runtime/secrets/ssh/known_hosts"
}
```

Names cannot contain paths. Descriptor files must resolve inside the registry. `knownHosts` must be a read-only regular file below `/runtime/secrets/ssh`. Host/user/options are never model input.

Pi, its JSONL session, lifecycle files, scheduling, RPC, and supervision remain local. At container startup, the runtime attests the exact `ssh.ts`, `ssh-lock.mjs`, and `ssh-relocate.mjs` bytes. Target recovery identity binds that code attestation together with the descriptor and `known_hosts` contents, so code changes or host-key rotation invalidate unattended resume. The local child Pi explicitly loads only those reviewed extensions; the extension verifies the binding, pinned host key, exact remote hostname, canonical cwd, and allowed root **before the first provider turn**. Locked mode does not register `relocate` and ignores ordinary SSH flags.

All `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, and `!` operations route to the verified target. File operations enforce `allowedRoot`. Writes use a same-directory temporary file, SHA-256 verification, symlink rejection, atomic rename, and final path/hash verification. Read-only transport failures retry at most once; mutations never retry.

A timeout, abort, lost connection, signal, malformed completion trailer, or spawn failure during remote bash/mutation is `ssh_transport_ambiguous` with `effects_state: unknown`. The remote operation may still be running. Safe deployment and automatic replay remain blocked until the evidence is reconciled or an operator records an audited effects resolution. Never dismiss retained delivery as a substitute for that resolution.

`allowedRoot` protects file tools; it is **not a bash sandbox**. Use a restricted remote account/container/chroot/forced command when arbitrary bash needs confinement. Remote authenticated content is trusted model input but is not descriptor attestation.

## Interactive legacy relocation

When `MONIKA_SSH_LOCK_DESCRIPTOR` is empty, the historical interactive flags remain available:

- `--ssh user@host[:/remote/path]`
- `--ssh-debug`
- `--ssh-verify /path`
- the `relocate` tool

Legacy relocation is an operator convenience and is not the named-target security boundary. It may use the user's ordinary SSH configuration. Even in legacy mode, a requested but failed SSH connection never silently falls back to local tools.

Interactive targets are normalized before use. Supported forms are `user@host`, an SSH config alias, `user@host:/absolute/path`, `user@host:~/path`, and bracketed IPv6 such as `user@[2001:db8::1]:/home/user`. Configure non-default ports in SSH config rather than overloading the path separator. Omit `target` to inspect state and use the exact value `local` to return to container execution.

Relocation is a serialized state transition:

1. parse and validate the target;
2. resolve a canonical remote cwd;
3. verify SSH, the cwd, and remote `rg` availability;
4. read remote `AGENTS.md` when present;
5. commit routing state once;
6. publish best-effort UI status.

UI status cannot change the tool outcome. TUI mode may color the footer; RPC uses plain text, while JSON/print modes skip presentation. A failed validation throws a real tool error and preserves the previous context. Status distinguishes `local`, `remote`, and `ssh_unavailable`; unavailable required SSH blocks routed tools instead of claiming a local fallback.

All model-controlled paths, patterns, globs, and fixed-script arguments cross SSH in a newline-delimited base64 header on stdin. They never enter the SSH client argv or remote login-shell source; the reviewed wrapper reconstructs them as positional data for fixed scripts. This preserves empty and trailing-newline values while avoiding Linux's per-argument `E2BIG` ceiling. Bash source and complete write/edit payloads follow the header as stdin payload. Bash executes from a temporary script file. Writes decode into a temporary file held through a same-directory capability, verify the complete payload digest, and atomically rename, rejecting symlink destinations and symlinked parent paths. Remote grep/find treat ripgrep exit code 1 as a successful no-match outcome, propagate invalid-input and transport failures, enforce an operation-wide 30-second timeout, cap search inputs, and bound producer output before local parsing. The runtime image pre-provisions `rg` and `fd`; remote targets must provision `rg` before relocation succeeds.

`relocate` results include privacy-safe structured details (`operation`, resulting `state`, `stateChanged`, and UI-warning count). Remote grep/find results identify the `relocated_ssh` backend and distinguish `success` from `no_match`. Raw hosts, paths, patterns, and commands remain outside analytics aggregates.
