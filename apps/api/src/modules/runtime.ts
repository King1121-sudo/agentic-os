/**
 * Agent Runtime (§5, §6) — the kernel execution pipeline:
 *   EVENT → CONTEXT RESOLVER → MEMORY RETRIEVAL → PLANNER → STEPS (tool/skill/model)
 *   → OBSERVATION → RESULT → MEMORY UPDATE → EVENT → NOTIFICATION
 * Every step is traced, persisted (checkpointed), auditable, and controllable
 * (pause/resume/stop/approve). Approvals suspend the execution and are resumed
 * by the human decision (API) — with a timeout that fails the step safely.
 */
import type { DataPort, BrokerPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import { EventBus } from '../kernel/bus';
import type { ModelRouter } from '../gateway/router';
import type { ToolRegistry, ToolDef } from './tools';
import { recordToolExecution } from './tools';
import { evaluateGate, type ToolContext } from '../kernel/types';
import * as store from './store';
import { resolveSkillChain, requiredToolsFor, recordSkillExecution } from './skills';
import { searchMemory, createMemory } from './memory';
import { config } from '../config';
import type {
  AgentRecord, ExecutionRecord, Plan, PlanStep, TraceEntry, Observation,
} from '@agentic/contracts';

type StepOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Extra runtime context threaded through executions (Phase 3). */
export interface RunExtras {
  depth: number;               // delegation nesting depth (0 = top-level)
  parentExecId?: string;       // set for delegated child executions
  resumedFrom?: number;       // checkpoint: step index to resume from (inclusive)
  resumedObservations?: Observation[];
  resumedTrace?: TraceEntry[];
  skipPlanning?: boolean;      // resume: reuse the persisted plan
}

export class AgentRuntime {
  private control = new Map<string, { pause: boolean; stop: boolean; waiter: ((v: 'approved' | 'denied' | 'timeout') => void) | null }>();
  /** Phase 2: abort controllers for in-flight generations, per execution. */
  private aborts = new Map<string, Set<AbortController>>();

  constructor(
    private db: DataPort,
    private broker: BrokerPort,
    private bus: EventBus,
    private router: ModelRouter,
    private tools: ToolRegistry,
  ) {}

  // ─── lifecycle ───────────────────────────────────────────────────────────
  async run(opts: {
    agent: AgentRecord; input: string; user_id: string;
    project_id?: string | null; task_id?: string | null; autonomy_override?: number;
    extras?: RunExtras; skill?: string;
  }): Promise<ExecutionRecord> {
    const { agent, input } = opts;
    const extras = opts.extras ?? { depth: 0 };
    const execId = uuid();
    const startedAt = iso();

    await store.insertExecution(this.db, {
      id: execId, agent_id: agent.id, user_id: opts.user_id, input, project_id: opts.project_id ?? null,
      task_id: opts.task_id ?? null, status: 'running', observations: [], trace: [],
      started_at: startedAt, parent_execution_id: extras.parentExecId ?? null,
    });
    // delegation graph: parent → child link
    if (extras.parentExecId) {
      await store.createLink(this.db, {
        from_type: 'execution', from_id: extras.parentExecId,
        to_type: 'execution', to_id: execId, relation: 'delegated_to',
      }).catch(() => {});
    }
    await store.setAgentStatus(this.db, agent.id, 'thinking');
    this.control.set(execId, { pause: false, stop: false, waiter: null });
    await this.bus.emit('agent.started', {
      execution_id: execId, agent: agent.name, input: input.slice(0, 200),
      delegated_by: extras.parentExecId ?? undefined, depth: extras.depth,
    },
      { actor_type: 'agent', actor_id: agent.id, target_type: 'execution', target_id: execId });
    await store.audit(this.db, { actor_type: 'agent', actor_id: agent.id, action: 'execution.start', execution_id: execId, meta: { input: input.slice(0, 300), depth: extras.depth } });

    // fire-and-forget; state machine drives itself to a terminal state
    this.drive(opts, execId).catch(async (e) => {
      await this.finish(execId, 'failed', null, String(e?.message ?? e), agent);
    });
    return (await store.getExecution(this.db, execId))!;
  }

  private async drive(opts: {
    agent: AgentRecord; input: string; user_id: string; project_id?: string | null; task_id?: string | null;
    autonomy_override?: number; extras?: RunExtras; skill?: string;
  }, execId: string): Promise<void> {
    const { agent, input } = opts;
    const extras = opts.extras ?? { depth: 0 };
    const trace: TraceEntry[] = extras.resumedTrace ? [...extras.resumedTrace] : [];
    const observations: Observation[] = extras.resumedObservations ? [...extras.resumedObservations] : [];
    const push = (entry: TraceEntry) => { trace.push(entry); };
    const persist = () => store.updateExecution(this.db, execId, { trace: JSON.stringify(trace), observations: JSON.stringify(observations) });

    const emitTrace = async (entry: TraceEntry) => {
      push(entry); await persist();
      await this.bus.emit('agent.thinking', { execution_id: execId, agent: agent.name, kind: entry.kind, message: entry.message },
        { actor_type: 'agent', actor_id: agent.id, target_type: 'execution', target_id: execId }).catch(() => {});
    };

    // Phase 2: throttled volatile token stream → SSE (never persisted)
    // (class-level helper — see makeTokenPump)

    try {
      // 1) CONTEXT RESOLVER — resolve project + task context
      let project: any = null;
      if (opts.project_id) project = await store.getProject(this.db, opts.project_id);

      // 1b) AGENT MAILBOX (Phase 3) — pending peer messages inject into context
      const mailbox = await store.pendingMessagesFor(this.db, agent.id, true).catch(() => []);
      if (mailbox.length) {
        push({ ts: iso(), kind: 'state', message: `Received ${mailbox.length} agent message(s)`, data: { from: mailbox.map(m => m.from_agent_id) } });
      }
      push({ ts: iso(), kind: 'state', message: `Context resolved${project ? ` (project: ${project.name})` : ''}` });

      // 2) MEMORY RETRIEVAL
      let memories: any[] = [];
      if (agent.memory_policy.read) {
        memories = await searchMemory(this.db, {
          user_id: opts.user_id, query: input, k: agent.memory_policy.k,
          types: agent.memory_policy.types?.length ? agent.memory_policy.types : undefined,
          project_id: opts.project_id ?? null,
        });
        push({ ts: iso(), kind: 'memory', message: `Retrieved ${memories.length} memories`, data: memories.map(m => m.id) });
      }

      // 3) PLANNER — resumed executions reuse the persisted plan (checkpoint);
      //    a direct skill request skips planning entirely (skill step + synthesis)
      let plan: Plan;
      if ((opts as any).skill) {
        plan = {
          rationale: `Direct execution of skill "${(opts as any).skill}"`,
          steps: [
            { kind: 'skill', skill: (opts as any).skill, args: {} },
            { kind: 'model', capability: 'reasoning', prompt: 'Synthesize the skill results for the user.', input_from: 'all' },
          ],
        };
        await store.updateExecution(this.db, execId, { plan: JSON.stringify(plan) });
        push({ ts: iso(), kind: 'plan', message: plan.rationale, data: { steps: plan.steps.length } });
      } else if (extras.skipPlanning) {
        const existing = await store.getExecution(this.db, execId);
        plan = (existing?.plan as Plan) ?? {
          rationale: 'Resumed without a persisted plan; falling back to reasoning',
          steps: [{ kind: 'model', capability: 'reasoning', prompt: 'Answer directly.', input_from: 'all' }],
        };
        push({ ts: iso(), kind: 'state', message: `Resumed from checkpoint at step ${extras.resumedFrom! + 1} (plan reused)` });
        await this.bus.emit('execution.resumed', { execution_id: execId, agent: agent.name, from_step: (extras.resumedFrom ?? 0) + 1 },
          { actor_type: 'user', target_type: 'execution', target_id: execId }).catch(() => {});
      } else {
        await store.setAgentStatus(this.db, agent.id, 'planning');
        await this.bus.emit('agent.thinking', { execution_id: execId, agent: agent.name, phase: 'planning' },
          { actor_type: 'agent', actor_id: agent.id, target_type: 'execution', target_id: execId }).catch(() => {});
        const planPrompt = [
          agent.system_instructions || 'You are an agent in the Agentic OS. Create a short plan.',
          `User request: ${input}`,
          project ? `Project context: ${project.name} — ${project.description}` : '',
          mailbox.length ? `Messages from other agents:\n${mailbox.map(m => `- ${m.content.slice(0, 200)}`).join('\n')}` : '',
          memories.length ? `Relevant memories:\n${memories.map(m => `- (${m.type}) ${m.summary}`).join('\n')}` : '',
          `Produce a plan with the available tools: ${agent.tools.join(', ')}.`,
        ].filter(Boolean).join('\n\n');
        const planResp = await this.router.generate(
          { capability: 'planning', system: PLANNER_SYSTEM, prompt: planPrompt, hint: { user_input: input, tools: agent.tools, memories: memories.map(m => m.id) } },
          { agent_id: agent.id, execution_id: execId, preference: agent.model_policy.preference },
        );
        plan = planResp.plan ?? {
          rationale: 'Fallback plan (planner returned no structured plan)',
          steps: [{ kind: 'model', capability: 'reasoning', prompt: 'Answer the request directly.', input_from: 'all' }],
        };
        await store.updateExecution(this.db, execId, { plan: JSON.stringify(plan), tokens_in: planResp.input_tokens, tokens_out: planResp.output_tokens });
        await this.bus.emit('plan.created', { execution_id: execId, agent: agent.name, rationale: plan.rationale, steps: plan.steps.length },
          { actor_type: 'agent', actor_id: agent.id, target_type: 'execution', target_id: execId });
        await emitTrace({ ts: iso(), kind: 'plan', message: plan.rationale, data: { steps: plan.steps.length, model: planResp.model_id } });
      }

      // 4) STEP EXECUTION LOOP (resume-aware, retry with backoff)
      await store.setAgentStatus(this.db, agent.id, 'executing');
      const ctx: ToolContext = {
        execution_id: execId, agent, user_id: opts.user_id, depth: extras.depth,
        emit: emitTrace, observe: (o) => { observations.push(o); },
      };
      const startStep = extras.skipPlanning ? (extras.resumedFrom ?? 0) : 0;

      for (let i = startStep; i < plan.steps.length; i++) {
        // control checks between every step
        const ctl = this.control.get(execId);
        if (ctl?.stop) { await this.finish(execId, 'cancelled', null, 'Stopped by user', agent); return; }
        while (ctl?.pause) {
          await store.setAgentStatus(this.db, agent.id, 'paused');
          await store.updateExecution(this.db, execId, { status: 'paused' });
          await this.bus.emit('agent.paused', { execution_id: execId, agent: agent.name }, { actor_type: 'user', target_type: 'execution', target_id: execId }).catch(() => {});
          await sleep(500);
          if (this.control.get(execId)?.stop) { await this.finish(execId, 'cancelled', null, 'Stopped by user', agent); return; }
          if (!this.control.get(execId)?.pause) break;
        }
        await store.setAgentStatus(this.db, agent.id, 'executing');
        await store.updateExecution(this.db, execId, { current_step: i + 1, status: 'running' });

        const step = plan.steps[i];
        await this.bus.emit('agent.executing', { execution_id: execId, agent: agent.name, step: i + 1, total: plan.steps.length, kind: step.kind },
          { actor_type: 'agent', actor_id: agent.id, target_type: 'execution', target_id: execId }).catch(() => {});

        // Phase 3: retry with exponential backoff (250ms * 2^n). User-initiated
        // aborts and cancellations are never retried.
        let outcome: StepOutcome | null = null;
        let attempt = 0;
        const maxAttempts = 1 + Math.max(0, config.stepRetries);
        while (attempt < maxAttempts) {
          outcome = await this.executeStep(step, opts, execId, ctx, trace, observations, i);
          if (outcome.ok) break;
          const aborted = this.control.get(execId)?.stop || /abort/i.test(outcome.error);
          if (aborted || attempt >= maxAttempts - 1) break;
          const backoff = 250 * Math.pow(2, attempt);
          trace.push({ ts: iso(), kind: 'error', message: `Step ${i + 1} failed (attempt ${attempt + 1}/${maxAttempts}): ${outcome.error.slice(0, 140)} — retrying in ${backoff}ms` });
          await persist();
          await sleep(backoff);
          attempt++;
        }
        const result = outcome!;

        if (!result.ok) {
          // Phase 2: a user-initiated abort mid-generation surfaces as 'aborted' —
          // that is a CANCELLATION, not a failure.
          if (this.control.get(execId)?.stop || /abort/i.test(result.error)) {
            await this.finish(execId, 'cancelled', null, 'Stopped by user', agent);
            return;
          }
          // failure recovery: notify + fail execution
          await store.notify(this.db, {
            user_id: opts.user_id, title: `Agent ${agent.name} failed`, message: result.error.slice(0, 300),
            priority: 'high', category: 'agent', source: 'runtime', related_type: 'execution', related_id: execId,
          });
          await this.finish(execId, 'failed', null, result.error, agent);
          return;
        }
        observations.push({ step: i + 1, source: step.kind, summary: summarizeOutcome(result.result), data: result.result as any });
        await persist();
      }

      // 5) RESULT — final synthesis (streamed live to the UI)
      const synthPump = this.makeTokenPump(execId, agent, 'synthesis');
      const synthCtl = new AbortController();
      this.trackAbort(execId, synthCtl);
      let finalResp;
      try {
        finalResp = await this.router.generateStream(
          {
            capability: 'writing', system: agent.system_instructions || 'You are an agent in the Agentic OS. Summarize what you did clearly and concisely.',
            prompt: [
              `Original request: ${input}`,
              `Plan rationale: ${plan.rationale}`,
              `Observations:`,
              ...observations.map((o, n) => `${n + 1}. [${o.source}] ${JSON.stringify(o.data).slice(0, 500)}`),
              `Write the final answer for the user: what was done, what was created, ids if any.`,
            ].join('\n'),
          },
          async (d) => { await synthPump.push(d); },
          { agent_id: agent.id, execution_id: execId, preference: agent.model_policy.preference },
          synthCtl.signal,
        );
      } finally {
        this.untrackAbort(execId, synthCtl);
        await synthPump.end();
      }
      const result = finalResp.text;
      push({ ts: iso(), kind: 'result', message: result.slice(0, 300), data: { model: finalResp.model_id } });

      // 6) MEMORY UPDATE (episodic)
      if (agent.memory_policy.write) {
        await createMemory(this.db, {
          user_id: opts.user_id, type: 'episodic',
          content: `Agent ${agent.name} handled request "${input.slice(0, 160)}" → ${result.slice(0, 160)}`,
          importance: 4, source: `agent:${agent.name}`, source_id: execId, project_id: opts.project_id ?? null,
        }).catch(() => {});
      }

      // 7) tokens/cost rollup
      const exec = await store.getExecution(this.db, execId);
      await store.updateExecution(this.db, execId, {
        tokens_in: (exec?.tokens_in ?? 0) + finalResp.input_tokens,
        tokens_out: (exec?.tokens_out ?? 0) + finalResp.output_tokens,
      });

      await this.finish(execId, 'completed', result, null, agent);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // user-initiated abort → cancellation semantics, not failure
      const cancelled = (e as any)?.aborted || this.control.get(execId)?.stop || /abort/i.test(msg);
      await this.finish(execId, cancelled ? 'cancelled' : 'failed', null, cancelled ? 'Stopped by user' : msg, agent);
    }
  }

  /** Execute one plan step (tool | model | skill) with full gating. */
  private async executeStep(
    step: PlanStep, opts: { agent: AgentRecord; input: string; user_id: string; autonomy_override?: number },
    execId: string, ctx: ToolContext, trace: TraceEntry[], observations: Observation[], stepIndex: number,
  ): Promise<StepOutcome> {
    if (step.kind === 'model') {
      const pump = this.makeTokenPump(execId, ctx.agent, `model:${step.capability ?? 'reasoning'}`);
      const ctl = new AbortController();
      this.trackAbort(execId, ctl);
      let resp;
      try {
        resp = await this.router.generateStream(
          { capability: step.capability ?? 'reasoning', system: ctx.agent.system_instructions, prompt: step.prompt || opts.input, hint: observations.length ? observations.slice(-3) : undefined },
          async (d) => { await pump.push(d); },
          { agent_id: ctx.agent.id, execution_id: execId, preference: ctx.agent.model_policy.preference },
          ctl.signal,
        );
      } finally {
        this.untrackAbort(execId, ctl);
        await pump.end();
      }
      trace.push({ ts: iso(), kind: 'model', message: `Model ${resp.model_id}: ${resp.text.slice(0, 160)}`, data: { model: resp.model_id, tokens: resp.output_tokens } });
      return { ok: true, result: { text: resp.text, model: resp.model_id } };
    }

    if (step.kind === 'skill') {
      const skill = await store.getSkill(this.db, step.skill);
      if (!skill) return { ok: false, error: `Skill not found: ${step.skill}` };

      // Phase 4: permission precheck across the whole inheritance chain — the
      // agent must hold every tool any step (inherited or own) requires.
      const all = await store.listSkills(this.db);
      const byName = new Map(all.map(s => [s.name, s]));
      const chain = resolveSkillChain(byName, skill);
      const needed = requiredToolsFor(byName, skill);
      const missing = needed.filter(t => !ctx.agent.tools.includes(t));
      const t0 = Date.now();
      if (missing.length > 0) {
        await recordSkillExecution(this.db, {
          skill_id: skill.id, skill_version: skill.version, execution_id: execId,
          agent_id: ctx.agent.id, status: 'denied', latency_ms: Date.now() - t0,
          error: `Agent lacks tools: ${missing.join(', ')}`,
        });
        await this.bus.emit('skill.denied', { execution_id: execId, skill: skill.name, missing },
          { actor_type: 'system', target_type: 'skill', target_id: skill.id }).catch(() => {});
        return { ok: true, result: { denied: true, reason: `Agent lacks tools for skill chain: ${missing.join(', ')}`, skill: skill.name } };
      }

      // run the RESOLVED chain (parent steps first), each through the same machinery
      const out: unknown[] = [];
      for (const s of chain.steps) {
        const r = await this.executeStep(s as PlanStep, opts, execId, ctx, trace, observations, stepIndex);
        if (!r.ok) {
          await recordSkillExecution(this.db, {
            skill_id: skill.id, skill_version: skill.version, execution_id: execId,
            agent_id: ctx.agent.id, status: 'failed', latency_ms: Date.now() - t0, error: r.error,
          });
          return r;
        }
        out.push(r.result);
      }
      await recordSkillExecution(this.db, {
        skill_id: skill.id, skill_version: skill.version, execution_id: execId,
        agent_id: ctx.agent.id, status: 'completed', latency_ms: Date.now() - t0,
      });
      await this.bus.emit('skill.executed', { execution_id: execId, skill: skill.name, chain: chain.chain, steps: chain.steps.length, version: skill.version },
        { actor_type: 'skill', target_type: 'skill', target_id: skill.id }).catch(() => {});
      trace.push({ ts: iso(), kind: 'skill', message: `Skill ${skill.name} v${skill.version} executed (${chain.steps.length} steps, chain: ${chain.chain.join(' → ')})` });
      return { ok: true, result: { skill: skill.name, version: skill.version, chain: chain.chain, outputs: out } };
    }

    // tool step
    const tool: ToolDef | undefined = this.tools.get(step.tool!);
    if (!tool) return { ok: false, error: `Unknown tool: ${step.tool}` };
    // Phase 4: args_from — pull arg values from the execution's raw input
    let args = (step.args ?? {}) as Record<string, unknown>;
    if ((step as any).args_from) {
      const src = (step as any).args_from as 'input' | 'url' | 'query';
      const input = opts.input;
      if (src === 'url') {
        const url = /https?:\/\/\S+/i.exec(input)?.[0];
        if (url) args = { ...args, url };
      } else if (src === 'input') {
        args = { ...args, content: input, query: input, task: input, expression: input, title: input, message: input };
      } else if (src === 'query') {
        const q = input.replace(/^.*?(?:on|about|for|query)\s+/i, '').trim() || input;
        args = { ...args, query: q, content: q };
      }
    }

    // SECURITY GATE
    const decision = evaluateGate(ctx.agent, tool, args, opts.autonomy_override);
    if (!decision.allowed) {
      await recordToolExecution(this.db, { execution_id: execId, agent_id: ctx.agent.id, tool: tool.name, args, result: null, risk: tool.risk, status: 'denied', error: decision.reason, latency_ms: 0 });
      await this.bus.emit('tool.denied', { execution_id: execId, tool: tool.name, reason: decision.reason }, { actor_type: 'system', target_type: 'execution', target_id: execId });
      await store.audit(this.db, { actor_type: 'system', action: 'tool.denied', target_type: 'tool', target_id: tool.name, execution_id: execId, meta: { reason: decision.reason } });
      return { ok: true, result: { denied: true, reason: decision.reason, tool: tool.name } }; // denial is an observation, not a crash
    }

    // APPROVAL GATE
    if (decision.needsApproval) {
      const approved = await this.requestApproval(execId, ctx.agent, tool.name, args, decision.reason, opts.user_id);
      if (approved !== 'approved') {
        await recordToolExecution(this.db, { execution_id: execId, agent_id: ctx.agent.id, tool: tool.name, args, result: null, risk: tool.risk, status: 'denied', error: `approval ${approved}`, latency_ms: 0 });
        return { ok: true, result: { denied: true, reason: `Human ${approved} the action`, tool: tool.name } };
      }
    }

    // EXECUTE
    const t0 = Date.now();
    try {
      const result = await tool.execute(args, ctx);
      const latency = Date.now() - t0;
      await recordToolExecution(this.db, { execution_id: execId, agent_id: ctx.agent.id, tool: tool.name, args, result, risk: tool.risk, status: 'ok', latency_ms: latency });
      await this.bus.emit('tool.executed', { execution_id: execId, tool: tool.name, risk: tool.risk, latency_ms: latency, summary: summarizeOutcome(result) },
        { actor_type: 'tool', target_type: 'execution', target_id: execId });
      await store.audit(this.db, { actor_type: 'agent', actor_id: ctx.agent.id, action: `tool.${tool.name}`, target_type: 'tool', target_id: tool.name, execution_id: execId, meta: { args, risk: tool.risk } });
      trace.push({ ts: iso(), kind: 'tool', message: `${tool.name} → ${summarizeOutcome(result)}`, data: { latency_ms: latency } });
      return { ok: true, result };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const latency = Date.now() - t0;
      await recordToolExecution(this.db, { execution_id: execId, agent_id: ctx.agent.id, tool: tool.name, args, result: null, risk: tool.risk, status: 'error', error: msg, latency_ms: latency });
      await this.bus.emit('tool.failed', { execution_id: execId, tool: tool.name, error: msg }, { actor_type: 'tool', target_type: 'execution', target_id: execId }).catch(() => {});
      return { ok: false, error: `Tool ${tool.name} failed: ${msg}` };
    }
  }

  /** Human-in-the-loop approval: suspends execution until decided or timeout. */
  private async requestApproval(execId: string, agent: AgentRecord, tool: string, args: unknown, reason: string, userId: string): Promise<'approved' | 'denied' | 'timeout'> {
    const approval = await store.createApproval(this.db, { execution_id: execId, agent_id: agent.id, tool, args, reason });
    await store.updateExecution(this.db, execId, { status: 'approval_required' });
    await store.setAgentStatus(this.db, agent.id, 'approval_required');
    await this.bus.emit('approval.requested', { approval_id: approval.id, execution_id: execId, agent: agent.name, tool, reason },
      { actor_type: 'agent', actor_id: agent.id, target_type: 'approval', target_id: approval.id });
    const notification = await store.notify(this.db, {
      user_id: userId, title: `Approval needed: ${tool}`,
      message: `Agent ${agent.name} wants to run "${tool}". ${reason}`,
      priority: 'high', category: 'approval', source: 'runtime',
      related_type: 'approval', related_id: approval.id,
    });
    await this.bus.emit('notification.created', { id: notification.id, title: notification.title }, { actor_type: 'system', target_type: 'notification', target_id: notification.id });

    return new Promise<'approved' | 'denied' | 'timeout'>((resolve) => {
      const ctl = this.control.get(execId)!;
      ctl.waiter = resolve;
      const timer = setTimeout(() => {
        if (ctl.waiter === resolve) { ctl.waiter = null; resolve('timeout'); }
      }, config.approvalTimeoutS * 1000);
      // cleanup on decision via resolveApproval()
      const origResolve = resolve;
      this.approvalWaiters.set(approval.id, { resolve: (v) => { clearTimeout(timer); origResolve(v); } });
    });
  }
  private approvalWaiters = new Map<string, { resolve: (v: 'approved' | 'denied' | 'timeout') => void }>();

  /** Called by the API when the human decides an approval. */
  async resolveApproval(approvalId: string, decision: 'approve' | 'deny', userId: string): Promise<boolean> {
    const rows = await this.db.query<any>('SELECT * FROM approvals WHERE id = ?', [approvalId]);
    const appr = rows[0];
    if (!appr || appr.status !== 'pending') return false;
    await store.decideApproval(this.db, approvalId, decision, userId);
    const waiter = this.approvalWaiters.get(approvalId);
    this.approvalWaiters.delete(approvalId);
    const execId = appr.execution_id;
    await this.bus.emit('approval.decided', { approval_id: approvalId, decision, execution_id: execId },
      { actor_type: 'user', actor_id: userId, target_type: 'approval', target_id: approvalId });
    await store.audit(this.db, { actor_type: 'user', actor_id: userId, action: `approval.${decision}`, execution_id: execId, meta: { tool: appr.tool } });
    if (waiter) waiter.resolve(decision === 'approve' ? 'approved' : 'denied');
    // resume execution state
    await store.updateExecution(this.db, execId, { status: 'running' });
    const agentRow = await store.getAgent(this.db, appr.agent_id);
    if (agentRow) await store.setAgentStatus(this.db, agentRow.id, 'executing');
    return true;
  }

  // ─── controls ──────────────────────────────────────────────────────────────
  /** Phase 2: throttled volatile token pump — batches token deltas into
   *  agent.token SSE events (≥24 chars or 120ms) without persisting. */
  private makeTokenPump(execId: string, agent: AgentRecord, label: string) {
    let buf = '';
    let lastFlush = 0;
    const flush = async () => {
      if (!buf) return;
      const out = buf; buf = '';
      lastFlush = Date.now();
      await this.bus.emitVolatile('agent.token', { execution_id: execId, agent: agent.name, phase: label, delta: out },
        { actor_type: 'agent', actor_id: agent.id }).catch(() => {});
    };
    return {
      push: async (delta: string) => {
        buf += delta;
        if (buf.length >= 24 || Date.now() - lastFlush > 120) await flush();
      },
      end: flush,
    };
  }

  /** Phase 2: register/unregister in-flight generation aborts for an execution. */
  private trackAbort(execId: string, ctl: AbortController): void {
    if (!this.aborts.has(execId)) this.aborts.set(execId, new Set());
    this.aborts.get(execId)!.add(ctl);
  }
  private untrackAbort(execId: string, ctl: AbortController): void {
    this.aborts.get(execId)?.delete(ctl);
  }
  /** Abort all in-flight generations for an execution (used by stop()). */
  private abortAll(execId: string): void {
    for (const ctl of this.aborts.get(execId) ?? []) { try { ctl.abort(); } catch { /* already */ } }
    this.aborts.delete(execId);
  }

  async pause(execId: string): Promise<boolean> {
    const ex = await store.getExecution(this.db, execId);
    if (!ex || !['running', 'approval_required'].includes(ex.status)) return false;
    this.control.get(execId)!.pause = true;
    await store.updateExecution(this.db, execId, { status: 'paused' });
    const agent = await store.getAgent(this.db, ex.agent_id);
    if (agent) await store.setAgentStatus(this.db, agent.id, 'paused');
    await this.bus.emit('agent.paused', { execution_id: execId }, { actor_type: 'user', target_type: 'execution', target_id: execId });
    return true;
  }
  async resume(execId: string): Promise<boolean> {
    const ex = await store.getExecution(this.db, execId);
    if (!ex || ex.status !== 'paused') return false;
    this.control.get(execId)!.pause = false;
    await store.updateExecution(this.db, execId, { status: 'running' });
    const agent = await store.getAgent(this.db, ex.agent_id);
    if (agent) await store.setAgentStatus(this.db, agent.id, 'executing');
    await this.bus.emit('agent.resumed', { execution_id: execId }, { actor_type: 'user', target_type: 'execution', target_id: execId });
    return true;
  }
  async stop(execId: string): Promise<boolean> {
    const ex = await store.getExecution(this.db, execId);
    if (!ex || ['completed', 'failed', 'cancelled'].includes(ex.status)) return false;
    const ctl = this.control.get(execId);
    if (ctl) { ctl.stop = true; ctl.pause = false; ctl.waiter?.('denied'); }
    this.abortAll(execId); // Phase 2: kill in-flight generations immediately
    // Phase 3: cascade to delegated children (execution graph)
    const children = await this.db.query<any>(
      "SELECT id FROM executions WHERE parent_execution_id = ? AND status IN ('running','paused','approval_required')",
      [execId],
    );
    for (const c of children) { await this.stop(c.id).catch(() => {}); }
    return true;
  }

  // ─── checkpoint resume (Phase 3) ─────────────────────────────────────────────
  /** Resume an interrupted/paused execution from its persisted checkpoint.
   *  Reuses the saved plan, observations and trace; continues at current_step.
   *  NOTE on semantics: already-completed steps are NOT re-executed — a step
   *  that was mid-flight when the process died will re-run (at-least-once).
   *  Approval-gated steps re-request approval on resume. */
  async resumeExecution(execId: string): Promise<ExecutionRecord | null> {
    const ex = await store.getExecution(this.db, execId);
    if (!ex) return null;
    if (!['paused', 'interrupted'].includes(ex.status)) return ex;
    const agent = await store.getAgent(this.db, ex.agent_id);
    if (!agent) return null;
    // resume from the persisted step marker; completed observations are kept
    const resumeFrom = Math.max(0, ex.current_step - 1); // current_step is 1-based; the step it was ON may re-run
    this.control.set(execId, { pause: false, stop: false, waiter: null });
    await store.updateExecution(this.db, execId, { status: 'running' });
    await store.setAgentStatus(this.db, agent.id, 'executing');
    this.drive(
      {
        agent, input: ex.input, user_id: ex.user_id, project_id: ex.project_id ?? null,
        task_id: ex.task_id ?? null,
        extras: {
          depth: 0, resumedFrom: resumeFrom, skipPlanning: true,
          resumedObservations: ex.observations, resumedTrace: ex.trace,
        },
      },
      execId,
    ).catch(async (e) => {
      await this.finish(execId, 'failed', null, String(e?.message ?? e), agent);
    });
    return store.getExecution(this.db, execId);
  }

  /** Boot-time recovery: executions left 'running'/'approval_required' by a dead
   *  process are marked 'interrupted' (resumable via POST /executions/:id/resume
   *  or the Activity panel). At-least-once: a step mid-flight at crash time
   *  re-runs on resume. */
  async recoverInterrupted(): Promise<number> {
    const rows = await this.db.query<any>(
      "SELECT id, agent_id FROM executions WHERE status IN ('running', 'approval_required')",
    );
    for (const r of rows) {
      await store.updateExecution(this.db, r.id, { status: 'interrupted' });
      await store.setAgentStatus(this.db, r.agent_id, 'idle');
      await this.bus.emit('execution.interrupted', { execution_id: r.id, reason: 'process restart' },
        { actor_type: 'system', target_type: 'execution', target_id: r.id }).catch(() => {});
      // deny any approval that was pending on the dead execution
      await this.db.run(
        "UPDATE approvals SET status = 'timeout', decided_at = ? WHERE execution_id = ? AND status = 'pending'",
        [iso(), r.id],
      ).catch(() => {});
    }
    return rows.length;
  }

  private async finish(execId: string, status: ExecutionRecord['status'], result: string | null, error: string | null, agent: AgentRecord): Promise<void> {
    this.control.delete(execId);
    await store.updateExecution(this.db, execId, { status, result, error, completed_at: iso() });
    const agentStatus = status === 'completed' ? 'idle' : status === 'failed' ? 'idle' : 'idle';
    await store.setAgentStatus(this.db, agent.id, agentStatus);
    const eventType = status === 'completed' ? 'agent.completed' : status === 'failed' ? 'agent.failed' : status === 'cancelled' ? 'agent.stopped' : 'agent.completed';
    await this.bus.emit(eventType as any, { execution_id: execId, agent: agent.name, result: result?.slice(0, 400) ?? null, error },
      { actor_type: 'agent', actor_id: agent.id, target_type: 'execution', target_id: execId });
    await store.audit(this.db, { actor_type: 'agent', actor_id: agent.id, action: `execution.${status}`, execution_id: execId, meta: {} });
    // completion notification (skip for cancelled — quiet)
    if (status === 'completed' || status === 'failed') {
      const ex = await store.getExecution(this.db, execId);
      if (ex) {
        await store.notify(this.db, {
          user_id: ex.user_id, title: `Agent ${agent.name} ${status}`,
          message: (result ?? error ?? '').slice(0, 300),
          priority: status === 'failed' ? 'high' : 'medium', category: 'agent', source: 'runtime',
          related_type: 'execution', related_id: execId,
        }).catch(() => {});
      }
    }
  }
}

function summarizeOutcome(r: unknown): string {
  try {
    const s = typeof r === 'string' ? r : JSON.stringify(r);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  } catch { return '(unserializable)'; }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

const PLANNER_SYSTEM = `You are the planning model inside the Agentic OS kernel. Given a request, context, memories, and a tool vocabulary, produce a MINIMAL plan.
Respond ONLY with JSON: {"rationale": string, "steps": [{"kind":"tool","tool":name,"args":object} | {"kind":"model","capability":"reasoning|writing|chat","prompt":string,"input_from":"all|last"} | {"kind":"skill","skill":name,"args":object}]}
Rules: prefer tools over reasoning steps for concrete actions; end with a model step that synthesizes the answer; never invent tool names outside the vocabulary; keep plans under 6 steps.`;
