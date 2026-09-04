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
structure because the kernel's complexity lives in the runtime/gateway/memory
subsystems, not the HTTP layer, and Fastify keeps the dependency surface tiny
(one process, zero native deps in default mode). The API is a thin, typed
boundary over the same service layer a NestJS wrapper would expose — swapping
the HTTP shell later is mechanical if needed.

## Phase 2 — Model Gateway hardening (next)
- token accounting per provider, cost tables for hosted models
- Gemini provider adapter
- streaming SSE responses to the UI, generation cancellation
- capability-based routing tests against real providers

## Phase 3 — Agent runtime maturation
- subagent delegation (execution graph, parent_execution_id already in schema)
- retry/backoff policy per step, checkpoint resume across process restarts
- agent-to-agent messaging, planner→specialist routing in the command center

## Phase 4 — Skills
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
