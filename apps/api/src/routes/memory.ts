/**
 * memory routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as store from '../modules/store';
import * as memory from '../modules/memory';
import { backfillEntities } from '../modules/entities';
import { getWorkingMemory, appendFact } from '../modules/workingmemory';
import { requireOwned, NOT_FOUND } from '../modules/authz';
import { MemoryCreateInput, MemoryBackfillInput, WorkingMemoryFactInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerMemoryRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus } = ctx;

// ─── memory ────────────────────────────────────────────────────────────────
app.get('/api/memory', async (req: any) => {
  const q = String(req.query?.q ?? '');
  let rows: any[];
  if (q) rows = await memory.searchMemory(db, { user_id: req.user.id, query: q, k: 20 });
  else rows = await memory.listMemories(db, req.user.id, {
    type: req.query?.type, project_id: req.query?.project_id, limit: 200,
  });
  // Phase 5: attach graph entity refs ("kind:slug") for the chips in the UI
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const joins = await db.query<any>(
      `SELECT memory_id, entity_id FROM memory_entities WHERE memory_id IN (${ids.map(() => '?').join(',')})`, ids);
    const byMem = new Map<string, string[]>();
    for (const j of joins) {
      if (!byMem.has(j.memory_id)) byMem.set(j.memory_id, []);
      byMem.get(j.memory_id)!.push(j.entity_id);
    }
    for (const r of rows) (r as any).entity_refs = byMem.get(r.id) ?? [];
  }
  return rows;
});
app.post('/api/memory', async (req: any, reply: any) => {
  const parsed = MemoryCreateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const { record, deduped } = await memory.createMemory(db, {
    user_id: req.user.id, type: d.type, content: d.content, summary: d.summary,
    importance: d.importance, source: d.source, project_id: d.project_id,
  });
  await bus.emit('memory.created', { id: record.id, type: record.type, summary: record.summary.slice(0, 120) },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'memory', target_id: record.id });
  return { ...record, deduplicated: !!deduped };
});
app.get('/api/memory/search', async (req: any) =>
  memory.searchMemory(db, { user_id: req.user.id, query: String(req.query?.q ?? ''), k: 20 }));
app.delete('/api/memory/:id', async (req: any) => {
  const m = await memory.getMemory(db, req.params.id);
  if (!m || m.user_id !== req.user.id) return { ok: false };
  return { ok: await memory.deleteMemory(db, req.params.id) };
});
app.post('/api/memory/maintain', async (req: any) => {
  const decayed = await memory.decayMemories(db, req.user.id);
  const { merged } = await memory.consolidateMemories(db, req.user.id);
  if (decayed || merged) {
    await bus.emit('memory.consolidated', { decayed, merged }, { actor_type: 'system' });
  }
  return { decayed, merged };
});

// ─── Phase 5: semantic memory ─────────────────────────────────────────────
// vector driver state + semantic search (vector leg through the active port)
app.get('/api/memory/vector-stats', async () => {
  const vi = memory.getVectorIndex();
  return vi ? vi.stats() : { kind: 'none', dim: 0, provider: 'unset' };
});
app.post('/api/memory/entities/backfill', async (req: any) => {
  const parsed = MemoryBackfillInput.safeParse(req.body ?? {});
  const limit = parsed.success ? (parsed.data as any).limit : 200;
  const res = await backfillEntities(db, limit);
  await bus.emit('memory.entities.extracted', { backfill: true, ...res }, { actor_type: 'user', actor_id: req.user.id });
  return res;
});
app.get('/api/memory/entities/:id', async (req: any) => {
  // memories linked to an extracted entity (id format "<kind>:<slug>")
  const mems = await memory.memoriesForEntity(db, String(req.params.id));
  return { entity: String(req.params.id), memories: mems.map(m => ({ id: m.id, type: m.type, summary: m.summary, updated_at: m.updated_at })) };
});

// ─── Phase 5: working memory ──────────────────────────────────────────────
// Owner-scoped: a window carries the execution's pinned memories + step facts.
app.get('/api/executions/:id/working-memory', async (req: any, reply: any) => {
  const g = await requireOwned(() => store.getExecution(db, String(req.params.id)), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  const wm = await getWorkingMemory(db, String(req.params.id));
  if (!wm) return reply.code(404).send({ error: 'no working-memory window for this execution' });
  return wm;
});
app.post('/api/executions/:id/working-memory/facts', async (req: any, reply: any) => {
  const parsed = WorkingMemoryFactInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const g = await requireOwned(() => store.getExecution(db, String(req.params.id)), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  const wm = await appendFact(db, String(req.params.id), {
    text: parsed.data.text, source: parsed.data.source, step: parsed.data.step,
  });
  if (!wm) return reply.code(404).send({ error: 'no working-memory window for this execution' });
  return wm;
});
}
