# ADR 0001: Core is source of truth; contracts are wire; server is adapters

Date: 2026-01-22
Status: Accepted

## Context
The codebase has started to fragment shared types across packages. This creates drift between core domain models, contract DTOs, and server/local copies. It also makes adapters and tests unstable because they implicitly encode their own versions of shared types.

We need a clear ownership rule and tooling to keep the architecture coherent as we evolve.

## Decision
- **Core is the source of truth** for domain entities, events, and shared enums/union types.
- **Contracts are the wire format** for DTOs and schemas that cross process or surface boundaries.
- **Server is an adapter** (one of many) and must import domain types from core and DTOs from contracts instead of re-declaring them.

## Consequences
- New shared enums or shared DTOs must be declared in core/contracts (never in server or E2E tests).
- Server and E2E code must import these types from their authoritative packages.
- Lint rules and a lightweight guardrail script enforce this policy and fail CI when it is violated.

## Notes
This ADR does not forbid server-only, adapter-local types. It only forbids re-declaring types that already belong to core/contracts.
