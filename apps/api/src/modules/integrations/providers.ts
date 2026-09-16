/**
 * Provider adapters (Phase 8) — each is ONLY provider-specific behavior:
 * a manifest (data) + probe/execute/sync/normalize. Auth flows, state, PKCE,
 * refresh, storage, rate limits, webhooks, dedupe all live in the engine.
 *
 * Adding a provider = new file here + one registration line in index.ts.
 */
import { ProviderAdapter, ProviderManifest, AdapterCredentials } from './types';

// ─── shared HTTP helper (JSON, timeouts, Retry-After surfacing) ─────────────

export async function providerFetch(
  url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; json: any; retryAfterS: number | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 12000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'agentic-os/0.12', ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
    const raHeader = res.headers.get('retry-after');
    const json = await res.json().catch(() => null);
    return { status: res.status, json, retryAfterS: raHeader ? Number(raHeader) : null };
  } finally {
    clearTimeout(timer);
  }
}

export function bearer(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` }; }

export class ProviderHttpError extends Error {
  constructor(public status: number, message: string, public retryAfterS: number | null) {
    super(message);
  }
}

/** Throw a normalized error for non-2xx (used by every adapter). */
export async function ensureOk(res: { status: number; json: any; retryAfterS: number | null }, what: string): Promise<any> {
  if (res.status >= 200 && res.status < 300) return res.json;
  const detail = res.json?.message ?? res.json?.error ?? (typeof res.json === 'string' ? res.json : null) ?? `HTTP ${res.status}`;
  throw new ProviderHttpError(res.status, `${what}: ${String(detail).slice(0, 180)}`, res.retryAfterS);
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

export const githubManifest: ProviderManifest = {
  id: 'github', name: 'GitHub', icon: '⌥', color: 'var(--accent)', category: 'development',
  blurb: 'Repos, issues, pull requests, notifications',
  apiNotes: ['PAT fine-grained scopes are honored; OAuth apps use the scopes shown'],
  authMethods: [
    {
      kind: 'oauth2', label: 'GitHub OAuth',
      oauth: {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET',
        scopeParam: 'read:user repo',
        pkce: false,
      },
    },
    {
      kind: 'token', label: 'Personal Access Token',
      tokenFields: [{ name: 'token', label: 'PAT', placeholder: 'ghp_… / github_pat_…' }],
    },
  ],
  capabilities: [
    { id: 'github.repo.read', action: 'read', label: 'Read repositories', scopes: ['repo'], required: true },
    { id: 'github.issue.read', action: 'read', label: 'Read issues', scopes: ['repo'], required: true },
    { id: 'github.issue.write', action: 'create', label: 'Create issues', scopes: ['repo'] },
    { id: 'github.pr.read', action: 'read', label: 'Read pull requests', scopes: ['repo'], required: true },
    { id: 'github.pr.write', action: 'create', label: 'Create pull requests', scopes: ['repo'] },
    { id: 'github.search', action: 'search', label: 'Search repositories', scopes: [] },
  ],
  defaultCapabilities: ['github.repo.read', 'github.issue.read', 'github.pr.read'],
  webhook: { signatureHeader: 'x-hub-signature-256', scheme: 'hmac-sha256', secret: 'per-connection', secretEnv: 'GITHUB_WEBHOOK_SECRET' },
  sync: { defaultIntervalS: 120 },
  rateLimit: { maxPerMinute: 60 },
};

export class GitHubPlatformAdapter implements ProviderAdapter {
  manifest = githubManifest;

  async probeToken(token: string) {
    const res = await providerFetch('https://api.github.com/user', { headers: { ...bearer(token), Accept: 'application/vnd.github+json' } });
    const user = await ensureOk(res, 'github probe');
    if (!user?.login) throw new Error('GitHub token could not be verified');
    return { account: String(user.login), scopes: ['repo', 'read:user'], identityKey: null, expiresAt: null };
  }

  async execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>) {
    const h = { ...bearer(cred.accessToken), Accept: 'application/vnd.github+json' };
    if (capabilityId === 'github.search') {
      const q = String(args.q ?? '');
      if (!q) throw new Error('github.search needs args.q');
      const res = await providerFetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(Number(args.limit ?? 5), 25)}`);
      const data = await ensureOk(res, 'github search');
      return (data?.items ?? []).map((r: any) => ({ full_name: r.full_name, description: r.description?.slice(0, 120), stars: r.stargazers_count, url: r.html_url }));
    }
    if (capabilityId === 'github.repo.read') {
      const repo = String(args.repo ?? '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('github.repo.read needs args.repo as owner/name');
      const res = await providerFetch(`https://api.github.com/repos/${repo}`, { headers: h });
      const r = await ensureOk(res, 'github repo read');
      return { full_name: r.full_name, description: r.description?.slice(0, 160), stars: r.stargazers_count, open_issues: r.open_issues_count, url: r.html_url };
    }
    if (capabilityId === 'github.issue.read') {
      const repo = String(args.repo ?? '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('github.issue.read needs args.repo');
      const res = await providerFetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=${Math.min(Number(args.limit ?? 10), 30)}`, { headers: h });
      const issues = await ensureOk(res, 'github issues read');
      return (Array.isArray(issues) ? issues : []).map((i: any) => ({ repo, number: i.number, title: i.title, user: i.user?.login, url: i.html_url }));
    }
    if (capabilityId === 'github.issue.write') {
      const repo = String(args.repo ?? '');
      const title = String(args.title ?? '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !title) throw new Error('github.issue.write needs args.repo + args.title');
      const res = await providerFetch(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers: h, body: { title, body: args.body ?? '' } });
      const issue = await ensureOk(res, 'github issue create');
      return { number: issue.number, url: issue.html_url };
    }
    if (capabilityId === 'github.pr.read') {
      const repo = String(args.repo ?? '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('github.pr.read needs args.repo');
      const res = await providerFetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=${Math.min(Number(args.limit ?? 10), 30)}`, { headers: h });
      const prs = await ensureOk(res, 'github prs read');
      return (Array.isArray(prs) ? prs : []).map((p: any) => ({ repo, number: p.number, title: p.title, user: p.user?.login, url: p.html_url }));
    }
    throw new Error(`github: unknown capability ${capabilityId}`);
  }

  async sync(cred: AdapterCredentials, cursor: string | null) {
    // poll the authenticated user's notifications (cursor = since ISO)
    const params = new URLSearchParams({ per_page: '30' });
    if (cursor) params.set('since', cursor);
    const res = await providerFetch(`https://api.github.com/notifications?${params}`, {
      headers: { ...bearer(cred.accessToken), Accept: 'application/vnd.github+json' } });
    const items = await ensureOk(res, 'github notifications sync');
    return { items: Array.isArray(items) ? items : [], nextCursor: new Date().toISOString() };
  }

  normalizeItem(item: Record<string, unknown>) {
    const subject = (item as any).subject ?? {};
    return {
      event_type: (item as any).reason === 'review_requested' ? 'review.requested' : 'notification.received',
      payload: { subject: subject.title ?? null, type: subject.type ?? null, repository: (item as any).repository?.full_name ?? null, reason: (item as any).reason },
      actor: (item as any).repository?.full_name ?? null,
      resource: { type: 'github.notification', id: String((item as any).id ?? ''), url: subject.latest_comment_url ?? undefined },
    };
  }

  normalizeWebhook(body: Record<string, unknown>) {
    const action = String(body.action ?? '');
    const pr = (body as any).pull_request ?? null;
    const issue = (body as any).issue ?? null;
    if (pr) return { event_type: `pr.${action || 'updated'}`, payload: { repo: (body as any).repository?.full_name, number: pr.number, title: pr.title, user: pr.user?.login, url: pr.html_url }, source_event_id: `gh-${(body as any).repository?.id}-${pr.id}-${action}-${pr.updated_at}` };
    if (issue) return { event_type: `issue.${action || 'created'}`, payload: { repo: (body as any).repository?.full_name, number: issue.number, title: issue.title, user: issue.user?.login, url: issue.html_url }, source_event_id: `gh-${(body as any).repository?.id}-${issue.id}-${action}` };
    return null;
  }
}

// ─── Google (shared identity: Gmail + YouTube) ───────────────────────────────

/** Shared Google OAuth config — Gmail, YouTube, and every future Google service
 *  (Calendar, Drive, Contacts, Tasks, Sheets…) reference the SAME identity:
 *  same client id/secret, ONE family callback URL, scopes computed from the
 *  capabilities the user selected (least privilege, incremental when the user
 *  adds more services later). One Google login serves the whole family. */
const googleOauth = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientIdEnv: 'GOOGLE_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  scopeParam: '',                       // scopes come from capabilities (below)
  pkce: true,
  authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  sharedIdentity: 'google',
  redirectPath: '/api/integrations/google/oauth/callback',
  scopeFromCapabilities: true,
};

/** Resolve the Google account identity from a token: prefer the STABLE subject
 *  id (`sub`) over the email (§8 — email can change; sub never does). */
async function googleIdentity(token: string): Promise<{ sub: string; email: string; name?: string }> {
  const res = await providerFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: bearer(token) });
  const user = await ensureOk(res, 'google identity');
  if (!user?.sub || !user?.email) throw new Error('Google token could not be verified');
  return { sub: String(user.sub), email: String(user.email), name: user.name };
}

/** Probe used at connect + by every Google-family adapter: resolves account via
 *  the OIDC userinfo endpoint, identityKey = google:<sub> (stable subject). */
async function googleProbe(token: string, _scopeCheck: string): Promise<{ account: string; scopes: string[]; identityKey: string; expiresAt: null }> {
  const id = await googleIdentity(token);
  return { account: id.email, scopes: [], identityKey: `google:${id.sub}`, expiresAt: null };
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

export const gmailManifest: ProviderManifest = {
  id: 'gmail', name: 'Gmail', icon: '✉', color: 'var(--red)', category: 'communication',
  blurb: 'Read, search, send email via Google',
  apiNotes: ['Gmail requires Google OAuth — there is no personal-access-token mechanism', 'Full API list at developers.google.com/gmail'],
  authMethods: [{ kind: 'oauth2', label: 'Google OAuth', oauth: { ...googleOauth, scopeParam: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email' } }],
  capabilities: [
    { id: 'gmail.read', action: 'read', label: 'Read inbox', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], required: true },
    { id: 'gmail.search', action: 'search', label: 'Search mail', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], required: true },
    { id: 'gmail.send', action: 'send', label: 'Send mail', scopes: ['https://www.googleapis.com/auth/gmail.send'] },
  ],
  defaultCapabilities: ['gmail.read', 'gmail.search'],
  sync: { defaultIntervalS: 300 },
  rateLimit: { maxPerMinute: 30 },
};

export class GmailPlatformAdapter implements ProviderAdapter {
  manifest = gmailManifest;
  async probeToken(token: string) { return googleProbe(token, 'gmail'); }
  /** §11: verify the granted scopes actually reach the Gmail API — translate
   *  provider errors into standard codes, never raw secrets. */
  async verifyConnection(cred: AdapterCredentials): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    try {
      const res = await providerFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: bearer(cred.accessToken) });
      if (res.status === 403) {
        const detail = String(res.json?.error?.message ?? 'Gmail API not enabled for this Google project').slice(0, 160);
        return { ok: false, code: 'API_NOT_ENABLED', detail };
      }
      if (res.status === 401) return { ok: false, code: 'TOKEN_EXPIRED', detail: 'access token rejected' };
      if (res.json?.emailAddress) return { ok: true };
      return { ok: false, code: 'ACCESS_DENIED', detail: `unexpected Gmail profile response (HTTP ${res.status})` };
    } catch (e: any) {
      return { ok: false, code: 'ERROR', detail: String(e?.message ?? e).slice(0, 160) };
    }
  }
  async execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>) {
    const h = bearer(cred.accessToken);
    if (capabilityId === 'gmail.read') {
      const res = await providerFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5', { headers: h });
      const list = await ensureOk(res, 'gmail list');
      const out: unknown[] = [];
      for (const m of (list?.messages ?? []).slice(0, 5)) {
        const msg = await ensureOk(await providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata`, { headers: h }), 'gmail message');
        const headers = (msg?.payload?.headers ?? []) as any[];
        out.push({ id: m.id, subject: headers.find(x => x.name === 'Subject')?.value ?? '', from: headers.find(x => x.name === 'From')?.value ?? '', snippet: msg?.snippet ?? '' });
      }
      return out;
    }
    if (capabilityId === 'gmail.search') {
      const q = String(args.q ?? '');
      if (!q) throw new Error('gmail.search needs args.q');
      const res = await providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=5`, { headers: h });
      const list = await ensureOk(res, 'gmail search');
      return (list?.messages ?? []).map((m: any) => ({ id: m.id, threadId: m.threadId }));
    }
    if (capabilityId === 'gmail.send') {
      const to = String(args.to ?? ''); const subject = String(args.subject ?? args.title ?? ''); const body = String(args.body ?? args.text ?? '');
      if (!to || !subject) throw new Error('gmail.send needs args.to + args.subject (+ args.body)');
      // RFC822 assembly + base64url (Gmail API send)
      const email = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"', '', body].join('\r\n');
      const raw = Buffer.from(email).toString('base64url');
      const res = await providerFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: h, body: { raw } });
      const sent = await ensureOk(res, 'gmail send');
      return { id: sent.id, threadId: sent.threadId };
    }
    throw new Error(`gmail: unknown capability ${capabilityId}`);
  }
  async sync(cred: AdapterCredentials, cursor: string | null) {
    const params = new URLSearchParams({ maxResults: '10' });
    if (cursor) params.set('q', `after:${Math.floor(Date.parse(cursor) / 1000)}`);
    const res = await providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, { headers: bearer(cred.accessToken) });
    const list = await ensureOk(res, 'gmail sync');
    return { items: (list?.messages ?? []).map((m: any) => ({ id: m.id, threadId: m.threadId })), nextCursor: new Date().toISOString() };
  }
  normalizeItem(item: Record<string, unknown>) {
    return { event_type: 'email.received', payload: item, resource: { type: 'gmail.message', id: String(item.id ?? ''), url: undefined } };
  }
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

export const youtubeManifest: ProviderManifest = {
  id: 'youtube', name: 'YouTube', icon: '▶', color: 'var(--red)', category: 'media',
  blurb: 'Channel, videos, playlists, comments — shares your Google login',
  apiNotes: ['Uses the same Google OAuth identity as Gmail — one login, both services', 'Data API quotas apply per project'],
  authMethods: [{ kind: 'oauth2', label: 'Google OAuth', oauth: { ...googleOauth, scopeParam: 'https://www.googleapis.com/auth/youtube.readonly openid email' } }],
  capabilities: [
    { id: 'youtube.channel.read', action: 'read', label: 'Read channel info', scopes: ['https://www.googleapis.com/auth/youtube.readonly'], required: true },
    { id: 'youtube.video.read', action: 'read', label: 'Read videos', scopes: ['https://www.googleapis.com/auth/youtube.readonly'], required: true },
    { id: 'youtube.playlist.read', action: 'read', label: 'Read playlists', scopes: ['https://www.googleapis.com/auth/youtube.readonly'], required: true },
    { id: 'youtube.comment.read', action: 'read', label: 'Read comments', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] },
    { id: 'youtube.search', action: 'search', label: 'Search videos', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] },
  ],
  defaultCapabilities: ['youtube.channel.read', 'youtube.video.read'],
  sync: { defaultIntervalS: 600 },
  rateLimit: { maxPerMinute: 20 },
};

export class YouTubePlatformAdapter implements ProviderAdapter {
  manifest = youtubeManifest;
  async probeToken(token: string) { return googleProbe(token, 'youtube'); }
  /** §11: verify against the Data API (channels?mine) — catches disabled APIs,
   *  channels without a YouTube presence, and scope problems. */
  async verifyConnection(cred: AdapterCredentials): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    try {
      const res = await providerFetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: bearer(cred.accessToken) });
      if (res.status === 403) {
        const msg = String(res.json?.error?.message ?? '');
        if (/api service|not been used|is disabled/i.test(msg)) return { ok: false, code: 'API_NOT_ENABLED', detail: 'YouTube Data API not enabled for this Google project' };
        if (/quota/i.test(msg)) return { ok: false, code: 'QUOTA_EXCEEDED', detail: 'YouTube API quota exceeded' };
        return { ok: false, code: 'INVALID_SCOPE', detail: msg.slice(0, 160) || 'scope does not permit this request' };
      }
      if (res.status === 401) return { ok: false, code: 'TOKEN_EXPIRED', detail: 'access token rejected' };
      // empty items = valid auth, but this Google account has no channel —
      // read capabilities still work for public data via search; channel.read degrades
      if (Array.isArray(res.json?.items)) return { ok: true };
      return { ok: false, code: 'ACCESS_DENIED', detail: `unexpected YouTube response (HTTP ${res.status})` };
    } catch (e: any) {
      return { ok: false, code: 'ERROR', detail: String(e?.message ?? e).slice(0, 160) };
    }
  }
  async execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>) {
    const h = bearer(cred.accessToken);
    if (capabilityId === 'youtube.channel.read') {
      const res = await providerFetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: h });
      const data = await ensureOk(res, 'youtube channel read');
      const ch = data?.items?.[0];
      if (!ch) throw new Error('no channel on this Google account');
      return { title: ch.snippet?.title, subscribers: ch.statistics?.subscriberCount, views: ch.statistics?.viewCount, url: `https://youtube.com/channel/${ch.id}` };
    }
    if (capabilityId === 'youtube.search') {
      const q = String(args.q ?? '');
      if (!q) throw new Error('youtube.search needs args.q');
      const res = await providerFetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${Math.min(Number(args.limit ?? 5), 20)}&q=${encodeURIComponent(q)}`, { headers: h });
      const data = await ensureOk(res, 'youtube search');
      return (data?.items ?? []).map((v: any) => ({ videoId: v.id?.videoId, title: v.snippet?.title, channel: v.snippet?.channelTitle, url: `https://youtube.com/watch?v=${v.id?.videoId}` }));
    }
    if (capabilityId === 'youtube.comment.read') {
      const videoId = String(args.video_id ?? args.videoId ?? '');
      if (!videoId) throw new Error('youtube.comment.read needs args.video_id');
      const res = await providerFetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=20`, { headers: h });
      const data = await ensureOk(res, 'youtube comments');
      return (data?.items ?? []).map((c: any) => ({ author: c.snippet?.topLevelComment?.snippet?.authorDisplayName, text: c.snippet?.topLevelComment?.snippet?.textDisplay?.slice(0, 200), likes: c.snippet?.topLevelComment?.snippet?.likeCount }));
    }
    if (capabilityId === 'youtube.video.read' || capabilityId === 'youtube.playlist.read') {
      const endpoint = capabilityId === 'youtube.video.read'
        ? 'https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&mine=true'
        : 'https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=20';
      const res = await providerFetch(endpoint, { headers: h });
      const data = await ensureOk(res, 'youtube list');
      return data?.items ?? [];
    }
    throw new Error(`youtube: unknown capability ${capabilityId}`);
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

export const slackManifest: ProviderManifest = {
  id: 'slack', name: 'Slack', icon: '✱', color: 'var(--green)', category: 'communication',
  blurb: 'Channels, messages, events — bot token or OAuth',
  apiNotes: ['Bot tokens (xoxb-) are the primary mechanism; OAuth install flow adds the app'],
  authMethods: [
    {
      kind: 'oauth2', label: 'Slack OAuth (install app)',
      oauth: {
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        clientIdEnv: 'SLACK_CLIENT_ID', clientSecretEnv: 'SLACK_CLIENT_SECRET',
        scopeParam: 'channels:read chat:write users:read',
        pkce: false,
      },
    },
    { kind: 'bot_token', label: 'Bot Token', tokenFields: [{ name: 'token', label: 'Bot token', placeholder: 'xoxb-…' }] },
  ],
  capabilities: [
    { id: 'slack.channel.read', action: 'read', label: 'Read channels', scopes: ['channels:read'], required: true },
    { id: 'slack.message.read', action: 'read', label: 'Read messages', scopes: ['channels:history'], required: true },
    { id: 'slack.message.write', action: 'send', label: 'Send messages', scopes: ['chat:write'], required: true },
    { id: 'slack.user.read', action: 'read', label: 'Read users', scopes: ['users:read'] },
  ],
  defaultCapabilities: ['slack.channel.read', 'slack.message.read', 'slack.message.write'],
  webhook: { signatureHeader: 'x-slack-signature', scheme: 'hmac-sha256-v0', secret: 'env', secretEnv: 'SLACK_SIGNING_SECRET' },
  sync: { defaultIntervalS: 300 },
  rateLimit: { maxPerMinute: 40 },
};

export class SlackPlatformAdapter implements ProviderAdapter {
  manifest = slackManifest;
  async probeToken(token: string) {
    const res = await providerFetch('https://slack.com/api/auth.test', { method: 'POST', headers: bearer(token) });
    const auth = await ensureOk(res, 'slack probe');
    if (!auth?.ok) throw new Error(`Slack token could not be verified: ${auth?.error ?? 'unknown'}`);
    return { account: String(auth.team ?? auth.user ?? 'slack'), scopes: ['channels:read', 'chat:write'], identityKey: null, expiresAt: null };
  }
  async execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>) {
    const h = bearer(cred.accessToken);
    if (capabilityId === 'slack.channel.read') {
      const res = await providerFetch('https://slack.com/api/conversations.list?limit=20', { headers: h });
      const data = await ensureOk(res, 'slack channels');
      if (!data?.ok) throw new ProviderHttpError(res.status, `slack channels: ${data?.error}`, null);
      return (data.channels ?? []).map((c: any) => ({ id: c.id, name: c.name, members: c.num_members }));
    }
    if (capabilityId === 'slack.message.read') {
      const channel = String(args.channel ?? '');
      if (!channel) throw new Error('slack.message.read needs args.channel (id or name)');
      const res = await providerFetch(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=10`, { headers: h });
      const data = await ensureOk(res, 'slack history');
      if (!data?.ok) throw new ProviderHttpError(res.status, `slack history: ${data?.error}`, null);
      return (data.messages ?? []).map((m: any) => ({ ts: m.ts, user: m.user, text: m.text?.slice(0, 200) }));
    }
    if (capabilityId === 'slack.message.write') {
      const channel = String(args.channel ?? ''); const text = String(args.text ?? '');
      if (!channel || !text) throw new Error('slack.message.write needs args.channel + args.text');
      const res = await providerFetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: h, body: { channel, text } });
      const data = await ensureOk(res, 'slack post');
      if (!data?.ok) throw new ProviderHttpError(res.status, `slack post: ${data?.error}`, null);
      return { channel: data.channel, ts: data.ts };
    }
    if (capabilityId === 'slack.user.read') {
      const res = await providerFetch('https://slack.com/api/users.list?limit=50', { headers: h });
      const data = await ensureOk(res, 'slack users');
      return (data.members ?? []).slice(0, 25).map((m: any) => ({ id: m.id, name: m.name, real_name: m.real_name }));
    }
    throw new Error(`slack: unknown capability ${capabilityId}`);
  }
  normalizeWebhook(body: Record<string, unknown>) {
    // Slack Events API wraps payloads in { event: {...}, event_id }
    const ev = (body as any).event ?? body;
    const type = String(ev?.type ?? '');
    if (!type) return null;
    return {
      event_type: `slack.${type}`,
      payload: { channel: ev.channel, user: ev.user, text: ev.text?.slice(0, 300), ts: ev.ts },
      source_event_id: String((body as any).event_id ?? `${ev.channel}-${ev.ts ?? Date.now()}`),
    };
  }
}

// ─── Telegram (bot API — the non-OAuth proof) ────────────────────────────────

export const telegramManifest: ProviderManifest = {
  id: 'telegram', name: 'Telegram', icon: '➤', color: 'var(--accent)', category: 'communication',
  blurb: 'Bot API — send messages, read updates',
  apiNotes: ['Telegram uses the official Bot API (bot token), not OAuth', 'Inbound events arrive via getUpdates polling or webhooks'],
  authMethods: [{ kind: 'bot_token', label: 'Bot Token (from @BotFather)', tokenFields: [{ name: 'token', label: 'Bot token', placeholder: '123456:ABC-DEF…' }] }],
  capabilities: [
    { id: 'telegram.send', action: 'send', label: 'Send messages', scopes: [], required: true },
    { id: 'telegram.read', action: 'read', label: 'Read updates (polling)', scopes: [], required: true },
  ],
  defaultCapabilities: ['telegram.send', 'telegram.read'],
  sync: { defaultIntervalS: 60 },
  rateLimit: { maxPerMinute: 30 },
};

export class TelegramPlatformAdapter implements ProviderAdapter {
  manifest = telegramManifest;
  async probeToken(token: string) {
    const res = await providerFetch(`https://api.telegram.org/bot${token}/getMe`, {});
    const data = await ensureOk(res, 'telegram probe');
    if (!data?.ok || !data?.result?.username) throw new Error('Telegram bot token could not be verified');
    return { account: String(data.result.username), scopes: [], identityKey: null, expiresAt: null };
  }
  async execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>) {
    const token = cred.accessToken; // the bot token itself
    if (capabilityId === 'telegram.send') {
      const chatId = String(args.chat_id ?? args.chatId ?? '');
      const text = String(args.text ?? '');
      if (!chatId || !text) throw new Error('telegram.send needs args.chat_id + args.text');
      const res = await providerFetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', body: { chat_id: chatId, text } });
      const data = await ensureOk(res, 'telegram send');
      if (!data?.ok) throw new ProviderHttpError(res.status, `telegram send: ${data?.description}`, null);
      return { message_id: data.result?.message_id };
    }
    throw new Error(`telegram: unknown capability ${capabilityId}`);
  }
  async sync(cred: AdapterCredentials, cursor: string | null) {
    const token = cred.accessToken;
    const params = new URLSearchParams({ timeout: '0', limit: '20' });
    if (cursor) params.set('offset', cursor);
    const res = await providerFetch(`https://api.telegram.org/bot${token}/getUpdates?${params}`, {});
    const data = await ensureOk(res, 'telegram getUpdates');
    const items = data?.ok ? (data.result ?? []) : [];
    // next cursor: highest update_id + 1
    const nextOffset = items.length ? String(Math.max(...items.map((u: any) => u.update_id)) + 1) : cursor;
    return { items, nextCursor: nextOffset };
  }
  normalizeItem(item: Record<string, unknown>) {
    const msg = (item as any).message ?? (item as any).edited_message ?? null;
    if (!msg) return null;
    return {
      event_type: (item as any).edited_message ? 'message.edited' : 'message.received',
      payload: { chat_id: msg.chat?.id, chat_title: msg.chat?.title ?? msg.chat?.username, from: msg.from?.username ?? msg.from?.first_name, text: msg.text?.slice(0, 300) },
      actor: msg.from?.username ?? null,
      resource: { type: 'telegram.message', id: String(msg.message_id ?? ''), url: undefined },
    };
  }
}

// ─── WhatsApp (Meta Cloud API — official only) ────────────────────────────────

export const whatsappManifest: ProviderManifest = {
  id: 'whatsapp', name: 'WhatsApp', icon: '☎', color: 'var(--green)', category: 'communication',
  blurb: 'WhatsApp Business Cloud API (official Meta platform only)',
  apiNotes: [
    'Business Cloud API only — no unofficial scraping or session hijacking',
    'Requires a Meta business app + WhatsApp Business Account (WABA)',
    'Inbound messages arrive via webhook (Meta signature); outbound via cloud API send',
  ],
  authMethods: [
    {
      kind: 'token', label: 'Cloud API access token (System User)',
      tokenFields: [
        { name: 'token', label: 'Access token', placeholder: 'EAAG… (system-user token)' },
        { name: 'phone_number_id', label: 'Phone number ID', placeholder: 'from Meta dashboard' },
      ],
    },
  ],
  capabilities: [
    { id: 'whatsapp.send', action: 'send', label: 'Send messages', scopes: [], required: true },
    { id: 'whatsapp.read', action: 'read', label: 'Receive messages (webhook)', scopes: [], required: true },
    { id: 'whatsapp.status', action: 'listen', label: 'Message status events', scopes: [] },
  ],
  defaultCapabilities: ['whatsapp.send', 'whatsapp.read'],
  webhook: { signatureHeader: 'x-hub-signature-256', scheme: 'hmac-sha256', secret: 'env', secretEnv: 'WHATSAPP_APP_SECRET' },
  rateLimit: { maxPerMinute: 40 },
};

export class WhatsAppPlatformAdapter implements ProviderAdapter {
  manifest = whatsappManifest;
  async probeToken(token: string) {
    // token + phone_number_id comes in as "token|phone_number_id" — resolve via
    // a cheap call: GET /{phone_number_id} returns the number info
    const [accessToken, phoneId] = token.split('|');
    if (!accessToken || !phoneId) throw new Error('whatsapp connect needs token|phone_number_id');
    const res = await providerFetch(`https://graph.facebook.com/v21.0/${phoneId}`, { headers: bearer(accessToken) });
    const data = await ensureOk(res, 'whatsapp probe');
    if (!data?.id) throw new Error('WhatsApp token/phone id could not be verified');
    return { account: String(data.display_phone_number ?? data.id), scopes: [], identityKey: `meta:${data.id}`, expiresAt: null };
  }
  async execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>) {
    if (capabilityId === 'whatsapp.send') {
      const [accessToken, phoneId] = cred.accessToken.split('|');
      const to = String(args.to ?? '');
      const text = String(args.text ?? args.body ?? '');
      if (!to || !text) throw new Error('whatsapp.send needs args.to (E.164) + args.text');
      const res = await providerFetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: 'POST', headers: bearer(accessToken),
        body: { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      });
      const data = await ensureOk(res, 'whatsapp send');
      return { message_id: data.messages?.[0]?.id };
    }
    throw new Error(`whatsapp: unknown capability ${capabilityId}`);
  }
  normalizeWebhook(body: Record<string, unknown>) {
    // Meta cloud webhook: { object: 'whatsapp_business_account', entry: [...] }
    const entries = (body as any).entry ?? [];
    for (const entry of entries) {
      const changes = entry.changes ?? [];
      for (const ch of changes) {
        const value = ch.value ?? {};
        const msg = (value.messages ?? [])[0];
        if (msg) {
          return {
            event_type: 'message.received',
            payload: { from: msg.from, name: value.contacts?.[0]?.profile?.name, text: msg.text?.body?.slice(0, 300), phone_number_id: value.metadata?.phone_number_id },
            source_event_id: `wa-${msg.id}`,
          };
        }
        const status = (value.statuses ?? [])[0];
        if (status) {
          return { event_type: 'message.status', payload: { status: status.status, message_id: status.id }, source_event_id: `wa-${status.id}-${status.status}` };
        }
      }
    }
    return null;
  }
}

// ─── Instagram (Meta Graph — official only) ──────────────────────────────────

export const instagramManifest: ProviderManifest = {
  id: 'instagram', name: 'Instagram', icon: '◎', color: 'var(--purple)', category: 'social',
  blurb: 'Professional account via official Meta Graph API',
  apiNotes: [
    'Official Meta Graph API for professional/business accounts only',
    'No personal-account scraping — capabilities limited to what the API grants',
  ],
  authMethods: [
    {
      kind: 'oauth2', label: 'Meta OAuth (Instagram professional account)',
      oauth: {
        authorizeUrl: 'https://www.instagram.com/oauth/authorize',
        tokenUrl: 'https://api.instagram.com/oauth/access_token',
        clientIdEnv: 'INSTAGRAM_CLIENT_ID', clientSecretEnv: 'INSTAGRAM_CLIENT_SECRET',
        scopeParam: 'instagram_business_basic instagram_business_manage_messages',
        pkce: true,
        authorizeParams: { response_type: 'code' },
      },
    },
  ],
  capabilities: [
    { id: 'instagram.profile.read', action: 'read', label: 'Read profile', scopes: ['instagram_business_basic'], required: true },
    { id: 'instagram.media.read', action: 'read', label: 'Read media', scopes: ['instagram_business_basic'], required: true },
    { id: 'instagram.messaging', action: 'read', label: 'Messaging (where supported)', scopes: ['instagram_business_manage_messages'] },
    { id: 'instagram.comments.read', action: 'read', label: 'Read comments', scopes: ['instagram_business_basic'] },
  ],
  defaultCapabilities: ['instagram.profile.read', 'instagram.media.read'],
  webhook: { signatureHeader: 'x-hub-signature-256', scheme: 'hmac-sha256', secret: 'env', secretEnv: 'META_APP_SECRET' },
  sync: { defaultIntervalS: 600 },
  rateLimit: { maxPerMinute: 30 },
};

export class InstagramPlatformAdapter implements ProviderAdapter {
  manifest = instagramManifest;
  async probeToken(token: string) {
    const res = await providerFetch(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`, {});
    const data = await ensureOk(res, 'instagram probe');
    if (!data?.username) throw new Error('Instagram token could not be verified');
    return { account: String(data.username), scopes: [], identityKey: `instagram:${data.user_id}`, expiresAt: null };
  }
  async execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>) {
    if (capabilityId === 'instagram.profile.read') {
      const res = await providerFetch(`https://graph.instagram.com/me?fields=user_id,username,account_type,media_count&access_token=${encodeURIComponent(cred.accessToken)}`, {});
      return ensureOk(res, 'instagram profile');
    }
    if (capabilityId === 'instagram.media.read') {
      const res = await providerFetch(`https://graph.instagram.com/me/media?fields=id,caption,media_type,permalink,timestamp&limit=10&access_token=${encodeURIComponent(cred.accessToken)}`, {});
      const data = await ensureOk(res, 'instagram media');
      return data?.data ?? [];
    }
    if (capabilityId === 'instagram.comments.read') {
      const mediaId = String(args.media_id ?? '');
      if (!mediaId) throw new Error('instagram.comments.read needs args.media_id');
      const res = await providerFetch(`https://graph.instagram.com/${mediaId}/comments?access_token=${encodeURIComponent(cred.accessToken)}`, {});
      const data = await ensureOk(res, 'instagram comments');
      return data?.data ?? [];
    }
    throw new Error(`instagram: unknown capability ${capabilityId}`);
  }
  normalizeWebhook(body: Record<string, unknown>) {
    // Meta-style wrapper for Instagram messaging webhooks
    const entries = (body as any).entry ?? [];
    for (const entry of entries) {
      const messaging = (entry.messaging ?? [])[0] ?? null;
      if (messaging) {
        return { event_type: 'message.received', payload: { from: messaging.sender?.id, text: messaging.message?.text?.slice(0, 300) }, source_event_id: `ig-${messaging.message?.mid ?? Date.now()}` };
      }
    }
    return null;
  }
}
