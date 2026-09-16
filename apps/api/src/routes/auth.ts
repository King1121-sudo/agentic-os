/**
 * auth routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as crypto from 'crypto';
import { iso } from '../infra/types';
import * as store from '../modules/store';
import * as memory from '../modules/memory';
import { config } from '../config';
import { verifyPassword } from '../auth.util';
import { LoginInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';
import { SESSION_COOKIE, SESSION_DAYS, getCookie } from './context';

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus } = ctx;

// ─── session auth ─────────────────────────────────────────────────────────
async function currentUser(req: any): Promise<{ id: string; username: string; display_name: string } | null> {
  const sid = getCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const rows = await db.query<any>(
    'SELECT u.id, u.username, u.display_name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
    [sid],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at < iso()) {
    await db.run('DELETE FROM sessions WHERE id = ?', [sid]);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name };
}

app.addHook('preHandler', async (req: any, reply: any) => {
  // public: auth endpoints, health, webhooks (secret-authed), and the OAuth
  // provider callbacks (external redirects carry no session cookie — the
  // one-time state row identifies the user instead)
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/auth') || url.startsWith('/api/health') || url.startsWith('/api/webhooks')) return;
  if (url.includes('/oauth/callback')) return;
  const u = await currentUser(req);
  if (!u) { reply.code(401).send({ error: 'unauthorized' }); return; }
  (req as any).user = u;
});

// ─── auth ──────────────────────────────────────────────────────────────────
// Login throttle: per-username+IP sliding window (5 failures → 10-min lockout).
// In-process on purpose — single-node deployments; swap for Redis when scaled.
const loginFailures = new Map<string, { n: number; first: number; lockUntil?: number }>();
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginKey = (req: any, username: string) => `${username}|${req.ip ?? 'unknown'}`;

app.post('/api/auth/login', async (req: any, reply: any) => {
  const parsed = LoginInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid input', details: parsed.error.flatten() });
  const { username, password } = parsed.data;
  const key = loginKey(req, username);
  const rec = loginFailures.get(key);
  if (rec?.lockUntil && Date.now() < rec.lockUntil) {
    return reply.code(429).send({ error: 'too many failed attempts — try again later' });
  }
  const rows = await db.query<any>('SELECT * FROM users WHERE username = ?', [username]);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    const now = Date.now();
    const cur = rec && now - rec.first < LOGIN_WINDOW_MS ? rec : { n: 0, first: now };
    cur.n += 1;
    if (cur.n >= LOGIN_MAX) cur.lockUntil = now + LOGIN_LOCK_MS;
    loginFailures.set(key, cur);
    return reply.code(401).send({ error: 'invalid credentials' });
  }
  loginFailures.delete(key);
  const sid = crypto.randomBytes(32).toString('hex');    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)', [sid, user.id, iso(), expires]);
  reply.header('set-cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  await store.audit(db, { actor_type: 'user', actor_id: user.id, action: 'user.login', meta: { username } });
  await bus.emit('user.login', { username }, { actor_type: 'user', actor_id: user.id });
  return { id: user.id, username: user.username, display_name: user.display_name };
});

app.post('/api/auth/logout', async (req: any, reply: any) => {
  const sid = getCookie(req, SESSION_COOKIE);
  if (sid) await db.run('DELETE FROM sessions WHERE id = ?', [sid]);
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  return { ok: true };
});

app.get('/api/auth/me', async (req: any) => (req as any).user);

// ─── health / system ──────────────────────────────────────────────────────
app.get('/api/health', async () => {
  const dbUp = await db.health().catch(() => false);
  const count = async (t: string) => Number((await db.query<any>(`SELECT COUNT(*) AS n FROM ${t}`))[0]?.n ?? 0);
  const vec = memory.getVectorIndex();
  return {
    ok: dbUp, version: config.version, time: iso(),
    db: dbUp ? 'up' : 'down', broker: 'up',
    providers: await db.query('SELECT id, name, kind, status FROM model_providers'),
    vector: vec ? vec.stats() : null,           // Phase 5: semantic driver state
    counts: {
      agents: await count('agents'), executions: await count('executions'),
      memories: await count('memories'), tasks: await count('tasks'),
      projects: await count('projects'), generations: await count('generations'),
      events: await count('events'),
      extracted_entities: await count('entities'),
      working_memory_windows: await count('working_memory'),
    },
  };
});
}
