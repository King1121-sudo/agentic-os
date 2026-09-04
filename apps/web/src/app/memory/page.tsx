'use client';
import Shell from '@/components/Shell';
import { useState } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

const TYPES = ['all', 'semantic', 'episodic', 'preference', 'project', 'procedural'];

export default function MemoryPage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [results, setResults] = useState<any[] | null>(null);
  const list = usePoll(() => api(`/api/memory${type !== 'all' ? `?type=${type}` : ''}`), 5000);

  async function search() {
    if (!q.trim()) { setResults(null); return; }
    const r = await api(`/api/memory/search?q=${encodeURIComponent(q)}`);
    setResults(r);
  }

  async function add() {
    const content = prompt('New memory content:');
    if (!content) return;
    await post('/api/memory', { type: type === 'all' ? 'semantic' : type, content, importance: 6 });
  }

  const shown = results ?? list;

  return (
    <Shell title="Memory">
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Memory Engine</h1>
          <div className="xs faint">Semantic · episodic · preference · project · procedural — scored retrieval, decay, consolidation</div>
        </div>
        <div className="row">
          <button onClick={async () => { const r = await post('/api/memory/maintain', {}); alert(`Maintenance: ${r.decayed} decayed, ${r.merged} merged`); }}>Run maintenance</button>
          <button className="primary" onClick={add}>+ Memory</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Search memory — keyword + embedding + recency + importance…" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }} />
        <button className="primary" onClick={search}>Search</button>
        {results && <button onClick={() => { setResults(null); setQ(''); }}>Clear</button>}
      </div>

      <div className="tabs">
        {TYPES.map(t => <button key={t} className={type === t ? 'on' : ''} onClick={() => { setType(t); setResults(null); }}>{t}</button>)}
      </div>

      <div className="grid">
        {(shown ?? []).map((m: any) => (
          <div key={m.id} className="item" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className={`badge ${m.type === 'preference' ? 'b-purple' : m.type === 'episodic' ? 'b-blue' : 'b-gray'}`}>{m.type}</span>
            <div className="grow">
              <div className="small">{m.content}</div>
              <div className="xs faint">
                importance {m.importance} · confidence {m.confidence} · {m.access_count} accesses · {fmtAgo(m.updated_at)}
                {results && <span> · score {Number(m.score).toFixed(3)}</span>}
              </div>
            </div>
            <button className="ghost xs" onClick={async () => { await api(`/api/memory/${m.id}`, { method: 'DELETE' }); }}>✕</button>
          </div>
        ))}
        {shown && shown.length === 0 && <div className="empty">No memories{results ? ' match that query' : ' yet'}.</div>}
      </div>
    </Shell>
  );
}
