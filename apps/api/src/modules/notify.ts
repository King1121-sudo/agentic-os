/**
 * Notifications + Widgets (Phase 10, §19/§20).
 *
 * 1. Web Push (browser channel): RFC 8291/8292 — VAPID P-256 keypair, ES256
 *    JWT auth header, aes128gcm content encoding for the payload. Zero
 *    dependencies: Node stdlib crypto implements the entire protocol. The
 *    browser registers a service worker (apps/web/public/sw.js) that displays
 *    the notifications.
 *
 * 2. Notification router: every notification created via store.notify() is
 *    ALSO fanned out to the user's enabled channels. In-app is the existing
 *    bell/ledger. Browser push goes to every registered subscription of the
 *    user, gated by their prefs (min priority + category allowlist).
 *
 * 3. Dashboard layouts: per-user widget grids persisted as a JSON array
 *    (id, kind, width); the UI renders exactly the saved order. A default
 *    layout is seeded on first read.
 */
import * as crypto from 'crypto';
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import { safeJson } from '../kernel/bus';
import type { DashboardLayout, DashboardWidget, NotificationPrefs, NotificationRecord } from '@agentic/contracts';

// ─── VAPID keypair (RFC 8292) ───────────────────────────────────────────────

export interface VapidKeys { publicKey: string; privateKey: string }

let vapidKeys: VapidKeys | null = null;

/** Load from env (base64url uncompressed P-256 point + raw private scalar) or
 *  generate + persist to <dataDir>/vapid.json on first use. */
export function getVapidKeys(dataDir: string): VapidKeys {
  if (vapidKeys) return vapidKeys;
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    vapidKeys = { publicKey: envPub, privateKey: envPriv };
    return vapidKeys;
  }
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) {
    vapidKeys = JSON.parse(fs.readFileSync(file, 'utf8'));
    return vapidKeys!;
  }
  // generate: P-256 keypair; export the raw uncompressed public point (65B)
  // and the raw private scalar (32B), both base64url — the Web Push convention.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' }) as any;
  const privJwk = privateKey.export({ format: 'jwk' }) as any;
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x, 'base64url'),
    Buffer.from(pubJwk.y, 'base64url'),
  ]);
  vapidKeys = {
    publicKey: raw.toString('base64url'),
    privateKey: Buffer.from(privJwk.d, 'base64url').toString('base64url'),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(vapidKeys), { mode: 0o600 });
  return vapidKeys;
}

// ─── Web Push send (RFC 8291 aes128gcm + RFC 8292 VAPID JWT) ────────────────

function b64u(buf: Buffer): string { return buf.toString('base64url').replace(/=+$/, ''); }

/** ES256 JWT for the Authorization: vapid header. (exported for tests) */
export function vapidJwt(keys: VapidKeys, audience: string, subject: string, expiryS = 12 * 3600): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + expiryS,
    sub: subject,
  })));
  const signingInput = `${header}.${payload}`;
  // reconstruct the P-256 JWK from the stored raw keys (uncompressed point + scalar)
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'),
    y: pub.subarray(33, 65).toString('base64url'),
    d: keys.privateKey,
  };
  const der = crypto.createSign('SHA256').update(signingInput).sign(crypto.createPrivateKey({ key: jwk as any, format: 'jwk' }));
  // DER ECDSA signature → raw r||s (64 bytes)
  let r: Buffer, s: Buffer;
  if (der.length === 72) { r = der.subarray(8, 8 + 32); s = der.subarray(der.length - 32); }
  else {
    // generic DER sequence parse (short ints may drop leading zeros)
    let i = 2;
    const rLen = der[i + 1];
    const rStart = rLen === 33 ? i + 3 : i + 2;
    r = der.subarray(rStart, rStart + 32);
    i = rStart + 32;
    const sLen = der[i + 1];
    const sStart = sLen === 33 ? i + 3 : i + 2;
    s = der.subarray(sStart, sStart + 32);
  }
  const rawSig = b64u(Buffer.concat([r, s]));
  return `${signingInput}.${rawSig}`;
}

/** aes128gcm content-encoding (RFC 8291 §2) with a random 16-byte salt. */
export function encryptPushPayload(payload: string, p256dh: string, auth: string): Buffer {
  const keyInfo = Buffer.from('Web-Push: key\r\n');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\r\n');
  const authSecret = Buffer.from(auth, 'base64url');
  const asPubKey = Buffer.from(p256dh, 'base64url');

  // ECDH on the subscription's public key with a fresh ephemeral P-256 pair
  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdh = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: asPubKey.subarray(1, 33).toString('base64url'), y: asPubKey.subarray(33).toString('base64url') } as any, format: 'jwk' }),
  }) as Buffer;

  // HKDF outputs ArrayBuffers in this Node version — coerce once
  const asBuf = (a: unknown) => Buffer.from(a as ArrayBuffer);
  const ikm = asBuf(crypto.hkdfSync('sha256', ecdh, authSecret, Buffer.from('Web-Push: auth\r\n'), 32));
  const salt = crypto.randomBytes(16);
  // RFC 8291: PRK key/nonce derivation uses (ikm || 0x01) via HKDF expand
  const cek = asBuf(crypto.hkdfSync('sha256', Buffer.concat([ikm, Buffer.from([1])]), salt, keyInfo, 16));
  const nonce = asBuf(crypto.hkdfSync('sha256', Buffer.concat([ikm, Buffer.from([2])]), salt, nonceInfo, 12));

  const ephemeralPub = (ephemeral.publicKey.export({ format: 'jwk' }) as any);
  const rawEph = Buffer.concat([Buffer.from([0x04]), Buffer.from(ephemeralPub.x, 'base64url'), Buffer.from(ephemeralPub.y, 'base64url')]);

  // aes128gcm header: salt(16) | rs(4, big-endian, 4096) | idlen(1=65) | keyid(65)
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([65]), rawEph]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const padding = Buffer.from([2]); // one delimiter byte = last record
  return Buffer.concat([header, ciphertext, tag, padding]);
}

/** Push one payload to one subscription endpoint. Returns 2xx/4xx/410 info. */
export async function sendWebPush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: { title: string; body: string; url?: string },
  keys: VapidKeys,
): Promise<{ ok: boolean; status: number; gone?: boolean }> {
  const body = encryptPushPayload(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  const audience = new URL(sub.endpoint).origin;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@agentic-os.local';
  const auth = `vapid t=${vapidJwt(keys, audience, subject)}, k=${keys.publicKey}`;
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(body.length),
        TTL: '60',
        Urgency: 'high',
        Authorization: auth,
      },
      body,
    });
    // 404/410 = subscription gone → caller should prune it
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e: any) {
    return { ok: false, status: 0 };
  }
}

// ─── channel router ─────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, urgent: 3 };
export const DEFAULT_PREFS: NotificationPrefs = {
  in_app: true, browser_push: false, push_min_priority: 'high', categories: [],
};

export async function getPrefs(db: DataPort, userId: string): Promise<NotificationPrefs> {
  const rows = await db.query<any>('SELECT prefs FROM notification_prefs WHERE user_id = ?', [userId]);
  return rows[0] ? { ...DEFAULT_PREFS, ...safeJson(rows[0].prefs) } : DEFAULT_PREFS;
}

export async function setPrefs(db: DataPort, userId: string, patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  const current = await getPrefs(db, userId);
  const next: NotificationPrefs = { ...current, ...patch };
  await db.run(
    'INSERT INTO notification_prefs (user_id, prefs, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at',
    [userId, JSON.stringify(next), iso()]);
  return next;
}

/** Should this notification reach the browser-push channel per the user's prefs? */
export function pushAllowed(n: { priority: string; category: string }, prefs: NotificationPrefs): boolean {
  if (!prefs.browser_push) return false;
  if ((PRIORITY_RANK[n.priority] ?? 0) < (PRIORITY_RANK[prefs.push_min_priority] ?? 2)) return false;
  if (prefs.categories.length > 0 && !prefs.categories.includes(n.category)) return false;
  return true;
}

/** Push subscriptions registry. */
export async function addPushSubscription(
  db: DataPort, userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<void> {
  await db.run(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, keys, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys',
    [uuid(), userId, sub.endpoint, JSON.stringify(sub.keys), iso()]);
}

export async function removePushSubscription(db: DataPort, endpoint: string): Promise<void> {
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

export async function listPushSubscriptions(db: DataPort, userId: string): Promise<{ id: string; endpoint: string }[]> {
  return db.query<any>('SELECT id, endpoint FROM push_subscriptions WHERE user_id = ?', [userId]);
}

/** Fan out a notification to the user's channels. Called by the notifier
 *  wrapper below — the in-app row already exists at this point. */
export async function fanOutNotification(
  db: DataPort, dataDir: string, n: { id: string; user_id: string; title: string; message: string; priority: string; category: string },
): Promise<{ pushed: number; pruned: number }> {
  const prefs = await getPrefs(db, n.user_id);
  if (!pushAllowed(n, prefs)) return { pushed: 0, pruned: 0 };
  const keys = getVapidKeys(dataDir);
  const subs = await db.query<any>('SELECT * FROM push_subscriptions WHERE user_id = ?', [n.user_id]);
  let pushed = 0, pruned = 0;
  for (const s of subs) {
    const k = safeJson(s.keys);
    const r = await sendWebPush({ endpoint: s.endpoint, keys: k }, {
      title: n.title.slice(0, 120), body: n.message.slice(0, 240), url: '/?focus=notifications',
    }, keys);
    if (r.gone) { await removePushSubscription(db, s.endpoint); pruned++; continue; }
    if (r.ok) pushed++;
  }
  return { pushed, pruned };
}

/**
 * Notification channel router: subscribes to `notification.created` on the
 * broker (the same channel automations use) and fans each notification out to
 * the user's enabled channels — browser push (Web Push, prefs-gated). The
 * in-app channel is the notification row itself (already persisted by
 * store.notify before the event fires). Failures never break the emitter.
 */
export async function startNotificationRouter(deps: {
  db: DataPort; broker: { subscribe(channel: string, handler: (ch: string, payload: unknown) => void): Promise<() => void> }; dataDir: string; onPushed?: (info: { pushed: number }) => void;
}): Promise<() => void> {
  const { CHANNEL } = await import('../kernel/bus');
  return deps.broker.subscribe(CHANNEL, (_ch: string, payload: unknown) => {
    const ev = payload as { type?: string; data?: { id?: string } };
    if (ev?.type !== 'notification.created' || !ev.data?.id) return;
    // async fire-and-forget — a push failure must never break the bus
    (async () => {
      try {
        const rows = await deps.db.query<any>('SELECT * FROM notifications WHERE id = ?', [ev.data!.id]);
        const n = rows[0];
        if (!n) return;
        const res = await fanOutNotification(deps.db, deps.dataDir, n);
        if (res.pushed > 0 && deps.onPushed) deps.onPushed({ pushed: res.pushed });
      } catch { /* isolated */ }
    })();
  });
}

// ─── dashboard layouts ──────────────────────────────────────────────────────

export const DEFAULT_LAYOUT: DashboardWidget[] = [
  { id: 'w-agents', kind: 'agent-presence', width: 2 },
  { id: 'w-health', kind: 'system-health', width: 1 },
  { id: 'w-tasks', kind: 'open-tasks', width: 1 },
  { id: 'w-projects', kind: 'projects', width: 1 },
  { id: 'w-notes', kind: 'unread-notes', width: 1 },
  { id: 'w-activity', kind: 'recent-activity', width: 2 },
  { id: 'w-actions', kind: 'quick-actions', width: 1 },
];

/** The widget registry the UI's "add widget" picker renders. */
export const WIDGET_REGISTRY: { kind: DashboardWidget['kind']; name: string; description: string; defaultWidth: 1 | 2 | 3 }[] = [
  { kind: 'agent-presence', name: 'Agent Presence', description: 'Live agent roster and statuses', defaultWidth: 2 },
  { kind: 'system-health', name: 'System Health', description: 'DB, broker, providers, counts', defaultWidth: 1 },
  { kind: 'open-tasks', name: "Today's Tasks", description: 'Open and in-progress tasks', defaultWidth: 1 },
  { kind: 'projects', name: 'Projects', description: 'Project workspaces', defaultWidth: 1 },
  { kind: 'unread-notes', name: 'Unread Notifications', description: 'The notification inbox', defaultWidth: 1 },
  { kind: 'recent-activity', name: 'Recent Activity', description: 'The live event stream', defaultWidth: 2 },
  { kind: 'quick-actions', name: 'Quick Actions', description: 'One-click commands', defaultWidth: 1 },
  { kind: 'counts', name: 'Kernel Counts', description: 'Executions, memories, generations', defaultWidth: 1 },
  { kind: 'approvals', name: 'Pending Approvals', description: 'Approval gate queue', defaultWidth: 1 },
  { kind: 'automations', name: 'Automations', description: 'Enabled triggers and recent fires', defaultWidth: 1 },
];

export async function getLayout(db: DataPort, userId: string): Promise<DashboardLayout> {
  const rows = await db.query<any>('SELECT widgets, updated_at FROM dashboard_layouts WHERE user_id = ?', [userId]);
  if (rows[0]) return { widgets: safeJson(rows[0].widgets), updated_at: rows[0].updated_at };
  return { widgets: DEFAULT_LAYOUT, updated_at: iso() };
}

export async function setLayout(db: DataPort, userId: string, widgets: DashboardWidget[]): Promise<DashboardLayout> {
  await db.run(
    'INSERT INTO dashboard_layouts (user_id, widgets, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET widgets = excluded.widgets, updated_at = excluded.updated_at',
    [userId, JSON.stringify(widgets), iso()]);
  return { widgets, updated_at: iso() };
}
