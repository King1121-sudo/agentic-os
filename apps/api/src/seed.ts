/**
 * Idempotent seed: admin user, model-provider entries for configured gateways,
 * default agent roster (Planner/Hermes/Coder/Researcher/Monitor per §7),
 * a starter skill tree (§12), and an example project + memory.
 * Runs on every boot; only creates what's missing.
 */
import type { DataPort } from './infra/types';
import { iso, uuid } from './infra/types';
import type { EventBus } from './kernel/bus';
import * as store from './modules/store';
import { createMemory } from './modules/memory';
import { config } from './config';
import { hashPassword } from './auth.util';

const now = () => iso();

export async function seed(db: DataPort, bus: EventBus): Promise<{ created: boolean; agents: number; skills: number }> {
  let createdUser = false;

  // ── admin user ────────────────────────────────────────────────────────────
  const userCount = await db.query<any>('SELECT COUNT(*) AS n FROM users');
  if ((userCount[0]?.n ?? 0) === 0) {
    const id = uuid();
    await db.run(
      'INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [id, config.seedAdmin.username, hashPassword(config.seedAdmin.password), 'Administrator', now(), now()],
    );
    createdUser = true;
  }

  // ── agents ────────────────────────────────────────────────────────────────
  const agentDefs = [
    {
      name: 'Hermes',
      description: 'Generalist supervisor. Routes requests, plans, coordinates other agents.',
      system_instructions: 'You are Hermes, the supervisor agent of the Agentic OS. Plan efficiently, use tools for concrete actions, and summarize results clearly for the user.',
      autonomy: 2,
      tools: ['memory.search', 'memory.write', 'task.create', 'task.update', 'task.list', 'project.create', 'notify', 'sys.info', 'calc.eval', 'http.fetch'],
    },
    {
      name: 'Planner',
      description: 'Breaks goals into sprints, tasks and dependency-ordered plans.',
      system_instructions: 'You are the Planner agent. Convert goals into concrete, dependency-ordered task plans and sprints. Use task.create and project.create to materialize plans.',
      autonomy: 2,
      tools: ['memory.search', 'task.create', 'task.update', 'task.list', 'project.create', 'sys.info'],
    },
    {
      name: 'Coder',
      description: 'Writes code and artifacts into the sandbox; runs whitelisted commands when approved.',
      system_instructions: 'You are the Coder agent. Produce working code, write artifacts with file.write, and only request shell.run when genuinely needed.',
      autonomy: 2,
      tools: ['memory.search', 'file.write', 'file.read', 'http.fetch', 'shell.run', 'notify'],
    },
    {
      name: 'Researcher',
      description: 'Fetches and synthesizes information from the web.',
      system_instructions: 'You are the Researcher agent. Fetch sources with http.fetch, cross-check, and synthesize concise findings.',
      autonomy: 3,
      tools: ['memory.search', 'memory.write', 'http.fetch', 'file.write', 'notify'],
    },
    {
      name: 'Monitor',
      description: 'Watches system health and project status; escalates anomalies.',
      system_instructions: 'You are the Monitor agent. Check system state with sys.info, report anomalies via notify. Be terse.',
      autonomy: 3,
      tools: ['sys.info', 'memory.search', 'notify', 'task.list'],
    },
  ];

  let agentsCreated = 0;
  for (const def of agentDefs) {
    if (await store.getAgentByName(db, def.name)) continue;
    await store.upsertAgent(db, {
      id: uuid(), name: def.name, description: def.description,
      system_instructions: def.system_instructions,
      model_policy: { capability: 'reasoning', preference: [] },
      skills: [], tools: def.tools,
      memory_policy: { read: true, write: true, k: 5, types: ['semantic', 'episodic', 'preference', 'project'] },
      permissions: { tools: def.tools, scopes: scopesFor(def.tools) },
      autonomy_level: def.autonomy as any,
      status: 'idle', created_at: now(), updated_at: now(),
    });
    agentsCreated++;
  }

  // ── skills (starter skill tree: general → …) ──────────────────────────────
  const skillDefs = [
    {
      name: 'Daily Briefing', category: 'productivity', description: 'Compile open tasks, agent status, notifications into a briefing.',
      steps: [
        { kind: 'tool', tool: 'task.list', args: { status: 'todo' } },
        { kind: 'tool', tool: 'sys.info', args: {} },
        { kind: 'model', capability: 'writing', prompt: 'Compose a terse daily briefing from the task list and system info.', input_from: 'all' },
      ] as any[],
      required_tools: ['task.list', 'sys.info'],
    },
    {
      name: 'Research & Save', category: 'research', description: 'Fetch a URL, summarize, save the summary to memory and file.',
      steps: [
        { kind: 'tool', tool: 'http.fetch', args: {} },
        { kind: 'model', capability: 'reasoning', prompt: 'Summarize the fetched content in five key points.', input_from: 'last' },
        { kind: 'tool', tool: 'memory.write', args: {} },
      ] as any[],
      required_tools: ['http.fetch', 'memory.write'],
    },
    {
      name: 'Web Artifact', category: 'development', description: 'Write a generated HTML/MD artifact into the sandbox.',
      steps: [
        { kind: 'model', capability: 'writing', prompt: 'Draft the artifact content.', input_from: 'all' },
        { kind: 'tool', tool: 'file.write', args: {} },
      ] as any[],
      required_tools: ['file.write'],
    },
  ];

  let skillsCreated = 0;
  for (const s of skillDefs) {
    const existing = await db.query<any>('SELECT id FROM skills WHERE name = ?', [s.name]);
    if (existing.length) continue;
    await db.run(
      `INSERT INTO skills (id, name, description, category, parent_id, version, instructions, steps, required_tools, required_permissions, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), s.name, s.description, s.category, null, '0.1.0', '', JSON.stringify(s.steps),
       JSON.stringify(s.required_tools), JSON.stringify([]), now(), now()],
    );
    skillsCreated++;
  }

  // ── example project + welcome memory (first boot only) ────────────────────
  if (createdUser) {
    const admin = (await db.query<any>('SELECT id FROM users ORDER BY created_at LIMIT 1'))[0];
    const proj = await store.createProject(db, {
      name: 'Agentic OS', description: 'The operating system for AI agents — this instance.', created_by: admin.id,
    });
    await store.createTask(db, {
      title: 'Explore the command center', project_id: proj.id, priority: 'medium', created_by: admin.id,
      description: 'Type "what are my agents doing" or "create a task to review the kernel design".',
    });
    await createMemory(db, {
      user_id: admin.id, type: 'preference',
      content: 'User prefers concise, technical briefings and honest status over optimistic filler.',
      importance: 7, source: 'seed',
    });
    await createMemory(db, {
      user_id: admin.id, type: 'semantic',
      content: 'Agentic OS kernel v0.1: Fastify API, adapter-based data layer (SQLite/Postgres), event bus, agent runtime with approvals, model gateway with fallback, memory engine with consolidation, tools gated by risk/autonomy.',
      importance: 8, source: 'seed',
    });
    if (bus) await bus.emit('system.ready', { seeded: true, agents: agentDefs.length, skills: skillDefs.length }, { actor_type: 'system' });
  }

  return { created: createdUser, agents: agentsCreated, skills: skillsCreated };
}

function scopesFor(toolNames: string[]): string[] {
  const map: Record<string, string> = {
    'memory.search': 'memory:read', 'memory.write': 'memory:write',
    'task.create': 'tasks:write', 'task.update': 'tasks:write', 'task.list': 'tasks:read',
    'project.create': 'projects:write', 'http.fetch': 'net:fetch',
    'file.write': 'files:write', 'file.read': 'files:read', 'shell.run': 'shell:exec',
    'notify': 'notify:send', 'calc.eval': 'calc', 'sys.info': 'system:read',
  };
  return [...new Set(['memory:read', 'memory:write', ...toolNames.map(t => map[t]).filter(Boolean)])];
}
