'use client';
import Shell from '@/components/Shell';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, post, usePoll, fmtTime } from '@/lib/api';

export default function ActivityPage() {
  return (
    <Suspense fallback={<div className="empty">Loading activity…</div>}>
      <ActivityView />
    </Suspense>
  );
}

function ActivityView() {
  const events = usePoll(() => api('/api/events?limit=150'), 3000);
  const [selectedExec, setSelectedExec] = useState<string | null>(null);
  const params = useSearchParams();
  useEffect(() => { const e = params.get('exec'); if (e) setSelectedExec(e); }, [params]);

  return (
    <Shell title="Activity">
      <div className="between" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-h1">OS Activity Stream</h1>
          <div className="xs faint">Every kernel event, live. Click any execution event to open the trace.</div>
        </div>
      </div>
      <div className="grid cols-21">
        <div className="card" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          {(events ?? []).map((e: any) => (
            <div key={e.id} className="ev" style={{ cursor: e.data?.execution_id ? 'pointer' : 'default' }}
              onClick={() => e.data?.execution_id && setSelectedExec(e.data.execution_id)}>
              <span className="t">{fmtTime(e.created_at)}</span>
              <span className="k mono" style={{ color: evColor(e.type) }}>{e.type}</span>
              <span className="d">{summarizeEv(e)}</span>
            </div>
          ))}
          {events && events.length === 0 && <div className="empty">No events yet.</div>}
        </div>
        {selectedExec && <TraceViewer execId={selectedExec} onClose={() => setSelectedExec(null)} />}
      </div>
    </Shell>
  );
}

function evColor(t: string): string {
  if (t.startsWith('agent')) return t.includes('fail') ? 'var(--red)' : t.includes('completed') ? 'var(--green)' : 'var(--accent)';
  if (t.startsWith('tool')) return t.includes('denied') || t.includes('fail') ? 'var(--red)' : 'var(--accent)';
  if (t.startsWith('memory')) return 'var(--purple)';
  if (t.startsWith('approval')) return 'var(--amber)';
  if (t.startsWith('task') || t.startsWith('project')) return 'var(--green)';
  return 'var(--fg-dim)';
}

function summarizeEv(e: any): string {
  const d = e.data ?? {};
  if (d.input) return `${d.agent ? d.agent + ': ' : ''}${String(d.input).slice(0, 90)}`;
  if (d.tool) return `${d.tool}${d.summary ? ` → ${d.summary}` : d.error ? ` ✗ ${d.error}` : ''}`;
  if (d.summary) return d.summary;
  return JSON.stringify(d).slice(0, 110);
}

// --- execution trace viewer (§5: what happened, why, with what) ------------
function TraceViewer({ execId, onClose }: { execId: string; onClose: () => void }) {
  const exec = usePoll(() => api(`/api/executions/${execId}`), 2000, [execId]);
  const [audit, setAudit] = useState<any[]>([]);
  const [gens, setGens] = useState<any[]>([]);
  const [children, setChildren] = useState<any[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  // Phase 5: working-memory window for THIS execution
  const [wm, setWm] = useState<any | null>(null);
  // Phase 2: live token stream for THIS execution (volatile SSE events)
  const [liveText, setLiveText] = useState<{ phase: string; text: string } | null>(null);

  useEffect(() => {
    // Normalize every response: a null/undefined body (e.g. 404) becomes [] —
    // never let a non-array flow into state that the render assumes is a list.
    api(`/api/audit?execution_id=${execId}`).then(r => setAudit(Array.isArray(r) ? r : [])).catch(() => setAudit([]));
    api(`/api/generations?execution_id=${execId}`).then(r => setGens(Array.isArray(r) ? r : [])).catch(() => setGens([]));
    api(`/api/executions/${execId}/children`).then(r => setChildren(Array.isArray(r) ? r : [])).catch(() => setChildren([]));
    api(`/api/executions/${execId}/working-memory`).then(r => setWm(r && !r.error ? r : null)).catch(() => setWm(null));
  }, [execId]);

  // subscribe to token deltas for this execution
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'agent.token' && ev.data?.execution_id === execId) {
          setLiveText(prev => {
            const phase = ev.data.phase ?? '…';
            if (prev && prev.phase === phase) return { phase, text: prev.text + ev.data.delta };
            return { phase, text: ev.data.delta };
          });
        }
      } catch { /* skip */ }
    };
    return () => es.close();
  }, [execId]);

  // clear the live stream once the execution settles
  useEffect(() => {
    if (exec && ['completed', 'failed', 'cancelled'].includes((exec as any).status)) {
      const t = setTimeout(() => setLiveText(null), 1500);
      return () => clearTimeout(t);
    }
  }, [exec]);

  if (!exec) return null;
  const e: any = exec;
  // Wire-shape normalization for the execution record's embedded arrays.
  const traceEntries = Array.isArray(e.trace) ? e.trace : [];
  const planSteps = e.plan && Array.isArray(e.plan.steps) ? e.plan.steps : [];
  const statusBadge = e.status === 'completed' ? 'b-green' : e.status === 'failed' ? 'b-red' :
    e.status === 'approval_required' ? 'b-amber' : e.status === 'paused' ? 'b-amber' :
    e.status === 'interrupted' ? 'b-purple' : e.status === 'cancelled' ? 'b-gray' : 'b-blue';
  const streaming = ['running', 'approval_required', 'paused'].includes(e.status) && liveText;

  return (
    <div className="card" style={{ maxHeight: '72vh', overflowY: 'auto', position: 'sticky', top: 64 }}>
      <div className="between" style={{ marginBottom: 8 }}>
        <div className="row">
          <span className={`badge ${statusBadge}`}>{e.status}</span>
          <span className="xs mono faint">{e.id?.slice(0, 8)}</span>
        </div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <div className="xs dim" style={{ marginBottom: 10 }}>{e.input}</div>

      {streaming && (
        <div style={{
          marginBottom: 12, border: '1px solid var(--accent)', borderRadius: 8,
          background: 'var(--accent-soft)', padding: '8px 12px',
        }}>
          <div className="row between" style={{ marginBottom: 4 }}>
            <span className="badge b-blue">streaming · {liveText!.phase}</span>
            <button className="danger" onClick={() => post(`/api/executions/${execId}/stop`, {})}>■ Stop</button>
          </div>
          <div className="mono xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto' }}>
            {liveText!.text}
          </div>
        </div>
      )}

      <div className="row wrap" style={{ marginBottom: 12, gap: 6 }}>
        {e.status === 'running' && <button onClick={() => post(`/api/executions/${execId}/pause`, {})}>Pause</button>}
        {(e.status === 'paused' || e.status === 'interrupted') && <button className="primary" onClick={() => post(`/api/executions/${execId}/resume`, {})}>Resume from checkpoint</button>}
        {['running', 'paused', 'approval_required', 'interrupted'].includes(e.status) && <button className="danger" onClick={() => post(`/api/executions/${execId}/stop`, {})}>Stop</button>}
        <button className={showAudit ? 'primary' : ''} onClick={() => setShowAudit(s => !s)}>Audit ({audit.length})</button>
        <span className="badge b-gray">{e.tokens_in}+{e.tokens_out} tok</span>
      </div>

      {children.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="xs faint" style={{ marginBottom: 4 }}>DELEGATED EXECUTIONS ({children.length})</div>
          {children.map((c: any) => (
            <div key={c.id} className="item" onClick={() => window.open(`/activity?exec=${c.id}`, '_self')}>
              <span className={`dot ${c.status === 'completed' ? 'd-green' : c.status === 'failed' ? 'd-red' : c.status === 'running' ? 'd-cyan' : 'd-gray'}`} />
              <div className="grow">
                <div className="small">{c.input?.slice(0, 80)}</div>
                <div className="xs faint mono">{c.id.slice(0, 8)} · {c.status}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {planSteps.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="xs faint" style={{ marginBottom: 4 }}>PLAN — {e.plan.rationale}</div>
          <div className="trace">
            {planSteps.map((s: any, i: number) => (
              <div key={i} className={`step ${s.kind}`}>
                <div className="msg small">
                  {s.kind === 'tool' && <span className="badge b-blue">tool</span>}
                  {s.kind === 'model' && <span className="badge b-purple">model</span>}
                  {s.kind === 'skill' && <span className="badge b-green">skill</span>}
                  {' '}{s.tool ?? s.capability ?? s.skill}
                  {s.kind === 'tool' && s.args && Object.keys(s.args).length > 0 && (
                    <span className="xs faint"> {JSON.stringify(s.args).slice(0, 80)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {wm && Array.isArray(wm.facts) && (
        <div style={{ marginBottom: 12 }}>
          <div className="xs faint" style={{ marginBottom: 4 }}>
            WORKING MEMORY — {wm.pinned_memory_ids?.length ?? 0} pinned · {wm.facts.length} facts · ~{wm.token_estimate} tokens
            {wm.closed_at ? ' · closed' : ' · open'}
          </div>
          <div className="trace">
            {(wm.pinned_memory_ids ?? []).length > 0 && (
              <div className="step memory">
                <div className="msg small">
                  <span className="badge b-purple">pinned</span>{' '}
                  {wm.pinned_memory_ids.map((id: string) => id.slice(0, 8)).join(', ')}
                </div>
                <div className="ts">long-term memories retrieved at planning</div>
              </div>
            )}
            {wm.facts.slice().reverse().map((f: any, i: number) => (
              <div key={i} className={`step ${f.source === 'retrieval' ? 'memory' : f.source}`}>
                <div className="msg small">{f.text}</div>
                <div className="ts">{fmtTime(f.ts)} · {f.source}{f.step ? ` · step ${f.step}` : ''}</div>
              </div>
            ))}
            {wm.facts.length === 0 && (wm.pinned_memory_ids ?? []).length === 0 && (
              <div className="xs faint" style={{ padding: '4px 0' }}>(empty window)</div>
            )}
          </div>
        </div>
      )}

      <div className="xs faint" style={{ marginBottom: 4 }}>EXECUTION TRACE ({traceEntries.length})</div>
      <div className="trace">
        {traceEntries.map((t: any, i: number) => (
          <div key={i} className={`step ${t.kind}`}>
            <div className="msg">{t.message}</div>
            <div className="ts">{fmtTime(t.ts)} · {t.kind}</div>
          </div>
        ))}
      </div>

      {showAudit && (
        <div style={{ marginTop: 12 }}>
          <div className="xs faint" style={{ marginBottom: 4 }}>AUDIT LOG</div>
          <table className="tbl">
            <thead><tr><th>time</th><th>actor</th><th>action</th><th>target</th></tr></thead>
            <tbody>
              {audit.map((a: any) => (
                <tr key={a.id}>
                  <td className="mono xs">{fmtTime(a.ts)}</td>
                  <td className="xs">{a.actor_type}</td>
                  <td className="mono xs">{a.action}</td>
                  <td className="xs dim">{a.target_type}{a.target_id ? `:${a.target_id.slice(0, 8)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {e.result && (
        <div style={{ marginTop: 12 }}>
          <div className="xs faint" style={{ marginBottom: 4 }}>RESULT</div>
          <pre className="code">{e.result}</pre>
        </div>
      )}
      {gens.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="xs faint" style={{ marginBottom: 4 }}>GENERATIONS ({gens.length})</div>
          {gens.map((g: any) => (
            <div key={g.id} className="row between xs" style={{ padding: '3px 0' }}>
              <span className="mono">{g.model_id}</span>
              <span className="dim">{g.input_tokens}+{g.output_tokens} tok · {g.latency_ms}ms</span>
              <span className={`badge ${g.status === 'completed' ? 'b-green' : 'b-red'}`}>{g.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
