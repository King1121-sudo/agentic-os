// Final live check (run via tsx): OAuth consent URL generation, state rows,
// webhook verification, agent tool generation — against a scratch DB.
import { SqliteDataPort } from '../src/infra/sqlite.adapter';
import { runMigrations } from '../src/infra/migrations';
import { InProcessBroker } from '../src/infra/broker';
import { EventBus } from '../src/kernel/bus';
import { createIntegrationPlatform } from '../src/modules/integrations';
import { oauthStart } from '../src/modules/integrations/oauth';
import { gmailManifest, githubManifest } from '../src/modules/integrations/providers';
import { verifyWebhookSignature } from '../src/modules/integrations/webhooks';
import { createIntegrationTools } from '../src/modules/integrations/tools';
import * as crypto from 'crypto';
import * as fs from 'fs';

(async () => {
  process.env.GOOGLE_CLIENT_ID = 'live-test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'live-test-client-secret';
  process.env.GITHUB_CLIENT_ID = 'gh-live-id';
  process.env.GITHUB_CLIENT_SECRET = 'gh-live-secret';
  const file = 'C:/Users/Gurjinder Singh/agentic-os/data/live-oauth-check.db';
  fs.rmSync(file, { force: true });
  const db = new SqliteDataPort(file);
  await runMigrations(db);
  const bus = new EventBus(db, new InProcessBroker());

  // 1. gmail consent URL: PKCE + offline access
  const g = await oauthStart(db, 'user-1', gmailManifest, gmailManifest.authMethods[0], ['gmail.read', 'gmail.send'], null);
  const gu = new URL(g.url);
  console.log('gmail consent host:', gu.host);
  console.log('  pkce:', gu.searchParams.get('code_challenge_method'), '| challenge len:', (gu.searchParams.get('code_challenge') ?? '').length);
  console.log('  access_type:', gu.searchParams.get('access_type'), '| prompt:', gu.searchParams.get('prompt'));
  console.log('  redirect:', gu.searchParams.get('redirect_uri'));

  // 2. github: no PKCE, plain state
  const gh = await oauthStart(db, 'user-1', githubManifest, githubManifest.authMethods[0], ['github.repo.read'], null);
  const ghu = new URL(gh.url);
  console.log('github consent host:', ghu.host, '| pkce (none expected):', ghu.searchParams.get('code_challenge_method'));

  // 3. one-time state rows
  const rows = await db.query<any>('SELECT * FROM oauth_states ORDER BY created_at DESC LIMIT 2');
  console.log('state rows:', rows.length, '| verifier stored:', !!rows[0].code_challenge, '| caps:', rows[0].capabilities);

  // 4. webhook HMAC verification
  const body = JSON.stringify({ action: 'opened', issue: { id: 1 } });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec-test').update(body).digest('hex');
  console.log('webhook good sig:', verifyWebhookSignature(githubManifest, body, { 'x-hub-signature-256': sig }, 'whsec-test'));
  console.log('webhook bad sig:', verifyWebhookSignature(githubManifest, body, { 'x-hub-signature-256': 'sha256=bad' }, 'whsec-test'));

  // 5. agent tools generated from manifests
  const platform = createIntegrationPlatform({ db, bus });
  const tools = createIntegrationTools(db, platform);
  console.log('integration tools:', tools.map(t => t.name).join(', '));

  await db.close();
  fs.rmSync(file, { force: true });
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
