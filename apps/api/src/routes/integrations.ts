/**
 * integrations routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as store from '../modules/store';
import { redactSecrets, intakeWebhook } from '../modules/integrations';
import { IntegrationConnectTokenInput, IntegrationConnectOAuthInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerIntegrationsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus, integrationsService } = ctx;

// ─── Integration Platform ──────────────────────────────────────────────────
// GET /api/integrations — provider catalog (config status, no secrets) + connections
app.get('/api/integrations', async (req: any) => {
  const providers = integrationsService.listProviders();
  const conns = await integrationsService.listConnections(req.user.id);
  return providers.map((p: any) => ({ ...p, connections: conns.filter(c => c.provider === p.id) }));
});

app.post('/api/integrations/connect', async (req: any, reply: any) => {
  const parsed = IntegrationConnectTokenInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const provider = integrationsService.getAdapter(d.integration_id);
  if (!provider) return reply.code(404).send({ error: 'unknown provider' });
  try {
    const conn = await integrationsService.connectWithToken(
      req.user.id, d.integration_id, d.token, 'token',
      (d as any).capabilities ?? provider.manifest.defaultCapabilities ?? [], (d as any).label);
    return { connected: true, connection: { id: conn.id, provider: conn.provider, account: conn.account_id, capabilities: conn.capabilities, scopes: conn.scopes } };
  } catch (e: any) {
    return reply.code(400).send({ error: String(e?.message ?? e).slice(0, 200) });
  }
});

app.post('/api/integrations/:id/disconnect', async (req: any, reply: any) => {
  // :id may be a connection id OR a provider id (single-connection convenience)
  let target = String((req.body ?? {}).connection_id ?? '');
  if (!target || !(await integrationsService.getConnection(target))) {
    const conns = await integrationsService.listConnections(req.user.id, String(req.params.id));
    if (conns.length === 0) return reply.code(404).send({ error: 'no connections for this provider' });
    if (conns.length > 1 && !target) return reply.code(400).send({ error: 'multiple connections — pass connection_id' });
    target = target || conns[0].id;
  }
  const ok = await integrationsService.disconnect(req.user.id, target);
  if (!ok) return reply.code(404).send({ error: 'connection not found' });
  return { disconnected: true };
});

// capability-gated execution (Phase 16 pipeline; also used by agent tools)
app.post('/api/integrations/capability', async (req: any, reply: any) => {
  const { connection_id, capability, args } = (req.body ?? {}) as Record<string, unknown>;
  if (!connection_id || !capability) return reply.code(400).send({ error: 'needs connection_id + capability' });
  try {
    const result = await integrationsService.executeCapability(req.user.id, String(connection_id), String(capability), (args as any) ?? {});
    await store.audit(db, { actor_type: 'user', actor_id: req.user.id, action: 'integration.execute',
      meta: redactSecrets({ capability, connection_id, ok: true }) });
    return { ok: true, result };
  } catch (e: any) {
    await store.audit(db, { actor_type: 'user', actor_id: req.user.id, action: 'integration.execute',
      meta: redactSecrets({ capability, connection_id, ok: false, error: String(e?.message ?? e).slice(0, 160) }) });
    return reply.code(400).send({ error: String(e?.message ?? e).slice(0, 200) });
  }
});

app.get('/api/integrations/:id/health', async (req: any) => {
  const conns = await integrationsService.listConnections(req.user.id, String(req.params.id));
  const out = [];
  for (const c of conns) {
    out.push({ connection_id: c.id, account: c.account_id, ...(await integrationsService.healthCheck(req.user.id, c.id)) });
  }
  return out;
});

app.get('/api/integrations/:id/events', async (req: any) =>
  integrationsService.listEvents(50, String(req.params.id)));
app.get('/api/integration-events', async () => integrationsService.listEvents(50));

// OAuth: start (consent URL w/ state + PKCE) + complete (code exchange)
app.get('/api/integrations/:id/oauth', async (req: any, reply: any) => {
  try {
    const caps = String(req.query?.capabilities ?? '').split(',').filter(Boolean);
    const { url, state } = await integrationsService.startOAuth(
      req.user.id, String(req.params.id), caps, (req.query?.redirect_to as string) ?? null);
    return { url, state };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});
app.post('/api/integrations/oauth/complete', async (req: any, reply: any) => {
  const parsed = IntegrationConnectOAuthInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  try {
    const conn = await integrationsService.completeOAuth(req.user.id, parsed.data.integration_id, parsed.data.state, parsed.data.code);
    return { connected: true, connection: { id: conn.id, provider: conn.provider, account: conn.account_id, capabilities: conn.capabilities } };
  } catch (e: any) {
    return reply.code(400).send({ error: String(e?.message ?? e).slice(0, 200) });
  }
});
// provider callbacks (302 from consent screen) — session-exempt by URL
// prefix; the one-time state row carries the user.
app.get('/api/integrations/:id/oauth/callback', async (req: any, reply: any) => {
  const state = String(req.query?.state ?? '');
  const code = String(req.query?.code ?? '');
  const error = String(req.query?.error ?? '');
  if (error) return reply.redirect(`/integrations?oauth_error=${encodeURIComponent(error)}`);
  if (!state || !code) return reply.redirect('/integrations?oauth_error=missing_code');
  // FAMILY callback (e.g. /api/integrations/google/oauth/callback): resolve
  // the actual provider from the state row — the id segment is the family.
  const rows = await db.query<any>('SELECT user_id, redirect_to, integration_id FROM oauth_states WHERE state = ?', [state]);
  if (!rows[0]) return reply.redirect('/integrations?oauth_error=state_expired');
  const provider = integrationsService.getAdapter(String(req.params.id))
    ? String(req.params.id)
    : rows[0].integration_id;      // family callback → state knows the provider
  try {
    const conn = await integrationsService.completeOAuth(rows[0].user_id, provider, state, code);
    const dest = rows[0].redirect_to ?? '/integrations';
    const suffix = conn.status === 'error'
      ? `oauth_error=${encodeURIComponent(conn.last_error ?? 'verification failed')}`
      : `connected=${conn.provider}`;
    return reply.redirect(`${dest}${dest.includes('?') ? '&' : '?'}${suffix}`);
  } catch (e: any) {
    return reply.redirect(`/integrations?oauth_error=${encodeURIComponent(String(e?.message ?? e)).slice(0, 180)}`);
  }
});

// §15 diagnostics — Google OAuth configuration state (no secrets)
app.get('/api/integrations/google/diagnostics', async () => integrationsService.googleDiagnostics());

// Provider webhook intake (Phase 10): signature verification, replay
// protection, normalization, bus bridge. Session-exempt (providers have no
// cookies); authenticity comes from the signature, not auth.
app.post('/api/integrations/:id/webhook', async (req: any, reply: any) => {
  const adapter = integrationsService.getAdapter(String(req.params.id));
  if (!adapter || !adapter.manifest.webhook) return reply.code(404).send({ error: 'no webhook support' });
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  const wh = adapter.manifest.webhook;
  const secret = wh.secret === 'env' ? process.env[wh.secretEnv ?? ''] ?? '' : '';
  if (!secret) return reply.code(400).send({ error: 'webhook secret not configured' });
  const result = await intakeWebhook(db, adapter, rawBody, req.headers as any, secret);
  if (!result.accepted) {
    const code = result.reason === 'signature verification failed' ? 401 : 200;
    return reply.code(code).send({ ok: false, reason: result.reason });
  }
  await bus.emit('integration.event', { integration: adapter.manifest.id, kind: result.event_type, via: 'webhook' },
    { actor_type: 'integration', target_type: 'integration', target_id: adapter.manifest.id });
  return { ok: true, event_id: result.event_id };
});
}
