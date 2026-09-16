'use client';
/**
 * The OS shell: persistent rail, live topbar, command palette (⌘K),
 * approval banner, notification center, and the GLOBAL ACTIVE OPERATIONS
 * indicator fed by the ExecutionStore (§23/§33).
 *
 * The shell no longer owns its own SSE subscription — the ExecutionStore
 * (root layout) is the one event source; this component reads from it.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, post, fmtAgo } from '@/lib/api';
import { useExecutionStore } from '@/lib/execution-store';
import type { LiveExecution } from '@/lib/execution-store';

const NAV = [
  { href: '/', icon: '⌂', label: 'Home', key: '1' },
  { href: '/agents', icon: 'Ⓢ', label: 'Agents', key: '2' },
  { href: '/memory', icon: 'Ⓜ', label: 'Memory', key: '3' },
  { href: '/projects', icon: '◫', label: 'Projects', key: '4' },
  { href: '/skills', icon: 'Ⓥ', label: 'Skills', key: '5' },
  { href: '/flows', icon: '⎔', label: 'Flows', key: '6' },
  { href: '/automations', icon: '⏁', label: 'Automations', key: '7' },
  { href: '/integrations', icon: '⎌', label: 'Integrations', key: 'i' },
  { href: '/activity', icon: '⏣', label: 'Activity', key: '8' },
  { href: '/links', icon: '⤫', label: 'Links', key: '9' },
  { href: '/settings', icon: '⚙', label: 'Settings', key: '0' },
];

const ACTIVE_STATES = ['received', 'understanding', 'planning', 'executing', 'waiting', 'approval_required', 'completing'];

export default function Shell({ children, title }: { children: React.ReactNode; title?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [notifs, setNotifs] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [clock, setClock] = useState('');
  const store = useExecutionStore();

  const refreshNotifs = useCallback(async () => {
    try {
      const [n, a] = await Promise.all([
        api('/api/notifications?status=unread'),
        api('/api/approvals?status=pending'),
      ]);
      setNotifs(Array.isArray(n) ? n : []);
      setApprovals(Array.isArray(a) ? a : []);
    } catch { /* unauthenticated */ }
  }, []);

  useEffect(() => { refreshNotifs(); }, [refreshNotifs]);

  // live event stream → refresh the bell when relevant events arrive
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev?.type === 'notification.created' || ev?.type === 'approval.requested' || ev?.type === 'approval.decided') {
          refreshNotifs();
        }
      } catch { /* skip */ }
    };
    return () => es.close();
  }, [refreshNotifs]);

  // live clock
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
      else if (e.key === 'Escape') { setPaletteOpen(false); setNotifOpen(false); setOpsOpen(false); }
      else if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault(); setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const t = localStorage.getItem('theme') as any;
    if (t) setTheme(t);
  }, []);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); localStorage.setItem('theme', next);
    document.documentElement.dataset.theme = next;
  };

  const unreadCount = notifs.length;
  const activeLabel = NAV.find(n => n.href === pathname)?.label ?? (title ?? 'Agentic OS');
  const activeExecs: LiveExecution[] = useMemo(
    () => store.order.map(id => store.executions[id]).filter(ex => ex && ACTIVE_STATES.includes(ex.state)),
    [store.order, store.executions],
  );

  return (
    <div className="shell">
      <nav className="rail" aria-label="OS navigation">
        <div className="logo" aria-hidden="true">Æ</div>
        {NAV.map(n => (
          <Link key={n.href} href={n.href} title={`${n.label} (${n.key})`} aria-label={n.label}
            className={pathname === n.href ? 'on' : ''}>
            {n.icon}
            {n.href === '/' && approvals.length > 0 && <span className="dot" title={`${approvals.length} pending approvals`} />}
          </Link>
        ))}
        <div className="spacer" />
        <button className="ghost" onClick={toggleTheme} title="toggle theme" aria-label="Toggle theme">{theme === 'dark' ? '☾' : '☀'}</button>
        <button className="ghost" title="logout" aria-label="Log out"
          onClick={async () => { await post('/api/auth/logout', {}); location.href = '/login'; }}>⏻</button>
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="title">{activeLabel}</span>
          <span className="crumb">AGENTIC OS v0.13</span>
          <div style={{ flex: 1 }} />
          <span className="mono faint xs" aria-hidden="true" style={{ letterSpacing: '0.08em' }}>{clock}</span>

          {/* §23/§33 — global active operations, visible from anywhere */}
          {activeExecs.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button className="active-ops" onClick={() => setOpsOpen(o => !o)}
                aria-label={`${activeExecs.length} active operations — open details`}
                aria-expanded={opsOpen}>
                <span className="ops-pulse" aria-hidden="true" />
                {activeExecs.length} ACTIVE {activeExecs.length === 1 ? 'AGENT' : 'AGENTS'}
              </button>
              {opsOpen && (
                <div className="active-ops-pop" role="dialog" aria-label="Active operations">
                  {activeExecs.map(ex => (
                    <div key={ex.id} className="active-ops-row">
                      <span className={`dot ${ex.state === 'approval_required' ? 'd-amber' : ex.state === 'failed' ? 'd-red' : 'd-cyan'}`} />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="small" style={{ fontWeight: 600 }}>{ex.agent}</div>
                        <div className="xs faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ex.activity.slice(-1)[0]?.label ?? ex.state}
                        </div>
                      </div>
                      <a className="xs dim" href={`/activity?exec=${ex.id}`}>trace ↗</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className={`live ${store.connected ? '' : 'off'}`}>
            <span className="pulse" /> {store.connected ? 'LIVE' : 'OFFLINE'}
          </div>
          <button onClick={() => setPaletteOpen(true)}>
            Command <span className="kbd">⌘K</span>
          </button>
          <div className="row" style={{ position: 'relative' }}>
            <button onClick={() => { setNotifOpen(o => !o); if (!notifOpen) refreshNotifs(); }}
              title="notifications" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}>
              🔔{unreadCount ? ` ${unreadCount}` : ''}
            </button>
            {notifOpen && notifs.length + approvals.length > 0 && (
              <div className="card" role="dialog" aria-label="Notifications"
                style={{ position: 'absolute', top: 40, right: 0, width: 340, maxHeight: 380, overflowY: 'auto', zIndex: 50, boxShadow: 'var(--shadow-3)' }}>
                {approvals.map(a => (
                  <div key={a.id} className="item" onClick={() => router.push('/activity')}>
                    <div className="grow">
                      <div className="row"><span className="badge b-amber">approval</span></div>
                      <div className="small" style={{ marginTop: 4 }}>{a.tool} — <span className="dim">{a.reason}</span></div>
                      <div className="row" style={{ marginTop: 6 }}>
                        <button className="primary" onClick={e => { e.stopPropagation(); decide(a.id, 'approve', refreshNotifs); }}>Approve</button>
                        <button className="danger" onClick={e => { e.stopPropagation(); decide(a.id, 'deny', refreshNotifs); }}>Deny</button>
                      </div>
                    </div>
                  </div>
                ))}
                {notifs.slice(0, 8).map(n => (
                  <div key={n.id} className="item" onClick={async () => { await post(`/api/notifications/${n.id}/read`, {}); refreshNotifs(); }}>
                    <div className="grow">
                      <div className="row between">
                        <span className="small" style={{ fontWeight: 600 }}>{n.title}</span>
                        <span className="xs faint">{fmtAgo(n.created_at)}</span>
                      </div>
                      <div className="xs dim">{n.message?.slice(0, 140)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </header>

        {approvals.length > 0 && (
          <div className="approval-banner" role="region" aria-label={`${approvals.length} approvals pending`}>
            <span className="badge b-amber">⏸ {approvals.length} approval{approvals.length > 1 ? 's' : ''} pending</span>
            {approvals.map(a => (
              <span key={a.id} className="row small" style={{ gap: 6 }}>
                <span className="mono dim">{a.tool}</span>
                <button onClick={() => decide(a.id, 'approve', refreshNotifs)}>Approve</button>
                <button className="danger" onClick={() => decide(a.id, 'deny', refreshNotifs)}>Deny</button>
              </span>
            ))}
          </div>
        )}

        <main className="content" id="os-content">{children}</main>

        <footer style={{ borderTop: '1px solid var(--border)', padding: '6px 16px', display: 'flex', gap: 16, background: 'var(--bg-panel)' }}>
          <span className="xs faint mono">
            {store.connected ? 'live stream connected' : 'reconnecting…'}
          </span>
          <span className="xs faint mono">⌘K command · / search</span>
        </footer>
      </div>

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  );
}

async function decide(id: string, d: 'approve' | 'deny', refresh: () => void) {
  await post(`/api/approvals/${id}/decision`, { decision: d }).catch(() => {});
  refresh();
}

// --- command palette / command center --------------------------------------
function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'command' | 'search'>('command');
  const [results, setResults] = useState<any[] | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const store = useExecutionStore();

  const commands = useMemo(() => [
    { icon: '⌂', label: 'Go to Home', run: () => router.push('/') },
    { icon: 'Ⓢ', label: 'Go to Agents', run: () => router.push('/agents') },
    { icon: 'Ⓜ', label: 'Go to Memory', run: () => router.push('/memory') },
    { icon: '◫', label: 'Go to Projects', run: () => router.push('/projects') },
    { icon: 'Ⓥ', label: 'Go to Skills', run: () => router.push('/skills') },
    { icon: '⏣', label: 'Go to Activity', run: () => router.push('/activity') },
    { icon: '⤫', label: 'Go to Links Explorer', run: () => router.push('/links') },
    { icon: '⚙', label: 'Go to Settings', run: () => router.push('/settings') },
  ], [router]);

  async function runCommand(text: string) {
    setBusy(true); setReply(null);
    store.trackCommand(text);
    try {
      const res = await post<any>('/api/command', { text });
      if (res.kind === 'execution' && res.execution_id) {
        // register in the global store; the command surface on Home shows it,
        // the topbar indicator shows it — but close the palette immediately
        store.register(res.execution_id, { agent: res.agent_name ?? 'Agent', ack: res.ack, input: text, state: 'received' });
        setReply(res.ack ?? `Running on ${res.agent_name} — follow it on Home or Activity.`);
        setTimeout(onClose, 600);
      } else {
        setReply(res.text);
      }
    } catch (e: any) {
      setReply(`Error: ${e.message}`);
    } finally { setBusy(false); }
  }

  async function runSearch(text: string) {
    if (!text.trim()) { setResults(null); return; }
    setResults(await api(`/api/search?q=${encodeURIComponent(text)}`).catch(() => null));
  }

  const filtered = commands.filter(c => !q || c.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="palette-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" onClick={e => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          autoFocus placeholder="Type a command, ask the OS, or search… (⏎ run)"
          aria-label="Command input"
          value={q}
          onChange={e => { setQ(e.target.value); if (mode === 'search') runSearch(e.target.value); }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              if (mode === 'search' || (!q.startsWith('>') && !filtered.length && q)) runCommand(q);
              else if (filtered.length) { filtered[0].run(); onClose(); }
              else if (q) runCommand(q);
            }
          }}
        />
        {reply && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-inset)' }}>
            <pre className="code" style={{ margin: 0, border: 'none', background: 'transparent' }}>{reply}</pre>
          </div>
        )}
        {busy && <div style={{ padding: 10, color: 'var(--cyan)' }} className="xs mono">routing through kernel…</div>}
        <div className="results">
          {mode === 'command' && !reply && (
            <>
              {q && !filtered.length && (
                <div className="item" onClick={() => runCommand(q)}>
                  <span style={{ color: 'var(--cyan)' }}>❯</span>
                  <div className="grow">
                    <div className="small" style={{ fontWeight: 600 }}>Ask the OS: “{q}”</div>
                    <div className="xs dim">routes to agent → planner → tools → memory</div>
                  </div>
                </div>
              )}
              {filtered.map(c => (
                <div key={c.label} className="item" onClick={() => { c.run(); onClose(); }}>
                  <span>{c.icon}</span>
                  <div className="grow small">{c.label}</div>
                  <span className="kbd">go</span>
                </div>
              ))}
            </>
          )}
          {mode === 'search' && results && (
            results.map(r => (
              <div key={r.type + r.id} className="item">
                <span className="badge b-gray">{r.type}</span>
                <div className="grow">
                  <div className="small">{r.title}</div>
                  <div className="xs faint">{r.subtitle}</div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="hint">
          <span>⌘K toggle · ⏎ run · Esc close</span>
          <span className="row" style={{ gap: 6 }}>
            <button className={mode === 'command' ? 'primary' : ''} onClick={() => setMode('command')}>command</button>
            <button className={mode === 'search' ? 'primary' : ''} onClick={() => { setMode('search'); runSearch(q); }}>search</button>
          </span>
        </div>
      </div>
    </div>
  );
}
