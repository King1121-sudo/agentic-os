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
import { config } from './config';
import { hashPassword, verifyPassword } from './auth.util';
import {
  LoginInput, ExecuteInput, CommandInput, ProjectCreateInput, TaskCreateInput, TaskUpdateInput,
  SprintCreateInput, MemoryCreateInput, AgentCreateInput, LinkCreateInput, ApprovalDecisionInput,
  SkillCreateInput,
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
}

// ─── password hashing lives in auth.util.ts (scrypt, stdlib) ─────────────────

export function buildApi(deps: ApiDeps) {
  const { db, broker, bus, router, runtime, tools } = deps;
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
    if (req.url.startsWith('/api/auth') || req.url.startsWith('/api/health')) return;
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
    return {
      ok: dbUp, version: config.version, time: iso(),
      db: dbUp ? 'up' : 'down', broker: 'up',
      providers: await db.query('SELECT id, name, kind, status FROM model_providers'),
      counts: {
        agents: await count('agents'), executions: await count('executions'),
        memories: await count('memories'), tasks: await count('tasks'),
        projects: await count('projects'), generations: await count('generations'),
        events: await count('events'),
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
    });
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
  app.post('/api/skills', async (req: any, reply: any) => {
    const parsed = SkillCreateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    const now = iso();
    const rec = {
      id: uuid(), name: d.name, description: d.description, category: d.category,
      parent_id: d.parent_id ?? null, version: '0.1.0', instructions: d.instructions,
      steps: d.steps, required_tools: d.required_tools ?? [], required_permissions: [],
      created_at: now, updated_at: now,
    };
    await db.run(
      `INSERT INTO skills (id, name, description, category, parent_id, version, instructions, steps, required_tools, required_permissions, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rec.id, rec.name, rec.description, rec.category, rec.parent_id, rec.version, rec.instructions,
       JSON.stringify(rec.steps), JSON.stringify(rec.required_tools), JSON.stringify(rec.required_permissions), now, now],
    );
    return rec;
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
    if (q) return memory.searchMemory(db, { user_id: req.user.id, query: q, k: 20 });
    return memory.listMemories(db, req.user.id, {
      type: req.query?.type, project_id: req.query?.project_id, limit: 200,
    });
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
    store.listNotifications(db, req.user.id, req.query?.status));
  app.post('/api/notifications/:id/read', async (req: any) => {
    await db.run('UPDATE notifications SET status = ? WHERE id = ?', ['read', req.params.id]);
    return { ok: true };
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

    const gens = await db.query<any>('SELECT id, model_id, kind, created_at FROM generations WHERE LOWER(COALESCE(output, \'\')) LIKE ? LIMIT 10', [like]);
    for (const g of gens) out.push({ type: 'generation', id: g.id, title: `Generation ${g.kind}`, subtitle: g.model_id, score: 0.8, created_at: g.created_at });

    return out.sort((a, b) => b.score - a.score);
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

    // explicit sprint creation (§22)
    if (/\b(create|make|start|prepare)\b.*\bsprint\b/.test(t)) {
      const projMatch = text.match(/for\s+(?:the\s+)?["“']?([A-Za-z0-9 _-]+)["”']?\s*$/i) ?? text.match(/\bsprint for\s+([A-Za-z0-9 _-]+)/i);
      let project = projMatch ? await store.findProjectByName(db, projMatch[1].trim()) : (await store.listProjects(db))[0];
      if (!project) project = await store.createProject(db, { name: projMatch?.[1]?.trim() ?? 'General', created_by: user.id });
      const sprint = await store.createSprint(db, {
        project_id: project.id, name: `Sprint: ${project.name}`, objective: text.slice(0, 200),
      });
      // create the standard sprint task template
      const template = ['Architecture review', 'Security audit', 'Testing', 'Deployment', 'Monitoring', 'Documentation'];
      const created: any[] = [];
      for (const step of template) {
        created.push(await store.createTask(db, { title: step, project_id: project.id, sprint_id: sprint.id, priority: 'high', created_by: user.id }));
      }
      await bus.emit('sprint.started', { id: sprint.id, name: sprint.name, tasks: created.length }, { actor_type: 'user', actor_id: user.id, target_type: 'sprint', target_id: sprint.id });
      return { kind: 'result', text: `Sprint "${sprint.name}" created in project "${project.name}" with ${created.length} tasks (architecture review, security audit, testing, deployment, monitoring, documentation).`, data: { sprint_id: sprint.id } };
    }

    // connect integration (framework boundary — §16, honestly unimplemented)
    if (/\b(connect|link|hook up)\b.*\b(github|gmail|slack|notion|linear|calendar)\b/.test(t)) {
      return { kind: 'unimplemented', text: 'The Integration SDK ships as a port (connect/disconnect/authenticate/subscribe interface in apps/api/src/modules/integrations.ts). Gmail/GitHub/Slack adapters are Phase 9 (ROADMAP.md); the kernel does not fake them.' };
    }

    // schedule (§15 — automations are Phase 8)
    if (/\b(schedule|every morning|cron|recurring)\b/.test(t)) {
      return { kind: 'unimplemented', text: 'The Automation Engine (cron/webhook/event triggers) is Phase 8 in ROADMAP.md. The event bus it will subscribe to is live — every action you take now already emits events.' };
    }

    // route everything else through specialist detection (Phase 3), falling back to Hermes
    const specialist = await detectSpecialist(t);
    const agent = specialist ?? (await store.getAgentByName(db, 'Hermes')) ?? (await store.listAgents(db))[0];
    if (!agent) return { kind: 'result', text: 'No agents registered. Run: npm run seed' };
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
    return { agents, tasks, projects, notes, events, counts };
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
