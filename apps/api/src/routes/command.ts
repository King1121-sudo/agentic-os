/**
 * command routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as store from '../modules/store';
import * as memory from '../modules/memory';
import * as projects from '../modules/projects';
import { CommandInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerCommandRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus, runtime, integrationsService } = ctx;

// ─── COMMAND CENTER (§29) ──────────────────────────────────────────────────
app.post('/api/command', async (req: any, reply: any) => {
  const parsed = CommandInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
  const text = parsed.data.text.trim();
  await bus.emit('command.executed', { text: text.slice(0, 200) }, { actor_type: 'user', actor_id: req.user.id });
  const result = await routeCommand(text, req.user);
  // §7 immediate acknowledgement — honest intent naming what will actually happen.
  // The ack names the real route (agent or instant local answer), never invents work.
  const ack = result.kind === 'execution'
    ? `I'll route this to ${result.agent_name ?? 'the agent'} — follow the execution as it runs.`
    : result.ack ?? 'Working on it.';
  await bus.emit('command.acknowledged', { text: text.slice(0, 200), ack, kind: result.kind, agent: result.kind === 'execution' ? result.agent_name ?? null : null }, { actor_type: 'system', actor_id: req.user.id }).catch(() => {});
  return { ...result, ack };
});

async function routeCommand(text: string, user: { id: string; username: string; display_name: string }): Promise<any> {
  const t = text.toLowerCase();

  // "show me what my agents are doing" / "what changed while i was away"
  if (/\b(what).*(agents?).*(doing|up to)|show.*(agents?)\b/.test(t)) {
    const agents = await store.listAgents(db);
    const running = await db.query<any>("SELECT * FROM executions WHERE status IN ('running','approval_required','paused') ORDER BY started_at DESC LIMIT 10");
    return { kind: 'result', ack: "I'll check the agent roster and any executions still running.", text: [
      'AGENTS', ...agents.map(a => `${a.name.padEnd(14)} ${a.status === 'idle' ? '○' : '●'} ${a.status}`),
      '', 'ACTIVE EXECUTIONS', ...(running.length ? running.map(r => `${r.id.slice(0, 8)} — ${r.status}: ${r.input.slice(0, 80)}`) : ['(none — all idle)']),
    ].join('\n') };
  }

  // memory queries
  if (/\b(what do you (know|remember)|recall|do you remember)\b/.test(t)) {
    const hits = await memory.searchMemory(db, { user_id: user.id, query: text, k: 5 });
    return { kind: 'result', ack: "I'll search your memories for that.", text: hits.length
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
    return { kind: 'result', ack: "I'll put together your briefing — tasks, notifications, agents and projects.", text: [
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
      ack: 'I\'ll review the project and create a dependency-chained sprint for it.',
      text: `Sprint "${res.sprint.name}" planned in project "${project.name}" — ${res.tasks.length} tasks in a dependency chain (Design → Implement → Test → Deploy). ${res.blocked_count} task(s) auto-blocked by dependencies; complete a task to unblock the next. Execution order: level 0 first.`,
      data: { sprint_id: res.sprint.id },
    };
  }

  // Phase 6: milestone creation — "add a milestone X to project Y"
  if (/\b(add|create|set)\b.*\bmilestone\b/.test(t)) {
    const nameMatch = text.match(/milestone\s+(?:called|named|titled|for|to|[:-])?\s*["“']?([^"”',]{2,120})["”']?/i);
    let mName = nameMatch?.[1]?.trim() ?? '';
    // strip trailing "to project X" fragments
    const pm = mName.match(/\s+(?:in|to|for)\s+(?:the\s+)?(?:project\s+)?(.+)$/i);
    let projName = pm?.[1]?.trim();
    if (projName) mName = mName.slice(0, pm!.index).trim();
    const project = projName
      ? (await store.findProjectByName(db, projName)) ?? (await store.createProject(db, { name: projName, created_by: user.id }))
      : (await store.listProjects(db))[0];
    if (!project) return { kind: 'result', ack: 'I looked for a project to attach that milestone to.', text: 'No project to attach the milestone to — create a project first.' };
    const due = text.match(/\b(?:by|due|before)\s+([A-Za-z0-9/, -]{3,20})/)?.[1];
    const m = await projects.createMilestone(db, { project_id: project.id, name: mName || 'New milestone', due_date: due ? new Date(due).toISOString() : null });
    await bus.emit('milestone.created', { id: m.id, name: m.name, project_id: m.project_id }, { actor_type: 'user', actor_id: user.id, target_type: 'project', target_id: m.project_id });
    return { kind: 'result', ack: `I'll add that milestone to "${project.name}" with its due date.`, text: `Milestone "${m.name}" added to project "${project.name}"${m.due_date ? ` (due ${m.due_date.slice(0, 10)})` : ''}. It will flip to "missed" automatically if the due date passes while still open.`, data: { milestone_id: m.id } };
  }

  // Phase 6: project status via rollup — "status of project X" / "how is X going"
  const statusMatch = t.match(/\b(?:status|progress|how is|how's)\b.*\b(?:project|going)\b/i)
    ?? t.match(/\b(?:project)\s+([A-Za-z0-9 _-]+)\s+status\b/i);
  if (statusMatch) {
    const nameMatch2 = t.match(/\b(?:project|of)\s+["“']?([A-Za-z0-9][A-Za-z0-9 _-]{1,40})["”']?/i);
    const name = nameMatch2?.[1]?.trim();
    const project = name ? await store.findProjectByName(db, name) : (await store.listProjects(db))[0];
    if (!project) return { kind: 'result', ack: 'I looked for that project.', text: name ? `No project named "${name}".` : 'No projects yet.' };
    const r = await projects.projectRollup(db, project.id);
    if (!r) return { kind: 'result', ack: 'I looked for that project.', text: 'Project not found.' };
    return { kind: 'result', ack: `I'll pull the rollup for "${project.name}" — progress, blockers, sprints, milestones.`, text: [
      `Project "${project.name}" — ${r.completion_pct}% complete`,
      `  Tasks: ${r.tasks.done}/${r.tasks.total} done · ${r.tasks.in_progress} in progress · ${r.tasks.blocked} blocked`,
      ...(r.blocked_tasks.length ? ['', 'BLOCKERS', ...r.blocked_tasks.map(b => `  ${b.title} waits on: ${b.waiting_on.join(', ')}`)] : []),
      ...(r.overdue_tasks.length ? ['', 'OVERDUE', ...r.overdue_tasks.map(o => `  ${o.title} (deadline ${String(o.deadline).slice(0, 10)})`)] : []),
      ...(r.active_sprints.length ? ['', 'ACTIVE SPRINTS', ...r.active_sprints.map(s => `  ${s.name} — ${s.tasks_done}/${s.tasks_total} tasks (${s.completion_pct}%)`)] : []),
      ...(r.milestones.total ? ['', `MILESTONES — ${r.milestones.reached} reached, ${r.milestones.missed} missed, ${r.milestones.open} open`,
        ...(r.milestones.next_due ? [`  next due: ${r.milestones.next_due.name} (${String(r.milestones.next_due.due_date).slice(0, 10)})`] : [])] : []),
    ].join('\n'), data: r as any };
  }

  // connect integration (platform: real adapters + vault + OAuth)
  if (/\b(connect|link|hook up)\b.*\b(github|gmail|slack|telegram|whatsapp|instagram|youtube)\b/.test(t)) {
    const idMatch = t.match(/\b(github|gmail|slack|telegram|whatsapp|instagram|youtube)\b/i);
    const integrationId = idMatch?.[1]?.toLowerCase();
    const conns = await integrationsService.listConnections(user.id, String(integrationId));
    const live = conns.filter(c => c.status === 'connected');
    if (live.length) {
      return { kind: 'result', ack: `I'll check your current ${integrationId} connections and how to connect.`, text: `${live.map(c => c.account_id).join(', ')} ${live.length > 1 ? 'are' : 'is'} already connected to ${integrationId} (${live.map(c => c.capabilities.join('+')).join(' ; ')}). Disconnect from the Integrations page to switch accounts.` };
    }
    return { kind: 'result', ack: `I'll check your current ${integrationId} connections and how to connect.`, text: [
      `To connect ${integrationId}, open the Integrations page (rail icon ⎌) and either:`,
      `  • paste a ${integrationId === 'slack' ? 'bot token (xoxb-…)' : 'personal access token'} — it is verified against the provider and stored encrypted, or`,
      `  • use the OAuth button${integrationId === 'slack' ? ' (Slack connects with bot tokens only)' : ' for the full consent flow'}.`,
      `Tokens never touch the database in plaintext — the vault encrypts them with AES-256-GCM.`,
    ].join('\n') };
  }

  // schedule/automations — Phase 8 shipped: point at the real engine
  if (/\b(schedule|every morning|cron|recurring|automation)\b/.test(t)) {
    return { kind: 'result', ack: "I'll point you at the Automation Engine — it's live.", text: [
      'The Automation Engine is live (Phase 8):',
      '  • Open the Automations page (rail icon ⏁) to create one visually — trigger (cron / event / webhook) → action (flow or agent), with an autonomy policy.',
      '  • Every-minute crons, event-pattern triggers, and signature-verified webhooks all run today; runs are logged per automation.',
      '  • Example webhook trigger: POST /api/webhooks/:id with the automation\'s Bearer secret.',
    ].join('\n') };
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
}
