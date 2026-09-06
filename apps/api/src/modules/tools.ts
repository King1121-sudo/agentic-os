/**
 * Tool Runtime (§13). Tools are registered capabilities with schema, risk class,
 * permission scope, and execute(). The runtime routes every call through the
 * security gate (evaluateGate) — no tool runs ungated.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { ToolDef, ToolContext } from '../kernel/types';
export type { ToolDef } from '../kernel/types';
import { config } from '../config';
import * as store from './store';
import { createMemory, searchMemory } from './memory';
import * as projects from './projects';
import { clearDeadlineAlerts } from './automations';
import type { AgentRuntime } from './runtime';

/** Phase 3: set by main.ts after the runtime is constructed (avoids the cycle). */
let runtimeRef: AgentRuntime | null = null;
export function setRuntimeRef(r: AgentRuntime): void { runtimeRef = r; }

const SANDBOX = path.resolve(config.dataDir, 'sandbox');

function sandboxPath(rel: string): string {
  const p = path.resolve(SANDBOX, rel.replace(/^[.\/\\]+/, ''));
  if (p !== SANDBOX && !p.startsWith(SANDBOX + path.sep)) throw new Error(`Path escapes sandbox: ${rel}`);
  return p;
}

// ─── registry ────────────────────────────────────────────────────────────────
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(t: ToolDef): void { this.tools.set(t.name, t); }
  get(name: string): ToolDef | undefined { return this.tools.get(name); }
  list(): ToolDef[] { return [...this.tools.values()]; }
}

// ─── tool executions persistence ────────────────────────────────────────────
export async function recordToolExecution(
  db: DataPort, e: { execution_id: string | null; agent_id: string | null; tool: string; args: unknown; result: unknown; risk: string; status: string; error?: string; latency_ms: number },
): Promise<string> {
  const id = uuid();
  await db.run(
    `INSERT INTO tool_executions (id, execution_id, agent_id, tool, args, result, risk, status, error, latency_ms, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, e.execution_id, e.agent_id, e.tool, JSON.stringify(e.args ?? {}), JSON.stringify(e.result ?? null),
     e.risk, e.status, e.error ?? null, e.latency_ms, iso()],
  );
  return id;
}

// ─── builtin tools ──────────────────────────────────────────────────────────
export function createBuiltinTools(db: DataPort): ToolDef[] {
  fs.mkdirSync(SANDBOX, { recursive: true });

  const tools: ToolDef[] = [
    {
      name: 'memory.write',
      description: 'Persist a durable memory of a given type. Use for facts, preferences, events worth remembering.',
      risk: 'low', scope: 'memory:write',
      schema: {
        content: { type: 'string', required: true, description: 'What to remember' },
        type: { type: 'string', required: false, description: 'episodic|semantic|preference|project|procedural' },
        importance: { type: 'number', required: false, description: '0-10' },
      },
      async execute(args, ctx) {
        const { record, deduped } = await createMemory(db, {
          user_id: ctx.user_id,
          type: (String(args.type || 'semantic') as any),
          content: String(args.content),
          importance: Number(args.importance ?? 5),
          source: `agent:${ctx.agent.name}`,
          source_id: ctx.execution_id,
        });
        return { id: record.id, deduplicated: !!deduped, memory: { type: record.type, summary: record.summary } };
      },
    },
    {
      name: 'memory.search',
      description: 'Search long-term memory by query. Returns top-k scored hits.',
      risk: 'low', scope: 'memory:read',
      schema: { query: { type: 'string', required: true, description: 'Search text' }, k: { type: 'number', required: false, description: 'Top-k (default 5)' } },
      async execute(args, ctx) {
        const hits = await searchMemory(db, { user_id: ctx.user_id, query: String(args.query), k: Number(args.k ?? 5) });
        return hits.map(h => ({ id: h.id, type: h.type, summary: h.summary, score: Number(h.score.toFixed(3)) }));
      },
    },
    {
      name: 'task.create',
      description: 'Create a task (optionally in a project / with priority).',
      risk: 'medium', scope: 'tasks:write',
      schema: {
        title: { type: 'string', required: true, description: 'Task title' },
        project_name: { type: 'string', required: false, description: 'Project name (created if missing)' },
        priority: { type: 'string', required: false, description: 'low|medium|high|urgent' },
        description: { type: 'string', required: false, description: 'Details' },
      },
      async execute(args, ctx) {
        let project_id: string | null = null;
        if (args.project_name) {
          const existing = await store.findProjectByName(db, String(args.project_name));
          project_id = existing ? existing.id : (await store.createProject(db, { name: String(args.project_name), created_by: ctx.user_id })).id;
        }
        const t = await store.createTask(db, {
          title: String(args.title), description: String(args.description ?? ''), project_id,
          priority: (args.priority as any) ?? 'medium', created_by: ctx.user_id,
          assignee_agent_id: ctx.agent.id,
        });
        return { id: t.id, title: t.title, project_id: t.project_id };
      },
    },
    {
      name: 'task.update',
      description: 'Update a task by id (status, priority, title, ...). Completing a task auto-unblocks dependent tasks.',
      risk: 'medium', scope: 'tasks:write',
      schema: { task_id: { type: 'string', required: true, description: 'Task id' }, status: { type: 'string', required: false, description: 'todo|in_progress|blocked|done|archived' } },
      async execute(args) {
        const t = await store.updateTask(db, String(args.task_id), args as Record<string, unknown>);
        if (!t) throw new Error(`Task not found: ${args.task_id}`);
        // Phase 6: completing a task cascades — dependent tasks re-evaluate their
        // blocked state (blocked → todo when ready) and deadline alerts reset
        let unblocked: string[] = [];
        if (t.status === 'done' || t.status === 'archived') {
          unblocked = await projects.cascadeUnblock(db, t.id);
          await clearDeadlineAlerts(db, t.id).catch(() => {});
        }
        return { id: t.id, status: t.status, unblocked_dependents: unblocked.length };
      },
    },
    {
      name: 'task.list',
      description: 'List tasks, optionally filtered by project id / status.',
      risk: 'low', scope: 'tasks:read',
      schema: { project_id: { type: 'string', required: false, description: 'Project filter' }, status: { type: 'string', required: false, description: 'Status filter' } },
      async execute(args) {
        const ts = await store.listTasks(db, { project_id: args.project_id ? String(args.project_id) : undefined, status: args.status ? String(args.status) : undefined, limit: 20 });
        return ts.map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, project_id: t.project_id }));
      },
    },
    {
      name: 'project.create',
      description: 'Create a project workspace.',
      risk: 'medium', scope: 'projects:write',
      schema: { name: { type: 'string', required: true, description: 'Project name' }, description: { type: 'string', required: false, description: 'What this project is about' } },
      async execute(args, ctx) {
        const p = await store.createProject(db, { name: String(args.name), description: String(args.description ?? ''), created_by: ctx.user_id });
        return { id: p.id, name: p.name, slug: p.slug };
      },
    },
    {
      name: 'task.depend',
      description: 'Declare that one task depends on another (must finish first). Enforces no self-dependency, duplicates, or cycles; auto-blocks the dependent task.',
      risk: 'medium', scope: 'tasks:write',
      schema: {
        task_id: { type: 'string', required: false, description: 'Id of the dependent task (the one that waits)' },
        depends_on: { type: 'string', required: false, description: 'Id of the task it waits on' },
        task_title: { type: 'string', required: false, description: 'Dependent task by title (resolved if ids absent)' },
        depends_on_title: { type: 'string', required: false, description: 'Dependency task by title (resolved if ids absent)' },
      },
      async execute(args, ctx) {
        // resolve by title when ids are absent (heuristic planner passes titles)
        const resolveTask = async (id?: string, title?: string): Promise<string | null> => {
          if (id) return String(id);
          if (title) {
            const t = (await store.listTasks(db, { limit: 500 })).find(x => x.title.toLowerCase() === String(title).toLowerCase());
            return t?.id ?? null;
          }
          return null;
        };
        const taskId = await resolveTask(args.task_id as string, args.task_title as string);
        const dependsOn = await resolveTask(args.depends_on as string, args.depends_on_title as string);
        if (!taskId || !dependsOn) throw new Error('could not resolve both tasks (pass ids or exact titles)');
        const r = await projects.addDependency(db, taskId, dependsOn);
        if (!r.ok) throw new Error(r.error);
        return { id: r.id, task_id: taskId, depends_on: dependsOn, blocked: true };
      },
    },
    {
      name: 'sprint.plan',
      description: 'Plan a sprint for a project: create the sprint, its tasks with priorities, and dependency edges between them. Returns a dependency-ordered schedule.',
      risk: 'medium', scope: 'projects:write',
      schema: {
        project_name: { type: 'string', required: true, description: 'Project name (created if missing)' },
        sprint_name: { type: 'string', required: false, description: 'Sprint name (default: "Sprint N")' },
        objective: { type: 'string', required: false, description: 'Sprint objective' },
        tasks_json: { type: 'string', required: true, description: 'JSON array of {title, description?, priority?, depends_on_titles?: string[]}' },
      },
      async execute(args, ctx) {
        // resolve project (create if missing — same convention as task.create)
        const existing = await store.findProjectByName(db, String(args.project_name));
        const project = existing ?? await store.createProject(db, { name: String(args.project_name), created_by: ctx.user_id });
        // parse the task plan (LLM planners pass JSON; heuristic passes pre-validated arrays)
        let tasks: any[];
        if (typeof args.tasks_json === 'string') {
          try { tasks = JSON.parse(args.tasks_json); } catch { throw new Error('tasks_json is not valid JSON'); }
        } else if (Array.isArray(args.tasks_json)) {
          tasks = args.tasks_json;
        } else {
          throw new Error('tasks_json must be a JSON array of task definitions');
        }
        if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks_json must contain at least one task');
        const plan = {
          project_id: project.id,
          name: String(args.sprint_name ?? `Sprint ${new Date().toISOString().slice(0, 10)}`),
          objective: String(args.objective ?? ''),
          tasks: tasks.slice(0, 12).map((t: any) => ({
            title: String(t.title ?? '').slice(0, 200),
            description: String(t.description ?? ''),
            priority: (['low', 'medium', 'high', 'urgent'].includes(t.priority) ? t.priority : 'medium'),
            depends_on_titles: Array.isArray(t.depends_on_titles) ? t.depends_on_titles.map(String) : [],
          })).filter((t: any) => t.title.length > 0),
        };
        if (plan.tasks.length === 0) throw new Error('no valid task definitions in tasks_json');
        const res = await projects.materializeSprintPlan(db, plan);
        return {
          sprint_id: res.sprint.id, sprint_name: res.sprint.name, project: project.name,
          tasks_created: res.tasks.length,
          blocked_by_dependencies: res.blocked_count,
          schedule: res.order.slice(0, 12).map(o => ({ task_id: o.task_id, level: o.level, depends_on: o.depends_on.length })),
          order: 'dependency-sorted (level 0 first, same-level tasks parallelizable)',
        };
      },
    },
    {
      name: 'http.fetch',
      description: 'Fetch a URL (GET) and return up to max_chars of text.',
      risk: 'medium', scope: 'net:fetch',
      schema: { url: { type: 'string', required: true, description: 'http(s) URL' }, max_chars: { type: 'number', required: false, description: 'Max characters (default 4000)' } },
      async execute(args) {
        const url = String(args.url);
        if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs allowed');
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 20000);
        try {
          const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'AgenticOS/0.1 (+local)' } });
          const text = (await res.text()).slice(0, Number(args.max_chars ?? 4000));
          return { status: res.status, url, content: text };
        } finally { clearTimeout(t); }
      },
    },
    {
      name: 'file.write',
      description: `Write a text file into the OS sandbox (data/sandbox). Paths are sandboxed.`,
      risk: 'medium', scope: 'files:write',
      schema: { path: { type: 'string', required: true, description: 'Relative sandbox path' }, content: { type: 'string', required: true, description: 'File content' } },
      async execute(args) {
        const p = sandboxPath(String(args.path));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args.content), 'utf8');
        return { written: true, path: path.relative(config.dataDir, p), bytes: Buffer.byteLength(String(args.content)) };
      },
    },
    {
      name: 'file.read',
      description: 'Read a text file from the OS sandbox.',
      risk: 'low', scope: 'files:read',
      schema: { path: { type: 'string', required: true, description: 'Relative sandbox path' } },
      async execute(args) {
        const p = sandboxPath(String(args.path));
        return { path: args.path, content: fs.readFileSync(p, 'utf8').slice(0, 10000) };
      },
    },
    {
      name: 'shell.run',
      description: 'Run a whitelisted shell command in the sandbox (requires AGENTIC_ALLOW_SHELL=1 AND human approval).',
      risk: 'high', scope: 'shell:exec',
      schema: { command: { type: 'string', required: true, description: 'Command to run' } },
      async execute(args) {
        if (!config.allowShell) throw new Error('shell.run disabled (set AGENTIC_ALLOW_SHELL=1 to enable)');
        const { execFile } = require('child_process') as typeof import('child_process');
        return new Promise((resolve) => {
          execFile('bash', ['-c', String(args.command)], { cwd: SANDBOX, timeout: 20000, windowsHide: true },
            (err, stdout, stderr) => resolve({
              exit_code: err ? (err as any).code ?? 1 : 0, stdout: String(stdout).slice(0, 4000), stderr: String(stderr).slice(0, 2000),
            }));
        });
      },
    },
    {
      name: 'notify',
      description: 'Send a notification to the user.',
      risk: 'medium', scope: 'notify:send',
      schema: { title: { type: 'string', required: true, description: 'Notification title' }, message: { type: 'string', required: true, description: 'Body' }, priority: { type: 'string', required: false, description: 'low|medium|high|urgent' } },
      async execute(args, ctx) {
        const n = await store.notify(db, {
          user_id: ctx.user_id, title: String(args.title), message: String(args.message),
          priority: (args.priority as any) ?? 'medium', category: 'agent', source: `agent:${ctx.agent.name}`,
          related_type: 'execution', related_id: ctx.execution_id,
        });
        return { id: n.id };
      },
    },
    {
      name: 'calc.eval',
      description: 'Evaluate a arithmetic expression safely (numbers and + - * / ( ) . % only).',
      risk: 'low', scope: 'calc',
      schema: { expression: { type: 'string', required: true, description: 'e.g. (12 + 3) * 4' } },
      async execute(args) {
        const expr = String(args.expression);
        if (!/^[\d\s+\-*/().%]+$/.test(expr)) throw new Error('Expression contains disallowed characters');
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict"; return (${expr});`)();
        if (typeof val !== 'number' || !Number.isFinite(val)) throw new Error('Not a finite number');
        return { expression: expr, value: val };
      },
    },
    {
      name: 'sys.info',
      description: 'Get OS kernel info (counts, providers, uptime).',
      risk: 'low', scope: 'system:read',
      schema: {},
      async execute() {
        const counts = await healthCounts(db);
        return { version: config.version, platform: `${os.platform()}/${os.arch()}`, counts };
      },
    },
    {
      name: 'agent.delegate',
      description: 'Delegate a subtask to another registered agent. Returns the child execution result (parent waits). Depth-limited.',
      risk: 'medium', scope: 'agents:delegate',
      schema: {
        agent_name: { type: 'string', required: true, description: 'Target agent name (e.g. Coder, Researcher)' },
        task: { type: 'string', required: true, description: 'The subtask instruction for the agent' },
      },
      async execute(args, ctx) {
        if (!runtimeRef) throw new Error('Runtime not wired');
        const target = await store.getAgentByName(db, String(args.agent_name));
        if (!target) throw new Error(`Agent not found: ${args.agent_name}`);
        if (target.id === ctx.agent.id) throw new Error('Cannot delegate to self');
        // depth guard — prevent runaway delegation chains/cycles
        const childDepth = ctx.depth + 1;
        if (childDepth > config.maxDelegationDepth) {
          throw new Error(`Delegation depth limit (${config.maxDelegationDepth}) exceeded`);
        }
        const childExec = await runtimeRef.run({
          agent: target, input: String(args.task), user_id: ctx.user_id,
          extras: { depth: childDepth, parentExecId: ctx.execution_id ?? undefined },
        });
        // wait for the child to reach a terminal state (poll; children are short-lived)
        const deadline = Date.now() + 5 * 60 * 1000;
        let child = await store.getExecution(db, childExec.id);
        while (child && !['completed', 'failed', 'cancelled'].includes(child.status) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 300));
          child = await store.getExecution(db, childExec.id);
        }
        return {
          child_execution_id: childExec.id,
          agent: target.name,
          status: child?.status ?? 'timeout',
          result: child?.result?.slice(0, 2000) ?? null,
          error: child?.error ?? null,
        };
      },
    },
    {
      name: 'agent.message',
      description: 'Send an async message to another agent. Injected into the target\'s next planning context.',
      risk: 'low', scope: 'agents:message',
      schema: {
        agent_name: { type: 'string', required: true, description: 'Target agent name' },
        content: { type: 'string', required: true, description: 'Message content' },
      },
      async execute(args, ctx) {
        const target = await store.getAgentByName(db, String(args.agent_name));
        if (!target) throw new Error(`Agent not found: ${args.agent_name}`);
        const msg = await store.createAgentMessage(db, {
          from_agent_id: ctx.agent.id, to_agent_id: target.id,
          execution_id: ctx.execution_id, content: String(args.content),
        });
        return { message_id: msg.id, to: target.name };
      },
    },
  ];
  return tools;
}

async function healthCounts(db: DataPort) {
  const one = async (sql: string) => Number((await db.query<any>(sql))[0]?.n ?? 0);
  return {
    agents: await one('SELECT COUNT(*) AS n FROM agents'),
    executions: await one('SELECT COUNT(*) AS n FROM executions'),
    memories: await one('SELECT COUNT(*) AS n FROM memories'),
    tasks: await one('SELECT COUNT(*) AS n FROM tasks'),
    projects: await one('SELECT COUNT(*) AS n FROM projects'),
    generations: await one('SELECT COUNT(*) AS n FROM generations'),
    events: await one('SELECT COUNT(*) AS n FROM events'),
  };
}

export { SANDBOX };
