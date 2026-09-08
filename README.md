# Agentic OS — v0.12.0

An **AI-native operating environment**: agents, memory, tools, skills, flows, automations, integrations, a knowledge graph, and a living JARVIS command center as one coherent system. **Phases 1–12 complete and verified.**

```
User (text / voice / UI / automation / webhook)
        │
   COMMAND CENTER  ────────────── MOBILE SUPERVISOR (/mobile)
        │                                │  (briefings · one-tap approvals · emergency stop)
        ▼                                ▼
   AGENT RUNTIME  (plan → steps → approvals → result)
        │
   ┌────┴─────────┬───────────────┬──────────────┐
   MEMORY       PLANNER        INTEGRATIONS    FLOWS / AUTOMATIONS
   (vector +     (model          (GitHub/        (visual graphs,
    working)      gateway)        Gmail/Slack)    cron/event/webhook)
        │
        ▼
   TOOLS / SKILLS / MODELS  →  EVENTS (SSE) → AUDIT → NOTIFICATIONS → KNOWLEDGE GRAPH
```

## Quick start

```bash
npm install                 # workspaces: contracts → api → web
npm run dev:api             # kernel on :4000 (SQLite + in-process broker by default)
npm run dev:web             # OS shell on :3000
```

Open http://localhost:3000, log in (`admin` / `admin123` — change via `.env`), press **⌘K** (or tap the JARVIS core) and try:

- `good morning` — daily briefing
- `create a task to fix the login bug in project Aurora` — real task via agent → planner → tool → memory
- `remember that I prefer concise summaries` — preference memory
- `what do you know about my preferences` — scored retrieval
- `create a sprint for the Agentic OS project` — dependency-chained sprint plan
- `what's connected to pgvector` — knowledge-graph query

With no `.env` the kernel runs on the **builtin deterministic provider** (zero network, zero keys) — the full pipeline still executes. Add real models via `.env` (see `.env.example`) and the router picks them up with automatic fallback.

## The JARVIS cockpit & mobile supervisor

- **`/`** — the living command center: central core state (standby / thinking / executing / approval required), orbiting agent satellites, context field, realtime event rail, attention panel, and the command surface (text + search + optional voice via browser SpeechRecognition). The Phase 10 widget dashboard remains via the **▼ Classic dashboard** toggle.
- **`/mobile`** — installable phone-first supervisor PWA: briefing, stat tiles, one-tap approvals, agent roster, and a two-step **EMERGENCY STOP** that cancels every running execution/flow and pauses automations.

## Subsystems (all live, phases 1–12)

| Subsystem | Where |
|---|---|
| Kernel pipeline (context → memory → plan → steps → result) | `apps/api/src/modules/runtime.ts` |
| Event bus (84 typed events, SSE) | `apps/api/src/kernel/bus.ts` |
| Model gateway (builtin / OpenAI-compat / Ollama / Gemini; streaming, fallback, cost ledger) | `apps/api/src/gateway/*` |
| Memory engine (7 types, composite scoring, decay, consolidation, entity extraction) | `modules/memory.ts`, `entities.ts` |
| Vector search (local cosine default; pgvector ANN on Postgres) | `modules/vector.ts` |
| Working memory (per-execution windows) | `modules/workingmemory.ts` |
| Skills (inheritance, versioning, hot-load JSON/YAML) | `modules/skills.ts` + `skills/` |
| Projects / sprints / dependencies / milestones / rollups | `modules/projects.ts` |
| Flows (visual graph engine, checkpoints, pause/resume/recovery) | `modules/flows.ts` |
| Automations (cron / event / webhook triggers, policy gates) | `modules/automations-engine.ts` |
| **Integration platform** (7 providers, central OAuth + PKCE + refresh, capability grants, webhook gateway, sync engine, vault) | `modules/integrations/` — see `docs/integrations.md` |
| Notifications (in-app + Web Push RFC 8291/8292, VAPID) | `modules/notify.ts` |
| Knowledge graph (co-occurrence derivation, snapshot, neighborhoods) | `modules/graph.ts` |
| Mobile supervision (briefing API, emergency stop) | `modules/supervision.ts` |
| Web shell (Next.js, JARVIS cockpit, ⌘K palette, SSE) | `apps/web` |

## Testing

```bash
npm test          # 149 tests across 12 files: kernel, gateway, memory, security,
                  # skills, projects, flows, automations, integrations, push, graph, supervision
```

## Production

```bash
npm run build                     # contracts + api (tsc) + web (next build)
docker compose up --build         # Postgres (pgvector) + Redis + api + web
```

Single image builds both apps; `docker-compose.yml` wires the Postgres/Redis drivers. Set `DATABASE_URL`/`REDIS_URL` to swap drivers without code changes (ports/adapters).

## Configuration

Every knob is env-driven (`apps/api/src/config.ts`); defaults are zero-dependency local drivers. Full list in `.env.example` — highlights: `PORT`, `DATABASE_URL`, `REDIS_URL`, `OPENAI_*` / `OLLAMA_BASE_URL` / `GEMINI_*` (models), `OPENAI_EMBED_*` (embeddings), `INTEGRATION_VAULT_KEY`, `VAPID_*` (browser push), `AGENTIC_*` (runtime policy), `SEED_ADMIN_*`.

## Security model

- Sessions: scrypt-hashed passwords, HttpOnly cookies; **login throttling** (5 failures → 10-min lockout)
- Per-agent toolsets + permission scopes; risk-classed tools (high-risk always human-approved, even L4)
- Sandboxed filesystem tools (`data/sandbox/`, path-escape checked); `shell.run` off by default and approval-gated
- Secret vault (AES-256-GCM, 0600 key file); OAuth state rows are one-time + CSRF-checked; webhook tokens compared in constant time
- Every tool call audited; denials are observations, not crashes; no secrets in API responses, logs, or audit entries

## Honest boundaries

- The builtin provider is deterministic, not an LLM — it keeps the OS fully operable with zero deps; real models slot in via env
- Login throttling and the automation ticker are in-process (single-node); use Redis when scaling horizontally
- Voice input is browser SpeechRecognition (Chrome/Edge); no speech synthesis is shipped
- `http.fetch` is approval-gated by autonomy policy but does not restrict private-IP ranges — intended for trusted-agent use, not multi-tenant hosting

Full design: `ARCHITECTURE.md` · Phase history: `ROADMAP.md` + `CHANGELOG.md`
