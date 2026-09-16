# Changelog

## 0.18.0 — Route modules (2026-09-16)

`apps/api/src/app.ts` was 1347 lines holding 118 routes for thirteen different
subsystems — the file every change had to touch. It is now a 58-line composition
root; the routes live in `routes/*.ts`, one module per subsystem.

### Changed
- **`app.ts` split into 13 route modules** (`apps/api/src/routes/`): `auth`,
  `agents`, `memory`, `projects`, `flows`, `automations`, `integrations`,
  `graph`, `approvals`, `notifications`, `telemetry`, `command`, `supervision`.
  Largest module is 223 lines; `app.ts` is 58.
- **Route bodies moved verbatim** — no rewriting, no "while I'm here" edits. Each
  module destructures the deps it needs from a shared `RouteContext`
  (`routes/context.ts`), so a body is byte-identical to what it was inline. That
  is what makes the parity check below meaningful.
- `ApiDeps` is now an alias of `RouteContext`; `buildApi` registers the modules
  in order. Shared helpers (`getCookie`, `SESSION_COOKIE`/`SESSION_DAYS`,
  `scopesForTools`, `safeParse`) moved into `routes/context.ts`.
- Adding or removing a subsystem is now a one-line change in the composition root.

### Added
- **`scripts/smoke.sh`** (+ `npm run smoke`) — a live HTTP smoke test against a
  real running API: the auth guard, every route module, the five command-center
  branches, and the SSE stream. The vitest suite drives the app in-process via
  `app.inject()`, so this covers what only breaks over a real socket.

### Verified
- **Route parity: 118 routes before, 118 after — the route sets diff IDENTICAL**
  (compared against `git show HEAD:apps/api/src/app.ts`).
- **`npm test` → 189/189** · `npm run lint` → 0 errors · `npm run typecheck` → 0
  errors (api + api tests + web).
- **Live smoke: 39/39** against a booted API on a real port — health, the 401
  guard, login/session, all 13 modules, all five command branches, SSE handshake.

## 0.17.0 — Verification gate (2026-09-16)

The repo had no linter and no CI, which is how a multi-user authorization gap
could ship unnoticed. This adds the gate, then pays down what it found.

### Added
- **ESLint 9 flat config** (`eslint.config.mjs`) covering the API, contracts and
  the Next.js app, with `typescript-eslint` and `eslint-plugin-react-hooks`.
  Deliberate relaxations are documented inline with reasons, not silently
  disabled.
- **A ratchet, not a wish list.** `npm run lint` passes `--max-warnings=884` —
  the exact warning count when the gate landed. New warnings fail the build;
  existing debt does not. The number only ever goes down.
- **GitHub Actions CI** (`.github/workflows/ci.yml`): `npm ci` → lint →
  typecheck → test → build on every push to `master`/`main` and every PR, with
  `--max-warnings` making lint a real gate.
- **`tsconfig.test.json`** for the API, wired into `npm run typecheck`. Test
  files were excluded from `tsconfig.json` so the build never emits them — but
  that also meant a type error inside a test was invisible until the test ran.
- Scripts: `lint`, `lint:fix`, `typecheck`, `verify`.

### Fixed (found by the new gate)
- **Dead code — 52 unused bindings** removed. Two were worth more than tidying:
  - `gateway/router.ts`: `const modelCount = p.kind === 'builtin' ? modelIds.length : modelIds.length;` — **both branches identical**, so the value could never differ. Removed.
  - `app.ts` `/api/health`: a provider-status local computed on every request and never returned (the response uses a separate DB query instead).
- **`phase11.test.ts`**: `expect(ids).not.toContain(expect.anything && undefined)` — the argument always evaluated to `undefined`, so the assertion tested nothing. Replaced with a real check that every graph ref is a `"<kind>:<slug>"` string.
- **`phase12.test.ts`**: `flowEngine.getRun?.(...)` called a method `FlowEngine` does not have, so the `??` fallback dynamic-import ran on every invocation. Now calls the module's `getRun` directly.
- **Test type errors (9, then 11)** — invisible before because tests were
  untypechecked. Root causes fixed rather than annotated over:
  `waitForRun` was typed `Promise<any>`, which made every downstream callback
  implicitly `any`; typing it `Promise<FlowRunRecord>` removed three annotations
  and surfaced two genuine `context` shape errors that were then fixed properly.
- Unnecessary regex escapes (`[:\-]`, `[.\/\\]`) — no behaviour change.

### Notes
- `@typescript-eslint/no-require-imports` is **off** for the API: it compiles to
  CommonJS, and every `require()` there lazy-loads an *optional* dependency
  (`redis`, `pg`, `node:sqlite`, `child_process`, `dotenv`) so the kernel still
  boots with zero drivers installed. The rule is ESM-oriented.
- React Compiler advisories from `react-hooks` v7 (11) are `warn`, not `error`:
  they flag real patterns (`setState` synchronously in an effect, `Date.now()`
  during render, ref access in a render body) but every fix changes component
  behaviour and the web app has no UI test coverage to catch a regression. They
  stay visible in every lint run.

### Verified
- `npm run lint` → **0 errors**, 884 warnings (= the ceiling) · `npm run
  typecheck` → 0 errors (api + api tests + web) · `npm test` → **189/189** ·
  `npm run build` → contracts + api green; `apps/web` compiles and generates
  15/15 pages (its final Turbopack cache-cleanup step is blocked by this
  environment's bulk-delete guard — a sandbox artifact, not a build failure).

## 0.16.0 — Authorization & repository hygiene (2026-09-16)

Closes a multi-user data-isolation gap: several routes exposed or controlled
other users' records. Also purges a 246 MB browser profile from git and
re-aligns the documentation, which had drifted three versions behind.

### Security
- **Owner-scoped executions** (`modules/authz.ts`, `app.ts`): `GET /api/executions`
  no longer returns every user's executions (inputs, plans, traces, results).
  `GET /api/executions/:id`, `GET …/children`, and `POST …/pause|resume|stop` now
  require ownership — previously any authenticated user could read, pause or stop
  another user's running execution.
- **Owner-scoped working memory**: `GET /api/executions/:id/working-memory` and
  `POST …/facts` (pinned memories + step facts) were readable and writable by any
  authenticated user.
- **Owner-scoped approvals**: `GET /api/approvals` returned the global queue, and
  `POST /api/approvals/:id/decision` let any user approve a high-risk tool call
  (e.g. `shell.run`) on someone else's execution. The check now lives inside
  `AgentRuntime.resolveApproval`, so every caller is covered, not just the route.
- **Owner-scoped generations**: `GET /api/generations` (and its `execution_id`
  filter) leaked model inputs/outputs; now joined through `executions`.
- **Owner-scoped flow runs**: `GET /api/flow-runs/:id` and `POST …/pause|resume|stop`,
  plus `GET /api/flows/:id/runs`, now respect `flow_runs.user_id`.
- **Per-user dashboard counts** and **universal search**: `/api/dashboard` counts
  and `/api/search` generation hits are now scoped; search no longer surfaces
  another user's model output.
- **Policy**: a non-owner receives `404`, never `403` — a 403 would confirm the
  record exists. Ownerless rows (`NULL`/empty owner: seeded data, and rows written
  by an automation or tool with no user in context) stay shared, preserving the
  pre-existing behaviour for system rows. Full model: `docs/authorization.md`.

### Added
- `modules/authz.ts` — `ownerOf` / `isOwnedBy` / `requireOwned` and the shared
  `NOT_FOUND` body.
- `tests/authz.test.ts` — 19 tests over two real login sessions asserting the
  non-owner gets 404 **and that the record was not mutated** (a denial that
  partially applies is still a failure). Mutation-verified: disabling the guards
  fails 11 of the 19.

### Changed
- `store.listExecutions`, `store.listApprovals` and `flows.listRuns` take an
  options object with an optional `user_id`. Omitting it is now reserved for
  internal system sweeps; every HTTP caller passes it.
- `store.getApproval` added (needed to resolve an approval's owning execution).

### Fixed
- **Repository hygiene**: `apps/web/chrome-profile/` — a 246 MB Chrome profile
  (1504 tracked files, including `Network/Cookies`, `History`, `Login Data`,
  `Secure Preferences`, `Session Storage`) — was committed. Removed from the
  index and added to `.gitignore`; tracked files drop from 1640 to 136. The
  working copy is untouched. History still contains the blobs (`.git` is 117 MB);
  reclaiming that needs a deliberate `git filter-repo` pass.
- **Documentation drift**: `package.json`, `apps/*/package.json`,
  `apps/api/src/config.ts`, `README.md` and `ARCHITECTURE.md` all still said
  `0.12.0` / "149 tests" / "Phases 1–12" while `ROADMAP.md` and `CHANGELOG.md`
  said `0.15.0` / 170 tests. `ARCHITECTURE.md` also claimed "Ten migrations
  (`sql/001…010`)" and "41 tables" — the real numbers are eleven migrations and
  46 tables. All declarations now agree, and `ARCHITECTURE.md` gained an
  authorization section (§9) with the residual gaps stated explicitly.

### Verified
- `npm test` → **189/189** (170 existing + 19 new) · `tsc` → 0 errors.
- Two-session matrix: owner succeeds, non-owner 404s, target record unmodified.
- Builds: `packages/contracts` + `apps/api` `tsc` green; `apps/web` `next build`
  compiles clean and generates 15/15 pages. (Next's final Turbopack cache-cleanup
  step is blocked by this environment's bulk-delete guard — a sandbox artifact,
  not a build failure. No web source was modified in this release.)

## 0.15.0 — JARVIS Real Agent Experience (2026-09-09)

The interaction layer now behaves like the runtime it visualizes: commands are acknowledged instantly with honest intent, executions are visible while they run, and the JARVIS presence is driven by real state end to end. No fake activity anywhere — every line in the execution panel is a real bus event.

### Added
- **Command acknowledgement (§7)**: every command returns an `ack` — a natural first-person statement naming what will actually happen ("I'll route this to Researcher — follow the execution as it runs.", "I'll pull the rollup for Aurora — progress, blockers, sprints, milestones."). All 10 command-center routes carry honest acks; `command.acknowledged` lands on the event bus with kind + agent. Contract: additive `ack` field + `command.acknowledged` EventType (contracts rebuilt).
- **ExecutionStore** (`apps/web/src/lib/execution-store.tsx`): ONE client-side source of truth for live execution state, mounted at the root layout so it survives navigation (§22/§45). Fed by the existing SSE stream, idempotent by event id (§34), bounded buffers (§36), reconciles against `/api/executions` on reconnect (§35). Maps every existing runtime event (agent.started/thinking/executing, plan.created, tool.executed/denied/failed, skill.executed/denied, approval.requested/decided, agent.paused/resumed/stopped/completed/failed, memory.working.opened, agent.token streaming) into a normalized execution timeline — zero new backend events invented.
- **LiveExecutionPanel** (`LiveExecutionPanel.tsx`): the "watch it work" surface, inline under the command input. Real agent badge with state-specific breathing, human-friendly activity lines (§13 Level 1) with expandable technical details (Level 2: tool latency, plan rationale, timestamps), streaming response buffer, inline Approve/Deny when the execution is genuinely paused on `approval_required`, Pause/Resume/Stop controls wired to the real runtime endpoints, honest failure surface, live elapsed timer, "Full trace ↗" into the Activity inspector.
- **Global active-operations indicator (§23/§33)**: topbar shows `● N ACTIVE AGENTS` with a popover of who's doing what, from anywhere in the OS.
- **State-specific breathing (§5)**: the JARVIS Core's nucleus now breathes per real state — idle (near-still 6.5s), listening (3.4s), thinking (slow deep 5.2s), executing (rhythmic 2.6s), waiting (9s subdued), approval_required (attention 1.6s), error (short triple pulse). One keyframe family, transform/opacity only, flattened under `prefers-reduced-motion`; text state label always accompanies it (§38).
- **5 new tests** (`jarvis.test.ts`, 170 total): ack presence + honest-content contract, `command.acknowledged` bus landing + ordering, execution commands returning id+agent immediately, and a real execution driving to terminal state with its full event chain asserted — all through the real Fastify app with a real login session.

### Changed
- **Command surface behavior**: execution commands no longer navigate away. The command stays on Home; the live panel streams in beneath it; simple local answers render as a quiet result card (§21/§41 complexity-aware: no execution theater for instant answers). The Shell footer ticker was replaced by the store-driven connection state; the palette registers executions into the global store and closes with the ack visible.
- **JARVIS Core mode** now derives from live ExecutionStore state first (≤SSE latency), falling back to the polled agent/health selector — and gained a real `waiting` mode.

### Fixed
- **Stale command-center copy (§31)**: the "schedule" branch still said automations were "Phase 8 in ROADMAP" — they shipped in Phase 8 (0.8.0). Now answers with real, current guidance (Automations page, trigger types, webhook secret).
- **Command surface "navigate away" UX**: `kind:'execution'` used to redirect to /activity, destroying the in-progress feeling; the trace viewer on /activity remains the deep-inspection surface.

### Verified live
- Complex command (§42): ack → execution created → Researcher active → activity streamed (context memories, plan, steps) → completed → panel retained. **Approval flow (§24)**: task.create command → Hermes genuinely paused on `approval_required` → Approve via UI → resumed → completed → core returned to STANDBY; the created task is real. **Cancellation (§44)**: 300s-wait flow run → stop → `cancelled` (real backend state). **Background (§45)**: store lives at the root; executions continue streaming while navigating. **Simple command (§41)**: instant local answers render as a result card, no timeline. 8-branch ack matrix all honest; ack for already-connected integrations named the real account. Mobile briefing unchanged (nominal).

## 0.14.0 — JARVIS UI/UX Transformation (2026-09-09)

### Redesigned
- **One HUD design system across the whole console** (`apps/web/src/app/globals.css`, rewritten): the base kernel CSS and the Phase-12 JARVIS cockpit CSS — previously two coexisting visual worlds — are unified into a single token layer. Deep space field (`#060a10`) with a fixed architectural grid, translucent panels with cyan corner ticks, IBM Plex Sans + JetBrains Mono type system, semantic status colors (cyan = information, orange = attention/action reserved, green = live, red = danger, purple = memory), one panel/button/badge/dot/metric primitive set, elevated shadows, glow tokens, reduced-motion-safe semantic animation. Light theme carries the same HUD language inverted. All text/surface pairs verified ≥4.5:1.
- **App shell** (`Shell.tsx`): live clock, `LIVE/OFFLINE` bus indicator with glow, notification flyout (click-to-open instead of always-rendered), approval banner, v0.13 crumb, ARIA labels on all icon-only controls. Mobile (<820px): the rail collapses to a bottom navigation bar with safe-area insets — deliberate mobile command-first experience, not shrunken desktop.
- **Home = Command Center**: cockpit is the primary view; the Phase-10 widget grid remains as a "Widget grid" toggle with all layout-editing preserved (add/reorder/width/remove/save/reset). New left bank: **Attention Required** panel (approvals + urgent notifications + recent failures, inline ✓/✕ decide) and **Mission Queue** with real deadline urgency (overdue red / due-within-48h orange, computed from task deadlines). Center: JARVIS Core + command surface. Right bank: Agent Presence, Autonomous Layer (sentinels with run counts), Realtime Feed with tone-coded event pins. HUD strip anchors system status.
- **JARVIS Core**: real-state mode selector extended with `waiting` (paused/blocked agents) — modes: idle/thinking/executing/waiting/approval_required/error, all derived from health, approvals, agent statuses, live events. Mode copy tightened ("Kernel online — awaiting intent").
- **Command surface**: voice state machine rebuilt (IDLE/LISTENING/PROCESSING/ERROR live via Web Speech; SPEAKING/INTERRUPTED typed and reserved for real TTS — never rendered fake). Voice chip shows the state; interim transcript surfaces as "heard: …"; suggested natural-language commands when empty; text and voice route the same `POST /api/command`.

### Fixed
- `var(--card)` undefined-token bug in the flows builder node and links tooltip (rendered no background).
- Flows tool-node color fallback chain masking `--blue`.
- Memory page `window.prompt/alert` → inline composer card (⌘⏎ submit) and inline operation status; links page derive `alert` → inline status line.
- `.notice` side-tab accent border (AI-UI tell flagged by detector) → hairline cyan border + tinted field.
- Status dot semantics: executing/running states pulse cyan (system) instead of blue; sprints active badge → cyan.
- One header scale (`.page-h1` 17px/700) across all 12 subsystem pages (was ad-hoc 18px inline styles).
- `--fg-faint` contrast 3.68:1 → 4.53:1 (dark), 4.4:1 → 5.11:1 (light).
- Topbar version crumb v0.12 → v0.13.

### Documentation
- `apps/web/PRODUCT.md` (product truth: real-state-only, one-OS, command-first principles), `apps/web/DESIGN.md` (built-world design system record), `apps/web/.impeccable/surface-brief.md` (audit + direction contract).

### Verified
- `npm test` 165/165 · `tsc` 0 errors (web) · production `next build` green (15 routes) · all 14 routes live-200 with the new shell · command E2E through the new surface ("what are my agents doing" → real agent roster) · SOM/AX layout inspection (no overflow/misalignment at 1456×864) · Impeccable detector clean (1 brief-pinned advisory retained: the architectural grid field).

## 0.13.0 — Universal Integration Platform (2026-09-08)

### Replaced
- **Phase 9's three one-off integrations → a provider-agnostic platform** (`modules/integrations/`, 7 initial providers). Adding a provider is now: one manifest + one adapter + one registration line — the engine (service, OAuth, webhooks, sync, rate limits) has zero provider knowledge.

### Added
- **7 providers**: GitHub (OAuth + PAT), Gmail + YouTube (shared Google OAuth identity — one login, both services; Calendar/Drive/Contacts will reuse it), Slack (OAuth + bot token), Telegram (official Bot API — the non-OAuth proof), WhatsApp (official Meta Cloud API only), Instagram (official Meta Graph, professional accounts).
- **Central OAuthManager** (`integrations/oauth.ts`): ONE authorization-code implementation — state generation/validation (CSRF, one-time, 10-min expiry), PKCE S256 where the provider requires it (Google, Instagram), token exchange, refresh-token storage, expiry tracking, automatic refresh on the pre-call path, revoked-token → `reauth_required`, multi-account by provider+account.
- **Capability-based permissions**: every provider declares granular capabilities (`gmail.send`, `github.issue.write`, `slack.message.write`, `whatsapp.send`…); connections store explicit grants; every execution path — UI, API, agent tools — enforces the grant before touching credentials. Unknown capabilities rejected at connect time (before any network call).
- **Webhook gateway** (`integrations/webhooks.ts`): signature verification (HMAC-SHA256 + Slack v0 timestamp scheme, constant-time), replay protection (source-event dedup), normalization, bus bridge — `POST /api/integrations/:id/webhook`.
- **Sync engine** (`integrations/sync.ts`): cursor-based incremental polling per connection, checkpointed in `integration_sync_state`, per-provider intervals (≥60s floor), Telegram getUpdates offset / GitHub notifications since-cursors.
- **Rate limiting** (`integrations/rate-limit.ts`): per provider+connection token buckets, Retry-After-aware backoff — one provider can never exhaust the OS.
- **Agent tools** (`integrations/tools.ts`): `integration.list` + one `<provider>.action` tool per provider, generated from manifests, capability-gated, fully audited (deep secret redaction on every audit/event path).
- **Manifest-driven UI**: the Integrations page renders entirely from the provider catalog — auth methods per provider (never a generic token field), config status (`configured` / `not_configured` / `misconfigured`), capability chips, multi-account connections, health, API-restriction notes.
- **Normalized event model**: `{id, provider, connection_id, event_type, actor, timestamp, resource, payload, capabilities_required, source_event_id, metadata}` bridged onto the OS bus.
- Migration `011`: multi-account `integration_connections` (label, identity_key, token expiry, last success/error), webhook dedup, sync state, PKCE columns on oauth_states, backfill from the Phase-9 table.
- 21 rewritten platform tests (151 total): OAuth state/PKCE/exchange/refresh/expiry, capability enforcement + unauthorized-call denial, multi-account lifecycle, encrypted storage + tamper detection, secret redaction, webhook signature + replay, rate limiting, sync cursors, adapter probes against mocked HTTP, provider catalog shape.

### Fixed
- **The "OAuth (unconfigured)" bug**: config status was computed from a hardcoded `{github, gmail}` env-name map — every other OAuth provider always showed unconfigured, and Gmail's spec-correct `GOOGLE_*` env names weren't in the map. Status now resolves from each provider's declared env names (`configured`/`not_configured`/`misconfigured`), and no secret value ever crosses the API.

## 0.12.1 — Finalization, hardening & release readiness (2026-09-08)

### Security
- **Login throttling**: per-username+IP sliding window — 5 failures in 5 min → 10-minute lockout (429). In-process by design for single-node; documented Redis path for scale.
- **Dependency audit swept to zero**: 9 vulnerabilities (fastify ≤5.12.0, find-my-way, postcss, vite/vitest chain, esbuild) fixed via `npm audit fix --force` — fastify 5.12.3, vitest 5.0.0, Next 16.3.4. Full suite + all three production builds verified on the new majors.
- **VAPID JWT signature bug fixed (real since Phase 10)**: the DER fast path for 72-byte ECDSA signatures sliced `r` at byte 8 instead of byte 5, corrupting the ES256 JWT whenever both integers needed zero-padding (~25% of signatures — real push services would have rejected those sends). Now signs with `dsaEncoding: 'ieee-p1363'` (raw r||s, no DER parsing) with a correct universal DER parser as fallback; the test loops 40 iterations to cover all DER shapes. Caught because the "flaky" test failure repeated across runs.

### Build / packaging
- **Dockerfile now ships `apps/web/public`** — the PWA manifest, service worker, and icon were silently missing from production images (browser push + installability were broken in Docker).
- **Root `npm run build` now includes the web production build** (was contracts + api only).

### Cleanup
- Removed dead `apps/web/src/lib/jarvis-store.tsx` (provider written, never mounted), stray `output/enhanced-portrait.jpg`, empty `docs/` dir.
- `.env.example` now documents every Phase 5–12 variable: `OPENAI_EMBED_*`, `INTEGRATION_VAULT_KEY`, `VAPID_*`, `AGENTIC_SKILLS_DIR`.

### Documentation
- **README rewritten for v0.12.0**: current subsystem map (all phases live), JARVIS cockpit + mobile supervisor, converged command architecture, honest boundaries, production paths.
- **ARCHITECTURE.md rewritten**: 41-table data model, command-convergence diagram (text/voice/UI/automation → one runtime), per-subsystem reality, operational limits.

### Verified in this pass
- Migrations: fresh-DB boot applies all 10 idempotently (41 tables); re-run is a no-op.
- `npm test` → 149/149 · `tsc` → 0 errors (api + web) · production builds green (contracts, api, web/Next 16).
- No secrets committed (`git ls-files` clean), no key/secret fields in any API response surface, OAuth state one-time + CSRF-checked, webhook tokens constant-time compared, vault keys 0600.

## 0.12.0 — Desktop/Mobile supervision (Phase 12, 2026-09-07)

### Added
- **Mobile supervision app** (`/mobile`): a phone-first standalone supervisor surface — live briefing (status escalation nominal/action_required/critical), running-work stat tiles, one-tap Approve/Deny for the full pending-approval queue, agent roster, open tasks with project names, recent events, and a two-step-confirm **emergency stop** with post-stop report. Installable PWA (manifest + standalone display + theme color); OS notifications ride the existing Phase 10 Web Push channel.
- **Briefing API** (`GET /api/mobile/briefing`): render-ready supervision payload — status, agents, actionable tasks, approvals, summarized events, running-work counts.
- **Emergency stop** (`POST /api/emergency-stop`, `modules/supervision.ts`): the kill switch — cascades through every non-terminal execution (delegated children + in-flight generation aborts included, execution rows forced terminal synchronously), cancels every running/waiting/paused/interrupted flow run, pauses all enabled automations until re-armed. Audit row + `system.emergency_stop` bus event (new contract event type) + urgent supervisor notification; idempotent by construction. Live-verified against a genuinely running flow run.
- 6 new tests (149 total): briefing shape/escalation/projection, emergency-stop cascade + terminal assertions, idempotence, audit + event persistence.

## 0.11.0 — Knowledge graph (Phase 11, 2026-09-06)

### Added
- **Co-occurrence derivation** (`modules/graph.ts`): entities that share a memory are semantically related — every unordered pair co-mentioned in a memory derives a `co_occurs_with` graph link (`created_by='derived'`, stable link ids). Idempotent and self-healing: existing pairs upsert without churn, stale pairs (memories that no longer share entities) are pruned, explicit kernel links are never touched. Runs at boot and via `POST /api/graph/derive` (live-verified: boot derived 22 links from the real memory corpus; re-run reported 0/0).
- **Force-graph Links Explorer** (`/links`, rewritten): a zero-dependency canvas force simulation — pairwise repulsion, spring edges (derived links longer and weaker than explicit ones), centering gravity, velocity damping. Node radius by degree, kind-colored nodes + legend chips, purple derived vs blue explicit edges, labels on high-degree nodes, out-of-neighborhood dimming on focus. Drag-pan, scroll-zoom, hover tooltips, click-to-focus (fetches the one-hop neighborhood into the inspector with clickable neighbor rows), Freeze/Animate, Clear focus, per-kind filters, and the Derive button.
- **Graph APIs**: `GET /api/graph` (render-ready snapshot: nodes with degree/weight, typed edges, derived count; default view filters the 225 bookkeeping execution entities out of the semantic graph; `?kinds=`, `?all=1`), `GET /api/graph/neighbors?id=` (one-hop traversal).
- **Graph queries in universal search**: `/api/search` now returns `type: 'graph'` results — matching entities expand to their neighborhoods, so "what's connected to pgvector?" answers with the actual neighborhood (center, neighbors, edge types).
- 12 new tests (143 total): derivation pair counting/dedup/symmetry, idempotence, stale pruning, explicit-link safety, snapshot shape (degrees/weights/derived flags/kind filters/includeAll), neighborhoods, graph-query matching + empty safety. The tests caught two real bugs (double-prefixed entity refs in link columns; inconsistent diff-map keys) — both fixed before ship.

## 0.10.0 — Notifications + Widgets (Phase 10, 2026-09-06)

### Added
- **Browser push channel** (`modules/notify.ts`): full Web Push (RFC 8291/8292) with zero dependencies — Node stdlib crypto implements VAPID P-256 key management (env keys or auto-generated `vapid.json`), the ES256 JWT Authorization header, and aes128gcm payload encryption (ECDH + HKDF with per-send random salt/ephemeral key). Browser side ships a service worker (`public/sw.js`) that decrypts pushes into native OS notifications and focuses the app on click. Dead endpoints (404/410) are pruned automatically; push failures are isolated from the event bus.
- **Notification router**: every `notification.created` on the bus fans out to the user's channels — the in-app bell (the persisted notification row) plus browser push to all of that user's registered subscriptions, gated by their prefs. Subscribing auto-enables the channel; unsubscribing the last browser disables it. `POST /api/notifications/push/test` fires the entire pipeline.
- **Per-user channel prefs** (migration 010): `browser_push`, `push_min_priority` (low/medium/high/urgent threshold), `categories` allowlist. The gate is tested from both sides (below-threshold never pushes; category filters work; urgent passes the high default).
- **Configurable dashboard grid** (migration 010 `dashboard_layouts`): per-user widget order + widths (1/3, 2/3, full row), `GET/PUT /api/dashboard/layout` with duplicate-id rejection, reset endpoint, `widget.layout.updated` event. The home page is now a pure widget renderer driven by the saved layout.
- **Widget SDK**: registry of 10 widget kinds (agent-presence, system-health, open-tasks, projects, unread-notes, recent-activity, quick-actions, counts, approvals, automations) — each a pure function of dashboard data. New this phase: Pending Approvals (live approval queue) and Automations widgets. Edit mode: add from picker, reorder, cycle width, remove, save/reset. The Unread Notifications widget embeds the browser-push opt-in (Enable/Test/Turn off with live prefs state).
- 11 new tests (131 total): VAPID key shapes/stability, JWT cryptographically verified against the public key, aes128gcm body structure, prefs gating matrix, subscription registry upsert/prune, fan-out with mocked fetch (headers, VAPID auth, gone-pruning), router bus-E2E, layout persistence/isolation/reset.

## 0.9.0 — Integrations (Phase 9, 2026-09-05)

### Added
- **Integration adapters** (`modules/integrations-service.ts`, migration 009): the IntegrationPort from v0.1 now has three real adapters — GitHub (personal access token or OAuth; probes `GET /user`, lists open PRs, public repo search), Gmail (OAuth; probes the Gmail profile, reads recent message metadata), Slack (bot token xoxb-; probes `auth.test`, lists channels, posts via `chat.postMessage`). Connect always probes the provider's identity endpoint first — an invalid token is rejected with the provider's own error (live-verified: `HTTP 401 Bad credentials`); no fake connections.
- **Secret vault** (`modules/vault.ts`): all tokens (access + refresh) are AES-256-GCM encrypted at rest (`iv.tag.payload`, random IV per write, auth-tag tamper detection) — plaintext never touches the database. Master key via `INTEGRATION_VAULT_KEY` or an auto-generated 0600 key file. Disconnect deletes vault rows.
- **OAuth authorization-code flow**: `GET /api/integrations/:id/oauth` issues a user-bound, one-time, 10-minute CSRF state and returns the provider consent URL; the provider callback (`GET /api/integrations/:id/oauth/callback`, session-exempt) exchanges the code, probes, and stores — refresh tokens (Gmail offline grants) persisted to the vault. Unknown/expired/wrong-user states rejected; states are consumed even when the exchange fails. GitHub/Gmail OAuth app credentials are env-configured, and the UI honestly disables OAuth buttons with the reason when unconfigured.
- **Integration events → automations**: external events are persisted (`integration_events`) and bridged onto the OS bus as `integration.event`, so Phase 8 automations (`trigger_config.event_type = 'integration.event'` + optional pattern) dispatch flows or agents off external activity. Capability writes (e.g. Slack postMessage) emit `<id>.created` events.
- **Per-integration permission scopes**: capability→scope maps enforced before every read/create/search (`requireCapability` — missing scopes reject, never silent); connections are one per user per adapter; reconnect upserts and rotates the vault token.
- **API**: `GET /api/integrations` (adapters + connections + oauth flags), `POST /api/integrations/connect`, `POST /api/integrations/:id/disconnect|read|create`, `GET /api/integrations/:id/search|events`, `GET /api/integration-events`, OAuth start/callback/complete. Command-center "connect github" now answers with real guidance. Events: `integration.connected/disconnected/failed/oauth.started`.
- **Integrations UI** (`/integrations`, nav rail): adapter cards (connection state, scope chips, token modal, OAuth button with unconfigured reason, Test read, Disconnect) + the live integration-event feed with the automation-bridge hint.
- 19 new tests (120 total): vault (round-trip, IV uniqueness, tamper, malformed), httpJson error surfacing (live 401), adapter probes (mocked positives + real negative paths), connection upsert/token rotation, scope enforcement, disconnect idempotence, OAuth state machine (start/complete/one-time-use/expiry/user-binding), event bridge (persist + emit + capability events), adapter listing.

## 0.8.0 — Automations (Phase 8, 2026-09-05)

### Added
- **Automation engine** (`modules/automations-engine.ts`, migration 008): trigger → action bindings subscribing to the existing OS infrastructure. **Cron triggers**: dependency-free 5-field parser (wildcards, every-N steps, ranges, lists, month/day names, sunday-7) with a 60s ticker and catch-up (missed windows fire once; `last_fired_at` on the row is the dedup). **Event triggers**: a single BrokerPort subscription feeds all event automations — exact event-type match plus optional substring pattern over event data; `automation.*` events never trigger automations (feedback-loop guard). **Webhook triggers**: `POST /api/webhooks/:id` (session-auth-exempt) authenticated by a server-generated per-automation secret via Bearer header or query param, constant-time compared.
- **Per-automation autonomy policy**: `autonomy_level` 0-4 on every automation gates dispatch exactly like the runtime gates tools — below the action minimum the fire is skipped with a logged reason; the level also flows into the dispatched agent's own tool gates via `autonomy_override`. In-flight guard: concurrent triggers of the same automation → one dispatch, one logged skip.
- **Actions**: run a flow (flow_id + input template) or an agent (agent_name + input template); `${event.*}` / `${payload.*}` templates inject trigger context into action input. Every fire (dispatched/skipped/failed) is persisted to `automation_runs` with reason + target id, and run stats update on the automation row.
- **Automation inspector** (`/automations`): create form with trigger/action pickers, cron/event/webhook config, agent/flow selectors, autonomy dropdown with plain-language labels; list view with trigger icons, schedules, run counts, last-fired; per-automation ⚡ test-fire / Pause-Enable / delete; inspector panel showing config (webhook URL + secret for external callers) and the run log; global recent-runs feed. Nav rail entry.
- **API**: `GET/POST /api/automations`, `GET/PATCH/DELETE /api/automations/:id` (cron parse errors → 400), `POST /api/automations/:id/toggle`, `POST /api/automations/:id/test`, `GET /api/automations/:id/runs`, `GET /api/automation-runs`, `POST /api/webhooks/:id`. Events: `automation.created/updated/deleted/enabled/paused/dispatched/skipped/failed`.
- 16 new tests (101 total): cron parse matrix + malformed rejects, next-fire, event matching/pattern/self-trigger/paused, autonomy-gate skip, flow dispatch + missing-target failure, webhook secret compare + paused skip, test-fire, double-fire guard.

### Fixed
- Cron day-name lookup treated sunday (0) as missing — falsy-zero bug found by the test matrix, now resolved by `undefined` comparison.

## 0.7.0 — Flows (Phase 7, 2026-09-05)

### Added
- **Flow engine** (`modules/flows.ts`): long-running, checkpointed executions of directed flow graphs over the existing bus/agent/tool infrastructure. Save-time validation: unique ids, dangling edges, exactly one trigger, per-kind config requirements, cycle detection that only allows back-edges through loop nodes. Condition nodes evaluate via a safe hand-rolled expression parser (ctx paths, literals, comparisons, &&/||/!, parens — no eval). Node kinds: trigger (defaults seed), agent/skill (full AgentRuntime execution awaited to terminal state), tool (template-resolved args + required-arg enforcement), condition (true/false routing; missing false-edge ends the flow), branch (ctx-value routing with default), loop (counter to max_iterations, body/exit routes), wait (1-300s), approval (real approval + notification, polled decision). Node outputs land in a context variable store and template (`${ctx.*}`) into downstream inputs.
- **Checkpoint/resume** (migration 007 `flow_runs`): current node, completed set, live context, and bounded trace persist after every node — pause at a node boundary, resume from the persisted node (at-least-once), stop → cancelled, boot recovery marks orphaned runs `interrupted` (resumable). `POST /api/flow-runs/:id/{pause,resume,stop}`.
- **Versioned flow definitions** (migration 007 `flows` + `flow_versions`): diff-aware patch bumps — unchanged graph keeps its version; any change bumps semver patch and snapshots the prior definition. `GET /api/flows/:id/versions`. Live-verified: 0.1.0 → 0.1.1 on loop-max change, no bump on identical PATCH.
- **Visual builder** (`/flows`, @xyflow/react 12): palette with all 9 kinds, draggable canvas with kind-styled custom nodes and labeled source handles (true/false, body/exit), node inspector editing kind-specific config, flow list with versions/runs, live run panel with trace and Resume/Stop, inline save validation. Flows entry in the nav rail.
- **Flow API**: `GET/POST /api/flows`, `GET/PATCH/DELETE /api/flows/:id`, `POST /api/flows/:id/run`, `GET /api/flows/:id/runs`, `GET /api/flow-runs/:id`, plus the pause/resume/stop controls. Events: `flow.created/updated`, `flow.run.started/completed/failed/cancelled/paused/resumed`, `flow.node.started/completed`, `flow.waiting`, `flow.approval.requested`.
- 15 new tests (85 total): validation matrix, expression safety, template resolution, linear/branch/loop/wait/agent E2E, stop, pause→resume→complete, boot recovery, required-arg failure.

## 0.6.0 — Projects/Sprints (Phase 6, 2026-09-05)

### Added
- **Dependency graph** (`modules/projects.ts`): the previously-unused `task_dependencies` table is now the backbone of project execution. Edges are cycle-guarded at write time (DFS reachability: adding from→to is rejected if to can already reach from), plus self/dupe/unknown-task guards. `dependencyOrder()` computes topological parallel levels — L0 first, same-level tasks parallelizable. Exposed as `POST/GET/DELETE /api/tasks/:id/dependencies`, `GET /api/projects/:id/dependency-order`, and the `task.depend` tool (accepts ids or exact titles; the heuristic planner extracts "<A> depends on <B>" phrasing).
- **Blockers**: task status now follows the graph — an unfinished dependency blocks its dependent; `cascadeUnblock()` re-evaluates dependents on completion so finishing a task unblocks its children level by level (wired into both the PATCH task route and the `task.update` tool, which now reports `unblocked_dependents`). Rollup lists each blocked task with the names it waits on. Events: `task.blocked`, `task.unblocked`, `task.dependency.added/removed`.
- **Dependency-aware sprint planning**: `materializeSprintPlan()` creates a sprint, its tasks, and the edges between them (by title), returning a level-sorted execution schedule. Three entry points: the `sprint.plan` tool (JSON task defs; the builtin heuristic planner extracts goal + project from natural language and emits a Design→Implement→Test→Deploy chain), the command center ("plan a sprint for X in project Y" — now a real dependency chain instead of a flat task list), and `sprint.planned` events.
- **Milestones** (migration 006): dated project checkpoints — create via API/command center ("add a milestone X to project Y by DATE"), mark reached; open milestones past due flip to `missed` automatically on the automation sweep. `milestone.created/completed/missed` events; Milestones card on the project page.
- **Progress rollups**: `GET /api/projects/:id/rollup` aggregates task counts by status, completion %, blockers (with waiting-on names), active sprint progress (tasks done/total, %), milestone counts + next due, and overdue tasks. Command center "status of project X" renders it as a briefing; the project page shows a rollup bar (green progress bar, blocked/overdue/milestone badges, blocker list) plus per-task dependency-level badges (L1–Ln).
- **Deadline automations** (`modules/automations.ts`): a 60s sweep (also `POST /api/automations/deadlines/run`) — overdue tasks → high-priority notification + `task.deadline.overdue` event; ≤24h → medium + `task.deadline.due_soon`; stale open milestones → missed. Deduped per (task, kind) through the `deadline_alerts` ledger; completing a task clears its rows so a reopened deadline can alert again.
- Sprint lifecycle: `POST /api/sprints/:id/transition {start|complete|cancel}` — planned→active→completed (unfinished sprint tasks archived on completion) with Start/Complete/Cancel buttons in the UI.
- 13 new tests (70 total): edge guards, cascade unblocking level-by-level, topological ordering, sprint materialization + heuristic arg parsing (goal/project extraction), milestone lifecycle, rollup shape, deadline dedup/reset, sprint transitions.

## 0.5.0 — Memory (Phase 5, 2026-09-05)

### Added
- **Vector Index Port** (`modules/vector.ts`): the memory engine's vector leg is now a pluggable driver behind an unchanged `searchMemory`/`createMemory` interface. Default: local in-process cosine (SQL keyword prefilter, supersampled for composite rescoring). Production: **pgvector** — activates automatically when the data driver is Postgres and the `vector` extension exists; adds a `memories_vec vector(dim)` column, HNSW ANN index (IVFFlat fallback), a `BEFORE INSERT` trigger that casts the TEXT embedding JSON into the vector column on every write (all write paths covered, zero app-code changes), and ANN cosine search with graceful degrade to the local driver on any failure. Embedding provider pluggable via `OPENAI_EMBED_BASE_URL` + `OPENAI_EMBED_MODEL` (OpenAI-compat `/embeddings`); ships with the deterministic 128-d hash. Live-verified against pgvector 0.8.6 (3/3 rows vectorized by trigger, ANN + composite results correct, HNSW index active). `docker-compose` Postgres upgraded to `pgvector/pgvector:pg16` (data-compatible drop-in).
- **Entity extraction** (`modules/entities.ts`): deterministic person/org/tech/url/topic extraction on every memory write — the single choke point every write funnels through. Entities upsert into the `entities` graph registry, the new `memory_entities` join (migration 004), and `memory -[mentions]-> entity` links, so the Links Explorer can traverse memory → entity → memory. Guards: org-marker sequences ("Vector Labs Inc") classify as org, not person; sentence-initial capitalized subjects rejected unless followed by an actor verb ("Maria Chen from…"); tech vocabulary matched as whole words; mid-sentence words don't leak into names. Boot-time **backfill** extracts from pre-Phase-5 memories — idempotent via `memory_entity_scan` (migration 005): zero-entity memories are marked scanned so boots stay O(new memories), not O(all). `POST /api/memory/entities/backfill` triggers on demand; `GET /api/memory/entities/:kindSlug` lists a entity's linked memories; `DELETE /api/memory/:id` cascades joins + graph links but keeps entities referenced by other memories.
- **Working-memory windows** (`modules/workingmemory.ts`): one per execution (`working_memory` table, migration 004). Opened at planning with the retrieved memories pinned (ids); step outcomes append as bounded facts (≤40 × 240 chars, oldest dropped, token estimate tracked); the window feeds the synthesis prompt — bounding the observation-log growth that previously inflated prompts; closed at terminal state (facts stay readable for audit). Exposed via `GET /api/executions/:id/working-memory` and `POST /api/executions/:id/working-memory/facts` (manual facts, e.g. user context injected into a resumed run). Trace viewer renders the WORKING MEMORY panel (pinned ids + fact feed); Memory page shows clickable entity chips (`entity_refs` attached by `GET /api/memory`) + the active vector driver badge; `GET /api/health` reports vector stats and entity/window counts.
- 15 new tests (57 total): driver search/stats/fallback, extraction determinism + graph invariants, backfill idempotency, delete/consolidation cascades, window lifecycle/bounds/render, full runtime E2E with a real window opened and closed.

### Fixed
- Memory-write entity quality: capitalized org markers no longer double-extract as person entities; sentence-initial true names followed by common verbs ("reported", "from") now extract.
- Consolidation no longer orphans `memory_entities` join rows (re-pointed at the keeper; Postgres fallback deletes only the conflicting rows).

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
