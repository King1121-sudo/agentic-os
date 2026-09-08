# Google OAuth Setup (Gmail + YouTube — one shared login)

Agentic OS uses **one Google OAuth client** for the whole Google family. Gmail and YouTube share it today; Calendar, Drive, Contacts, Tasks, Sheets, and Docs will reuse the same identity without any new OAuth setup.

## The redirect URI (exact — do not invent another)

```
Development:  http://localhost:3000/api/integrations/google/oauth/callback
Production:   https://<your-domain>/api/integrations/google/oauth/callback
```

The path is family-shared (`/api/integrations/google/...`, **not** `/gmail/...` or `/youtube/...`) so one authorized redirect URI covers every Google service. The base comes from `AGENTIC_PUBLIC_URL` (defaults to `http://localhost:3000`).

## Step-by-step

1. **Create/select a Google Cloud project** → [console.cloud.google.com](https://console.cloud.google.com)
2. **OAuth consent screen** (APIs & Services → OAuth consent screen): choose *External* (or *Internal* for Workspace), fill app name + support email. While in **testing** mode, add your Google account under **Test users** — only test users can consent until you publish the app.
3. **Enable the APIs** (APIs & Services → Library):
   - `Gmail API` — for gmail.read / gmail.search / gmail.send
   - `YouTube Data API v3` — for all YouTube capabilities
   - (no API enablement needed for the OIDC identity endpoint)
4. **Create the OAuth Client ID** (Credentials → Create Credentials → OAuth client ID → *Web application*):
   - Authorized redirect URI: exactly the URL above (add BOTH dev and prod if you use both)
5. **Copy the client ID + client secret** into Agentic OS:
   - Create `.env` in the repo root (it is git-ignored):
     ```
     GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
     GOOGLE_CLIENT_SECRET=<client secret>
     # only needed in production:
     AGENTIC_PUBLIC_URL=https://<your-domain>
     ```
6. **Restart the API** (`npm run dev:api`) — the config is read at boot.
7. **Verify**: the Integrations page now shows `GOOGLE OAUTH · CONFIGURED` under Gmail and YouTube with a **Connect** button. You can also check `GET /api/integrations/google/diagnostics`:
   ```json
   { "status": "READY", "client_id": "configured", "client_secret": "configured",
     "redirect_uri": "http://localhost:3000/api/integrations/google/oauth/callback" }
   ```
8. **Connect**: click Connect → Google consent → back in Agentic OS the connection shows CONNECTED with your Google account.
9. **Adding YouTube later**: click Connect on the YouTube card — Google recognizes the existing grant (`include_granted_scopes=true`) and only asks for the incremental YouTube scopes. **No second login**; the shared family credential is reused.

## Scopes actually requested (least privilege)

Only scopes for the capabilities you select on the card are requested:

| Capability | Scope |
|---|---|
| gmail.read / gmail.search | `https://www.googleapis.com/auth/gmail.readonly` |
| gmail.send | `https://www.googleapis.com/auth/gmail.send` |
| youtube.* read/search | `https://www.googleapis.com/auth/youtube.readonly` |
| (always, identity) | `openid` `email` |

## Token lifecycle (automatic)

- Access tokens expire ~1h; the OS refreshes them transparently before every call (stored encrypted, AES-256-GCM)
- If you revoke access in your [Google Account permissions](https://myaccount.google.com/permissions), the next refresh fails → every Google connection flips to **REAUTH REQUIRED** with a *Reconnect Google* button
- Disconnecting a service deletes that service's vault rows (the shared family credential stays for other services)

## Troubleshooting

| Error code | Meaning / fix |
|---|---|
| `API_NOT_ENABLED` | Enable Gmail API / YouTube Data API in the Google Cloud project (step 3) |
| `INVALID_SCOPE` | Consent-screen scopes not configured for testing users, or capability needs a scope your app doesn't request — re-check step 2/4 |
| `ACCESS_DENIED` | The account isn't in the test-users list while the app is in testing mode |
| `redirect_uri_mismatch` | The authorized redirect URI in Google doesn't EXACTLY match the one shown in the UI/diagnostics |
| `REAUTH_REQUIRED` | Refresh token revoked/expired — click Reconnect Google |
| `QUOTA_EXCEEDED` | YouTube API quota — see Google Cloud quotas |
