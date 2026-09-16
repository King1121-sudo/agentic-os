'use client';
/**
 * LiveExecutionPanel — the "I gave JARVIS a task and I watch it work" surface.
 * Renders ONE execution from the ExecutionStore: ack, breathing agent badge,
 * human-friendly activity (§13 Level 1), expandable technical detail (Level 2),
 * streaming response, real controls (pause/stop/approve/deny), honest failure.
 *
 * Complexity-aware (§21): mounts ONLY when a live/finished execution exists
 * from the current session's command. Simple local answers render as a result
 * card (handled by the command surface itself), never this panel.
 */
import { useEffect, useState } from 'react';
import { api, post, fmtAgo } from '@/lib/api';
import { useExecutionStore, type LiveExecution } from '@/lib/execution-store';

const STATE_COPY: Record<string, { label: string; cls: string }> = {
  received: { label: 'Received', cls: 'exec-received' },
  understanding: { label: 'Understanding', cls: 'exec-understanding' },
  planning: { label: 'Planning', cls: 'exec-planning' },
  executing: { label: 'Executing', cls: 'exec-executing' },
  waiting: { label: 'Waiting', cls: 'exec-waiting' },
  approval_required: { label: 'Approval required', cls: 'exec-approval' },
  completing: { label: 'Finishing', cls: 'exec-completing' },
  completed: { label: 'Completed', cls: 'exec-completed' },
  failed: { label: 'Failed', cls: 'exec-failed' },
  cancelled: { label: 'Cancelled', cls: 'exec-cancelled' },
};

const ICON: Record<string, string> = {
  done: '✓', active: '●', pending: '○', warn: '⚠', fail: '✕',
};

const ICON_COLOR: Record<string, string> = {
  done: 'var(--green)', active: 'var(--cyan)', pending: 'var(--fg-faint)',
  warn: 'var(--orange)', fail: 'var(--red)',
};

const ACTIVE = ['received', 'understanding', 'planning', 'executing', 'waiting', 'approval_required', 'completing'];

export function LiveExecutionPanel({ exec: ex, onClose }: { exec: LiveExecution; onClose: () => void }) {
  const [showTech, setShowTech] = useState(false);
  const [elapsed, setElapsed] = useState('');
  const store = useExecutionStore();
  const copy = STATE_COPY[ex.state] ?? STATE_COPY.received;
  const active = ACTIVE.includes(ex.state);

  // live duration ticker — real elapsed time since the backend's started_at
  useEffect(() => {
    if (!active) {
      setElapsed(ex.completedAt ? fmtAgo(ex.completedAt) : '');
      return;
    }
    const tick = () => {
      const ms = Date.now() - Date.parse(ex.startedAt);
      if (ms < 60_000) setElapsed(`${Math.max(1, Math.round(ms / 1000))}s`);
      else if (ms < 3_600_000) setElapsed(`${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`);
      else setElapsed(`${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [ex.startedAt, ex.completedAt, active]);

  const control = async (action: 'pause' | 'resume' | 'stop') => {
    await post(`/api/executions/${ex.id}/${action}`, {}).catch(() => {});
  };

  const decide = async (decision: 'approve' | 'deny') => {
    // find this execution's pending approval — real id from the API, never guessed
    try {
      const pending = await api('/api/approvals?status=pending');
      const mine = (Array.isArray(pending) ? pending : []).find((a: any) => a.execution_id === ex.id);
      if (mine) await post(`/api/approvals/${mine.id}/decision`, { decision });
    } catch { /* the SSE event will still update state */ }
  };

  return (
    <section
      className={`live-exec ${active ? 'is-active' : `is-${ex.state}`}`}
      aria-label={`Execution by ${ex.agent} — ${copy.label}`}
      role="region"
    >
      <header className="live-exec-head">
        <div className="live-exec-id">
          <span className={`exec-agent-badge ${copy.cls}`} aria-hidden="true">
            <span className="exec-agent-initial">{ex.agent.charAt(0).toUpperCase()}</span>
          </span>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <strong>{ex.agent}</strong>
              <span className={`exec-state-label ${copy.cls}`}>{copy.label}</span>
            </div>
            <div className="xs faint mono" style={{ marginTop: 1 }}>
              {ex.id.slice(0, 8)}{active && elapsed ? ` · ${elapsed}` : ''}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexShrink: 0 }}>
          {ex.state === 'executing' && <button onClick={() => control('pause')}>Pause</button>}
          {ex.state === 'waiting' && <button className="primary" onClick={() => control('resume')}>Resume</button>}
          {active && ex.state !== 'approval_required' && <button className="danger" onClick={() => control('stop')}>Stop</button>}
          <button className="ghost" onClick={onClose} aria-label="Dismiss panel">✕</button>
        </div>
      </header>

      {ex.state === 'approval_required' && (
        <div className="approval-inline" role="alertdialog" aria-label="Approval required">
          <div className="small" style={{ fontWeight: 600, color: 'var(--orange)' }}>A decision is blocking execution</div>
          <div className="xs dim" style={{ marginTop: 2 }}>
            {ex.activity.filter(l => l.kind === 'approval').slice(-1)[0]?.label ?? 'Approval required'}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button className="primary" onClick={() => decide('approve')}>Approve</button>
            <button className="danger" onClick={() => decide('deny')}>Deny</button>
          </div>
        </div>
      )}

      {ex.state === 'failed' && (
        <div className="exec-failure" role="alert">
          <div className="small" style={{ fontWeight: 600, color: 'var(--red)' }}>✕ Execution failed</div>
          <div className="xs dim" style={{ marginTop: 2 }}>{ex.error ?? 'The agent reported a failure.'}</div>
        </div>
      )}

      <ol className="live-activity" aria-label="Execution activity">
        {ex.activity.map(line => (
          <li key={line.id} className={`activity-line icon-${line.icon} ${line.kind ? `kind-${line.kind}` : ''}`}>
            <span className="activity-icon" style={{ color: ICON_COLOR[line.icon] }} aria-hidden="true">
              {ICON[line.icon] ?? '○'}
            </span>
            <span className="activity-label">{line.label}</span>
            {showTech && (line.detail || line.ts) && (
              <span className="activity-detail mono xs">
                {line.detail}{line.detail && line.ts ? ' · ' : ''}{line.ts ? line.ts.slice(11, 19) : ''}
              </span>
            )}
          </li>
        ))}
      </ol>

      {ex.streaming && active && (
        <div className="live-stream" aria-live="polite">
          <div className="xs faint mono" style={{ marginBottom: 4 }}>streaming · {ex.streaming.phase}</div>
          <div className="mono xs live-stream-text">{ex.streaming.text}</div>
        </div>
      )}

      {ex.state === 'completed' && ex.result && (
        <div className="live-result">
          <div className="xs faint" style={{ marginBottom: 4 }}>RESULT</div>
          <pre className="code" style={{ margin: 0, maxHeight: 200, overflowY: 'auto' }}>{ex.result}</pre>
        </div>
      )}

      <footer className="live-exec-foot">
        <button className="ghost xs" onClick={() => setShowTech(s => !s)} aria-expanded={showTech}>
          {showTech ? 'Hide details' : 'Technical details'}
        </button>
        <a className="xs dim" href={`/activity?exec=${ex.id}`} onClick={e => { e.preventDefault(); window.location.href = `/activity?exec=${ex.id}`; }}>
          Full trace ↗
        </a>
        {active && !store.connected && <span className="xs" style={{ color: 'var(--orange)' }}>Reconnecting…</span>}
      </footer>
    </section>
  );
}
