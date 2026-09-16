/**
 * flows routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import { iso, uuid } from '../infra/types';
import * as flows from '../modules/flows';
import { requireOwned, NOT_FOUND } from '../modules/authz';
import { FlowUpsertInput, FlowRunInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerFlowsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus, flowEngine } = ctx;

// ─── Phase 7: flows ────────────────────────────────────────────────────────
app.get('/api/flows', async () => flows.listFlows(db));
app.get('/api/flows/:id', async (req: any, reply: any) => {
  const f = await flows.getFlow(db, String(req.params.id));
  if (!f) return reply.code(404).send({ error: 'flow not found' });
  return f;
});
app.post('/api/flows', async (req: any, reply: any) => {
  const parsed = FlowUpsertInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const v = flows.validateFlow(d.nodes as any, d.edges as any);
  if (!v.ok) return reply.code(400).send({ error: `invalid flow: ${v.errors.join('; ')}` });
  const id = uuid(); const now = iso();
  await db.run(
    'INSERT INTO flows (id, name, description, nodes, edges, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, d.name, d.description, JSON.stringify(d.nodes), JSON.stringify(d.edges), '0.1.0', req.user.id, now, now]);
  await db.run(
    'INSERT INTO flow_versions (id, flow_id, version, nodes, edges, created_at) VALUES (?,?,?,?,?,?)',
    [uuid(), id, '0.1.0', JSON.stringify(d.nodes), JSON.stringify(d.edges), now]);
  await bus.emit('flow.created', { id, name: d.name, nodes: d.nodes.length }, { actor_type: 'user', actor_id: req.user.id, target_type: 'flow', target_id: id });
  return flows.getFlow(db, id);
});
app.patch('/api/flows/:id', async (req: any, reply: any) => {
  const parsed = FlowUpsertInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const existing = await flows.getFlow(db, String(req.params.id));
  if (!existing) return reply.code(404).send({ error: 'flow not found' });
  const d = parsed.data;
  const v = flows.validateFlow(d.nodes as any, d.edges as any);
  if (!v.ok) return reply.code(400).send({ error: `invalid flow: ${v.errors.join('; ')}` });
  // version bump on any graph change; unchanged graph keeps its version
  const changed = JSON.stringify(d.nodes) !== JSON.stringify(existing.nodes) || JSON.stringify(d.edges) !== JSON.stringify(existing.edges);
  const parts = existing.version.split('.').map(Number);
  const newVersion = changed ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : existing.version;
  await db.run('UPDATE flows SET name = ?, description = ?, nodes = ?, edges = ?, version = ?, updated_at = ? WHERE id = ?',
    [d.name, d.description, JSON.stringify(d.nodes), JSON.stringify(d.edges), newVersion, iso(), existing.id]);
  if (changed) {
    await db.run('INSERT INTO flow_versions (id, flow_id, version, nodes, edges, created_at) VALUES (?,?,?,?,?,?)',
      [uuid(), existing.id, newVersion, JSON.stringify(d.nodes), JSON.stringify(d.edges), iso()]);
  }
  await bus.emit('flow.updated', { id: existing.id, name: d.name, version: newVersion, bumped: changed },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'flow', target_id: existing.id });
  return flows.getFlow(db, existing.id);
});
app.delete('/api/flows/:id', async (req: any, reply: any) => {
  const f = await flows.getFlow(db, String(req.params.id));
  if (!f) return reply.code(404).send({ error: 'flow not found' });
  await db.run('DELETE FROM flow_runs WHERE flow_id = ?', [f.id]);
  await db.run('DELETE FROM flow_versions WHERE flow_id = ?', [f.id]);
  await db.run('DELETE FROM flows WHERE id = ?', [f.id]);
  return { ok: true };
});
app.get('/api/flows/:id/versions', async (req: any) =>
  db.query('SELECT id, flow_id, version, created_at FROM flow_versions WHERE flow_id = ? ORDER BY created_at', [req.params.id]));

// flow runs
app.post('/api/flows/:id/run', async (req: any, reply: any) => {
  const parsed = FlowRunInput.safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const f = await flows.getFlow(db, String(req.params.id));
  if (!f) return reply.code(404).send({ error: 'flow not found' });
  const run = await flowEngine.start(f, req.user.id, parsed.data.input ?? {});
  return run;
});
// Flow runs carry a user_id owner — reads and controls are owner-scoped.
app.get('/api/flows/:id/runs', async (req: any) =>
  flows.listRuns(db, { flow_id: String(req.params.id), user_id: req.user.id, limit: 50 }));
app.get('/api/flow-runs/:id', async (req: any, reply: any) => {
  const g = await requireOwned(() => flows.getRun(db, String(req.params.id)), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  return g.rec;
});
app.post('/api/flow-runs/:id/pause', async (req: any, reply: any) => {
  const g = await requireOwned(() => flows.getRun(db, String(req.params.id)), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  return { ok: await flowEngine.pause(String(req.params.id)) };
});
app.post('/api/flow-runs/:id/resume', async (req: any, reply: any) => {
  const g = await requireOwned(() => flows.getRun(db, String(req.params.id)), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  const r = await flowEngine.resume(String(req.params.id));
  if (!r) return { ok: false };
  return r;
});
app.post('/api/flow-runs/:id/stop', async (req: any, reply: any) => {
  const g = await requireOwned(() => flows.getRun(db, String(req.params.id)), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  return { ok: await flowEngine.stop(String(req.params.id)) };
});
}
