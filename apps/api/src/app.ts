/**
 * HTTP API — typed boundary (§39). Fastify + zod DTOs from @agentic/contracts.
 * All routes are session-authenticated (cookie) except /api/auth/*, /api/health.
 * Realtime: /api/stream (SSE) taps the EventBus via the BrokerPort.
 */
import * as crypto from 'crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { DataPort, BrokerPort } from './infra/types';
import { iso, uuid } from './infra/types';
import { EventBus, CHANNEL, parseEventRow } from './kernel/bus';
import type { ModelRouter } from './gateway/router';
import type { AgentRuntime } from './modules/runtime';
import type { ToolRegistry } from './modules/tools';
import * as store from './modules/store';
import * as memory from './modules/memory';
import { backfillEntities } from './modules/entities';
import { getWorkingMemory, appendFact } from './modules/workingmemory';
import * as projects from './modules/projects';
import { runDeadlineSweep, clearDeadlineAlerts } from './modules/automations';
import * as flows from './modules/flows';
import { FlowEngine } from './modules/flows';
import * as automations from './modules/automations-engine';
import { AutomationEngine } from './modules/automations-engine';
import { IntegrationService } from './modules/integrations-service';
import * as notify from './modules/notify';
import * as graph from './modules/graph';
import { loadSkillsFromDir, upsertSkillVersioned, skillMetrics, skillVersions } from './modules/skills';
import { config } from './config';
import { hashPassword, verifyPassword } from './auth.util';
import {
  LoginInput, ExecuteInput, CommandInput, ProjectCreateInput, TaskCreateInput, TaskUpdateInput,
  SprintCreateInput, MemoryCreateInput, AgentCreateInput, LinkCreateInput, ApprovalDecisionInput,
  SkillCreateInput, MemoryBackfillInput, WorkingMemoryFactInput,
  TaskDependencyInput, MilestoneCreateInput, SprintTransitionInput,
  FlowUpsertInput, FlowRunInput, AutomationUpsertInput, AutomationToggleInput,
  IntegrationConnectTokenInput, IntegrationConnectOAuthInput,
  DashboardLayoutInput, NotificationPrefsInput, PushSubscriptionInput,
} from '@agentic/contracts';

const SESSION_COOKIE = 'agentic_session';
const SESSION_DAYS = 14;

/** Minimal cookie reader (no @fastify/cookie dependency needed). */
function getCookie(req: any, name: string): string | null {
  const header: string | undefined = req?.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export interface ApiDeps {
  db: DataPort;
  broker: BrokerPort;
  bus: EventBus;
  router: ModelRouter;
  runtime: AgentRuntime;
  tools: ToolRegistry;
  flowEngine: FlowEngine;
  automationEngine: AutomationEngine;
  integrationsService: IntegrationService;
}

// ─── password hashing lives in auth.util.ts (scrypt, stdlib) ─────────────────

export function buildApi(deps: ApiDeps) {
  const { db, broker, bus, router, runtime, tools, flowEngine, automationEngine, integrationsService } = deps;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.register(cors, { origin: config.corsOrigin, credentials: true });

  // ─── session auth ─────────────────────────────────────────────────────────
  async function currentUser(req: any): Promise<{ id: string; username: string; display_name: string } | null> {
    const sid = getCookie(req, SESSION_COOKIE);
    if (!sid) return null;
    const rows = await db.query<any>(
      'SELECT u.id, u.username, u.display_name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
      [sid],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at < iso()) {
      await db.run('DELETE FROM sessions WHERE id = ?', [sid]);
      return null;
    }
    return { id: row.id, username: row.username, display_name: row.display_name };
  }

  app.addHook('preHandler', async (req: any, reply: any) => {
    // public: auth endpoints, health, webhooks (secret-authed), and the OAuth
    // provider callbacks (external redirects carry no session cookie — the
    // one-time state row identifies the user instead)
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/auth') || url.startsWith('/api/health') || url.startsWith('/api/webhooks')) return;
    if (url.includes('/oauth/callback')) return;
    const u = await currentUser(req);
    if (!u) { reply.code(401).send({ error: 'unauthorized' }); return; }
    (req as any).user = u;
  });

  // ─── auth ──────────────────────────────────────────────────────────────────
  app.post('/api/auth/login', async (req: any, reply: any) => {
    const parsed = LoginInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const { username, password } = parsed.data;
    const rows = await db.query<any>('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const sid = crypto.randomBytes(32).toString('hex');    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)', [sid, user.id, iso(), expires]);
    reply.header('set-cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    await store.audit(db, { actor_type: 'user', actor_id: user.id, action: 'user.login', meta: { username } });
    await bus.emit('user.login', { username }, { actor_type: 'user', actor_id: user.id });
    return { id: user.id, username: user.username, display_name: user.display_name };
  });

  app.post('/api/auth/logout', async (req: any, reply: any) => {
    const sid = getCookie(req, SESSION_COOKIE);
    if (sid) await db.run('DELETE FROM sessions WHERE id = ?', [sid]);
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req: any) => (req as any).user);

  // ─── health / system ──────────────────────────────────────────────────────
  app.get('/api/health', async () => {
    const dbUp = await db.health().catch(() => false);
    const providers = router.listProviders().map(p => ({ id: p.id, status: p.healthy ? 'up' : 'down', models: 0 }));
    const count = async (t: string) => Number((await db.query<any>(`SELECT COUNT(*) AS n FROM ${t}`))[0]?.n ?? 0);
    const vec = memory.getVectorIndex();
    return {
      ok: dbUp, version: config.version, time: iso(),
      db: dbUp ? 'up' : 'down', broker: 'up',
      providers: await db.query('SELECT id, name, kind, status FROM model_providers'),
      vector: vec ? vec.stats() : null,           // Phase 5: semantic driver state
      counts: {
        agents: await count('agents'), executions: await count('executions'),
        memories: await count('memories'), tasks: await count('tasks'),
        projects: await count('projects'), generations: await count('generations'),
        events: await count('events'),
        extracted_entities: await count('entities'),
        working_memory_windows: await count('working_memory'),
      },
    };
  });

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

  app.post('/api/executions/:id/pause', async (req: any) => ({ ok: await runtime.pause(req.params.id) }));
  app.post('/api/executions/:id/resume', async (req: any) => {
    // Phase 3: resume works for paused AND interrupted (crash-recovered) executions
    const ex = await store.getExecution(db, req.params.id);
    if (ex && ex.status === 'interrupted') {
      const r = await runtime.resumeExecution(req.params.id);
      return { ok: !!r, resumed: true, execution: r };
    }
    return { ok: await runtime.resume(req.params.id), resumed: ex?.status === 'paused' };
  });
  app.post('/api/executions/:id/stop', async (req: any) => ({ ok: await runtime.stop(req.params.id) }));

  app.get('/api/executions', async (req: any) => {
    const limit = Math.min(200, Number(req.query?.limit ?? 50));
    return store.listExecutions(db, limit);
  });
  app.get('/api/executions/:id', async (req: any) => store.getExecution(db, req.params.id));
  // Phase 3: execution graph — child (delegated) executions of a parent
  app.get('/api/executions/:id/children', async (req: any) => {
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

  // ─── memory ────────────────────────────────────────────────────────────────
  app.get('/api/memory', async (req: any) => {
    const q = String(req.query?.q ?? '');
    let rows: any[];
    if (q) rows = await memory.searchMemory(db, { user_id: req.user.id, query: q, k: 20 });
    else rows = await memory.listMemories(db, req.user.id, {
      type: req.query?.type, project_id: req.query?.project_id, limit: 200,
    });
    // Phase 5: attach graph entity refs ("kind:slug") for the chips in the UI
    if (rows.length) {
      const ids = rows.map(r => r.id);
      const joins = await db.query<any>(
        `SELECT memory_id, entity_id FROM memory_entities WHERE memory_id IN (${ids.map(() => '?').join(',')})`, ids);
      const byMem = new Map<string, string[]>();
      for (const j of joins) {
        if (!byMem.has(j.memory_id)) byMem.set(j.memory_id, []);
        byMem.get(j.memory_id)!.push(j.entity_id);
      }
      for (const r of rows) (r as any).entity_refs = byMem.get(r.id) ?? [];
    }
    return rows;
  });
  app.post('/api/memory', async (req: any, reply: any) => {
    const parsed = MemoryCreateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    const { record, deduped } = await memory.createMemory(db, {
      user_id: req.user.id, type: d.type, content: d.content, summary: d.summary,
      importance: d.importance, source: d.source, project_id: d.project_id,
    });
    await bus.emit('memory.created', { id: record.id, type: record.type, summary: record.summary.slice(0, 120) },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'memory', target_id: record.id });
    return { ...record, deduplicated: !!deduped };
  });
  app.get('/api/memory/search', async (req: any) =>
    memory.searchMemory(db, { user_id: req.user.id, query: String(req.query?.q ?? ''), k: 20 }));
  app.delete('/api/memory/:id', async (req: any) => {
    const m = await memory.getMemory(db, req.params.id);
    if (!m || m.user_id !== req.user.id) return { ok: false };
    return { ok: await memory.deleteMemory(db, req.params.id) };
  });
  app.post('/api/memory/maintain', async (req: any) => {
    const decayed = await memory.decayMemories(db, req.user.id);
    const { merged } = await memory.consolidateMemories(db, req.user.id);
    if (decayed || merged) {
      await bus.emit('memory.consolidated', { decayed, merged }, { actor_type: 'system' });
    }
    return { decayed, merged };
  });

  // ─── Phase 5: semantic memory ─────────────────────────────────────────────
  // vector driver state + semantic search (vector leg through the active port)
  app.get('/api/memory/vector-stats', async () => {
    const vi = memory.getVectorIndex();
    return vi ? vi.stats() : { kind: 'none', dim: 0, provider: 'unset' };
  });
  app.post('/api/memory/entities/backfill', async (req: any) => {
    const parsed = MemoryBackfillInput.safeParse(req.body ?? {});
    const limit = parsed.success ? (parsed.data as any).limit : 200;
    const res = await backfillEntities(db, limit);
    await bus.emit('memory.entities.extracted', { backfill: true, ...res }, { actor_type: 'user', actor_id: req.user.id });
    return res;
  });
  app.get('/api/memory/entities/:id', async (req: any) => {
    // memories linked to an extracted entity (id format "<kind>:<slug>")
    const mems = await memory.memoriesForEntity(db, String(req.params.id));
    return { entity: String(req.params.id), memories: mems.map(m => ({ id: m.id, type: m.type, summary: m.summary, updated_at: m.updated_at })) };
  });

  // ─── Phase 5: working memory ──────────────────────────────────────────────
  app.get('/api/executions/:id/working-memory', async (req: any, reply: any) => {
    const wm = await getWorkingMemory(db, String(req.params.id));
    if (!wm) return reply.code(404).send({ error: 'no working-memory window for this execution' });
    return wm;
  });
  app.post('/api/executions/:id/working-memory/facts', async (req: any, reply: any) => {
    const parsed = WorkingMemoryFactInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const wm = await appendFact(db, String(req.params.id), {
      text: parsed.data.text, source: parsed.data.source, step: parsed.data.step,
    });
    if (!wm) return reply.code(404).send({ error: 'no working-memory window for this execution' });
    return wm;
  });

  // ─── projects / tasks / sprints ────────────────────────────────────────────
  app.get('/api/projects', async () => store.listProjects(db));
  app.post('/api/projects', async (req: any, reply: any) => {
    const parsed = ProjectCreateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const p = await store.createProject(db, { ...parsed.data, created_by: req.user.id });
    await bus.emit('project.created', { id: p.id, name: p.name }, { actor_type: 'user', actor_id: req.user.id, target_type: 'project', target_id: p.id });
    return p;
  });
  app.get('/api/projects/:id', async (req: any) => {
    const p = await store.getProject(db, req.params.id);
    if (!p) return { error: 'not found' };
    const [tasks, sprints, links] = await Promise.all([
      store.listTasks(db, { project_id: p.id }),
      store.listSprints(db, p.id),
      store.listLinks(db, { type: 'project', id: p.id }),
    ]);
    return { ...p, tasks, sprints, links };
  });

  app.get('/api/tasks', async (req: any) =>
    store.listTasks(db, { project_id: req.query?.project_id, status: req.query?.status, limit: 200 }));
  app.post('/api/tasks', async (req: any, reply: any) => {
    const parsed = TaskCreateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    let project_id = d.project_id ?? null;
    if (!project_id && d.project_name) {
      const existing = await store.findProjectByName(db, d.project_name);
      project_id = existing ? existing.id : (await store.createProject(db, { name: d.project_name, created_by: req.user.id })).id;
    }
    const t = await store.createTask(db, { ...d, project_id, created_by: req.user.id } as any);
    await bus.emit('task.created', { id: t.id, title: t.title, priority: t.priority },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: t.id });
    return t;
  });
  app.patch('/api/tasks/:id', async (req: any, reply: any) => {
    const parsed = TaskUpdateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const t = await store.updateTask(db, req.params.id, parsed.data);
    if (!t) return reply.code(404).send({ error: 'not found' });
    await bus.emit(t.status === 'done' ? 'task.completed' : 'task.updated',
      { id: t.id, status: t.status }, { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: t.id });
    // Phase 6: completion cascades — unblock dependents + clear deadline alerts
    let unblocked: string[] = [];
    if (t.status === 'done' || t.status === 'archived') {
      unblocked = await projects.cascadeUnblock(db, t.id);
      await clearDeadlineAlerts(db, t.id).catch(() => {});
      for (const u of unblocked) {
        const ut = await store.getTask(db, u);
        if (ut) await bus.emit('task.unblocked', { id: ut.id, title: ut.title }, { actor_type: 'system', target_type: 'task', target_id: ut.id });
      }
    }
    return t;
  });
  app.get('/api/tasks/:id', async (req: any) => store.getTask(db, req.params.id));

  app.get('/api/sprints', async (req: any) => store.listSprints(db, req.query?.project_id));
  app.post('/api/sprints', async (req: any, reply: any) => {
    const parsed = SprintCreateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const s = await store.createSprint(db, { ...parsed.data } as any);
    await bus.emit('sprint.started', { id: s.id, name: s.name }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
    return s;
  });
  // Phase 6: sprint lifecycle transitions (start/complete/cancel)
  app.post('/api/sprints/:id/transition', async (req: any, reply: any) => {
    const parsed = SprintTransitionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const s = await projects.getSprint(db, req.params.id);
    if (!s) return reply.code(404).send({ error: 'sprint not found' });
    const action = parsed.data.action;
    // state machine: planned → active → completed | cancelled (any → cancelled)
    const now = iso();
    if (action === 'start') {
      if (s.status !== 'planned') return reply.code(409).send({ error: `sprint is ${s.status}, not planned` });
      const updated = await projects.updateSprint(db, s.id, { status: 'active', started_at: now });
      await bus.emit('sprint.started', { id: s.id, name: s.name }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
      return updated;
    }
    if (action === 'complete') {
      if (s.status !== 'active') return reply.code(409).send({ error: `sprint is ${s.status}, not active` });
      // completion rolls up: any non-done sprint tasks are archived
      const tasks = await db.query<any>("SELECT id, status FROM tasks WHERE sprint_id = ?", [s.id]);
      let archived = 0;
      for (const t of tasks) {
        if (!['done', 'archived'].includes(t.status)) {
          await store.updateTask(db, t.id, { status: 'archived' });
          archived++;
        }
      }
      const updated = await projects.updateSprint(db, s.id, { status: 'completed', completed_at: now });
      await bus.emit('sprint.completed', { id: s.id, name: s.name, tasks_archived: archived }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
      return { ...updated, tasks_archived: archived };
    }
    // cancel
    if (['completed', 'cancelled'].includes(s.status)) return reply.code(409).send({ error: `sprint already ${s.status}` });
    const updated = await projects.updateSprint(db, s.id, { status: 'cancelled', completed_at: now });
    await bus.emit('sprint.completed', { id: s.id, name: s.name, cancelled: true }, { actor_type: 'user', actor_id: req.user.id, target_type: 'sprint', target_id: s.id });
    return updated;
  });

  // ─── Phase 6: dependencies ────────────────────────────────────────────────
  app.get('/api/tasks/:id/dependencies', async (req: any) => {
    const taskId = String(req.params.id);
    const [deps, dependents] = await Promise.all([
      projects.dependenciesOf(db, taskId),
      projects.dependentsOf(db, taskId),
    ]);
    return { task_id: taskId, depends_on: deps, blocks: dependents };
  });
  app.get('/api/projects/:id/dependency-order', async (req: any) => {
    const order = await projects.dependencyOrder(db, String(req.params.id));
    const titles = new Map((await store.listTasks(db, { project_id: String(req.params.id) })).map(t => [t.id, t.title]));
    return order.map(o => ({ ...o, title: titles.get(o.task_id) ?? o.task_id }));
  });
  app.post('/api/tasks/:id/dependencies', async (req: any, reply: any) => {
    const parsed = TaskDependencyInput.safeParse({ ...req.body, task_id: req.params.id });
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const r = await projects.addDependency(db, String(req.params.id), parsed.data.depends_on);
    if (!r.ok) return reply.code(r.error.includes('not found') ? 404 : 409).send({ error: r.error });
    await bus.emit('task.dependency.added', { task_id: String(req.params.id), depends_on: parsed.data.depends_on },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: String(req.params.id) });
    const task = await store.getTask(db, String(req.params.id));
    if (task?.status === 'blocked') {
      await bus.emit('task.blocked', { id: task.id, title: task.title }, { actor_type: 'system', target_type: 'task', target_id: task.id });
    }
    return { ok: true, id: r.id, task: store.getTask(db, String(req.params.id)) };
  });
  app.delete('/api/tasks/:id/dependencies/:dependsOn', async (req: any, reply: any) => {
    const ok = await projects.removeDependency(db, String(req.params.id), String(req.params.dependsOn));
    if (!ok) return reply.code(404).send({ error: 'dependency not found' });
    await bus.emit('task.dependency.removed', { task_id: String(req.params.id), depends_on: String(req.params.dependsOn) },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'task', target_id: String(req.params.id) });
    const task = await store.getTask(db, String(req.params.id));
    if (task?.status !== 'blocked' && task) {
      await bus.emit('task.unblocked', { id: task.id, title: task.title }, { actor_type: 'system', target_type: 'task', target_id: task.id });
    }
    return { ok: true };
  });

  // ─── Phase 6: milestones ────────────────────────────────────────────────────
  app.get('/api/projects/:id/milestones', async (req: any) => projects.listMilestones(db, String(req.params.id)));
  app.post('/api/projects/:id/milestones', async (req: any, reply: any) => {
    const parsed = MilestoneCreateInput.safeParse({ ...req.body, project_id: req.params.id });
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const m = await projects.createMilestone(db, parsed.data as any);
    await bus.emit('milestone.created', { id: m.id, name: m.name, project_id: m.project_id },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'project', target_id: m.project_id });
    return m;
  });
  app.patch('/api/milestones/:id', async (req: any, reply: any) => {
    const m = await projects.updateMilestone(db, String(req.params.id), req.body ?? {});
    if (!m) return reply.code(404).send({ error: 'milestone not found' });
    if (req.body?.status === 'reached') {
      await bus.emit('milestone.completed', { id: m.id, name: m.name, project_id: m.project_id },
        { actor_type: 'user', actor_id: req.user.id, target_type: 'project', target_id: m.project_id });
    }
    return m;
  });
  app.delete('/api/milestones/:id', async (req: any, reply: any) => {
    const ok = await projects.deleteMilestone(db, String(req.params.id));
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ─── Phase 6: progress rollup ───────────────────────────────────────────────
  app.get('/api/projects/:id/rollup', async (req: any) => projects.projectRollup(db, String(req.params.id)));

  // ─── Phase 6: deadline automations (manual trigger; the timer also runs it) ─
  app.post('/api/automations/deadlines/run', async (req: any) => {
    const res = await runDeadlineSweep(db, bus, { dueSoonHours: Number(req.body?.dueSoonHours ?? 24) });
    return res;
  });

  // ─── Phase 7: flows ────────────────────────────────────────────────────────
  app.get('/api/flows', async () => flows.listFlows(db));
  app.get('/api/flows/:id', async (req: any, reply: any) => {
    const f = await flows.getFlow(db, String(req.params.id));
    if (!f) return reply.code(404).send({ error: 'flow not found' });
    return f;
  });
  app.post('/api/flows', async (req: any, reply: any) => {
    const parsed = FlowUpsertInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    const v = flows.validateFlow(d.nodes as any, d.edges as any);
    if (!v.ok) return reply.code(400).send({ error: `invalid flow: ${v.errors.join('; ')}` });
    const id = uuid(); const now = iso();
    await db.run(
      'INSERT INTO flows (id, name, description, nodes, edges, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, d.name, d.description, JSON.stringify(d.nodes), JSON.stringify(d.edges), '0.1.0', req.user.id, now, now]);
    await db.run(
      'INSERT INTO flow_versions (id, flow_id, version, nodes, edges, created_at) VALUES (?,?,?,?,?,?)',
      [uuid(), id, '0.1.0', JSON.stringify(d.nodes), JSON.stringify(d.edges), now]);
    await bus.emit('flow.created', { id, name: d.name, nodes: d.nodes.length }, { actor_type: 'user', actor_id: req.user.id, target_type: 'flow', target_id: id });
    return flows.getFlow(db, id);
  });
  app.patch('/api/flows/:id', async (req: any, reply: any) => {
    const parsed = FlowUpsertInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const existing = await flows.getFlow(db, String(req.params.id));
    if (!existing) return reply.code(404).send({ error: 'flow not found' });
    const d = parsed.data;
    const v = flows.validateFlow(d.nodes as any, d.edges as any);
    if (!v.ok) return reply.code(400).send({ error: `invalid flow: ${v.errors.join('; ')}` });
    // version bump on any graph change; unchanged graph keeps its version
    const changed = JSON.stringify(d.nodes) !== JSON.stringify(existing.nodes) || JSON.stringify(d.edges) !== JSON.stringify(existing.edges);
    const parts = existing.version.split('.').map(Number);
    const newVersion = changed ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : existing.version;
    await db.run('UPDATE flows SET name = ?, description = ?, nodes = ?, edges = ?, version = ?, updated_at = ? WHERE id = ?',
      [d.name, d.description, JSON.stringify(d.nodes), JSON.stringify(d.edges), newVersion, iso(), existing.id]);
    if (changed) {
      await db.run('INSERT INTO flow_versions (id, flow_id, version, nodes, edges, created_at) VALUES (?,?,?,?,?,?)',
        [uuid(), existing.id, newVersion, JSON.stringify(d.nodes), JSON.stringify(d.edges), iso()]);
    }
    await bus.emit('flow.updated', { id: existing.id, name: d.name, version: newVersion, bumped: changed },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'flow', target_id: existing.id });
    return flows.getFlow(db, existing.id);
  });
  app.delete('/api/flows/:id', async (req: any, reply: any) => {
    const f = await flows.getFlow(db, String(req.params.id));
    if (!f) return reply.code(404).send({ error: 'flow not found' });
    await db.run('DELETE FROM flow_runs WHERE flow_id = ?', [f.id]);
    await db.run('DELETE FROM flow_versions WHERE flow_id = ?', [f.id]);
    await db.run('DELETE FROM flows WHERE id = ?', [f.id]);
    return { ok: true };
  });
  app.get('/api/flows/:id/versions', async (req: any) =>
    db.query('SELECT id, flow_id, version, created_at FROM flow_versions WHERE flow_id = ? ORDER BY created_at', [req.params.id]));

  // flow runs
  app.post('/api/flows/:id/run', async (req: any, reply: any) => {
    const parsed = FlowRunInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const f = await flows.getFlow(db, String(req.params.id));
    if (!f) return reply.code(404).send({ error: 'flow not found' });
    const run = await flowEngine.start(f, req.user.id, parsed.data.input ?? {});
    return run;
  });
  app.get('/api/flows/:id/runs', async (req: any) => flows.listRuns(db, String(req.params.id), 50));
  app.get('/api/flow-runs/:id', async (req: any, reply: any) => {
    const r = await flows.getRun(db, String(req.params.id));
    if (!r) return reply.code(404).send({ error: 'run not found' });
    return r;
  });
  app.post('/api/flow-runs/:id/pause', async (req: any) => ({ ok: await flowEngine.pause(String(req.params.id)) }));
  app.post('/api/flow-runs/:id/resume', async (req: any) => {
    const r = await flowEngine.resume(String(req.params.id));
    if (!r) return { ok: false };
    return r;
  });
  app.post('/api/flow-runs/:id/stop', async (req: any) => ({ ok: await flowEngine.stop(String(req.params.id)) }));

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
  app.get('/api/automation-runs', async (req: any) =>
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

  // ─── Phase 9: integrations ────────────────────────────────────────────────
  app.get('/api/integrations', async (req: any) => {
    const [adapters, conns] = await Promise.all([
      Promise.resolve(integrationsService.listAdapters()),
      integrationsService.listConnections(req.user.id),
    ]);
    return adapters.map(a => ({
      ...a,
      connection: conns.find(c => c.integration_id === a.id && c.status === 'connected') ?? null,
      oauth_configured: a.oauth
        ? !!(process.env[{ github: 'GITHUB_CLIENT_ID', gmail: 'GMAIL_CLIENT_ID' }[a.id] ?? ''] && process.env[{ github: 'GITHUB_CLIENT_SECRET', gmail: 'GMAIL_CLIENT_SECRET' }[a.id] ?? ''])
        : false,
    }));
  });
  app.post('/api/integrations/connect', async (req: any, reply: any) => {
    const parsed = IntegrationConnectTokenInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    try {
      const conn = await integrationsService.connectWithToken(req.user.id, d.integration_id, d.token, d.scopes);
      return { connected: true, connection: { integration_id: conn.integration_id, account: conn.account, scopes: conn.scopes, capabilities: conn.capabilities } };
    } catch (e: any) {
      return reply.code(400).send({ error: `connection failed: ${e.message}` });
    }
  });
  app.post('/api/integrations/:id/disconnect', async (req: any, reply: any) => {
    const ok = await integrationsService.disconnect(req.user.id, String(req.params.id));
    if (!ok) return reply.code(404).send({ error: 'integration not connected' });
    return { disconnected: true };
  });
  // scoped operations
  app.post('/api/integrations/:id/read', async (req: any, reply: any) => {
    try {
      const results = await integrationsService.read(req.user.id, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      return { results };
    } catch (e: any) {
      return reply.code(403).send({ error: e.message });
    }
  });
  app.post('/api/integrations/:id/create', async (req: any, reply: any) => {
    try {
      const result = await integrationsService.create(req.user.id, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      return { result };
    } catch (e: any) {
      return reply.code(403).send({ error: e.message });
    }
  });
  app.get('/api/integrations/:id/search', async (req: any, reply: any) => {
    try {
      const results = await integrationsService.search(req.user.id, String(req.params.id), String(req.query?.q ?? ''));
      return { results };
    } catch (e: any) {
      return reply.code(403).send({ error: e.message });
    }
  });
  app.get('/api/integrations/:id/events', async (req: any) =>
    integrationsService.listEvents(50, String(req.params.id)));
  app.get('/api/integration-events', async () => integrationsService.listEvents(50));

  // OAuth flow: start (returns consent URL) + complete (code exchange)
  app.get('/api/integrations/:id/oauth', async (req: any, reply: any) => {
    try {
      const { url, state } = await integrationsService.oauthStart(req.user.id, String(req.params.id), (req.query?.redirect_to as string) ?? null);
      return { url, state };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.post('/api/integrations/oauth/complete', async (req: any, reply: any) => {
    const parsed = IntegrationConnectOAuthInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    try {
      const conn = await integrationsService.oauthComplete(req.user.id, parsed.data.state, parsed.data.code);
      return { connected: true, connection: { integration_id: conn.integration_id, account: conn.account, scopes: conn.scopes } };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
  // provider callbacks land here (302 from GitHub/Google consent). The callback
  // is session-cookie exempt by URL prefix; the state row carries the user.
  app.get('/api/integrations/:id/oauth/callback', async (req: any, reply: any) => {
    const state = String(req.query?.state ?? '');
    const code = String(req.query?.code ?? '');
    const error = String(req.query?.error ?? '');
    if (error) return reply.redirect(`/integrations?oauth_error=${encodeURIComponent(error)}`);
    if (!state || !code) return reply.redirect('/integrations?oauth_error=missing_code');
    // resolve the user from the state row BEFORE redirecting into the app
    const rows = await db.query<any>('SELECT user_id, redirect_to FROM oauth_states WHERE state = ?', [state]);
    if (!rows[0]) return reply.redirect('/integrations?oauth_error=state_expired');
    try {
      const conn = await integrationsService.oauthComplete(rows[0].user_id, state, code);
      const dest = rows[0].redirect_to ?? '/integrations';
      return reply.redirect(`${dest}${dest.includes('?') ? '&' : '?'}connected=${conn.integration_id}`);
    } catch (e: any) {
      return reply.redirect(`/integrations?oauth_error=${encodeURIComponent(e.message).slice(0, 180)}`);
    }
  });

  // ─── links (knowledge graph) ───────────────────────────────────────────────
  app.get('/api/links', async (req: any) => {
    const type = String(req.query?.type ?? ''); const id = String(req.query?.id ?? '');
    if (type && id) return store.listLinks(db, { type, id });
    return db.query('SELECT * FROM links ORDER BY created_at DESC LIMIT 200');
  });
  app.post('/api/links', async (req: any, reply: any) => {
    const parsed = LinkCreateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const l = await store.createLink(db, { ...parsed.data, created_by: req.user.id });
    await bus.emit('link.created', { id: l.id, relation: l.relation }, { actor_type: 'user', actor_id: req.user.id, target_type: 'event', target_id: l.id });
    return l;
  });

  // ─── entities (graph explorer) ────────────────────────────────────────────
  app.get('/api/entities', async (req: any) => {
    const q = String(req.query?.q ?? '').toLowerCase();
    const rows = await db.query<any>('SELECT * FROM entities ORDER BY updated_at DESC LIMIT 500');
    return q ? rows.filter(r => r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q)) : rows;
  });

  // ─── approvals ────────────────────────────────────────────────────────────
  app.get('/api/approvals', async (req: any) => store.listApprovals(db, String(req.query?.status ?? 'pending')));
  app.post('/api/approvals/:id/decision', async (req: any, reply: any) => {
    const parsed = ApprovalDecisionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const ok = await runtime.resolveApproval(req.params.id, parsed.data.decision, req.user.id);
    if (!ok) return reply.code(404).send({ error: 'approval not found or already decided' });
    return { ok: true };
  });

  // ─── notifications ─────────────────────────────────────────────────────────
  app.get('/api/notifications', async (req: any) =>
    store.listNotifications(db, req.user.id, req.query?.status ?? undefined));
  app.post('/api/notifications/:id/read', async (req: any) => {
    await db.run('UPDATE notifications SET status = ? WHERE id = ?', ['read', req.params.id]);
    return { ok: true };
  });

  // ─── Phase 10: dashboard layout (configurable grid) ─────────────────────────
  app.get('/api/dashboard/layout', async (req: any) => ({
    layout: await notify.getLayout(db, req.user.id),
    registry: notify.WIDGET_REGISTRY,
  }));
  app.put('/api/dashboard/layout', async (req: any, reply: any) => {
    const parsed = DashboardLayoutInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid layout', details: parsed.error.flatten() });
    // duplicate widget instance ids break React keys — reject early
    const ids = parsed.data.widgets.map(w => w.id);
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'duplicate widget ids in layout' });
    const layout = await notify.setLayout(db, req.user.id, parsed.data.widgets as any);
    await bus.emit('widget.layout.updated', { widgets: layout.widgets.length },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'user', target_id: req.user.id });
    return layout;
  });
  app.post('/api/dashboard/layout/reset', async (req: any) =>
    notify.setLayout(db, req.user.id, notify.DEFAULT_LAYOUT));

  // ─── Phase 10: notification prefs + browser push channel ────────────────────
  app.get('/api/notifications/prefs', async (req: any) =>
    notify.getPrefs(db, req.user.id));
  app.put('/api/notifications/prefs', async (req: any, reply: any) => {
    const parsed = NotificationPrefsInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid prefs', details: parsed.error.flatten() });
    return notify.setPrefs(db, req.user.id, parsed.data as any);
  });
  // browser registers the PushSubscription after the service worker opts in
  app.get('/api/notifications/push/vapid', async () => ({
    publicKey: notify.getVapidKeys(config.dataDir).publicKey,
  }));
  app.post('/api/notifications/push/subscribe', async (req: any, reply: any) => {
    const parsed = PushSubscriptionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid subscription', details: parsed.error.flatten() });
    await notify.addPushSubscription(db, req.user.id, parsed.data as any);
    // subscribing implies the user wants the channel on
    const prefs = await notify.setPrefs(db, req.user.id, { browser_push: true });
    return { subscribed: true, prefs };
  });
  app.post('/api/notifications/push/unsubscribe', async (req: any, reply: any) => {
    const endpoint = String(req.body?.endpoint ?? '');
    if (!endpoint) return reply.code(400).send({ error: 'endpoint required' });
    await notify.removePushSubscription(db, endpoint);
    const subs = await notify.listPushSubscriptions(db, req.user.id);
    const prefs = subs.length === 0
      ? await notify.setPrefs(db, req.user.id, { browser_push: false })
      : await notify.getPrefs(db, req.user.id);
    return { unsubscribed: true, prefs };
  });
  app.get('/api/notifications/push/subscriptions', async (req: any) =>
    notify.listPushSubscriptions(db, req.user.id));
  // test fire through the whole pipeline (row → bus → router → channels)
  app.post('/api/notifications/push/test', async (req: any) => {
    const n = await store.notify(db, {
      user_id: req.user.id, title: 'Push test',
      message: 'If your browser is subscribed, this appears as a native notification.',
      priority: 'high', category: 'system', source: 'push-test',
    });
    await bus.emit('notification.created', { id: n.id, title: n.title },
      { actor_type: 'user', actor_id: req.user.id, target_type: 'notification', target_id: n.id });
    return { sent: n.id, note: 'in-app row created; browser push fan-out respects your prefs' };
  });

  // ─── generations ──────────────────────────────────────────────────────────
  app.get('/api/generations', async (req: any) => {
    const limit = Math.min(200, Number(req.query?.limit ?? 50));
    const execFilter = req.query?.execution_id ? 'WHERE execution_id = ?' : '';
    const params = req.query?.execution_id ? [req.query.execution_id] : [];
    const rows = await db.query<any>(
      `SELECT * FROM generations ${execFilter} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return rows.map(r => ({ ...r, input: safeParse(r.input), context: safeParse(r.context) }));
  });

  // ─── events / activity ────────────────────────────────────────────────────
  app.get('/api/events', async (req: any) => {
    const limit = Math.min(500, Number(req.query?.limit ?? 100));
    const rows = await db.query<any>('SELECT * FROM events ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map(parseEventRow);
  });

  // ─── audit ────────────────────────────────────────────────────────────────
  app.get('/api/audit', async (req: any) => {
    const limit = Math.min(500, Number(req.query?.limit ?? 200));
    const execFilter = req.query?.execution_id ? 'WHERE execution_id = ?' : '';
    const params = req.query?.execution_id ? [req.query.execution_id] : [];
    const rows = await db.query<any>(`SELECT * FROM audit_logs ${execFilter} ORDER BY ts DESC LIMIT ?`, [...params, limit]);
    return rows.map(r => ({ ...r, meta: safeParse(r.meta) }));
  });

  // ─── universal search (§28) ───────────────────────────────────────────────
  app.get('/api/search', async (req: any) => {
    const q = String(req.query?.q ?? '').trim();
    if (!q) return [];
    const like = `%${q.toLowerCase()}%`;
    const out: any[] = [];

    const tasks = await db.query<any>('SELECT id, title, status, updated_at FROM tasks WHERE LOWER(title) LIKE ? LIMIT 10', [like]);
    for (const t of tasks) out.push({ type: 'task', id: t.id, title: t.title, subtitle: `task · ${t.status}`, score: 1, created_at: t.updated_at });

    const projects = await db.query<any>('SELECT id, name, status, updated_at FROM projects WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 10', [like, like]);
    for (const p of projects) out.push({ type: 'project', id: p.id, title: p.name, subtitle: `project · ${p.status}`, score: 1, created_at: p.updated_at });

    const mems = await memory.searchMemory(db, { user_id: req.user.id, query: q, k: 10 });
    for (const m of mems) out.push({ type: 'memory', id: m.id, title: m.summary, subtitle: `memory · ${m.type}`, score: m.score, created_at: m.updated_at });

    const agents = await db.query<any>('SELECT id, name, description FROM agents WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 10', [like, like]);
    for (const a of agents) out.push({ type: 'agent', id: a.id, title: a.name, subtitle: a.description.slice(0, 80), score: 1, created_at: a.updated_at });

    const skills = await db.query<any>('SELECT id, name, description FROM skills WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 10', [like, like]);
    for (const s of skills) out.push({ type: 'skill', id: s.id, title: s.name, subtitle: `skill · ${s.category}`, score: 1, created_at: s.updated_at });

    const docs = await db.query<any>('SELECT id, title, subtitle, kind FROM entities WHERE LOWER(title) LIKE ? OR LOWER(subtitle) LIKE ? LIMIT 10', [like, like]);
    for (const d of docs) out.push({ type: 'entity', id: d.id, title: d.title, subtitle: `entity · ${d.kind}`, score: 1, created_at: '' });

    // Phase 11: graph query — matching entities expand to their neighborhoods
    const gq = await graph.graphQuery(db, q);
    for (const m of gq.matched) {
      const nb = gq.neighborhoods.find(n => n.center.id === m.id);
      out.push({
        type: 'graph', id: m.id, title: `⤫ ${m.label}`,
        subtitle: nb ? `graph · ${nb.nodes.length} neighbors via ${nb.edges.length} links` : `graph · ${m.kind}`,
        score: 0.9, created_at: '',
        neighborhood: nb ?? { center: { id: m.id, kind: m.kind, label: m.label, degree: 0, weight: 0 }, nodes: [], edges: [] },
      });
    }

    const gens = await db.query<any>('SELECT id, model_id, kind, created_at FROM generations WHERE LOWER(COALESCE(output, \'\')) LIKE ? LIMIT 10', [like]);
    for (const g of gens) out.push({ type: 'generation', id: g.id, title: `Generation ${g.kind}`, subtitle: g.model_id, score: 0.8, created_at: g.created_at });

    return out.sort((a, b) => b.score - a.score);
  });

  // ─── Phase 11: knowledge graph ────────────────────────────────────────────
  app.get('/api/graph', async (req: any) => {
    const kinds = req.query?.kinds ? String(req.query.kinds).split(',').map(s => s.trim()).filter(Boolean) : undefined;
    return graph.graphSnapshot(db, { kinds, includeAll: req.query?.all === '1' });
  });
  app.get('/api/graph/neighbors', async (req: any) => {
    const id = String(req.query?.id ?? '');
    if (!id || !id.includes(':')) return { error: 'id must be "<kind>:<entity_id>"' };
    return (await graph.graphNeighborhood(db, id)) ?? { error: 'node not found' };
  });
  app.post('/api/graph/derive', async (req: any) => {
    const res = await graph.deriveCoOccurrenceLinks(db);
    await bus.emit('link.created', { derived: true, ...res }, { actor_type: 'system' });
    return res;
  });

  // ─── SSE realtime stream (§27) ─────────────────────────────────────────────
  app.get('/api/stream', async (req: any, reply: any) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':ok\n\n');
    let last = new Date(Date.now() - 5000).toISOString();
    // replay recent events so a fresh page load has activity
    const recent = await bus.tail(last, 50);
    for (const ev of recent) reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    last = recent.length ? recent[recent.length - 1].created_at : last;

    const unsub = await broker.subscribe(CHANNEL, (_ch, payload) => {
      const ev = payload as any;
      // Volatile token events bypass the cursor (they are never persisted) —
      // send them straight through so streaming feels live on every panel.
      if (ev?.type === 'agent.token') { reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`); return; }
      if (ev?.created_at && ev.created_at > last) {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
        last = ev.created_at;
      }
    });
    const ping = setInterval(() => { try { reply.raw.write(':ping\n\n'); } catch { /* closed */ } }, 15000);
    req.raw.on('close', () => { clearInterval(ping); unsub(); });
  });

  // ─── COMMAND CENTER (§29) ──────────────────────────────────────────────────
  app.post('/api/command', async (req: any, reply: any) => {
    const parsed = CommandInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const text = parsed.data.text.trim();
    await bus.emit('command.executed', { text: text.slice(0, 200) }, { actor_type: 'user', actor_id: req.user.id });
    return routeCommand(text, req.user);
  });

  async function routeCommand(text: string, user: { id: string; username: string; display_name: string }): Promise<any> {
    const t = text.toLowerCase();

    // "show me what my agents are doing" / "what changed while i was away"
    if (/\b(what).*(agents?).*(doing|up to)|show.*(agents?)\b/.test(t)) {
      const agents = await store.listAgents(db);
      const running = await db.query<any>("SELECT * FROM executions WHERE status IN ('running','approval_required','paused') ORDER BY started_at DESC LIMIT 10");
      return { kind: 'result', text: [
        'AGENTS', ...agents.map(a => `${a.name.padEnd(14)} ${a.status === 'idle' ? '○' : '●'} ${a.status}`),
        '', 'ACTIVE EXECUTIONS', ...(running.length ? running.map(r => `${r.id.slice(0, 8)} — ${r.status}: ${r.input.slice(0, 80)}`) : ['(none — all idle)']),
      ].join('\n') };
    }

    // memory queries
    if (/\b(what do you (know|remember)|recall|do you remember)\b/.test(t)) {
      const hits = await memory.searchMemory(db, { user_id: user.id, query: text, k: 5 });
      return { kind: 'result', text: hits.length
        ? ['MEMORY', ...hits.map(h => `- (${h.type}, importance ${h.importance}) ${h.summary}`)].join('\n')
        : 'No matching memories yet. Memories accumulate as you and your agents work.' };
    }

    // greeting / morning briefing (§30)
    if (/^(good morning|hello|hi|hey|morning brief|briefing|what.*today)\b/.test(t)) {
      const openTasks = await store.listTasks(db, { status: 'todo', limit: 5 });
      const inProgress = await store.listTasks(db, { status: 'in_progress', limit: 5 });
      const agents = await store.listAgents(db);
      const notes = await store.listNotifications(db, user.id, 'unread');
      const projects = await store.listProjects(db);
      return { kind: 'result', text: [
        `Good ${new Date().getHours() < 12 ? 'morning' : 'day'}, ${user.display_name || user.username}.`,
        '', 'TODAY',
        `  ${openTasks.length} open tasks, ${inProgress.length} in progress`,
        `  ${notes.length} unread notifications`,
        '', 'ACTIVE AGENTS',
        ...(agents.length ? agents.map(a => `  ${a.name.padEnd(13)} ${a.status}`) : ['  (none)']),
        '', 'PROJECTS',
        ...(projects.length ? projects.map(p => `  ${p.name.padEnd(13)} ${p.status}`) : ['  (none)']),
      ].join('\n') };
    }

    // explicit sprint creation (§22) — Phase 6: dependency-aware planning
    if (/\b(create|make|start|prepare|plan)\b.*\bsprint\b/.test(t)) {
      const projMatch = text.match(/for\s+(?:the\s+)?["“']?([A-Za-z0-9 _-]+?)["”']?\s*(?:project|workspace)?\s*$/i)
        ?? text.match(/\bsprint for\s+([A-Za-z0-9 _-]+)/i);
      // normalize: strip a trailing "project"/"workspace" word so "for the Aurora project"
      // captures "Aurora", not "Aurora project" (which would miss the existing project)
      let rawName = projMatch?.[1]?.trim() ?? '';
      rawName = rawName.replace(/\s+(project|workspace)$/i, '').trim();
      let project = rawName ? await store.findProjectByName(db, rawName) : (await store.listProjects(db))[0];
      if (!project) project = await store.createProject(db, { name: rawName || 'General', created_by: user.id });
      // Phase 6: dependency-chained plan — Design → Implement → Test → Deploy
      const goalMatch = text.match(/\bsprint\b(?:\s+(?:for|on|to))?\s+(?:the\s+)?(.+?)(?:\s+(?:in|for)\s+(?:the\s+)?(?:project\s+)?[A-Za-z0-9 _-]+)?\s*$/i);
      const goal = (goalMatch?.[1] ?? '').replace(/\b(create|make|start|prepare|plan)\b|\bsprint\b/gi, '').trim();
      const g = goal.length > 3 ? goal : `${project.name} work`;
      const res = await projects.materializeSprintPlan(db, {
        project_id: project.id, name: `Sprint: ${g}`.slice(0, 120), objective: text.slice(0, 200),
        tasks: [
          { title: `Design: ${g}`, description: 'Define requirements and approach', priority: 'high', depends_on_titles: [] },
          { title: `Implement: ${g}`, description: 'Build the solution per the design', priority: 'urgent', depends_on_titles: [`Design: ${g}`] },
          { title: `Test: ${g}`, description: 'Verify behavior against requirements', priority: 'high', depends_on_titles: [`Implement: ${g}`] },
          { title: `Deploy: ${g}`, description: 'Ship and monitor', priority: 'medium', depends_on_titles: [`Test: ${g}`] },
        ],
      });
      await bus.emit('sprint.planned', { sprint_id: res.sprint.id, name: res.sprint.name, project: project.name, tasks: res.tasks.length, blocked: res.blocked_count },
        { actor_type: 'user', actor_id: user.id, target_type: 'sprint', target_id: res.sprint.id });
      await bus.emit('sprint.started', { id: res.sprint.id, name: res.sprint.name, tasks: res.tasks.length }, { actor_type: 'user', actor_id: user.id, target_type: 'sprint', target_id: res.sprint.id });
      return {
        kind: 'result',
        text: `Sprint "${res.sprint.name}" planned in project "${project.name}" — ${res.tasks.length} tasks in a dependency chain (Design → Implement → Test → Deploy). ${res.blocked_count} task(s) auto-blocked by dependencies; complete a task to unblock the next. Execution order: level 0 first.`,
        data: { sprint_id: res.sprint.id },
      };
    }

    // Phase 6: milestone creation — "add a milestone X to project Y"
    if (/\b(add|create|set)\b.*\bmilestone\b/.test(t)) {
      const nameMatch = text.match(/milestone\s+(?:called|named|titled|for|to|[:\-])?\s*["“']?([^"”',]{2,120})["”']?/i);
      let mName = nameMatch?.[1]?.trim() ?? '';
      // strip trailing "to project X" fragments
      const pm = mName.match(/\s+(?:in|to|for)\s+(?:the\s+)?(?:project\s+)?(.+)$/i);
      let projName = pm?.[1]?.trim();
      if (projName) mName = mName.slice(0, pm!.index).trim();
      const project = projName
        ? (await store.findProjectByName(db, projName)) ?? (await store.createProject(db, { name: projName, created_by: user.id }))
        : (await store.listProjects(db))[0];
      if (!project) return { kind: 'result', text: 'No project to attach the milestone to — create a project first.' };
      const due = text.match(/\b(?:by|due|before)\s+([A-Za-z0-9/, -]{3,20})/)?.[1];
      const m = await projects.createMilestone(db, { project_id: project.id, name: mName || 'New milestone', due_date: due ? new Date(due).toISOString() : null });
      await bus.emit('milestone.created', { id: m.id, name: m.name, project_id: m.project_id }, { actor_type: 'user', actor_id: user.id, target_type: 'project', target_id: m.project_id });
      return { kind: 'result', text: `Milestone "${m.name}" added to project "${project.name}"${m.due_date ? ` (due ${m.due_date.slice(0, 10)})` : ''}. It will flip to "missed" automatically if the due date passes while still open.`, data: { milestone_id: m.id } };
    }

    // Phase 6: project status via rollup — "status of project X" / "how is X going"
    const statusMatch = t.match(/\b(?:status|progress|how is|how's)\b.*\b(?:project|going)\b/i)
      ?? t.match(/\b(?:project)\s+([A-Za-z0-9 _-]+)\s+status\b/i);
    if (statusMatch) {
      const nameMatch2 = t.match(/\b(?:project|of)\s+["“']?([A-Za-z0-9][A-Za-z0-9 _-]{1,40})["”']?/i);
      const name = nameMatch2?.[1]?.trim();
      const project = name ? await store.findProjectByName(db, name) : (await store.listProjects(db))[0];
      if (!project) return { kind: 'result', text: name ? `No project named "${name}".` : 'No projects yet.' };
      const r = await projects.projectRollup(db, project.id);
      if (!r) return { kind: 'result', text: 'Project not found.' };
      return { kind: 'result', text: [
        `Project "${project.name}" — ${r.completion_pct}% complete`,
        `  Tasks: ${r.tasks.done}/${r.tasks.total} done · ${r.tasks.in_progress} in progress · ${r.tasks.blocked} blocked`,
        ...(r.blocked_tasks.length ? ['', 'BLOCKERS', ...r.blocked_tasks.map(b => `  ${b.title} waits on: ${b.waiting_on.join(', ')}`)] : []),
        ...(r.overdue_tasks.length ? ['', 'OVERDUE', ...r.overdue_tasks.map(o => `  ${o.title} (deadline ${String(o.deadline).slice(0, 10)})`)] : []),
        ...(r.active_sprints.length ? ['', 'ACTIVE SPRINTS', ...r.active_sprints.map(s => `  ${s.name} — ${s.tasks_done}/${s.tasks_total} tasks (${s.completion_pct}%)`)] : []),
        ...(r.milestones.total ? ['', `MILESTONES — ${r.milestones.reached} reached, ${r.milestones.missed} missed, ${r.milestones.open} open`,
          ...(r.milestones.next_due ? [`  next due: ${r.milestones.next_due.name} (${String(r.milestones.next_due.due_date).slice(0, 10)})`] : [])] : []),
      ].join('\n'), data: r as any };
    }

    // connect integration (Phase 9: real adapters + vault + OAuth)
    if (/\b(connect|link|hook up)\b.*\b(github|gmail|slack)\b/.test(t)) {
      const idMatch = t.match(/\b(github|gmail|slack)\b/i);
      const integrationId = idMatch?.[1]?.toLowerCase();
      const conn = await integrationsService.getConnection(user.id, String(integrationId));
      if (conn && conn.status === 'connected') {
        return { kind: 'result', text: `${conn.account} is already connected to ${integrationId} with scopes: ${conn.scopes.join(', ')}. Disconnect from the Integrations page if you want to switch accounts.` };
      }
      return { kind: 'result', text: [
        `To connect ${integrationId}, open the Integrations page (rail icon ⎌) and either:`,
        `  • paste a ${integrationId === 'slack' ? 'bot token (xoxb-…)' : 'personal access token'} — it is verified against the provider and stored encrypted, or`,
        `  • use the OAuth button${integrationId === 'slack' ? ' (Slack connects with bot tokens only)' : ' for the full consent flow'}.`,
        `Tokens never touch the database in plaintext — the vault encrypts them with AES-256-GCM.`,
      ].join('\n') };
    }

    // schedule (§15 — automations are Phase 8)
    if (/\b(schedule|every morning|cron|recurring)\b/.test(t)) {
      return { kind: 'unimplemented', text: 'The Automation Engine (cron/webhook/event triggers) is Phase 8 in ROADMAP.md. The event bus it will subscribe to is live — every action you take now already emits events.' };
    }

    // route everything else through specialist detection (Phase 3), falling back to Hermes
    const specialist = await detectSpecialist(t);
    const agent = specialist ?? (await store.getAgentByName(db, 'Hermes')) ?? (await store.listAgents(db))[0];
    if (!agent) return { kind: 'result', text: 'No agents registered. Run: npm run seed' };
    // Phase 4: "run/use the <skill> skill [on <url>]" → direct skill execution
    const skillMatch = text.match(/\b(?:run|use|execute)\s+(?:the\s+)?["“']?([A-Za-z][A-Za-z&' -]{2,40}?)["”']?\s+skill\b/i);
    if (skillMatch) {
      const skillName = skillMatch[1].trim();
      const skill = await store.getSkill(db, skillName);
      if (skill) {
        const target = /https?:\/\/\S+/i.exec(text)?.[0];
        const input = target ? `Run skill ${skill.name} on ${target}` : `Run skill ${skill.name}`;
        const exec = await runtime.run({ agent, input, user_id: user.id, skill: skill.name } as any);
        return { kind: 'execution', execution_id: exec.id, agent_id: agent.id, agent_name: agent.name };
      }
      // unknown skill falls through to normal planning (the planner will report it)
    }
    const exec = await runtime.run({ agent, input: text, user_id: user.id });
    return { kind: 'execution', execution_id: exec.id, agent_id: agent.id, agent_name: agent.name };
  }

  /** Phase 3: specialist routing — explicit or keyword-based agent selection.
   *  Delegation phrasing ("delegate to X", "have X do Y") intentionally routes to
   *  Hermes so the supervisor creates a real delegation graph via agent.delegate. */
  async function detectSpecialist(t: string): Promise<any | null> {
    // delegation phrasing → supervisor orchestrates (agent.delegate creates the child execution)
    if (/\bdelegate\s+(?:to|the)\b/i.test(t) || /\bdelegate\b.*\bto\s+(?:the\s+)?(?:coder|researcher|monitor|planner)\b/i.test(t)) {
      return null; // fall through to Hermes
    }
    // explicit direct routing: "ask the coder to …" / "tell Monitor to …"
    const explicit = t.match(/\b(?:ask|tell|have|get|instruct)\s+(?:the\s+)?([A-Za-z]+)\s+to\b/i);
    const name = explicit?.[1];
    if (name) {
      const agent = await store.getAgentByName(db, name);
      if (agent) return agent;
    }
    // keyword-based specialist matching
    const rules: { re: RegExp; agent: string }[] = [
      { re: /\b(research|investigate|find out|look up|fetch.*url|sources?|web|paper|article)\b/i, agent: 'Researcher' },
      { re: /\b(code|implement|write.*script|refactor|debug|fix.*bug|build|program|html|css)\b/i, agent: 'Coder' },
      { re: /\b(status|health|monitor|watch|alert|system)\b/i, agent: 'Monitor' },
      { re: /\b(plan|roadmap|break ?down|milestone|sprint|goals?)\b/i, agent: 'Planner' },
    ];
    for (const r of rules) {
      if (r.re.test(t)) {
        const agent = await store.getAgentByName(db, r.agent);
        if (agent) return agent;
      }
    }
    return null;
  }

  // ─── dashboard (home widgets data) ────────────────────────────────────────
  app.get('/api/dashboard', async (req: any) => {
    const user = req.user;
    const [agents, tasks, projects, notes, events] = await Promise.all([
      store.listAgents(db),
      store.listTasks(db, { limit: 100 }),
      store.listProjects(db),
      store.listNotifications(db, user.id, 'unread'),
      bus.list(30),
    ]);
    const counts = {
      executions: Number((await db.query<any>('SELECT COUNT(*) AS n FROM executions'))[0]?.n ?? 0),
      memories: Number((await db.query<any>('SELECT COUNT(*) AS n FROM memories'))[0]?.n ?? 0),
      generations: Number((await db.query<any>('SELECT COUNT(*) AS n FROM generations'))[0]?.n ?? 0),
      tool_runs: Number((await db.query<any>('SELECT COUNT(*) AS n FROM tool_executions'))[0]?.n ?? 0),
    };
    // Wire-shape guarantee: every array field is a real array even if a
    // subsystem errored — the dashboard must never degrade the UI.
    return {
      agents: Array.isArray(agents) ? agents : [],
      tasks: Array.isArray(tasks) ? tasks : [],
      projects: Array.isArray(projects) ? projects : [],
      notes: Array.isArray(notes) ? notes : [],
      events: Array.isArray(events) ? events : [],
      counts,
    };
  });

  return app;
}

function scopesForTools(toolNames: string[], registry: ToolRegistry): string[] {
  const scopes = new Set<string>(['memory:read', 'memory:write']); // baseline
  for (const t of registry.list()) {
    if (toolNames.includes(t.name)) scopes.add(t.scope);
  }
  return [...scopes];
}

function safeParse(v: unknown): any {
  if (typeof v !== 'string') return v ?? {};
  try { return JSON.parse(v); } catch { return v; }
}
