'use client';
import Shell from '@/components/Shell';
import { use, useState } from 'react';
import { api, post, patch, usePoll, fmtAgo } from '@/lib/api';

const STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'archived'];

export default function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const project = usePoll(() => api(`/api/projects/${id}`), 4000, [id]);
  const rollup = usePoll(() => api(`/api/projects/${id}/rollup`), 5000, [id]);
  const milestones = usePoll(() => api(`/api/projects/${id}/milestones`), 6000, [id]);
  const depOrder = usePoll(() => api(`/api/projects/${id}/dependency-order`), 6000, [id]);
  const [newTask, setNewTask] = useState('');
  const [newMs, setNewMs] = useState('');
  const [msDue, setMsDue] = useState('');

  if (!project) return <Shell title="Project"><div className="empty">Loading project…</div></Shell>;
  const p: any = project;
  const r: any = rollup;
  const tasks = p.tasks ?? [];
  const done = tasks.filter((t: any) => t.status === 'done').length;
  const levelOf = (taskId: string) => (depOrder ?? []).find((o: any) => o.task_id === taskId)?.level;

  async function addTask() {
    if (!newTask.trim()) return;
    await post('/api/tasks', { title: newTask, project_id: id, priority: 'medium' });
    setNewTask('');
  }

  async function addMilestone() {
    if (!newMs.trim()) return;
    await post(`/api/projects/${id}/milestones`, { name: newMs, ...(msDue ? { due_date: new Date(msDue).toISOString() } : {}) });
    setNewMs(''); setMsDue('');
  }

  async function setStatus(taskId: string, status: string) {
    await patch(`/api/tasks/${taskId}`, { status });
  }

  async function sprintAction(sprintId: string, action: 'start' | 'complete' | 'cancel') {
    await post(`/api/sprints/${sprintId}/transition`, { action });
  }

  return (
    <Shell title={p.name}>
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-h1">{p.name}</h1>
          <div className="xs faint">{p.description}</div>
        </div>
        <span className="badge b-blue">{done}/{tasks.length} done</span>
      </div>

      {/* Phase 6: rollup bar */}
      {r && (
        <div className="card" style={{ marginBottom: 14, padding: '10px 14px' }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <div className="row" style={{ gap: 10 }}>
              <span className="badge b-green">{r.completion_pct}% complete</span>
              <span className="xs dim">{r.tasks.done} done · {r.tasks.in_progress} in progress · <span style={{ color: r.tasks.blocked ? 'var(--red)' : 'inherit' }}>{r.tasks.blocked} blocked</span> · {r.tasks.todo} todo</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {r.overdue_tasks.length > 0 && <span className="badge b-red">{r.overdue_tasks.length} overdue</span>}
              {r.milestones.total > 0 && <span className="badge b-purple">{r.milestones.reached}/{r.milestones.total} milestones</span>}
            </div>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-hover)', overflow: 'hidden' }}>
            <div style={{ width: `${r.completion_pct}%`, height: '100%', background: 'var(--green)', transition: 'width .3s' }} />
          </div>
          {r.blocked_tasks.length > 0 && (
            <div className="xs" style={{ marginTop: 8, color: 'var(--red)' }}>
              {r.blocked_tasks.map((b: any, i: number) => (
                <div key={b.id}>{i === 0 && <b>BLOCKERS</b>} · {b.title} waits on: {b.waiting_on.join(', ') || '—'}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid cols-21">
        <div className="card">
          <h3>Tasks <span className="count">{tasks.length}</span> {depOrder && depOrder.length > 0 && <span className="xs faint" style={{ fontWeight: 400 }}>· L0–L{Math.max(...(depOrder as any[]).map(o => o.level))} dependency levels</span>}</h3>
          <div className="row" style={{ marginBottom: 10 }}>
            <input placeholder="New task title…" value={newTask} onChange={e => setNewTask(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addTask(); }} />
            <button className="primary" onClick={addTask}>Add</button>
          </div>
          {tasks.map((t: any) => {
            const lvl = levelOf(t.id);
            return (
            <div key={t.id} className="item">
              <span className={`dot ${t.status === 'done' ? 'd-green' : t.status === 'in_progress' ? 'd-cyan' : t.status === 'blocked' ? 'd-red' : 'd-gray'}`} />
              <div className="grow">
                <div className="small" style={{ textDecoration: t.status === 'done' ? 'line-through' : 'none', opacity: t.status === 'done' ? 0.55 : 1 }}>
                  {t.title} {lvl != null && lvl > 0 && <span className="badge b-gray xs">L{lvl}</span>}
                </div>
                <div className="xs faint">{t.priority} · {fmtAgo(t.updated_at)}{t.deadline && <span> · due {String(t.deadline).slice(0, 10)}</span>}</div>
              </div>
              <select value={t.status} onChange={e => setStatus(t.id, e.target.value)} style={{ width: 'auto', fontSize: 11, padding: '2px 6px' }}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            );
          })}
          {tasks.length === 0 && <div className="empty">No tasks in this project yet. Try ⌘K → “plan a sprint for {p.name}”.</div>}
        </div>

        <div className="grid">
          {/* Sprints with lifecycle controls */}
          <div className="card">
            <h3>Sprints</h3>
            {(p.sprints ?? []).map((s: any) => {
              const sp = (r?.active_sprints ?? []).find((x: any) => x.id === s.id);
              return (
                <div key={s.id} className="item">
                  <span className={`badge ${s.status === 'active' ? 'b-cyan' : s.status === 'completed' ? 'b-green' : s.status === 'cancelled' ? 'b-gray' : 'b-gray'}`}>{s.status}</span>
                  <div className="grow">
                    <div className="small" style={{ fontWeight: 600 }}>{s.name}</div>
                    <div className="xs faint">{s.objective?.slice(0, 80)}</div>
                    {sp && sp.tasks_total > 0 && (
                      <div className="xs" style={{ marginTop: 3 }}>
                        <span style={{ color: 'var(--green)' }}>{sp.tasks_done}/{sp.tasks_total}</span> · {sp.completion_pct}%
                      </div>
                    )}
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    {s.status === 'planned' && <button className="xs" onClick={() => sprintAction(s.id, 'start')}>Start</button>}
                    {s.status === 'active' && <button className="xs primary" onClick={() => sprintAction(s.id, 'complete')}>Complete</button>}
                    {['planned', 'active'].includes(s.status) && <button className="xs ghost" onClick={() => sprintAction(s.id, 'cancel')}>✕</button>}
                  </div>
                </div>
              );
            })}
            {(p.sprints ?? []).length === 0 && <div className="empty">No sprints. Try ⌘K → “plan a sprint for {p.name}”.</div>}
          </div>

          {/* Phase 6: milestones */}
          <div className="card">
            <h3>Milestones</h3>
            <div className="row" style={{ marginBottom: 8 }}>
              <input placeholder="New milestone…" value={newMs} onChange={e => setNewMs(e.target.value)} style={{ flex: 2 }} />
              <input type="date" value={msDue} onChange={e => setMsDue(e.target.value)} style={{ width: 130 }} />
              <button onClick={addMilestone}>Add</button>
            </div>
            {(milestones ?? []).map((m: any) => (
              <div key={m.id} className="item">
                <span className={`badge ${m.status === 'reached' ? 'b-green' : m.status === 'missed' ? 'b-red' : 'b-purple'}`}>{m.status}</span>
                <div className="grow">
                  <div className="small">{m.name}</div>
                  <div className="xs faint">{m.due_date ? `due ${String(m.due_date).slice(0, 10)}` : 'no due date'}</div>
                </div>
                {m.status === 'open' && (
                  <div className="row" style={{ gap: 4 }}>
                    <button className="xs" onClick={() => patch(`/api/milestones/${m.id}`, { status: 'reached' })}>✓ Reached</button>
                    <button className="xs ghost" onClick={() => api(`/api/milestones/${m.id}`, { method: 'DELETE' })}>✕</button>
                  </div>
                )}
              </div>
            ))}
            {(milestones ?? []).length === 0 && <div className="empty">No milestones yet — dated checkpoints with automatic miss detection.</div>}
          </div>

          <div className="card">
            <h3>Links</h3>
            {(p.links ?? []).slice(0, 12).map((l: any) => (
              <div key={l.id} className="xs mono dim" style={{ padding: '2px 0' }}>
                {l.from_type}:{String(l.from_id).slice(0, 8)} —{l.relation}→ {l.to_type}:{String(l.to_id).slice(0, 8)}
              </div>
            ))}
            {(p.links ?? []).length === 0 && <div className="empty">No links yet.</div>}
          </div>
        </div>
      </div>
    </Shell>
  );
}
