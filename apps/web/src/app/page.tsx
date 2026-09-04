'use client';
import Shell from '@/components/Shell';
import Link from 'next/link';
import { usePoll } from '@/lib/api';

export default function Home() {
  const d = usePoll(() => fetch('/api/dashboard').then(r => r.json()), 4000);
  const health = usePoll(() => fetch('/api/health').then(r => r.json()), 8000);

  if (!d) return <div className="empty">Booting OS dashboard…</div>;
  const { agents, tasks, projects, notes, events, counts } = d as any;

  const openTasks = (tasks || []).filter((t: any) => t.status === 'todo' || t.status === 'in_progress');

  return (
    <Shell title="Home">
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>
          Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}.
        </h1>
        <div className="dim small">
          {openTasks.length} open tasks · {agents.filter((a: any) => a.status !== 'idle').length} active agents · {(notes || []).length} unread notifications
        </div>
      </div>

      <div className="grid cols-21" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Agent Presence <span className="count">{agents.length}</span></h3>
          {agents.length === 0 && <div className="empty">No agents. Seed the OS from the settings panel.</div>}
          {agents.map((a: any) => (
            <Link key={a.id} href={`/agents/${a.id}`} className="item">
              <span className={`dot ${a.status === 'idle' ? 'd-gray' : a.status === 'executing' ? 'd-blue' : a.status === 'approval_required' ? 'd-amber' : 'd-green'}`} />
              <div className="grow">
                <div className="row between">
                  <span style={{ fontWeight: 600 }}>{a.name}</span>
                  <span className="xs mono dim">{a.status}</span>
                </div>
                <div className="xs faint">{a.description?.slice(0, 70)}</div>
              </div>
            </Link>
          ))}
        </div>

        <div className="card">
          <h3>System Health</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="row between small"><span>Database</span><span className={`badge ${health?.db === 'up' ? 'b-green' : 'b-red'}`}>{health?.db ?? '…'}</span></div>
            <div className="row between small"><span>Event broker</span><span className="badge b-green">up</span></div>
            <div className="row between small"><span>Kernel</span><span className="badge b-blue">v{health?.version ?? '…'}</span></div>
            {(health?.providers || []).map((p: any) => (
              <div key={p.id} className="row between small"><span className="mono">{p.kind}</span>
                <span className={`badge ${p.status === 'up' ? 'b-green' : 'b-gray'}`}>{p.id} {p.status}</span>
              </div>
            ))}
          </div>
          <h3 style={{ marginTop: 14 }}>Counts</h3>
          <div className="grid cols-2">
            {Object.entries(counts || {}).map(([k, v]) => (
              <div key={k} className="row between xs"><span className="dim">{k}</span><span className="mono">{String(v)}</span></div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Today’s Tasks <span className="count">{openTasks.length}</span></h3>
          {openTasks.slice(0, 6).map((t: any) => (
            <Link key={t.id} href={`/projects/${t.project_id}`} className="item">
              <span className={`dot ${t.status === 'in_progress' ? 'd-blue' : 'd-gray'}`} />
              <div className="grow">
                <div className="small">{t.title}</div>
                <div className="xs faint">{t.priority} · {t.status}</div>
              </div>
            </Link>
          ))}
          {openTasks.length === 0 && <div className="empty">All clear. No open tasks.</div>}
        </div>
        <div className="card">
          <h3>Projects</h3>
          {(projects || []).slice(0, 6).map((p: any) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="item">
              <span className="dot d-blue" />
              <div className="grow">
                <div className="small" style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="xs faint">{p.status}</div>
              </div>
            </Link>
          ))}
          {projects.length === 0 && <div className="empty">No projects yet.</div>}
        </div>
        <div className="card">
          <h3>Unread Notifications</h3>
          {(notes || []).slice(0, 6).map((n: any) => (
            <div key={n.id} className="item">
              <span className={`dot ${n.priority === 'high' || n.priority === 'urgent' ? 'd-red' : 'd-gray'}`} />
              <div className="grow">
                <div className="small" style={{ fontWeight: 600 }}>{n.title}</div>
                <div className="xs dim">{n.message?.slice(0, 120)}</div>
              </div>
            </div>
          ))}
          {notes.length === 0 && <div className="empty">Inbox zero.</div>}
        </div>
      </div>

      <div className="grid cols-21">
        <div className="card">
          <h3>Recent Activity</h3>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {(events || []).map((e: any) => <EventRow key={e.id} ev={e} />)}
            {events.length === 0 && <div className="empty">The OS is quiet. Use ⌘K to run something.</div>}
          </div>
        </div>
        <div className="card">
          <h3>Quick Actions</h3>
          <div style={{ display: 'flex', flexDirection: 'column' }} className="wrap" >
            {['create a task to review the kernel trace format', 'what are my agents doing', 'morning brief', 'list all tasks'].map(c => (
              <button key={c} style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }}
                onClick={() => fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: c }), credentials: 'include' }).then(() => location.assign('/activity'))}>
                ❯ {c}
              </button>
            ))}
          </div>
          <div className="xs faint" style={{ marginTop: 10 }}>
            Every command routes: command center → agent → planner → gateway → tools → memory → events.
          </div>
        </div>
      </div>
    </Shell>
  );
}

export function EventRow({ ev }: { ev: any }) {
  const colors: Record<string, string> = {
    'agent.started': 'var(--green)', 'agent.completed': 'var(--green)', 'agent.failed': 'var(--red)',
    'tool.executed': 'var(--accent)', 'tool.denied': 'var(--red)', 'tool.failed': 'var(--red)',
    'approval.requested': 'var(--amber)', 'memory.created': 'var(--purple)',
    'generation.completed': 'var(--purple)', 'command.executed': 'var(--fg-dim)',
  };
  return (
    <div className="ev">
      <span className="t">{new Date(ev.created_at).toLocaleTimeString([], { hour12: false })}</span>
      <span className="k mono" style={{ color: colors[ev.type] ?? 'var(--fg-dim)' }}>{ev.type}</span>
      <span className="d">{typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)}</span>
    </div>
  );
}
