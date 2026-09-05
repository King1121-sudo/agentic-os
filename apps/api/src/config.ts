/** Central typed configuration. Every knob is env-overridable, all defaults local. */
import * as path from 'path';
import * as fs from 'fs';

// load .env from repo root or apps/api, whichever exists
for (const p of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
  if (fs.existsSync(p)) { require('dotenv').config({ path: p }); break; }
}

const num = (v: string | undefined, d: number) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const str = (v: string | undefined, d: string) => (v != null && v !== '' ? v : d);

/** Repo-root-relative data dir, stable whether run from repo root, apps/api, or dist. */
const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  port: num(process.env.PORT, 4000),
  corsOrigin: str(process.env.CORS_ORIGIN, 'http://localhost:3000'),
  databaseUrl: process.env.DATABASE_URL ?? '',
  sqliteFile: process.env.SQLITE_FILE ?? path.join(dataDir, 'agentic.db'),
  redisUrl: process.env.REDIS_URL ?? '',
  dataDir,
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL ?? '',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    models: (process.env.OPENAI_MODELS ?? 'gpt-4o-mini,gpt-4o').split(',').map(s => s.trim()).filter(Boolean),
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com',
    models: (process.env.GEMINI_MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  },
  ollama: { baseUrl: process.env.OLLAMA_BASE_URL ?? '' },
  approvalTimeoutS: num(process.env.APPROVAL_TIMEOUT_S, 300),
  stepRetries: num(process.env.AGENTIC_STEP_RETRIES, 1),
  maxDelegationDepth: num(process.env.AGENTIC_MAX_DELEGATION_DEPTH, 2),
  seedAdmin: { username: str(process.env.SEED_ADMIN_USER, 'admin'), password: str(process.env.SEED_ADMIN_PASSWORD, 'admin123') },
  allowShell: str(process.env.AGENTIC_ALLOW_SHELL, '0') === '1',
  version: '0.3.0',
};
