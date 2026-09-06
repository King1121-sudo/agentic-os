'use client';
import Shell from '@/components/Shell';
import { useState } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

const TYPES = ['all', 'semantic', 'episodic', 'preference', 'project', 'procedural'];

export default function MemoryPage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [results, setResults] = useState<any[] | null>(null);
  const [entityFocus, setEntityFocus] = useState<{ id: string; title: string } | null>(null);
  const list = usePoll(() => api(`/api/memory${type !== 'all' ? `?type=${type}` : ''}`), 5000);
  const vector = usePoll(() => api('/api/memory/vector-stats'), 15000);
  const entityMems = usePoll(
    () => entityFocus ? api(`/api/memory/entities/${encodeURIComponent(entityFocus.id)}`) : Promise.resolve(null),
    5000, [entityFocus?.id],
  );

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

  const shown = entityFocus ? (entityMems?.memories ?? []) : (results ?? list);

  return (
    <Shell title="Memory">
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Memory Engine</h1>
          <div className="xs faint">
            Entity graph · working-memory windows · semantic retrieval — scored, decayed, consolidated
            {vector && <span style={{ color: 'var(--accent)' }}> · vector driver: {vector.kind} ({vector.dim}d, {vector.provider})</span>}
          </div>
        </div>
        <div className="row">
          <button onClick={async () => {
            const r = await post('/api/memory/entities/backfill', {});
            alert(`Entity backfill: ${r.processed} memories scanned → ${r.entities} entities (${r.memories} distinct)`);
          }}>Extract entities</button>
          <button onClick={async () => { const r = await post('/api/memory/maintain', {}); alert(`Maintenance: ${r.decayed} decayed, ${r.merged} merged`); }}>Run maintenance</button>
          <button className="primary" onClick={add}>+ Memory</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Search memory — keyword + vector + recency + importance…" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }} />
        <button className="primary" onClick={search}>Search</button>
        {results && <button onClick={() => { setResults(null); setQ(''); }}>Clear</button>}
        {entityFocus && <button onClick={() => setEntityFocus(null)}>← All memories</button>}
      </div>

      <div className="tabs">
        {TYPES.map(t => <button key={t} className={type === t ? 'on' : ''} onClick={() => { setType(t); setResults(null); setEntityFocus(null); }}>{t}</button>)}
      </div>

      {entityFocus && (
        <div className="xs" style={{ marginBottom: 8, color: 'var(--purple)' }}>
          Memories linked to <b>{entityFocus.title}</b> — via the entity graph ({entityFocus.id})
        </div>
      )}

      <div className="grid">
        {(shown ?? []).map((m: any) => (
          <div key={m.id} className="item" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className={`badge ${m.type === 'preference' ? 'b-purple' : m.type === 'episodic' ? 'b-blue' : 'b-gray'}`}>{m.type}</span>
            <div className="grow">
              <div className="small">{m.content}</div>
              {Array.isArray(m.entity_refs) && m.entity_refs.length > 0 && (
                <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                  {m.entity_refs.slice(0, 8).map((ref: string) => {
                    const [kind, ...rest] = ref.split(':');
                    const title = rest.join(':').replace(/-/g, ' ');
                    return (
                      <span key={ref} className="badge b-purple xs" style={{ cursor: 'pointer' }}
                        title={`memories linked to ${ref}`}
                        onClick={ev => { ev.stopPropagation(); setEntityFocus({ id: ref, title }); }}>
                        {kind} · {title}
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="xs faint">
                importance {m.importance} · confidence {m.confidence} · {m.access_count} accesses · {fmtAgo(m.updated_at)}
                {results && <span> · score {Number(m.score).toFixed(3)}</span>}
              </div>
            </div>
            <button className="ghost xs" onClick={async () => { await api(`/api/memory/${m.id}`, { method: 'DELETE' }); }}>✕</button>
          </div>
        ))}
        {shown && shown.length === 0 && <div className="empty">No memories{entityFocus ? ' link to that entity' : results ? ' match that query' : ' yet'}.</div>}
      </div>
    </Shell>
  );
}
