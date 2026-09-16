/**
 * automations routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as crypto from 'crypto';
import { iso, uuid } from '../infra/types';
import * as store from '../modules/store';
import * as flows from '../modules/flows';
import * as automations from '../modules/automations-engine';
import { AutomationUpsertInput, AutomationToggleInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerAutomationsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus, automationEngine } = ctx;

// ─── Phase 8: automations ──────────────────────────────────────────────────
app.get('/api/automations', async () => automations.listAutomations(db));
app.get('/api/automations/:id', async (req: any, reply: any) => {
  const a = await automations.getAutomation(db, String(req.params.id));
  if (!a) return reply.code(404).send({ error: 'automation not found' });
  return a;
});
app.post('/api/automations', async (req: any, reply: any) => {
  const parsed = AutomationUpsertInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  // trigger validation (cron parse, event_type presence)
  const terr = automations.validateTrigger(d.trigger, d.trigger_config as any);
  if (terr) return reply.code(400).send({ error: terr });
  // action validation
  if (d.action === 'flow' && !d.action_config.flow_id) return reply.code(400).send({ error: 'flow action needs action_config.flow_id' });
  if (d.action === 'agent' && !d.action_config.agent_name) return reply.code(400).send({ error: 'agent action needs action_config.agent_name' });
  if (d.action === 'flow') {
    const f = await flows.getFlow(db, String(d.action_config.flow_id));
    if (!f) return reply.code(400).send({ error: `flow not found: ${d.action_config.flow_id}` });
  }
  if (d.action === 'agent') {
    const a = await store.getAgentByName(db, String(d.action_config.agent_name));
    if (!a) return reply.code(400).send({ error: `agent not found: ${d.action_config.agent_name}` });
  }
  // webhook: generate a secret server-side when absent
  const triggerConfig = { ...d.trigger_config } as Record<string, unknown>;
  if (d.trigger === 'webhook' && !triggerConfig.secret) {
    triggerConfig.secret = crypto.randomBytes(24).toString('hex');
  }
  const id = uuid(); const now = iso();
  await db.run(
    `INSERT INTO automations (id, name, description, trigger, trigger_config, action, action_config, autonomy_level, enabled, last_fired_at, last_run_id, run_count, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?,?)`,
    [id, d.name, d.description, d.trigger, JSON.stringify(triggerConfig), d.action, JSON.stringify(d.action_config),
     d.autonomy_level, d.enabled ? 1 : 0, req.user.id, now, now]);
  await bus.emit('automation.created', { id, name: d.name, trigger: d.trigger, action: d.action },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'event', target_id: id });
  return automations.getAutomation(db, id);
});
app.patch('/api/automations/:id', async (req: any, reply: any) => {
  const existing = await automations.getAutomation(db, String(req.params.id));
  if (!existing) return reply.code(404).send({ error: 'automation not found' });
  const parsed = AutomationUpsertInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const terr = automations.validateTrigger(d.trigger, d.trigger_config as any);
  if (terr) return reply.code(400).send({ error: terr });
  // preserve an existing webhook secret when the patch doesn't supply one
  const triggerConfig = { ...d.trigger_config } as Record<string, unknown>;
  if (d.trigger === 'webhook' && !triggerConfig.secret && existing.trigger_config.secret) {
    triggerConfig.secret = existing.trigger_config.secret;
  }
  await db.run(
    `UPDATE automations SET name = ?, description = ?, trigger = ?, trigger_config = ?, action = ?, action_config = ?, autonomy_level = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    [d.name, d.description, d.trigger, JSON.stringify(triggerConfig), d.action, JSON.stringify(d.action_config),
     d.autonomy_level, d.enabled ? 1 : 0, iso(), existing.id]);
  await bus.emit('automation.updated', { id: existing.id, name: d.name },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'event', target_id: existing.id });
  return automations.getAutomation(db, existing.id);
});
app.post('/api/automations/:id/toggle', async (req: any, reply: any) => {
  const parsed = AutomationToggleInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const a = await automations.getAutomation(db, String(req.params.id));
  if (!a) return reply.code(404).send({ error: 'automation not found' });
  await db.run('UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?', [parsed.data.enabled ? 1 : 0, iso(), a.id]);
  await bus.emit(parsed.data.enabled ? 'automation.enabled' : 'automation.paused',
    { id: a.id, name: a.name }, { actor_type: 'user', actor_id: req.user.id, target_type: 'event', target_id: a.id });
  return automations.getAutomation(db, a.id);
});
app.post('/api/automations/:id/test', async (req: any, reply: any) => {
  const run = await automationEngine.testFire(String(req.params.id));
  if (!run) return reply.code(404).send({ error: 'automation not found' });
  return run;
});
app.get('/api/automations/:id/runs', async (req: any) =>
  automations.listAutomationRuns(db, String(req.params.id), 100));
app.get('/api/automation-runs', async () =>
  automations.listAutomationRuns(db, undefined, 100));
app.delete('/api/automations/:id', async (req: any, reply: any) => {
  const a = await automations.getAutomation(db, String(req.params.id));
  if (!a) return reply.code(404).send({ error: 'automation not found' });
  await db.run('DELETE FROM automation_runs WHERE automation_id = ?', [a.id]);
  await db.run('DELETE FROM automations WHERE id = ?', [a.id]);
  await bus.emit('automation.deleted', { id: a.id, name: a.name },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'event', target_id: a.id });
  return { ok: true };
});

// ─── Phase 8: webhook intake (UNAUTHENTICATED — secret IS the auth) ────────
app.post('/api/webhooks/:id', async (req: any, reply: any) => {
  const a = await automations.getAutomation(db, String(req.params.id));
  if (!a || a.trigger !== 'webhook') return reply.code(404).send({ error: 'webhook not found' });
  // secret via Bearer header or ?secret= query (constant-time compare)
  const header = String(req.headers?.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query?.secret ?? '');
  const secret = String(a.trigger_config.secret ?? '');
  if (!secret || !token || !automations.timingSafeEqual(token, secret)) {
    return reply.code(401).send({ error: 'invalid webhook secret' });
  }
  const run = await automationEngine.onWebhook(a.id, (req.body ?? {}) as Record<string, unknown>);
  if (!run) return reply.code(404).send({ error: 'webhook not found' });
  return { accepted: true, run_id: run.id, status: run.status, reason: run.reason };
});
}
