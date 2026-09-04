/**
 * BrokerPort adapters.
 *  - InProcessBroker: default; powers SSE within one API process.
 *  - RedisBroker: cross-process pub/sub (optional; enabled by REDIS_URL) so
 *    multiple API instances / future workers share one event stream.
 */
import type { BrokerPort, BrokerHandler } from './types';

export class InProcessBroker implements BrokerPort {
  kind = 'inprocess' as const;
  private subs = new Map<string, Set<BrokerHandler>>();

  async publish(channel: string, payload: unknown): Promise<void> {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const h of [...set]) {
      try { h(channel, payload); } catch { /* isolated */ }
    }
  }

  async subscribe(channel: string, handler: BrokerHandler): Promise<() => void> {
    if (!this.subs.has(channel)) this.subs.set(channel, new Set());
    this.subs.get(channel)!.add(handler);
    return () => { this.subs.get(channel)?.delete(handler); };
  }

  async close(): Promise<void> { this.subs.clear(); }
}

export class RedisBroker implements BrokerPort {
  kind = 'redis' as const;
  private pub: any;
  private sub: any;
  private handlers = new Map<string, Set<BrokerHandler>>();
  private connected = false;

  constructor(private url: string) {}

  private async ensure(): Promise<void> {
    if (this.connected) return;
    const { createClient } = require('redis') as { createClient: (o: any) => any };
    this.pub = createClient({ url: this.url });
    this.sub = createClient({ url: this.url });
    await this.pub.connect();
    await this.sub.connect();
    await this.sub.pSubscribe('*', (message: string, channel: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      let payload: unknown = message;
      try { payload = JSON.parse(message); } catch { /* raw */ }
      for (const h of [...set]) { try { h(channel, payload); } catch { /* isolated */ } }
    });
    this.connected = true;
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.ensure();
    await this.pub.publish(channel, JSON.stringify(payload));
  }

  async subscribe(channel: string, handler: BrokerHandler): Promise<() => void> {
    await this.ensure();
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(handler);
    return () => { this.handlers.get(channel)?.delete(handler); };
  }

  async close(): Promise<void> {
    if (this.connected) { await this.pub?.quit?.(); await this.sub?.quit?.(); }
  }
}

export function createBroker(redisUrl: string): BrokerPort {
  return redisUrl ? new RedisBroker(redisUrl) : new InProcessBroker();
}
