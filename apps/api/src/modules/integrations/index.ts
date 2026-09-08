/**
 * Integration Platform — public surface. Registration of the seven initial
 * providers happens here; the engine (service.ts) knows nothing about them.
 */
export * from './types';
export * from './oauth';
export * from './webhooks';
export * from './sync';
export * from './service';
export * from './rate-limit';
export { RateLimiter } from './rate-limit';

import { IntegrationService } from './service';
export { createIntegrationTools } from './tools';
import {
  GitHubPlatformAdapter, GmailPlatformAdapter, YouTubePlatformAdapter,
  SlackPlatformAdapter, TelegramPlatformAdapter, WhatsAppPlatformAdapter,
  InstagramPlatformAdapter,
} from './providers';

/** The platform with all initial providers registered. */
export function createIntegrationPlatform(deps: { db: any; bus: any }): IntegrationService {
  const service = new IntegrationService(deps);
  service.register(new GitHubPlatformAdapter());
  service.register(new GmailPlatformAdapter());
  service.register(new YouTubePlatformAdapter());
  service.register(new SlackPlatformAdapter());
  service.register(new TelegramPlatformAdapter());
  service.register(new WhatsAppPlatformAdapter());
  service.register(new InstagramPlatformAdapter());
  return service;
}
