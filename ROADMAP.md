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

## Phase 4 — Skills ✅ (v0.4.0)

- [x] Inheritance: skills declare `parent` (by name) in files or via the API; execution resolves the chain (parent steps first, own last) with a cycle guard; trace shows `Skill X vN executed (k steps, chain: X → Parent)`
- [x] Versioning: every changed definition snapshots the prior version into `skill_versions` and bumps patch semver; diff-aware loader — unchanged files are no-ops (verified: reload reports bumped=0); two-pass load so parent resolution never depends on file order
- [x] Hot-load SDK: skill definitions live in `skills/` as JSON or YAML (tiny built-in YAML subset parser, zero deps); boot auto-loads, `POST /api/skills/reload` re-scans; per-file errors reported without failing the batch
- [x] Permission-aware execution: chain-wide tool precheck before running any step (agent must hold every tool the chain needs); denials recorded in `skill_executions` + `skill.denied` event + UI
- [x] Performance metrics: `skill_executions` history (status, latency, version) → `GET /api/skills/metrics` (runs, ✓/✗/⊘, success %, avg latency); Skills panel renders tree + metrics + version history
- [x] Direct skill execution: `POST /api/agents/:id/execute {skill}` and command-center phrasing ("run the X skill on <url>") build a skill-first plan without the LLM planner
- [x] `args_from` templating: skill steps can pull `url`/`query`/`input` from the execution input (verified: inherited http.fetch step fetched the real URL)
- [x] 9 new tests (41 total): chain order + cycle guard + tool union, version bump/dedup + snapshot, YAML parsing + name validation, two-pass diff-aware loading, per-file errors, metrics aggregation

## Phase 5 — Memory (next)
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
