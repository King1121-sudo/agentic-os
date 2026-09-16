/**
 * Authorization — resource ownership (§39).
 *
 * The OS is multi-user: `executions`, `working_memory`, `flow_runs`,
 * `memories` and `notifications` all carry a `user_id` OWNER column. Every
 * route that reads or controls one of those records must confirm the caller
 * owns it — otherwise any authenticated user can read another user's inputs,
 * plans, traces and results, and can pause/stop/approve their work.
 *
 * POLICY
 *  - A record owned by someone else is reported as **404, never 403**. A 403
 *    would confirm the record exists; 404 leaks nothing.
 *  - Ownerless records (`NULL` or empty owner) are shared/system rows —
 *    seeded data, and rows written by an automation or tool with no user in
 *    context. They stay readable, which preserves existing behaviour.
 *
 * NOT AN OWNER COLUMN: `links.created_by` stores the literal `'derived'` for
 * knowledge-graph co-occurrence edges. Never pass a link record to these
 * helpers. `tasks.created_by` / `projects.created_by` are *creator* stamps,
 * not owners — those resources are deliberately workspace-shared; see
 * `docs/authorization.md`.
 */
export type Owned = { user_id?: string | null; created_by?: string | null } | null | undefined;

/** Shared 404 body — byte-identical for "missing" and "not yours". */
export const NOT_FOUND = { error: 'not found' } as const;

/**
 * The owner of a record, or null when it is a shared/system row.
 * `user_id` wins over `created_by`; empty strings collapse to null so rows
 * written from a context without a user stay shared rather than becoming
 * unreachable.
 */
export function ownerOf(rec: Owned): string | null {
  if (!rec) return null;
  return rec.user_id || rec.created_by || null;
}

/** Does `rec` belong to `userId`? Ownerless records are shared → true. */
export function isOwnedBy(rec: Owned, userId: string): boolean {
  if (!rec) return false;
  const owner = ownerOf(rec);
  return owner === null || owner === userId;
}

/**
 * Load a record and confirm the caller owns it. Returns `{ ok: false }` when
 * the record is missing OR owned by someone else, so a route can answer 404
 * without ever distinguishing the two cases.
 *
 *   const g = await requireOwned(() => store.getExecution(db, req.params.id), req.user.id);
 *   if (!g.ok) return reply.code(404).send(NOT_FOUND);
 */
export async function requireOwned<T extends Owned>(
  load: () => Promise<T>, userId: string,
): Promise<{ ok: true; rec: NonNullable<T> } | { ok: false }> {
  const rec = await load();
  if (!isOwnedBy(rec, userId)) return { ok: false };
  return { ok: true, rec: rec as NonNullable<T> };
}
