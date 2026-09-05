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
import { buildApi } from './app';
import { seed } from './seed';

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

  // 7b) BOOT RECOVERY — executions orphaned by a previous process crash
  const recovered = await runtime.recoverInterrupted();
  if (recovered > 0) console.log(`[boot] recovery: ${recovered} interrupted execution(s) marked resumable`);

  // 8) API
  const app = buildApi({ db, broker, bus, router, runtime, tools });

  // 9) SEED (idempotent — first boot only)
  const seedRes = await seed(db, bus);
  if (seedRes.created) console.log(`[boot] seed: admin user + ${seedRes.agents} agents + ${seedRes.skills} skills`);

  // 10) HEALTH REFRESH LOOP (providers re-probed every 60s)
  setInterval(() => router.refreshHealth().catch(() => {}), 60000);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  await bus.emit('system.ready', { version: config.version, port: config.port }, { actor_type: 'system' });
  console.log(`[boot] Agentic OS API listening on http://localhost:${config.port}`);
  console.log('[boot] login: admin / admin123 (seed default, change via .env)');
}

main().catch((e) => {
  console.error('[boot] FATAL', e);
  process.exit(1);
});
