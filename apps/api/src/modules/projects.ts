/**
 * Projects/Sprints engine (Phase 6) — dependency graph, blockers, milestones,
 * sprint lifecycle, dependency-aware planning, progress rollups, deadline checks.
 *
 * The dependency graph is a DAG guarded at write time (cycle rejection), and
 * task status automation follows it: a task whose dependencies are all done is
 * unblocked (todo/in_progress), a task with unfinished dependencies is blocked.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { TaskRecord, MilestoneRecord, SprintRecord, DependencyOrder } from '@agentic/contracts';

// ─── dependencies ───────────────────────────────────────────────────────────

/** All dependency edges for a set of tasks (both columns). */
export async function listDependencies(db: DataPort, taskId?: string): Promise<{ task_id: string; depends_on: string }[]> {
  if (taskId) {
    const rows = await db.query<any>(
      'SELECT task_id, depends_on FROM task_dependencies WHERE task_id = ? OR depends_on = ?', [taskId, taskId]);
    return rows;
  }
  return db.query<any>('SELECT task_id, depends_on FROM task_dependencies');
}

/** Dependencies that block a given task (its `depends_on` set). */
export async function dependenciesOf(db: DataPort, taskId: string): Promise<string[]> {
  const rows = await db.query<any>('SELECT depends_on FROM task_dependencies WHERE task_id = ?', [taskId]);
  return rows.map(r => r.depends_on);
}

/** Tasks that directly depend on a given task (its dependents). */
export async function dependentsOf(db: DataPort, taskId: string): Promise<string[]> {
  const rows = await db.query<any>('SELECT task_id FROM task_dependencies WHERE depends_on = ?', [taskId]);
  return rows.map(r => r.task_id);
}

/** Add task_id → depends_on. Guards: existence, self-dependency, duplicates,
 *  and CYCLES (adding this edge must not make the graph cyclic). */
export async function addDependency(
  db: DataPort, taskId: string, dependsOn: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (taskId === dependsOn) return { ok: false, error: 'a task cannot depend on itself' };
  const task = await db.query<any>('SELECT id FROM tasks WHERE id = ?', [taskId]);
  const dep = await db.query<any>('SELECT id FROM tasks WHERE id = ?', [dependsOn]);
  if (task.length === 0) return { ok: false, error: `task not found: ${taskId}` };
  if (dep.length === 0) return { ok: false, error: `dependency task not found: ${dependsOn}` };
  // duplicate guard (also covers DBs whose 001 lacked the UNIQUE constraint)
  const dupe = await db.query<any>('SELECT id FROM task_dependencies WHERE task_id = ? AND depends_on = ?', [taskId, dependsOn]);
  if (dupe.length > 0) return { ok: false, error: 'dependency already exists' };
  // cycle guard: can we reach taskId from dependsOn following existing edges?
  if (await wouldCycle(db, taskId, dependsOn)) {
    return { ok: false, error: 'adding this dependency would create a cycle' };
  }
  const id = uuid();
  await db.run('INSERT INTO task_dependencies (id, task_id, depends_on, created_at) VALUES (?,?,?,?)',
    [id, taskId, dependsOn, iso()]);
  // enforce blocked-status automation for the affected task
  await syncTaskBlockedState(db, taskId);
  return { ok: true, id };
}

export async function removeDependency(db: DataPort, taskId: string, dependsOn: string): Promise<boolean> {
  const existing = await db.query<any>('SELECT id FROM task_dependencies WHERE task_id = ? AND depends_on = ?', [taskId, dependsOn]);
  if (existing.length === 0) return false;
  await db.run('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?', [taskId, dependsOn]);
  await syncTaskBlockedState(db, taskId);
  return true;
}

/** DFS from `from` following depends_on edges: if we can reach `to`, adding
 *  from→to would close a cycle (to must eventually depend on from). */
async function wouldCycle(db: DataPort, from: string, to: string): Promise<boolean> {
  // adding edge from → to cycles iff to can already reach from via depends_on
  const visited = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const next = await db.query<any>('SELECT depends_on FROM task_dependencies WHERE task_id = ?', [cur]);
    for (const n of next) stack.push(n.depends_on);
  }
  return false;
}

/** Blocked-status automation: a task with unfinished dependencies is `blocked`
 *  (unless already done/archived); a blocked task whose dependencies are all
 *  done returns to `todo`. Transitively re-checks dependents when a dependency
 *  completes, so finishing a task unblocks its children. */
export async function syncTaskBlockedState(db: DataPort, taskId: string): Promise<'blocked' | 'unblocked' | 'unchanged'> {
  const rows = await db.query<any>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  const task = rows[0];
  if (!task || ['done', 'archived'].includes(task.status)) return 'unchanged';
  const deps = await dependenciesOf(db, taskId);
  const openDeps: string[] = [];
  for (const d of deps) {
    const r = await db.query<any>("SELECT status FROM tasks WHERE id = ?", [d]);
    if (!r[0] || !['done', 'archived'].includes(r[0].status)) openDeps.push(d);
  }
  if (openDeps.length > 0 && task.status !== 'blocked') {
    await db.run("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?", [iso(), taskId]);
    return 'blocked';
  }
  if (openDeps.length === 0 && task.status === 'blocked') {
    await db.run("UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?", [iso(), taskId]);
    return 'unblocked';
  }
  return 'unchanged';
}

/** After a task completes: unblock its dependents (cascade). Returns how many
 *  tasks transitioned blocked → todo. */
export async function cascadeUnblock(db: DataPort, taskId: string): Promise<string[]> {
  const dependents = await dependentsOf(db, taskId);
  const unblocked: string[] = [];
  for (const d of dependents) {
    if ((await syncTaskBlockedState(db, d)) === 'unblocked') unblocked.push(d);
  }
  return unblocked;
}

/** Topological levels: level 0 = no dependencies, level N = 1 + max(level of deps).
 *  Tasks in the same level can run in parallel. Deterministic order. */
export async function dependencyOrder(db: DataPort, projectId?: string): Promise<DependencyOrder[]> {
  const tasks = await db.query<any>(
    projectId ? 'SELECT id FROM tasks WHERE project_id = ?' : 'SELECT id FROM tasks',
    projectId ? [projectId] : [],
  );
  const ids = new Set(tasks.map(t => t.id));
  const edges = await db.query<any>(
    projectId
      ? `SELECT td.task_id, td.depends_on FROM task_dependencies td JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?`
      : 'SELECT task_id, depends_on FROM task_dependencies',
    projectId ? [projectId] : [],
  );
  const depsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.task_id)) continue; // dep outside project scope still counts below
    if (!depsOf.has(e.task_id)) depsOf.set(e.task_id, []);
    depsOf.get(e.task_id)!.push(e.depends_on);
  }
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const compute = (id: string): number => {
    if (level.has(id)) return level.get(id)!;
    if (visiting.has(id)) return 0; // cycle (guarded at write, defensive here)
    visiting.add(id);
    const deps = depsOf.get(id) ?? [];
    const lvl = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(compute));
    visiting.delete(id);
    level.set(id, lvl);
    return lvl;
  };
  const out: DependencyOrder[] = [];
  for (const t of tasks) out.push({ task_id: t.id, level: compute(t.id), depends_on: depsOf.get(t.id) ?? [] });
  out.sort((a, b) => a.level - b.level || a.task_id.localeCompare(b.task_id));
  return out;
}

// ─── milestones ─────────────────────────────────────────────────────────────

export async function createMilestone(
  db: DataPort, m: { project_id: string; name: string; description?: string; due_date?: string | null },
): Promise<MilestoneRecord> {
  const now = iso();
  const rec: MilestoneRecord = {
    id: uuid(), project_id: m.project_id, name: m.name, description: m.description ?? '',
    due_date: m.due_date ?? null, status: 'open', reached_at: null,
    created_at: now, updated_at: now,
  };
  await db.run(
    `INSERT INTO milestones (id, project_id, name, description, due_date, status, reached_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.project_id, rec.name, rec.description, rec.due_date, rec.status, null, rec.created_at, rec.updated_at],
  );
  return rec;
}

export async function listMilestones(db: DataPort, projectId?: string): Promise<MilestoneRecord[]> {
  const rows = projectId
    ? await db.query<any>('SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at', [projectId])
    : await db.query<any>('SELECT * FROM milestones ORDER BY created_at');
  return rows.map(parseMilestone);
}

export async function updateMilestone(
  db: DataPort, id: string, fields: { name?: string; description?: string; due_date?: string | null; status?: 'open' | 'reached' | 'missed' },
): Promise<MilestoneRecord | null> {
  const allowed = ['name', 'description', 'due_date', 'status'];
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`); vals.push(v);
  }
  if (fields.status === 'reached') { sets.push('reached_at = ?'); vals.push(iso()); }
  if (fields.status === 'missed') { sets.push('reached_at = ?'); vals.push(null); }
  if (sets.length === 0) return getMilestone(db, id);
  vals.push(iso(), id);
  await db.run(`UPDATE milestones SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return getMilestone(db, id);
}

export async function getMilestone(db: DataPort, id: string): Promise<MilestoneRecord | null> {
  const rows = await db.query<any>('SELECT * FROM milestones WHERE id = ?', [id]);
  return rows[0] ? parseMilestone(rows[0]) : null;
}

export async function deleteMilestone(db: DataPort, id: string): Promise<boolean> {
  const existing = await db.query<any>('SELECT id FROM milestones WHERE id = ?', [id]);
  if (existing.length === 0) return false;
  await db.run('DELETE FROM milestones WHERE id = ?', [id]);
  return true;
}

function parseMilestone(r: any): MilestoneRecord {
  return {
    id: r.id, project_id: r.project_id, name: r.name, description: r.description,
    due_date: r.due_date, status: r.status, reached_at: r.reached_at,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

// ─── sprint lifecycle ───────────────────────────────────────────────────────

export async function updateSprint(
  db: DataPort, id: string, fields: Partial<SprintRecord>,
): Promise<SprintRecord | null> {
  const allowed = ['name', 'objective', 'status', 'deadline', 'started_at', 'completed_at'];
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k) || v === undefined) continue;
    sets.push(`${k} = ?`); vals.push(v);
  }
  if (sets.length === 0) return getSprint(db, id);
  vals.push(iso(), id);
  await db.run(`UPDATE sprints SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return getSprint(db, id);
}

export async function getSprint(db: DataPort, id: string): Promise<SprintRecord | null> {
  const rows = await db.query<any>('SELECT * FROM sprints WHERE id = ?', [id]);
  return rows[0] ?? null;
}

// ─── dependency-aware sprint planning (the Planner agent's engine) ──────────

export interface PlannedTask { title: string; description: string; priority: 'low' | 'medium' | 'high' | 'urgent'; depends_on_titles: string[] }

/**
 * Materialize a sprint plan: create the sprint, create its tasks, wire the
 * dependency edges (by title), enforce blocked-status, and emit a dependency-
 * ordered execution schedule. Used by the sprint.plan tool and the command
 * center — the Planner agent's planning engine.
 */
export async function materializeSprintPlan(
  db: DataPort,
  plan: { project_id: string; name: string; objective?: string; deadline?: string | null; tasks: PlannedTask[] },
): Promise<{ sprint: SprintRecord; tasks: TaskRecord[]; order: DependencyOrder[]; blocked_count: number }> {
  // 1) create the sprint (started — planning IS the start of execution)
  const now = iso();
  const sprint: SprintRecord = {
    id: uuid(), project_id: plan.project_id, name: plan.name, objective: plan.objective ?? '',
    status: 'active', deadline: plan.deadline ?? null,
    created_at: now, updated_at: now, started_at: now, completed_at: null,
  };
  await db.run(
    `INSERT INTO sprints (id, project_id, name, objective, status, deadline, created_at, updated_at, started_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [sprint.id, sprint.project_id, sprint.name, sprint.objective, sprint.status, sprint.deadline,
     sprint.created_at, sprint.updated_at, sprint.started_at, null],
  );

  // 2) create tasks (title → id map for edge wiring)
  const byTitle = new Map<string, TaskRecord>();
  const tasks: TaskRecord[] = [];
  for (const t of plan.tasks) {
    const rec = await createPlannedTask(db, t, plan.project_id, sprint.id);
    byTitle.set(t.title, rec);
    tasks.push(rec);
  }

  // 3) wire dependency edges (cycle-guarded; unknown titles are skipped)
  let blockedCount = 0;
  for (const t of plan.tasks) {
    const task = byTitle.get(t.title)!;
    for (const depTitle of t.depends_on_titles) {
      const dep = byTitle.get(depTitle);
      if (!dep) continue; // planner referenced an unknown task — skip the edge
      await addDependency(db, task.id, dep.id);
    }
    if ((await dependenciesOf(db, task.id)).length > 0) blockedCount++;
  }

  // 4) dependency-ordered execution schedule
  const order = await dependencyOrder(db, plan.project_id);
  return { sprint, tasks, order, blocked_count: blockedCount };
}

async function createPlannedTask(db: DataPort, t: PlannedTask, projectId: string, sprintId: string): Promise<TaskRecord> {
  const now = iso();
  const rec: TaskRecord = {
    id: uuid(), project_id: projectId, sprint_id: sprintId,
    title: t.title, description: t.description ?? '', status: 'todo',
    priority: t.priority ?? 'medium', deadline: null,
    assignee_agent_id: null, labels: [], created_by: null,
    created_at: now, updated_at: now, completed_at: null,
  };
  await db.run(
    `INSERT INTO tasks (id, project_id, sprint_id, title, description, status, priority, deadline,
      assignee_agent_id, labels, created_by, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.project_id, rec.sprint_id, rec.title, rec.description, rec.status, rec.priority,
     rec.deadline, rec.assignee_agent_id, JSON.stringify(rec.labels), rec.created_by, rec.created_at, rec.updated_at, null],
  );
  return rec;
}

// ─── progress rollups ───────────────────────────────────────────────────────

export interface ProjectRollup {
  project_id: string;
  tasks: { total: number; done: number; in_progress: number; blocked: number; todo: number; archived: number };
  completion_pct: number;
  blocked_tasks: { id: string; title: string; waiting_on: string[] }[];
  active_sprints: { id: string; name: string; status: string; tasks_total: number; tasks_done: number; completion_pct: number }[];
  milestones: { total: number; reached: number; missed: number; open: number; next_due: MilestoneRecord | null };
  overdue_tasks: { id: string; title: string; deadline: string }[];
}

/** Aggregated project state: one query pass, then in-memory shaping — this is
 *  what the project page rollup bar and the Monitor agent consume. */
export async function projectRollup(db: DataPort, projectId: string): Promise<ProjectRollup | null> {
  const p = await db.query<any>('SELECT id FROM projects WHERE id = ?', [projectId]);
  if (p.length === 0) return null;
  const tasks = await db.query<any>('SELECT id, title, status, deadline FROM tasks WHERE project_id = ?', [projectId]);
  const sprints = await db.query<any>("SELECT * FROM sprints WHERE project_id = ?", [projectId]);
  const miles = await listMilestones(db, projectId);
  const edges = await db.query<any>(
    `SELECT td.task_id, td.depends_on FROM task_dependencies td JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?`,
    [projectId],
  );
  const depsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!depsOf.has(e.task_id)) depsOf.set(e.task_id, []);
    depsOf.get(e.task_id)!.push(e.depends_on);
  }
  const statusOf = new Map(tasks.map(t => [t.id, t.status]));
  const titleOf = new Map(tasks.map(t => [t.id, t.title]));

  const counts = { total: tasks.length, done: 0, in_progress: 0, blocked: 0, todo: 0, archived: 0 };
  for (const t of tasks) counts[t.status as keyof typeof counts]++;
  const nowIso = iso();
  const overdue = tasks.filter(t => t.deadline && t.deadline < nowIso && !['done', 'archived'].includes(t.status))
    .map(t => ({ id: t.id, title: t.title, deadline: t.deadline }));

  const blockedTasks = tasks.filter(t => t.status === 'blocked').map(t => ({
    id: t.id, title: t.title,
    waiting_on: (depsOf.get(t.id) ?? []).filter(d => !['done', 'archived'].includes(statusOf.get(d) ?? '')).map(d => titleOf.get(d) ?? d.slice(0, 8)),
  }));

  const sprintRows = sprints.filter(s => ['planned', 'active'].includes(s.status));
  const activeSprints = [] as ProjectRollup['active_sprints'];
  for (const s of sprintRows) {
    const st = await db.query<any>('SELECT status FROM tasks WHERE sprint_id = ?', [s.id]);
    const total = st.length;
    const done = st.filter(t => t.status === 'done').length;
    activeSprints.push({
      id: s.id, name: s.name, status: s.status, tasks_total: total, tasks_done: done,
      completion_pct: total ? Math.round(100 * done / total) : 0,
    });
  }

  const openMilestones = miles.filter(m => m.status === 'open');
  const nextDue = openMilestones.filter(m => m.due_date).sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1))[0] ?? null;

  return {
    project_id: projectId,
    tasks: counts,
    completion_pct: counts.total ? Math.round(100 * counts.done / counts.total) : 0,
    blocked_tasks: blockedTasks,
    active_sprints: activeSprints,
    milestones: { total: miles.length, reached: miles.filter(m => m.status === 'reached').length,
      missed: miles.filter(m => m.status === 'missed').length, open: openMilestones.length, next_due: nextDue },
    overdue_tasks: overdue,
  };
}

// ─── deadline checks (the automation engine's data source) ─────────────────

/** Open tasks with deadlines: overdue (deadline < now) and due-soon (≤ 24h). */
export async function deadlineScan(db: DataPort, opts: { dueSoonHours?: number; limit?: number } = {}): Promise<{
  overdue: TaskRecord[]; due_soon: TaskRecord[];
}> {
  const limit = opts.limit ?? 200;
  const rows = await db.query<any>(
    `SELECT * FROM tasks WHERE deadline IS NOT NULL AND status NOT IN ('done','archived')
     ORDER BY deadline ASC LIMIT ?`, [limit]);
  const nowMs = Date.now();
  const soonMs = nowMs + (opts.dueSoonHours ?? 24) * 3600 * 1000;
  const overdue: TaskRecord[] = [];
  const dueSoon: TaskRecord[] = [];
  for (const r of rows) {
    const dl = Date.parse(r.deadline);
    if (Number.isNaN(dl)) continue;
    if (dl < nowMs) overdue.push(r);
    else if (dl <= soonMs) dueSoon.push(r);
  }
  return { overdue, due_soon: dueSoon };
}
