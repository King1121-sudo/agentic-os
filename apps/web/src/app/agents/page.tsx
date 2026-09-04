'use client';
import Shell from '@/components/Shell';
import { useEffect, useState } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

const AUTONOMY = ['L0 Observe', 'L1 Suggest', 'L2 Approval', 'L3 Auto', 'L4 Autonomous'];

export default function AgentsPage() {
  const agents = usePoll(() => api('/api/agents'), 3000) as any[] | null;
  const [showCreate, setShowCreate] = useState(false);

  return (
    <Shell title="Agents">
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Agent Registry</h1>
          <div className="xs faint">Registered agents with model policy, tools, memory policy, autonomy</div>
        </div>
        <button className="primary" onClick={() => setShowCreate(s => !s)}>+ New Agent</button>
      </div>

      {showCreate && <CreateAgent onDone={() => setShowCreate(false)} />}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {(agents ?? []).map((a: any) => (
          <div key={a.id} className="card">
            <div className="between" style={{ marginBottom: 8 }}>
              <div className="row">
                <span className={`dot ${a.status === 'idle' ? 'd-gray' : a.status === 'executing' ? 'd-blue' : a.status === 'approval_required' ? 'd-amber' : 'd-green'}`} />
                <span style={{ fontWeight: 700 }}>{a.name}</span>
              </div>
              <span className="badge b-blue">{AUTONOMY[a.autonomy_level] ?? `L${a.autonomy_level}`}</span>
            </div>
            <div className="xs dim" style={{ minHeight: 32 }}>{a.description}</div>
            <div style={{ margin: '8px 0', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {a.tools.slice(0, 8).map((t: string) => <span key={t} className="badge b-gray mono">{t}</span>)}
              {a.tools.length > 8 && <span className="badge b-gray">+{a.tools.length - 8}</span>}
            </div>
            <div className="row between xs faint">
              <span>memory: {a.memory_policy.read ? 'R' : '–'}{a.memory_policy.write ? 'W' : '–'} · k={a.memory_policy.k}</span>
              <span>{fmtAgo(a.updated_at)}</span>
            </div>
            <ExecuteBox agent={a} />
          </div>
        ))}
      </div>
    </Shell>
  );
}

function ExecuteBox({ agent }: { agent: any }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (!input.trim()) return;
    setBusy(true); setResult(null);
    try {
      const r = await post<any>(`/api/agents/${agent.id}/execute`, { input });
      setResult(`execution ${r.execution_id.slice(0, 8)} — watch it in Activity`);
    } catch (e: any) { setResult(`error: ${e.message}`); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div className="row" style={{ gap: 6 }}>
        <input placeholder={`Direct ${agent.name}…`} value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') run(); }} />
        <button className="primary" disabled={busy || !input.trim()} onClick={run}>{busy ? '…' : 'Run'}</button>
      </div>
      {result && <div className="xs dim" style={{ marginTop: 6 }}>{result}</div>}
    </div>
  );
}

function CreateAgent({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [autonomy, setAutonomy] = useState(2);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await post('/api/agents', { name, description: desc, autonomy_level: autonomy });
      onDone();
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>New Agent</h3>
      <div className="grid cols-3">
        <div><label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Auditor" /></div>
        <div><label>Description</label><input value={desc} onChange={e => setDesc(e.target.value)} placeholder="What it does" /></div>
        <div>
          <label>Autonomy level</label>
          <select value={autonomy} onChange={e => setAutonomy(Number(e.target.value))}>
            {AUTONOMY.map((l, i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={busy || !name.trim()} onClick={create}>Create</button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
