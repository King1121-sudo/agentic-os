'use client';
import Shell from '@/components/Shell';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '@/lib/api';

/** Node visual metadata by kind. */
const KIND_COLOR: Record<string, string> = {
  person: '#f0883e', org: '#d29922', tech: '#58a6ff', url: '#7ee787', topic: '#bc8cff',
  agent: '#58a6ff', task: '#7ee787', project: '#ffa657', sprint: '#ffa657', skill: '#56d364',
  memory: '#bc8cff', execution: '#8b949e', generation: '#8b949e', default: '#8b949e',
};
const KINDS = ['person', 'org', 'tech', 'url', 'topic', 'agent', 'task', 'project', 'sprint', 'skill', 'memory'];

interface SimNode { id: string; kind: string; label: string; degree: number; weight: number; x: number; y: number; vx: number; vy: number; fx?: number }
interface SimEdge { from: string; to: string; relation: string; derived: boolean }

export default function LinksPage() {
  const [snapshot, setSnapshot] = useState<{ nodes: any[]; edges: any[]; derived: number } | null>(null);
  const [kinds, setKinds] = useState<string[]>(KINDS);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hover, setHover] = useState<SimNode | null>(null);
  const [selected, setSelected] = useState<SimNode | null>(null);
  const [neighborhood, setNeighborhood] = useState<any>(null);
  const [running, setRunning] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<{ nodes: SimNode[]; edges: SimEdge[] }>({ nodes: [], edges: [] });
  const viewRef = useRef<{ scale: number; ox: number; oy: number; dragging: boolean; lastX: number; lastY: number }>({ scale: 1, ox: 0, oy: 0, dragging: false, lastX: 0, lastY: 0 });

  const load = useCallback(async () => {
    const s = await api(`/api/graph${kinds.length ? `?kinds=${kinds.join(',')}` : ''}`);
    setSnapshot(s);
  }, [kinds]);

  useEffect(() => { load(); }, [load]);

  // rebuild the simulation when the snapshot changes
  useEffect(() => {
    if (!snapshot) return;
    const prev = new Map(simRef.current.nodes.map(n => [n.id, n]));
    const nodes: SimNode[] = snapshot.nodes.map((n: any, i: number) => ({
      ...n,
      x: prev.get(n.id)?.x ?? 200 + Math.cos(i * 2.399) * 120,
      y: prev.get(n.id)?.y ?? 150 + Math.sin(i * 2.399) * 90,
      vx: 0, vy: 0,
    }));
    simRef.current = { nodes, edges: snapshot.edges };
  }, [snapshot]);

  // -- force simulation loop (zero-dep): spring links + repulsion + damping --
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const { nodes, edges } = simRef.current;
      if (nodes.length) {
        // repulsion (O(n²) but node counts are small)
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d2 = Math.max(40, dx * dx + dy * dy);
            const f = 900 / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
          }
        }
        // springs along edges (derived links weaker)
        const byId = new Map(nodes.map(n => [n.id, n]));
        for (const e of edges) {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.max(1, Math.hypot(dx, dy));
          const target = e.derived ? 140 : 90;
          const k = (e.derived ? 0.008 : 0.02) * (d - target);
          const fx = (dx / d) * k, fy = (dy / d) * k;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
        // gravity to the center + integrate + damping
        for (const n of nodes) {
          if (n.fx !== undefined) { n.x = n.fx; n.y = n.y ?? n.y; n.vx = 0; n.vy = 0; continue; }
          n.vx += (400 - n.x) * 0.0015;
          n.vy += (260 - n.y) * 0.0015;
          n.vx *= 0.86; n.vy *= 0.86;
          n.x += Math.max(-8, Math.min(8, n.vx));
          n.y += Math.max(-8, Math.min(8, n.vy));
        }
      }
      draw();
      if (running) raf = requestAnimationFrame(step);
    };
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const v = viewRef.current;
      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);
      const { nodes, edges } = simRef.current;
      const byId = new Map(nodes.map(n => [n.id, n]));
      // edges
      for (const e of edges) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        const dimmed = focusId && e.from !== focusId && e.to !== focusId;
        ctx.strokeStyle = e.derived ? 'rgba(188,140,255,0.35)' : 'rgba(88,166,255,0.55)';
        ctx.globalAlpha = dimmed ? 0.12 : 1;
        ctx.lineWidth = e.derived ? 1 : 1.4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // nodes
      for (const n of nodes) {
        const r = 5 + Math.min(14, n.degree * 1.4);
        const dimmed = focusId && n.id !== focusId && !edges.some(e => (e.from === focusId && e.to === n.id) || (e.to === focusId && e.from === n.id));
        ctx.globalAlpha = dimmed ? 0.15 : 1;
        ctx.fillStyle = KIND_COLOR[n.kind] ?? KIND_COLOR.default;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (n.id === focusId || n.id === selected?.id) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        // labels for high-degree nodes (avoid clutter)
        if (n.degree >= 3 || n.id === focusId) {
          ctx.fillStyle = 'rgba(230,237,243,0.9)';
          ctx.font = '10px ui-sans-serif, system-ui';
          ctx.fillText(n.label.slice(0, 18), n.x + r + 3, n.y + 3);
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, focusId, selected]);

  // -- pointer interactions: pan, zoom, hover, click --
  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - rect.left - v.ox) / v.scale, y: (clientY - rect.top - v.oy) / v.scale };
  };
  const nodeAt = (x: number, y: number): SimNode | null => {
    for (const n of simRef.current.nodes) {
      const r = 5 + Math.min(14, n.degree * 1.4) + 4;
      if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) return n;
    }
    return null;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    v.dragging = true; v.lastX = e.clientX; v.lastY = e.clientY;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    if (v.dragging) {
      v.ox += e.clientX - v.lastX; v.oy += e.clientY - v.lastY;
      v.lastX = e.clientX; v.lastY = e.clientY;
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    setHover(nodeAt(w.x, w.y));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    const moved = Math.hypot(e.clientX - v.lastX, e.clientY - v.lastY);
    v.dragging = false;
    if (moved > 5) return; // it was a pan
    const w = toWorld(e.clientX, e.clientY);
    const n = nodeAt(w.x, w.y);
    setSelected(n);
    setFocusId(n ? n.id : null);
    setNeighborhood(null);
    if (n) api(`/api/graph/neighbors?id=${encodeURIComponent(n.id)}`).then(setNeighborhood).catch(() => {});
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    v.scale = Math.max(0.3, Math.min(3, v.scale * factor));
  };

  const [deriveMsg, setDeriveMsg] = useState('');

  const derive = async () => {
    const r = await post('/api/graph/derive', {});
    load();
    setDeriveMsg(`Derived ${r.links_created} new co-occurrence link(s)${r.links_removed ? `, removed ${r.links_removed} stale` : ''} from ${r.pairs_scanned} entity pairs.`);
    setTimeout(() => setDeriveMsg(''), 6000);
  };

  const toggleKind = (k: string) => {
    setKinds(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);
  };

  const derivedCount = snapshot?.derived ?? 0;
  const explicitCount = (snapshot?.edges.length ?? 0) - derivedCount;

  return (
    <Shell title="Links">
      <div className="between" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-h1">Links Explorer</h1>
          <div className="xs faint">
            Knowledge graph — {snapshot?.nodes.length ?? 0} nodes · {explicitCount} explicit · {derivedCount} derived (co-occurrence)
          </div>
        </div>
        <div className="row">
          <button onClick={derive}>⟳ Derive links</button>
          {deriveMsg && <span className="xs mono" style={{ color: 'var(--green)' }} role="status">{deriveMsg}</span>}
          <button onClick={() => setRunning(r => !r)}>{running ? '❚❚ Freeze' : '▶ Animate'}</button>
          <button onClick={() => { setFocusId(null); setSelected(null); setNeighborhood(null); }}>Clear focus</button>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {KINDS.map(k => (
          <button key={k} className={kinds.includes(k) ? 'on' : ''} style={{ fontSize: 11, padding: '2px 8px', border: `1px solid ${KIND_COLOR[k] ?? '#8b949e'}`, color: kinds.includes(k) ? KIND_COLOR[k] ?? '#8b949e' : 'var(--fg-dim)', background: kinds.includes(k) ? 'transparent' : 'var(--bg-hover)' }} onClick={() => toggleKind(k)}>
            ● {k}
          </button>
        ))}
      </div>

      <div className="grid cols-21" style={{ gap: 12 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden', height: 560 }}>
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%', cursor: hover ? 'pointer' : 'grab' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { viewRef.current.dragging = false; setHover(null); }}
            onWheel={onWheel}
          />
          {hover && (
            <div style={{ position: 'absolute', pointerEvents: 'none', background: 'var(--bg-panel-solid)', border: '1px solid var(--border-bright)', borderRadius: 6, padding: '4px 8px', fontSize: 11, left: 12, top: 12 }}>
              <b>{hover.label}</b> <span className="faint">({hover.kind} · {hover.degree} links{hover.weight ? ` · w${hover.weight}` : ''})</span>
            </div>
          )}
        </div>

        <div className="card" style={{ maxHeight: 560, overflowY: 'auto' }}>
          {selected ? (
            <>
              <h3>{selected.label}</h3>
              <div className="xs faint mono">{selected.id}</div>
              <div className="xs dim" style={{ margin: '6px 0' }}>{selected.kind} · {selected.degree} links · {selected.weight} derived</div>
              <div className="xs faint" style={{ marginBottom: 4 }}>NEIGHBORHOOD ({neighborhood?.nodes?.length ?? '…'})</div>
              <div className="trace">
                {(neighborhood?.nodes ?? []).map((n: any) => (
                  <div key={n.id} className="item" onClick={() => { setFocusId(n.id); setSelected(n); api(`/api/graph/neighbors?id=${encodeURIComponent(n.id)}`).then(setNeighborhood).catch(() => {}); }} style={{ cursor: 'pointer' }}>
                    <span className="dot" style={{ background: KIND_COLOR[n.kind] ?? '#8b949e' }} />
                    <div className="grow">
                      <div className="xs">{n.label}</div>
                      <div className="xs faint mono">{n.id}</div>
                    </div>
                  </div>
                ))}
                {neighborhood && (neighborhood.nodes?.length ?? 0) === 0 && <div className="xs faint" style={{ padding: '4px 0' }}>No neighbors.</div>}
              </div>
              {neighborhood?.edges && (
                <>
                  <div className="xs faint" style={{ margin: '8px 0 4px' }}>EDGES ({neighborhood.edges.length})</div>
                  {neighborhood.edges.slice(0, 12).map((e: any, i: number) => (
                    <div key={i} className="xs mono dim" style={{ padding: '2px 0' }}>
                      {e.relation}{e.derived ? ' (derived)' : ''}: {e.from === selected.id ? e.to : e.from}
                    </div>
                  ))}
                </>
              )}
            </>
          ) : (
            <>
              <h3>Graph Guide</h3>
              <div className="xs dim" style={{ lineHeight: 1.7 }}>
                A force-directed map of the OS knowledge graph.
                <br /><br />
                <b>Node size</b> = connection count. <b>Purple edges</b> are derived
                co-occurrence links (entities sharing memories); <b>blue edges</b> are
                explicit kernel links (mentions, delegated_to…).
                <br /><br />
                <b>Drag</b> to pan · <b>scroll</b> to zoom · <b>click</b> a node to focus its
                neighborhood. Filter kinds with the chips above.
                <br /><br />
                <b>⟳ Derive links</b> recomputes co-occurrence from the entity-memory
                join — new memories since the last boot show up immediately.
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
