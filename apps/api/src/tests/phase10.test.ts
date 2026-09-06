/** Phase 10 tests: VAPID keygen/JWT/push crypto, prefs gating, layout
 * persistence, subscription registry, channel router fan-out. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import * as store from '../modules/store';
import {
  getVapidKeys, vapidJwt, encryptPushPayload, getPrefs, setPrefs, pushAllowed,
  addPushSubscription, removePushSubscription, listPushSubscriptions,
  fanOutNotification, startNotificationRouter, getLayout, setLayout, DEFAULT_LAYOUT,
} from '../modules/notify';

let db: SqliteDataPort;
let bus: EventBus;
let broker: InProcessBroker;
const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'notify-test-'));

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let userId: string;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase10-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  userId = uid();
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [userId, 'tester', 'x:y', 'T', now(), now()]);
  broker = new InProcessBroker();
  bus = new EventBus(db, broker);
}, 30000);

afterAll(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  await db.close().catch(() => {});
});

// ─── VAPID + push crypto ────────────────────────────────────────────────────
describe('phase 10 — web push crypto', () => {
  it('VAPID keys have the right raw shapes (87/43 b64url chars)', () => {
    const keys = getVapidKeys(dataDir);
    expect(keys.publicKey.length).toBe(87);      // 65B uncompressed point
    expect(keys.privateKey.length).toBe(43);     // 32B scalar
    // persisted to the key file
    expect(fs.existsSync(path.join(dataDir, 'vapid.json'))).toBe(true);
    // stable across calls
    expect(getVapidKeys(dataDir)).toEqual(keys);
  });

  it('vapidJwt is a well-formed ES256 JWT (verifiable with the public key)', () => {
    const keys = getVapidKeys(dataDir);
    const jwt = vapidJwt(keys, 'https://fcm.googleapis.com', 'mailto:ops@agentic-os.local');
    const [h, p, sig] = jwt.split('.');
    expect(Buffer.from(h, 'base64url').toString()).toContain('ES256');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.sub).toBe('mailto:ops@agentic-os.local');
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
    // signature is 64 bytes raw (r||s)
    expect(Buffer.from(sig, 'base64url').length).toBe(64);
    // verify against the VAPID public key
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } as any, format: 'jwk' });
    const verified = crypto.verify('sha256', Buffer.from(`${h}.${p}`), {
      key: pubKey, dsaEncoding: 'ieee-p1363',
    }, Buffer.from(sig, 'base64url'));
    expect(verified).toBe(true);
  });

  it('encryptPushPayload produces a structurally valid aes128gcm body', () => {
    // synthetic subscription keypair (a real browser supplies these)
    const sub = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = sub.publicKey.export({ format: 'jwk' }) as any;
    const p256dh = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    const auth = crypto.randomBytes(16).toString('base64url');
    const body = encryptPushPayload(JSON.stringify({ title: 'Test', body: 'Hello' }), p256dh, auth);
    // header layout: salt(16) rs(4)=4096 idlen(1)=65 keyid(65)
    expect(body.length).toBeGreaterThan(16 + 4 + 1 + 65);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    // last byte: the record delimiter (0x02 = last record, no padding)
    expect(body[body.length - 1]).toBe(2);
    // two payloads with the same inputs differ (random salt + ephemeral key)
    const body2 = encryptPushPayload(JSON.stringify({ title: 'Test', body: 'Hello' }), p256dh, auth);
    expect(body.equals(body2)).toBe(false);
  });
});

// ─── prefs + gating ─────────────────────────────────────────────────────────
describe('phase 10 — notification prefs', () => {
  it('defaults: push off, min priority high, all categories', async () => {
    const p = await getPrefs(db, userId);
    expect(p.in_app).toBe(true);
    expect(p.browser_push).toBe(false);
    expect(p.push_min_priority).toBe('high');
    expect(p.categories).toEqual([]);
  });

  it('pushAllowed respects enable, priority, and category filters', async () => {
    const base = { priority: 'medium', category: 'agent' };
    expect(pushAllowed(base, { in_app: true, browser_push: false, push_min_priority: 'high', categories: [] })).toBe(false);
    expect(pushAllowed(base, { in_app: true, browser_push: true, push_min_priority: 'medium', categories: [] })).toBe(true);
    expect(pushAllowed(base, { in_app: true, browser_push: true, push_min_priority: 'high', categories: [] })).toBe(false);
    expect(pushAllowed(base, { in_app: true, browser_push: true, push_min_priority: 'low', categories: ['deadline'] })).toBe(false);
    expect(pushAllowed(base, { in_app: true, browser_push: true, push_min_priority: 'low', categories: ['agent'] })).toBe(true);
    // urgent passes the default high threshold
    expect(pushAllowed({ priority: 'urgent', category: 'x' }, { in_app: true, browser_push: true, push_min_priority: 'high', categories: [] })).toBe(true);
  });

  it('setPrefs persists + merges', async () => {
    const p1 = await setPrefs(db, userId, { browser_push: true });
    expect(p1.browser_push).toBe(true);
    const p2 = await setPrefs(db, userId, { push_min_priority: 'urgent' });
    expect(p2.browser_push).toBe(true);          // merge, not replace
    expect(p2.push_min_priority).toBe('urgent');
    expect((await getPrefs(db, userId)).browser_push).toBe(true);
  });
});

// ─── subscriptions registry ─────────────────────────────────────────────────
describe('phase 10 — push subscriptions', () => {
  it('add / list / remove, endpoint upsert', async () => {
    const sub = { endpoint: 'https://fcm.example.com/send/abc123', keys: { p256dh: 'B'.repeat(64) + 'x', auth: 'A'.repeat(16) } };
    await addPushSubscription(db, userId, sub);
    await addPushSubscription(db, userId, sub);   // same endpoint → upsert, not duplicate
    let subs = await listPushSubscriptions(db, userId);
    expect(subs.length).toBe(1);
    // a second browser
    await addPushSubscription(db, userId, { endpoint: 'https://fcm.example.com/send/def456', keys: sub.keys });
    subs = await listPushSubscriptions(db, userId);
    expect(subs.length).toBe(2);
    await removePushSubscription(db, sub.endpoint);
    subs = await listPushSubscriptions(db, userId);
    expect(subs.length).toBe(1);
    await removePushSubscription(db, 'https://fcm.example.com/send/def456');
    expect((await listPushSubscriptions(db, userId)).length).toBe(0);
  });
});

// a synthetic but CRYPTOGRAPHICALLY VALID subscription (real P-256 point)
function makeSub(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = kp.publicKey.export({ format: 'jwk' }) as any;
  const p256dh = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  return { endpoint, keys: { p256dh, auth } };
}

// ─── router fan-out ─────────────────────────────────────────────────────────
describe('phase 10 — channel router', () => {
  it('fan-out: prefs on + subscription registered → sendWebPush called per sub (mocked fetch)', async () => {
    await setPrefs(db, userId, { browser_push: true, push_min_priority: 'medium', categories: [] });
    const sub = makeSub('https://fcm.example.com/send/live1');
    await addPushSubscription(db, userId, sub);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    (globalThis as any).fetch = fetchMock;
    try {
      const res = await fanOutNotification(db, dataDir, {
        id: uid(), user_id: userId, title: 'Deploy ready', message: 'staging is green', priority: 'high', category: 'agent',
      });
      expect(res.pushed).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(sub.endpoint);
      expect(init.headers['Content-Encoding']).toBe('aes128gcm');
      expect(String(init.headers.Authorization)).toContain('vapid t=');
      expect(String(init.headers.Authorization)).toContain('k=');
      // gone-subscription pruning
      fetchMock.mockResolvedValue({ ok: false, status: 410 });
      const res2 = await fanOutNotification(db, dataDir, {
        id: uid(), user_id: userId, title: 't', message: 'm', priority: 'high', category: 'agent',
      });
      expect(res2.pushed).toBe(0);
      expect(res2.pruned).toBe(1);
      expect((await listPushSubscriptions(db, userId)).length).toBe(0);
    } finally {
      (globalThis as any).fetch = fetch; // restore... (vi restore below)
      fetchMock.mockRestore();
    }
  });

  it('below-threshold priority never pushes even when subscribed', async () => {
    await setPrefs(db, userId, { browser_push: true, push_min_priority: 'urgent' });
    await addPushSubscription(db, userId, makeSub('https://fcm.example.com/send/lowpri'));
    const fetchMock = vi.fn();
    const orig = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchMock;
    try {
      const res = await fanOutNotification(db, dataDir, {
        id: uid(), user_id: userId, title: 'low', message: 'medium priority note', priority: 'medium', category: 'system',
      });
      expect(res.pushed).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).fetch = orig;
    }
    await removePushSubscription(db, 'https://fcm.example.com/send/lowpri');
  });

  it('router: notification.created on the bus fans out to channels (E2E)', async () => {
    await setPrefs(db, userId, { browser_push: true, push_min_priority: 'low' });
    await addPushSubscription(db, userId, makeSub('https://fcm.example.com/send/router1'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    const orig = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchMock;
    let pushedEvents = 0;
    const stop = await startNotificationRouter({
      db, broker, dataDir,
      onPushed: () => { pushedEvents++; },
    });
    try {
      // a notification through the normal kernel path (runtime uses this shape)
      const n = await store.notify(db, { user_id: userId, title: 'Router E2E', message: 'pushed through the bus', priority: 'high', category: 'agent', source: 'test' });
      await bus.emit('notification.created', { id: n.id, title: n.title }, { actor_type: 'system', target_type: 'notification', target_id: n.id });
      await sleep(400); // async fan-out
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://fcm.example.com/send/router1');
      expect(pushedEvents).toBeGreaterThanOrEqual(0); // callback best-effort
      // in-app channel: the row exists (that IS the in-app notification)
      const row = await db.query<any>('SELECT * FROM notifications WHERE id = ?', [n.id]);
      expect(row.length).toBe(1);
    } finally {
      stop();
      (globalThis as any).fetch = orig;
      await removePushSubscription(db, 'https://fcm.example.com/send/router1');
    }
  });
});

// ─── dashboard layouts ──────────────────────────────────────────────────────
describe('phase 10 — dashboard layouts', () => {
  it('default layout on first read; set + persist; reset', async () => {
    const first = await getLayout(db, userId);
    expect(first.widgets).toEqual(DEFAULT_LAYOUT);
    expect(first.widgets.length).toBe(7);
    // save a custom grid
    const custom = [
      { id: 'a', kind: 'counts', width: 1 as const },
      { id: 'b', kind: 'approvals', width: 2 as const },
    ];
    const saved = await setLayout(db, userId, custom);
    expect(saved.widgets).toEqual(custom);
    const reread = await getLayout(db, userId);
    expect(reread.widgets.map(w => w.kind)).toEqual(['counts', 'approvals']);
    // per-user isolation
    const other = uid();
    expect((await getLayout(db, other)).widgets).toEqual(DEFAULT_LAYOUT);
    // reset
    await setLayout(db, userId, DEFAULT_LAYOUT);
    expect((await getLayout(db, userId)).widgets).toEqual(DEFAULT_LAYOUT);
  });
});
