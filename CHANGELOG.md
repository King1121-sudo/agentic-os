# Changelog

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
