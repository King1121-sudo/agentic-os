'use client';
import Shell from '@/components/Shell';
import { useState } from 'react';
import { api, usePoll } from '@/lib/api';

/** Links Explorer (§10) — simple interactive graph of entity relationships. */
export default function LinksPage() {
  const [focus, setFocus] = useState<{ type: string; id: string; title: string } | null>(null);
  const entities = usePoll(() => api('/api/entities'), 5000) as any[] | null;
  const links = usePoll(() => api('/api/links'), 5000) as any[] | null;

  const focused = usePoll(
    () => focus ? api(`/api/links?type=${focus.type}&id=${focus.id}`) : Promise.resolve([]),
    5000, [focus?.type, focus?.id],
  ) as any[] | null;

  const titleFor = (type: string, id: string): string => {
    const e = (entities ?? []).find((x: any) => x.kind === type && x.entity_id === id);
    return e?.title ?? `${type}:${id.slice(0, 8)}`;
  };

  return (
    <Shell title="Links">
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Links Explorer</h1>
          <div className="xs faint">Knowledge graph — every entity and its relationships. Click to traverse.</div>
        </div>
      </div>

      <div className="grid cols-21">
        <div className="card" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <h3>Entities <span className="count">{entities?.length ?? 0}</span></h3>
          {(entities ?? []).map((e: any) => (
            <div key={e.id} className={`item ${focus && focus.type === e.kind && focus.id === e.entity_id ? 'sel' : ''}`}
              onClick={() => setFocus({ type: e.kind, id: e.entity_id, title: e.title })}>
              <span className="badge b-gray">{e.kind}</span>
              <div className="grow">
                <div className="small">{e.title}</div>
                <div className="xs faint">{e.subtitle?.slice(0, 70)}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          {focus ? (
            <>
              <h3>{focus.title}</h3>
              <div className="xs faint" style={{ marginBottom: 8 }}>{focus.type}:{focus.id.slice(0, 12)}…</div>
              {(focused ?? []).map((l: any) => {
                const outgoing = l.from_type === focus.type && l.from_id === focus.id;
                const other = outgoing ? { type: l.to_type, id: l.to_id } : { type: l.from_type, id: l.from_id };
                return (
                  <div key={l.id} className="item" onClick={() => setFocus({ type: other.type, id: other.id, title: titleFor(other.type, other.id) })}>
                    <span className="badge b-blue">{outgoing ? '→' : '←'} {l.relation}</span>
                    <div className="grow">
                      <div className="small">{titleFor(other.type, other.id)}</div>
                      <div className="xs faint mono">{other.type}:{other.id.slice(0, 10)}</div>
                    </div>
                  </div>
                );
              })}
              {(focused ?? []).length === 0 && <div className="empty">No links from this entity yet.</div>}
            </>
          ) : (
            <div className="empty">Select an entity to explore its relationships.</div>
          )}
        </div>
      </div>
    </Shell>
  );
}
