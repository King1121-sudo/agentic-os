/**
 * Store — repository layer over DataPort. Dialect-neutral SQL, JSON (de)serialization.
 * Every subsystem (tools, runtime, API) goes through these typed functions.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import { syncEntity } from '../infra/migrations';
import { safeJson } from '../kernel/bus';
import type {
  AgentRecord, TaskRecord, ProjectRecord, SprintRecord, MemoryRecord,
  NotificationRecord, LinkRecord, ApprovalRecord, ExecutionRecord, SkillRecord,
} from '@agentic/contracts';

const J = JSON.stringify;

// ─── agents ─────────────────────────────────────────────────────────────────
export async function listAgents(db: DataPort): Promise<AgentRecord[]> {
  const rows = await db.query<any>('SELECT * FROM agents ORDER BY created_at');
  return rows.map(parseAgent);
}
export async function getAgent(db: DataPort, id: string): Promise<AgentRecord | null> {
  const rows = await db.query<any>('SELECT * FROM agents WHERE id = ?', [id]);
  return rows[0] ? parseAgent(rows[0]) : null;
}
export async function getAgentByName(db: DataPort, name: string): Promise<AgentRecord | null> {
  const rows = await db.query<any>('SELECT * FROM agents WHERE name = ?', [name]);
  return rows[0] ? parseAgent(rows[0]) : null;
}
export async function upsertAgent(db: DataPort, a: AgentRecord): Promise<void> {
  await db.run(
    `INSERT INTO agents (id, name, description, system_instructions, model_policy, skills, tools, memory_policy,
      permissions, autonomy_level, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
      system_instructions=excluded.system_instructions, model_policy=excluded.model_policy,
      skills=excluded.skills, tools=excluded.tools, memory_policy=excluded.memory_policy,
      permissions=excluded.permissions, autonomy_level=excluded.autonomy_level,
      status=excluded.status, updated_at=excluded.updated_at`,
    [a.id, a.name, a.description, a.system_instructions, J(a.model_policy), J(a.skills), J(a.tools),
     J(a.memory_policy), J(a.permissions), a.autonomy_level, a.status, a.created_at, a.updated_at],
  );
  await syncEntity(db, 'agent', a.id, a.name, a.description, { status: a.status, autonomy: a.autonomy_level });
}
export async function setAgentStatus(db: DataPort, id: string, status: string): Promise<void> {
  await db.run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', [status, iso(), id]);
}
export function parseAgent(r: any): AgentRecord {
  return {
    id: r.id, name: r.name, description: r.description, system_instructions: r.system_instructions,
    model_policy: safeJson(r.model_policy), skills: safeJson(r.skills), tools: safeJson(r.tools),
    memory_policy: safeJson(r.memory_policy), permissions: safeJson(r.permissions),
    autonomy_level: r.autonomy_level, status: r.status, created_at: r.created_at, updated_at: r.updated_at,
  };
}

// ─── executions ─────────────────────────────────────────────────────────────
export async function insertExecution(db: DataPort, e: Partial<ExecutionRecord> & { id: string; agent_id: string; input: string; user_id: string }): Promise<void> {
  await db.run(
    `INSERT INTO executions (id, agent_id, parent_execution_id, user_id, input, project_id, task_id, status, plan,
      observations, trace, result, error, current_step, tokens_in, tokens_out, cost, started_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.id, e.agent_id, e.parent_execution_id ?? null, e.user_id, e.input, e.project_id ?? null, e.task_id ?? null,
     e.status ?? 'running', e.plan ? J(e.plan) : null, J(e.observations ?? []), J(e.trace ?? []),
     e.result ?? null, e.error ?? null, e.current_step ?? 0, 0, 0, 0, e.started_at ?? iso(), iso(), null],
  );
  await syncEntity(db, 'execution', e.id, `Execution ${e.input.slice(0, 40)}`, `agent:${e.agent_id}`, {});
}
export async function updateExecution(db: DataPort, id: string, fields: Partial<Record<string, unknown>>): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  await db.run(`UPDATE executions SET ${sets}, updated_at = ? WHERE id = ?`, [...keys.map(k => (fields as any)[k]), iso(), id]);
}
export async function getExecution(db: DataPort, id: string): Promise<ExecutionRecord | null> {
  const rows = await db.query<any>('SELECT * FROM executions WHERE id = ?', [id]);
  return rows[0] ? parseExecution(rows[0]) : null;
}
export async function listExecutions(db: DataPort, limit = 50): Promise<ExecutionRecord[]> {
  const rows = await db.query<any>('SELECT * FROM executions ORDER BY started_at DESC LIMIT ?', [limit]);
  return rows.map(parseExecution);
}
export function parseExecution(r: any): ExecutionRecord {
  return {
    id: r.id, agent_id: r.agent_id, parent_execution_id: r.parent_execution_id, user_id: r.user_id, input: r.input,
    project_id: r.project_id, task_id: r.task_id, status: r.status,
    plan: r.plan ? safeJson(r.plan) : null, observations: safeJson(r.observations), trace: safeJson(r.trace),
    result: r.result, error: r.error, current_step: r.current_step,
    tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost: r.cost,
    started_at: r.started_at, updated_at: r.updated_at, completed_at: r.completed_at,
  };
}

// ─── projects / tasks / sprints ─────────────────────────────────────────────
export async function createProject(db: DataPort, p: Partial<ProjectRecord> & { name: string }): Promise<ProjectRecord> {
  const now = iso();
  const rec: ProjectRecord = {
    id: p.id ?? uuid(), name: p.name,
    slug: p.slug ?? slugify(p.name) + '-' + Math.random().toString(36).slice(2, 6),
    description: p.description ?? '', status: p.status ?? 'active', deadline: p.deadline ?? null,
    created_by: p.created_by ?? null, created_at: now, updated_at: now,
  };
  await db.run(
    `INSERT INTO projects (id, name, slug, description, status, deadline, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.name, rec.slug, rec.description, rec.status, rec.deadline, rec.created_by, rec.created_at, rec.updated_at],
  );
  await syncEntity(db, 'project', rec.id, rec.name, rec.description, { status: rec.status });
  return rec;
}
export async function listProjects(db: DataPort): Promise<ProjectRecord[]> {
  return db.query<any>('SELECT * FROM projects ORDER BY created_at DESC');
}
export async function getProject(db: DataPort, id: string): Promise<ProjectRecord | null> {
  const rows = await db.query<any>('SELECT * FROM projects WHERE id = ?', [id]);
  return rows[0] ?? null;
}
export async function findProjectByName(db: DataPort, q: string): Promise<ProjectRecord | null> {
  const rows = await db.query<any>(
    'SELECT * FROM projects WHERE LOWER(name) LIKE ? ORDER BY created_at DESC LIMIT 1', [`%${q.toLowerCase()}%`]);
  return rows[0] ?? null;
}

export async function createTask(db: DataPort, t: Partial<TaskRecord> & { title: string }): Promise<TaskRecord> {
  const now = iso();
  const rec: TaskRecord = {
    id: t.id ?? uuid(), project_id: t.project_id ?? null, sprint_id: t.sprint_id ?? null,
    title: t.title, description: t.description ?? '', status: t.status ?? 'todo',
    priority: t.priority ?? 'medium', deadline: t.deadline ?? null,
    assignee_agent_id: t.assignee_agent_id ?? null, labels: t.labels ?? [],
    created_by: t.created_by ?? null, created_at: now, updated_at: now, completed_at: null,
  };
  await db.run(
    `INSERT INTO tasks (id, project_id, sprint_id, title, description, status, priority, deadline,
      assignee_agent_id, labels, created_by, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.project_id, rec.sprint_id, rec.title, rec.description, rec.status, rec.priority,
     rec.deadline, rec.assignee_agent_id, J(rec.labels), rec.created_by, rec.created_at, rec.updated_at, null],
  );
  await syncEntity(db, 'task', rec.id, rec.title, rec.status, { priority: rec.priority, project_id: rec.project_id });
  return rec;
}
export async function updateTask(db: DataPort, id: string, fields: Record<string, unknown>): Promise<TaskRecord | null> {
  const allowed = ['title', 'description', 'status', 'priority', 'deadline', 'assignee_agent_id', 'sprint_id', 'project_id'];
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`); vals.push(k === 'deadline' && v === '' ? null : v);
  }
  if (fields.status === 'done') { sets.push('completed_at = ?'); vals.push(iso()); }
  if (sets.length === 0) return getTask(db, id);
  vals.push(iso(), id);
  await db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  const t = await getTask(db, id);
  if (t) await syncEntity(db, 'task', t.id, t.title, t.status, { priority: t.priority, project_id: t.project_id });
  return t;
}
export async function getTask(db: DataPort, id: string): Promise<TaskRecord | null> {
  const rows = await db.query<any>('SELECT * FROM tasks WHERE id = ?', [id]);
  return rows[0] ? parseTask(rows[0]) : null;
}
export async function listTasks(db: DataPort, opts: { project_id?: string; status?: string; limit?: number } = {}): Promise<TaskRecord[]> {
  const conds: string[] = []; const params: unknown[] = [];
  if (opts.project_id) { conds.push('project_id = ?'); params.push(opts.project_id); }
  if (opts.status) { conds.push('status = ?'); params.push(opts.status); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  params.push(opts.limit ?? 200);
  const rows = await db.query<any>(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`, params);
  return rows.map(parseTask);
}
export function parseTask(r: any): TaskRecord {
  return {
    id: r.id, project_id: r.project_id, sprint_id: r.sprint_id, title: r.title, description: r.description,
    status: r.status, priority: r.priority, deadline: r.deadline, assignee_agent_id: r.assignee_agent_id,
    labels: safeJson(r.labels), created_by: r.created_by, created_at: r.created_at,
    updated_at: r.updated_at, completed_at: r.completed_at,
  };
}

export async function createSprint(db: DataPort, s: Partial<SprintRecord> & { project_id: string; name: string }): Promise<SprintRecord> {
  const now = iso();
  const rec: SprintRecord = {
    id: s.id ?? uuid(), project_id: s.project_id, name: s.name, objective: s.objective ?? '',
    status: s.status ?? 'planned', deadline: s.deadline ?? null,
    created_at: now, updated_at: now, started_at: null, completed_at: null,
  };
  await db.run(
    `INSERT INTO sprints (id, project_id, name, objective, status, deadline, created_at, updated_at, started_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.project_id, rec.name, rec.objective, rec.status, rec.deadline, rec.created_at, rec.updated_at, null, null],
  );
  await syncEntity(db, 'sprint', rec.id, rec.name, rec.objective, { project_id: rec.project_id, status: rec.status });
  return rec;
}
export async function listSprints(db: DataPort, projectId?: string): Promise<SprintRecord[]> {
  const rows = projectId
    ? await db.query<any>('SELECT * FROM sprints WHERE project_id = ? ORDER BY created_at DESC', [projectId])
    : await db.query<any>('SELECT * FROM sprints ORDER BY created_at DESC');
  return rows;
}

// ─── skills ─────────────────────────────────────────────────────────────────
export async function listSkills(db: DataPort): Promise<SkillRecord[]> {
  const rows = await db.query<any>('SELECT * FROM skills ORDER BY category, name');
  return rows.map(parseSkill);
}
export async function getSkill(db: DataPort, idOrName: string): Promise<SkillRecord | null> {
  const rows = await db.query<any>('SELECT * FROM skills WHERE id = ? OR name = ?', [idOrName, idOrName]);
  return rows[0] ? parseSkill(rows[0]) : null;
}
export function parseSkill(r: any): SkillRecord {
  return {
    id: r.id, name: r.name, description: r.description, category: r.category, parent_id: r.parent_id,
    version: r.version, instructions: r.instructions, steps: safeJson(r.steps),
    required_tools: safeJson(r.required_tools), required_permissions: safeJson(r.required_permissions),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

// ─── notifications ──────────────────────────────────────────────────────────
export async function notify(db: DataPort, n: Partial<NotificationRecord> & { user_id: string; title: string; message: string }): Promise<NotificationRecord> {
  const rec: NotificationRecord = {
    id: n.id ?? uuid(), user_id: n.user_id, title: n.title, message: n.message,
    priority: n.priority ?? 'medium', category: n.category ?? 'system', source: n.source ?? 'system',
    related_type: n.related_type ?? null, related_id: n.related_id ?? null,
    status: 'unread', created_at: iso(), expires_at: n.expires_at ?? null,
  };
  await db.run(
    `INSERT INTO notifications (id, user_id, title, message, priority, category, source, related_type, related_id, status, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.user_id, rec.title, rec.message, rec.priority, rec.category, rec.source,
     rec.related_type, rec.related_id, rec.status, rec.created_at, rec.expires_at],
  );
  return rec;
}
export async function listNotifications(db: DataPort, userId: string, status?: string): Promise<NotificationRecord[]> {
  const rows = status
    ? await db.query<any>('SELECT * FROM notifications WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100', [userId, status])
    : await db.query<any>('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [userId]);
  return rows;
}

// ─── links ──────────────────────────────────────────────────────────────────
export async function createLink(db: DataPort, l: { from_type: string; from_id: string; to_type: string; to_id: string; relation: string; created_by?: string }): Promise<LinkRecord> {
  const rec: LinkRecord = {
    id: uuid(), from_type: l.from_type as any, from_id: l.from_id, to_type: l.to_type as any,
    to_id: l.to_id, relation: l.relation, created_at: iso(), created_by: l.created_by ?? null,
  };
  await db.run(
    'INSERT INTO links (id, from_type, from_id, to_type, to_id, relation, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [rec.id, rec.from_type, rec.from_id, rec.to_type, rec.to_id, rec.relation, rec.created_by, rec.created_at],
  );
  return rec;
}
export async function listLinks(db: DataPort, opts: { type?: string; id?: string; limit?: number } = {}): Promise<LinkRecord[]> {
  const rows = await db.query<any>(
    `SELECT * FROM links WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
     ORDER BY created_at DESC LIMIT ?`,
    [opts.type ?? '', opts.id ?? '', opts.type ?? '', opts.id ?? '', opts.limit ?? 100],
  );
  return rows;
}

// ─── approvals ───────────────────────────────────────────────────────────────
export async function createApproval(db: DataPort, a: { execution_id: string; agent_id: string; tool: string; args: unknown; reason: string }): Promise<ApprovalRecord> {
  const rec: ApprovalRecord = {
    id: uuid(), execution_id: a.execution_id, agent_id: a.agent_id, tool: a.tool,
    args: a.args as any, reason: a.reason, status: 'pending',
    decided_by: null, decided_at: null, created_at: iso(),
  };
  await db.run(
    'INSERT INTO approvals (id, execution_id, agent_id, tool, args, reason, status, decided_by, decided_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [rec.id, rec.execution_id, rec.agent_id, rec.tool, J(rec.args), rec.reason, rec.status, null, null, rec.created_at],
  );
  return rec;
}
export async function listApprovals(db: DataPort, status = 'pending'): Promise<ApprovalRecord[]> {
  const rows = await db.query<any>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100', [status]);
  return rows.map(r => ({ ...r, args: safeJson(r.args) }));
}
export async function decideApproval(db: DataPort, id: string, decision: 'approve' | 'deny', userId: string): Promise<ApprovalRecord | null> {
  await db.run('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?',
    [decision === 'approve' ? 'approved' : 'denied', userId, iso(), id]);
  const rows = await db.query<any>('SELECT * FROM approvals WHERE id = ?', [id]);
  return rows[0] ? { ...rows[0], args: safeJson(rows[0].args) } : null;
}

// ─── audit ──────────────────────────────────────────────────────────────────
export async function audit(db: DataPort, entry: { actor_type: string; actor_id?: string | null; action: string; target_type?: string | null; target_id?: string | null; execution_id?: string | null; meta?: unknown }): Promise<void> {
  await db.run(
    `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, target_type, target_id, execution_id, meta, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), iso(), entry.actor_type, entry.actor_id ?? null, entry.action,
     entry.target_type ?? null, entry.target_id ?? null, entry.execution_id ?? null,
     J(entry.meta ?? {}), iso()],
  );
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
}
