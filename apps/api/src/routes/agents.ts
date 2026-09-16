/**
 * agents routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import { iso, uuid } from '../infra/types';
import * as store from '../modules/store';
import { requireOwned, NOT_FOUND } from '../modules/authz';
import { loadSkillsFromDir, upsertSkillVersioned, skillMetrics, skillVersions } from '../modules/skills';
import { config } from '../config';
import { ExecuteInput, AgentCreateInput, SkillCreateInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';
import { scopesForTools } from './context';

export function registerAgentsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus, router, runtime, tools } = ctx;

// ─── agents ───────────────────────────────────────────────────────────────
app.get('/api/agents', async () => {
  const agents = await store.listAgents(db);
  return agents.map(a => ({ ...a, available_tools: a.tools, autonomy_label: a.autonomy_level }));
});

app.post('/api/agents', async (req: any, reply: any) => {
  const parsed = AgentCreateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const allTools = tools.list().map(t => t.name);
  const chosen = d.tools?.filter(t => allTools.includes(t)) ?? ['memory.search', 'memory.write', 'task.create', 'task.list', 'sys.info', 'calc.eval'];
  const chosenScoped = scopesForTools(chosen, tools);
  const now = iso();
  const rec = {
    id: uuid(), name: d.name, description: d.description,
    system_instructions: d.system_instructions || `You are ${d.name}, an agent in the Agentic OS.`,
    model_policy: { capability: d.model_policy?.capability ?? 'reasoning', preference: d.model_policy?.preference ?? [] },
    skills: d.skills ?? [],
    tools: chosen,
    memory_policy: { read: d.memory_policy?.read ?? true, write: d.memory_policy?.write ?? true, k: d.memory_policy?.k ?? 5, types: d.memory_policy?.types ?? ['semantic', 'episodic', 'preference', 'project'] },
    permissions: { tools: chosen, scopes: chosenScoped },
    autonomy_level: d.autonomy_level ?? 2,
    status: 'idle' as const, created_at: now, updated_at: now,
  };
  await store.upsertAgent(db, rec as any);
  await bus.emit('agent.started', { agent: rec.name, created: true }, { actor_type: 'user', actor_id: req.user.id, target_type: 'agent', target_id: rec.id });
  return rec;
});

app.get('/api/agents/:id', async (req: any) => store.getAgent(db, req.params.id));
app.patch('/api/agents/:id', async (req: any, reply: any) => {
  const a = await store.getAgent(db, req.params.id);
  if (!a) return reply.code(404).send({ error: 'not found' });
  const b = req.body ?? {};
  const upd = { ...a, ...b, updated_at: iso() };
  if (b.tools) upd.permissions = { tools: b.tools, scopes: scopesForTools(b.tools, tools) };
  await store.upsertAgent(db, upd);
  return upd;
});

app.post('/api/agents/:id/execute', async (req: any, reply: any) => {
  const agent = await store.getAgent(db, req.params.id);
  if (!agent) return reply.code(404).send({ error: 'agent not found' });
  const parsed = ExecuteInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const exec = await runtime.run({
    agent, input: parsed.data.input, user_id: req.user.id,
    project_id: parsed.data.project_id ?? null, task_id: parsed.data.task_id ?? null,
    autonomy_override: parsed.data.autonomy_override,
    skill: parsed.data.skill,
  } as any);
  return { execution_id: exec.id, status: exec.status, agent_id: agent.id, agent_name: agent.name };
});

// ─── executions ───────────────────────────────────────────────────────────
// Every route below is owner-scoped (§39). A non-owner gets 404, never 403,
// so a response never confirms that another user's execution exists.
app.post('/api/executions/:id/pause', async (req: any, reply: any) => {
  const g = await requireOwned(() => store.getExecution(db, req.params.id), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  return { ok: await runtime.pause(req.params.id) };
});
app.post('/api/executions/:id/resume', async (req: any, reply: any) => {
  const g = await requireOwned(() => store.getExecution(db, req.params.id), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  // Phase 3: resume works for paused AND interrupted (crash-recovered) executions
  if (g.rec.status === 'interrupted') {
    const r = await runtime.resumeExecution(req.params.id);
    return { ok: !!r, resumed: true, execution: r };
  }
  return { ok: await runtime.resume(req.params.id), resumed: g.rec.status === 'paused' };
});
app.post('/api/executions/:id/stop', async (req: any, reply: any) => {
  const g = await requireOwned(() => store.getExecution(db, req.params.id), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  return { ok: await runtime.stop(req.params.id) };
});

app.get('/api/executions', async (req: any) => {
  const limit = Math.min(200, Number(req.query?.limit ?? 50));
  return store.listExecutions(db, { user_id: req.user.id, limit });
});
app.get('/api/executions/:id', async (req: any, reply: any) => {
  const g = await requireOwned(() => store.getExecution(db, req.params.id), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  return g.rec;
});
// Phase 3: execution graph — child (delegated) executions of a parent
app.get('/api/executions/:id/children', async (req: any, reply: any) => {
  const g = await requireOwned(() => store.getExecution(db, req.params.id), req.user.id);
  if (!g.ok) return reply.code(404).send(NOT_FOUND);
  const rows = await db.query<any>(
    'SELECT * FROM executions WHERE parent_execution_id = ? ORDER BY started_at', [req.params.id]);
  return rows.map(store.parseExecution);
});

// Phase 3: agent-to-agent message log
app.get('/api/agent-messages', async () => store.listAgentMessages(db, 100));

// ─── models ────────────────────────────────────────────────────────────────
app.get('/api/models', async () => ({
  providers: router.listProviders(),
  models: await router.listModels(),
}));
app.get('/api/models/usage', async () => router.usage());

// ─── tools & skills ───────────────────────────────────────────────────────
app.get('/api/tools', async () => tools.list().map(t => ({
  name: t.name, description: t.description, risk: t.risk, scope: t.scope, schema: t.schema,
})));

app.get('/api/skills', async () => store.listSkills(db));
app.get('/api/skills/metrics', async () => skillMetrics(db));
app.get('/api/skills/versions', async (req: any) => skillVersions(db, req.query?.skill_id));
app.post('/api/skills/reload', async () => {
  const res = await loadSkillsFromDir(db, config.skillsDir, bus);
  return { ...res, dir: config.skillsDir };
});
app.post('/api/skills', async (req: any, reply: any) => {
  const parsed = SkillCreateInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const { skill, version_bumped } = await upsertSkillVersioned(db, {
    name: d.name, description: d.description, category: d.category,
    parent: null, instructions: d.instructions,
    steps: d.steps, required_tools: d.required_tools,
  }, bus);
  return { ...skill, version_bumped };
});
app.post('/api/skills/:id/execute', async (req: any, reply: any) => {
  // skills execute within an agent execution — the runtime handles skill steps.
  // This endpoint documents the boundary: direct execution requires an agent.
  const skill = await store.getSkill(db, req.params.id);
  if (!skill) return reply.code(404).send({ error: 'skill not found' });
  const { agent_name, input } = (req.body ?? {}) as { agent_name?: string; input?: string };
  const agent = agent_name ? await store.getAgentByName(db, agent_name) : await store.getAgentByName(db, 'Hermes');
  if (!agent) return reply.code(404).send({ error: 'no agent available' });
  const exec = await runtime.run({
    agent, user_id: req.user.id,
    input: input ?? `Execute skill "${skill.name}" per its definition.`,
  });
  return { execution_id: exec.id, skill: skill.name, agent: agent.name };
});
}
