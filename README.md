# Agentic OS — Kernel v0.1

An **AI-native operating environment**: agents, memory, skills, tools, events, projects, generations and a live workspace shell as one coherent system.

This is Milestone 1 (the kernel) of a 12-phase build (see `ROADMAP.md`). It is **real, running software** — no fake integrations, no placeholder features pretending to work.

```
User → Command Center → Agent → Planner → Model Gateway → Tools → Result
                                  ↓                 ↑
                              Memory ←────────── Events → SSE → Live UI
                                  ↓                 ↓
                              Generation records · Audit trail · Notifications
```

## Quick start

```bash
npm install                 # installs workspaces (contracts → api → web)
npm run dev:api             # boots kernel on :4000 (SQLite + in-process broker by default)
npm run dev:web             # boots OS shell on :3000
```

Open http://localhost:3000, log in (`admin` / `admin123`), press **⌘K** and try:

- `good morning` — daily briefing
- `create a task to fix the login bug in project Aurora` — a real task gets created (agent → planner → tool → memory → event pipeline)
- `remember that I prefer concise summaries` — writes a preference memory
- `what do you know about my preferences` — scored memory retrieval
- `list all tasks`
- `create a sprint for the Agentic OS project` — sprint + 6 template tasks

With no `.env` the kernel runs on the **builtin deterministic provider** (zero network, zero keys) — the full pipeline still executes: planner → gateway → tools → memory → generations → events → live UI. Add real models via `.env` (see below) and the router picks them up with automatic fallback.

## Real AI models

Copy `.env.example` → `.env`:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1     # or Groq, OpenRouter, Together…
OPENAI_API_KEY=sk-…
OPENAI_MODELS=gpt-4o-mini,gpt-4o
OLLAMA_BASE_URL=http://127.0.0.1:11434        # local models
```

The Model Router health-probes providers at boot + every 60s, picks models by capability/preference/priority/cost, and falls back automatically when one fails. The builtin provider stays as the last-resort fallback so the OS never hard-fails.

## Architecture (what ships in v0.1)

| Subsystem | Status | Where |
|---|---|---|
| OS shell (Next.js, dark/light, ⌘K palette, SSE live feed) | ✅ live | `apps/web` |
| Kernel pipeline (context → memory → plan → execute → result → memory → event → notify) | ✅ live | `modules/runtime.ts` |
| Event bus (23 event types, persisted + broadcast) | ✅ live | `kernel/bus.ts` |
| Model Gateway (4 provider adapters incl. Gemini, streaming + cancellation, health + capability routing, fallback) | ✅ live | `gateway/*` |
| Usage & cost accounting (list-price registry, per-model ledger, Settings → Model Usage) | ✅ live | `gateway/costs.ts`, `/api/models/usage` |
| Agent Runtime (states, pause/resume/stop, approval gates, tracing, checkpointing) | ✅ live | `modules/runtime.ts` |
| Memory Engine (7 types, composite scoring, dedup, decay, consolidation) | ✅ live | `modules/memory.ts` |
| Tool Runtime (12 tools, risk classes, permission scopes, sandboxed files) | ✅ live | `modules/tools.ts` |
| Skills (registry, composable steps, skill tree UI) | ✅ live | store + UI |
| Tasks / Projects / Sprints | ✅ live | store + UI |
| Links / entity graph + explorer | ✅ live | `links` panel |
| Generations ledger (tokens, latency, cost, parent chains) | ✅ live | gateway + UI |
| Audit logs (immutable trail per execution) | ✅ live | every subsystem |
| Approvals (human-in-the-loop, L0–L4 autonomy) | ✅ live | runtime + topbar |
| Notifications (in-app) | ✅ live | runtime + UI |
| Universal search (tasks, projects, memory, agents, skills, generations) | ✅ live | command palette |
| Integration SDK (port + registry) | ✅ boundary | `modules/integrations.ts` — adapters are Phase 9 |
| Automations (cron/webhook/event triggers) | ⬜ Phase 8 | event bus it subscribes to is live |
| Flows (visual workflow builder) | ⬜ Phase 7 | plan/steps machinery it will reuse is live |
| pgvector semantic memory, Redis broker | ⬜ config | ports exist; drivers activate via env |

Full design doc: `ARCHITECTURE.md`. Phase plan: `ROADMAP.md`.

## API surface (all zod-validated)

```
POST /api/auth/login|logout        GET /api/auth/me
GET  /api/health                   GET /api/dashboard
GET  /api/agents                   POST /api/agents
POST /api/agents/:id/execute
POST /api/executions/:id/pause|resume|stop
GET  /api/executions[/:id]
GET  /api/models | /api/tools | /api/skills        POST /api/skills[/:id/execute]
GET|POST /api/memory               GET /api/memory/search
POST /api/memory/maintain          DELETE /api/memory/:id
GET|POST /api/projects             GET /api/projects/:id
GET|POST|PATCH /api/tasks[/:id]
GET|POST /api/sprints
GET|POST /api/links                GET /api/entities
GET  /api/approvals                POST /api/approvals/:id/decision
GET  /api/notifications            POST /api/notifications/:id/read
GET  /api/generations              GET /api/events   GET /api/audit  GET /api/search
GET  /api/stream (SSE)             POST /api/command (Command Center)
```

## Testing

```bash
npm test        # vitest: memory scoring/decay/consolidation, planner extraction,
                # security gate, router fallback, adapter, auth hashing
```

## Configuration

Every knob is env-driven (`apps/api/src/config.ts`); with nothing set the kernel boots on zero-dependency local drivers:

| Env | Default | Effect |
|---|---|---|
| `PORT` | 4000 | API port |
| `DATABASE_URL` | SQLite file | Postgres driver when set |
| `REDIS_URL` | — | Redis broker when set |
| `OPENAI_BASE_URL/KEY/MODELS` | — | OpenAI-compatible provider |
| `OLLAMA_BASE_URL` | — | local models |
| `AGENTIC_ALLOW_SHELL` | 0 | enables `shell.run` (always approval-gated regardless) |
| `APPROVAL_TIMEOUT_S` | 300 | approval gate timeout |

## Security model

- Sessions (scrypt-hashed passwords, HttpOnly cookies, 14-day expiry)
- Per-agent toolset + permission scopes (least privilege)
- Risk-classed tools: low (free at L1) / medium (impact-gated) / high (always approval, even L4)
- Sandboxed filesystem tools (`data/sandbox/`, path-escape checked)
- Every tool call audited; denials are observations, not crashes
- `shell.run` disabled unless explicitly enabled AND human-approved
