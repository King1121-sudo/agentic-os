'use client';
import Shell from '@/components/Shell';
import Link from 'next/link';
import { use } from 'react';
import { useState } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

const AUTONOMY = ['L0 Observe', 'L1 Suggest', 'L2 Approval', 'L3 Auto', 'L4 Autonomous'];

export default function AgentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const agent = usePoll(() => api(`/api/agents/${id}`), 3000, [id]);
  const executions = usePoll(() => api('/api/executions?limit=30'), 3000);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);

  if (!agent) return <Shell title="Agent"><div className="empty">Loading…</div></Shell>;
  const a: any = agent;
  const mine = (executions ?? []).filter((e: any) => e.agent_id === id);

  async function run() {
    if (!input.trim()) return;
    const r = await post<any>(`/api/agents/${id}/execute`, { input });
    setPending(r.execution_id);
    setInput('');
  }

  return (
    <Shell title={a.name}>
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <div className="row">
            <span className={`dot ${a.status === 'idle' ? 'd-gray' : 'd-blue'}`} />
            <h1 style={{ fontSize: 18, fontWeight: 700 }}>{a.name}</h1>
            <span className="badge b-blue">{AUTONOMY[a.autonomy_level] ?? `L${a.autonomy_level}`}</span>
          </div>
          <div className="xs faint">{a.description}</div>
        </div>
        <Link href="/agents" className="btn">← All agents</Link>
      </div>

      {pending && (
        <div className="notice" style={{ marginBottom: 12 }}>
          Execution <span className="mono">{pending.slice(0, 8)}</span> dispatched —{' '}
          <Link href={`/activity?exec=${pending}`}>open live trace</Link>
        </div>
      )}

      <div className="grid cols-21">
        <div className="card">
          <h3>Direct Execution</h3>
          <div className="row">
            <input placeholder={`Instruct ${a.name}… (runs through planner → tools → memory)`} value={input}
              onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') run(); }} />
            <button className="primary" onClick={run}>Execute</button>
          </div>
          <h3 style={{ marginTop: 14 }}>Execution History <span className="count">{mine.length}</span></h3>
          {mine.map((e: any) => (
            <Link key={e.id} href={`/activity?exec=${e.id}`} className="item">
              <span className={`dot ${e.status === 'completed' ? 'd-green' : e.status === 'failed' ? 'd-red' : 'd-blue'}`} />
              <div className="grow">
                <div className="small">{e.input.slice(0, 90)}</div>
                <div className="xs faint">{e.status} · {fmtAgo(e.started_at)} · {e.tokens_in + e.tokens_out} tok</div>
              </div>
            </Link>
          ))}
          {mine.length === 0 && <div className="empty">No executions yet.</div>}
        </div>

        <div className="grid">
          <div className="card">
            <h3>Policy</h3>
            <div className="xs" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><span className="faint">Model capability:</span> <span className="mono">{a.model_policy?.capability}</span></div>
              <div><span className="faint">Memory:</span> read={String(a.memory_policy?.read)} write={String(a.memory_policy?.write)} k={a.memory_policy?.k}</div>
              <div><span className="faint">Autonomy:</span> {AUTONOMY[a.autonomy_level]}</div>
            </div>
            <h3 style={{ marginTop: 12 }}>System Instructions</h3>
            <pre className="code">{a.system_instructions || '—'}</pre>
          </div>
          <div className="card">
            <h3>Tools ({a.tools.length})</h3>
            {a.tools.map((t: string) => <div key={t} className="mono xs dim" style={{ padding: '2px 0' }}>▸ {t}</div>)}
          </div>
        </div>
      </div>
    </Shell>
  );
}
