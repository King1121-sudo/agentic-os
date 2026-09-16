# Authorization — resource ownership

The OS stores data for multiple users. This document records which resources
are isolated per user, which are deliberately shared, and what is still open.

Implementation: `apps/api/src/modules/authz.ts`.
Regression suite: `apps/api/src/tests/authz.test.ts` (19 tests, mutation-verified).

## Policy

1. **A record owned by another user is reported as `404`, never `403`.** A 403
   confirms that the record exists; 404 leaks nothing. The response body is the
   single shared constant `NOT_FOUND` so "missing" and "not yours" are
   byte-identical.
2. **Ownerless rows stay shared.** An owner of `NULL` or `''` means "no user was
   in context" — seeded data, and rows written by an automation, webhook or
   agent tool with no user. Those remain readable, which preserves the
   pre-existing behaviour for system rows. This is why `ownerOf()` uses `||`
   rather than `??`: an empty string collapses to `null` instead of becoming an
   owner nobody can match.
3. **`created_by` is a creator stamp, not an owner.** `tasks` and `projects` use
   it to record who made the row; they are workspace-shared objects. See
   "Residual gaps" below.

## Enforced: owner-scoped on `user_id`

| Resource | Routes |
|---|---|
| executions | `GET /api/executions`, `GET /api/executions/:id`, `GET …/children`, `POST …/pause`, `POST …/resume`, `POST …/stop` |
| working memory | `GET /api/executions/:id/working-memory`, `POST …/facts` |
| flow runs | `GET /api/flow-runs/:id`, `POST …/pause`, `POST …/resume`, `POST …/stop`, `GET /api/flows/:id/runs` |
| memories | already scoped before this pass (`GET/POST /api/memory`, `DELETE /api/memory/:id`, `/search`, `/maintain`) |
| notifications | already scoped (per-user by construction) |

## Enforced: scoped through a parent

These tables have no owner column of their own — they inherit the owning
execution's `user_id`, so the check is a join (or a load of the parent):

| Resource | Mechanism |
|---|---|
| generations | `JOIN executions e ON e.id = g.execution_id WHERE e.user_id = ?` |
| approvals | list joins `executions`; the decision path re-checks via `runtime.resolveApproval` |
| tool executions | counted through `executions` on `/api/dashboard` |

`approvals` is the highest-risk of these: approving someone else's gate would
wave through a high-risk tool call (e.g. `shell.run`) on their execution. The
ownership check lives **inside** `AgentRuntime.resolveApproval`, so every caller
is covered, not just the HTTP route.

## Deliberately shared

- `agents`, `skills`, `entities`, `links`, `graph` — OS-level registries
- `tasks`, `projects`, `sprints`, `milestones`, `flows`, `automations` — carry
  `created_by` but are treated as workspace objects
- `/api/mobile/briefing` and `/api/emergency-stop` — the supervisor surfaces,
  whose entire purpose is the whole OS

## Residual gaps (open, not yet closed)

1. **Global telemetry surfaces.** `GET /api/events`, `GET /api/audit` and the
   `GET /api/stream` SSE feed are unscoped. Bus event payloads include
   execution inputs, agent names and tool summaries, so a second user can
   observe the first user's activity. Closing this properly needs an owner
   column (or an execution join) on `events`; it is a schema change, not a
   route guard, and is therefore out of scope for the guard pass.
2. **Shared workspace objects.** If the deployment ever becomes genuinely
   multi-tenant rather than multi-user, `tasks`/`projects`/`flows`/`automations`
   need real ownership. `authz.ts` supports this directly — pass `created_by`
   through `isOwnedBy` — but it is a product decision, not a bug fix.

## Adding a new user-owned resource

1. Give the table a `user_id` column (prefer `user_id` over `created_by` so the
   intent is unambiguous).
2. Scope every list query with a `WHERE user_id = ?` clause — do not rely on the
   route remembering.
3. Guard every detail/mutation route with
   `requireOwned(() => loader(id), req.user.id)` and answer `NOT_FOUND`.
4. Add a case to `authz.test.ts` with two sessions: one asserting the owner
   succeeds, one asserting the non-owner gets 404 **and that the record was not
   mutated**.
