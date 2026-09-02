# Runtime maintenance

This document covers dependency policy, Pi upgrades, CI entry points, and image
publishing references. Exact versions and resolved dependency graphs remain
canonical in manifests, lockfiles, installer scripts, and tracked configuration—not
in prose.

## Dependency policy

npm and pnpm resolution use a ten-day minimum release age. The npm policy is baked
into the Monika image and remains active for interactive installs; pnpm policy
lives in each workspace's `pnpm-workspace.yaml`. pnpm fails closed when no mature
version satisfies a range or registry publication time is missing, and verifies
frozen lockfiles against that policy during builds.

Dependency lifecycle scripts are also fail-closed. Each workspace's `allowBuilds`
map explicitly approves or denies the packages whose install scripts were reviewed;
new unreviewed scripts fail installation rather than running or being silently
ignored.

The pnpm workspaces exempt `@earendil-works/*` so coordinated Pi releases can be
adopted without waiting ten days. The image's exact global Pi install bypasses the
npm cooldown explicitly for that one reviewed command; arbitrary interactive npm
installs are not broadly exempt. Agentd records its complete dependency graph in
`services/agentd/pnpm-lock.yaml`.

For an urgent non-Pi update, bypass the cooldown only for the exact update command
and restore normal policy immediately:

```bash
npm install --min-release-age=0 <package>@<exact-version>
pnpm install --config.minimumReleaseAge=0 <package>@<exact-version>
```

Runtime tools and Pi packages are pinned deliberately in their executable sources,
including:

- `scripts/install-pi-subagents` and `config/pi-subagents-*.patch`;
- `Containerfile` for image-installed tools;
- `config/settings.json` for image settings defaults and initial Pi packages;
- service `package.json` files and lockfiles.

Do not duplicate exact hashes or versions in overview documentation. Update the pin,
its verification, and its tests together.

## Upgrading Pi

Pi is installed both in the runtime image and as an agentd SDK dependency. Change
the exact version in:

```text
Containerfile
services/agentd/package.json
config/settings.json
tests/smoke/monika-runtime.sh
```

`config/settings.json` records the bundled changelog acknowledgement so a rebuilt
runtime does not present already-reviewed release notes as an unreviewed local
state change. It is the source of image defaults and first-boot package choices;
a deployment's current `packages` array and Pi-managed `npm/`/`git/` trees live
under `/data/pi-agent-packages`. Startup reapplies image defaults while retaining
that array. The reviewed browser package seed must be produced by Pi's own exact
`pi install` operation in `Containerfile`, not by a custom installer.

`PI_OFFLINE=1` on normal Pi and agentd startup gates automatic package resolution
and update checks. It does not authorize or block an explicit `pi install`.
Administrator maintenance commands still set `PI_OFFLINE=0` explicitly as a record
of online-maintenance intent:

```bash
docker exec -it -e PI_OFFLINE=0 monika pi install npm:package@1.2.3
docker exec -it -e PI_OFFLINE=0 -e GIT_TERMINAL_PROMPT=0 monika \
  pi install git:github.com/owner/repository@<commit>
docker exec -it -e PI_OFFLINE=0 monika pi update --extensions
docker exec -it -e PI_OFFLINE=0 monika pi remove npm:package
```

Keep Git terminal prompting disabled unless a reviewed private-package credential
path was configured deliberately. An unexpected credential challenge must fail the
maintenance command rather than block an interactive Pi or agentd process.

Run package maintenance only at forum/agentd quiescence and recreate Monika through
the safe deployment path immediately afterward. Existing loaded conversations retain
the resources they started with; they do not hot-reload changed packages. Do not use
a second container against the live runtime state to work around this boundary.

Do not edit the persistent settings file as a substitute for Pi package commands;
Pi intentionally persists a package choice only after installation succeeds.
`pi update --extensions` can refresh floating sources, but it does not rotate an
exact npm pin. Upgrade pinned packages—including `pi-agent-browser`—with an exact
command such as `pi install npm:pi-agent-browser@NEW_VERSION`.

When upgrading a deployment created before package-state persistence, inventory
its old container-layer settings and installed package choices before discarding
the old container. Those disposable choices cannot migrate automatically. The
runtime no longer includes `nutrient-skills` by default; reinstall it only if an
administrator explicitly wants and reviews an exact source. Reinstall every
desired pin through Pi after the new runtime starts.

Before changing packages, back up the complete `/data/pi-agent-packages` tree. A
rollback must restore its `settings.json`, `npm/`, and `git/` from the same backup
while the runtime is stopped. Retain the pre-maintenance backup until the package
has loaded successfully after a container recreation; partial rollback can pair
settings with incompatible install trees.

Regenerate the frozen agentd lockfile with the repository's pnpm version:

```bash
cd services/agentd
corepack pnpm@11.21.0 install --lockfile-only
```

Then build and run the runtime smoke suite:

```bash
docker build -f Containerfile -t monika-test .
tests/smoke/monika-runtime.sh monika-test
```

Pi upgrades can change extension loading, tool schemas, model catalog behavior,
JSONL events, compaction, and SDK lifecycle semantics. Run focused tests for any
surface touched by the release rather than relying only on `pi --version`.

Do not recreate the live Monika container from an active Pi session. Prepare and
validate the image, then let the operator apply it through the safe deployment
path in [`redeployment.md`](redeployment.md).

## Test entry points

Repository-level test philosophy and commands live in
[`tests/README.md`](../tests/README.md). Major suites include:

- `services/agentd` provider-independent lifecycle tests;
- `services/memstore` Go/FTS5 tests;
- stateful-memory context and child-boundary tests;
- SSH transport and relocation tests;
- forum unit and E2E wrappers;
- full runtime and forum container smoke tests.

Tests must use ephemeral state. Never point a throwaway runtime, child test, or
runner at the live memstore database or `/data/pi-subagents` lifecycle root.

## CI gates

Pull requests and merge-queue candidates use stable subsystem gate jobs:

- `monika-container-checks` — runtime image and smoke validation;
- `forum-container-checks` — forum tests and image build;
- `integration-checks` — stable placeholder reserved for future cross-service
  compatibility coverage.

Workflow files under [`.github/workflows/`](../.github/workflows/) are executable
truth. [`AGENTS.md`](../AGENTS.md) records contributor and agent branch-gate rules;
do not copy workflow trigger matrices into the root README.

## Image publishing and releases

Development image workflows publish path-filtered `main` and commit-addressed
images. Nightly builds Monika and Forum from one commit into a coordinated immutable
candidate. Stable promotion reuses those exact manifests after the soak period
rather than rebuilding.

See [`releases.md`](releases.md) for candidate eligibility, digest verification,
release tags, and manual overrides.

## Licensing and distributed notices

First-party repository content is licensed under AGPL-3.0-or-later except where
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) identifies a separate
license. Source package manifests carry SPDX identifiers where the format
supports them. The Monika and Forum images expose the same SPDX identifier
through their OCI metadata and carry project license texts under
`/usr/share/licenses/`.

Source dependency records remain canonical in manifests and lockfiles. A
source or image SBOM is supplementary compliance evidence, not a replacement
for required license texts, notices, source provision, or other obligations.
Generate and review SBOMs against exact image digests in a dedicated compliance
change rather than mixing generated inventories into ordinary licensing or
feature work.

## Documentation discipline

System-wide contracts belong in root `docs/`; component behavior belongs beside the
component. Configuration and source files remain authoritative for exact defaults.
When behavior changes:

1. update the executable source and tests;
2. update its single canonical explanatory document;
3. leave short links—not copied summaries—in higher-level navigation documents;
4. check all moved or renamed Markdown links before merging.
