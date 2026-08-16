# Codex Forum Refactor Plan (RoboBB)

Date: 2026-01-20
Owner: pp

## Goals
- Make the forum the source of truth (threads, posts, sessions) independent of adapters.
- Allow many adapters (web, Discord, Matrix, Slack, vBulletin) without breaking state or streaming.
- Support a single ECHS-backed agent runtime via a shared worker interface.
- Ensure durability of tool runs, plans, and assistant replies.
- Prepare for horizontal scale without rewriting the core again.

## Current risks and pain points
- In-memory stream bus and per-process thread state mean scale-out will split state and drop streams.
- SQLite is single-writer and will become the write bottleneck under multiple adapters.
- Agent runtime is embedded in the web server, so deploys and crashes kill in-flight turns.
- No auth or rate limiting for public access, so it is easy to spam and exhaust resources.
- Tool output is stored and broadcast without strict redaction, which risks leaking sensitive data.

## Target architecture

### 1) Forum Core (API + DB)
Single source of truth for:
- Forums, topics, posts, identities
- Sessions and agent runs
- Plans and tool runs
- Robot state (last known status, model, plan)

Swap SQLite for Postgres. Add a write-through cache for hot reads if needed.

### 2) Adapter Layer
Each adapter is a thin plugin that:
- Maps external events into forum posts
- Renders forum posts back to the external system
- Maintains rate and consistency on its own protocol

Adapters must not hold long-term state, only per-connection cursor/offsets.

### 3) Worker Layer
Move all agent runtimes into a worker pool:
- Workers consume jobs from a queue
- Each job references a topic, session, and latest post
- Workers stream deltas back through a shared event bus

ECHS is the worker type. It shares the same job contract.

### 4) Event Bus
Use a shared bus (Redis pubsub, NATS, or Kafka) to deliver:
- Streaming reasoning deltas
- Assistant deltas
- Tool run updates

The web server subscribes and fans out via SSE or WebSocket.

## Contracts

### Job contract (Forum Core -> Worker)
Fields:
- job_id
- topic_id
- session_id
- parent_post_id
- prompt
- model
- reasoning_effort
- base_instructions
- developer_instructions
- adapter_context (optional)

### Stream contract (Worker -> Event Bus)
Event types:
- state
- reasoning_delta
- assistant_message
- tool_started
- tool_completed

### Adapter contract
Methods:
- handleIncoming(event)
- handleOutgoing(post)
- health()
- shutdown()

## Migration plan

Phase 0 (now)
- Add feature flags to switch stream bus to Redis without breaking local mode.
- Add auth and basic rate limits on post creation and stream subscribe.

Phase 1
- Replace SQLite with Postgres and migrate schema.
- Add event bus and store robot state in DB only.

Phase 2
- Split worker service out of the web server.
- Introduce a queue and job table.
- Move ECHS integration into worker service.

Phase 3
- Add first external adapter plugin (Discord or Matrix).

Phase 4
- Scale horizontally behind a load balancer.
- Add adapter backpressure and retry strategy.

## Hard problems to solve now
- Exactly-once vs at-least-once event delivery for tool runs and assistant messages.
- Idempotency keys for adapter ingress to avoid duplicate posts.
- Session ownership and concurrency rules when multiple adapters talk to one topic.
- Privacy controls for tool outputs and internal reasoning.

## Open questions
- Is full chain-of-thought visibility required for all operators, or only debug mode?
- Should adapters enforce their own rate limits, or should the core do it centrally?
- Is there a single global identity map, or per-adapter identity namespaces?
- How should archived threads be handled by workers and adapters?
