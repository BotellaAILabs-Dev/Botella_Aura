# Connection Manager

This covers the five connection tickets: the Connection Manager data model, the connection flow, capabilities, the token lifecycle, and connection health.

Every integration a workspace has is described in one provider-agnostic way:

- which provider and which channels
- which account authorised it, and which pages or profiles it reaches
- what it was granted
- whether it is healthy
- what it can and cannot do

Nothing here ever sends a token to the browser.

| Piece | File |
| --- | --- |
| Data model, browser-safe view, account discovery | `lib/connection-manager.ts` |
| Capability registry and checks | `lib/capabilities.ts` |
| Health statuses and rules | `lib/connection-health.ts` |
| OAuth error messages, provider-error classification | `lib/connection-errors.ts` |
| Records, setup (select/confirm), LinkedIn mirror | `server/connections/manager.service.ts` |
| Discovered accounts (provider → account → page) | `server/connections/accounts.ts` |
| Health checks, execution gate, execution results, revocation, sweep | `server/connections/health.service.ts` |
| Token refresh/revoke | `server/connectors/connection.service.ts` (`refreshStoredToken`, `revokeAtProvider`) |
| Pages | `/dashboard/connections`, `/dashboard/connections/[connectorId]/setup` |
| Migration | `prisma/migrations/20261017090000_connection_manager` |

## 1. Data model

`Connection` (one per workspace and connector) now also stores:

| Ticket field | Column |
| --- | --- |
| Provider | `provider` (family: `google` for GA4 and Search Console) |
| Workspace | `companyId` |
| User | `connectedById` |
| Connected account, provider account ID | `accountLabel`, `providerAccountId` |
| Page/profile | `ConnectedAccount` rows (see below) |
| Channel | `channels[]` (FACEBOOK, INSTAGRAM, LINKEDIN, WEB…) |
| Permissions/scopes | `scopes[]` (granted, normalised; the raw string stays in `scope`) |
| Access token reference | `credentialRef`: `self` (encrypted on this row) or `linkedin_connection` |
| Token expiration | `expiresAt` |
| Connection status | `status`, which adds `REVOKED`, plus `setupStage` (AUTHORIZED / ACCOUNT_SELECTED / CONFIRMED) |
| Health status | `health`, `healthReason` |
| Supported capabilities | `capabilities` (snapshot), computed live from the registry |
| Last successful connection check | `lastHealthyAt` (`healthCheckedAt` = last check of any outcome) |
| Last successful execution | `lastExecutionAt`, plus `lastExecutionError`, `lastExecutionFailedAt`, `consecutiveFailures` |

**`ConnectedAccount`** holds the provider → account → page tree, as ids and names only:

- **Meta:** the Facebook login → each Page it manages (selectable) → the Instagram account linked to each Page.
- **LinkedIn:** the member, plus the organisation when one is configured.
- **Other providers:** the one account (a GA4 property, a HubSpot portal…).

**LinkedIn** keeps its own `LinkedInConnection` table and tokens. Its Connection Manager record is a mirror:

- `credentialRef = linkedin_connection`, and no token is copied.
- It is kept in sync on connect, disconnect and status change (`syncLinkedInMirror`), and backfilled by the migration.
- Code that counted LinkedIn separately skips the mirror (`NOT_MIRRORED`), so nothing is counted twice:
  - business context
  - coverage
  - snapshot
  - foundations
  - onboarding checklist
  - the connector list

**Tokens never reach the client.** `toConnectionRecord` drops every encrypted field, and the end-to-end suite checks that responses and pages don't contain the token.

## 2. Connection flow

**Connect → Authenticate → Authorize → Select account/page → Confirm.**

The provider's sign-in covers the first three steps. The setup page covers the last two.

**After OAuth (`completeOAuth`)**, Aura records:

- the granted scopes, read from Meta's `/me/permissions` (Meta's token response has none)
- the provider account id
- the discovered accounts
- a setup stage, chosen as follows:

| Situation | Stage |
| --- | --- |
| New connection with a choice (several Pages) | AUTHORIZED → setup page |
| New connection that publishes, with one account | ACCOUNT_SELECTED → setup page to confirm |
| Data-only connector (GA4, HubSpot…) | CONFIRMED (nothing to act on, nothing to choose) |
| Reconnect of a confirmed connection whose chosen account is still there | stays CONFIRMED |
| API-key connectors | CONFIRMED on save (the key is verified first) |

**Selecting a Meta Page** is checked live with Meta (`selectMetaPage`), so a Page the person no longer manages can't be chosen.

**Confirming:**

- requires a chosen account and no missing core permissions
- runs a live health check straight away
- is audited (`CONNECTION_CONFIRMED`)

**Required permissions** are listed on the setup page, each marked granted or not, with **Reconnect and allow**.

**Failed authentication** shows a reason and a next step instead of the raw provider text (`describeAuthFailure`). Cases covered:

- declined
- `redirect_uri` mismatch
- invalid scope
- missing code
- expired or forged state
- another user finishing the sign-in
- no permission
- not configured
- exchange failed
- no Pages

**Roles:** OWNER/ADMIN can select and confirm. Anyone can view.

## 3. Capability framework

`lib/capabilities.ts` is the registry, per provider and channel. Meta V1 matches the ticket:

| Capability | Facebook | Instagram |
| --- | --- | --- |
| Organic publishing | Yes | Yes |
| Scheduling | Yes | Yes, with a limit (no API scheduling; Aura holds the post and publishes it at the time) |
| Organic analytics | Yes, needs `read_insights` | Yes, needs `instagram_manage_insights` |
| Paid ads, DMs/inbox, social listening, influencer monitoring | No | No |
| Autonomous posting | Not in initial scope | Not in initial scope |

A capability is available only when all three of these hold:

- the provider supports it
- its scopes were granted
- the connection is healthy

**Enforcement before execution (`connectionGate`):**

- `publishTo` checks it first, so an unusable connection is never called. The result is `reconnect` with the reason.
- Multi-publish preview blockers use it.
- The execution handoff uses it, adding the new `connection_unhealthy` issue.

The UI shows the full table per connection, with the reason or limit for each "no".

## 4. Token & credential lifecycle

| Requirement | How |
| --- | --- |
| Storage | AES-256-GCM, as before. `credentialRef` says where the secret lives. |
| Backend-only access | Records and pages never include tokens (tested). |
| Expiration detection | `evaluateHealth`: EXPIRED once past expiry and not refreshable; WARNING from 10 days before expiry |
| Refresh where supported | On use (as before) and ahead of time: the sweep refreshes tokens within a day of expiry. Audited `CONNECTION_TOKEN_REFRESHED`. |
| Not refreshable (Meta, LinkedIn self-serve) | EXPIRED, with reauthorization requested |
| Invalid-token detection | Live checks (provider `verify`, LinkedIn userinfo), and publish errors (Meta code 190 / HTTP 401, LinkedIn 401) mark the connection ACTION_REQUIRED at once |
| Revocation | Disconnecting revokes at the provider first (Meta `DELETE /me/permissions`, Google `/revoke`). Best-effort, and the result is audited. |
| Revoked connections marked | Meta deauthorize callback and Google `invalid_grant`: status REVOKED, tokens cleared, `revokedAt`, health DISCONNECTED, audited `CONNECTION_REVOKED` |
| Reauthorization requested | When health becomes EXPIRED or ACTION_REQUIRED (or WARNING for expiry): audited `CONNECTION_REAUTH_REQUIRED`, WhatsApp message to the person who connected it, Reconnect button in the UI |

## 5. Connection health

The statuses are Connected, Healthy, Warning, Expired, Disconnected and Action required. The rules are in `lib/connection-health.ts`, and each check is reported separately:

- token validity
- required permissions
- provider availability
- account/page availability
- recent execution failures

| Status | When |
| --- | --- |
| Connected | Set up, not checked yet |
| Healthy | Checked and everything passed |
| Warning | Expires within 10 days (not refreshable), provider unreachable, or a failure in the last 24 h |
| Expired | Token expired and could not be refreshed |
| Disconnected | Disconnected, or revoked at the provider |
| Action required | Token refused, permission missing, chosen Page gone, setup unfinished, or 3 failures in a row |

**Execution goes through Connected, Healthy and Warning only.** Two more rules apply:

- Only a live check or a reconnect can clear a blocking status. An offline re-evaluation can make it worse, never better.
- Every publish records its outcome (`recordExecutionResult`), which feeds the failure checks.

**Refresh options:**

| Action | Who | Notes |
| --- | --- | --- |
| **Re-check** a connection (`POST /api/connections/:id/health`) | MEMBER and above | Within 15 s, re-judges stored facts without calling the provider |
| **Re-check all** (`POST /api/connections/health`) | MEMBER and above | |
| Cron `/api/cron/connections` | `CRON_SECRET` | Refreshes expiring tokens and re-checks anything not checked in 6 h. Added to `vercel.json` daily (`0 6 * * *`); hourly is better if the plan allows. |

## API

| Route | Who | |
| --- | --- | --- |
| `GET /api/connections` | any member | all records (no secrets) |
| `GET /api/connections/:connectorId` | any member | record + setup steps + permissions |
| `POST /api/connections/:connectorId/select` | OWNER/ADMIN | `{ accountId }` |
| `POST /api/connections/:connectorId/confirm` | OWNER/ADMIN | confirm + live check |
| `POST /api/connections/:connectorId/health` | MEMBER+ | re-check one |
| `POST /api/connections/health` | MEMBER+ | re-check all |
| `GET/POST /api/cron/connections` | `CRON_SECRET` | sweep |

## Tests

- `tests/connection-manager.test.ts`: 27 unit tests covering the model, the Meta V1 table, permissions, health, detection and error messages.
- `pnpm verify:connections`: 51 checks against the running app and database.
  - It uses deliberately fake tokens that Meta really refuses, so invalid-token detection is exercised for real.
  - It also covers workspace isolation, roles, the handoff and publish blocking, every status, refresh, revocation, the cron, the LinkedIn mirror, disconnect, and the pages.

## Known limits

- **Organic analytics on Meta is registered but not yet usable.** Aura doesn't request `read_insights` / `instagram_manage_insights` and doesn't read insights yet. The Connection Manager shows it as "Needs permission" rather than claiming it works. Turning it on needs App Review and the scopes added to `META_SCOPES`.
- **Meta and LinkedIn self-serve tokens can't be refreshed by a server.** Reconnecting is the only renewal; Aura warns 10 days ahead.
