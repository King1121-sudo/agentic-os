# JARVIS OS Visual Architecture Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. If that skill is unavailable in the runtime, use `feature-development` + `test-driven-development` and keep the same task boundaries.

**Goal:** Redesign the Agentic OS web experience into a JARVIS-style living AI command center while preserving every Phase 1–11 capability and API contract.

**Architecture:** Keep the existing Fastify kernel and Next.js routes intact. Build a new visual shell and dashboard composition around a central `JARVIS Core`, spatial/context panels, realtime agent/event presence, voice/command input, HUD-style graph/telemetry, and responsive workspaces. The redesign should be an experience layer over the current kernel, not a rewrite of the backend.

**Tech Stack:** Existing monorepo: Next.js 15 + React 19 frontend, plain global CSS today, Fastify + TypeScript API, SQLite/Postgres data adapter, Redis/local broker, SSE event stream, shared `@agentic/contracts`, Vitest. For new UI work: add Tailwind only if the implementation pass chooses to adopt the `ui-skills` standard; otherwise keep the current CSS-token system and migrate incrementally. Use `motion/react` only for semantic JS animation and respect `prefers-reduced-motion`.

---

## 1. Current System Inspection Summary

### 1.1 Repository / stack

Inspected project root: `C:/Users/Gurjinder Singh/agentic-os`.

- Root version: `0.11.0`
- Latest commits at inspection:
  - `92ab056` — web shell header now shows v0.11
  - `1e057e2` — Phases 5–11 committed
- Frontend: `apps/web`
  - Next.js 15, React 19, TypeScript
  - `apps/web/src/app/*` App Router pages
  - `apps/web/src/components/Shell.tsx` persistent shell, rail, topbar, command palette, notifications, approvals, SSE event ticker
  - `apps/web/src/lib/api.ts` fetch helpers, polling hook, SSE hook
  - `apps/web/src/app/globals.css` tokenized dark/light theme and UI primitives
- Backend: `apps/api`
  - Fastify API, TypeScript
  - `apps/api/src/main.ts` composition root
  - `apps/api/src/app.ts` HTTP route boundary
  - `apps/api/src/modules/*` kernel modules
- Shared contracts: `packages/contracts/src/index.ts`
- Database/migrations: `sql/*.sql`

### 1.2 Existing frontend surfaces to preserve

Inspected frontend files and responsibilities:

| Route/File | Current responsibility | Must preserve |
|---|---|---|
| `apps/web/src/components/Shell.tsx` | Rail nav, topbar, v0.11 crumb, LIVE status, notifications/approvals flyout, command palette, footer event ticker | Keyboard command flow, auth logout, notifications, approvals, event stream |
| `apps/web/src/app/page.tsx` | Dashboard widgets, editable layout, health, agents, tasks, projects, notifications, activity, approvals, automations, push opt-in, quick actions | Phase 10 dashboard layout + widgets + push subscription |
| `apps/web/src/app/links/page.tsx` | Phase 11 canvas force graph, kind filters, derive button, focus/neighborhood panel | Graph APIs, graph derivation, focus behavior, pan/zoom |
| `apps/web/src/app/activity/page.tsx` | Kernel event stream + execution trace viewer, children, audit, generations, working memory, live token stream | Phase 2 streaming, Phase 3 pause/resume/stop/delegation, Phase 5 working memory |
| `apps/web/src/app/agents/page.tsx` | Agent registry, direct execution, mailbox, create agent | Agent lifecycle, mailbox, autonomy, tool/memory policy |
| `apps/web/src/app/agents/[id]/page.tsx` | Agent detail and execution history | Direct agent drill-down |
| `apps/web/src/app/memory/page.tsx` | Memory list/search/create/maintenance/vector/entity backfill | Phase 5 memory engine |
| `apps/web/src/app/projects/page.tsx` | Project list/create | Phase 6 project workspaces |
| `apps/web/src/app/projects/[id]/page.tsx` | Tasks, sprints, milestones, dependencies/rollup links | Phase 6 tasks/sprints/dependencies/milestones |
| `apps/web/src/app/flows/page.tsx` | Flow builder, node palette, runs, trace | Phase 7 flows |
| `apps/web/src/app/automations/page.tsx` | Automation inspector/create/toggle/test/runs | Phase 8 automations |
| `apps/web/src/app/integrations/page.tsx` | Integrations, token/OAuth connect/disconnect/read/events | Phase 9 integrations |
| `apps/web/src/app/skills/page.tsx` | Skills/tools/metrics/versions/reload | Phase 4 skill engine |
| `apps/web/src/app/settings/page.tsx` | Auth/me, health, providers, models, usage, autonomy levels | Model gateway + system settings |
| `apps/web/src/app/login/page.tsx` | Session login | Existing auth |

### 1.3 Existing backend surfaces to preserve

Inspected API route map and modules. Existing authenticated boundary already covers all required kernel capabilities:

- Auth: `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`
- Health/system: `/api/health`
- Agents/executions/messages: `/api/agents`, `/api/agents/:id/execute`, `/api/executions`, pause/resume/stop, children, `/api/agent-messages`
- Models/tools/skills: `/api/models`, `/api/models/usage`, `/api/tools`, `/api/skills`, metrics, versions, reload, execute
- Memory: `/api/memory`, search, maintain, vector stats, entity backfill, entity memory drill-down, working memory windows/facts
- Projects/tasks/sprints/milestones/dependencies/rollup/deadline sweep
- Flows: `/api/flows`, versions, runs, flow-run controls
- Automations/webhooks: `/api/automations`, runs, toggle, test, `/api/webhooks/:id`
- Integrations: connect/disconnect/read/create/search/events/OAuth
- Links/entities: `/api/links`, `/api/entities`
- Approvals/notifications/widgets/push: `/api/approvals`, `/api/notifications`, `/api/dashboard/layout`, VAPID/push routes
- Audit/events/search/graph/stream/command/dashboard

Backend modules inspected:

- `runtime.ts`: execution pipeline, memory retrieval, planner, steps, approvals, pause/resume/stop, token stream, delegation graph
- `graph.ts`: Phase 11 graph derivation/snapshot/neighborhood/search expansion
- `flows.ts`: long-running visual graph execution with checkpoint/resume
- `automations-engine.ts`: cron/event/webhook triggers → flow/agent dispatch
- `notify.ts`: notifications, web push, dashboard layout registry
- `memory.ts`, `entities.ts`, `workingmemory.ts`, `vector.ts`: Phase 5 semantic memory stack
- `projects.ts`: tasks/sprints/dependencies/milestones/deadline rollup
- `integrations-service.ts`, `vault.ts`: Phase 9 adapters + secrets
- `store.ts`: persistence helpers and domain record parsing

### 1.4 Existing realtime model

Current frontend uses:

- `usePoll()` for dashboard/route data refresh
- `useEventStream()` for `/api/stream` SSE
- Dedicated `EventSource('/api/stream')` in Activity trace viewer for live token deltas

This is enough to power JARVIS presence without backend rewrites, but a thin client-side event store should centralize SSE fan-out so multiple components do not open duplicate streams.

---

## 2. Reference Video Visual Analysis

The attached reference video was inspected through extracted keyframes/contact sheet. The video language is highly relevant to a JARVIS OS redesign.

### 2.1 Visual language

- Dark, cinematic green-black background with soft vignetting and spatial depth.
- Central glowing node/core acting as the system focus.
- Radial graph topology: lines radiate from the core into multiple colored semantic nodes.
- Thin HUD strokes, small labels, compact legends, and low-chrome controls.
- Interface feels like a living intelligence map rather than a flat dashboard.
- Color is semantic and restrained:
  - warm gold/white = central core/current focus
  - teal/green = live updates/system signal
  - pink/purple = entity categories or attention nodes
  - amber/orange = gaps/warnings/secondary states
- Text is small, data-dense, and secondary to the graph/spatial relationships.

### 2.2 Composition patterns to borrow

- **Central core first:** primary command state belongs at the center, not in a top-left card.
- **Orbiting entities:** agents, tasks, memories, flows, integrations, and graph nodes can orbit/radiate around the core.
- **Spatial panels:** panels should float/dock around the core and feel contextual, not purely tabular.
- **Timeline rail:** the reference uses a vertical year/time rail; Agentic OS can map this to event time, execution history, or workspace timeline.
- **Legend panel:** semantic filters and counts are compact floating overlays.
- **Bottom command surface:** a small bottom input/command module anchors user intent.
- **Zoomed focus mode:** later frames zoom into individual category nodes with circular scan rings and local metrics.

### 2.3 Motion cues to borrow

- Nodes bloom from the center and settle into graph positions.
- Relationships appear as drawn lines rather than static borders.
- Focus transitions zoom/scale into a selected node neighborhood.
- Radial scan arcs and progress rings indicate active analysis.
- Peripheral points shimmer subtly to signal live data, but should pause off-screen and respect reduced motion.

### 2.4 Design constraints from UI skill

- Animation must convey state; avoid decorative motion that competes with content.
- Animate only transform/opacity; avoid layout/property animation.
- Keep looping animations subtle, pausable, and reduced-motion safe.
- Icon-only buttons need `aria-label`.
- Destructive controls continue to use explicit confirmation patterns when needed.
- Do not make glow the only affordance; pair glow with labels, borders, badges, and focus states.

---

## 3. Product Design Architecture

### 3.1 North Star

Agentic OS becomes a **living AI command center**:

> The user commands a central JARVIS Core. Around it, agents, tasks, memory, events, flows, automations, integrations, approvals, and graph context reorganize spatially based on intent.

### 3.2 Preserve Phases 1–11 as system layers

| Existing phase/capability | JARVIS OS representation |
|---|---|
| Phase 1 kernel/events/tools | Core status, event timeline, telemetry strip |
| Phase 2 model gateway/streaming | Core thinking ring, live token stream, provider telemetry |
| Phase 3 subagents/mailbox/checkpoint | Agent orbit, execution constellations, delegation lanes |
| Phase 4 skills | Skill cards/runes and skill chain overlays |
| Phase 5 memory/vector/entities/working memory | Memory halo, contextual facts, entity clusters |
| Phase 6 projects/sprints/dependencies | Mission panels, task routes, sprint progress arcs |
| Phase 7 flows | Flow corridor / node execution map |
| Phase 8 automations | Autonomous sentinels and trigger radar |
| Phase 9 integrations | External signal sources, adapter status satellites |
| Phase 10 notifications/widgets/push | Alert band, notification pulse, configurable widgets |
| Phase 11 knowledge graph | Main spatial knowledge map / neighborhood focus |

### 3.3 Core layout model

Desktop/wide layout:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ System Strip: workspace · model · health · LIVE · approvals · notifications│
├──────┬──────────────────────────────┬──────────────────────────────┬──────┤
│ Rail │ Context Panel                │ JARVIS Spatial Core           │ Ops  │
│      │ - memory/facts               │ - central core/orb            │ Panel│
│      │ - selected entity            │ - orbiting agent/task nodes   │      │
│      │ - graph neighborhood         │ - active intent               │      │
│      │                              │ - command input/voice         │      │
├──────┴──────────────────────────────┴──────────────────────────────┴──────┤
│ Event/Execution Timeline: latest event · live tokens · running work         │
└────────────────────────────────────────────────────────────────────────────┘
```

Tablet layout:

- Core remains top/center.
- Context/Ops panels become tabbed drawers under the core.
- Rail becomes icon dock.
- Timeline becomes collapsible bottom sheet.

Mobile layout:

- Single-column command cockpit.
- Core at top, command/voice at bottom sticky safe-area.
- Agents/tasks/alerts become horizontal chips and stacked cards.
- Preserve all routes, but each route renders through responsive workspace templates.

### 3.4 Visual layers

1. **Ambient layer** — static dark field, subtle grid/noise, depth vignette.
2. **Spatial graph layer** — canvas/SVG node-link system used by Core + Links Explorer.
3. **Core layer** — central orb/state machine and command input.
4. **Panel layer** — glass/HUD cards for context, operations, status.
5. **Control layer** — approvals, destructive actions, command/voice controls.
6. **Notification layer** — alert pulses/flyouts/toasts.

---

## 4. Proposed Component Hierarchy

### 4.1 Shell-level hierarchy

Create a new shell architecture while preserving `Shell` behavior during migration:

```text
apps/web/src/components/
  Shell.tsx                         existing shell; can wrap/route to new shell later
  jarvis/
    JarvisShell.tsx                 persistent JARVIS cockpit shell
    JarvisRail.tsx                  existing nav, restyled as vertical system rail
    JarvisSystemStrip.tsx           top status: version, LIVE, model, health, approvals
    JarvisWorkspace.tsx             responsive layout grid/drawers
    JarvisFooterTimeline.tsx        live event ticker + execution shortcuts
    JarvisCommandSurface.tsx        command palette + prompt + voice state
    JarvisCore.tsx                  central orb/core state machine
    JarvisCoreCanvas.tsx            central graph/orbit renderer
    JarvisPanel.tsx                 reusable HUD panel primitive
    JarvisPanelHeader.tsx           title, count, filters, actions
    JarvisPresenceRing.tsx          agent presence around the core
    JarvisEventRail.tsx             chronological event rail
    JarvisApprovalBand.tsx          approval-required state/control surface
    JarvisVoiceControl.tsx          microphone/listening/voice transcript shell
    JarvisWorkspaceTabs.tsx         mobile/tablet panel switching
```

### 4.2 Data/provider hierarchy

```text
apps/web/src/lib/
  api.ts                            keep current functions; add non-breaking helpers only
  jarvis-store.tsx                  context/reducer combining health/dashboard/events
  jarvis-selectors.ts               derived UI selectors: active agents, urgent approvals
  jarvis-types.ts                   UI-only view models (no backend schema churn)
```

Provider model:

```text
<JarvisDataProvider>
  - one SSE connection to /api/stream
  - polls dashboard/health/approvals/notifications on existing intervals
  - exposes normalized state + derived selectors
  <JarvisShell>
    <RoutePage />
  </JarvisShell>
</JarvisDataProvider>
```

### 4.3 Page migration hierarchy

Each existing page remains a route and keeps its data/actions. Visual wrapper changes only:

```text
HomePage
  JarvisCockpitDashboard
    JarvisCoreDeck
    AgentPresenceOrbit
    MissionControlPanels
    ExistingWidgetGridCompatibility

LinksPage
  JarvisGraphExplorer
    reuse current /api/graph snapshot/neighbors/derive
    enhance canvas with reference-inspired focus rings/legend/zoom

ActivityPage
  JarvisActivityWorkspace
    EventRail
    ExecutionTracePanel
    LiveTokenPanel
    WorkingMemoryPanel

AgentsPage
  JarvisAgentWorkspace
    AgentOrbitSummary
    AgentRegistryPanel
    MailboxPanel
    DirectExecutionPanel

MemoryPage
  JarvisMemoryWorkspace
    MemoryHaloSummary
    SearchPanel
    EntityBackfillPanel
    MemoryListPanel

ProjectsPage / ProjectDetail
  JarvisMissionWorkspace
    ProjectList/MissionDeck
    TaskBoard
    Sprint/Milestone/Dependency panels

FlowsPage
  JarvisFlowWorkspace
    FlowCanvas/Builder
    RunTracePanel
    NodeInspector

AutomationsPage
  JarvisAutomationWorkspace
    TriggerRadar
    AutomationList
    RunLog

IntegrationsPage
  JarvisSignalWorkspace
    AdapterSatellites
    ConnectPanel
    IntegrationEventFeed

SkillsPage
  JarvisSkillWorkspace
    SkillTree
    ToolRegistry
    Metrics/Versions

SettingsPage
  JarvisSystemWorkspace
    KernelHealth
    ProviderMap
    ModelRegistry
    UsageTelemetry
```

### 4.4 Component primitive rules

- Create reusable HUD primitives before styling individual pages:
  - `JarvisPanel`
  - `JarvisMetric`
  - `JarvisStatusDot`
  - `JarvisCommandButton`
  - `JarvisListItem`
  - `JarvisTimelineItem`
  - `JarvisEmptyState`
- Keep existing `.card`, `.row`, `.badge`, `.trace`, `.ev`, `.grid` available until pages migrate.
- Add ARIA labels to all icon-only rail/action buttons.
- Prefer one accent color per panel; use severity colors only for state.

---

## 5. State Model

### 5.1 Existing backend state remains source of truth

Do not introduce a parallel domain model. Keep using:

- `AgentRecord`, `ExecutionRecord`, `MemoryRecord`, `TaskRecord`, `ProjectRecord`, `OsEvent`, etc. from `@agentic/contracts`.
- Existing API endpoints.
- Existing SSE events.

### 5.2 New frontend-only JARVIS UI state

Add a UI state reducer, not backend schema changes for the first pass:

```ts
type JarvisMode =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'executing'
  | 'approval_required'
  | 'reviewing'
  | 'error';

type JarvisWorkspaceId =
  | 'home' | 'agents' | 'memory' | 'projects' | 'skills'
  | 'flows' | 'automations' | 'integrations' | 'activity'
  | 'links' | 'settings';

type JarvisFocus =
  | { kind: 'none' }
  | { kind: 'agent'; id: string }
  | { kind: 'execution'; id: string }
  | { kind: 'memory'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'graph-node'; id: string }
  | { kind: 'flow-run'; id: string }
  | { kind: 'automation'; id: string }
  | { kind: 'integration'; id: string };
```

Derived state examples:

- `jarvisMode`
  - `approval_required` if pending approvals exist
  - `executing` if any agent/execution/flow-run is active
  - `thinking` when recent `agent.thinking`/`agent.token` event exists
  - `error` if health/db/broker fails or recent failed events dominate
  - otherwise `idle`
- `activeAgents`
  - agents where status is not `idle`
- `attentionItems`
  - approvals, urgent notifications, failed executions, missed milestones
- `coreGraphNodes`
  - agents + active tasks + focused graph neighborhood + current command context

### 5.3 Event ingestion model

Current problem: multiple components open independent `EventSource` connections.

Plan:

- Keep `useEventStream()` for compatibility.
- Introduce `JarvisDataProvider` with one `/api/stream` subscription.
- Provider updates:
  - `events[]` rolling buffer
  - `lastEvent`
  - `agentTokenStreams[executionId]`
  - `activeExecutions`
  - `attentionPulse` timestamp for animation cues
- Existing pages can adopt provider gradually.

### 5.4 Command/voice state

Frontend-only first pass:

```ts
type VoiceState =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'permission_needed' }
  | { status: 'listening'; interim: string; final: string }
  | { status: 'submitting'; text: string }
  | { status: 'error'; message: string };
```

- Use browser SpeechRecognition where available.
- Voice submits to existing `POST /api/command`.
- No backend voice endpoint required initially.
- Text command palette remains primary and accessible fallback.

---

## 6. Interaction Model

### 6.1 Command-first interaction

Existing command palette remains, but visually becomes the JARVIS command surface:

- `⌘K` / `/` opens command/search as today.
- Central command bar is always available in Home/JARVIS cockpit.
- User can type natural language, choose a local route command, or switch to search.
- Submission still uses `POST /api/command`.
- Execution results still route to `/activity?exec=...`.

### 6.2 Voice interaction

Voice should be additive and non-destructive:

1. User clicks/taps microphone or presses optional shortcut.
2. Core enters `listening` mode.
3. Interim transcript appears as a ring/caption around command surface.
4. User confirms or presses Enter to submit.
5. Existing `/api/command` handles execution.
6. Core transitions to `thinking`/`executing` based on events.

Safety:

- Never auto-submit destructive voice commands without confirmation.
- Approval gates stay exactly as backend requires.
- Voice errors appear near the mic/control.
- Paste/text command always works.

### 6.3 Core focus interaction

- Click/tap JARVIS Core: opens command surface.
- Hover/focus core: shows current OS state and next available action.
- Click agent node: focuses agent panel and route shortcut.
- Click task/project node: opens contextual panel or route.
- Click graph node: uses existing `/api/graph/neighbors?id=` and displays neighborhood.
- Click active execution: opens trace panel or `/activity?exec=`.

### 6.4 Panel behavior

Panel states:

- `ambient`: compact telemetry/chips only.
- `peek`: expanded header + top few items.
- `focused`: full interactive panel with controls.
- `drawer`: mobile/tablet bottom sheet.

Rules:

- Panels should dock around the core on desktop.
- A focused panel can expand, but must not hide approvals or command input.
- Approval controls always appear in a high-priority band.
- Existing route pages still offer full tabular/details view.

### 6.5 Realtime presence

Agent presence should map backend statuses:

| Backend status | Visual state |
|---|---|
| `idle` | dim satellite |
| `thinking` / `planning` | slow pulse, orbit ring active |
| `executing` | active blue/cyan trail |
| `waiting` / `paused` | amber pause marker |
| `approval_required` | amber attention ring + approval band |
| `completed` | green completion flash then settle |
| `failed` | red/error marker and event rail link |
| `cancelled` | gray/offline marker |

### 6.6 Graph/knowledge interaction

The existing Links Explorer already matches the reference video structurally. Enhancement path:

- Keep current force simulation and endpoints.
- Restyle canvas to dark teal HUD field.
- Add central/focused node glow ring and radial scan arc.
- Move legend into a floating panel like the video.
- Add left-side temporal/event rail optional overlay.
- Add bottom command surface for graph queries.
- Add focus zoom behavior using transform/scale only.

---

## 7. Animation Principles

### 7.1 Semantic animation only

Every animation must answer one of:

- Is the OS alive/connected?
- Is JARVIS listening?
- Is JARVIS thinking/planning?
- Which agents are active?
- Which item requires attention?
- What changed recently?
- What is selected/focused?

### 7.2 Core animation states

| State | Animation |
|---|---|
| idle | slow breathing opacity on core ring |
| listening | waveform/radial ring expands subtly from mic input/transcript activity |
| thinking | rotating thin scan arc + small particle orbit |
| executing | directed trails from core to active agent/task nodes |
| approval_required | amber ring pulse + approval band enters |
| reviewing | selected panel/card scales/fades into focus |
| error | static red outline/shake avoided; use red state ring + message |

### 7.3 Performance constraints

- Animate `transform` and `opacity` only.
- Avoid large blur/backdrop-filter surfaces; static translucent backgrounds are acceptable.
- Pause looping animation when off-screen.
- Use CSS `@media (prefers-reduced-motion: reduce)` to disable/pause loops.
- Keep canvas graph drawing scoped and throttled.
- Avoid using glow as the only clickable/focus indicator.

### 7.4 Timing

- Interaction feedback: <= 150–200ms.
- Panel entrance: 120–180ms ease-out.
- Core breathing loop: 3–5s, low opacity delta.
- Thinking scan arc: 2–4s loop, low visual weight.
- Event pulse: single 400–700ms opacity/scale decay.

---

## 8. Implementation Plan

This section is intentionally implementation-ready, but no implementation has been performed.

### Task 1: Preserve baseline and create JARVIS design tokens

**Objective:** Add non-breaking visual tokens/primitives without changing route behavior.

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Create: `apps/web/src/components/jarvis/JarvisPanel.tsx`
- Create: `apps/web/src/components/jarvis/JarvisStatusDot.tsx`
- Create: `apps/web/src/components/jarvis/JarvisMetric.tsx`

**Steps:**
1. Verify baseline: `npm test` from repo root; expected `143 passed`.
2. Add CSS variables under existing `:root`:
   - `--jarvis-bg-deep`
   - `--jarvis-field`
   - `--jarvis-core`
   - `--jarvis-cyan`
   - `--jarvis-green`
   - `--jarvis-amber`
   - `--jarvis-danger`
   - `--jarvis-panel`
   - `--jarvis-line`
3. Add reusable panel/status/metric primitives using existing CSS conventions.
4. Add reduced-motion CSS guard.
5. Run `npm run build -w apps/web` if available; otherwise run root `npm test` and manual route checks.

**Acceptance:** Existing pages render unchanged except shared primitive availability; no route/API changes.

### Task 2: Centralize frontend realtime state

**Objective:** Add one shared JARVIS data provider so the shell/core/panels can react to the OS without duplicate SSE connections.

**Files:**
- Create: `apps/web/src/lib/jarvis-types.ts`
- Create: `apps/web/src/lib/jarvis-store.tsx`
- Create: `apps/web/src/lib/jarvis-selectors.ts`
- Modify: `apps/web/src/app/layout.tsx` or new shell wrapper integration point

**Steps:**
1. Define UI-only types: `JarvisMode`, `JarvisFocus`, `VoiceState`, `JarvisState`.
2. Implement provider using existing `api`, `post`, and one `EventSource('/api/stream')`.
3. Poll existing endpoints: `/api/dashboard`, `/api/health`, `/api/approvals?status=pending`, `/api/notifications?status=unread`.
4. Store rolling `events[]`, `tokenStreams`, `connected`, `lastEventAt`.
5. Create selectors for `mode`, `activeAgents`, `attentionItems`, `coreNodes`.
6. Keep `usePoll` and existing page code working.

**Acceptance:** No visual change required yet; provider can be mounted without breaking login/auth redirects.

### Task 3: Build `JarvisCore`

**Objective:** Create the central living AI core component driven by current OS state.

**Files:**
- Create: `apps/web/src/components/jarvis/JarvisCore.tsx`
- Create: `apps/web/src/components/jarvis/JarvisCoreCanvas.tsx`
- Create/modify CSS in `apps/web/src/app/globals.css`

**Steps:**
1. Render central orb/ring with accessible label.
2. Display current state text: idle/listening/thinking/executing/approval/error.
3. Map event/agent state to core visual state via selectors.
4. Add low-cost CSS animation for idle/thinking/approval.
5. Respect reduced motion.
6. Add click handler hook to open command surface.

**Acceptance:** Core can render inside existing dashboard with no dependency on new backend endpoints.

### Task 4: Build `JarvisCommandSurface` with voice mode

**Objective:** Upgrade the command palette/input into a central command + optional voice surface while preserving `POST /api/command` behavior.

**Files:**
- Create: `apps/web/src/components/jarvis/JarvisCommandSurface.tsx`
- Optionally refactor from: `apps/web/src/components/Shell.tsx` `CommandPalette`
- Modify: `apps/web/src/lib/jarvis-store.tsx`

**Steps:**
1. Extract reusable command/search logic from current `CommandPalette` without changing API behavior.
2. Add text input with Enter submit to `/api/command`.
3. Add search mode using existing `/api/search?q=`.
4. Add browser SpeechRecognition support behind feature detection.
5. Show transcript and confirmation before submit.
6. Route execution results to `/activity?exec=...` as today.

**Acceptance:** Keyboard command flow, search flow, and route commands still work; voice is optional/fallback-safe.

### Task 5: Build `JarvisShell`

**Objective:** Replace the visual shell around existing pages while keeping navigation, auth, approvals, notifications, and event ticker behavior.

**Files:**
- Create: `apps/web/src/components/jarvis/JarvisShell.tsx`
- Create: `apps/web/src/components/jarvis/JarvisRail.tsx`
- Create: `apps/web/src/components/jarvis/JarvisSystemStrip.tsx`
- Create: `apps/web/src/components/jarvis/JarvisFooterTimeline.tsx`
- Modify: `apps/web/src/components/Shell.tsx` only to delegate or gradually wrap

**Steps:**
1. Move existing NAV metadata into reusable export.
2. Preserve exact route list and keyboard behavior.
3. Restyle rail as HUD dock with labels/tooltips and `aria-label`s.
4. Move version/LIVE/notifications/approvals into `JarvisSystemStrip`.
5. Keep approval approve/deny calls unchanged.
6. Add bottom timeline based on provider `events[]`.

**Acceptance:** All routes still accessible; logout works; pending approvals can be approved/denied; notifications flyout remains functional.

### Task 6: Redesign Home as the JARVIS cockpit

**Objective:** Transform `apps/web/src/app/page.tsx` into the main command center while preserving widgets and dashboard layout.

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/components/jarvis/JarvisCockpitDashboard.tsx`
- Create: `apps/web/src/components/jarvis/JarvisPresenceRing.tsx`
- Create: `apps/web/src/components/jarvis/JarvisContextPanel.tsx`
- Create: `apps/web/src/components/jarvis/JarvisOpsPanel.tsx`

**Steps:**
1. Keep existing `WidgetCard` registry and dashboard layout editing.
2. Add cockpit layout: left context, center core, right operations, bottom event timeline.
3. Render `AgentPresenceWidget` data as `JarvisPresenceRing` around the core.
4. Render approvals/notifications/automations as attention panels.
5. Provide a compatibility area for current widgets to avoid losing Phase 10 functionality.
6. Add responsive CSS for tablet/mobile.

**Acceptance:** Existing widgets still exist, layout persistence still works, quick actions still call `/api/command`, push opt-in still works.

### Task 7: Upgrade Links Explorer to reference-inspired graph HUD

**Objective:** Enhance the existing Phase 11 graph experience to visually match the reference while preserving graph behavior.

**Files:**
- Modify: `apps/web/src/app/links/page.tsx`
- Optionally create: `apps/web/src/components/jarvis/JarvisGraphExplorer.tsx`
- Optionally create: `apps/web/src/components/jarvis/JarvisGraphLegend.tsx`

**Steps:**
1. Keep calls to `/api/graph`, `/api/graph/neighbors`, `/api/graph/derive` unchanged.
2. Restyle canvas background to dark teal spatial field.
3. Add floating legend panel, bottom graph command/search surface, selected-node radial focus ring.
4. Add focus zoom or pan-to-node behavior using transform/math only.
5. Preserve kind filter chips, derive, freeze, clear focus, hover, click, pan, zoom.
6. Ensure canvas remains keyboard/accessible via side panel list where possible.

**Acceptance:** Graph still reports nodes/edges/derived counts and passes existing Phase 11 tests.

### Task 8: Migrate Activity into mission timeline view

**Objective:** Make executions feel like live missions without changing runtime controls.

**Files:**
- Modify: `apps/web/src/app/activity/page.tsx`
- Create: `apps/web/src/components/jarvis/JarvisExecutionTrace.tsx`
- Create: `apps/web/src/components/jarvis/JarvisEventRail.tsx`

**Steps:**
1. Preserve `/api/events?limit=150` polling.
2. Preserve `TraceViewer` APIs: executions, audit, generations, children, working memory, token stream.
3. Render event list as vertical HUD timeline.
4. Render selected execution as focused mission panel.
5. Preserve pause/resume/stop controls.
6. Keep live token stream and working-memory window visible.

**Acceptance:** Running execution can still be stopped/paused/resumed; trace/audit/generation/children/working memory remain visible.

### Task 9: Migrate Agents/Memory/Projects/Flows/Automations/Integrations/Skills/Settings incrementally

**Objective:** Apply the JARVIS visual language to every route without changing backend semantics.

**Files:**
- Modify existing route files under `apps/web/src/app/*/page.tsx`
- Extract repeated UI into `apps/web/src/components/jarvis/*`

**Steps:**
1. Agents: agent registry becomes presence grid/orbit + mailbox panel.
2. Memory: memory list/search becomes memory halo + entity/context side panel.
3. Projects: project/task/sprint views become mission boards.
4. Flows: flow builder becomes node-corridor HUD while preserving current flow graph logic.
5. Automations: trigger radar + run ledger.
6. Integrations: adapter satellites + external event feed.
7. Skills: skill tree and tool registry as capability matrix.
8. Settings: kernel/provider/model telemetry as system console.

**Acceptance:** All existing forms/buttons still hit the same endpoints and support the same flows.

### Task 10: Testing and validation pass

**Objective:** Prove Phases 1–11 survived the visual redesign.

**Files:**
- Existing tests: `apps/api/src/tests/*.test.ts`
- Add frontend tests only if test infrastructure is introduced; otherwise use scripted/manual route validation.

**Required validation:**
1. `npm test` from repo root → expected `143 passed` or higher.
2. `npm run build -w packages/contracts`.
3. `npm run build -w apps/api`.
4. `npm run build -w apps/web`.
5. Live smoke while servers run:
   - `/api/health` reports `version: 0.11.0`, db up, broker up.
   - `/` loads JARVIS cockpit.
   - `/links` loads graph with current node/edge counts.
   - `/activity` loads events and trace viewer.
   - Command palette submits to `/api/command`.
   - Approvals approve/deny still call `/api/approvals/:id/decision`.
   - Graph derive remains idempotent.

---

## 9. Risks / Tradeoffs

### 9.1 Risk: visual rewrite breaks working Phase 1–11 flows

Mitigation:

- Do not change backend routes or contracts unless a specific new feature requires it.
- Migrate shell first, then one route at a time.
- Keep existing components available until equivalent JARVIS components are verified.

### 9.2 Risk: cinematic HUD reduces usability

Mitigation:

- Use HUD visuals as structure/state, not decoration.
- Keep readable text contrast.
- Keep tables/lists for dense details.
- Provide focus panels and keyboard-accessible controls.

### 9.3 Risk: too much animation hurts performance/accessibility

Mitigation:

- Animate only transform/opacity.
- Respect reduced motion.
- Pause loops off-screen.
- Avoid large blur/backdrop surfaces.
- Keep graph canvas bounded.

### 9.4 Risk: adding Tailwind creates migration churn

Mitigation:

- Decide in Task 1 whether to introduce Tailwind.
- If introduced, add it as a foundation commit and use it only for new JARVIS primitives first.
- If not introduced, document the deviation and keep the existing tokenized CSS path.

### 9.5 Risk: voice APIs vary by browser

Mitigation:

- Treat voice as progressive enhancement.
- Keep text command surface first-class.
- No command should require voice.

---

## 10. Open Questions Before Implementation

1. Should the JARVIS redesign become the default shell immediately, or ship behind a feature flag such as `NEXT_PUBLIC_JARVIS_UI=1` for comparison?
2. Should voice interaction be local browser SpeechRecognition only, or should a backend speech pipeline be planned later?
3. Should Tailwind be introduced to align with UI skill standards, or should the current CSS-token system remain to minimize churn?
4. Should the central graph on Home use the Phase 11 graph data directly, or a lighter synthesized graph of active agents/tasks/events?
5. Should Phase 12 Desktop/Mobile be combined with this redesign or implemented after the JARVIS shell foundation?

---

## 11. Recommended Execution Order

1. Add tokens/primitives and centralized JARVIS data provider.
2. Build `JarvisCore` + `JarvisCommandSurface` in isolation.
3. Introduce `JarvisShell` while preserving all current nav/notifications/approvals.
4. Redesign Home as cockpit with compatibility widget area.
5. Upgrade Links Explorer visuals because it already resembles the reference.
6. Migrate Activity, then Agents, then remaining workspaces.
7. Run full backend suite and frontend/API smoke validation after each major route migration.
8. Commit after each task group.

---

## 12. Final Design Direction

The target experience should feel like this:

> A dark, spatial AI command environment centered on a living JARVIS Core. The core indicates whether the OS is idle, listening, thinking, executing, or waiting for approval. Agents, tasks, memories, flows, automations, integrations, and graph entities appear as contextual satellites and HUD panels. The user can type or speak commands; the OS responds through live events, traceable execution panels, approvals, notifications, and graph context. All current Agentic OS capabilities remain intact — the redesign changes how the system is perceived and commanded, not what the kernel can do.
