/**
 * Integration SDK — the adapter PORT (§16).
 *
 * This file defines the contract every integration must fulfill. The kernel
 * kernel does NOT contain hard-coded Gmail/GitHub/Slack logic; adapters
 * implement this interface and are registered into integrationRegistry.
 *
 * STATUS: port + registry shipped. Concrete adapters (Gmail, GitHub, ...)
 * are Phase 9 per ROADMAP.md. Nothing here fakes a connection.
 */
import type { BrokerPort } from '../infra/types';

export interface IntegrationEvent {
  integration_id: string;
  kind: string;              // e.g. 'email.received', 'pr.opened'
  payload: Record<string, unknown>;
  received_at: string;
}

export interface IntegrationPort {
  id: string;                // 'gmail' | 'github' | ...
  name: string;
  required_scopes: string[]; // permission scopes the user must grant
  /** OAuth or token handshake; returns account handle + capability list. */
  connect(credentials: unknown): Promise<{ account: string; capabilities: string[] }>;
  disconnect(account: string): Promise<void>;
  /** Poll or push subscription → emits IntegrationEvent into the bus. */
  subscribe(broker: BrokerPort, onEvent: (ev: IntegrationEvent) => void): Promise<() => void>;
  /** CRUD against the external system (capability-dependent). The optional
   *  token param is the vault token for the calling connection (Phase 9). */
  read?(query: Record<string, unknown>): Promise<unknown[]>;
  create?(item: Record<string, unknown>): Promise<unknown>;
  update?(id: string, patch: Record<string, unknown>): Promise<unknown>;
  delete?(id: string): Promise<void>;
  search?(q: string, token?: string): Promise<unknown[]>;
}

/** Registry the API will expose via /api/integrations once adapters land. */
export class IntegrationRegistry {
  private integrations = new Map<string, IntegrationPort>();

  register(i: IntegrationPort): void { this.integrations.set(i.id, i); }
  list(): { id: string; name: string; required_scopes: string[] }[] {
    return [...this.integrations.values()].map(i => ({ id: i.id, name: i.name, required_scopes: i.required_scopes }));
  }
  get(id: string): IntegrationPort | undefined { return this.integrations.get(id); }
}

export function createIntegrationRegistry(): IntegrationRegistry {
  return new IntegrationRegistry();
}
