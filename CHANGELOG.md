# Changelog

## 0.2.0 — Model Gateway hardening (Phase 2, 2026-09-05)

### Added
- `generateStream()` on `ModelProviderPort` + all four adapters: openai-compat (SSE `stream_options.include_usage`), ollama (ndjson), gemini (`streamGenerateContent?alt=sse`), builtin (deterministic word-cadence so the stream path is testable with zero deps)
- Gemini provider: `v1beta` generateContent + streaming, model auto-discovery with optional `GEMINI_MODELS` filter, valid-body health probe
- Router `generateStream()`: same candidate/fallback semantics as `generate()`; abort marks the generation `cancelled` (new status) instead of failed
- Live streaming to the UI: runtime batches token deltas into volatile `agent.token` SSE events (≥24 chars / 120ms, never persisted); Activity trace viewer shows a streaming panel (phase label + live text + ■ Stop) while the execution runs
- Cancellation: Stop now aborts in-flight generations immediately via per-execution AbortController registry; execution finalizes as `cancelled | Stopped by user`
- Cost registry (`gateway/costs.ts`): published list prices for OpenAI/Gemini/Anthropic/DeepSeek/Llama/Qwen/Mixtral models, seeded into the models table at registration (ordered patterns; known prices never zeroed out)
- `GET /api/models/usage` — per-model accounting from the generations ledger (counts, ✓/✗/⊘, tokens in/out, cost, avg latency) + Settings → Model Usage table
- 8 new tests (25 total): stream reconstruction, abort→cancelled ledger, cost lookup ordering, usage aggregation, gemini request shape and health

### Fixed
- Gemini health probe sent an invalid empty body (would false-negative valid keys)
- Stopped executions recorded `failed | aborted`; now correctly `cancelled | Stopped by user` (abort detection in the runtime drive loop + outer catch)

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
