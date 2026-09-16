/**
 * notifications routes — extracted verbatim from app.ts (v0.17.0 split).
 * Bodies are unchanged; deps arrive via RouteContext.
 */
import * as store from '../modules/store';
import * as notify from '../modules/notify';
import { config } from '../config';
import { DashboardLayoutInput, NotificationPrefsInput, PushSubscriptionInput } from '@agentic/contracts';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

export function registerNotificationsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, bus } = ctx;

// ─── notifications ─────────────────────────────────────────────────────────
app.get('/api/notifications', async (req: any) =>
  store.listNotifications(db, req.user.id, req.query?.status ?? undefined));
app.post('/api/notifications/:id/read', async (req: any) => {
  await db.run('UPDATE notifications SET status = ? WHERE id = ?', ['read', req.params.id]);
  return { ok: true };
});

// ─── Phase 10: dashboard layout (configurable grid) ─────────────────────────
app.get('/api/dashboard/layout', async (req: any) => ({
  layout: await notify.getLayout(db, req.user.id),
  registry: notify.WIDGET_REGISTRY,
}));
app.put('/api/dashboard/layout', async (req: any, reply: any) => {
  const parsed = DashboardLayoutInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid layout', details: parsed.error.flatten() });
  // duplicate widget instance ids break React keys — reject early
  const ids = parsed.data.widgets.map(w => w.id);
  if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'duplicate widget ids in layout' });
  const layout = await notify.setLayout(db, req.user.id, parsed.data.widgets as any);
  await bus.emit('widget.layout.updated', { widgets: layout.widgets.length },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'user', target_id: req.user.id });
  return layout;
});
app.post('/api/dashboard/layout/reset', async (req: any) =>
  notify.setLayout(db, req.user.id, notify.DEFAULT_LAYOUT));

// ─── Phase 10: notification prefs + browser push channel ────────────────────
app.get('/api/notifications/prefs', async (req: any) =>
  notify.getPrefs(db, req.user.id));
app.put('/api/notifications/prefs', async (req: any, reply: any) => {
  const parsed = NotificationPrefsInput.safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'invalid prefs', details: parsed.error.flatten() });
  return notify.setPrefs(db, req.user.id, parsed.data as any);
});
// browser registers the PushSubscription after the service worker opts in
app.get('/api/notifications/push/vapid', async () => ({
  publicKey: notify.getVapidKeys(config.dataDir).publicKey,
}));
app.post('/api/notifications/push/subscribe', async (req: any, reply: any) => {
  const parsed = PushSubscriptionInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid subscription', details: parsed.error.flatten() });
  await notify.addPushSubscription(db, req.user.id, parsed.data as any);
  // subscribing implies the user wants the channel on
  const prefs = await notify.setPrefs(db, req.user.id, { browser_push: true });
  return { subscribed: true, prefs };
});
app.post('/api/notifications/push/unsubscribe', async (req: any, reply: any) => {
  const endpoint = String(req.body?.endpoint ?? '');
  if (!endpoint) return reply.code(400).send({ error: 'endpoint required' });
  await notify.removePushSubscription(db, endpoint);
  const subs = await notify.listPushSubscriptions(db, req.user.id);
  const prefs = subs.length === 0
    ? await notify.setPrefs(db, req.user.id, { browser_push: false })
    : await notify.getPrefs(db, req.user.id);
  return { unsubscribed: true, prefs };
});
app.get('/api/notifications/push/subscriptions', async (req: any) =>
  notify.listPushSubscriptions(db, req.user.id));
// test fire through the whole pipeline (row → bus → router → channels)
app.post('/api/notifications/push/test', async (req: any) => {
  const n = await store.notify(db, {
    user_id: req.user.id, title: 'Push test',
    message: 'If your browser is subscribed, this appears as a native notification.',
    priority: 'high', category: 'system', source: 'push-test',
  });
  await bus.emit('notification.created', { id: n.id, title: n.title },
    { actor_type: 'user', actor_id: req.user.id, target_type: 'notification', target_id: n.id });
  return { sent: n.id, note: 'in-app row created; browser push fan-out respects your prefs' };
});
}
