/**
 * approvals routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as store from '../modules/store';
import { NOT_FOUND } from '../modules/authz';
import { ApprovalDecisionInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerApprovalsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, runtime } = ctx;

// ─── approvals ────────────────────────────────────────────────────────────
// Approvals inherit the owning execution's user — scoped, so a user sees and
// decides only their own gates. `resolveApproval` re-checks ownership itself.
app.get('/api/approvals', async (req: any) =>
  store.listApprovals(db, { status: String(req.query?.status ?? 'pending'), user_id: req.user.id }));
app.post('/api/approvals/:id/decision', async (req: any, reply: any) => {
  const parsed = ApprovalDecisionInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const ok = await runtime.resolveApproval(req.params.id, parsed.data.decision, req.user.id);
  if (!ok) return reply.code(404).send(NOT_FOUND);
  return { ok: true };
});
}
