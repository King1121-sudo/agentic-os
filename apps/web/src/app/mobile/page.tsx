'use client';
/**
 * Phase 12 — Mobile supervision surface. Phone-first: briefing header,
 * one-tap approvals, live agent/task cards, and the EMERGENCY STOP (two-step
 * confirm — destructive action per ui-skills). Deliberately standalone —
 * no desktop Shell chrome, safe-area aware.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

const STATUS_TONE: Record<string, string> = {
  nominal: 'b-green', action_required: 'b-amber', critical: 'b-red',
};
const AGENT_DOT: Record<string, string> = {
  idle: 'd-gray', thinking: 'd-blue', planning: 'd-blue', executing: 'd-blue',
  waiting: 'd-amber', paused: 'd-amber', approval_required: 'd-amber',
  completed: 'd-green', failed: 'd-red', cancelled: 'd-gray',
};

export default function MobileSupervisorPage() {
  const briefing = usePoll(() => api('/api/mobile/briefing'), 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [lastStop, setLastStop] = useState<any | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  }, []);

  const decide = async (id: string, decision: 'approve' | 'deny') => {
    setBusy(id + decision);
    try {
      await post(`/api/approvals/${id}/decision`, { decision });
      flash(decision === 'approve' ? '✓ Approved' : '✕ Denied');
    } catch (e: any) { flash(`Error: ${e.message}`); }
    finally { setBusy(null); }
  };

  const emergencyStop = async () => {
    setBusy('es');
    try {
      const r = await post<any>('/api/emergency-stop', { reason: 'triggered from mobile supervisor' });
      setLastStop(r);
      flash('■ OS stopped — all work cancelled, automations paused');
    } catch (e: any) { flash(`Error: ${e.message}`); }
    finally { setBusy(null); setConfirming(false); }
  };

  useEffect(() => { document.documentElement.dataset.theme = 'dark'; }, []);

  if (!briefing) return <div className="empty" style={{ padding: 24 }}>Contacting kernel…</div>;

  const b: any = briefing;
  return (
    <div className="mobile-supervisor">
      <header className="ms-header">
        <div>
          <div className="ms-title">AGENTIC OS</div>
          <div className="ms-sub">Supervisor · {fmtAgo(b.generated_at)}</div>
        </div>
        <span className={`badge ${STATUS_TONE[b.status] ?? 'b-gray'}`}>{b.status.replace('_', ' ')}</span>
      </header>

      <div className="ms-stats">
        <div className="ms-stat"><span>{b.counts.running_executions}</span><label>running</label></div>
        <div className="ms-stat"><span>{b.counts.running_flow_runs}</span><label>flows</label></div>
        <div className="ms-stat"><span>{b.counts.enabled_automations}</span><label>autos on</label></div>
        <div className="ms-stat"><span>{b.counts.unread_notifications}</span><label>unread</label></div>
      </div>

      {b.approvals.length > 0 && (
        <section className="ms-section">
          <h2>APPROVALS <span className="count">{b.approvals.length}</span></h2>
          {b.approvals.map((a: any) => (
            <div key={a.id} className="ms-card ms-approval">
              <div className="ms-card-title">{a.tool}</div>
              <div className="xs dim">{a.reason?.slice(0, 140)}</div>
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button
                  className="primary" style={{ flex: 1 }}
                  disabled={busy === a.id + 'approve'}
                  onClick={() => decide(a.id, 'approve')}>
                  {busy === a.id + 'approve' ? '…' : '✓ Approve'}
                </button>
                <button
                  className="danger" style={{ flex: 1 }}
                  disabled={busy === a.id + 'deny'}
                  onClick={() => decide(a.id, 'deny')}>
                  {busy === a.id + 'deny' ? '…' : '✕ Deny'}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="ms-section">
        <h2>AGENTS <span className="count">{b.agents.length}</span></h2>
        {b.agents.map((a: any) => (
          <div key={a.id} className="ms-card ms-row">
            <span className={`dot ${AGENT_DOT[a.status] ?? 'd-gray'}`} />
            <div className="grow">
              <div className="ms-card-title">{a.name}</div>
              <div className="xs faint">{a.status}</div>
            </div>
          </div>
        ))}
      </section>

      <section className="ms-section">
        <h2>OPEN TASKS <span className="count">{b.open_tasks.length}</span></h2>
        {b.open_tasks.map((t: any) => (
          <div key={t.id} className="ms-card ms-row">
            <div className="grow">
              <div className="ms-card-title">{t.title}</div>
              <div className="xs faint">{t.project_name} · {t.priority} · {t.status}</div>
            </div>
          </div>
        ))}
        {b.open_tasks.length === 0 && <div className="empty">Queue clear.</div>}
      </section>

      <section className="ms-section">
        <h2>RECENT EVENTS</h2>
        {b.recent_events.slice(0, 8).map((e: any) => (
          <div key={e.id} className="ms-card ms-row">
            <div className="grow">
              <div className="xs mono">{e.type}</div>
              <div className="xs faint">{e.summary}</div>
            </div>
          </div>
        ))}
      </section>

      {lastStop && (
        <div className="ms-card ms-stop-report">
          <div className="ms-card-title">■ STOPPED AT {fmtAgo(lastStop.at)}</div>
          <div className="xs dim">
            {lastStop.stopped_executions} execution(s) · {lastStop.cancelled_flow_runs} flow run(s) · {lastStop.paused_automations} automation(s) paused.
            Re-arm automations from the desktop Automations page.
          </div>
        </div>
      )}

      <div className="ms-stop-zone">
        {confirming ? (
          <div className="ms-confirm">
            <div className="small" style={{ fontWeight: 600 }}>Stop ALL running work?</div>
            <div className="xs dim">Cancels every execution + flow run and pauses all automations. This cannot be undone.</div>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button style={{ flex: 1 }} onClick={() => setConfirming(false)}>Cancel</button>
              <button className="danger" style={{ flex: 1 }} disabled={busy === 'es'} onClick={emergencyStop}>
                {busy === 'es' ? 'STOPPING…' : '■ CONFIRM STOP'}
              </button>
            </div>
          </div>
        ) : (
          <button className="ms-stop" aria-label="Emergency stop" onClick={() => setConfirming(true)}>
            ■ EMERGENCY STOP
          </button>
        )}
      </div>

      {toast && <div className="ms-toast" role="status">{toast}</div>}
    </div>
  );
}
