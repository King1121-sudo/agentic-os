/**
 * telemetry routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import { CHANNEL, parseEventRow } from '../kernel/bus';
import * as memory from '../modules/memory';
import * as graph from '../modules/graph';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';
import { safeParse } from './context';

export function registerTelemetryRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, broker, bus } = ctx;

// ─── generations ──────────────────────────────────────────────────────────
// Generations have no owner column — they inherit the owning execution's
// user_id, so the join IS the scope; `execution_id` narrows it further.
// (`generations.execution_id` is never NULL, so an inner join loses nothing.)
app.get('/api/generations', async (req: any) => {
  const limit = Math.min(200, Number(req.query?.limit ?? 50));
  const conds = ['e.user_id = ?']; const params: unknown[] = [req.user.id];
  if (req.query?.execution_id) { conds.push('g.execution_id = ?'); params.push(req.query.execution_id); }
  const rows = await db.query<any>(
    `SELECT g.* FROM generations g JOIN executions e ON e.id = g.execution_id
     WHERE ${conds.join(' AND ')} ORDER BY g.created_at DESC LIMIT ?`, [...params, limit]);
  return rows.map(r => ({ ...r, input: safeParse(r.input), context: safeParse(r.context) }));
});

// ─── events / activity ────────────────────────────────────────────────────
app.get('/api/events', async (req: any) => {
  const limit = Math.min(500, Number(req.query?.limit ?? 100));
  const rows = await db.query<any>('SELECT * FROM events ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows.map(parseEventRow);
});

// ─── audit ────────────────────────────────────────────────────────────────
app.get('/api/audit', async (req: any) => {
  const limit = Math.min(500, Number(req.query?.limit ?? 200));
  const execFilter = req.query?.execution_id ? 'WHERE execution_id = ?' : '';
  const params = req.query?.execution_id ? [req.query.execution_id] : [];
  const rows = await db.query<any>(`SELECT * FROM audit_logs ${execFilter} ORDER BY ts DESC LIMIT ?`, [...params, limit]);
  return rows.map(r => ({ ...r, meta: safeParse(r.meta) }));
});

// ─── universal search (§28) ───────────────────────────────────────────────
app.get('/api/search', async (req: any) => {
  const q = String(req.query?.q ?? '').trim();
  if (!q) return [];
  const like = `%${q.toLowerCase()}%`;
  const out: any[] = [];

  const tasks = await db.query<any>('SELECT id, title, status, updated_at FROM tasks WHERE LOWER(title) LIKE ? LIMIT 10', [like]);
  for (const t of tasks) out.push({ type: 'task', id: t.id, title: t.title, subtitle: `task · ${t.status}`, score: 1, created_at: t.updated_at });

  const projects = await db.query<any>('SELECT id, name, status, updated_at FROM projects WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 10', [like, like]);
  for (const p of projects) out.push({ type: 'project', id: p.id, title: p.name, subtitle: `project · ${p.status}`, score: 1, created_at: p.updated_at });

  const mems = await memory.searchMemory(db, { user_id: req.user.id, query: q, k: 10 });
  for (const m of mems) out.push({ type: 'memory', id: m.id, title: m.summary, subtitle: `memory · ${m.type}`, score: m.score, created_at: m.updated_at });

  const agents = await db.query<any>('SELECT id, name, description FROM agents WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 10', [like, like]);
  for (const a of agents) out.push({ type: 'agent', id: a.id, title: a.name, subtitle: a.description.slice(0, 80), score: 1, created_at: a.updated_at });

  const skills = await db.query<any>('SELECT id, name, description FROM skills WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 10', [like, like]);
  for (const s of skills) out.push({ type: 'skill', id: s.id, title: s.name, subtitle: `skill · ${s.category}`, score: 1, created_at: s.updated_at });

  const docs = await db.query<any>('SELECT id, title, subtitle, kind FROM entities WHERE LOWER(title) LIKE ? OR LOWER(subtitle) LIKE ? LIMIT 10', [like, like]);
  for (const d of docs) out.push({ type: 'entity', id: d.id, title: d.title, subtitle: `entity · ${d.kind}`, score: 1, created_at: '' });

  // Phase 11: graph query — matching entities expand to their neighborhoods
  const gq = await graph.graphQuery(db, q);
  for (const m of gq.matched) {
    const nb = gq.neighborhoods.find(n => n.center.id === m.id);
    out.push({
      type: 'graph', id: m.id, title: `⤫ ${m.label}`,
      subtitle: nb ? `graph · ${nb.nodes.length} neighbors via ${nb.edges.length} links` : `graph · ${m.kind}`,
      score: 0.9, created_at: '',
      neighborhood: nb ?? { center: { id: m.id, kind: m.kind, label: m.label, degree: 0, weight: 0 }, nodes: [], edges: [] },
    });
  }

  const gens = await db.query<any>(
    `SELECT g.id, g.model_id, g.kind, g.created_at FROM generations g JOIN executions e ON e.id = g.execution_id
     WHERE e.user_id = ? AND LOWER(COALESCE(g.output, '')) LIKE ? LIMIT 10`, [req.user.id, like]);
  for (const g of gens) out.push({ type: 'generation', id: g.id, title: `Generation ${g.kind}`, subtitle: g.model_id, score: 0.8, created_at: g.created_at });

  return out.sort((a, b) => b.score - a.score);
});


// ─── SSE realtime stream (§27) ─────────────────────────────────────────────
app.get('/api/stream', async (req: any, reply: any) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(':ok\n\n');
  let last = new Date(Date.now() - 5000).toISOString();
  // replay recent events so a fresh page load has activity
  const recent = await bus.tail(last, 50);
  for (const ev of recent) reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  last = recent.length ? recent[recent.length - 1].created_at : last;

  const unsub = await broker.subscribe(CHANNEL, (_ch, payload) => {
    const ev = payload as any;
    // Volatile token events bypass the cursor (they are never persisted) —
    // send them straight through so streaming feels live on every panel.
    if (ev?.type === 'agent.token') { reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`); return; }
    if (ev?.created_at && ev.created_at > last) {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      last = ev.created_at;
    }
  });
  const ping = setInterval(() => { try { reply.raw.write(':ping\n\n'); } catch { /* closed */ } }, 15000);
  req.raw.on('close', () => { clearInterval(ping); unsub(); });
});
}
