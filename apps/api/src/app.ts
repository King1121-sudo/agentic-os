/**
 * HTTP API — typed boundary (§39). Fastify + zod DTOs from @agentic/contracts.
 * All routes are session-authenticated (cookie) except /api/auth/*, /api/health.
 * Realtime: /api/stream (SSE) taps the EventBus via the BrokerPort.
 *
 * This file is the COMPOSITION ROOT only: it builds the Fastify instance,
 * wires the session-auth hook, and registers one module per subsystem from
 * `./routes/*`. Each module owns its own routes and receives its dependencies
 * through RouteContext, so adding or removing a subsystem is a one-line change
 * here rather than an edit to a 1400-line file.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import type { RouteContext } from './routes/context';

import { registerAuthRoutes } from './routes/auth';
import { registerAgentsRoutes } from './routes/agents';
import { registerMemoryRoutes } from './routes/memory';
import { registerProjectsRoutes } from './routes/projects';
import { registerFlowsRoutes } from './routes/flows';
import { registerAutomationsRoutes } from './routes/automations';
import { registerIntegrationsRoutes } from './routes/integrations';
import { registerGraphRoutes } from './routes/graph';
import { registerApprovalsRoutes } from './routes/approvals';
import { registerNotificationsRoutes } from './routes/notifications';
import { registerTelemetryRoutes } from './routes/telemetry';
import { registerCommandRoutes } from './routes/command';
import { registerSupervisionRoutes } from './routes/supervision';

/** Dependencies the API needs. Alias of RouteContext, kept for existing callers. */
export type ApiDeps = RouteContext;

// ─── password hashing lives in auth.util.ts (scrypt, stdlib) ─────────────────

export function buildApi(deps: ApiDeps) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.register(cors, { origin: config.corsOrigin, credentials: true });

  // The session hook must be registered before any route that relies on
  // `req.user`, and the auth module owns it (it also owns `currentUser`).
  registerAuthRoutes(app, deps);
  registerAgentsRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerProjectsRoutes(app, deps);
  registerFlowsRoutes(app, deps);
  registerAutomationsRoutes(app, deps);
  registerIntegrationsRoutes(app, deps);
  registerGraphRoutes(app, deps);
  registerApprovalsRoutes(app, deps);
  registerNotificationsRoutes(app, deps);
  registerTelemetryRoutes(app, deps);
  registerCommandRoutes(app, deps);
  registerSupervisionRoutes(app, deps);

  return app;
}
