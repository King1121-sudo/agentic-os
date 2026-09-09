# PRODUCT TRUTH — Agentic OS

## What this is
An AI-native operating system: one environment where autonomous agents, memory, skills, tools, workflows (flows), automations, projects, tasks, sprints, documents, integrations and notifications work together. A Fastify kernel + SQLite/Postgres data plane exposes ~90 typed HTTP endpoints; a Next.js web app is the operator console.

## Who it is for
A single technical operator (builder/supervisor) who drives the OS via natural-language commands, monitors live agent activity, and intervenes through approvals. Not a team SaaS. Not a marketing product.

## The job
1. **Operate:** supervise live agents, executions, flow runs, automations, integrations — intervene via pause/resume/stop, approvals, emergency stop.
2. **Command:** natural-language command surface (⌘K everywhere; JARVIS input on Home) routing through one converged command architecture (text, voice, UI actions, automations → same kernel path `/api/command`).
3. **Understand:** activity stream, execution traces (plan, working memory, tool calls, generations), knowledge graph, project rollups.

## Product principles (non-negotiable)
- **Real state only.** Every status, pulse, number, and glow is backed by actual kernel/DB/SSE state. No fake activity, no synthetic numbers, no invented capabilities.
- **Nothing from Phases 1–13 is removed.** Functionality is preserved or enhanced; API contracts unchanged.
- **One OS, not many apps.** Every page is a subsystem of a single environment sharing one shell, one design language, one command surface.
- **Calm by default, loud on attention.** When nothing needs the operator, the environment is quiet. Approvals/failures escalate visually.
- **Command-first.** Natural language is a first-class way to operate the OS, keyboard a close second (⌘K, /, number keys).
- **Honest boundaries.** Unconfigured providers, unsupported browsers, empty corpora render honest empty/error states, never fake ones.

## Surfaces
- Desktop console (primary): shell + 13 subsystem pages + login.
- Mobile supervisor PWA (`/mobile`): briefing, approvals, emergency stop. Deliberately standalone, safe-area aware.
- Voice: same command routing as text (Web Speech API today; architecture ready for deeper voice-first interaction).

## Reference world
JARVIS-style HUD: deep dark field, architectural framing, cyan/electric-blue system information, controlled orange for attention/action, concentric circular geometry around a central core, technical linework, layered surfaces, subtle glow, precision instrumentation. Futuristic but calm, restrained, information-dense, fully operable. Never cheesy sci-fi, never unreadable.
