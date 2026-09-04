'use client';
import Shell from '@/components/Shell';
import { use } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

export default function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const project = usePoll(() => api(`/api/projects/${id}`), 4000, [id]);
  const [newTask, setNewTask] = useState('');

  if (!project) return <Shell title="Project"><div className="empty">Loading project…</div></Shell>;
  const p: any = project;
  const tasks = p.tasks ?? [];
  const done = tasks.filter((t: any) => t.status === 'done').length;

  async function addTask() {
    if (!newTask.trim()) return;
    await post('/api/tasks', { title: newTask, project_id: id, priority: 'medium' });
    setNewTask('');
  }

  return (
    <Shell title={p.name}>
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>{p.name}</h1>
          <div className="xs faint">{p.description}</div>
        </div>
        <span className="badge b-blue">{done}/{tasks.length} done</span>
      </div>

      <div className="grid cols-21">
        <div className="card">
          <h3>Tasks <span className="count">{tasks.length}</span></h3>
          <div className="row" style={{ marginBottom: 10 }}>
            <input placeholder="New task title…" value={newTask} onChange={e => setNewTask(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addTask(); }} />
            <button className="primary" onClick={addTask}>Add</button>
          </div>
          {tasks.map((t: any) => (
            <div key={t.id} className="item">
              <span className={`dot ${t.status === 'done' ? 'd-green' : t.status === 'in_progress' ? 'd-blue' : t.status === 'blocked' ? 'd-red' : 'd-gray'}`} />
              <div className="grow">
                <div className="small" style={{ textDecoration: t.status === 'done' ? 'line-through' : 'none', opacity: t.status === 'done' ? 0.55 : 1 }}>{t.title}</div>
                <div className="xs faint">{t.priority} · {fmtAgo(t.updated_at)}</div>
              </div>
              <select value={t.status} onChange={async e => { await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }); }}
                style={{ width: 'auto', fontSize: 11, padding: '2px 6px' }}>
                {['todo', 'in_progress', 'blocked', 'done', 'archived'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          ))}
          {tasks.length === 0 && <div className="empty">No tasks in this project yet.</div>}
        </div>

        <div className="grid">
          <div className="card">
            <h3>Sprints</h3>
            {(p.sprints ?? []).map((s: any) => (
              <div key={s.id} className="item">
                <span className="badge b-blue">{s.status}</span>
                <div className="grow">
                  <div className="small" style={{ fontWeight: 600 }}>{s.name}</div>
                  <div className="xs faint">{s.objective?.slice(0, 80)}</div>
                </div>
              </div>
            ))}
            {(p.sprints ?? []).length === 0 && <div className="empty">No sprints. Try ⌘K → “create a sprint for {p.name}”.</div>}
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
