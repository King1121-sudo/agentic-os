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
  | 'sprint' | 'skill' | 'tool_execution' | 'event' | 'approval' | 'notification';

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
  | 'skill.denied' | 'skill.version.bumped';

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
