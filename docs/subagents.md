# Subagents and delegated work

Monika uses a reviewed, pinned `pi-subagents` package as a workforce engine while
keeping narrative continuity and durable memory under the parent session's
control. Delegation is not automatic multiplication of identity: most children
are disposable specialists whose work contributes evidence without becoming a
new lived Monika experience.

This document owns the cross-cutting subagent model. Exact profile configuration
lives in [`config/agents/`](../config/agents/), package pins and patches live in
the installer and [`config/pi-subagents-0.37.2.patch`](../config/pi-subagents-0.37.2.patch),
SSH transport details live in [`config/extensions/SSH.md`](../config/extensions/SSH.md),
and deployment repair procedures live in [`redeployment.md`](redeployment.md).

## Roles and identity boundary

Configured profiles include scouts, researchers, context builders, planners,
reviewers, oracles, and workers. These roles receive bounded tools and only the
context their task requires.

Disposable specialists:

- receive project instructions and turn-routed topic addenda;
- do not receive autobiographical memory or the complete Monika persona;
- cannot mutate observations or invoke sleep;
- are omitted from forum session projection and memstore ingestion;
- return useful results to the canonical parent session.

`monika-delegate` is the explicit identity-bearing profile. It receives the stable
SOUL, STYLE, and REGISTER persona files, routed topic addenda, and bounded read-only
recall. It is appropriate when voice, taste, values, creative judgment, relational
context, or authored synthesis materially shapes the result.

Even an identity-bearing delegate is not an independent memory authority. The
parent decides what it endorses, how the result enters canonical history, and what
becomes a durable observation. Provenance comes before narrative compression.

## Execution shapes

The parent may run:

- one foreground specialist for a result needed immediately;
- parallel read-only specialists for independent evidence or review;
- a chain when one stage has an explicit output contract consumed by the next;
- bounded dynamic fanout when the work breadth is not known in advance;
- persistent asynchronous work when the parent can continue safely without the
  result and delivery must survive process restart.

Parallel writers must not mutate the same worktree. Use one writer in the active
worktree or deliberate isolated worktrees.

## Context and memory lifecycle

Child sessions live below `/app/.pi/agent/sessions/subagent/`, separate from
canonical user-facing sessions and sleep forks. Fresh and fork-context children
use per-run directories.

The deployment sets `subagents.defaultExtensions` to an empty list. Each profile
opts into its context seam and direct capabilities explicitly:

- specialist children receive topic-guided project context without persona or
  memory access;
- `monika-delegate` receives stable persona plus bounded read-only recall;
- no child receives memory mutation, observation lifecycle, automatic session
  ingestion, or sleep tools.

This is a lifecycle and capability boundary, not an operating-system sandbox.
Shell-capable children retain the runtime user's filesystem permissions and must
not circumvent it.

Useful child results return through the canonical parent transcript. This lets the
parent integrate evidence deliberately and allows normal parent-session memory
processing to preserve the result with honest attribution.

## Durable asynchronous lifecycle

Forum-owned delegation is forced through persistent asynchronous lifecycle
tracking at every nesting depth. Pi sessions and supervision stay local even when
a child routes coding tools to a named SSH target.

Before spawn, the package records durable launch and process identity. Lifecycle,
result, and recovery artifacts live below `/data/pi-subagents/`; operator delivery
custody and audits live below `/data/pi-subagent-operator-state/`.

Agentd continuously reconciles this ledger. Execution ownership and result delivery
are distinct:

- **active** work owns a process and blocks safe shutdown;
- **uncertain** work lacks trustworthy terminal proof and fails closed;
- **terminal with delivery pending** no longer owns a process but still needs
  canonical continuation or operator review;
- **remote effects unknown** does not imply a live process, but blocks safe
  deployment and replay until investigated.

A process-terminal record, runtime instance identity, PID start identity, and
container epoch distinguish surviving, interrupted, and destroyed runners across
agentd restart or container replacement. Optional project artifacts are never
supervisor authority.

## Canonical completion and forum projection

Agentd records a subagent origin in the canonical parent JSONL. A native package
completion becomes a parent continuation attributed as `subagent-completion` and
is projected beneath its originating forum post when available.

Canonical Pi message provenance is the acknowledgement proof. If agentd crashes
after persisting the assistant continuation but before removing the result file,
the next explicit session open can settle that file without waking the model or
creating a duplicate post.

Unproven legacy results remain pending. They are never consumed or deleted merely
because their content looks plausible.

## Stop, drain, and restart

Forum **Stop Robot** first fences the topic's durable dispatch generation, then
asks agentd to cancel work by canonical Pi session. Agentd can address a loaded or
unloaded parent, aborts the parent when necessary, writes scoped child controls,
and rescans nested work to a bounded fixed point.

The result remains typed as:

- `stopping` — cancellation accepted but not yet proven complete;
- `stopped` — local termination and cancellation barrier proven;
- `uncertain` — parent or child state cannot yet be proven.

Cancelled result bytes remain retained. Stop does not rewrite unknown SSH effects
as rollback. Scheduled package runs are disabled and outside the current causal
descendant contract.

Deployment drain rejects new launches and prevents completed results from waking a
parent while shutdown is being prepared. Pending delivery alone does not block
shutdown; active, uncertain, and effects-unknown work does. See
[`redeployment.md`](redeployment.md) for quiescence and repair operations.

## Execution targets

Role and execution location are separate decisions. Omission means local execution.
A remote leaf must select an administrator-configured named SSH target and run
asynchronously so transport ambiguity has a durable ledger.

SSH never falls back to local execution. A failed or timed-out mutation may have
continued remotely and therefore reports `effects_state=unknown`. Operators must
inspect and reconcile those effects before retry or deployment. See
[`config/extensions/SSH.md`](../config/extensions/SSH.md).

## Retention and manual resolution

Agentd exposes a deterministic retention dry run and applies conservative cleanup
only to proven-terminal, explicitly non-resumable bulky lifecycle logs with
settlement proof. Child sessions, resumable work, pending results, malformed
records, and uncertain state remain protected.

Manual delivery dismissal, effects resolution, or uncertain-run quarantine is an
audited last resort. These actions preserve evidence rather than editing history to
look cleaner. Exact endpoints and operator requirements are documented in
[`redeployment.md`](redeployment.md).

## Trust boundary

Subagent lifecycle controls coordinate processes running under the same runtime
UID; they are not cryptographic authentication and do not confine arbitrary shell.
The standalone container/user boundary, explicit tool profiles, loopback-only
agentd surface, locked SSH target account, and review discipline remain part of the
security model.
