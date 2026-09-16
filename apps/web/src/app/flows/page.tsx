'use client';
import Shell from '@/components/Shell';
import { useCallback, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, applyNodeChanges, applyEdgeChanges, addEdge, type Node, type Edge, type NodeChange, type EdgeChange, type Connection, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, post, patch, usePoll, fmtAgo } from '@/lib/api';

// --- node kind styling ------------------------------------------------------
const KIND_META: Record<string, { icon: string; color: string; hint: string }> = {
  trigger:    { icon: '⚡', color: 'var(--amber)',      hint: 'Flow entry point (run input)' },
  agent:      { icon: 'Ⓢ', color: 'var(--accent)',      hint: 'Run an agent to completion' },
  skill:      { icon: 'Ⓥ', color: 'var(--green)',      hint: 'Execute a skill via an agent' },
  tool:       { icon: '🔧', color: 'var(--blue)', hint: 'Call a tool directly' },
  condition:  { icon: '◇', color: 'var(--purple)',      hint: 'Boolean expression → true/false edges' },
  branch:     { icon: '⑃', color: 'var(--purple)',      hint: 'Route by ctx value → labeled edges' },
  loop:       { icon: '↻', color: 'var(--amber)',       hint: 'Repeat body N times' },
  wait:       { icon: '⏱', color: 'var(--fg-dim)',      hint: 'Pause seconds' },
  approval:   { icon: '✋', color: 'var(--red)',         hint: 'Human approval gate' },
};

function FlowNodeView({ data, selected }: { data: Record<string, unknown>; selected?: boolean }) {
  const kind = String(data.kind ?? 'tool');
  const meta = KIND_META[kind] ?? KIND_META.tool;
  return (
    <div style={{
      background: 'var(--bg-panel-solid)', border: `1.5px solid ${selected ? meta.color : 'var(--border-bright)'}`,
      borderRadius: 10, padding: '7px 12px', minWidth: 150, fontSize: 12,
      boxShadow: selected ? `0 0 0 2px ${meta.color}33` : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: meta.color, fontSize: 14 }}>{meta.icon}</span>
        <b style={{ fontSize: 12 }}>{String(data.label ?? kind)}</b>
      </div>
      <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>
        {String(data.summary ?? meta.hint).slice(0, 42)}
      </div>
      {/* branch/condition outputs */}
      {(kind === 'condition' || kind === 'branch' || kind === 'loop') && (
        <>
          <Handle id={kind === 'loop' ? 'body' : 'true'} type="source" position={Position.Bottom} style={{ left: '30%', background: 'var(--green)' }} />
          <Handle id={kind === 'loop' ? 'exit' : 'false'} type="source" position={Position.Bottom} style={{ left: '70%', background: 'var(--red)' }} />
        </>
      )}
      {(kind === 'trigger') ? (
        <Handle type="source" position={Position.Bottom} style={{ background: meta.color }} />
      ) : (
        <Handle type="target" position={Position.Top} style={{ background: 'var(--fg-dim)' }} />
      )}
      {kind !== 'trigger' && kind !== 'condition' && kind !== 'branch' && kind !== 'loop' && (
        <Handle type="source" position={Position.Bottom} style={{ background: meta.color }} />
      )}
    </div>
  );
}

const nodeTypes = { flow: FlowNodeView };

// --- node config editor -----------------------------------------------------
const CONFIG_FIELDS: Record<string, { key: string; label: string; placeholder?: string }[]> = {
  trigger:  [{ key: 'defaults', label: 'defaults (json)', placeholder: '{"input": "hello"}' }],
  agent:    [{ key: 'agent_name', label: 'agent', placeholder: 'Hermes' }, { key: 'input', label: 'input template', placeholder: 'Summarize ${ctx.content}' }],
  skill:    [{ key: 'skill_name', label: 'skill' }, { key: 'agent_name', label: 'via agent (default Hermes)' }, { key: 'input', label: 'input template' }],
  tool:     [{ key: 'tool_name', label: 'tool' }, { key: 'args', label: 'args (json)', placeholder: '{"query": "${ctx.input}"}' }],
  condition: [{ key: 'expression', label: 'expression', placeholder: 'ctx.score > 5' }],
  branch:   [{ key: 'value_from', label: 'value from (ctx path)', placeholder: 'ctx.route' }],
  loop:     [{ key: 'max_iterations', label: 'max iterations (1-100)', placeholder: '3' }],
  wait:     [{ key: 'seconds', label: 'seconds (1-300)', placeholder: '10' }],
  approval: [{ key: 'reason', label: 'approval reason', placeholder: 'Publish to production?' }],
};

export default function FlowsPage() {
  const flows = usePoll(() => api('/api/flows'), 8000) as any[] | null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runs = usePoll(() => selectedId ? api(`/api/flows/${selectedId}/runs`) : Promise.resolve([]), 4000, [selectedId]) as any[] | null;
  const activeRun = (runs ?? []).find(r => ['running', 'waiting', 'paused', 'interrupted'].includes(r.status)) ?? null;
  const activeRunLive = usePoll(() => activeRun ? api(`/api/flow-runs/${activeRun.id}`) : Promise.resolve(null), 2000, [activeRun?.id]) as any | null;

  // -- builder canvas state --
  const [nodes, setNodes] = useState<Node<Record<string, unknown>>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [name, setName] = useState('New Flow');
  const [editingId, setEditingId] = useState<string | null>(null); // selected node id
  const [saveMsg, setSaveMsg] = useState('');
  const editingNode = nodes.find(n => n.id === editingId);

  // load a flow into the canvas
  const loadFlow = useCallback((f: any) => {
    setSelectedId(f.id);
    setName(f.name);
    setNodes((f.nodes ?? []).map((n: any) => ({
      id: n.id, type: 'flow', position: { x: n.x ?? 0, y: n.y ?? 0 },
      data: { kind: n.kind, label: n.label ?? n.id, summary: configSummary(n), config: n.config ?? {} },
    })));
    setEdges((f.edges ?? []).map((e: any) => ({
      id: e.id, source: e.from, target: e.to, sourceHandle: e.from_handle ?? undefined,
      label: e.from_handle ?? undefined, animated: !e.from_handle,
      style: e.from_handle ? { stroke: e.from_handle === 'true' || e.from_handle === 'body' ? 'var(--green)' : 'var(--red)' } : undefined,
    })));
  }, []);

  // blank canvas
  const newFlow = () => {
    setSelectedId(null); setEditingId(null);
    setName('New Flow');
    setNodes([{ id: 'trigger1', type: 'flow', position: { x: 300, y: 40 }, data: { kind: 'trigger', label: 'Start', summary: 'Flow entry point', config: {} } }]);
    setEdges([]);
  };

  // add a node from the palette
  const addNode = (kind: string) => {
    const id = `${kind}${Date.now().toString(36)}`;
    setNodes(ns => [...ns, {
      id, type: 'flow', position: { x: 120 + (ns.length * 60) % 500, y: 80 + (ns.length * 90) % 400 },
      data: { kind, label: kind.charAt(0).toUpperCase() + kind.slice(1), summary: configSummary({ kind, config: {} }), config: {} },
    }]);
    setEditingId(id);
  };

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes(ns => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges(es => applyEdgeChanges(changes, es)), []);
  const onConnect = useCallback((c: Connection) => setEdges(es => addEdge({ ...c, animated: true }, es)), []);

  // config edit on the selected node
  const setConfigField = (key: string, value: string) => {
    if (!editingId) return;
    setNodes(ns => ns.map(n => {
      if (n.id !== editingId) return n;
      const config: Record<string, unknown> = { ...((n.data.config as Record<string, unknown> | undefined) ?? {}) };
      // try JSON for structured fields
      if (['defaults', 'args'].includes(key)) {
        try { config[key] = value ? JSON.parse(value) : {}; } catch { config[key] = value; }
      } else {
        config[key] = value;
      }
      const summary = configSummary({ kind: String(n.data.kind), config });
      return { ...n, data: { ...n.data, config, summary } };
    }));
  };

  // -- save --
  async function save() {
    const payload = {
      name,
      nodes: nodes.map(n => ({
        id: n.id, kind: n.data.kind, label: n.data.label === n.id ? undefined : n.data.label,
        config: n.data.config ?? {}, x: Math.round(n.position.x), y: Math.round(n.position.y),
      })),
      edges: edges.map(e => ({ id: e.id, from: e.source, to: e.target, from_handle: e.sourceHandle ?? undefined })),
    };
    try {
      const saved = selectedId
        ? await patch(`/api/flows/${selectedId}`, payload)
        : await post('/api/flows', payload);
      setSaveMsg(`saved v${saved.version}`);
      setSelectedId(saved.id);
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (e: any) {
      setSaveMsg(`error: ${e.message}`);
      setTimeout(() => setSaveMsg(''), 4000);
    }
  }

  async function runFlow() {
    if (!selectedId) { setSaveMsg('save the flow first'); return; }
    await post(`/api/flows/${selectedId}/run`, { input: {} });
    setSaveMsg('started');
    setTimeout(() => setSaveMsg(''), 2000);
  }

  return (
    <Shell title="Flows">
      <div className="between" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-h1">Flow Builder</h1>
          <div className="xs faint">Visual automation graphs — trigger → agents, skills, tools, branches, loops, waits, approvals</div>
        </div>
        <div className="row">
          <button onClick={newFlow}>New</button>
          <button className="primary" onClick={save}>Save</button>
          {selectedId && <button onClick={runFlow}>▶ Run</button>}
          {saveMsg && <span className="xs" style={{ color: saveMsg.startsWith('error') ? 'var(--red)' : 'var(--green)' }}>{saveMsg}</span>}
        </div>
      </div>

      <div className="grid cols-21" style={{ gap: 12 }}>
        {/* left: flow list */}
        <div className="card" style={{ maxHeight: '74vh', overflowY: 'auto' }}>
          <h3>Saved Flows <span className="count">{flows?.length ?? 0}</span></h3>
          <div className="xs" style={{ marginBottom: 8, color: 'var(--fg-dim)' }}>Add nodes from the palette below the canvas.</div>
          {(flows ?? []).map((f: any) => (
            <div key={f.id} className={`item ${selectedId === f.id ? 'sel' : ''}`} onClick={() => loadFlow(f)}>
              <span className="badge b-blue">v{f.version}</span>
              <div className="grow">
                <div className="small" style={{ fontWeight: 600 }}>{f.name}</div>
                <div className="xs faint">{f.nodes?.length ?? 0} nodes · {fmtAgo(f.updated_at)}</div>
              </div>
              <button className="ghost xs" onClick={async e => {
                e.stopPropagation();
                if (confirm(`Delete flow "${f.name}" and its runs?`)) {
                  await api(`/api/flows/${f.id}`, { method: 'DELETE' });
                  if (selectedId === f.id) newFlow();
                }
              }}>✕</button>
            </div>
          ))}
          {(flows ?? []).length === 0 && <div className="empty">No flows yet — build one and hit Save.</div>}

          {/* runs of the selected flow */}
          {selectedId && (runs ?? []).length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Runs <span className="count">{(runs ?? []).length}</span></h3>
              {(runs ?? []).slice(0, 8).map((r: any) => (
                <div key={r.id} className="item" style={{ fontSize: 11 }}>
                  <span className={`dot ${r.status === 'completed' ? 'd-green' : r.status === 'failed' ? 'd-red' : r.status === 'waiting' || r.status === 'paused' || r.status === 'interrupted' ? 'd-amber' : 'd-cyan'}`} />
                  <div className="grow">
                    <div className="xs">{r.status} · {r.completed_nodes?.length ?? 0} nodes · {fmtAgo(r.started_at)}</div>
                    <div className="xs faint" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.error ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)?.slice(0, 80)) ?? '…'}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    {['paused', 'interrupted'].includes(r.status) && <button className="xs" onClick={() => post(`/api/flow-runs/${r.id}/resume`, {})}>▶</button>}
                    {['running', 'waiting'].includes(r.status) && <button className="xs danger" onClick={() => post(`/api/flow-runs/${r.id}/stop`, {})}>■</button>}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* right: canvas + palette + inspector */}
        <div className="grid" style={{ gap: 12 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <input value={name} onChange={e => setName(e.target.value)} style={{ fontWeight: 700, width: '60%' }} />
            </div>
            <div style={{ height: 420 }}>
              <ReactFlow
                nodes={nodes} edges={edges} nodeTypes={nodeTypes}
                onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
                onNodeClick={(_, n) => setEditingId(n.id)}
                fitView proOptions={{ hideAttribution: true }}
              >
                <Background color="var(--border)" gap={18} />
                <Controls />
                <MiniMap pannable zoomable style={{ background: 'var(--bg-hover)' }} />
              </ReactFlow>
            </div>
          </div>

          {/* palette */}
          <div className="card">
            <h3>Node Palette</h3>
            <div className="row wrap" style={{ gap: 6 }}>
              {Object.entries(KIND_META).map(([kind, m]) => (
                <button key={kind} onClick={() => addNode(kind)} title={m.hint}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                  <span style={{ color: m.color }}>{m.icon}</span> {kind}
                </button>
              ))}
            </div>
          </div>

          {/* node inspector */}
          {editingNode && (
            <div className="card">
              <h3>Node — <span className="mono xs">{editingNode.id}</span></h3>
              <div className="row" style={{ marginBottom: 8 }}>
                <input value={String(editingNode.data.label ?? '')} onChange={e => {
                  setNodes(ns => ns.map(n => n.id === editingNode.id ? { ...n, data: { ...n.data, label: e.target.value } } : n));
                }} placeholder="Label" style={{ width: 140 }} />
                <span className="badge b-gray">{String(editingNode.data.kind)}</span>
              </div>
              {(CONFIG_FIELDS[String(editingNode.data.kind)] ?? []).map(f => {
                const raw = (editingNode.data.config as Record<string, unknown> | undefined)?.[f.key];
                const val = typeof raw === 'object' ? JSON.stringify(raw) : (raw ?? '');
                return (
                  <div className="row" key={f.key} style={{ marginBottom: 6 }}>
                    <span className="xs dim" style={{ width: 150 }}>{f.label}</span>
                    <input value={String(val)} placeholder={f.placeholder}
                      onChange={e => setConfigField(f.key, e.target.value)} />
                  </div>
                );
              })}
              <div className="xs faint">{KIND_META[String(editingNode.data.kind)]?.hint}</div>
            </div>
          )}

          {/* live run trace */}
          {activeRunLive && (
            <div className="card" style={{ borderColor: 'var(--accent)' }}>
              <div className="between" style={{ marginBottom: 6 }}>
                <h3 style={{ color: 'var(--accent)' }}>RUN — {activeRunLive.status} · {activeRunLive.completed_nodes?.length ?? 0} nodes done</h3>
                <div className="row" style={{ gap: 6 }}>
                  {['paused', 'interrupted', 'waiting'].includes(activeRunLive.status) && (
                    <button className="primary xs" onClick={() => post(`/api/flow-runs/${activeRunLive.id}/resume`, {})}>▶ Resume</button>
                  )}
                  {['running', 'waiting', 'paused'].includes(activeRunLive.status) && (
                    <button className="danger xs" onClick={() => post(`/api/flow-runs/${activeRunLive.id}/stop`, {})}>■ Stop</button>
                  )}
                </div>
              </div>
              <div className="trace" style={{ maxHeight: 160, overflowY: 'auto' }}>
                {(activeRunLive.trace ?? []).slice().reverse().map((t: any, i: number) => (
                  <div key={i} className={`step ${t.kind === 'error' ? 'error' : t.kind}`}>
                    <div className="msg small">{t.message}</div>
                    <div className="ts">{t.node ?? '—'} · {t.kind}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function configSummary(n: { kind: string; config: Record<string, unknown> }): string {
  const c = n.config ?? {};
  switch (n.kind) {
    case 'agent': return String(c.agent_name ?? 'pick agent');
    case 'skill': return String(c.skill_name ?? 'pick skill');
    case 'tool': return String(c.tool_name ?? 'pick tool');
    case 'condition': return String(c.expression ?? 'expression');
    case 'branch': return `on ${String(c.value_from ?? 'ctx.?')}`;
    case 'loop': return `×${String(c.max_iterations ?? '?')}`;
    case 'wait': return `${String(c.seconds ?? '?')}s`;
    case 'approval': return String(c.reason ?? 'approval').slice(0, 40);
    case 'trigger': return 'entry point';
    default: return '';
  }
}
