'use client';
/** The OS shell: persistent rail, live topbar, command palette (⌘K), activity ticker. */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, post, useEventStream, fmtTime, fmtAgo } from '@/lib/api';

const NAV = [
  { href: '/', icon: '⌂', label: 'Home', key: '1' },
  { href: '/agents', icon: 'Ⓢ', label: 'Agents', key: '2' },
  { href: '/memory', icon: 'Ⓜ', label: 'Memory', key: '3' },
  { href: '/projects', icon: '◫', label: 'Projects', key: '4' },
  { href: '/skills', icon: 'Ⓥ', label: 'Skills', key: '5' },
  { href: '/activity', icon: '⏣', label: 'Activity', key: '6' },
  { href: '/links', icon: '⤫', label: 'Links', key: '7' },
  { href: '/settings', icon: '⚙', label: 'Settings', key: '8' },
];

export type OsEvent = {
  id: string; type: string; actor_type: string; data: any; created_at: string;
};

export default function Shell({ children, title }: { children: React.ReactNode; title?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [events, setEvents] = useState<OsEvent[]>([]);
  const [notifs, setNotifs] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // ── live event stream ──
  const onEvent = useCallback((ev: OsEvent) => {
    setEvents(prev => [ev, ...prev].slice(0, 60));
    if (ev.type === 'notification.created' || ev.type === 'approval.requested') {
      refreshNotifs();
    }
  }, []);
  const { connected } = useEventStream(onEvent);

  const refreshNotifs = useCallback(async () => {
    try {
      const [n, a] = await Promise.all([
        api('/api/notifications?status=unread'),
        api('/api/approvals?status=pending'),
      ]);
      setNotifs(n); setApprovals(a);
    } catch { /* unauthenticated */ }
  }, []);

  useEffect(() => { refreshNotifs(); }, [refreshNotifs]);

  // ── keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
      else if (e.key === 'Escape') setPaletteOpen(false);
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

  return (
    <div className="shell">
      <nav className="rail">
        <div className="logo">Æ</div>
        {NAV.map(n => (
          <Link key={n.href} href={n.href} title={`${n.label} (${n.key})`} className={pathname === n.href ? 'on' : ''}>
            {n.icon}
            {n.href === '/' && approvals.length > 0 && <span className="dot" title={`${approvals.length} pending approvals`} />}
          </Link>
        ))}
        <div className="spacer" />
        <button className="ghost" onClick={toggleTheme} title="toggle theme">{theme === 'dark' ? '☾' : '☀'}</button>
        <button className="ghost" title="logout" onClick={async () => { await post('/api/auth/logout', {}); location.href = '/login'; }}>⏻</button>
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="title">{activeLabel}</span>
          <span className="crumb">Agentic OS v0.1</span>
          <div style={{ flex: 1 }} />
          <div className={`live ${connected ? '' : 'off'}`}>
            <span className="pulse" /> {connected ? 'LIVE' : 'OFFLINE'}
          </div>
          <button onClick={() => setPaletteOpen(true)}>
            Command <span className="kbd">⌘K</span>
          </button>
          <div className="row" style={{ position: 'relative' }}>
            <button onClick={refreshNotifs} title="notifications">🔔{unreadCount ? ` ${unreadCount}` : ''}</button>
            {notifs.length + approvals.length > 0 && (
              <div className="card" style={{ position: 'absolute', top: 38, right: 0, width: 340, maxHeight: 360, overflowY: 'auto', zIndex: 50 }}>
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
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'rgba(251,191,36,0.07)' }}>
            <div className="row wrap" style={{ gap: 14 }}>
              <span className="badge b-amber">⏸ {approvals.length} approval{approvals.length > 1 ? 's' : ''} pending</span>
              {approvals.map(a => (
                <span key={a.id} className="row small" style={{ gap: 6 }}>
                  <span className="mono dim">{a.tool}</span>
                  <button onClick={() => decide(a.id, 'approve', refreshNotifs)}>Approve</button>
                  <button className="danger" onClick={() => decide(a.id, 'deny', refreshNotifs)}>Deny</button>
                </span>
              ))}
            </div>
          </div>
        )}

        <main className="content">{children}</main>

        <footer style={{ borderTop: '1px solid var(--border)', padding: '6px 16px', display: 'flex', gap: 16, background: 'var(--bg-panel)' }}>
          <span className="xs faint">events {events.length ? `· last ${fmtTime(events[0].created_at)}` : ''}</span>
          <div style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {events[0] && (
              <span className="xs mono" style={{ color: 'var(--fg-faint)' }}>
                latest: <span style={{ color: 'var(--accent)' }}>{events[0].type}</span> {JSON.stringify(events[0].data).slice(0, 120)}
              </span>
            )}
          </div>
          <span className="xs faint">⌘K command · / search</span>
        </footer>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onRouted={(msg) => { setPaletteOpen(false); }}
        />
      )}
    </div>
  );
}

async function decide(id: string, d: 'approve' | 'deny', refresh: () => void) {
  await post(`/api/approvals/${id}/decision`, { decision: d }).catch(() => {});
  refresh();
}

// ─── command palette / command center ──────────────────────────────────────
function CommandPalette({ onClose, onRouted }: { onClose: () => void; onRouted: (msg?: string) => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'command' | 'search'>('command');
  const [results, setResults] = useState<any[] | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // local command list (navigation + OS actions)
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
    try {
      const res = await post<any>('/api/command', { text });
      if (res.kind === 'execution') {
        router.push(`/activity?exec=${encodeURIComponent(res.execution_id)}`);
        onClose();
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
      <div className="palette" onClick={e => e.stopPropagation()}>
        <input
          autoFocus placeholder="Type a command, ask the OS, or search… (⏎ run)"
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
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
            <pre className="code" style={{ margin: 0, border: 'none, background: transparent' as any }}>{reply}</pre>
          </div>
        )}
        {busy && <div style={{ padding: 10, color: 'var(--accent)' }} className="xs">routing through kernel…</div>}
        <div className="results">
          {mode === 'command' && !reply && (
            <>
              {q && !filtered.length && (
                <div className="item" onClick={() => runCommand(q)}>
                  <span className="accent">❯</span>
                  <div className="grow">
                    <div className="small" style={{ fontWeight: 600 }}>Ask the OS: “{q}”</div>
                    <div className="xs dim">routes to Hermes agent → planner → tools → memory</div>
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
