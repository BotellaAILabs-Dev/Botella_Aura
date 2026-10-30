# Chrome Extension (Human Action Layer)

> The Botella Aura companion extension (Manifest V3, "Botella Aura — Action Layer") is the only way Aura's approved work reaches LinkedIn by hand. It shows a panel on linkedin.com listing everything that is approved and waiting: posts (with their generated graphics), outreach connection notes and follow-ups. One click inserts the exact approved text into LinkedIn's own composer. The human clicks LinkedIn's Post or Send button themselves and then confirms in the panel, which syncs the status back to Aura. The same panel drafts Engagement Copilot comments and syncs the metrics visible on the user's own posts. It exists because LinkedIn offers no API for personal outreach or commenting, and Aura will not automate or scrape LinkedIn. The extension keeps a human in every action, with hard rate caps, and authenticates with a narrow, revocable token instead of the web session.

## 1. Overview

- **Extension** (`extension/`, plain JS, no bundler, manifest version `0.3.0`):
  - `background.js`: the service worker. It holds the token and API base in `chrome.storage.local`, is the single place that calls Aura, enforces the client rate caps, and routes messages.
  - `content/linkedin.js` + `linkedin.css`: the "✦ Aura" launcher and action panel on `https://www.linkedin.com/*`.
  - `content/pairing.js`: runs on the Aura web origin and receives the pairing token from the settings page via `window.postMessage`.
  - `popup.html/js/css`: pair by pasting a token, show status, disconnect.
- **Server**:
  - `server/extension/token.service.ts`: issue, verify, list and revoke `aura_ext_…` tokens.
  - `lib/extension-auth.ts`: bearer auth, membership re-check, CORS for extension origins.
  - `server/extension/queue.service.ts`: builds the action queue.
  - `server/extension/action.service.ts`: the sync-back after a human action.
- **Web app**:
  - `/dashboard/settings/extension`: download the extension, pair it, list and revoke tokens.
- **Packaging** (`scripts/package-extension.mjs`):
  - Runs at the start of `pnpm build` and `pnpm vercel-build`.
  - Writes `public/downloads/botella-aura-extension.zip`, so every deploy serves an installable build without a Chrome Web Store listing.

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
|---|---|---|---|
| Browser extension settings | `/dashboard/settings/extension` (`app/dashboard/settings/extension/page.tsx`, `components/dashboard/extension/extension-install-card.tsx`, `extension-manager.tsx`) | Download `/downloads/botella-aura-extension.zip` and follow the unpacked-install steps. **Generate a token** (optional label). The token is shown once, with **Send to extension**, which `postMessage`s it to `pairing.js`. List active tokens (label, created, last used, expiry) and **Disconnect** (revoke). | Page visible to members. The manage controls are enabled for `linkedin:connect` (OWNER, ADMIN). |
| Extension popup | toolbar icon (`popup.html`) | Paste a pairing token, see connection status and usage, set the API base, disconnect (removes the token and the local action log). | Anyone with the extension |
| LinkedIn action panel | `https://www.linkedin.com/*` (`content/linkedin.js`) | Open the "✦ Aura" panel and see the workspace name, the engagement section and **Your queue**. For each item: **Insert into composer** (or **Insert text + image**), **Copy**, then confirm with **Mark as posted** after clicking LinkedIn's own button. **Sync this post's metrics** on your own post. **Draft a comment for this post** (see [16](../16-engagement-copilot/)). | Queue: any role with a token. Mark content posted: `content:publish`. Mark outreach sent / comment posted: `content:approve`. Draft comments / sync metrics: `content:create`. |

When the user is not paired, the panel shows pairing instructions. A 401 from the queue means the token is invalid or revoked, and the user is asked to re-pair.

## 3. How it works

### 3.1 Pairing

1. A signed-in user calls `POST /api/extension/token` (session auth).
2. `issueExtensionToken`:
   - Creates `aura_ext_` + `generateToken(32)`.
   - Stores only `sha256(raw)` with `expiresAt = now + 180 days` (`DEFAULT_TTL_DAYS`).
   - Audits `EXTENSION_TOKEN_ISSUED`.
   - Returns the raw token once.
3. The settings page posts `{ source: 'botella-aura', type: 'AURA_EXT_TOKEN', token }` to its own window. `pairing.js` accepts it only from the same window and origin. It sends `AURA_SET_CONFIG` (pinning `apiBase` to that origin), then `AURA_SET_TOKEN`, and replies with `AURA_EXT_PAIRED`.
4. Alternatively, the user pastes the token into the popup. `DEFAULT_API_BASE` is `http://localhost:3000`. For other origins, `AURA_REQUEST_PERMISSION` asks for an optional host permission and registers `pairing.js` there (`ensurePairingScript`).

### 3.2 Every API call

- `apiFetch` in `background.js` sends `Authorization: Bearer <token>` with no cookies.
- `requireExtensionAuth(req)`:
  - Parses the bearer.
  - `verifyExtensionToken` rejects a missing `aura_ext_` prefix, an unknown hash, `revokedAt` or a past `expiresAt`, and bumps `lastUsedAt` on a best-effort basis.
  - `getMembership(userId, companyId)` must still exist, otherwise 401 "Extension is no longer authorized for this workspace".
- CORS (`corsHeaders`):
  - Echoes any `chrome-extension://` or `moz-extension://` origin. Otherwise `*`.
  - Pinned to `EXTENSION_ALLOWED_ORIGIN` when that is set.
  - Methods `GET, POST, OPTIONS`; headers `authorization, content-type`; max-age 86400.
  - Every route exports `OPTIONS` → `handleOptions`.

### 3.3 The queue (`getQueue`)

Built fresh on each panel open:

- **`content_draft`**: up to 50 `APPROVED` content drafts.
  - Text from `renderForManual`.
  - Skipped when the text is empty or when `approvalIntact(contentRecord(d, hash), hash)` fails, i.e. the body, platform or media changed since approval.
  - Carries `platform`, `platformLabel` and media metadata (asset id, MIME type, dimensions, size, alt text). No image bytes.
  - Target `linkedin_compose`.
- **`outreach_message`**: up to 50 `APPROVED` outreach messages.
  - Skipped when `outreachIntact` fails or the execution gate blocks it (drafted from a recommendation while `CONTEXTUAL_EXECUTION_ENABLED = false`).
  - Title "Connection note → <who>" or "Follow-up → <who>".
  - Target `linkedin_message`. `contextUrl` is the lead's LinkedIn URL.
- Engagement comments are not queued.

### 3.4 Insert and confirm (`content/linkedin.js`)

- `onInsert` fills LinkedIn's Quill editor through `fillEditor`, which selects all and uses `execCommand('insertText')`, falling back to a DOM write.
- If no composer is open, the text is copied to the clipboard with instructions.
- For items with media:
  - `loadMedia(assetId)` calls `GET /api/extension/media/:assetId`, which returns base64 JSON. The script rebuilds a `File` and attaches it if LinkedIn's file input is present.
  - Otherwise the user is told to click the photo icon and press insert again.
- The script never clicks LinkedIn's submit button and never runs on a timer.

### 3.5 Sync-back (`completeAction`)

**Before the call:**

- `AURA_COMPLETE` first runs `checkRate()` against the local action log (pruned to 24h): **8 per hour, 25 per day**. Only a successful call is logged.
- The server route counts today's `EXTENSION_ACTION_COMPLETED` audit rows for the user (`actionsToday`) and returns **429** at 25 (`EXTENSION_DAILY_CAP`).
- The body is validated: `itemType` ∈ `content_draft | outreach_message | engagement_comment`, `itemId`, optional `postedUrl` (a URL).

**Per item type:**

| itemType | Permission | Checks | Effect | Audit |
|---|---|---|---|---|
| `content_draft` | `content:publish` | Must be `APPROVED` (idempotent if `PUBLISHED`); `assertContentIntact` | `PUBLISHED`, `publishedAt`, `publishedUrl`, approval record "executed" | `CONTENT_PUBLISHED` |
| `outreach_message` | `content:approve` | Must be `APPROVED` (idempotent if `SENT`); `outreachIntact`; execution gate | `SENT`, `sentAt`; lead → `CONTACTED` | `OUTREACH_SENT` |
| `engagement_comment` | `content:approve` | Idempotent if `POSTED` | `POSTED`, `postedAt` | `ENGAGEMENT_COMMENT_POSTED` |

After any of these, `EXTENSION_ACTION_COMPLETED` is audited with `via: 'chrome_extension'`.

### 3.6 Status, metrics and media

- **Status:** `GET /api/extension/status` returns `connected`, workspace `company` name, `role`, `actionsToday`, `dailyCap` 25, `hourlyCap` 8 and `queueCount`.
- **Metrics:** `POST /api/extension/metrics` (`content:create`) takes `{ postUrl, ...metrics }` read from the user's own post page (`readPostMetrics`). It calls `recordContentMetrics` with `source: 'EXTENSION_DOM'` (Marketing Memory).
- **Media:** `GET /api/extension/media/:assetId` uses the company-scoped `getAsset`. Videos are refused with 422, because Aura publishes those to Instagram directly.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Extension | `extension/manifest.json` | MV3. Permissions `storage`, `activeTab`, `scripting`; host permissions for localhost:3000, `*.vercel.app`, `*.netlify.app`, `*.up.railway.app`, `*.botella.ai`, `*.linkedin.com`; optional `https://*/*`, `http://*/*` |
| Extension | `extension/background.js` | Token/API base storage, `apiFetch`, rate caps, message hub (`AURA_GET_STATE`, `AURA_REQUEST_PERMISSION`, `AURA_SET_TOKEN`, `AURA_SET_CONFIG`, `AURA_DISCONNECT`, `AURA_STATUS`, `AURA_QUEUE`, `AURA_RATE`, `AURA_MEDIA`, `AURA_SYNC_METRICS`, `AURA_ENGAGE_DRAFT`, `AURA_COMPLETE`) |
| Extension | `extension/content/linkedin.js`, `linkedin.css` | Panel, insert into composer/comment box, media attach, metrics read, engagement drafting |
| Extension | `extension/content/pairing.js` | Receives the token from the Aura settings page |
| Extension | `extension/popup.html`, `popup.js`, `popup.css` | Pair / status / disconnect UI |
| Extension | `extension/README.md` | Install and usage notes |
| Page | `app/dashboard/settings/extension/page.tsx` | Settings page |
| Component | `components/dashboard/extension/extension-install-card.tsx` | Download + install steps |
| Component | `components/dashboard/extension/extension-manager.tsx` | Generate token, send to extension, list, revoke |
| API | `app/api/extension/token/route.ts`, `token/[id]/revoke/route.ts` | Session-auth token issue/list/revoke |
| API | `app/api/extension/{status,queue,actions/complete,media/[assetId],metrics,engagement/draft}/route.ts` | Bearer-auth extension endpoints |
| Service | `server/extension/token.service.ts` | Token lifecycle |
| Service | `server/extension/queue.service.ts` | `getQueue` |
| Service | `server/extension/action.service.ts` | `completeAction`, `actionsToday` |
| Lib | `lib/extension-auth.ts` | `requireExtensionAuth`, CORS helpers, `extJson`, `extError`, `handleExtensionError` |
| Lib | `lib/extension-constants.ts` | `EXTENSION_DAILY_CAP = 25`, `EXTENSION_HOURLY_CAP = 8` |
| Script | `scripts/package-extension.mjs` | Dependency-free STORED zip into `public/downloads/` (excludes `package.json`, `node_modules`, `.md`, `.zip`) |
| Tests | `tests/extension-token.test.ts`, `tests/extension-permissions.test.ts` | Token exchange; role/workspace rules on writes |

## 5. Data model

| Model | Key fields | Notes |
|---|---|---|
| `ExtensionToken` | `userId`, `companyId`, `label?`, `tokenHash` (unique), `createdAt`, `lastUsedAt?`, `expiresAt?`, `revokedAt?` | Cascade-deleted with the user or company. Indexed by `userId` and `companyId`. |
| Uses | `ContentDraft` (+ `media` → `MediaAsset`), `OutreachMessage` (+ `Lead`), `EngagementComment`, `AuditLog` | Status changes on sync-back. `AuditLog` rows with action `EXTENSION_ACTION_COMPLETED` are the server-side counter for the daily cap. |

## 6. API endpoints

Full reference: [INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| GET | `/api/extension/token` | List the caller's active tokens in this workspace | Session, member |
| POST | `/api/extension/token` | Issue a token (raw value returned once) | Session, member |
| POST | `/api/extension/token/:id/revoke` | Revoke one of the caller's tokens | Session, own token only |
| GET | `/api/extension/status` | Connection + usage summary | Bearer |
| GET | `/api/extension/queue` | Approved items awaiting a human action | Bearer |
| POST | `/api/extension/actions/complete` | Record a human action | Bearer + per-type permission; 429 at 25/day |
| GET | `/api/extension/media/:assetId` | One image as base64 JSON | Bearer, company-scoped |
| POST | `/api/extension/metrics` | Sync visible metrics from the user's own post | Bearer, `content:create` |
| POST | `/api/extension/engagement/draft` | Draft a comment | Bearer, `content:create` |
| OPTIONS | all `/api/extension/*` bearer routes | CORS preflight | None |

## 7. External services

- **LinkedIn**: only through the user's own browser session, in the content script. Aura's server makes no LinkedIn call for this feature.
- **Chrome extension APIs**: `chrome.storage.local`, `chrome.runtime`, `chrome.permissions`, `chrome.scripting`.
- **Environment**: `EXTENSION_ALLOWED_ORIGIN` (optional) pins the CORS origin in production. See [ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

Not applicable. The extension runs nothing on a timer. Packaging is a build step, not a job.

## 9. Security & permissions

- **Token isolation:**
  - Only the SHA-256 hash is stored.
  - The raw token lives only in `chrome.storage.local`.
  - Tokens authorize only `/api/extension/*`, never the web session.
  - Each token is scoped to one user and workspace, expires after 180 days, and is revocable. `revokeExtensionToken` matches on `userId`, so users can revoke only their own.
- **Fresh authorization:** membership is re-read on every request, so a removed member's token stops working immediately. Write permissions come from that fresh role: `content:publish` to mark content published, `content:approve` for outreach and comments, `content:create` for metrics and drafts.
- **Workspace scoping:** every lookup in `action.service.ts` and `getAsset` filters by the token's `companyId`. Another workspace's id returns 404 (tested).
- **Approval integrity:** the queue and the sync-back both refuse items changed after approval, and recommendation-drafted outreach blocked by the execution gate.
- **CORS without credentials:** bearer-only auth lets CORS allow extension origins safely.
- **Rate caps:** client 8/hour and 25/day; server 25/day.
- **Pairing message hygiene:** `pairing.js` accepts only same-window, same-origin messages with the expected `source`/`type`.
- **Audit:** `EXTENSION_TOKEN_ISSUED`, `EXTENSION_TOKEN_REVOKED`, `EXTENSION_ACTION_COMPLETED`, plus the per-item audits.

## 10. Testing

- `tests/extension-token.test.ts`: issues an `aura_ext_` token storing only its hash; verifies a fresh token; rejects unknown, wrong-prefix, revoked and expired tokens.
- `tests/extension-permissions.test.ts`: an admin token can mark approved outreach sent; another workspace's item is not found whatever the role.
- `pnpm verify:approval` touches extension behaviour (approval integrity before hand-off). There is no dedicated `verify:extension` script.

## 11. Configuration & limits

| Setting | Value | Source |
|---|---|---|
| Token prefix / TTL | `aura_ext_` / 180 days | `token.service.ts` |
| Daily cap | 25 (client and server) | `lib/extension-constants.ts`, `background.js` |
| Hourly cap | 8 (client only) | same |
| Queue size | 50 content drafts + 50 outreach messages | `getQueue` |
| Default API base | `http://localhost:3000` | `background.js` |
| CORS max-age | 86400 s | `corsHeaders` |
| Env vars | `EXTENSION_ALLOWED_ORIGIN` (optional) | `lib/extension-auth.ts` |

## 12. Known limitations & future work

- **Token UI and API permissions differ.** The settings page enables management only for `linkedin:connect` (OWNER/ADMIN), but `POST /api/extension/token` accepts any member, including VIEWER. Writes are still role-checked per action.
- **The hourly cap is client-side only.** A modified extension could exceed 8/hour; the server enforces only the daily 25.
- **Server day boundary.** `actionsToday` counts from local midnight on the server, while the client uses a rolling 24h window.
- **Engagement comments are not queue items** (see [16](../16-engagement-copilot/)).
- **DOM selectors are best-effort.** LinkedIn markup changes can break insertion; the clipboard fallback keeps the flow usable.
- **Not on the Chrome Web Store.** Installs are unpacked from the deploy's zip. The manifest is `0.3.0` while `extension/package.json` says `0.2.0`.

## 13. Related documents

- [SPRINT-4-TECHNICAL.md](../../../SPRINT-4-TECHNICAL.md), section 5 (Chrome Extension v1)
- [SPRINT-5-TECHNICAL.md](../../../SPRINT-5-TECHNICAL.md) (metrics sync)
- [APPROVAL-MODEL.md](../../../APPROVAL-MODEL.md), [EXECUTION-HANDOFF.md](../../../EXECUTION-HANDOFF.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md), [MEDIA-STORAGE.md](../../../MEDIA-STORAGE.md)
- [extension/README.md](../../../../extension/README.md)
- Sibling features: [15 Leads & Outreach](../15-leads-and-outreach/), [16 Engagement Copilot](../16-engagement-copilot/), [11 Content Studio](../11-content-studio/), [12 Media & Graphics](../12-media-graphics-and-creatives/), [13 Review & Approval](../13-review-approval-versions-and-trace/), [18 Marketing Memory](../18-marketing-memory-and-analytics/), [20 Publishing](../20-publishing-execution-and-scheduling/)
- [Architecture](./02-ARCHITECTURE.md)
