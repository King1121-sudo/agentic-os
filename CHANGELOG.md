# Changelog

## 0.4.0 — Skills (Phase 4, 2026-09-05)

### Added
- **Skill inheritance**: `parent` field (name reference) resolves to an execution chain — parent steps run first, own steps last, cycle-guarded. Live-verified: `Research & Save Extended` → chain `Extended → Research & Save` executed as 3 steps.
- **Versioning**: any changed skill definition snapshots the superseded version into `skill_versions` (migration 003) and bumps patch semver (`0.1.0 → 0.1.1`). Version History panel lists superseded definitions. Diff-aware: reloading unchanged files bumps nothing.
- **Hot-load SDK**: skills are JSON/YAML files in `skills/` (4 shipped: daily-briefing, research-save + args_from, research-save-extended YAML demonstrating inheritance, web-artifact). Boot auto-loads; `POST /api/skills/reload` re-scans; two-pass load makes parent resolution independent of file order; per-file errors don't fail the batch. Tiny zero-dep YAML subset parser.
- **Permission-aware execution**: before any step runs, the agent's toolset is checked against every tool in the resolved chain; missing tools → skill.denied, recorded in history + metrics. Live-verified: Monitor denied `http.fetch, memory.write` for the Extended chain; metrics show ⊘.
- **Performance metrics**: `skill_executions` records every run (status/version/latency); `GET /api/skills/metrics` aggregates runs, ✓/✗/⊘, success %, avg latency; Skills panel shows per-skill stats inline.
- **Direct skill execution**: `POST /api/agents/:id/execute {skill: name}` and command-center phrasing ("run the Research & Save Extended skill on https://…") bypass the planner with a skill-first plan.
- **`args_from` step templating**: `{args_from: "url"|"query"|"input"}` pulls values from the execution input — the inherited http.fetch step now fetches the real URL from the command (live-verified, status 200).

### Fixed
- YAML step parsing lost continuation keys (only the first key of each step survived) — parser now handles indented sub-keys.
- Loader order dependence: single-pass load left `parent_id` null when a child file was read before its parent; two-pass load resolves deterministically.

## 0.3.0 — Agent runtime maturation (Phase 3, 2026-09-05)

### Added
- **Subagent delegation**: `agent.delegate` tool spawns a child execution (own plan, tools, gates) with `parent_execution_id` + `delegated_to` link in the knowledge graph; the parent awaits the child's terminal state and records its result as an observation. Depth guard (`AGENTIC_MAX_DELEGATION_DEPTH`, default 2) blocks runaway chains; `stop()` cascades to in-flight children.
- **Agent-to-agent messaging**: `agent.message` tool writes to a persistent mailbox (`agent_messages` table, migration 002); pending messages are consumed and injected into the receiving agent's next planning context; Agents panel shows the mailbox feed.
- **Checkpoint resume**: new `interrupted` execution status. At boot, `recoverInterrupted()` marks executions orphaned by a crash (their pending approvals time out, agents release to idle). `POST /api/executions/:id/resume` (or the UI button) continues from the persisted plan/trace/observations at the current step — at-least-once semantics (a step mid-flight at crash time re-runs; approval-gated steps re-request approval). Verified live: crash while approval-gated → reboot → interrupted → resume → re-gate → approve → completed, task created.
- **Per-step retry/backoff**: failed steps retry up to `AGENTIC_STEP_RETRIES` (default 1) with exponential backoff (250ms·2ⁿ); user-initiated cancellations never retry; retry attempts appear in the trace.
- **Specialist routing in the command center**: explicit ("ask the coder to…") and keyword-based routing (research→Researcher, code→Coder, status→Monitor, plan→Planner) with Hermes as fallback; delegation phrasing ("delegate to X: …") intentionally routes to Hermes so the supervisor builds a real delegation graph.
- **Execution-graph UI**: trace viewer lists delegated child executions with status dots (click to open); interrupted executions get a purple badge and a "Resume from checkpoint" button.
- `GET /api/executions/:id/children` (delegation graph) and `GET /api/agent-messages` (mailbox log).

### Fixed
- **Seed upgrade path**: existing built-in agents were never refreshed on boot, so upgrades silently missed new tools (v0.1 Hermes had no `agent.delegate` — delegation was gate-denied in the live E2E). Uncustomized built-ins now refresh to the current seed definition; user-customized toolsets are preserved.
- Specialist detection no longer hijacks delegation commands (bare agent-name match removed).

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
