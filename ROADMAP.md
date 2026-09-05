# Agentic OS — Roadmap

## Milestone 1 — Kernel v0.1 ✅ (this release)

Per §44 of the build spec:

- [x] Next.js frontend (OS shell: rail, panels, ⌘K command palette, dark/light)
- [x] Backend API (Fastify + zod DTOs; NestJS-scale modularity via ports — see ADR note below)
- [x] PostgreSQL schema + SQLite default driver (one portable SQL dialect)
- [x] Redis broker port + in-process default
- [x] Authentication (sessions, scrypt)
- [x] Agent registry + runtime (states, tracing, approvals, pause/stop)
- [x] Model registry + gateway (3 adapters, health probing, capability routing, fallback)
- [x] Event bus (23 types) + audit logs
- [x] Generation tracking (tokens/latency/cost)
- [x] Basic memory (7 types, scoring, decay, consolidation)
- [x] Tool registry (12 tools, risk classes, permission gates)
- [x] Skill registry + skill tree
- [x] Tasks / projects / sprints
- [x] Realtime activity stream (SSE)
- [x] Command center (natural-language routing)
- [x] Vitest suite (memory, planner, gate, router, adapter, auth)

**ADR note:** the spec asked for NestJS. We shipped Fastify + the same module/port
structure because the kernel's compl    exity lives in the runtime/gateway/memory
subsystems, not the HTTP layer, and Fastify keeps the dependency surface tiny
(one process, zero native deps in default mode). The API is a thin, typed
boundary over the same service layer a NestJS wrapper would expose — swapping
the HTTP shell later is mechanical if needed.

## Phase 2 — Model Gateway hardening ✅ (v0.2.0)

- [x] Streaming generation on ALL providers (`generateStream` on the port; openai-compat SSE, ollama ndjson, gemini SSE, builtin word-cadence for zero-dep testing)
- [x] Live token streaming to the UI: throttled volatile `agent.token` events (never persisted) → SSE → trace viewer streaming panel with mid-run Stop
- [x] Cancellation: Stop → AbortController → in-flight generation marked `cancelled` (not failed); execution → `cancelled`
- [x] Router `generateStream` with per-candidate fallback (same semantics as `generate`)
- [x] Gemini provider adapter (`v1beta generateContent` / `streamGenerateContent?alt=sse`, model auto-discovery, valid-body health probe)
- [x] Cost registry: published list prices seeded into models at registration (ordered patterns so gpt-4o-mini ≠ gpt-4o)
- [x] Usage accounting: `GET /api/models/usage` (gens, ✓/✗/⊘, tokens, cost, avg latency) + Settings → Model Usage table
- [x] Phase 2 test suite (streaming reconstruction, abort→cancelled, cost lookup, usage aggregation, gemini body/health) — 25/25 green

## Phase 3 — Agent runtime maturation ✅ (v0.3.0)

- [x] Subagent delegation: `agent.delegate` tool → child execution with `parent_execution_id` + `delegated_to` graph link; parent awaits child result; depth guard (`AGENTIC_MAX_DELEGATION_DEPTH`, default 2) blocks runaway chains; stop cascades to children
- [x] Per-step retry with exponential backoff (250ms · 2ⁿ, `AGENTIC_STEP_RETRIES`, default 1); user-initiated aborts never retried; retry attempts traced
- [x] Checkpoint resume: executions orphaned by a process crash are marked `interrupted` at boot (approvals timed out, agents released); `POST /executions/:id/resume` continues from the persisted plan/trace/observations at the current step (at-least-once: a step mid-flight at crash time re-runs)
- [x] Agent-to-agent messaging: `agent.message` tool → mailbox table; pending messages inject into the receiver's next planning context (and surface in its trace); Agents panel shows the mailbox
- [x] Command-center specialist routing: explicit ("ask the coder to…") and keyword-based (research→Researcher, code→Coder, status→Monitor, plan→Planner); delegation phrasing deliberately routes to Hermes so the supervisor builds a real delegation graph
- [x] Seed upgrade path: uncustomized built-in agents are refreshed to the current seed definition on boot (user-customized toolsets preserved) — fixes v0.1→v0.3 upgrades silently missing new tools
- [x] Execution-graph UI: trace viewer shows delegated child executions (clickable); interrupted executions get a purple badge + "Resume from checkpoint"
- [x] 7 new tests (32 total): delegation graph + child wait, depth guard rejection, mailbox injection + consumption, retry trace evidence, recoverInterrupted, checkpoint resume

## Phase 4 — Skills (next)
- skill inheritance + versioning (parent_id, version columns ready)
- permission-aware execution history + performance metrics
- SDK: skills defined as JSON/YAML files, hot-loadable

## Phase 5 — Memory
- pgvector driver for true semantic retrieval (port unchanged)
- entity extraction from memories, entity↔memory links
- working-memory context windows per execution (schema ready)

## Phase 6 — Projects/Sprints
- dependency-aware sprint planning by the Planner agent
- blockers, milestones, progress rollups, deadline automations

## Phase 7 — Flows
- React Flow visual builder (nodes: trigger/agent/skill/tool/condition/branch/loop/wait/approval)
- flow_versions + flow_executions tables (schema pending)
- long-running flow state with checkpoint/resume

## Phase 8 — Automations
- cron + event + webhook triggers subscribing to the existing bus
- automation inspector UI, per-automation autonomy policy

## Phase 9 — Integrations
- IntegrationPort adapters: GitHub, Gmail, Slack first (OAuth, secret vault)
- integration events → flows → agents; per-integration permission scopes

## Phase 10 — Notifications + Widgets
- browser push/desktop channels, configurable dashboard grid, widget SDK

## Phase 11 — Knowledge graph
- full Links Explorer (force graph), derived links from co-occurrence, graph queries in universal search

## Phase 12 — Desktop/Mobile
- local agent runtime + OS notifications; mobile supervision app (approvals, briefings, emergency stop)
