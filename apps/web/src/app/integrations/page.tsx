'use client';
/**
 * Integrations — manifest-driven platform UI (finalization Phases 14/15/22).
 * Everything renders from the provider catalog the API returns: auth methods
 * (OAuth vs token vs bot — per provider, never generic), capability grants,
 * config status (configured / not_configured / misconfigured), connections
 * grouped under shared identities (Google), and health.
 */
import Shell from '@/components/Shell';
import { useEffect, useState } from 'react';
import { api, post, usePoll, fmtAgo } from '@/lib/api';

const STATUS_BADGE: Record<string, string> = {
  connected: 'b-green', disconnected: 'b-gray', reauth_required: 'b-amber', error: 'b-red',
};
const CONFIG_BADGE: Record<string, { cls: string; text: string }> = {
  configured: { cls: 'b-green', text: 'Configured' },
  not_configured: { cls: 'b-gray', text: 'Not configured' },
  misconfigured: { cls: 'b-red', text: 'Misconfigured' },
};

export default function IntegrationsPage() {
  const providers = usePoll(() => api('/api/integrations'), 8000) as any[] | null;
  const events = usePoll(() => api('/api/integration-events'), 6000) as any[] | null;
  const [tokenForms, setTokenForms] = useState<Record<string, { [k: string]: string }>>({});
  const [selectedCaps, setSelectedCaps] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState('');
  const [oauthError, setOauthError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // OAuth callback lands here with ?connected=… or ?oauth_error=…
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('oauth_error')) setOauthError(p.get('oauth_error') || 'unknown error');
    if (p.get('connected')) setMsg(`${p.get('connected')} connected ✓`);
    if (p.get('oauth_error') || p.get('connected')) {
      window.history.replaceState({}, '', '/integrations');
      setTimeout(() => { setMsg(''); setOauthError(''); }, 6000);
    }
  }, []);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 6000); };

  async function connectToken(providerId: string, method: any) {
    const fields = tokenForms[providerId] ?? {};
    // multiple token fields (WhatsApp: token + phone_number_id) join with |
    const ordered: string[] = (method.tokenFields ?? []).map((f: any) => (fields[f.name] ?? '').trim());
    if (ordered.some((v: string) => !v)) { flash('fill in all credential fields'); return; }
    const token = ordered.join('|');
    setBusy(providerId);
    try {
      const r = await post('/api/integrations/connect', { integration_id: providerId, token });
      flash(`${providerId} connected as ${r.connection.account} ✓ (${r.connection.capabilities.length} capabilities)`);
      setTokenForms(t => ({ ...t, [providerId]: {} }));
    } catch (e: any) { flash(`error: ${e.message}`); }
    finally { setBusy(null); }
  }

  async function startOAuth(providerId: string) {
    try {
      // least privilege: only the capabilities the user selected (defaults to
      // the manifest's default set) become the OAuth scope request
      const caps = (selectedCaps[providerId] ?? []).join(',');
      const capQuery = caps ? `&capabilities=${encodeURIComponent(caps)}` : '';
      const r = await api(`/api/integrations/${providerId}/oauth?redirect_to=${encodeURIComponent(window.location.origin + '/integrations')}${capQuery}`);
      window.location.href = r.url; // → provider consent screen
    } catch (e: any) { flash(`error: ${e.message}`); }
  }

  async function disconnect(connectionId: string, providerId: string) {
    if (!confirm(`Disconnect this ${providerId} account? Stored credentials are deleted from the vault.`)) return;
    await post(`/api/integrations/${providerId}/disconnect`, { connection_id: connectionId });
    flash(`${providerId} disconnected`);
  }

  async function testHealth(providerId: string) {
    try {
      const r = await api(`/api/integrations/${providerId}/health`);
      if (!r.length) { flash('no connections to test'); return; }
      flash(r.map((h: any) => `${h.account}: ${h.status}`).join(' · '));
    } catch (e: any) { flash(`health check failed: ${e.message}`); }
  }

  return (
    <Shell title="Integrations">
      <div className="between" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-h1">Integrations</h1>
          <div className="xs faint">
            Universal integration platform — providers declare their own authentication + capabilities.
            Credentials encrypted at rest (AES-256-GCM); every agent action is capability-gated + audited.
          </div>
        </div>
        {msg && <span className="xs" style={{ color: msg.startsWith('error') ? 'var(--red)' : 'var(--green)', maxWidth: 420 }}>{msg}</span>}
      </div>
      {oauthError && <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 10, color: 'var(--red)' }}>OAuth failed: {oauthError}</div>}

      <div className="grid cols-21" style={{ gap: 12 }}>
        <div className="grid" style={{ gap: 12 }}>
          {(providers ?? []).map(p => {
            const conns = p.connections ?? [];
            return (
              <div key={p.id} className="card" style={{ borderColor: conns.some((c: any) => c.status === 'connected') ? p.color : 'var(--border)' }}>
                <div className="between" style={{ marginBottom: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ color: p.color, fontSize: 18 }}>{p.icon}</span>
                    <div>
                      <b style={{ fontSize: 14 }}>{p.name}</b>
                      <div className="xs faint">{p.blurb}</div>
                    </div>
                  </div>
                  <span className="badge b-gray">{p.category}</span>
                </div>

                {/* authentication: exactly what the provider supports */}
                <div className="xs dim" style={{ marginBottom: 4 }}>Authentication</div>
                <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
                  {p.authMethods.map((m: any) => {
                    const cfg = CONFIG_BADGE[m.configStatus] ?? { cls: 'b-gray', text: m.configStatus };
                    return (
                      <span key={m.kind} className={`badge ${cfg.cls}`} title={m.label}>
                        {m.label}
                        {m.configStatus !== 'configured' && m.kind === 'oauth2' ? ` · ${cfg.text}` : ''}
                      </span>
                    );
                  })}
                </div>

                {/* capabilities */}
                <div className="xs dim" style={{ marginBottom: 4 }}>Capabilities</div>
                <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
                  {p.capabilities.map((c: any) => (
                    <span key={c.id} className={`badge ${c.required ? 'b-blue' : 'b-gray'}`} title={c.description ?? c.label}>
                      {c.required ? '★ ' : ''}{c.label}
                    </span>
                  ))}
                </div>

                {/* connections (multi-account; grouped by identity) */}
                {conns.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginBottom: 8 }}>
                    {conns.map((c: any) => (
                      <div key={c.id} className="between" style={{ padding: '4px 0' }}>
                        <div className="row" style={{ gap: 6 }}>
                          <span className={`badge ${STATUS_BADGE[c.status] ?? 'b-gray'}`}>{c.status.replaceAll('_', ' ')}</span>
                          <span className="small">{c.account_id}</span>
                          {c.identity_key && <span className="xs faint">· {c.identity_key}</span>}
                        </div>
                        <div className="row" style={{ gap: 4 }}>
                          <span className="xs faint">{c.last_error ? `error ${fmtAgo(c.last_error_at)}` : `ok ${fmtAgo(c.updated_at)}`}</span>
                          <button className="danger" onClick={() => disconnect(c.id, p.id)}>Disconnect</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* connect controls — shown when NO active connection exists
                    (a reauth_required row still shows the reconnect path) */}
                {conns.filter((c: any) => c.status === 'connected' || c.status === 'reauth_required').length === 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    {p.authMethods.map((m: any) => {
                      if (m.kind === 'oauth2') {
                        const disabled = m.configStatus !== 'configured';
                        if (disabled) {
                          return (
                            <div key={m.kind} className="xs faint" style={{ marginBottom: 4 }}>
                                              {m.label} · NOT CONFIGURED — set the provider's client id/secret env vars,
                              then restart the backend.
                                              <span style={{ display: 'block', marginTop: 2 }}>Redirect URI for the provider console: <span className="mono">{window.location.origin}/api/integrations/{p.id === 'gmail' || p.id === 'youtube' ? 'google' : p.id}/oauth/callback</span></span>
                            </div>
                          );
                        }
                        const reauth = conns.some((c: any) => c.status === 'reauth_required');
                        return (
                          <div key={m.kind}>
                            {/* least privilege: choose capabilities before consent */}
                            <div className="row wrap" style={{ gap: 4, marginBottom: 6 }}>
                              {p.capabilities.map((c: any) => {
                                const sel = (selectedCaps[p.id] ?? p.defaultCapabilities ?? []).includes(c.id);
                                return (
                                  <button key={c.id}
                                    className={sel ? 'primary' : ''}
                                    style={{ fontSize: 11, padding: '2px 8px' }}
                                    title={c.description ?? c.label}
                                    onClick={() => setSelectedCaps(s => {
                                      const cur = s[p.id] ?? p.defaultCapabilities ?? [];
                                      return { ...s, [p.id]: cur.includes(c.id) ? cur.filter(x => x !== c.id) : [...cur, c.id] };
                                    })}>
                                    {sel ? '☑' : '☐'} {c.label}
                                  </button>
                                );
                              })}
                            </div>
                            <button className="primary" onClick={() => startOAuth(p.id)}>
                              {reauth ? 'Reconnect Google' : `Connect with ${m.label}`}
                            </button>
                          </div>
                        );
                      }
                      // token / bot_token: render exactly the fields the provider declares
                      return (
                        <div key={m.kind} style={{ marginTop: 6 }}>
                          <div className="row wrap" style={{ gap: 6 }}>
                            {(m.tokenFields ?? []).map((f: any) => (
                              <input key={f.name} type="password" placeholder={f.placeholder ?? f.label} style={{ flex: 1, minWidth: 140 }}
                                value={(tokenForms[p.id] ?? {})[f.name] ?? ''}
                                onChange={e => setTokenForms(t => ({ ...t, [p.id]: { ...(t[p.id] ?? {}), [f.name]: e.target.value } }))} />
                            ))}
                            <button disabled={busy === p.id} onClick={() => connectToken(p.id, m)}>
                              {busy === p.id ? 'Verifying…' : `Connect with ${m.label}`}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* REAUTH_REQUIRED: Google authorization expired/revoked */}
                {conns.some((c: any) => c.status === 'reauth_required') && (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <span className="badge b-amber">Google authorization expired or was revoked</span>
                    <button className="primary" onClick={() => startOAuth(p.id)}>Reconnect Google</button>
                  </div>
                )}

                {conns.filter((c: any) => c.status === 'connected').length > 0 && (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <button onClick={() => testHealth(p.id)}>Test connection</button>
                  </div>
                )}

                {p.apiNotes?.length > 0 && (
                  <div className="xs faint" style={{ marginTop: 6 }}>
                    {p.apiNotes.map((n: string, i: number) => <div key={i}>⚠ {n}</div>)}
                  </div>
                )}
              </div>
            );
          })}
          {providers && providers.length === 0 && <div className="empty">No providers registered.</div>}
        </div>

        <div className="card" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          <h3>Integration Events <span className="count">{events?.length ?? 0}</span></h3>
          <div className="xs faint" style={{ marginBottom: 8 }}>
            Normalized external events on the OS bus (<span className="mono">integration.event</span>) —
            webhooks are signature-verified + replay-protected; polling is cursor-synced.
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
            {(events ?? []).length === 0 && <div className="empty">No external events yet — connect an integration.</div>}
          </div>
        </div>
      </div>
    </Shell>
  );
}
