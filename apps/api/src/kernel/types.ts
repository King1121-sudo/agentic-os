/** Kernel-level types: registries, tool interface, model gateway port. */
import { Capability, Plan, PlanStep, TraceEntry, Observation, ToolRisk, AutonomyLevel, AgentRecord } from '@agentic/contracts';

export interface ToolContext {
  execution_id: string | null;
  agent: AgentRecord;
  user_id: string;
  /** Phase 3: delegation depth (0 = top-level). Guarded by AGENTIC_MAX_DELEGATION_DEPTH. */
  depth: number;
  emit: (entry: TraceEntry) => void;
  observe: (o: Observation) => void;
}

export interface ToolDef {
  name: string;
  description: string;
  risk: ToolRisk;
  scope: string;                       // permission scope required
  schema: Record<string, { type: 'string' | 'number' | 'boolean' | 'json'; required?: boolean; description: string }>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface SkillContext extends ToolContext {
  runStep: (step: PlanStep) => Promise<unknown>;
}

export interface ModelRequest {
  capability: Capability | 'planning';
  system?: string;
  prompt: string;
  hint?: unknown;
  max_tokens?: number;
  temperature?: number;
}

export interface ModelResponse {
  text: string;
  plan?: Plan;                        // set when capability === 'planning'
  model_id: string;
  provider_id: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

export interface ModelProviderPort {
  id: string;
  name: string;
  kind: 'builtin' | 'openai-compat' | 'ollama' | 'gemini';
  healthy(): Promise<boolean>;
  /** Cheap capability probe used by the router's health tracker. */
  listModels(): Promise<string[]>;
  generate(req: ModelRequest, model_id: string): Promise<ModelResponse>;
  /** Phase 2: streaming generation with abort support. Optional — the router
   *  falls back to generate() (single-chunk) when a provider lacks it. */
  generateStream?(req: ModelRequest, model_id: string, onToken: (delta: string) => void, signal?: AbortSignal): Promise<ModelResponse>;
}

// ─── autonomy + risk policy (security engine, §25 + §24) ───────────────────
export const RISK_GATE: Record<ToolRisk, { minAutonomy: AutonomyLevel; approval: 'never' | 'high-impact' | 'always' }> = {
  low:     { minAutonomy: 1, approval: 'never' },
  medium:  { minAutonomy: 2, approval: 'high-impact' },
  high:    { minAutonomy: 3, approval: 'always' },
};

export interface GateDecision {
  allowed: boolean;
  needsApproval: boolean;
  reason: string;
}

export function evaluateGate(
  agent: AgentRecord, tool: ToolDef, args: Record<string, unknown>, autonomyOverride?: number,
): GateDecision {
  const autonomy = autonomyOverride ?? agent.autonomy_level;
  // 1) tool must be in the agent's declared toolset (least privilege)
  if (!agent.tools.includes(tool.name)) {
    return { allowed: false, needsApproval: false, reason: `Tool "${tool.name}" is not in agent's toolset` };
  }
  // 2) permission scope check
  if (!agent.permissions.scopes.includes(tool.scope) && !agent.permissions.scopes.includes('*')) {
    return { allowed: false, needsApproval: false, reason: `Agent lacks scope "${tool.scope}"` };
  }
  // 3) arg schema validation (types only — cheap, catches model hallucination)
  for (const [k, def] of Object.entries(tool.schema)) {
    if (def.required && (args[k] === undefined || args[k] === null || args[k] === '')) {
      return { allowed: false, needsApproval: false, reason: `Missing required arg "${k}" for tool ${tool.name}` };
    }
  }
  // 4) autonomy + risk policy
  const policy = RISK_GATE[tool.risk];
  if (autonomy < policy.minAutonomy) {
    return { allowed: false, needsApproval: false, reason: `Autonomy level ${autonomy} below required ${policy.minAutonomy} for ${tool.risk}-risk tool` };
  }
  if (policy.approval === 'always') {
    return { allowed: true, needsApproval: true, reason: `${tool.risk}-risk tool requires human approval` };
  }
  if (policy.approval === 'high-impact') {
    // high-impact heuristic: writes/deletes or large payloads
    const impactful = /write|delete|update|create|send|run/i.test(`${tool.name} ${JSON.stringify(args).slice(0, 200)}`);
    if (impactful && autonomy < 3) {
      return { allowed: true, needsApproval: true, reason: 'High-impact medium-risk action at autonomy < 3' };
    }
  }
  return { allowed: true, needsApproval: false, reason: 'ok' };
}
