/**
 * projects routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import { iso } from '../infra/types';
import * as store from '../modules/store';
import * as projects from '../modules/projects';
import { runDeadlineSweep, clearDeadlineAlerts } from '../modules/automations';
import { ProjectCreateInput, TaskCreateInput, TaskUpdateInput, SprintCreateInput, TaskDependencyInput, MilestoneCreateInput, SprintTransitionInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerProjectsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus } = ctx;

// ─── projects / tasks / sprints ────────────────────────────────────────────
app.get('/api/projects', async () => store.listProjects(db));
app.post('/api/projects', async (req: any, reply: any) => {
  const parsed = ProjectCreateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const p = await store.createProject(db, { ...parsed.data, created_by: req.user.id });
  await bus.emit('project.created', { id: p.id, name: p.name }, { actor_type: 'user', actor_id: req.user.id, target_type: 'project', target_id: p.id });
  return p;
});
app.get('/api/projects/:id', async (req: any) => {
  const p = await store.getProject(db, req.params.id);
  if (!p) return { error: 'not found' };
  const [tasks, sprints, links] = await Promise.all([
    store.listTasks(db, { project_id: p.id }),
    store.listSprints(db, p.id),
    store.listLinks(db, { type: 'project', id: p.id }),
  ]);
  return { ...p, tasks, sprints, links };
});

app.get('/api/tasks', async (req: any) =>
  store.listTasks(db, { project_id: req.query?.project_id, status: req.query?.status, limit: 200 }));
app.post('/api/tasks', async (req: any, reply: any) => {
  const parsed = TaskCreateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  let project_id = d.project_id ?? null;
  if (!project_id && d.project_name) {
    const existing = await store.findProjectByName(db, d.project_name);
    project_id = existing ? existing.id : (await store.createProject(db, { name: d.project_name, created_by: req.user.id })).id;
  }
  const t = await store.createTask(db, { ...d, project_id, created_by: req.user.id } as any);
  await bus.emit('task.created', { id: t.id, title: t.title, priority: t.priority },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: t.id });
  return t;
});
app.patch('/api/tasks/:id', async (req: any, reply: any) => {
  const parsed = TaskUpdateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const t = await store.updateTask(db, req.params.id, parsed.data);
  if (!t) return reply.code(404).send({ error: 'not found' });
  await bus.emit(t.status === 'done' ? 'task.completed' : 'task.updated',
    { id: t.id, status: t.status }, { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: t.id });
  // Phase 6: completion cascades — unblock dependents + clear deadline alerts
  let unblocked: string[] = [];
  if (t.status === 'done' || t.status === 'archived') {
    unblocked = await projects.cascadeUnblock(db, t.id);
    await clearDeadlineAlerts(db, t.id).catch(() => {});
    for (const u of unblocked) {
      const ut = await store.getTask(db, u);
      if (ut) await bus.emit('task.unblocked', { id: ut.id, title: ut.title }, { actor_type: 'system', target_type: 'task', target_id: ut.id });
    }
  }
  return t;
});
app.get('/api/tasks/:id', async (req: any) => store.getTask(db, req.params.id));

app.get('/api/sprints', async (req: any) => store.listSprints(db, req.query?.project_id));
app.post('/api/sprints', async (req: any, reply: any) => {
  const parsed = SprintCreateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const s = await store.createSprint(db, { ...parsed.data } as any);
  await bus.emit('sprint.started', { id: s.id, name: s.name }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
  return s;
});
// Phase 6: sprint lifecycle transitions (start/complete/cancel)
app.post('/api/sprints/:id/transition', async (req: any, reply: any) => {
  const parsed = SprintTransitionInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const s = await projects.getSprint(db, req.params.id);
  if (!s) return reply.code(404).send({ error: 'sprint not found' });
  const action = parsed.data.action;
  // state machine: planned → active → completed | cancelled (any → cancelled)
  const now = iso();
  if (action === 'start') {
    if (s.status !== 'planned') return reply.code(409).send({ error: `sprint is ${s.status}, not planned` });
    const updated = await projects.updateSprint(db, s.id, { status: 'active', started_at: now });
    await bus.emit('sprint.started', { id: s.id, name: s.name }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
    return updated;
  }
  if (action === 'complete') {
    if (s.status !== 'active') return reply.code(409).send({ error: `sprint is ${s.status}, not active` });
    // completion rolls up: any non-done sprint tasks are archived
    const tasks = await db.query<any>("SELECT id, status FROM tasks WHERE sprint_id = ?", [s.id]);
    let archived = 0;
    for (const t of tasks) {
      if (!['done', 'archived'].includes(t.status)) {
        await store.updateTask(db, t.id, { status: 'archived' });
        archived++;
      }
    }
    const updated = await projects.updateSprint(db, s.id, { status: 'completed', completed_at: now });
    await bus.emit('sprint.completed', { id: s.id, name: s.name, tasks_archived: archived }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
    return { ...updated, tasks_archived: archived };
  }
  // cancel
  if (['completed', 'cancelled'].includes(s.status)) return reply.code(409).send({ error: `sprint already ${s.status}` });
  const updated = await projects.updateSprint(db, s.id, { status: 'cancelled', completed_at: now });
  await bus.emit('sprint.completed', { id: s.id, name: s.name, cancelled: true }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
  return updated;
});

// ─── Phase 6: dependencies ────────────────────────────────────────────────
app.get('/api/tasks/:id/dependencies', async (req: any) => {
  const taskId = String(req.params.id);
  const [deps, dependents] = await Promise.all([
    projects.dependenciesOf(db, taskId),
    projects.dependentsOf(db, taskId),
  ]);
  return { task_id: taskId, depends_on: deps, blocks: dependents };
});
app.get('/api/projects/:id/dependency-order', async (req: any) => {
  const order = await projects.dependencyOrder(db, String(req.params.id));
  const titles = new Map((await store.listTasks(db, { project_id: String(req.params.id) })).map(t => [t.id, t.title]));
  return order.map(o => ({ ...o, title: titles.get(o.task_id) ?? o.task_id }));
});
app.post('/api/tasks/:id/dependencies', async (req: any, reply: any) => {
  const parsed = TaskDependencyInput.safeParse({ ...req.body, task_id: req.params.id });
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const r = await projects.addDependency(db, String(req.params.id), parsed.data.depends_on);
  if (!r.ok) return reply.code(r.error.includes('not found') ? 404 : 409).send({ error: r.error });
  await bus.emit('task.dependency.added', { task_id: String(req.params.id), depends_on: parsed.data.depends_on },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: String(req.params.id) });
  const task = await store.getTask(db, String(req.params.id));
  if (task?.status === 'blocked') {
    await bus.emit('task.blocked', { id: task.id, title: task.title }, { actor_type: 'system', target_type: 'task', target_id: task.id });
  }
  return { ok: true, id: r.id, task: store.getTask(db, String(req.params.id)) };
});
app.delete('/api/tasks/:id/dependencies/:dependsOn', async (req: any, reply: any) => {
  const ok = await projects.removeDependency(db, String(req.params.id), String(req.params.dependsOn));
  if (!ok) return reply.code(404).send({ error: 'dependency not found' });
  await bus.emit('task.dependency.removed', { task_id: String(req.params.id), depends_on: String(req.params.dependsOn) },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: String(req.params.id) });
  const task = await store.getTask(db, String(req.params.id));
  if (task?.status !== 'blocked' && task) {
    await bus.emit('task.unblocked', { id: task.id, title: task.title }, { actor_type: 'system', target_type: 'task', target_id: task.id });
  }
  return { ok: true };
});

// ─── Phase 6: milestones ────────────────────────────────────────────────────
app.get('/api/projects/:id/milestones', async (req: any) => projects.listMilestones(db, String(req.params.id)));
app.post('/api/projects/:id/milestones', async (req: any, reply: any) => {
  const parsed = MilestoneCreateInput.safeParse({ ...req.body, project_id: req.params.id });
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const m = await projects.createMilestone(db, parsed.data as any);
  await bus.emit('milestone.created', { id: m.id, name: m.name, project_id: m.project_id },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'project', target_id: m.project_id });
  return m;
});
app.patch('/api/milestones/:id', async (req: any, reply: any) => {
  const m = await projects.updateMilestone(db, String(req.params.id), req.body ?? {});
  if (!m) return reply.code(404).send({ error: 'milestone not found' });
  if (req.body?.status === 'reached') {
    await bus.emit('milestone.completed', { id: m.id, name: m.name, project_id: m.project_id },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'project', target_id: m.project_id });
  }
  return m;
});
app.delete('/api/milestones/:id', async (req: any, reply: any) => {
  const ok = await projects.deleteMilestone(db, String(req.params.id));
  if (!ok) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

// ─── Phase 6: progress rollup ───────────────────────────────────────────────
app.get('/api/projects/:id/rollup', async (req: any) => projects.projectRollup(db, String(req.params.id)));

// ─── Phase 6: deadline automations (manual trigger; the timer also runs it) ─
app.post('/api/automations/deadlines/run', async (req: any) => {
  const res = await runDeadlineSweep(db, bus, { dueSoonHours: Number(req.body?.dueSoonHours ?? 24) });
  return res;
});
}
