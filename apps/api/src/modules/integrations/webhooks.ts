/**
 * Webhook Gateway (Phase 10) — verify → normalize → dedupe → bus.
 *
 * Provider-agnostic verification schemes; per-connection or env secrets;
 * replay protection via provider source-event-id (fallback: HMAC of
 * provider+body, a stable content identity); one INSERT-decides semantics.
 */
import * as crypto from 'crypto';
import type { DataPort } from '../../infra/types';
import { iso, uuid } from '../../infra/types';
import type { ProviderAdapter, ProviderManifest } from './types';

export interface WebhookResult {
  accepted: boolean;
  event_id?: string;
  event_type?: string;
  reason?: string;
}

/** Verify a provider's webhook signature. Returns false on any mismatch. */
export function verifyWebhookSignature(
  manifest: ProviderManifest, rawBody: string, headers: Record<string, string>, secret: string,
): boolean {
  const wh = manifest.webhook;
  if (!wh) return false;
  const header = headers[wh.signatureHeader] ?? headers[wh.signatureHeader.toLowerCase()] ?? '';
  if (!header) return false;
  if (wh.scheme === 'hmac-sha256') {
    // standard: hex HMAC-SHA256 over the raw body
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return timingSafeEq(header.replace(/^sha256=/, ''), expected);
  }
  if (wh.scheme === 'hmac-sha256-v0') {
    // Slack v0: base64 HMAC-SHA256 over `v0:ts:body`
    const ts = headers['x-slack-request-timestamp'] ?? '';
    const base = `v0:${ts}:${rawBody}`;
    const expected = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
    return timingSafeEq(header, expected);
  }
  if (wh.scheme === 'secret-query') {
    return timingSafeEq(header, secret);
  }
  return false;
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Replay protection: first delivery of a source id wins; later ones are
 *  dropped (idempotent by design — providers retry; we never double-fire). */
export async function claimWebhookEvent(db: DataPort, provider: string, sourceEventId: string): Promise<boolean> {
  try {
    await db.run(
      'INSERT INTO integration_webhook_dedup (source_event_id, provider, received_at) VALUES (?,?,?)',
      [sourceEventId, provider, iso()]);
    return true;
  } catch {
    return false; // PK conflict → already seen
  }
}

/** Full intake pipeline for one verified provider webhook delivery. */
export async function intakeWebhook(
  db: DataPort, adapter: ProviderAdapter, rawBody: string, headers: Record<string, string>, secret: string,
): Promise<WebhookResult> {
  const manifest = adapter.manifest;
  if (!verifyWebhookSignature(manifest, rawBody, headers, secret)) {
    return { accepted: false, reason: 'signature verification failed' };
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch { return { accepted: false, reason: 'malformed JSON' }; }
  const normalized = adapter.normalizeWebhook?.(body, headers);
  if (!normalized) return { accepted: false, reason: 'unrecognized payload' };
  // source id: provider's own id, else stable content hash
  const sourceId = normalized.source_event_id
    ?? crypto.createHash('sha256').update(`${manifest.id}:${rawBody}`).digest('hex');
  if (!(await claimWebhookEvent(db, manifest.id, sourceId))) {
    return { accepted: false, reason: 'duplicate delivery (replay protected)' };
  }
  const eventId = uuid();
  await db.run(
    'INSERT INTO integration_events (id, integration_id, connection_id, kind, payload, received_at) VALUES (?,?,?,?,?,?)',
    [eventId, manifest.id, null, normalized.event_type, JSON.stringify(normalized.payload), iso()]);
  return { accepted: true, event_id: eventId, event_type: normalized.event_type };
}
