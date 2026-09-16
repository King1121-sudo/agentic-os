/**
 * RouteContext — the dependency bundle every route module receives.
 *
 * Route modules take this instead of importing the kernel directly, so
 * `app.ts` stays a thin composition root and a module can be read, tested or
 * removed in isolation.
 */
import type { DataPort, BrokerPort } from '../infra/types';
import type { EventBus } from '../kernel/bus';
import type { ModelRouter } from '../gateway/router';
import type { AgentRuntime } from '../modules/runtime';
import type { ToolRegistry } from '../modules/tools';
import type { FlowEngine } from '../modules/flows';
import type { AutomationEngine } from '../modules/automations-engine';
import type { IntegrationService } from '../modules/integrations';

export interface RouteContext {
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

/** Session cookie name + lifetime, shared by the auth module and its hook. */
export const SESSION_COOKIE = 'agentic_session';
export const SESSION_DAYS = 14;

/** Minimal cookie reader (no @fastify/cookie dependency needed). */
export function getCookie(req: any, name: string): string | null {
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

/** Derive an agent's permission scopes from the tools it was granted. */
export function scopesForTools(toolNames: string[], registry: ToolRegistry): string[] {
  const scopes = new Set<string>(['memory:read', 'memory:write']); // baseline
  for (const t of registry.list()) {
    if (toolNames.includes(t.name)) scopes.add(t.scope);
  }
  return [...scopes];
}

/** Tolerant JSON parse for TEXT columns that may already be objects. */
export function safeParse(v: unknown): any {
  if (typeof v !== 'string') return v ?? {};
  try { return JSON.parse(v); } catch { return v; }
}
