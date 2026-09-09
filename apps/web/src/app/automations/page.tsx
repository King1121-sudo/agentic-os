'use client';
import Shell from '@/components/Shell';
import { useState } from 'react';
import { api, post, patch, usePoll, fmtAgo } from '@/lib/api';

const TRIGGER_META: Record<string, { icon: string; color: string; hint: string }> = {
  cron:    { icon: '⏰', color: 'var(--amber)', hint: '5-field cron schedule' },
  event:   { icon: '⚡', color: 'var(--accent)', hint: 'fires when a matching OS event lands on the bus' },
  webhook: { icon: '🪝', color: 'var(--green)', hint: 'external POST /api/webhooks/:id with the secret' },
};
const ACTION_META: Record<string, { icon: string; hint: string }> = {
  flow:  { icon: '⎔', hint: 'starts a flow run' },
  agent: { icon: 'Ⓢ', hint: 'runs an agent' },
};

export default function AutomationsPage() {
  const automations = usePoll(() => api('/api/automations'), 5000) as any[] | null;
  const allRuns = usePoll(() => api('/api/automation-runs'), 5000) as any[] | null;
  const flows = usePoll(() => api('/api/flows'), 15000) as any[] | null;
  const agents = usePoll(() => api('/api/agents'), 15000) as any[] | null;
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const selectedRuns = usePoll(
    () => selected ? api(`/api/automations/${selected}/runs`) : Promise.resolve([]),
    4000, [selected],
  ) as any[] | null;
  const selectedAuto = (automations ?? []).find(a => a.id === selected) ?? null;

  // create form state
  const [f, setF] = useState({
    name: '', trigger: 'event', schedule: '*/5 * * * *', event_type: 'task.completed', pattern: '',
    action: 'agent', agent_name: 'Hermes', flow_id: '', input: '', autonomy_level: 2,
  });

  async function create() {
    if (!f.name.trim()) { setMsg('name required'); return; }
    const body: any = {
      name: f.name, trigger: f.trigger, action: f.action,
      trigger_config: f.trigger === 'cron' ? { schedule: f.schedule }
        : f.trigger === 'event' ? { event_type: f.event_type, ...(f.pattern ? { pattern: f.pattern } : {}) }
        : {},
      action_config: f.action === 'flow' ? { flow_id: f.flow_id, input: f.input } : { agent_name: f.agent_name, input: f.input },
      autonomy_level: Number(f.autonomy_level), enabled: true,
    };
    try {
      const created = await post('/api/automations', body);
      setMsg(`created${created.trigger_config?.secret ? ' — webhook secret: ' + created.trigger_config.secret : ''}`);
      setCreating(false);
      setSelected(created.id);
      setTimeout(() => setMsg(''), 6000);
    } catch (e: any) {
      setMsg(`error: ${e.message}`);
      setTimeout(() => setMsg(''), 4000);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await post(`/api/automations/${id}/toggle`, { enabled });
  }

  async function testFire(id: string) {
    const r = await post(`/api/automations/${id}/test`, {});
    setMsg(`test fire: ${r.status}${r.reason ? ' — ' + r.reason : ''} (target: ${r.target_id?.slice(0, 8) ?? '—'})`);
    setTimeout(() => setMsg(''), 6000);
  }

  return (
    <Shell title="Automations">
      <div className="between" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-h1">Automation Inspector</h1>
          <div className="xs faint">Cron, event and webhook triggers → flows or agents. Every fire is policy-gated and logged.</div>
        </div>
        <div className="row">
          {msg && <span className="xs" style={{ color: msg.startsWith('error') ? 'var(--red)' : 'var(--green)', maxWidth: 400 }}>{msg}</span>}
          <button className="primary" onClick={() => setCreating(c => !c)}>{creating ? 'Cancel' : '+ Automation'}</button>
        </div>
      </div>

      {/* create form */}
      {creating && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>New Automation</h3>
          <div className="row" style={{ marginBottom: 8 }}>
            <input placeholder="Name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} style={{ flex: 2 }} />
            <select value={f.trigger} onChange={e => setF({ ...f, trigger: e.target.value })}>
              <option value="event">event trigger</option>
              <option value="cron">cron trigger</option>
              <option value="webhook">webhook trigger</option>
            </select>
            <select value={f.action} onChange={e => setF({ ...f, action: e.target.value })}>
              <option value="agent">run agent</option>
              <option value="flow">run flow</option>
            </select>
          </div>
          {f.trigger === 'cron' && (
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="xs dim" style={{ width: 130 }}>cron schedule</span>
              <input value={f.schedule} onChange={e => setF({ ...f, schedule: e.target.value })} placeholder="min hour dom mon dow" />
            </div>
          )}
          {f.trigger === 'event' && (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="xs dim" style={{ width: 130 }}>event type</span>
                <input value={f.event_type} onChange={e => setF({ ...f, event_type: e.target.value })} placeholder="task.completed / flow.run.completed / …" />
              </div>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="xs dim" style={{ width: 130 }}>pattern (optional)</span>
                <input value={f.pattern} onChange={e => setF({ ...f, pattern: e.target.value })} placeholder="substring to match in event data" />
              </div>
            </>
          )}
          {f.action === 'agent' ? (
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="xs dim" style={{ width: 130 }}>agent</span>
              <select value={f.agent_name} onChange={e => setF({ ...f, agent_name: e.target.value })}>
                {(agents ?? []).map((a: any) => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="xs dim" style={{ width: 130 }}>flow</span>
              <select value={f.flow_id} onChange={e => setF({ ...f, flow_id: e.target.value })}>
                <option value="">— pick a flow —</option>
                {(flows ?? []).map((fl: any) => <option key={fl.id} value={fl.id}>{fl.name} (v{fl.version})</option>)}
              </select>
            </div>
          )}
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="xs dim" style={{ width: 130 }}>input template</span>
            <input value={f.input} onChange={e => setF({ ...f, input: e.target.value })}
              placeholder={f.action === 'agent' ? 'Task done: ${event.event_type}' : 'input for the flow'} />
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="xs dim" style={{ width: 130 }}>autonomy policy</span>
            <select value={f.autonomy_level} onChange={e => setF({ ...f, autonomy_level: Number(e.target.value) })}>
              <option value={0}>0 — observe only (never dispatch)</option>
              <option value={1}>1 — suggest (skipped dispatch)</option>
              <option value={2}>2 — dispatch (flows/agents gate internally)</option>
              <option value={3}>3 — dispatch, high-impact still gated</option>
              <option value={4}>4 — autonomous</option>
            </select>
          </div>
          <div className="row">
            <button className="primary" onClick={create}>Create</button>
            <span className="xs faint">{TRIGGER_META[f.trigger]?.hint} → {ACTION_META[f.action]?.hint}</span>
          </div>
        </div>
      )}

      <div className="grid cols-21" style={{ gap: 12 }}>
        {/* automation list */}
        <div className="card" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          <h3>Automations <span className="count">{automations?.length ?? 0}</span></h3>
          {(automations ?? []).map(a => {
            const tm = TRIGGER_META[a.trigger] ?? TRIGGER_META.event;
            const am = ACTION_META[a.action] ?? ACTION_META.agent;
            return (
              <div key={a.id} className={`item ${selected === a.id ? 'sel' : ''}`} onClick={() => setSelected(a.id)}>
                <span style={{ color: tm.color, fontSize: 15 }}>{tm.icon}</span>
                <div className="grow">
                  <div className="small" style={{ fontWeight: 600 }}>
                    {a.name} {!a.enabled && <span className="badge b-gray">paused</span>}
                  </div>
                  <div className="xs faint">
                    {am.icon} {a.action} · autonomy {a.autonomy_level} · {a.run_count} runs
                    {a.last_fired_at && <span> · last {fmtAgo(a.last_fired_at)}</span>}
                    {a.trigger === 'cron' && <span> · {String(a.trigger_config.schedule)}</span>}
                    {a.trigger === 'event' && <span> · on {String(a.trigger_config.event_type)}</span>}
                    {a.trigger === 'webhook' && <span> · webhook ready</span>}
                  </div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="xs" title="test-fire" onClick={e => { e.stopPropagation(); testFire(a.id); }}>⚡</button>
                  <button className="xs" onClick={e => { e.stopPropagation(); toggle(a.id, !a.enabled); }}>{a.enabled ? 'Pause' : 'Enable'}</button>
                  <button className="ghost xs" onClick={async e => {
                    e.stopPropagation();
                    if (confirm(`Delete automation "${a.name}"?`)) await api(`/api/automations/${a.id}`, { method: 'DELETE' });
                  }}>✕</button>
                </div>
              </div>
            );
          })}
          {(automations ?? []).length === 0 && <div className="empty">No automations yet — create one above.</div>}
        </div>

        {/* inspector: selected automation + run log */}
        <div className="card" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          {selectedAuto ? (
            <>
              <h3>{selectedAuto.name}</h3>
              <div className="xs faint" style={{ marginBottom: 8 }}>{selectedAuto.description || TRIGGER_META[selectedAuto.trigger]?.hint}</div>
              <table className="tbl" style={{ marginBottom: 10 }}>
                <tbody>
                  <tr><td className="xs dim">Trigger</td><td className="mono xs">{selectedAuto.trigger} {JSON.stringify(selectedAuto.trigger_config).slice(0, 80)}</td></tr>
                  <tr><td className="xs dim">Action</td><td className="mono xs">{selectedAuto.action} {JSON.stringify(selectedAuto.action_config).slice(0, 80)}</td></tr>
                  <tr><td className="xs dim">Autonomy policy</td><td className="xs">level {selectedAuto.autonomy_level} — {['observe only', 'suggest (skip dispatch)', 'dispatch (internal gates)', 'dispatch, high-impact gated', 'autonomous'][selectedAuto.autonomy_level]}</td></tr>
                  <tr><td className="xs dim">Stats</td><td className="xs">{selectedAuto.run_count} runs · last fired {selectedAuto.last_fired_at ? fmtAgo(selectedAuto.last_fired_at) : 'never'}</td></tr>
                  {selectedAuto.trigger === 'webhook' && (
                    <tr><td className="xs dim">Webhook URL</td>
                      <td className="mono xs">POST /api/webhooks/{selectedAuto.id}<br />Authorization: Bearer {String(selectedAuto.trigger_config.secret ?? '')}</td></tr>
                  )}
                </tbody>
              </table>
              <div className="xs faint" style={{ marginBottom: 4 }}>RUN LOG ({(selectedRuns ?? []).length})</div>
              <div className="trace">
                {(selectedRuns ?? []).map(r => (
                  <div key={r.id} className={`step ${r.status === 'failed' ? 'error' : r.status === 'skipped' ? 'approval' : 'tool'}`}>
                    <div className="msg small">{r.status} — {r.reason}</div>
                    <div className="ts">{r.trigger} · {fmtAgo(r.fired_at)}{r.target_id ? ` · target ${String(r.target_id).slice(0, 8)}` : ''}</div>
                  </div>
                ))}
                {(selectedRuns ?? []).length === 0 && <div className="xs faint" style={{ padding: '4px 0' }}>No runs yet — test-fire with ⚡.</div>}
              </div>
            </>
          ) : (
            <>
              <h3>Recent Runs (all automations)</h3>
              <div className="trace">
                {(allRuns ?? []).slice(0, 25).map(r => (
                  <div key={r.id} className={`step ${r.status === 'failed' ? 'error' : r.status === 'skipped' ? 'approval' : 'tool'}`}>
                    <div className="msg small">{r.status} — {r.reason}</div>
                    <div className="ts">{r.trigger} · {fmtAgo(r.fired_at)}{r.target_id ? ` · target ${String(r.target_id).slice(0, 8)}` : ''}</div>
                  </div>
                ))}
                {(allRuns ?? []).length === 0 && <div className="empty">No automation runs yet.</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
