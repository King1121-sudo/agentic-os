'use client';
import Shell from '@/components/Shell';
import { api, usePoll } from '@/lib/api';

export default function SettingsPage() {
  const health = usePoll(() => api('/api/health'), 5000);
  const models = usePoll(() => api('/api/models'), 8000);
  const me = usePoll(() => api('/api/auth/me'), 30000);

  return (
    <Shell title="Settings">
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Settings & System</h1>

      <div className="grid cols-2">
        <div className="card">
          <h3>Kernel</h3>
          <div className="row between small" style={{ padding: '3px 0' }}><span>Version</span><span className="mono">{(health as any)?.version}</span></div>
          <div className="row between small" style={{ padding: '3px 0' }}><span>Database</span><span className={`badge ${(health as any)?.db === 'up' ? 'b-green' : 'b-red'}`}>{(health as any)?.db}</span></div>
          <div className="row between small" style={{ padding: '3px 0' }}><span>User</span><span className="mono">{(me as any)?.username}</span></div>
          <h3 style={{ marginTop: 12 }}>Providers</h3>
          {((health as any)?.providers ?? []).map((p: any) => (
            <div key={p.id} className="row between small" style={{ padding: '3px 0' }}>
              <span className="mono">{p.id} <span className="faint">({p.kind})</span></span>
              <span className={`badge ${p.status === 'up' ? 'b-green' : 'b-gray'}`}>{p.status}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>Model Registry <span className="count">{((models as any)?.models ?? []).length}</span></h3>
          <table className="tbl">
            <thead><tr><th>Model</th><th>Provider</th><th>Capabilities</th><th>Priority</th><th>Health</th></tr></thead>
            <tbody>
              {((models as any)?.models ?? []).map((m: any) => (
                <tr key={m.id}>
                  <td className="mono xs">{m.display_name}</td>
                  <td className="xs">{m.provider_id}</td>
                  <td className="xs">{JSON.parse(m.capabilities).join(', ')}</td>
                  <td className="xs mono">{m.priority}</td>
                  <td><span className={`badge ${m.provider_status === 'up' ? 'b-green' : 'b-gray'}`}>{m.provider_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="xs faint" style={{ marginTop: 8 }}>
            Add models via .env: OPENAI_BASE_URL + OPENAI_API_KEY (any OpenAI-compatible API) or OLLAMA_BASE_URL. The router health-checks and picks per capability with automatic fallback.
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Autonomy Levels (kernel-wide policy)</h3>
        <table className="tbl">
          <thead><tr><th>Level</th><th>Policy</th></tr></thead>
          <tbody>
            <tr><td>L0</td><td>Observe only — no tools</td></tr>
            <tr><td>L1</td><td>Suggest — low-risk read tools only</td></tr>
            <tr><td>L2 (default)</td><td>Execute with approval — medium tools gated by human approval on impact</td></tr>
            <tr><td>L3</td><td>Execute automatically — high-risk tools still approval-gated</td></tr>
            <tr><td>L4</td><td>Autonomous within boundaries — high-risk tools still approval-gated</td></tr>
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
