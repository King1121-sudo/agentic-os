/**
 * Composition root — builds the whole OS kernel and boots the API.
 * Dependency order: Data → Broker → Bus → Gateway → Tools → Runtime → API.
 * Adapters are selected by env (DATABASE_URL → Postgres, REDIS_URL → Redis);
 * defaults are the zero-dependency local drivers.
 */
import { config } from './config';
import { SqliteDataPort } from './infra/sqlite.adapter';
import { PgDataPort } from './infra/pg.adapter';
import { createBroker } from './infra/broker';
import { runMigrations } from './infra/migrations';
import { EventBus } from './kernel/bus';
import { ModelRouter } from './gateway/router';
import { BuiltinProvider, OpenAICompatProvider, OllamaProvider, GeminiProvider } from './gateway/providers';
import { ToolRegistry, createBuiltinTools, setRuntimeRef } from './modules/tools';
import { AgentRuntime } from './modules/runtime';
import { FlowEngine } from './modules/flows';
import { AutomationEngine } from './modules/automations-engine';
import { IntegrationService } from './modules/integrations-service';
import { startNotificationRouter } from './modules/notify';
import { deriveCoOccurrenceLinks } from './modules/graph';
import { buildApi } from './app';
import { seed } from './seed';
import { createVectorIndex } from './modules/vector';
import { setVectorIndex } from './modules/memory';
import { backfillEntities } from './modules/entities';
import { runDeadlineSweep } from './modules/automations';

async function main() {
  console.log(`[boot] Agentic OS Kernel v${config.version} starting…`);

  // 1) DATA LAYER
  const db = config.databaseUrl
    ? new PgDataPort(config.databaseUrl)
    : new SqliteDataPort(config.sqliteFile);
  console.log(`[boot] data: ${db.kind}`);

  // 2) BROKER
  const broker = createBroker(config.redisUrl);
  console.log(`[boot] broker: ${broker.kind}`);

  // 3) MIGRATIONS
  const applied = await runMigrations(db);
  console.log(`[boot] migrations: ${applied.length ? applied.join(', ') : 'up to date'}`);

  // 3b) VECTOR INDEX (Phase 5) — pgvector when DATABASE_URL points at a
  //     pgvector Postgres, local cosine otherwise. Embedding provider is
  //     env-configurable (OPENAI_EMBED_*) but defaults to the local hash.
  const vec = createVectorIndex(db, {
    embedBaseUrl: process.env.OPENAI_EMBED_BASE_URL,
    embedApiKey: process.env.OPENAI_EMBED_API_KEY ?? config.openai.apiKey,
    embedModel: process.env.OPENAI_EMBED_MODEL,
  });
  setVectorIndex(vec);
  const vecStats = vec.stats();
  console.log(`[boot] vector index: ${vecStats.kind} (dim ${vecStats.dim}, provider ${vecStats.provider})${vec.native() ? ' — ANN active' : ''}`);

  // 4) EVENT BUS
  const bus = new EventBus(db, broker);

  // 5) MODEL GATEWAY
  const router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  if (config.openai.baseUrl && config.openai.apiKey) {
    router.register(new OpenAICompatProvider(config.openai.baseUrl, config.openai.apiKey, config.openai.models));
    console.log(`[boot] model gateway: openai-compat @ ${config.openai.baseUrl} (${config.openai.models.join(', ')})`);
  } else {
    console.log('[boot] model gateway: no OPENAI config → builtin deterministic models only');
  }
  if (config.ollama.baseUrl) {
    router.register(new OllamaProvider(config.ollama.baseUrl));
    console.log(`[boot] model gateway: ollama @ ${config.ollama.baseUrl}`);
  }
  if (config.gemini.apiKey) {
    router.register(new GeminiProvider(config.gemini.apiKey, config.gemini.baseUrl, config.gemini.models));
    console.log(`[boot] model gateway: gemini${config.gemini.models.length ? ` (filter: ${config.gemini.models.join(', ')})` : ' (auto-discover)'}`);
  }
  const boot = await router.bootstrap();
  console.log(`[boot] providers: ${boot.providers.map((p: any) => `${p.id}=${p.status}(${p.models})`).join(' ')}`);

  // 6) TOOLS
  const tools = new ToolRegistry();
  for (const t of createBuiltinTools(db)) tools.register(t);

  // 7) RUNTIME
  const runtime = new AgentRuntime(db, broker, bus, router, tools);
  setRuntimeRef(runtime); // Phase 3: tools (agent.delegate/message) need the runtime

  // 7a) FLOW ENGINE (Phase 7) — long-running flow executions on the same bus
  const flowEngine = new FlowEngine({ db, bus, runtime, tools });

  // 7a-b) AUTOMATION ENGINE (Phase 8) — cron/event/webhook triggers on the bus
  const automationEngine = new AutomationEngine({ db, bus, runtime, flows: flowEngine });
  await automationEngine.start();
  const autoCount = Number((await db.query<any>('SELECT COUNT(*) AS n FROM automations WHERE enabled = 1'))[0]?.n ?? 0);
  console.log(`[boot] automations: ${autoCount} enabled (cron ticker + event subscriptions + webhook intake live)`);

  // 7a-c) INTEGRATIONS (Phase 9) — GitHub/Gmail/Slack adapters + secret vault
  const integrationsService = new IntegrationService({ db, bus });
  const integrationsOn = Number((await db.query<any>("SELECT COUNT(*) AS n FROM integrations WHERE status = 'connected'"))[0]?.n ?? 0);
  console.log(`[boot] integrations: ${integrationsService.listAdapters().map(a => a.id).join(', ')} adapters registered${integrationsOn ? `, ${integrationsOn} connected` : ''} — vault ${process.env.INTEGRATION_VAULT_KEY ? 'key from env' : 'auto-generated key file'}`);

  // 7a-d) NOTIFICATION ROUTER (Phase 10) — in-app + browser push channels
  await startNotificationRouter({
    db, broker, dataDir: config.dataDir,
    onPushed: ({ pushed }) => bus.emit('notification.push.sent', { pushed } as any, { actor_type: 'system' }).catch(() => {}),
  });
  const pushSubs = Number((await db.query<any>('SELECT COUNT(*) AS n FROM push_subscriptions'))[0]?.n ?? 0);
  console.log(`[boot] notification router: in-app + browser push${pushSubs ? ` (${pushSubs} subscription(s))` : ' (no browsers subscribed yet)'}`);

  // 7a-e) GRAPH DERIVATION (Phase 11) — co-occurrence links from memory_entities
  const derived = await deriveCoOccurrenceLinks(db);
  if (derived.links_created || derived.links_removed) {
    console.log(`[boot] graph: derived ${derived.links_created} new co-occurrence link(s)${derived.links_removed ? `, removed ${derived.links_removed} stale` : ''}`);
  }

  // 7b) BOOT RECOVERY — executions orphaned by a previous process crash
  const recovered = await runtime.recoverInterrupted();
  if (recovered > 0) console.log(`[boot] recovery: ${recovered} interrupted execution(s) marked resumable`);
  const recoveredFlows = await flowEngine.recoverInterrupted();
  if (recoveredFlows > 0) console.log(`[boot] recovery: ${recoveredFlows} interrupted flow run(s) marked resumable`);

  // 7c) ENTITY BACKFILL (Phase 5) — extract entities from memories that
  //     predate this phase (idempotent; only processes unlinked memories)
  const backfill = await backfillEntities(db, 200);
  if (backfill.processed > 0) {
    console.log(`[boot] entity backfill: ${backfill.processed} memories scanned → ${backfill.entities} entities (${backfill.memories} distinct)`);
  }

  // 8) API
  const app = buildApi({ db, broker, bus, router, runtime, tools, flowEngine, automationEngine, integrationsService });

  // 9) SEED (idempotent — first boot only)
  const seedRes = await seed(db, bus);
  if (seedRes.created) console.log(`[boot] seed: admin user + ${seedRes.agents} agents + ${seedRes.skills} skills`);

  // 10) HEALTH REFRESH LOOP (providers re-probed every 60s)
  setInterval(() => router.refreshHealth().catch(() => {}), 60000);

  // 10b) DEADLINE AUTOMATIONS (Phase 6) — overdue/due-soon/missed-milestone
  //      sweep every 60s; alerts deduped through the deadline_alerts ledger
  const firstSweep = await runDeadlineSweep(db, bus).catch(() => null);
  if (firstSweep && (firstSweep.overdue_alerts || firstSweep.due_soon_alerts || firstSweep.milestones_missed)) {
    console.log(`[boot] deadline automations: ${firstSweep.overdue_alerts} overdue, ${firstSweep.due_soon_alerts} due-soon, ${firstSweep.milestones_missed} milestones missed`);
  }
  setInterval(() => runDeadlineSweep(db, bus).catch(() => {}), 60000);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  await bus.emit('system.ready', { version: config.version, port: config.port }, { actor_type: 'system' });
  console.log(`[boot] Agentic OS API listening on http://localhost:${config.port}`);
  console.log('[boot] login: admin / admin123 (seed default, change via .env)');
}

main().catch((e) => {
  console.error('[boot] FATAL', e);
  process.exit(1);
});
