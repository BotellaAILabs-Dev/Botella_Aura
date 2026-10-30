# Connections, Connectors & OAuth

> Connections let a workspace link Aura to the outside services it reads from and publishes to: Facebook Pages and Instagram (Meta), LinkedIn, Google Analytics 4, Google Search Console, HubSpot, Mailchimp, Slack, and the API-key sources Crunchbase, Google Custom Search and GitHub. Each provider has its own sign-in, but the result is stored the same way: an encrypted credential, the account and Page it reaches, the permissions it was granted, a health status, and what it can and cannot do. Publishing and data features ask this layer before they act, so a broken connection is explained to the user instead of failing halfway through a post.

## 1. Overview

The feature has three layers:

| Layer | What it is | Main files |
| --- | --- | --- |
| **Connectors catalog** | Every integration listed in-product. Some are `available` (they work today) and some are `coming_soon` (listed so the roadmap is visible). Each available connector has a provider definition: OAuth or API key, endpoints, scopes, how to verify the credential, and how to revoke it. | `lib/connectors.ts`, `server/connectors/providers.ts` |
| **Connection records** | One `Connection` row per workspace and connector. It holds the encrypted tokens or key, and its `ConnectedAccount` rows hold the provider → account → page tree. LinkedIn keeps its own `LinkedInConnection` table and has a mirror `Connection` row. | `server/connectors/connection.service.ts`, `server/connections/manager.service.ts`, `server/connections/accounts.ts`, `server/services/linkedin.service.ts` |
| **Connection Manager** | The provider-agnostic view: setup stage, granted scopes, capabilities, health, token lifecycle and the execution gate. | `lib/connection-manager.ts`, `lib/capabilities.ts`, `lib/connection-health.ts`, `lib/connection-errors.ts`, `server/connections/health.service.ts` |

Available connectors (`lib/connectors.ts` with `status: 'available'`, plus a provider in `server/connectors/providers.ts`):

| Connector id | Auth | What connecting unlocks |
| --- | --- | --- |
| `meta` | OAuth (Facebook Login) | Publishing approved posts, with images, to a Facebook Page and the Instagram Business or Creator account linked to it. Organic post metrics. |
| `linkedin` | OAuth (own flow, `/api/linkedin/*`) | Posting to the connected member's profile (`w_member_social`), or to a Company Page when `LINKEDIN_ORG_URN` and `w_organization_social` are available. |
| `ga4` | Google OAuth | Reads GA4 traffic and conversions (`analytics.readonly`). |
| `search-console` | Google OAuth | Reads Search Console data (`webmasters.readonly`). |
| `hubspot` | OAuth | Contacts and deals, read only. |
| `mailchimp` | OAuth (HTTP Basic token exchange) | Audiences and campaign performance. |
| `slack` | OAuth | `chat:write`, `channels:read`. |
| `crunchbase` | API key (fallback `CRUNCHBASE_API_KEY`) | Funding and stage data for lead discovery. |
| `google-cse` | API key plus search-engine id (fallback `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_CX`) | Web search for lead discovery. |
| `github` | API key, personal access token (fallback `GITHUB_TOKEN`) | Higher API limits for competitor tracking and lead discovery. |

Roadmap connectors with no integration (`coming_soon`): Google Ads, X, YouTube, Klaviyo, Salesforce, Shopify, Semrush, Ahrefs, WordPress, Canva, Figma, Notion, Zapier, Make, Google Drive, OneDrive.

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
| --- | --- | --- | --- |
| Connectors catalog | `/dashboard/connectors` | See the working integrations first and the roadmap items in a collapsed list. Connect (OAuth redirect, or paste and verify an API key), **Test**, and disconnect. See readiness: when the deployment is missing app credentials, the card names the env vars (`providerReadiness`). Shows a banner after an OAuth round trip (`?status=connected\|denied\|error&reason=…`). The Meta card includes a Page picker (`meta-page-picker.tsx`) and a warning before expiry. | Everyone can view. OWNER/ADMIN (`company:update`) can connect, test and disconnect. |
| Connection Manager | `/dashboard/connections` | Every connection with its provider, channels, account, granted permissions, health, capability table and last execution. **Re-check** one connection, or **Re-check all**. **Reconnect** when a reconnect is needed. | Everyone can view. MEMBER and above (`content:create`) can re-check. Connecting needs OWNER/ADMIN. |
| Connection setup | `/dashboard/connections/[connectorId]/setup` | Steps 4 and 5 of **Connect → Authenticate → Authorize → Select account/page → Confirm**: choose the Page or account, review the required permissions (each marked granted or not, with **Reconnect and allow**), then confirm. | OWNER/ADMIN select and confirm. |
| LinkedIn card | `/dashboard/settings/connections` (`components/dashboard/linkedin-connection-card.tsx`) | Connect and disconnect LinkedIn through the dedicated OAuth flow. | OWNER/ADMIN (`linkedin:connect`). |
| Meta data-deletion status | `/meta/data-deletion?code=…` | Public page. Says whether the Meta data-deletion request with that confirmation code was processed. | Public. |

When OAuth fails, the user sees a reason and a next step instead of the provider's raw text (`describeAuthFailure` in `lib/connection-errors.ts`). The codes cover: declined, `redirect_uri` mismatch, invalid scope, missing code, bad or expired state (`bad_state`), a different browser (`state_mismatch`), another user finishing the sign-in (`wrong_user`), `forbidden`, not configured, `exchange_failed` and `no_accounts`.

If the connect flow was started from WhatsApp, the OAuth callback also sends a confirmation there (`notifyUser`, best effort).

## 3. How it works

### 3.1 Starting a connector OAuth flow (`POST /api/connectors/:id`)

1. `requireActiveCompany()`, then `can(role, 'company:update')`. Without that permission the route returns 403.
2. `getProvider(id)`. A connector with no provider returns 404 ("on the roadmap").
3. For OAuth providers:
   - `providerReadiness(id)` checks that the client id and secret env vars are set. If not, it returns 409 naming them.
   - `preflightConnector(id)` (`server/connectors/preflight.ts`) checks the credentials, that the app URL is public, and the exact redirect URI. A blocker returns 409 with its message.
   - `buildAuthorizeUrl()` (`server/connectors/oauth.ts`) returns the consent URL and a binding cookie (`aura_oauth_<connectorId>`).
4. The `state` parameter is a signed token: the company id, connector id, user id and a nonce, HMAC'd with `NEXTAUTH_SECRET` and valid for 10 minutes (`STATE_TTL_MS`). It is not stored in the database.
5. The binding cookie is encrypted and httpOnly (`lib/pkce.ts`, TTL 10 minutes). It holds the state nonce and a PKCE code verifier. The S256 challenge is sent to the provider only when its `pkceEnv` flag is on (`META_OAUTH_PKCE`, `LINKEDIN_OAUTH_PKCE`). The cookie binding applies to every provider.
6. Google GA4 and Search Console share one OAuth client and one redirect path, `/api/connectors/google/callback` (`GOOGLE_REDIRECT_PATH`). Google is sent `access_type=offline` and `prompt=consent`. Meta uses `config_id` instead of `scope` when `META_LOGIN_CONFIG_ID` is set (Facebook Login for Business).

### 3.2 The callback (`GET /api/connectors/:id/callback`)

1. A provider `error` returns `denied` (for `access_denied`) or `error`. A missing `code` or `state` returns `missing_code`.
2. `decodeState()` checks the HMAC and expiry. The connector id comes from the state, not the path, so a shared alias path such as `google` works.
3. `verifyBinding()` requires the cookie, and requires that it matches the state's nonce. The cookie is then deleted, so it can be used once.
4. `requireUser()`. The session user must equal `state.userId` (otherwise `wrong_user`), and must still have `company:update` in `state.companyId` (otherwise `forbidden`).
5. `completeOAuth()` (`connection.service.ts`):
   - exchanges the code (with the verifier when PKCE is on)
   - for Meta, runs `upgradeToken`: the 1–2 hour user token is swapped for the long-lived token (about 60 days) through `fb_exchange_token`
   - runs the provider's `verify()` to get the account label and non-secret metadata. For Meta this is the list of Pages from `me/accounts` with their linked Instagram account. If the account manages no Pages, the connection fails with `no_accounts`.
   - reads granted scopes: Meta from `/me/permissions` (`grantedScopes`), the others from the token response
   - encrypts the tokens with AES-256-GCM (`lib/crypto.ts`) and upserts `Connection`
   - records the discovered accounts (`recordDiscoveredAccounts`) and picks a setup stage (`initialSetupStage`)
   - audits `CONNECTOR_CONNECTED`, plus `CONNECTION_CONFIRMED` (`automatic: true`) when it confirms itself
6. If the setup stage is not `CONFIRMED`, the user is redirected to `/dashboard/connections/<id>/setup?status=authorized`. Otherwise they go back to `/dashboard/connectors?status=connected`.

How the setup stage is chosen:

| Situation | Stage |
| --- | --- |
| New connection with a choice (several Pages) | `AUTHORIZED` → setup page |
| New publishing connection with one account | `ACCOUNT_SELECTED` → setup page to confirm |
| Data-only connector (GA4, HubSpot…) | `CONFIRMED` |
| Reconnect of a confirmed connection whose chosen account still exists | stays `CONFIRMED` |
| API-key connector | `CONFIRMED` on save, after the key is verified |

### 3.3 API keys and email verification

- **API key** (`POST /api/connectors/:id` with a body): validated with `saveApiKeySchema`. `saveApiKey()` verifies the key with the provider before storing it in `apiKeyEnc`, then audits `CONNECTOR_CREDENTIALS_SAVED`. The route sets `maxDuration = 60` because verification calls the provider.
- **Credential resolution** (`resolveCredential`): this is the single accessor used by lead discovery, competitor tracking and analytics. It uses the workspace's `CONNECTED` row first. For an OAuth token within 60 s of expiry it calls `refreshStoredToken`. If the row can't be used, it falls back to the deployment-wide env var (`fallbackEnv`). A key that can no longer be decrypted (for example after an `ENCRYPTION_KEY` rotation) is logged and skipped instead of throwing.
- **Email + one-time code** (`POST /api/connectors/:id/email-verify`): `{ email }` sends a code and `{ code }` redeems it (`server/connectors/email-verification.service.ts`). The code has 6 digits, is hashed at rest, expires after 15 minutes, allows at most 5 attempts and can be used once. It records which account a connector belongs to (`ConnectionKind.EMAIL_CODE`, `verifiedEmail`, `verifiedAt`). It does not grant API access.

### 3.4 Selecting and confirming (Connection Manager)

- `POST /api/connections/:connectorId/select { accountId }`: for Meta, `selectMetaPage` checks the choice live with Meta, so a Page the person no longer manages can't be chosen. Other providers use `selectAccount`.
- `POST /api/connections/:connectorId/confirm`: `confirmConnection` requires a chosen account and no missing core scopes (`missingRequiredScopes`). It then runs `checkConnectionHealth` live and audits `CONNECTION_CONFIRMED`.
- `POST /api/meta/page { pageId }`: the Page picker on the Meta connector card. `pageId` must match `^\d{1,30}$`.

### 3.5 Capabilities (`lib/capabilities.ts`)

A capability is available only when all three of these hold:

1. the provider supports it on that channel (registry level `supported` or `limited`)
2. its scopes were granted
3. the connection's health allows execution

Capabilities: `organic_publishing`, `scheduling`, `organic_analytics`, `paid_ads`, `messaging`, `social_listening`, `influencer_monitoring`, `autonomous_posting`, `data_read`.

| Provider / channel | Organic publishing | Scheduling | Organic analytics |
| --- | --- | --- | --- |
| Meta / FACEBOOK | supported (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`) | supported: Aura publishes at the time | supported with page-read scopes. Impressions and reach also need `read_insights`. |
| Meta / INSTAGRAM | supported (+ `instagram_basic`, `instagram_content_publish`) | limited: the API has no scheduling, so Aura holds the post | supported with `instagram_basic`. Reach, views and saves also need `instagram_manage_insights`. |
| LinkedIn / LINKEDIN | supported (any of `w_member_social`, `w_organization_social`) | limited: Aura holds the post | not in V1 |
| Data connectors (`ga4`, `search-console`, `hubspot`, `mailchimp`, `slack`, `crunchbase`, `google-cse`, `github`) | unsupported | unsupported | — (`data_read` only) |

Paid ads, DMs/inbox, social listening and influencer monitoring are not in V1 for Meta. Autonomous posting is `out_of_scope`. `checkCapability`, `capabilityMatrix` and `capabilitySnapshot` drive the UI table. `executorFor(platform)` maps FACEBOOK/INSTAGRAM to `meta` and LINKEDIN to `linkedin`.

### 3.6 Health (`lib/connection-health.ts`, `server/connections/health.service.ts`)

Statuses (`ConnectionHealth`): `CONNECTED`, `HEALTHY`, `WARNING`, `EXPIRED`, `DISCONNECTED`, `ACTION_REQUIRED`. Execution goes through `CONNECTED`, `HEALTHY` and `WARNING` only (`healthBlocksExecution`).

| Rule | Value |
| --- | --- |
| Expiry warning (token not refreshable) | 10 days before expiry (`EXPIRY_WARNING_MS`) |
| "Recent failure" window | 24 h (`RECENT_FAILURE_MS`) |
| Failures in a row before `ACTION_REQUIRED` | 3 (`FAILURES_FOR_ACTION`) |
| Proactive refresh of refreshable tokens | within 24 h of expiry (`PROACTIVE_REFRESH_MS`) |
| Health considered stale | 6 h (`HEALTH_STALE_MS`) |

- `evaluateHealth()` reports each check separately: token validity, required permissions, provider availability, account/page availability, recent execution failures. It returns an action: `reconnect`, `grant_permissions`, `select_account`, `finish_setup`, `retry_later` or `review_failures`.
- A live check calls the provider's `verify`. For LinkedIn it calls `checkLinkedInToken` (userinfo). A rejected LinkedIn token calls `markLinkedInCredentialInvalid`.
- **Only a live check or a reconnect can clear a blocking status.** An offline re-evaluation can make the status worse, never better.
- `connectionGate(companyId, platform, capability)` is the pre-execution check used by publishing routing, multi-publish previews and the execution handoff.
- `recordExecutionResult()` stores the outcome of every publish attempt (`lastExecutionAt`, `lastExecutionError`, `lastExecutionFailedAt`, `consecutiveFailures`). A credential rejection (Meta code 190, or HTTP 401) marks the connection `ACTION_REQUIRED` at once (`markCredentialInvalid`, `isCredentialRejection`).
- When the status becomes `EXPIRED` or `ACTION_REQUIRED` (or `WARNING` for expiry), reauthorization is requested: the audit `CONNECTION_REAUTH_REQUIRED`, and a WhatsApp message to the person who connected it.

### 3.7 Token lifecycle

- **Refresh** (`refreshStoredToken`) has four outcomes:
  - `refreshed`: new token stored, audited `CONNECTION_TOKEN_REFRESHED`
  - `not_refreshable`: no refresh token (Meta, self-serve LinkedIn), so the status becomes `EXPIRED`
  - `revoked`: `invalid_grant`, so the status becomes `REVOKED` and the tokens are cleared, audited `CONNECTION_REVOKED`
  - `failed`: any other error, so the status becomes `ERROR`
- **Revocation on disconnect** (`disconnect` → `revokeAtProvider`): Meta `DELETE /me/permissions`, Google `oauth2.googleapis.com/revoke`. It is best effort and audited `CONNECTOR_DISCONNECTED`. LinkedIn uses `REVOKE_URL` in `linkedin.service.ts`.
- **Meta deauthorize callback** (`POST /api/meta/deauthorize`): checks the `signed_request` (HMAC with `META_CLIENT_SECRET`, max age 15 min, `SIGNED_REQUEST_MAX_AGE_S`). Then `markRevoked`: status `REVOKED`, tokens cleared, `revokedAt` set, health `DISCONNECTED`.
- **Meta data-deletion callback** (`POST /api/meta/data-deletion`): deletes every Meta `Connection` made by that Facebook user and writes a `CONNECTOR_DISCONNECTED` audit row with a 16-hex `confirmationCode`. It answers with `{ url: /meta/data-deletion?code=…, confirmation_code }`.

### 3.8 LinkedIn

LinkedIn has its own flow (`/api/linkedin/connect` → `/api/linkedin/callback`), its own table (`LinkedInConnection`) and its own CSRF: a nonce whose SHA-256 is kept in the `li_oauth_nonce` cookie (10 min), plus the PKCE binding cookie `li_oauth_pkce`. Scopes requested: `openid profile email w_member_social`. The REST API version is `LINKEDIN_DEFAULT_API_VERSION = '202610'`, and can be overridden with `LINKEDIN_API_VERSION` (`lib/linkedin-api.ts`, `YYYYMM`, with a sunset warning once a version is 12 months old). Post text is escaped for LinkedIn's "little" format (`lib/linkedin-little.ts`).

The Connection Manager mirror row (`credentialRef = 'linkedin_connection'`) is kept in sync by `syncLinkedInMirror`. No token is copied to it.

### 3.9 Graph base URL and the sandbox

`lib/graph-base.ts` decides the Meta Graph host. `META_GRAPH_BASE_URL` and `WHATSAPP_GRAPH_BASE_URL` are honoured only when they point at loopback (`localhost`, `127.0.0.1`, `::1`). Anything else falls back to `https://graph.facebook.com`, so a token can never be sent to another host. `META_GRAPH_VERSION` defaults to `v23.0` (`lib/meta.ts`). See the sandbox in [24-platform-jobs-and-deployment](../24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md).

### 3.10 Meta organic insights

`server/connectors/meta-insights.service.ts` (`collectMetaInsights`) reads published Facebook and Instagram posts from the last 30 days (`INSIGHTS_WINDOW_MS`), each at most once every 6 hours (`INSIGHTS_REFRESH_MS`), up to 50 posts per run. Results are saved as `PerformanceSnapshot` rows with source `META_API`.

- Always read: reactions, comments and shares on Facebook (`pages_read_engagement`), and likes and comments on Instagram (`instagram_basic`).
- Read only when the scope was granted: impressions and clicks on Facebook (`read_insights`), and reach, views, shares and saves on Instagram (`instagram_manage_insights`).
- The insights scopes are requested only when `META_REQUEST_INSIGHTS=true`.
- It runs at the end of `/api/cron/publish`, and only if time is left.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/connectors/page.tsx` | Connectors catalog, OAuth result banner, redirect-URI listing |
| Page | `app/dashboard/connections/page.tsx` | Connection Manager |
| Page | `app/dashboard/connections/[connectorId]/setup/page.tsx` | Select account and confirm (steps 4–5) |
| Page | `app/dashboard/settings/connections/page.tsx` | Hosts the LinkedIn card |
| Page | `app/meta/data-deletion/page.tsx` | Public deletion-status page |
| Component | `components/dashboard/connectors/connector-grid.tsx` | Catalog grid: connect, test, disconnect, API-key entry |
| Component | `components/dashboard/connectors/meta-page-picker.tsx` | Meta Page choice and expiry warning |
| Component | `components/dashboard/connections/connection-manager.tsx` | Health, capabilities, re-check, reconnect |
| Component | `components/dashboard/connections/connection-setup.tsx` | Select and confirm UI |
| Component | `components/dashboard/linkedin-connection-card.tsx` | LinkedIn connect and disconnect |
| API | `app/api/connectors/route.ts` | List connections |
| API | `app/api/connectors/[id]/route.ts` | Status, connect (OAuth URL or API key), disconnect |
| API | `app/api/connectors/[id]/callback/route.ts` | OAuth callback |
| API | `app/api/connectors/[id]/test/route.ts` | Test a stored connection (`testConnection`, audits `CONNECTOR_SYNCED`) |
| API | `app/api/connectors/[id]/email-verify/route.ts` | Email + code verification |
| API | `app/api/connectors/preflight/route.ts` | Preflight result and redirect paths |
| API | `app/api/connections/**` | Records, setup, select, confirm, health |
| API | `app/api/linkedin/{connect,callback,disconnect}/route.ts` | LinkedIn OAuth |
| API | `app/api/meta/{page,deauthorize,data-deletion}/route.ts` | Meta Page choice and Meta platform callbacks |
| Service | `server/connectors/providers.ts` | Provider registry (`PROVIDERS`), `providerReadiness`, `oauthRedirectPaths` |
| Service | `server/connectors/oauth.ts` | Signed state, authorize URL, binding, code exchange, refresh |
| Service | `server/connectors/connection.service.ts` | Save key, complete OAuth, disconnect, revoke, resolve credential, refresh, test |
| Service | `server/connectors/preflight.ts` | Pre-redirect configuration check |
| Service | `server/connectors/email-verification.service.ts` | One-time code flow |
| Service | `server/connectors/meta.service.ts` | Meta status, Page selection, deauthorize, data deletion |
| Service | `server/connectors/meta-insights.service.ts` | Organic metrics collection |
| Service | `server/connections/manager.service.ts` | Records, setup steps, select, confirm, LinkedIn mirror |
| Service | `server/connections/accounts.ts` | Discovered account tree |
| Service | `server/connections/health.service.ts` | Health checks, gate, execution results, revocation, sweep |
| Service | `server/oauth/endpoints.ts` | Every redirect URI and webhook URL for a base URL (used by `pnpm auth:endpoints`) |
| Service | `server/services/linkedin.service.ts` | LinkedIn OAuth, status, publish context, token check |
| Lib | `lib/connectors.ts` | Catalog registry |
| Lib | `lib/connection-manager.ts` | Record shape, `toConnectionRecord` (drops secrets), channels, scopes, account discovery |
| Lib | `lib/capabilities.ts` | Capability registry and checks |
| Lib | `lib/connection-health.ts` | Health rules |
| Lib | `lib/connection-errors.ts` | OAuth failure messages, provider error classification |
| Lib | `lib/meta.ts` | Graph version, scopes, Page parsing, signed requests, token health |
| Lib | `lib/graph-base.ts` | Loopback-only Graph override |
| Lib | `lib/linkedin-api.ts`, `lib/linkedin-little.ts` | LinkedIn version and text escaping |
| Lib | `lib/pkce.ts`, `lib/crypto.ts` | PKCE and browser binding; AES-256-GCM |
| Tests | `tests/connection-manager.test.ts`, `tests/connector-redirect.test.ts`, `tests/oauth-endpoints.test.ts`, `tests/oauth-pkce.test.ts`, `tests/meta.test.ts`, `tests/meta-login.test.ts`, `tests/meta-insights.test.ts`, `tests/graph-base.test.ts`, `tests/linkedin-publish.test.ts` | Unit coverage |

## 5. Data model

| Model / enum | Key fields | Notes |
| --- | --- | --- |
| `Connection` | `companyId`, `connectorId` (unique together), `kind` (`ConnectionKind`), `status` (`ConnectionStatus`), `accountLabel`, `scope` (raw), `scopes[]` (normalised), `accessTokenEnc`, `refreshTokenEnc`, `apiKeyEnc`, `expiresAt`, `metadata` (JSON: Page ids, Instagram id…), `connectedById`, `verifiedEmail`, `verifiedAt`, `provider`, `channels[]`, `providerAccountId`, `credentialRef` (`self` / `linkedin_connection`), `setupStage`, `health`, `healthReason`, `healthCheckedAt`, `lastHealthyAt`, `lastExecutionAt`, `lastExecutionError`, `lastExecutionFailedAt`, `consecutiveFailures`, `capabilities` (JSON snapshot), `confirmedAt`, `revokedAt` | Cascade-deleted with `Company`. Indexed on `companyId` and `health`. |
| `ConnectedAccount` | `connectionId`, `companyId`, `kind`, `externalId`, `name`, `parentId` (self-relation `AccountParent`), `channel`, `selectable`, `selected`, `lastSeenAt`, `metadata` | Provider → account → page tree, ids and names only. Unique on (`connectionId`, `kind`, `externalId`). |
| `LinkedInConnection` | `companyId` (unique), `linkedInUserId`, `displayName`, `avatarUrl`, `accessTokenEnc`, `refreshTokenEnc`, `scope`, `expiresAt`, `status` (`LinkedInConnectionStatus`), `errorMessage`, `connectedAt` | One per company. |
| `ConnectorEmailVerification` | `companyId`, `connectorId`, `email`, `codeHash`, `attempts`, `expiresAt`, `consumedAt` | One-time codes. |
| `ConnectionKind` | `OAUTH`, `API_KEY`, `EMAIL_CODE` | |
| `ConnectionStatus` | `CONNECTED`, `ERROR`, `EXPIRED`, `DISCONNECTED`, `REVOKED` | |
| `ConnectionHealth` | `CONNECTED`, `HEALTHY`, `WARNING`, `EXPIRED`, `DISCONNECTED`, `ACTION_REQUIRED` | |
| `ConnectionSetupStage` | `AUTHORIZED`, `ACCOUNT_SELECTED`, `CONFIRMED` | |
| `LinkedInConnectionStatus` | `PENDING`, `ACTIVE`, `EXPIRED`, `REVOKED`, `ERROR` | |
| Also used | `AuditLog` (connector audits and deletion confirmation codes), `PerformanceSnapshot` (Meta insights), `ContentPublication` (posts to read insights for) | |

## 6. API endpoints

Full list: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| GET | `/api/connectors` | List the workspace's connections | Any member |
| GET | `/api/connectors/:id` | Readiness + connection for one connector | Any member |
| POST | `/api/connectors/:id` | OAuth: returns `authorizeUrl` and sets the binding cookie. API key: verify and store. | `company:update` (OWNER/ADMIN) |
| DELETE | `/api/connectors/:id` | Disconnect (revoke at provider, delete credentials) | `company:update` |
| GET | `/api/connectors/:id/callback` | OAuth redirect target (shared Google alias `/api/connectors/google/callback`) | Signed state + binding cookie + session user + `company:update` |
| POST | `/api/connectors/:id/test` | Test a stored connection | `company:update` |
| POST | `/api/connectors/:id/email-verify` | `{ email }` sends a code, `{ code }` redeems it | `company:update` |
| GET | `/api/connectors/preflight` | Preflight issues and redirect paths | Any member |
| GET | `/api/connections` | All Connection Manager records (no secrets) | Any member |
| GET | `/api/connections/:connectorId` | Record + setup steps + permissions | Any member |
| POST | `/api/connections/:connectorId/select` | `{ accountId }` | `company:update` |
| POST | `/api/connections/:connectorId/confirm` | Confirm + live health check | `company:update` |
| POST | `/api/connections/:connectorId/health` | Re-check one connection | `content:create` (MEMBER+) |
| POST | `/api/connections/health` | Re-check all connections | `content:create` |
| GET | `/api/linkedin/connect` | Start LinkedIn OAuth (redirect) | `linkedin:connect` (OWNER/ADMIN) |
| GET | `/api/linkedin/callback` | LinkedIn OAuth callback | Nonce cookie + `linkedin:connect` |
| POST | `/api/linkedin/disconnect` | Disconnect LinkedIn | `linkedin:connect` |
| GET / POST | `/api/meta/page` | Meta status / choose the Page | GET any member; POST `company:update` |
| POST | `/api/meta/deauthorize` | Meta deauthorize callback | Meta `signed_request` (HMAC) |
| POST | `/api/meta/data-deletion` | Meta data-deletion callback | Meta `signed_request` (HMAC) |
| GET / POST | `/api/cron/connections` | Connection sweep | `CRON_SECRET` |

## 7. External services

| Service | Endpoints used | Env vars |
| --- | --- | --- |
| Meta Graph API / Facebook Login | `facebook.com/<ver>/dialog/oauth`, `graph.facebook.com/<ver>/oauth/access_token`, `me/accounts`, `me`, `me/permissions` (GET/DELETE), post fields and insights | `META_CLIENT_ID`, `META_CLIENT_SECRET`, `META_GRAPH_VERSION`, `META_OAUTH_PKCE`, `META_REQUEST_INSIGHTS`, `META_LOGIN_CONFIG_ID`, `META_GRAPH_BASE_URL` (loopback only) |
| Google OAuth, GA4 Admin, Search Console | `accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, `/revoke`, `analyticsadmin.googleapis.com/v1beta/accountSummaries`, `searchconsole.googleapis.com/webmasters/v3/sites` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| LinkedIn | `linkedin.com/oauth/v2/{authorization,accessToken,revoke}`, `api.linkedin.com/v2/userinfo` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ORG_URN`, `LINKEDIN_OAUTH_PKCE`, `LINKEDIN_API_VERSION` |
| HubSpot | `app.hubspot.com/oauth/authorize`, `api.hubapi.com/oauth/v1/token`, `account-info/v3/details` | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` |
| Mailchimp | `login.mailchimp.com/oauth2/{authorize,token,metadata}` | `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET` |
| Slack | `slack.com/oauth/v2/authorize`, `slack.com/api/oauth.v2.access`, `auth.test` | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| Crunchbase | `api.crunchbase.com/api/v4/searches/organizations` | `CRUNCHBASE_API_KEY` (fallback) |
| Google Custom Search | `googleapis.com/customsearch/v1` | `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX` (fallbacks) |
| GitHub | `api.github.com/user` | `GITHUB_TOKEN` (fallback) |

Also required: `ENCRYPTION_KEY` (token encryption), `NEXTAUTH_SECRET` (state HMAC), and `APP_URL` / `NEXTAUTH_URL` (redirect URIs; connector redirects use `APP_URL`, falling back to `NEXTAUTH_URL`). See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

| Job | Route | Schedule | What it does |
| --- | --- | --- | --- |
| Connection sweep | `/api/cron/connections` | `0 6 * * *` in `vercel.json` (the route comment says hourly is better) | `runConnectionSweep()` (limit 50 per pass): refresh every `CONNECTED` connection with a refresh token expiring within 24 h, then live-check connections not checked for 6 h. Returns `{ refreshed, refreshFailed, checked, changed }`. |
| Meta insights | part of `/api/cron/publish` | `0 9 * * *` | `collectMetaInsights()` when the publish budget leaves time |

## 9. Security & permissions

- **RBAC**: connecting, disconnecting, testing, choosing an account and confirming need `company:update` (OWNER/ADMIN). LinkedIn needs `linkedin:connect` (OWNER/ADMIN). Re-checking health needs `content:create` (MEMBER+). Viewing is open to any member.
- **Workspace scoping**: every route resolves `requireActiveCompany()`. Rows are looked up by (`companyId`, `connectorId`). The OAuth callback re-checks membership in the company named in the signed state.
- **CSRF and replay**: signed, 10-minute state (HMAC with `NEXTAUTH_SECRET`), plus a single-use encrypted binding cookie, plus optional PKCE. The callback also requires the same user.
- **Secrets never reach the browser**: `toConnectionRecord` drops every `*Enc` field. Page tokens are never stored; the publishers derive a fresh one per post.
- **Encryption at rest**: AES-256-GCM with `ENCRYPTION_KEY`.
- **Meta callbacks** are authenticated by `signed_request` HMAC with `META_CLIENT_SECRET` (max age 15 min) and return 503 when the secret is unset.
- **Graph host override** is accepted for loopback only (`lib/graph-base.ts`).
- **Validation**: zod bodies (`accountId` 1–64 chars, `pageId` digits only, email / 6-digit code, `saveApiKeySchema`).

## 10. Testing

| Test | Covers |
| --- | --- |
| `tests/connection-manager.test.ts` | Record model, Meta V1 capability table, permissions, health rules, error messages |
| `tests/connector-redirect.test.ts` | OAuth redirect URIs and connector preflight |
| `tests/oauth-endpoints.test.ts` | `normalizeBaseUrl`, `oauthRedirectUris`, `nextAuthUrlMismatch` |
| `tests/oauth-pkce.test.ts` | PKCE primitives, Meta connector OAuth, LinkedIn |
| `tests/meta.test.ts`, `tests/meta-login.test.ts` | Login model and permissions, Pages, signed state, provider hooks |
| `tests/meta-insights.test.ts` | Insights parsing and optional permissions |
| `tests/graph-base.test.ts` | Loopback-only override, including look-alike hosts |
| `tests/linkedin-publish.test.ts` | LinkedIn publishing inputs |

End-to-end scripts (run against the app and database): `pnpm verify:connections`, `pnpm verify:meta`, `pnpm verify:instagram-api`, `pnpm verify:sandbox` (`pnpm sandbox check`).

## 11. Configuration & limits

| Setting | Value |
| --- | --- |
| OAuth state TTL | 10 min |
| Binding / PKCE cookie TTL | 10 min |
| Token considered fresh | more than 60 s before expiry |
| Proactive refresh window | 24 h |
| Health stale after | 6 h |
| Expiry warning | 10 days |
| Failures for `ACTION_REQUIRED` | 3 in a row |
| Sweep batch size | 50 |
| Email code | 6 digits, 15 min, 5 attempts |
| Meta signed_request max age | 15 min |
| Meta Graph version | `v23.0` (`META_GRAPH_VERSION`) |
| LinkedIn API version | `202610` (`LINKEDIN_API_VERSION`) |
| Insights window / refresh | 30 days / 6 h, 50 posts per run |
| Route `maxDuration` | 60 s (connect, callback); 30 s (email verify) |

## 12. Known limitations & future work

- Meta and self-serve LinkedIn tokens can't be refreshed by a server. Reconnecting is the only renewal, and Aura warns 10 days ahead.
- Detailed Meta insights (impressions, reach, saves) need App Review for `read_insights` and `instagram_manage_insights`, and `META_REQUEST_INSIGHTS=true`. Without them only engagement counts are collected.
- Posting to a LinkedIn Company Page needs the Community Management API (`w_organization_social`) and `LINKEDIN_ORG_URN`.
- 16 connectors in the catalog are `coming_soon` and have no integration.
- `vercel.json` runs the connection sweep daily. Hourly needs a plan that allows it, or an external scheduler.
- Most roadmap connectors would need a provider entry in `server/connectors/providers.ts` and `status: 'available'` in `lib/connectors.ts`.

## 13. Related documents

- [CONNECTION-MANAGER.md](../../../CONNECTION-MANAGER.md)
- [META-INTEGRATION.md](../../../META-INTEGRATION.md), [META-APP-SETUP.md](../../../META-APP-SETUP.md), [META-APP-REVIEW-CHECKLIST.md](../../../META-APP-REVIEW-CHECKLIST.md), [META-APP-REVIEW-SUBMISSION.md](../../../META-APP-REVIEW-SUBMISSION.md)
- [AUTH-SETUP.md](../../../AUTH-SETUP.md), [SANDBOX.md](../../../SANDBOX.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md)
- Sibling features: [20-publishing-execution-and-scheduling](../20-publishing-execution-and-scheduling/01-FEATURE-DETAILS.md), [24-platform-jobs-and-deployment](../24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md), [21-whatsapp-assistant](../21-whatsapp-assistant/01-FEATURE-DETAILS.md), [02-workspaces-team-and-roles](../02-workspaces-team-and-roles/01-FEATURE-DETAILS.md)
