/**
 * Deadline Automations (Phase 6) — a periodic sweep over tasks and milestones:
 *
 *   - overdue tasks (deadline < now, not done)     → high-priority notification + task.deadline.overdue event
 *   - due-soon tasks (≤ 24h, not done)             → medium-priority notification + task.deadline.due_soon event
 *   - open milestones past due                    → status 'missed' + milestone.missed event
 *
 * Every alert is deduped through the deadline_alerts ledger (UNIQUE task+kind),
 * so each task fires once per kind — re-running the sweep is idempotent.
 * Resolution: completing the task clears its alerts (the ledger row is deleted),
 * so a reopened/edited deadline can alert again.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { EventBus } from '../kernel/bus';
import { deadlineScan } from './projects';
import type { TaskRecord } from '@agentic/contracts';

export interface AutomationResult {
  ran_at: string;
  overdue_alerts: number;
  due_soon_alerts: number;
  milestones_missed: number;
}

/** Fire one alert if not already sent (ledger dedup). Returns true when new. */
async function fireOnce(
  db: DataPort, bus: EventBus | null, taskId: string, kind: 'overdue' | 'due_soon',
  task: TaskRecord, userId: string | null,
): Promise<boolean> {
  const id = uuid();
  try {
    await db.run('INSERT INTO deadline_alerts (id, task_id, kind, alerted_at) VALUES (?,?,?,?)',
      [id, taskId, kind, iso()]);
  } catch {
    return false; // UNIQUE violation → already alerted
  }
  const overdue = kind === 'overdue';
  const hoursLate = overdue
    ? Math.max(1, Math.round((Date.now() - Date.parse(task.deadline ?? iso())) / 3600000))
    : Math.max(1, Math.round((Date.parse(task.deadline ?? iso()) - Date.now()) / 3600000));
  const text = overdue
    ? `Task "${task.title}" is overdue by ~${hoursLate}h (deadline ${task.deadline}).`
    : `Task "${task.title}" is due in ≤${hoursLate}h (deadline ${task.deadline}).`;
  await db.run(
    `INSERT INTO notifications (id, user_id, title, message, priority, category, source, related_type, related_id, status, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), userId ?? '', `Deadline ${overdue ? 'overdue' : 'due soon'}: ${task.title.slice(0, 80)}`,
     text.slice(0, 300), overdue ? 'high' : 'medium', 'deadline', 'automation',
     'task', taskId, 'unread', iso(), null],
  ).catch(() => {});
  await bus?.emit(overdue ? 'task.deadline.overdue' : 'task.deadline.due_soon',
    { task_id: taskId, title: task.title, deadline: task.deadline, hours: hoursLate },
    { actor_type: 'system', target_type: 'task', target_id: taskId }).catch(() => {});
  return true;
}

/** Clear a task's alert ledger rows (called when a task completes). */
export async function clearDeadlineAlerts(db: DataPort, taskId: string): Promise<void> {
  await db.run('DELETE FROM deadline_alerts WHERE task_id = ?', [taskId]).catch(() => {});
}

/** One automation sweep. Idempotent per (task, kind); safe to run on a timer. */
export async function runDeadlineSweep(db: DataPort, bus: EventBus | null, opts: { dueSoonHours?: number } = {}): Promise<AutomationResult> {
  const { overdue, due_soon } = await deadlineScan(db, opts);
  const ownerCache = new Map<string, string | null>(); // project → creator user id
  const ownerFor = async (t: TaskRecord): Promise<string | null> => {
    if (t.created_by) return t.created_by;
    if (!t.project_id) return null;
    if (!ownerCache.has(t.project_id)) {
      const p = await db.query<any>('SELECT created_by FROM projects WHERE id = ?', [t.project_id]);
      ownerCache.set(t.project_id, p[0]?.created_by ?? null);
    }
    return ownerCache.get(t.project_id) ?? null;
  };

  let overdueAlerts = 0;
  for (const t of overdue) {
    if (await fireOnce(db, bus, t.id, 'overdue', t, await ownerFor(t))) overdueAlerts++;
  }
  let dueSoonAlerts = 0;
  for (const t of due_soon) {
    if (await fireOnce(db, bus, t.id, 'due_soon', t, await ownerFor(t))) dueSoonAlerts++;
  }

  // milestones past due → missed
  const nowIso = iso();
  const stale = await db.query<any>(
    "SELECT * FROM milestones WHERE status = 'open' AND due_date IS NOT NULL AND due_date < ?", [nowIso]);
  let missed = 0;
  for (const m of stale) {
    await db.run("UPDATE milestones SET status = 'missed', reached_at = NULL, updated_at = ? WHERE id = ?", [iso(), m.id]);
    await bus?.emit('milestone.missed', { milestone_id: m.id, name: m.name, due_date: m.due_date },
      { actor_type: 'system', target_type: 'milestone', target_id: m.id }).catch(() => {});
    missed++;
  }

  return { ran_at: iso(), overdue_alerts: overdueAlerts, due_soon_alerts: dueSoonAlerts, milestones_missed: missed };
}
