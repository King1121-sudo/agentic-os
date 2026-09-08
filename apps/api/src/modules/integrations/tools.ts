/**
 * Integration platform tools (Phase 16) — capability-gated agent tools,
 * generated DYNAMICALLY from registered provider manifests. Zero hardcoded
 * provider knowledge: one tool per capability per provider, e.g.
 *   gmail.send, github.search, slack.message.write, telegram.send, …
 *
 * Execution pipeline per call (the requirement-10 chain):
 *   capability authorization → connection lookup → credential retrieval
 *   → token refresh if needed → provider API → normalized result → audit
 */
import type { DataPort } from '../../infra/types';
import { iso } from '../../infra/types';
import type { ToolDef, ToolContext } from '../../kernel/types';
import type { IntegrationService } from './service';

export function createIntegrationTools(db: DataPort, service: IntegrationService): ToolDef[] {
  const tools: ToolDef[] = [];

  // One discovery tool: lists every integration capability the user's
  // connections actually grant — agents call this first to learn what's wired.
  tools.push({
    name: 'integration.list',
    description: 'List connected integrations and the capabilities each connection grants (call this first to discover available integration actions).',
    risk: 'low', scope: 'integrations:read',
    schema: {},
    async execute(_args, ctx) {
      const conns = await service.listConnections(ctx.user_id);
      return conns.filter(c => c.status === 'connected').map(c => ({
        connection_id: c.id, provider: c.provider, account: c.account_id,
        capabilities: c.capabilities,
      }));
    },
  });

  // The generic executor: one tool per provider (github, gmail, slack, …),
  // parameterized by capability — schema is derived from the manifest so the
  // planner sees exact names.
  const providers = service.listProviders() as any[];
  for (const p of providers) {
    const manifest = service.getAdapter(p.id)?.manifest;
    if (!manifest) continue;
    const caps = manifest.capabilities.map(c => `${c.id}`).join(', ');
    tools.push({
      name: `${p.id}.action`,
      description: `${manifest.name} integration — execute a capability. Available capabilities: ${caps}. Requires a matching connected account.`,
      risk: 'medium', scope: `integration:${p.id}`,
      schema: {
        capability: { type: 'string', required: true, description: `one of: ${caps}` },
        connection: { type: 'string', required: false, description: 'connection id or account (default: first matching connected account)' },
        args: { type: 'json', required: false, description: 'capability arguments as JSON (e.g. {"repo":"owner/name"}, {"to":"a@b.c","subject":"…"}, {"text":"…"})' },
      },
      async execute(args, ctx) {
        const capability = String(args.capability ?? '');
        if (!capability) throw new Error(`${p.id}.action needs args.capability`);
        const cap = manifest.capabilities.find(c => c.id === capability);
        if (!cap) throw new Error(`unknown ${p.id} capability: ${capability}`);
        // resolve the connection: explicit id/account, else first connected
        const conns = await service.listConnections(ctx.user_id, p.id);
        const connected = conns.filter(c => c.status === 'connected' && c.capabilities.includes(capability));
        if (connected.length === 0) {
          throw new Error(`no connected ${manifest.name} account grants ${capability} — connect it on the Integrations page`);
        }
        const sel = String(args.connection ?? '');
        const conn = sel
          ? connected.find(c => c.id === sel || c.account_id === sel)
          : connected[0];
        if (!conn) throw new Error(`no ${manifest.name} connection matching "${sel}" grants ${capability}`);
        // → capability auth (engine re-checks) → credentials (refresh) → provider
        const result = await service.executeCapability(ctx.user_id, conn.id, capability, (args.args as any) ?? {});
        await auditIntegrationCall(db, ctx, p.id, conn.id, capability, true);
        return result;
      },
    });
  }
  return tools;
}

async function auditIntegrationCall(
  db: DataPort, ctx: ToolContext, provider: string, connectionId: string, capability: string, ok: boolean,
): Promise<void> {
  // requirement 19: who/what/tool/provider/connection/capability/timestamp —
  // never credentials (nothing secret ever reaches this call anyway).
  await db.run(
    'INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, target_type, target_id, execution_id, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [`${provider}-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, iso(), 'agent', ctx.agent?.id ?? null,
     `integration.${capability}`, 'integration', connectionId, ctx.execution_id,
     JSON.stringify({ provider, connection_id: connectionId, capability, ok }), iso()],
  ).catch(() => {});
}
