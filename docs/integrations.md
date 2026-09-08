# Integrations

Agentic OS connects to external applications through a **provider-agnostic Integration Platform**. Adding a provider never touches the engine — you write one adapter (data + provider behavior) and register it.

## Architecture

```
UI (/integrations)  ──►  GET /api/integrations  ──►  provider catalog (config status, capabilities, auth methods)
   │                                                        │
   ├─ OAuth connect ──► /api/integrations/:id/oauth ──► OAuthManager (state, PKCE, refresh — ONE impl)
   ├─ Token connect ──► /api/integrations/connect ──► probe → vault (AES-256-GCM) → connection row
   │
   ▼
Provider adapters (github, gmail, youtube, slack, telegram, whatsapp, instagram)
   │
   ├─ Webhook Gateway: signature verification (HMAC-SHA256 / Slack v0) → replay dedup → normalize → bus
   ├─ Sync Engine: cursor-based polling, ≥60s intervals, per-connection rate limits
   └─ Capability execution: grant check → credential (auto-refresh) → provider API → audit
   │
   ▼
OS event bus (integration.event)  ──►  automations / agents / memory
Agent tools (github.action, gmail.action, …) — capability-gated, manifest-generated
```

## The three contracts

**ProviderManifest** (data): identity, auth methods (OAuth2 config / token fields), capabilities (id → action → scopes), webhook scheme, sync interval, rate limit, API notes. This is *all* the UI needs — it renders entirely from the catalog.

**ProviderAdapter** (behavior): `probeToken` (verify credentials → account; must throw on failure), `execute(capabilityId, cred, args)`, optional `sync`, `normalizeItem`, `normalizeWebhook`, `healthCheck`.

**IntegrationService** (engine): connections, vault, capability enforcement, OAuth flows via the central OAuthManager, health, rate limiting, normalized events. Zero provider knowledge.

## Authentication

| Provider | Method | Notes |
|---|---|---|
| Gmail, YouTube | Google OAuth (PKCE, offline) | Shared `GOOGLE_*` identity — one Google login serves both; Calendar/Drive/Contacts will reuse it |
| GitHub | OAuth **or** PAT | OAuth app or fine-grained personal access token |
| Slack | OAuth install **or** bot token | xoxb- bot tokens |
| Telegram | Bot token | Official Bot API — deliberately NOT OAuth |
| WhatsApp | Cloud API token + phone_number_id | Official Meta Business API only — no scraping, ever |
| Instagram | Meta OAuth | Professional accounts via the official Graph API |

The UI only shows the methods a provider actually supports — Gmail never offers a "personal access token" field.

## Security model

- Credentials sealed in the vault (AES-256-GCM, 0600 key file or `INTEGRATION_VAULT_KEY`); plaintext never in DB, logs, events, audit, or API responses
- Every capability call: grant check → credential refresh → provider call → audit row (deep secret redaction on all audit/event paths)
- Webhooks: HMAC signature verification (constant-time), replay protection via source-event dedup, timestamp-aware Slack v0 scheme
- A connection is only `connected` after a successful provider probe
- Disconnect deletes vault rows; revoked refresh tokens flip the connection to `reauth_required`

## Adding a provider

1. Create `apps/api/src/modules/integrations/providers.ts` entry (or a new file): a `ProviderManifest` + a `ProviderAdapter` class
2. Register it in `createIntegrationPlatform` (`modules/integrations/index.ts`)
3. Add env names to `.env.example` if OAuth
4. Done — UI cards, capability gating, agent tool (`<id>.action`), webhook intake, and sync all derive from the manifest

Health states: `connected · disconnected · reauth_required · error` (per connection), config status per auth method: `configured · not_configured · misconfigured`.
