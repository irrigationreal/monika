# Monika Forum Service

Purpose: forum frontend for Monika/Pi sessions. This service was imported from
`irrigationreal/monika-forum`, which repurposed the Irrigate Collective
`codex-forum` project for Monika.

The forum remains a UI/API/projection layer. It must not embed Pi and must not
talk directly to memstore. It talks to Monika through `agentd` using
`MONIKA_AGENTD_BASE_URL`.

Primary packages:
- `@irrigationreal/codex-forum-core`
- `@irrigationreal/codex-forum-contracts`
- `@irrigationreal/codex-forum-adapters`
- `@irrigationreal/codex-forum-server`
- `@irrigationreal/codex-forum-cli`

App:
- `apps/codex-forum` (Vue)

## Architecture constraints

- Pi JSONL sessions are canonical conversation state.
- Forum SQLite is projection/metadata/blob metadata only.
- One forum topic maps to one canonical Pi session.
- Memory save/dedupe identity uses canonical Pi session id/path.
- Close/save lifecycle goes forum → agentd → Pi `session_shutdown` → stateful-memory.

## Git workflow

After making changes, commit and push. Commit messages must include the URL to
the forum thread/post that requested the change.

### Attribution policy

- Default: do **not** add `Co-authored-by:` trailers or any other attribution trailers.
- Exception: if `.codex-forum/requester.json` exists and includes a forum requester
  with a robot-only email address, add exactly one trailer:
  - `Co-authored-by: <forum_username> <requester_email>`
- If requester email is missing/unset, use no trailer.

## Clean architecture rules

**Single source of truth**
- Core (`packages/core`) owns domain vocabulary: enums/unions, IDs, entities, read-models, policies, and service interfaces/implementations.
- Contracts (`packages/contracts`) owns the API boundary: DTOs + Zod schemas. Reuse core primitives instead of redefining enums/unions.
- Server (`packages/server`) is infra + wiring: DB rows, repositories, adapters, routes. It must not redefine domain types already in core/contracts.

**Layering discipline**
1. Domain/application logic lives in core.
2. Repositories and adapters live in server.
3. Routes call services + mappers, not store/SQL directly.
4. Contracts schemas are enforced at the HTTP boundary.

**Mapping rules**
- Only two mapping layers: DB ↔ Domain, and Domain ↔ DTO.
- Never hand-build DTOs in routes; use mappers.
- Never parse/shape DB rows in routes; use DB→domain mappers.

**Type hygiene**
- Do not re-declare shared enums/types in server/app/tests.
- If you need a convenience type, alias from core/contracts.
- Run `pnpm guardrails:types` before final commit when touching shared types.

## CI expectations

Forum container build checks live at `.github/workflows/ci-forum-container.yml` and expose `forum-container-checks` as the branch-protection gate. Cross-service agentd/forum compatibility belongs in `.github/workflows/ci-integration.yml`; it is currently a placeholder gate named `integration-checks`.

The forum image definition is `services/forum/Containerfile`. The `Image / Forum`, `Release / Nightly`, and `Release / Stable` workflows publish or promote `ghcr.io/irrigationreal/monika-forum` images from this repo.

## Testing

Run from `services/forum`:

```bash
pnpm test
```

On stanza, use `nix-shell` if pnpm is not on PATH:

```bash
nix-shell -p nodejs_22 pnpm --run 'CODEX_FORUM_UPLOADS_DIR=/tmp/codex-forum-test-uploads pnpm test'
```

Unit/integration tests live under:
- `packages/*/src/**/*.test.ts`
- `apps/codex-forum/src/**/*.test.ts`

E2E tests live under:
- `apps/codex-forum/e2e/**/*.spec.ts`

Do not add new tests unless explicitly instructed, unless the change is large or high-risk enough that you should recommend tests first.
