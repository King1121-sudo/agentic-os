# Agentic OS — Architecture (Kernel v0.1)

## 1. Ports & adapters (the replaceability spine)

Every subsystem talks to a PORT; concrete drivers are adapters selected at boot:

```
DataPort ──────── SqliteDataPort (node:sqlite, default)   │ PgDataPort (pg, DATABASE_URL)
BrokerPort ────── InProcessBroker (default)                │ RedisBroker (REDIS_URL)
ModelProviderPort BuiltinProvider │ OpenAICompatProvider │ OllamaProvider │ (future: Gemini…)
IntegrationPort  (registry; adapters Phase 9)
```

All SQL is dialect-neutral: TEXT/INTEGER/REAL columns, app-side UUIDs, `?`-params (Pg adapter converts to `$n`). One schema (`sql/001_kernel.sql`) runs on both. This is why Postgres/pgvector/Redis swap in without touching any subsystem.

## 2. Kernel execution pipeline (§5 of the spec)

```
EVENT (command.executed)
 → CONTEXT RESOLVER (project/task resolution)
 → MEMORY RETRIEVAL (composite-scored top-k)
 → PLANNER (Model Gateway, capability='planning')
 → STEP LOOP: tool | skill | model steps
     tool step → SECURITY GATE (toolset ∩ scopes ∩ schema ∩ risk×autonomy)
              → [APPROVAL GATE (suspends execution, notification, timeout)]
              → execute → record tool_execution → audit → event
 → RESULT (final synthesis generation)
 → MEMORY UPDATE (episodic)
 → EVENT (agent.completed) → NOTIFICATION
```

Every hop appends to the execution's `trace[]` (persisted between steps — checkpointed), and emits both an event (activity stream) and audit entry (immutable trail). The Activity panel renders the trace + plan + audit + generations of any execution — the "why did the agent do that" view.

## 3. Subsystems

**Model Gateway** — `ModelRouter.candidates()`: healthy providers → agent preference first → capability match → priority desc, cost asc. `generate()` tries up to 4 candidates, marking failed providers down and falling through; every attempt is a Generation row (tokens, latency, cost, status). Builtin provider is the never-fails floor: a deterministic planner (keyword-driven step selection with natural-language arg extraction) and reasoner/summarizer. Honest label: it's not an LLM; it makes the kernel fully operable with zero external deps, and real LLMs slot in via env config.

**Memory Engine** — 7 types (working/episodic/semantic/preference/project/procedural/entity). Retrieval score = 0.40·keyword + 0.25·vector + 0.15·recency(e^{-age/30d}) + 0.15·importance + 0.05·access. Duplicate content reinforces instead of duplicating; decay erodes importance of unaccessed memories after 14 idle days; consolidation merges cos>0.92 same-type pairs. **Phase 5:** the vector leg delegates to a `VectorIndexPort` — local cosine (default) or pgvector ANN (auto-activates on Postgres with the `vector` extension; HNSW index + BEFORE-INSERT trigger keeps `memories_vec` in sync from the TEXT embedding). Embeddings come from a pluggable provider (deterministic 128-d hash default, OpenAI-compat `/embeddings` via `OPENAI_EMBED_*`). Every write extracts person/org/tech/url/topic entities into the graph (`memory_entities` + `memory -[mentions]-> entity` links); every execution opens a working-memory window (pinned retrieved memories + bounded step facts) that feeds the synthesis prompt and the trace viewer.

**Agent Runtime** — fire-and-forget async state machine per execution with an in-process control map (pause/stop/approval waiters). States: idle→thinking→planning→executing→(waiting/paused/approval_required)→completed/failed/cancelled. Approval gate suspends the promise; the API decision resolves it (or the timeout fails the step safely → observation, not crash).

**Tool Runtime** — 12 tools with schema/risk/scope. `evaluateGate`: toolset membership → scope → required-arg check → risk×autonomy policy (L-table). High-risk always human-approved (even L4). File tools jailed to `data/sandbox/` with path-escape checks.

**Skills** — ordered steps of {tool|model|skill} — composable, versioned, categorized (skill tree). Executed inside agent executions via the runtime's step machinery.

**Event Bus** — 23 event types; every emit persists to `events` + publishes over BrokerPort (SSE taps it; future flows/automations subscribe the same way).

**Knowledge graph** — `entities` (kind:id → title/subtitle/meta, auto-synced by every store write) + `links` (typed relations). Links Explorer traverses both directions.

## 4. Data model

28 tables: users, sessions, model_providers, models, agents, executions, generations, memories, entities, links, projects, sprints, tasks, task_dependencies, skills, tool_executions, events, audit_logs, approvals, notifications, schema_migrations (+ indexes). See `sql/001_kernel.sql`.

## 5. Extension points (§37)

- Add a provider → implement `ModelProviderPort`, register in `main.ts`
- Add a tool → `ToolDef` in `modules/tools.ts` (risk/scope/schema required)
- Add an integration → implement `IntegrationPort`, register into the registry
- Add a flow/automation (Phases 7–8) → subscribe to BrokerPort channels; events are already typed
- Replace memory retrieval → swap `similarity()` internals for pgvector; callers unchanged

## 6. Honest boundaries (what v0.1 does NOT do)

- No Gmail/GitHub/Slack adapters yet — the port + registry exist, the command center says so explicitly rather than faking a connection
- No cron automations or visual flow builder yet (Phases 8/7) — the event bus and step machinery they build on are live
- `shell.run` executes through bash with a timeout in the sandbox dir, but is disabled by default and approval-gated; it is a dev convenience, not a hardened sandbox
- SSE requires the sticky local broker for cross-process fan-out (Redis broker when scaling)
- Multi-user RBAC is single-user + sessions in v0.1; the permission scopes vocabulary is in place
