/**
 * graph routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as store from '../modules/store';
import * as graph from '../modules/graph';
import { LinkCreateInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerGraphRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus } = ctx;

// ─── links (knowledge graph) ───────────────────────────────────────────────
app.get('/api/links', async (req: any) => {
  const type = String(req.query?.type ?? ''); const id = String(req.query?.id ?? '');
  if (type && id) return store.listLinks(db, { type, id });
  return db.query('SELECT * FROM links ORDER BY created_at DESC LIMIT 200');
});
app.post('/api/links', async (req: any, reply: any) => {
  const parsed = LinkCreateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const l = await store.createLink(db, { ...parsed.data, created_by: req.user.id });
  await bus.emit('link.created', { id: l.id, relation: l.relation }, { actor_type: 'user', actor_id: req.user.id, target_type: 'event', target_id: l.id });
  return l;
});

// ─── entities (graph explorer) ────────────────────────────────────────────
app.get('/api/entities', async (req: any) => {
  const q = String(req.query?.q ?? '').toLowerCase();
  const rows = await db.query<any>('SELECT * FROM entities ORDER BY updated_at DESC LIMIT 500');
  return q ? rows.filter(r => r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q)) : rows;
});


// ─── Phase 11: knowledge graph ────────────────────────────────────────────
app.get('/api/graph', async (req: any) => {
  const kinds = req.query?.kinds ? String(req.query.kinds).split(',').map(s => s.trim()).filter(Boolean) : undefined;
  return graph.graphSnapshot(db, { kinds, includeAll: req.query?.all === '1' });
});
app.get('/api/graph/neighbors', async (req: any) => {
  const id = String(req.query?.id ?? '');
  if (!id || !id.includes(':')) return { error: 'id must be "<kind>:<entity_id>"' };
  return (await graph.graphNeighborhood(db, id)) ?? { error: 'node not found' };
});
app.post('/api/graph/derive', async () => {
  const res = await graph.deriveCoOccurrenceLinks(db);
  await bus.emit('link.created', { derived: true, ...res }, { actor_type: 'system' });
  return res;
});
}
