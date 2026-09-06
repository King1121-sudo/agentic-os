/**
 * Agentic OS — shared contracts (types + zod schemas).
 * Single source of truth for the domain model, event catalog, plan format,
 * and API DTOs. Imported by the API (runtime, zod) and the web shell (types only).
 */
import { z } from 'zod';

// ─── primitives ────────────────────────────────────────────────────────────
export type Uuid = string;
export type Iso = string;
export type Json = unknown;

// ─── enums ─────────────────────────────────────────────────────────────────
export type Capability = 'planning' | 'reasoning' | 'writing' | 'chat';
export type ToolRisk = 'low' | 'medium' | 'high';
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;
export type AgentStatus =
  | 'idle' | 'thinking' | 'planning' | 'executing' | 'waiting'
  | 'paused' | 'approval_required' | 'completed' | 'failed' | 'cancelled';
export type ExecutionStatus =
  | 'running' | 'paused' | 'approval_required' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export type MemoryType =
  | 'working' | 'episodic' | 'semantic' | 'preference' | 'project' | 'procedural' | 'entity';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'archived';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type ProjectStatus = 'active' | 'archived';
export type SprintStatus = 'planned' | 'active' | 'completed' | 'cancelled';
export type GenerationStatus = 'started' | 'completed' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timeout';
export type NotificationStatus = 'unread' | 'read';
export type EntityKind =
  | 'user' | 'agent' | 'execution' | 'generation' | 'memory' | 'project' | 'task'
  | 'sprint' | 'skill' | 'tool_execution' | 'event' | 'approval' | 'notification'
  // Phase 5: extracted entities (people/orgs/tech/urls) linked to memories
  | 'person' | 'org' | 'tech' | 'url' | 'topic';

export const AUTONOMY_LEVELS: Record<AutonomyLevel, string> = {
  0: 'Observe only',
  1: 'Suggest',
  2: 'Execute with approval',
  3: 'Execute automatically (high-impact still gated)',
  4: 'Autonomous within boundaries',
};

// ─── event catalog (kernel-wide) ───────────────────────────────────────────
export type EventType =
  | 'command.executed' | 'agent.started' | 'agent.thinking' | 'plan.created'
  | 'agent.executing' | 'tool.executed' | 'tool.denied' | 'tool.failed'
  | 'skill.executed' | 'agent.paused' | 'agent.resumed' | 'agent.stopped'
  | 'agent.completed' | 'agent.failed' | 'approval.requested' | 'approval.decided'
  | 'memory.created' | 'memory.updated' | 'memory.consolidated'
  | 'project.created' | 'project.archived' | 'task.created' | 'task.updated'
  | 'task.completed' | 'sprint.started' | 'sprint.completed'
  | 'generation.started' | 'generation.completed' | 'generation.failed'
  | 'notification.created' | 'link.created' | 'integration.event'
  | 'user.login' | 'user.logout' | 'system.ready'
  | 'agent.token' | 'generation.cancelled'
  | 'agent.delegated' | 'agent.messaged' | 'execution.resumed' | 'execution.interrupted'
  | 'skill.denied' | 'skill.version.bumped'
  // Phase 5: memory — entity extraction, working-memory windows, semantic vector search
  | 'memory.entities.extracted' | 'memory.working.opened' | 'memory.working.closed'
  | 'memory.vector.query'
  // Phase 6: projects/sprints — dependencies, milestones, deadline automations
  | 'task.dependency.added' | 'task.dependency.removed' | 'task.blocked' | 'task.unblocked'
  | 'milestone.created' | 'milestone.completed' | 'milestone.missed'
  | 'sprint.planned' | 'task.deadline.overdue' | 'task.deadline.due_soon'
  // Phase 7: flows — lifecycle + node transitions
  | 'flow.created' | 'flow.updated' | 'flow.run.started' | 'flow.run.completed'
  | 'flow.run.failed' | 'flow.run.cancelled' | 'flow.run.paused' | 'flow.run.resumed'
  | 'flow.node.started' | 'flow.node.completed' | 'flow.waiting' | 'flow.approval.requested'
  // Phase 8: automations — lifecycle + dispatches
  | 'automation.created' | 'automation.updated' | 'automation.deleted'
  | 'automation.enabled' | 'automation.paused'
  | 'automation.dispatched' | 'automation.skipped' | 'automation.failed'
  // Phase 9: integrations — lifecycle + external events bridged onto the bus
  | 'integration.connected' | 'integration.disconnected' | 'integration.failed'
  | 'integration.oauth.started'
  // Phase 10: notifications + widgets
  | 'notification.push.sent' | 'widget.layout.updated';

export interface OsEvent {
  id: Uuid;
  type: EventType;
  actor_type: 'user' | 'agent' | 'system' | 'tool' | 'skill' | 'flow' | 'automation' | 'integration';
  actor_id?: string;
  target_type?: EntityKind;
  target_id?: string;
  data: Json;
  created_at: Iso;
}

// ─── records ────────────────────────────────────────────────────────────────
export interface ModelPolicy {
  capability?: Capability;
  preference?: { provider_id?: string; model_id?: string }[];
  temperature?: number;
  max_tokens?: number;
}

export interface AgentRecord {
  id: Uuid;
  name: string;
  description: string;
  system_instructions: string;
  model_policy: ModelPolicy;
  skills: string[];
  tools: string[];
  memory_policy: { read: boolean; write: boolean; k: number; types: MemoryType[] };
  permissions: { tools: string[]; scopes: string[] };
  autonomy_level: AutonomyLevel;
  status: AgentStatus;
  created_at: Iso;
  updated_at: Iso;
}

export interface TraceEntry {
  ts: Iso;
  kind: 'plan' | 'tool' | 'model' | 'skill' | 'state' | 'error' | 'memory' | 'approval' | 'result';
  message: string;
  data?: Json;
}

export interface Observation {
  step: number;
  source: string;
  summary: string;
  data: Json;
}

export interface ExecutionRecord {
  id: Uuid;
  agent_id: Uuid;
  parent_execution_id?: Uuid | null;
  user_id: Uuid;
  input: string;
  project_id?: Uuid | null;
  task_id?: Uuid | null;
  status: ExecutionStatus;
  plan: { rationale: string; steps: PlanStep[] } | null;
  observations: Observation[];
  trace: TraceEntry[];
  result: string | null;
  error: string | null;
  current_step: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  started_at: Iso;
  updated_at: Iso;
  completed_at: Iso | null;
}

export interface ModelRecord {
  id: string;
  provider_id: string;
  family: string;
  display_name: string;
  capabilities: Capability[];
  context_limit: number;
  cost_in_per_mtok: number;
  cost_out_per_mtok: number;
  priority: number;
  health: 'healthy' | 'unhealthy' | 'unknown';
  latency_ms: number | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface ProviderRecord {
  id: string;
  name: string;
  kind: 'builtin' | 'openai-compat' | 'ollama' | 'gemini';
  base_url: string | null;
  status: 'up' | 'down' | 'unknown';
  model_count: number;
  created_at: Iso;
  updated_at: Iso;
}

export interface GenerationRecord {
  id: Uuid;
  agent_id: Uuid | null;
  execution_id: Uuid | null;
  parent_generation_id: Uuid | null;
  model_id: string;
  provider_id: string;
  kind: Capability;
  input: { system?: string; user: string; hint?: Json } ;
  output: string | null;
  context: { memories_used: string[]; tools_used: string[] };
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost: number;
  status: GenerationStatus;
  error: string | null;
  created_at: Iso;
  completed_at: Iso | null;
}

export interface MemoryRecord {
  id: Uuid;
  user_id: Uuid;
  type: MemoryType;
  content: string;
  summary: string;
  importance: number;
  confidence: number;
  source: string;
  source_id?: string | null;
  project_id?: Uuid | null;
  entities: string[];
  keywords: string[];
  embedding?: string | number[] | null;
  access_count: number;
  created_at: Iso;
  updated_at: Iso;
  last_accessed: Iso;
  expires_at: Iso | null;
}

export interface MemoryHit extends MemoryRecord { score: number }

/** Phase 5: extracted entity (person/org/tech/url/topic) linked to memories. */
export interface ExtractedEntity {
  kind: 'person' | 'org' | 'tech' | 'url' | 'topic';
  name: string;
}

/** Phase 5: working-memory window — one per execution. Holds the context the
 *  agent is actively using: pinned memories retrieved at planning + facts
 *  appended per step, bounded to keep synthesis prompts small. */
export interface WorkingMemoryRecord {
  id: Uuid;
  execution_id: Uuid;
  user_id: Uuid;
  agent_id: Uuid;
  pinned_memory_ids: string[];
  facts: { ts: Iso; step: number; source: string; text: string }[];
  token_estimate: number;
  created_at: Iso;
  updated_at: Iso;
  closed_at: Iso | null;
}

/** Phase 5: vector-search result (driver-agnostic — local cosine or pgvector). */
export interface VectorHit {
  memory_id: Uuid;
  score: number;
}

export interface ProjectRecord {
  id: Uuid; name: string; slug: string; description: string;
  status: ProjectStatus; deadline: Iso | null;
  created_by: Uuid | null; created_at: Iso; updated_at: Iso;
}

export interface TaskRecord {
  id: Uuid; project_id: Uuid | null; sprint_id: Uuid | null;
  title: string; description: string; status: TaskStatus; priority: Priority;
  deadline: Iso | null; assignee_agent_id: Uuid | null; labels: string[];
  created_by: Uuid | null; created_at: Iso; updated_at: Iso; completed_at: Iso | null;
}

export interface SprintRecord {
  id: Uuid; project_id: Uuid; name: string; objective: string;
  status: SprintStatus; deadline: Iso | null;
  created_at: Iso; updated_at: Iso; started_at: Iso | null; completed_at: Iso | null;
}

/** Phase 6: milestone — a dated checkpoint within a project. */
export interface MilestoneRecord {
  id: Uuid; project_id: Uuid; name: string; description: string;
  due_date: Iso | null;
  status: 'open' | 'reached' | 'missed';
  reached_at: Iso | null;
  created_at: Iso; updated_at: Iso;
}

/** Phase 6: task dependency edge — task_id depends on depends_on. */
export interface TaskDependencyRecord {
  id: Uuid; task_id: Uuid; depends_on: Uuid; created_at: Iso;
}

/** Phase 6: dependency-aware execution order computed from the dependency graph. */
export type DependencyOrder = { task_id: Uuid; level: number; depends_on: Uuid[] };

// ─── Phase 7: Flows ─────────────────────────────────────────────────────────
/** Flow node kinds (§17): what a flow step can be. */
export type FlowNodeKind =
  | 'trigger' | 'agent' | 'skill' | 'tool' | 'condition' | 'branch'
  | 'loop' | 'wait' | 'approval';

/** A node in the flow graph. `config` is kind-specific (agent name, tool args,
 *  condition expression, loop max, wait seconds, …). */
export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label?: string;
  config: Record<string, unknown>;
  x?: number; y?: number;             // builder canvas position
}

/** Directed edge between nodes. `from_handle` disambiguates branch outputs
 *  ('true'/'false' for condition/branch nodes). */
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  from_handle?: string;
}

export interface FlowRecord {
  id: Uuid; name: string; description: string;
  nodes: FlowNode[]; edges: FlowEdge[];
  version: string;                     // current version (semver patch-bumped)
  created_by: Uuid | null;
  created_at: Iso; updated_at: Iso;
}

export interface FlowVersionRecord {
  id: Uuid; flow_id: Uuid; version: string;
  nodes: FlowNode[]; edges: FlowEdge[];
  created_at: Iso;
}

export type FlowRunStatus = 'running' | 'paused' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface FlowRunRecord {
  id: Uuid; flow_id: Uuid; flow_version: string;
  user_id: Uuid;
  status: FlowRunStatus;
  input: Json;
  context: Record<string, unknown>;   // live variable store (outputs feed inputs)
  current_node: string | null;         // checkpoint: node being executed / next up
  completed_nodes: string[];
  trace: { ts: Iso; node: string | null; kind: string; message: string; data?: Json }[];
  result: Json | null;
  error: string | null;
  started_at: Iso; updated_at: Iso; completed_at: Iso | null;
}

// ─── Phase 8: Automations ───────────────────────────────────────────────────
/** What starts an automation. */
export type AutomationTriggerKind = 'cron' | 'event' | 'webhook';

/** What an automation does when it fires. */
export type AutomationActionKind = 'flow' | 'agent';

export interface AutomationRecord {
  id: Uuid;
  name: string;
  description: string;
  trigger: AutomationTriggerKind;
  /** cron: {schedule: 'every 5 minutes as cron expr'}; event: {event_type: 'task.completed', pattern?};
   *  webhook: {secret} (token verified on intake). */
  trigger_config: Record<string, unknown>;
  action: AutomationActionKind;
  /** flow: {flow_id, input}; agent: {agent_name, input}. */
  action_config: Record<string, unknown>;
  /** Per-automation autonomy policy: 0-4. Gates the dispatched action the same
   *  way the agent runtime gates tools — 2 means high-risk actions need approval. */
  autonomy_level: number;
  enabled: boolean;
  /** run log: last fired, last result, count — for the inspector UI */
  last_fired_at: Iso | null;
  last_run_id: Uuid | null;
  run_count: number;
  created_by: Uuid | null;
  created_at: Iso; updated_at: Iso;
}

/** One automation dispatch (the run log). */
export interface AutomationRunRecord {
  id: Uuid;
  automation_id: Uuid;
  trigger: AutomationTriggerKind;
  status: 'dispatched' | 'skipped' | 'failed';
  reason: string;                    // why skipped (policy gate, dedup) or failed
  target_id: Uuid | null;            // flow run id or agent execution id
  fired_at: Iso;
}

// ─── Phase 9: Integrations ──────────────────────────────────────────────────
export type IntegrationStatus = 'connected' | 'disconnected';

/** A live integration connection (one per user + adapter). */
export interface IntegrationRecord {
  id: Uuid;
  integration_id: string;            // adapter id: 'github' | 'gmail' | 'slack'
  user_id: Uuid;
  status: IntegrationStatus;
  account: string;                    // external account handle (login/email/team)
  capabilities: string[];             // granted capability names
  scopes: string[];                  // granted permission scopes
  connected_at: Iso;
  updated_at: Iso;
}

/** An external event received through an integration, persisted + bridged. */
export interface IntegrationEventRecord {
  id: Uuid;
  integration_id: string;            // adapter id
  connection_id: Uuid | null;
  kind: string;                      // 'email.received' | 'pr.opened' | ...
  payload: Json;
  received_at: Iso;
}

// ─── Phase 10: Notifications + Widgets ──────────────────────────────────────
/** Dashboard widget kinds (the registry the UI renders from). */
export type WidgetKind =
  | 'agent-presence' | 'system-health' | 'open-tasks' | 'projects' | 'unread-notes'
  | 'recent-activity' | 'quick-actions' | 'counts' | 'approvals' | 'automations';

/** One placed widget in a user's dashboard grid. */
export interface DashboardWidget {
  id: string;                        // unique within the layout
  kind: WidgetKind;
  width: 1 | 2 | 3;                  // grid columns (of 3)
}

/** A user's dashboard layout (order = render order). */
export interface DashboardLayout {
  widgets: DashboardWidget[];
  updated_at: Iso;
}

/** Per-user notification channel preferences. */
export interface NotificationPrefs {
  in_app: boolean;                   // the bell (always effectively on — the ledger)
  browser_push: boolean;             // Web Push (VAPID)
  push_min_priority: 'low' | 'medium' | 'high' | 'urgent';  // gate for the push channel
  categories: string[];              // empty = all categories
}

// ─── Phase 11: Knowledge graph ───────────────────────────────────────────────
/** A node in the knowledge-graph snapshot (entities + memory co-mentions). */
export interface GraphNode {
  id: string;                        // "<kind>:<id>" (entity registry convention)
  kind: string;
  label: string;
  degree: number;                    // edge count (precomputed for sizing)
  weight: number;                    // derived-link strength (co-occurrence count)
}

/** An edge in the snapshot. `relation` distinguishes explicit links
 *  (mentions, delegated_to, …) from derived ones (co_occurs_with). */
export interface GraphEdge {
  from: string;                      // "<kind>:<id>"
  to: string;
  relation: string;
  derived: boolean;
}

/** The whole graph for rendering — nodes sized by degree, edges typed. */
export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  derived: number;                   // count of co-occurrence edges in this snapshot
}

/** One hop of graph traversal (a node's immediate neighborhood). */
export interface GraphNeighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SkillStepDef {
  kind: 'tool' | 'model';
  tool?: string;
  capability?: Capability;
  args?: Record<string, unknown>;
  prompt?: string;
}

export interface SkillRecord {
  id: Uuid; name: string; description: string; category: string;
  parent_id: Uuid | null; version: string; instructions: string;
  steps: SkillStepDef[];
  required_tools: string[]; required_permissions: string[];
  created_at: Iso; updated_at: Iso;
}

export interface LinkRecord {
  id: Uuid; from_type: EntityKind; from_id: string; to_type: EntityKind; to_id: string;
  relation: string; created_at: Iso; created_by: Uuid | null;
}

export interface ApprovalRecord {
  id: Uuid; execution_id: Uuid; agent_id: Uuid; tool: string;
  args: Json; reason: string; status: ApprovalStatus;
  decided_by: Uuid | null; decided_at: Iso | null; created_at: Iso;
}

export interface NotificationRecord {
  id: Uuid; user_id: Uuid; title: string; message: string;
  priority: Priority; category: string; source: string;
  related_type: EntityKind | null; related_id: string | null;
  status: NotificationStatus; created_at: Iso; expires_at: Iso | null;
}

export interface AuditRecord {
  id: Uuid; ts: Iso; actor_type: string; actor_id: string | null;
  action: string; target_type: string | null; target_id: string | null;
  execution_id: Uuid | null; meta: Json;
}

export interface ToolExecutionRecord {
  id: Uuid; execution_id: Uuid | null; agent_id: Uuid | null; tool: string;
  args: Json; result: Json; risk: ToolRisk; status: 'ok' | 'error' | 'denied';
  error: string | null; latency_ms: number; created_at: Iso;
}

export interface SystemHealth {
  db: 'up' | 'down'; broker: 'up' | 'down';
  providers: { id: string; status: string; models: number }[];
  counts: { agents: number; executions: number; memories: number; tasks: number; projects: number; generations: number; events: number };
  version: string;
  time: Iso;
}

// ─── plan format (agent runtime ↔ model gateway) ───────────────────────────
export const PlanStepSchema = z.union([
  z.object({
    kind: z.literal('tool'),
    tool: z.string(),
    args: z.record(z.unknown()).default({}),
    /** Phase 4: template refs inside args resolved from the execution input.
     *  e.g. { "$input": true } → the raw user input; { "$url": true } → first URL in it. */
    args_from: z.enum(['input', 'url', 'query']).optional(),
  }),
  z.object({
    kind: z.literal('model'),
    capability: z.enum(['reasoning', 'writing', 'chat']).default('reasoning'),
    prompt: z.string().default(''),
    input_from: z.enum(['all', 'last']).default('all'),
    store_as: z.string().optional(),
  }),
  z.object({
    kind: z.literal('skill'),
    skill: z.string(),
    args: z.record(z.unknown()).default({}),
  }),
]);
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  rationale: z.string().default(''),
  steps: z.array(PlanStepSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

// ─── API DTOs (zod-validated) ───────────────────────────────────────────────
export const LoginInput = z.object({ username: z.string().min(1), password: z.string().min(1) });
export type LoginInputDto = z.infer<typeof LoginInput>;

export const ExecuteInput = z.object({
  input: z.string().min(1).max(8000),
  project_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  skill: z.string().optional(),
  autonomy_override: z.number().int().min(0).max(4).optional(),
});
export type ExecuteInputDto = z.infer<typeof ExecuteInput>;

export const CommandInput = z.object({ text: z.string().min(1).max(2000) });

export const ProjectCreateInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional().default(''),
  deadline: z.string().optional(),
});
export const TaskCreateInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().default(''),
  project_id: z.string().uuid().optional(),
  project_name: z.string().optional(),
  sprint_id: z.string().uuid().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().default('medium'),
  deadline: z.string().optional(),
});
export const TaskUpdateInput = z.object({
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'archived']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  deadline: z.string().optional(),
  sprint_id: z.string().uuid().nullable().optional(),
});
export const SprintCreateInput = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  objective: z.string().max(2000).optional().default(''),
  deadline: z.string().optional(),
});
/** Phase 6: dependency edge — task_id depends on depends_on. */
export const TaskDependencyInput = z.object({
  task_id: z.string().uuid(),
  depends_on: z.string().uuid(),
});
/** Phase 6: milestone within a project. */
export const MilestoneCreateInput = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().default(''),
  due_date: z.string().optional(),
});
/** Phase 6: sprint lifecycle transition. */
export const SprintTransitionInput = z.object({
  action: z.enum(['start', 'complete', 'cancel']),
});
/** Phase 7: flow node + edge (builder DTO). */
export const FlowNodeInput = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['trigger', 'agent', 'skill', 'tool', 'condition', 'branch', 'loop', 'wait', 'approval']),
  label: z.string().max(120).optional(),
  config: z.record(z.unknown()).optional().default({}),
  x: z.number().optional(),
  y: z.number().optional(),
});
export const FlowEdgeInput = z.object({
  id: z.string().min(1).max(64),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  from_handle: z.string().max(32).optional(),
});
/** Phase 7: create/update a flow graph. */
export const FlowUpsertInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  nodes: z.array(FlowNodeInput).min(1).max(60),
  edges: z.array(FlowEdgeInput).max(120).default([]),
});
/** Phase 7: start a flow run. */
export const FlowRunInput = z.object({
  input: z.record(z.unknown()).optional().default({}),
});
/** Phase 8: create/update an automation. */
export const AutomationUpsertInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  trigger: z.enum(['cron', 'event', 'webhook']),
  trigger_config: z.object({
    schedule: z.string().max(60).optional(),          // cron only
    event_type: z.string().max(60).optional(),        // event only
    pattern: z.string().max(120).optional(),         // event only: substring match on event data
    secret: z.string().min(8).max(120).optional(),   // webhook only (generated server-side when absent)
  }),
  action: z.enum(['flow', 'agent']),
  action_config: z.object({
    flow_id: z.string().uuid().optional(),            // flow action
    agent_name: z.string().max(80).optional(),       // agent action
    input: z.string().max(2000).optional(),          // prompt / flow input template
  }),
  autonomy_level: z.number().int().min(0).max(4).optional().default(2),
  enabled: z.boolean().optional().default(true),
});
/** Phase 8: enable/pause toggle. */
export const AutomationToggleInput = z.object({
  enabled: z.boolean(),
});
/** Phase 9: connect an integration with a personal access token / bot token. */
export const IntegrationConnectTokenInput = z.object({
  integration_id: z.enum(['github', 'gmail', 'slack']),
  token: z.string().min(8).max(400),
  scopes: z.array(z.string().max(60)).optional(),   // defaults to the adapter's required set
});
/** Phase 9: complete OAuth with the authorization code (from the callback). */
export const IntegrationConnectOAuthInput = z.object({
  state: z.string().min(8).max(120),
  code: z.string().min(4).max(400),
});
/** Phase 10: save a dashboard layout (the widget grid). */
export const DashboardLayoutInput = z.object({
  widgets: z.array(z.object({
    id: z.string().min(1).max(48),
    kind: z.enum(['agent-presence', 'system-health', 'open-tasks', 'projects', 'unread-notes',
      'recent-activity', 'quick-actions', 'counts', 'approvals', 'automations']),
    width: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })).min(1).max(24),
});
/** Phase 10: notification channel preferences. */
export const NotificationPrefsInput = z.object({
  browser_push: z.boolean().optional(),
  push_min_priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  categories: z.array(z.string().max(40)).max(20).optional(),
});
/** Phase 10: Web Push subscription (browser PushSubscription JSON). */
export const PushSubscriptionInput = z.object({
  endpoint: z.string().url().max(500),
  keys: z.object({
    p256dh: z.string().min(16).max(200),
    auth: z.string().min(8).max(200),
  }),
});
export const MemoryCreateInput = z.object({
  type: z.enum(['working', 'episodic', 'semantic', 'preference', 'project', 'procedural', 'entity']),
  content: z.string().min(1).max(8000),
  summary: z.string().max(500).optional(),
  importance: z.number().min(0).max(10).optional().default(5),
  project_id: z.string().uuid().optional(),
  source: z.string().optional().default('user'),
});
export const AgentCreateInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).optional().default(''),
  system_instructions: z.string().max(8000).optional().default(''),
  model_policy: z.object({
    capability: z.enum(['planning', 'reasoning', 'writing', 'chat']).optional(),
    preference: z.array(z.object({ provider_id: z.string().optional(), model_id: z.string().optional() })).optional(),
  }).optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  autonomy_level: z.number().int().min(0).max(4).optional().default(2),
  memory_policy: z.object({
    read: z.boolean().optional().default(true),
    write: z.boolean().optional().default(true),
    k: z.number().int().min(1).max(20).optional().default(5),
    types: z.array(z.enum(['working', 'episodic', 'semantic', 'preference', 'project', 'procedural', 'entity'])).optional(),
  }).optional(),
});
export const LinkCreateInput = z.object({
  from_type: z.string(), from_id: z.string(),
  to_type: z.string(), to_id: z.string(),
  relation: z.string(),
});
/** Phase 5: force entity extraction over existing memories (backfill). */
export const MemoryBackfillInput = z.object({
  limit: z.number().int().min(1).max(500).optional().default(200),
});
/** Phase 5: manual fact appended to an execution's working-memory window. */
export const WorkingMemoryFactInput = z.object({
  text: z.string().min(1).max(500),
  source: z.string().max(60).optional().default('user'),
  step: z.number().int().min(0).optional().default(0),
});
export const ApprovalDecisionInput = z.object({
  decision: z.enum(['approve', 'deny']),
  note: z.string().max(1000).optional(),
});
export const SkillCreateInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  category: z.string().optional().default('general'),
  parent_id: z.string().uuid().nullable().optional(),
  steps: z.array(z.object({
    kind: z.enum(['tool', 'model']),
    tool: z.string().optional(),
    capability: z.enum(['reasoning', 'writing', 'chat']).optional(),
    args: z.record(z.unknown()).optional(),
    prompt: z.string().optional(),
  })).min(1),
  required_tools: z.array(z.string()).optional().default([]),
  instructions: z.string().max(8000).optional().default(''),
});

// ─── command center response ────────────────────────────────────────────────
export type CommandResponse =
  | { kind: 'result'; text: string; data?: Json }
  | { kind: 'execution'; execution_id: Uuid; agent_id: Uuid; agent_name: string }
  | { kind: 'unimplemented'; text: string };

export interface SearchResultItem {
  type: string; id: string; title: string; subtitle: string;
  score: number; created_at: Iso;
}
