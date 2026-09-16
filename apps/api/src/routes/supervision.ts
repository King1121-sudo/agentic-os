/**
 * supervision routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as store from '../modules/store';
import { mobileBriefing, createEmergencyStop } from '../modules/supervision';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerSupervisionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus, runtime, flowEngine } = ctx;

// ─── Phase 12: mobile supervision ──────────────────────────────────────────
app.get('/api/mobile/briefing', async (req: any) => mobileBriefing(db, req.user.id));

app.post('/api/emergency-stop', async (req: any) => {
  const reason = String((req.body ?? {}).reason ?? 'triggered from supervision surface');
  const es = createEmergencyStop({ db, bus, runtime, flows: flowEngine });
  return es.execute(reason, req.user.id);
});

// ─── dashboard (home widgets data) ────────────────────────────────────────
app.get('/api/dashboard', async (req: any) => {
  const user = req.user;
  const [agents, tasks, projects, notes, events] = await Promise.all([
    store.listAgents(db),
    store.listTasks(db, { limit: 100 }),
    store.listProjects(db),
    store.listNotifications(db, user.id, 'unread'),
    bus.list(30),
  ]);
  // Counts are owner-scoped: generations and tool runs inherit the owning
  // execution's user_id, so each user sees the size of their own world.
  const counts = {
    executions: Number((await db.query<any>('SELECT COUNT(*) AS n FROM executions WHERE user_id = ?', [user.id]))[0]?.n ?? 0),
    memories: Number((await db.query<any>('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?', [user.id]))[0]?.n ?? 0),
    generations: Number((await db.query<any>(
      'SELECT COUNT(*) AS n FROM generations g JOIN executions e ON e.id = g.execution_id WHERE e.user_id = ?', [user.id]))[0]?.n ?? 0),
    tool_runs: Number((await db.query<any>(
      'SELECT COUNT(*) AS n FROM tool_executions t JOIN executions e ON e.id = t.execution_id WHERE e.user_id = ?', [user.id]))[0]?.n ?? 0),
  };
  // Wire-shape guarantee: every array field is a real array even if a
  // subsystem errored — the dashboard must never degrade the UI.
  return {
    agents: Array.isArray(agents) ? agents : [],
    tasks: Array.isArray(tasks) ? tasks : [],
    projects: Array.isArray(projects) ? projects : [],
    notes: Array.isArray(notes) ? notes : [],
    events: Array.isArray(events) ? events : [],
    counts,
  };
});
}
