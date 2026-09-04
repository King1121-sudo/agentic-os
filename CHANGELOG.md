# Changelog

## 0.1.0 — Kernel (2026-09-05)

Initial milestone. See ARCHITECTURE.md for the full map.

### Added
- Ports & adapters: DataPort (SQLite default / Postgres via DATABASE_URL), BrokerPort (in-process / Redis), ModelProviderPort (builtin / openai-compat / ollama)
- Kernel pipeline: context → memory retrieval → planner → gated tool/skill/model steps → synthesis → episodic memory write → events → notifications; per-step trace persistence
- Model Gateway: capability routing, agent preference, priority/cost ordering, health probing (boot + 60s), 4-candidate fallback, generations ledger
- Builtin deterministic provider: keyword-driven planner with natural-language argument extraction; keeps the OS runnable with zero external dependencies
- Agent Runtime: 10 lifecycle states, pause/resume/stop controls, human approval gate with timeout, 5 seeded agents (Hermes/Planner/Coder/Researcher/Monitor)
- Memory Engine: 7 memory types, composite retrieval scoring, dedup-reinforcement, decay, consolidation, maintenance endpoint
- Tool Runtime: 12 tools with risk classes + permission scopes; sandboxed file tools; approval-gated shell
- Skills: composable step graphs, skill tree UI, 3 seeded skills
- Tasks/Projects/Sprints + sprint template command
- Knowledge graph: entity registry (auto-synced), typed links, Links Explorer
- Event bus (23 types) + audit logs + realtime SSE activity stream
- Command center: briefings, agent status, memory queries, sprint creation, NL task creation routed through the agent pipeline
- OS shell: 8 panels, ⌘K palette (command + universal search), dark/light theme, live presence, approval inbox, execution trace viewer with plan/audit/generations
- Auth: scrypt + HttpOnly sessions; tests: vitest suite covering memory, planner, gate, router, adapter, auth
