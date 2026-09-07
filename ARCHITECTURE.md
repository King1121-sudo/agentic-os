# Agentic OS — Architecture (v0.12.0)

## 1. Ports & adapters (the replaceability spine)

Every subsystem talks to a PORT; concrete drivers are adapters selected at boot:

```
DataPort ──────── SqliteDataPort (node:sqlite, default) │ PgDataPort (pg, DATABASE_URL)
BrokerPort ────── InProcessBroker (default)              │ RedisBroker (REDIS_URL)
ModelProviderPort BuiltinProvider │ OpenAICompatProvider │ OllamaProvider │ GeminiProvider
VectorIndexPort ─ LocalVectorIndex (hash-128 cosine)    │ PgVectorIndex (pgvector ANN)
IntegrationPort  (registry + GitHub/Gmail/Slack adapters)
```

All SQL is dialect-neutral: TEXT/INTEGER/REAL columns, app-side UUIDs, `?`-params (the Pg adapter converts to `$n`). Ten migrations (`sql/001…010`, tracked via `schema_migrations`) run identically on both drivers; fresh-DB boot applies all ten idempotently (41 tables).

## 2. Kernel execution pipeline

```
EVENT (command.executed / automation / webhook / flow node)
 → CONTEXT RESOLVER (project/task + agent mailbox)
 → MEMORY RETRIEVAL (composite-scored top-k) + WORKING-MEMORY WINDOW (Phase 5)
 → PLANNER (Model Gateway, capability='planning')
 → STEP LOOP: tool | skill | model steps
     tool step → SECURITY GATE (toolset ∩ scopes ∩ schema ∩ risk×autonomy)
              → [APPROVAL GATE (suspends execution, notification, timeout)]
              → execute → tool_execution row → audit → event
 → RESULT (final streamed synthesis)
 → MEMORY UPDATE (episodic) → EVENT → NOTIFICATION
```

Every hop appends to the execution's `trace[]` (persisted between steps — checkpointed), emits an event, and writes an audit row. Executions are resumable from checkpoints; delegated children form an execution graph (`parent_execution_id`, depth-guarded).

## 3. Command convergence

Every entry point funnels into the same architecture — there is no parallel voice/automation agent system:

```
TEXT (⌘K palette / JARVIS surface) ─┐
VOICE (browser SpeechRecognition →  ├─→ POST /api/command → COMMAND CENTER
        same transcript as text)    │       (routeCommand: intents → agent
UI actions (widget buttons) ────────┤        executions via Hermes + tools)
AUTOMATION (cron/event/webhook) ────┤
INTEGRATION events / flow nodes ────┘
                                              ↓
                                        AGENT RUNTIME
```

Voice is purely an input modality: the transcript fills the same command input and submits `POST /api/command` after human review — approvals, autonomy gates, and the full runtime pipeline apply identically.

## 4. Subsystems

**Model Gateway** — `ModelRouter.candidates()`: healthy providers → agent preference → capability → priority desc, cost asc; tries up to 4 candidates with automatic fallback; every attempt is a Generation row (tokens, latency, cost). Streaming (`generateStream`) feeds a throttled SSE token pump with AbortController cancellation. The builtin provider is the never-fails floor (deterministic planner/reasoner — honest label: not an LLM).

**Memory** — 7 types; retrieval score = 0.40·keyword + 0.25·vector + 0.15·recency + 0.15·importance + 0.05·access. Duplicates reinforce; decay erodes idle importance; consolidation merges cos>0.92 pairs. Writes extract person/org/tech/url/topic entities into the graph; executions open working-memory windows (pinned memories + bounded step facts) that feed synthesis and are visible in the trace viewer. Vector leg delegates to `VectorIndexPort` (pgvector ANN auto-activates on Postgres with the `vector` extension; embeddings pluggable via `OPENAI_EMBED_*`).

**Knowledge graph** — `entities` (auto-synced on every store write) + `links` (explicit kernel relations + derived `co_occurs_with` from shared memories; idempotent derivation at boot and on demand). Snapshot/neighborhood APIs feed the Links Explorer and universal search.

**Agent Runtime** — fire-and-forget async state machine per execution with in-process control (pause/stop/approval waiters, abort controllers). States: idle→thinking→planning→executing→(waiting/paused/approval_required)→completed/failed/cancelled. Approvals suspend a promise; decisions or timeouts resolve them. Crash recovery marks orphans `interrupted` (resumable); per-step retry with backoff.

**Flows** — directed node graphs (trigger/agent/skill/tool/condition/branch/loop/wait/approval) walked from the trigger with a checkpoint after every node (context-variable store, template resolution, cycle-safe validation). Same control semantics as the runtime: pause/stop/recover.

**Automations** — cron (5-field parser with catch-up), event-substring, and webhook (constant-time token) triggers dispatching flows or agent executions, gated by per-automation autonomy policy; every fire lands in `automation_runs`. Deadline sweeps emit overdue/due-soon/missed-milestone alerts through a dedupe ledger.

**Integrations** — GitHub/Gmail/Slack adapters behind `IntegrationPort`; token or OAuth flows (one-time CSRF state rows); credentials sealed in the vault (AES-256-GCM, 0600 key file). External events bridge onto the bus as `integration.event`.

**Notifications** — in-app rows + browser Web Push (RFC 8291/8292, zero deps): VAPID P-256 keys, ES256 JWT, aes128gcm payloads; per-user channel prefs (priority threshold + categories) gate the fan-out; gone endpoints pruned.

**Supervision (Phase 12)** — `GET /api/mobile/briefing` (status/agents/tasks/approvals/events/counts) and `POST /api/emergency-stop`: cancels every non-terminal execution (children cascade), cancels flow runs, pauses automations; audit + `system.emergency_stop` event + urgent notification; idempotent.

**Realtime** — `GET /api/stream` (SSE): replays the last 50 events, then subscribes to the broker channel; volatile token events bypass the cursor; 15s pings; clean unsubscribe on close. The UI auto-reconnects via EventSource.

## 5. Data model

41 tables across `sql/001–010`: users, sessions, model_providers, models, agents, executions, generations, memories, memory_entities, entities, links, projects, sprints, tasks, task_dependencies, milestones, deadline_alerts, skills, skill_versions, tool_executions, events, audit_logs, approvals, notifications, notification_prefs, push_subscriptions, dashboard_layouts, agent_messages, flows, flow_runs, automations, automation_runs, integrations, oauth_states, integration_events, working_memory, schema_migrations (+ indexes).

## 6. Web application

Next.js App Router, single global token stylesheet (dark/light), shared Shell (rail nav, ⌘K command palette, approvals band, notifications, SSE ticker). The home page is the **JARVIS cockpit** (central core state machine, agent satellites, context/event/attention panels, command surface with optional voice) with the Phase 10 configurable widget grid preserved behind a toggle. `/mobile` is a standalone installable supervisor PWA. All pages render live API data; the Links Explorer is a zero-dependency canvas force simulation.

## 7. Extension points

- Add a provider → implement `ModelProviderPort`, register in `main.ts`
- Add a tool → `ToolDef` in `modules/tools.ts` (risk/scope/schema required)
- Add an integration → implement `ServiceAdapter`, register in `IntegrationService`
- Add a widget → `WIDGET_REGISTRY` in `modules/notify.ts` + renderer in the home page
- Swap drivers → set `DATABASE_URL` / `REDIS_URL`; no code changes

## 8. Operational boundaries (honest limits)

- Login throttle + automation ticker are in-process — single-node designs; Redis broker when scaling
- `http.fetch` does not block private-IP ranges (trusted-agent use, not multi-tenant hosting)
- Voice input requires a browser with SpeechRecognition; there is no speech synthesis
- SSE fan-out beyond one process requires the Redis broker
- No FK constraints in SQL (app-enforced relationships) — deliberate for the dual-dialect constraint
