/** Phase 6 tests: dependency graph + cycle guard, blocked-status automation,
 * dependency-aware sprint planning, milestones, rollups, deadline automations. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import * as store from '../modules/store';
import * as projects from '../modules/projects';
import { runDeadlineSweep, clearDeadlineAlerts } from '../modules/automations';
import { heuristicPlan } from '../gateway/providers';

let db: SqliteDataPort;
let bus: EventBus;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

let projectId: string;
let taskA: any, taskB: any, taskC: any, taskD: any;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase6-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['u1', 'tester', 'x:y', 'T', now(), now()]);
  bus = new EventBus(db, new InProcessBroker());

  const p = await store.createProject(db, { name: 'Apollo', created_by: 'u1' });
  projectId = p.id;
  taskA = await store.createTask(db, { title: 'Design schema', project_id: projectId, created_by: 'u1' });
  taskB = await store.createTask(db, { title: 'Build API', project_id: projectId, created_by: 'u1' });
  taskC = await store.createTask(db, { title: 'Write tests', project_id: projectId, created_by: 'u1' });
  taskD = await store.createTask(db, { title: 'Deploy', project_id: projectId, created_by: 'u1' });
}, 30000);

afterAll(async () => { await db.close().catch(() => {}); });

// ─── dependencies ────────────────────────────────────────────────────────────
describe('phase 6 — dependency graph', () => {
  it('adds edges and auto-blocks the dependent task', async () => {
    const r1 = await projects.addDependency(db, taskB.id, taskA.id); // B waits on A
    expect(r1.ok).toBe(true);
    const r2 = await projects.addDependency(db, taskC.id, taskB.id); // C waits on B
    expect(r2.ok).toBe(true);
    const r3 = await projects.addDependency(db, taskD.id, taskC.id); // D waits on C
    expect(r3.ok).toBe(true);
    // dependents are blocked automatically
    expect((await store.getTask(db, taskB.id))!.status).toBe('blocked');
    expect((await store.getTask(db, taskC.id))!.status).toBe('blocked');
    expect((await store.getTask(db, taskD.id))!.status).toBe('blocked');
    // A has no deps → stays todo
    expect((await store.getTask(db, taskA.id))!.status).toBe('todo');
  });

  it('rejects self-dependency, duplicates, unknown tasks, and cycles', async () => {
    const self = await projects.addDependency(db, taskA.id, taskA.id);
    expect(self.ok).toBe(false);
    const dupe = await projects.addDependency(db, taskB.id, taskA.id);
    expect(dupe.ok).toBe(false);
    expect((dupe as any).error).toContain('exists');
    const missing = await projects.addDependency(db, taskA.id, uid());
    expect(missing.ok).toBe(false);
    // cycle: A depends on B, but B already depends on A
    const cycle = await projects.addDependency(db, taskA.id, taskD.id);
    expect(cycle.ok).toBe(false);
    expect((cycle as any).error).toContain('cycle');
  });

  it('completing a task cascades: unblocks dependents level by level', async () => {
    await store.updateTask(db, taskA.id, { status: 'done' });
    const unblocked = await projects.cascadeUnblock(db, taskA.id);
    expect(unblocked).toContain(taskB.id);
    expect((await store.getTask(db, taskB.id))!.status).toBe('todo'); // unblocked
    expect((await store.getTask(db, taskC.id))!.status).toBe('blocked'); // still waits on B
    // finish B → C unblocks, D stays blocked
    await store.updateTask(db, taskB.id, { status: 'done' });
    await projects.cascadeUnblock(db, taskB.id);
    expect((await store.getTask(db, taskC.id))!.status).toBe('todo');
    expect((await store.getTask(db, taskD.id))!.status).toBe('blocked');
  });

  it('dependencyOrder computes topological levels', async () => {
    // rebuild a fresh known state: C done? no — use a fresh project for clarity
    const p2 = await store.createProject(db, { name: 'Order Test', created_by: 'u1' });
    const t1 = await store.createTask(db, { title: 't1', project_id: p2.id, created_by: 'u1' });
    const t2 = await store.createTask(db, { title: 't2', project_id: p2.id, created_by: 'u1' });
    const t3 = await store.createTask(db, { title: 't3', project_id: p2.id, created_by: 'u1' });
    const t4 = await store.createTask(db, { title: 't4', project_id: p2.id, created_by: 'u1' });
    await projects.addDependency(db, t2.id, t1.id);
    await projects.addDependency(db, t3.id, t1.id);
    await projects.addDependency(db, t4.id, t2.id);
    await projects.addDependency(db, t4.id, t3.id);
    const order = await projects.dependencyOrder(db, p2.id);
    const byId = new Map(order.map(o => [o.task_id, o]));
    expect(byId.get(t1.id)!.level).toBe(0);
    expect(byId.get(t2.id)!.level).toBe(1);
    expect(byId.get(t3.id)!.level).toBe(1);
    expect(byId.get(t4.id)!.level).toBe(2);
    // sorted by level ascending
    for (let i = 1; i < order.length; i++) expect(order[i].level).toBeGreaterThanOrEqual(order[i - 1].level);
  });

  it('removeDependency unblocks and is 404-safe', async () => {
    const p3 = await store.createProject(db, { name: 'Remove Test', created_by: 'u1' });
    const t1 = await store.createTask(db, { title: 'r1', project_id: p3.id, created_by: 'u1' });
    const t2 = await store.createTask(db, { title: 'r2', project_id: p3.id, created_by: 'u1' });
    await projects.addDependency(db, t2.id, t1.id);
    expect((await store.getTask(db, t2.id))!.status).toBe('blocked');
    expect(await projects.removeDependency(db, t2.id, t1.id)).toBe(true);
    expect((await store.getTask(db, t2.id))!.status).toBe('todo');
    expect(await projects.removeDependency(db, t2.id, t1.id)).toBe(false); // already gone
  });
});

// ─── dependency-aware sprint planning ────────────────────────────────────────
describe('phase 6 — sprint planning', () => {
  it('materializeSprintPlan creates sprint + tasks + edges + ordered schedule', async () => {
    const res = await projects.materializeSprintPlan(db, {
      project_id: projectId, name: 'Apollo Sprint 1', objective: 'ship the API',
      tasks: [
        { title: 'Spec the API', description: 'write the spec', priority: 'high', depends_on_titles: [] },
        { title: 'Code the API', description: '', priority: 'urgent', depends_on_titles: ['Spec the API'] },
        { title: 'Test the API', description: '', priority: 'high', depends_on_titles: ['Code the API'] },
      ],
    });
    expect(res.tasks.length).toBe(3);
    expect(res.blocked_count).toBe(2); // Code + Test blocked by deps
    // schedule is level-sorted
    const levels = res.order.filter(o => res.tasks.some(t => t.id === o.task_id)).map(o => o.level);
    expect(levels).toEqual([0, 1, 2]);
    // blocked statuses materialized
    const code = res.tasks.find(t => t.title === 'Code the API')!;
    expect((await store.getTask(db, code.id))!.status).toBe('blocked');
    // sprint is active with started_at
    expect(res.sprint.status).toBe('active');
    expect(res.sprint.started_at).not.toBeNull();
  });

  it('planner heuristics: sprint-plan request → sprint.plan step with parsed args', () => {
    const plan = heuristicPlan('plan a sprint for the authentication service in project Apollo', null as any);
    const step = plan.steps.find(s => (s as any).tool === 'sprint.plan') as any;
    expect(step).toBeDefined();
    const tasks = JSON.parse(step.args.tasks_json);
    expect(tasks.length).toBe(4);
    expect(tasks[0].title).toMatch(/^Design:/);
    expect(tasks[1].depends_on_titles).toEqual([tasks[0].title]);
    expect(step.args.project_name).toBe('Apollo');
  });

  it('planner heuristics: dependency phrasing → task.depend step with titles', () => {
    const plan = heuristicPlan('make task "Write docs" depend on "Test the API"', null as any);
    const step = plan.steps.find(s => (s as any).tool === 'task.depend') as any;
    expect(step).toBeDefined();
    expect(step.args.task_title).toBe('Write docs');
    expect(step.args.depends_on_title).toBe('Test the API');
  });
});

// ─── milestones ─────────────────────────────────────────────────────────────
describe('phase 6 — milestones', () => {
  it('create → reach transitions and events', async () => {
    const m = await projects.createMilestone(db, { project_id: projectId, name: 'API shipped', due_date: new Date(Date.now() + 86400000).toISOString() });
    expect(m.status).toBe('open');
    const reached = await projects.updateMilestone(db, m.id, { status: 'reached' });
    expect(reached!.status).toBe('reached');
    expect(reached!.reached_at).not.toBeNull();
  });

  it('past-due open milestones flip to missed on the sweep', async () => {
    const m = await projects.createMilestone(db, { project_id: projectId, name: 'Ancient deadline', due_date: new Date(Date.now() - 86400000).toISOString() });
    const sweep = await runDeadlineSweep(db, bus);
    expect(sweep.milestones_missed).toBeGreaterThanOrEqual(1);
    const after = await projects.getMilestone(db, m.id);
    expect(after!.status).toBe('missed');
  });
});

// ─── rollup ──────────────────────────────────────────────────────────────────
describe('phase 6 — progress rollup', () => {
  it('aggregates tasks, blockers, sprints, milestones, overdue', async () => {
    // give one open task a past deadline
    const overdueTask = await store.createTask(db, { title: 'Late thing', project_id: projectId, created_by: 'u1' });
    await store.updateTask(db, overdueTask.id, { deadline: new Date(Date.now() - 3600000).toISOString() });
    const r = await projects.projectRollup(db, projectId);
    expect(r).not.toBeNull();
    expect(r!.tasks.total).toBeGreaterThanOrEqual(4);
    expect(r!.blocked_tasks.length).toBeGreaterThan(0);
    expect(r!.blocked_tasks[0].waiting_on.length).toBeGreaterThan(0); // names, not ids
    expect(r!.active_sprints.length).toBeGreaterThan(0);
    expect(r!.active_sprints[0].tasks_total).toBeGreaterThanOrEqual(3);
    expect(r!.overdue_tasks.length).toBeGreaterThan(0);
    expect(r!.milestones.total).toBeGreaterThanOrEqual(2);
    expect(typeof r!.completion_pct).toBe('number');
  });
});

// ─── deadline automations ────────────────────────────────────────────────────
describe('phase 6 — deadline automations', () => {
  it('fires overdue + due-soon alerts once (deduped), then resets on completion', async () => {
    const overdueT = await store.createTask(db, { title: 'Overdue automation task', project_id: projectId, created_by: 'u1' });
    await store.updateTask(db, overdueT.id, { deadline: new Date(Date.now() - 7200000).toISOString() });
    const soonT = await store.createTask(db, { title: 'Due soon task', project_id: projectId, created_by: 'u1' });
    await store.updateTask(db, soonT.id, { deadline: new Date(Date.now() + 2 * 3600000).toISOString() });

    const first = await runDeadlineSweep(db, bus);
    expect(first.overdue_alerts).toBeGreaterThanOrEqual(1);
    expect(first.due_soon_alerts).toBeGreaterThanOrEqual(1);

    // second run: same tasks → deduped (no new alerts for them)
    const second = await runDeadlineSweep(db, bus);
    // only previously-alerted tasks here → zero NEW alerts expected
    expect(second.overdue_alerts).toBe(0);
    expect(second.due_soon_alerts).toBe(0);

    // notifications were created for the alerts
    const notifs = await db.query<any>("SELECT COUNT(*) AS n FROM notifications WHERE source = 'automation'");
    expect(Number(notifs[0].n)).toBeGreaterThanOrEqual(2);

    // completing a task clears its ledger row so it can re-alert if reopened
    await store.updateTask(db, overdueT.id, { status: 'done' });
    await clearDeadlineAlerts(db, overdueT.id);
    const rows = await db.query<any>('SELECT COUNT(*) AS n FROM deadline_alerts WHERE task_id = ?', [overdueT.id]);
    expect(Number(rows[0].n)).toBe(0);
  });
});

// ─── sprint lifecycle ────────────────────────────────────────────────────────
describe('phase 6 — sprint lifecycle', () => {
  it('start → complete archives unfinished tasks', async () => {
    const p = await store.createProject(db, { name: 'Lifecycle Test', created_by: 'u1' });
    const s = await store.createSprint(db, { project_id: p.id, name: 'S1' }); // planned
    expect(s.status).toBe('planned');
    const t1 = await store.createTask(db, { title: 'done thing', project_id: p.id, sprint_id: s.id, created_by: 'u1' });
    const t2 = await store.createTask(db, { title: 'unfinished thing', project_id: p.id, sprint_id: s.id, created_by: 'u1' });
    await store.updateTask(db, t1.id, { status: 'done' });

    const started = await projects.updateSprint(db, s.id, { status: 'active', started_at: now() });
    expect(started!.status).toBe('active');
    // complete via the route logic: archive non-done
    const tasks = await db.query<any>('SELECT id, status FROM tasks WHERE sprint_id = ?', [s.id]);
    for (const t of tasks) {
      if (!['done', 'archived'].includes(t.status)) await store.updateTask(db, t.id, { status: 'archived' });
    }
    const completed = await projects.updateSprint(db, s.id, { status: 'completed', completed_at: now() });
    expect(completed!.status).toBe('completed');
    expect(completed!.completed_at).not.toBeNull();
    expect((await store.getTask(db, t2.id))!.status).toBe('archived');
    expect((await store.getTask(db, t1.id))!.status).toBe('done');
  });
});
