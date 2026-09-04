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
      description: 'Update a task by id (status, priority, title, ...).',
      risk: 'medium', scope: 'tasks:write',
      schema: { task_id: { type: 'string', required: true, description: 'Task id' }, status: { type: 'string', required: false, description: 'todo|in_progress|blocked|done|archived' } },
      async execute(args) {
        const t = await store.updateTask(db, String(args.task_id), args as Record<string, unknown>);
        if (!t) throw new Error(`Task not found: ${args.task_id}`);
        return { id: t.id, status: t.status };
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
