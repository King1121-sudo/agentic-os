'use client';
import Shell from '@/components/Shell';
import { useEffect, useState } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

const META: Record<string, { icon: string; color: string; blurb: string }> = {
  github: { icon: '⌥', color: 'var(--accent)', blurb: 'Repos, pull requests, issues — token or OAuth' },
  gmail:  { icon: '✉', color: 'var(--red)',    blurb: 'Read inbox, send mail — OAuth (Google)' },
  slack:  { icon: '✱', color: 'var(--green)',  blurb: 'Channels + post messages — bot token (xoxb-)' },
};

export default function IntegrationsPage() {
  const integrations = usePoll(() => api('/api/integrations'), 6000) as any[] | null;
  const events = usePoll(() => api('/api/integration-events'), 5000) as any[] | null;
  const [connecting, setConnecting] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [oauthError, setOauthError] = useState('');

  // OAuth callback redirects land here with ?connected=… or ?oauth_error=…
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('oauth_error')) setOauthError(p.get('oauth_error') || 'unknown error');
    if (p.get('connected')) setMsg(`${p.get('connected')} connected ✓`);
    if (p.get('oauth_error') || p.get('connected')) {
      window.history.replaceState({}, '', '/integrations');
      setTimeout(() => { setMsg(''); setOauthError(''); }, 6000);
    }
  }, []);

  async function connectToken(id: string) {
    if (token.trim().length < 8) { setMsg('token looks too short'); return; }
    try {
      const r = await post('/api/integrations/connect', { integration_id: id, token: token.trim() });
      setMsg(`${id} connected as ${r.connection.account} ✓ (scopes: ${r.connection.scopes.join(', ')})`);
      setConnecting(null); setToken('');
    } catch (e: any) {
      setMsg(`error: ${e.message}`);
    }
    setTimeout(() => setMsg(''), 6000);
  }

  async function startOAuth(id: string) {
    try {
      const r = await api(`/api/integrations/${id}/oauth?redirect_to=${encodeURIComponent(window.location.origin + '/integrations')}`);
      window.location.href = r.url; // → provider consent screen
    } catch (e: any) {
      setMsg(`error: ${e.message}`);
      setTimeout(() => setMsg(''), 6000);
    }
  }

  async function disconnect(id: string) {
    if (!confirm(`Disconnect ${id}? Stored tokens are deleted from the vault.`)) return;
    await post(`/api/integrations/${id}/disconnect`, {});
    setMsg(`${id} disconnected`);
    setTimeout(() => setMsg(''), 4000);
  }

  async function testRead(id: string, integration: any) {
    try {
      const body = id === 'github' ? { repo: prompt('owner/name to list open PRs:', 'facebook/react') ?? '' }
        : id === 'slack' ? {}
        : {};
      const r = await post(`/api/integrations/${id}/read`, body);
      const n = (r.results ?? []).length;
      setMsg(`${id} read ok — ${n} item(s)${n ? ': ' + JSON.stringify(r.results[0]).slice(0, 120) : ''}`);
    } catch (e: any) {
      setMsg(`read failed: ${e.message}`);
    }
    setTimeout(() => setMsg(''), 8000);
  }

  return (
    <Shell title="Integrations">
      <div className="between" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Integrations</h1>
          <div className="xs faint">GitHub · Gmail · Slack — tokens encrypted at rest (AES-256-GCM), scoped capabilities, events bridged onto the OS bus</div>
        </div>
        {msg && <span className="xs" style={{ color: msg.startsWith('error') || msg.includes('failed') ? 'var(--red)' : 'var(--green)', maxWidth: 420 }}>{msg}</span>}
      </div>
      {oauthError && <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 10, color: 'var(--red)' }}>OAuth failed: {oauthError}</div>}

      <div className="grid cols-21" style={{ gap: 12 }}>
        <div className="grid" style={{ gap: 12 }}>
          {(integrations ?? []).map(i => {
            const meta = META[i.id] ?? { icon: '⎌', color: 'var(--fg-dim)', blurb: '' };
            const conn = i.connection;
            return (
              <div key={i.id} className="card" style={{ borderColor: conn ? meta.color : 'var(--border)' }}>
                <div className="between" style={{ marginBottom: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ color: meta.color, fontSize: 18 }}>{meta.icon}</span>
                    <div>
                      <b style={{ fontSize: 14 }}>{i.name}</b>
                      <div className="xs faint">{meta.blurb}</div>
                    </div>
                  </div>
                  {conn
                    ? <span className="badge b-green">connected · {conn.account}</span>
                    : <span className="badge b-gray">not connected</span>}
                </div>

                <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
                  <span className="xs dim">scopes:</span>
                  {(conn?.scopes ?? i.required_scopes).map((s: string) => (
                    <span key={s} className="badge b-gray xs">{s}</span>
                  ))}
                </div>

                {conn ? (
                  <div className="row" style={{ gap: 6 }}>
                    <button onClick={() => testRead(i.id, i)}>Test read</button>
                    <button className="danger" onClick={() => disconnect(i.id)}>Disconnect</button>
                  </div>
                ) : (
                  <div className="row" style={{ gap: 6 }}>
                    <button className="primary" onClick={() => setConnecting(connecting === i.id ? null : i.id)}>Connect with token</button>
                    {i.oauth && (
                      <button disabled={!i.oauth_configured} title={i.oauth_configured ? 'Start OAuth consent flow' : 'OAuth app not configured (set client id/secret env)'} onClick={() => startOAuth(i.id)}>
                        OAuth{!i.oauth_configured && ' (unconfigured)'}
                      </button>
                    )}
                  </div>
                )}

                {connecting === i.id && (
                  <div className="row" style={{ marginTop: 8, gap: 6 }}>
                    <input type="password" placeholder={i.id === 'slack' ? 'xoxb-… bot token' : 'personal access token'} value={token} onChange={e => setToken(e.target.value)} style={{ flex: 2 }} />
                    <button onClick={() => connectToken(i.id)}>Verify + store</button>
                  </div>
                )}
                <div className="xs faint" style={{ marginTop: 6 }}>
                  {conn ? `Connected ${fmtAgo(conn.connected_at)} · capabilities: ${(conn.capabilities ?? []).join(', ')}` : 'The token is verified against the provider, then stored encrypted — plaintext never touches the database.'}
                </div>
              </div>
            );
          })}
          {integrations && integrations.length === 0 && <div className="empty">No adapters registered.</div>}
        </div>

        <div className="card" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          <h3>Integration Events <span className="count">{events?.length ?? 0}</span></h3>
          <div className="xs faint" style={{ marginBottom: 8 }}>
            External events bridged onto the OS bus as <span className="mono">integration.event</span> —
            create an automation with event type <span className="mono">integration.event</span> to act on them.
          </div>
          <div className="trace">
            {(events ?? []).map(ev => (
              <div key={ev.id} className="step tool">
                <div className="msg small">
                  <span className="badge b-gray xs">{ev.integration_id}</span> {ev.kind}
                </div>
                <div className="ts">{fmtAgo(ev.received_at)} · {JSON.stringify(ev.payload).slice(0, 90)}</div>
              </div>
            ))}
            {(events ?? []).length === 0 && <div className="empty">No external events yet — connect an integration and use its capabilities.</div>}
          </div>
        </div>
      </div>
    </Shell>
  );
}
