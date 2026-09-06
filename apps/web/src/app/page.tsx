'use client';
import Shell from '@/components/Shell';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, post, usePoll, patch } from '@/lib/api';
import type { AgentRecord, TaskRecord, ProjectRecord, NotificationRecord, OsEvent } from '@agentic/contracts';

/** Dashboard wire shape (GET /api/dashboard). */
interface DashboardData {
  agents: AgentRecord[];
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  notes: NotificationRecord[];
  events: OsEvent[];
  counts: Record<string, number>;
  approvals?: any[];
}

interface HealthData { db?: string; version?: string; providers?: { id: string; kind: string; status: string }[] }
interface Widget { id: string; kind: string; width: 1 | 2 | 3 }
interface WidgetDef { kind: string; name: string; description: string; defaultWidth: 1 | 2 | 3 }

export default function Home() {
  const d = usePoll<DashboardData>(() => api<DashboardData>('/api/dashboard'), 4000);
  const health = usePoll<HealthData>(() => api<HealthData>('/api/health'), 8000);
  const approvals = usePoll(() => api('/api/approvals?status=pending').catch(() => []), 5000) as any[] | null;
  const autos = usePoll(() => api('/api/automations').catch(() => []), 6000) as any[] | null;
  const layoutData = usePoll(() => api('/api/dashboard/layout'), 0) as any | null; // load once (re-fetched after edits)
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const [prefsMsg, setPrefsMsg] = useState('');

  const layout = draft ?? layoutData?.layout?.widgets ?? [];
  const registry: WidgetDef[] = layoutData?.registry ?? [];

  const startEdit = () => { setDraft([...layout]); setEditing(true); };
  const cancelEdit = () => { setDraft(null); setEditing(false); };
  const saveEdit = async () => {
    if (!draft) return;
    try {
      await fetch('/api/dashboard/layout', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widgets: draft }),
      }).then(r => r.json());
      setDraft(null); setEditing(false);
      window.location.reload(); // re-run usePoll with the new layout
    } catch { /* transient */ }
  };
  const resetLayout = async () => {
    await post('/api/dashboard/layout/reset', {});
    window.location.reload();
  };

  const addWidget = (kind: string) => {
    if (!draft) return;
    const def = registry.find(r => r.kind === kind);
    draft.push({ id: `w-${kind}-${Date.now().toString(36)}`, kind, width: def?.defaultWidth ?? 1 });
    setDraft([...draft]);
  };
  const removeWidget = (id: string) => { if (draft) setDraft(draft.filter(w => w.id !== id)); };
  const move = (id: string, dir: -1 | 1) => {
    if (!draft) return;
    const i = draft.findIndex(w => w.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= draft.length) return;
    const next = [...draft]; [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };
  const cycleWidth = (id: string) => {
    if (!draft) return;
    setDraft(draft.map(w => w.id === id ? { ...w, width: ((w.width % 3) + 1) as 1 | 2 | 3 } : w));
  };

  if (!d) return <div className="empty">Booting OS dashboard…</div>;

  const agents = Array.isArray(d.agents) ? d.agents : [];
  const tasks = Array.isArray(d.tasks) ? d.tasks : [];
  const projects = Array.isArray(d.projects) ? d.projects : [];
  const notes = Array.isArray(d.notes) ? d.notes : [];
  const events = Array.isArray(d.events) ? d.events : [];
  const counts = d.counts && typeof d.counts === 'object' ? d.counts : {};
  const openTasks = tasks.filter(t => t.status === 'todo' || t.status === 'in_progress');

  // render rows of widgets honoring width (3-col grid)
  const rows: Widget[][] = [];
  let row: Widget[] = [], rowW = 0;
  for (const w of layout) {
    if (rowW + w.width > 3) { rows.push(row); row = []; rowW = 0; }
    row.push(w); rowW += w.width;
  }
  if (row.length) rows.push(row);

  const widgetProps = { d, health, approvals, autos, openTasks, agents, projects, notes, events, counts };

  return (
    <Shell title="Home">
      <div className="between" style={{ marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>
            Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}.
          </h1>
          <div className="dim small">
            {openTasks.length} open tasks · {agents.filter(a => a.status !== 'idle').length} active agents · {notes.length} unread notifications
          </div>
        </div>
        <div className="row">
          {editing ? (
            <>
              <select onChange={e => { if (e.target.value) addWidget(e.target.value); e.target.value = ''; }} defaultValue="">
                <option value="">+ Add widget…</option>
                {registry.map(r => <option key={r.kind} value={r.kind}>{r.name} — {r.description}</option>)}
              </select>
              <button onClick={resetLayout}>Reset default</button>
              <button onClick={cancelEdit}>Cancel</button>
              <button className="primary" onClick={saveEdit}>Save layout</button>
            </>
          ) : (
            <button onClick={startEdit}>⚙ Edit dashboard</button>
          )}
        </div>
      </div>

      {editing && (
        <div className="xs faint" style={{ marginBottom: 10 }}>
          Add widgets, reorder with ↑↓, cycle widths with ⇔ (1/3, 2/3, full row). Layout persists per user.
        </div>
      )}

      {rows.map((r, ri) => (
        <div key={ri} className="grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, r.reduce((s, w) => s + w.width, 0))}, 1fr)`, gap: 14, marginBottom: 14 }}>
          {r.map(w => (
            <div key={w.id} style={{ gridColumn: `span ${w.width}` }}>
              {editing && (
                <div className="row xs" style={{ gap: 4, marginBottom: 4 }}>
                  <button className="xs ghost" onClick={() => move(w.id, -1)}>↑</button>
                  <button className="xs ghost" onClick={() => move(w.id, 1)}>↓</button>
                  <button className="xs ghost" onClick={() => cycleWidth(w.id)}>⇔ {w.width}/3</button>
                  <button className="xs ghost" onClick={() => removeWidget(w.id)}>✕</button>
                </div>
              )}
              <WidgetCard kind={w.kind} {...widgetProps} />
            </div>
          ))}
        </div>
      ))}
      {layout.length === 0 && <div className="empty">Dashboard is empty — add widgets with ⚙ Edit dashboard.</div>}
    </Shell>
  );
}

// ─── the widget SDK: every widget is a pure function of dashboard data ──────

function WidgetCard({ kind, ...props }: { kind: string } & ReturnType<typeof buildWidgetProps>) {
  switch (kind) {
    case 'agent-presence': return <AgentPresenceWidget {...props} />;
    case 'system-health': return <SystemHealthWidget {...props} />;
    case 'open-tasks': return <OpenTasksWidget {...props} />;
    case 'projects': return <ProjectsWidget {...props} />;
    case 'unread-notes': return <UnreadNotesWidget {...props} />;
    case 'recent-activity': return <RecentActivityWidget {...props} />;
    case 'quick-actions': return <QuickActionsWidget />;
    case 'counts': return <CountsWidget {...props} />;
    case 'approvals': return <ApprovalsWidget {...props} />;
    case 'automations': return <AutomationsWidget {...props} />;
    default: return <div className="card"><div className="empty">Unknown widget: {kind}</div></div>;
  }
}

type WProps = ReturnType<typeof buildWidgetProps>;
function buildWidgetProps() { return {} as any; }

function AgentPresenceWidget({ agents }: WProps) {
  return (
    <div className="card">
      <h3>Agent Presence <span className="count">{agents.length}</span></h3>
      {agents.length === 0 && <div className="empty">No agents. Seed the OS from the settings panel.</div>}
      {agents.map((a: any) => (
        <Link key={a.id} href={`/agents/${a.id}`} className="item">
          <span className={`dot ${a.status === 'idle' ? 'd-gray' : a.status === 'executing' ? 'd-blue' : a.status === 'approval_required' ? 'd-amber' : 'd-green'}`} />
          <div className="grow">
            <div className="row between"><span style={{ fontWeight: 600 }}>{a.name}</span><span className="xs mono dim">{a.status}</span></div>
            <div className="xs faint">{a.description?.slice(0, 70)}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function SystemHealthWidget({ health, counts }: WProps) {
  return (
    <div className="card">
      <h3>System Health</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row between small"><span>Database</span><span className={`badge ${health?.db === 'up' ? 'b-green' : 'b-red'}`}>{health?.db ?? '…'}</span></div>
        <div className="row between small"><span>Event broker</span><span className="badge b-green">up</span></div>
        <div className="row between small"><span>Kernel</span><span className="badge b-blue">v{health?.version ?? '…'}</span></div>
      </div>
      {Object.keys(counts).length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Counts</h3>
          <div className="grid cols-2">
            {Object.entries(counts).map(([k, v]) => (
              <div key={k} className="row between xs"><span className="dim">{k}</span><span className="mono">{String(v)}</span></div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OpenTasksWidget({ openTasks }: WProps) {
  return (
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
  );
}

function ProjectsWidget({ projects }: WProps) {
  return (
    <div className="card">
      <h3>Projects</h3>
      {projects.slice(0, 6).map((p: any) => (
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
  );
}

function UnreadNotesWidget({ notes }: WProps) {
  return (
    <div className="card">
      <h3>Unread Notifications</h3>
      <PushOptIn />
      {notes.slice(0, 6).map((n: any) => (
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
  );
}

function RecentActivityWidget({ events }: WProps) {
  return (
    <div className="card">
      <h3>Recent Activity</h3>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {events.map((e: any) => <EventRow key={e.id} ev={e} />)}
        {events.length === 0 && <div className="empty">The OS is quiet. Use ⌘K to run something.</div>}
      </div>
    </div>
  );
}

function QuickActionsWidget() {
  return (
    <div className="card">
      <h3>Quick Actions</h3>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {['create a task to review the kernel trace format', 'what are my agents doing', 'morning brief', 'list all tasks'].map(c => (
          <button key={c} style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }}
            onClick={() => post('/api/command', { text: c }).then(() => location.assign('/activity')).catch(() => {})}>
            ❯ {c}
          </button>
        ))}
      </div>
      <div className="xs faint" style={{ marginTop: 10 }}>
        Every command routes: command center → agent → planner → tools → memory → events.
      </div>
    </div>
  );
}

function CountsWidget({ counts }: WProps) {
  return (
    <div className="card">
      <h3>Kernel Counts</h3>
      <div className="grid cols-2">
        {Object.entries(counts).map(([k, v]) => (
          <div key={k} className="row between xs"><span className="dim">{k}</span><span className="mono">{String(v)}</span></div>
        ))}
      </div>
      {Object.keys(counts).length === 0 && <div className="empty">No counts yet.</div>}
    </div>
  );
}

function ApprovalsWidget({ approvals }: WProps) {
  return (
    <div className="card">
      <h3>Pending Approvals <span className="count">{approvals?.length ?? 0}</span></h3>
      {(approvals ?? []).map((a: any) => (
        <div key={a.id} className="item">
          <span className="dot d-amber" />
          <div className="grow">
            <div className="small" style={{ fontWeight: 600 }}>{a.tool}</div>
            <div className="xs faint">{a.reason?.slice(0, 100)}</div>
          </div>
        </div>
      ))}
      {(approvals ?? []).length === 0 && <div className="empty">No approvals waiting.</div>}
    </div>
  );
}

function AutomationsWidget({ autos }: WProps) {
  return (
    <div className="card">
      <h3>Automations <span className="count">{autos?.length ?? 0}</span></h3>
      {(autos ?? []).slice(0, 6).map((a: any) => (
        <div key={a.id} className="item">
          <span className="dot d-blue" />
          <div className="grow">
            <div className="small">{a.name} {!a.enabled && <span className="badge b-gray">paused</span>}</div>
            <div className="xs faint">{a.trigger} → {a.action} · {a.run_count} runs</div>
          </div>
        </div>
      ))}
      {(autos ?? []).length === 0 && <div className="empty">No automations. Create one from the Automations page.</div>}
    </div>
  );
}

// ─── Phase 10: browser push opt-in (lives in the notifications widget) ──────
function PushOptIn() {
  const [state, setState] = useState<'idle' | 'asking' | 'on' | 'unsupported' | 'denied'>('idle');
  const [prefs, setPrefs] = useState<any>(null);
  useEffect(() => { api('/api/notifications/prefs').then(setPrefs).catch(() => {}); }, []);

  const enable = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setState('unsupported'); return; }
    try {
      setState('asking');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { publicKey } = await api('/api/notifications/push/vapid');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(publicKey),
      });
      const json = sub.toJSON() as any;
      await post('/api/notifications/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
      setPrefs(await api('/api/notifications/prefs'));
      setState('on');
    } catch {
      setState('denied');
    }
  }, []);

  const disable = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await post('/api/notifications/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setPrefs(await api('/api/notifications/prefs'));
      setState('idle');
    } catch { /* transient */ }
  }, []);

  const test = useCallback(async () => { await post('/api/notifications/push/test', {}); }, []);

  return (
    <div className="xs" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0' }}>
      <span className="faint">Browser push:</span>
      {prefs?.browser_push ? (
        <>
          <span className="badge b-green">on</span>
          <button className="ghost xs" onClick={test}>Test</button>
          <button className="ghost xs" onClick={disable}>Turn off</button>
        </>
      ) : state === 'unsupported' ? (
        <span className="badge b-gray">unsupported browser</span>
      ) : state === 'denied' ? (
        <span className="badge b-red">permission denied</span>
      ) : (
        <button className="xs" onClick={enable} disabled={state === 'asking'}>
          {state === 'asking' ? 'enabling…' : 'Enable'}
        </button>
      )}
      {prefs?.browser_push && <span className="faint">min priority: {prefs.push_min_priority}</span>}
    </div>
  );
}

function urlB64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const arr = new Uint8Array<ArrayBuffer>(buf);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ─── shared event row (unchanged from the original dashboard) ───────────────
function EventRow({ ev }: { ev: OsEvent }) {
  const colorFor = (t: string) => {
    if (t.startsWith('agent')) return t.includes('fail') ? 'var(--red)' : t.includes('completed') ? 'var(--green)' : 'var(--accent)';
    if (t.startsWith('tool')) return t.includes('denied') || t.includes('fail') ? 'var(--red)' : 'var(--accent)';
    if (t.startsWith('memory')) return 'var(--purple)';
    if (t.startsWith('approval')) return 'var(--amber)';
    if (t.startsWith('task') || t.startsWith('project') || t.startsWith('sprint')) return 'var(--green)';
    return 'var(--fg-dim)';
  };
  const summarize = (e: OsEvent) => {
    const dat = (e as any).data ?? {};
    if (dat.input) return `${dat.agent ? dat.agent + ': ' : ''}${String(dat.input).slice(0, 90)}`;
    if (dat.tool) return `${dat.tool}${dat.summary ? ` → ${dat.summary}` : dat.error ? ` ✗ ${dat.error}` : ''}`;
    if (dat.summary) return dat.summary;
    return JSON.stringify(dat).slice(0, 110);
  };
  return (
    <div className="ev">
      <span className="k mono" style={{ color: colorFor(ev.type) }}>{ev.type}</span>
      <span className="d xs dim">{summarize(ev)}</span>
    </div>
  );
}
