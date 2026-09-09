# Surface brief — apps/web (whole console)

- **Scope:** the entire web console (shell + all 13 subsystem pages + login + mobile supervisor). Mode: **Operate**. Not Persuade, not Experience — the visitor completes supervision/command tasks; expression lives in precise details.
- **Audience/job:** a single technical operator supervising a live AI OS — issuing commands, watching agent state, approving actions, debugging traces, wiring automations.
- **Action/task:** orient instantly (what needs attention NOW), command (natural language, keyboard), drill into entities (agent → execution → trace → memory), act (approve/pause/stop).
- **Proof/content:** all real kernel data — SSE events, agent records, executions, flows, graph snapshots, rollups, integration catalogs. Zero synthetic data.
- **Constraints:** preserve every Phase 1–13 API interaction and behavior; keep @xyflow flows canvas, canvas force-graph, mobile supervisor standalone; WCAG AA contrast; reduced-motion; no new heavy deps.

## Direction contract

**THESIS:** The console is a command environment around a living core — one instrument panel where every subsystem reads as an organ of the same OS. It refuses the generic SaaS dashboard arrangement (uniform card grids, equal-weight modules, chrome-over-content) and the split-personality app (JARVIS cockpit bolted beside an untouched admin panel).

**OWN-WORLD:** Deep space-field background with a fixed architectural grid; surfaces are translucent dark panels over the field with hairline cyan structure lines, corner ticks, and eyebrow micro-labels; type is Inter for interface + JetBrains Mono for identifiers/data (the two existing faces, re-registered to a tightened scale); color budget: cyan for system/information (largest allowed accent), orange reserved for attention/action (approvals, warnings, action-required), green = success/live, red = failure/danger, purple = memory/graph. Concentric circular geometry appears ONLY around the JARVIS Core and as status rings — never as decoration elsewhere.

**STORY:** The operator lands on a command center that answers "what is the OS doing and what needs me" in one viewport: core state at center-left, priority attention queue, live agents orbit, realtime event rail, command surface pinned within reach. Selecting any entity opens a contextual inspector panel instead of a page jump. The environment visibly reacts to real events (agent starts, approvals land, flows complete) via the existing SSE stream — calm when quiet, escalating when action is required.

**FIRST VIEWPORT (Home):** Topbar (system name, LIVE indicator, clock, ⌘K trigger, notifications). Below: a cockpit grid — left bank (attention queue + upcoming deadlines), center (JARVIS Core readout with real agent satellites + universal command surface immediately beneath), right bank (agent presence list + sentinels). A HUD strip (kernel version, DB, broker, events/min, uptime) anchors the bottom of the viewport. Primary action = the command input; secondary = attention items' inline approve/deny.

**FORM:** Established-world extension (the JARVIS cockpit world already committed in code from the 2026-09-06 pass; this pass extends it from Home to the whole console). Chosen position: unify the existing two visual systems (kernel CSS + jarvis CSS) into one token layer so every page inherits the HUD language. Seed key: n/a (brief-pinned world, no roll required).

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
