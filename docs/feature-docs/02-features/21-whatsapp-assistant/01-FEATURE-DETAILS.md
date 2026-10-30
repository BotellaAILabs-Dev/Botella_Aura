# WhatsApp AI Assistant

> The WhatsApp assistant lets people use Aura by messaging one central Botella WhatsApp number, through Meta's WhatsApp Cloud API. A person links their number to their Aura account with a two-way check: a single-use link signed in on the website, then a 6-digit code sent back from the phone. After that they can choose a workspace and do what their role allows: see what matters today, opportunities, suggestions, campaigns, the calendar, analytics and pending approvals; write a post or generate an image; approve or reject; publish to LinkedIn, Facebook and Instagram; or start connecting an account. Every change needs an explicit, single-use "yes". It exists so owners and teams can keep Aura moving from their phone without opening the dashboard, while keeping Aura's permissions, approvals and tenant isolation exactly as strict as on the web.

## 1. Overview

- **Inbound pipeline:**
  1. `POST /api/webhooks/whatsapp` verifies Meta's `X-Hub-Signature-256` HMAC over the raw body.
  2. It parses the payload, stores each message once (keyed on `wamid`), queues a `WhatsAppJob`, and answers Meta at once.
  3. `drainConversations` runs after the response via `waitUntil`.
  4. The cron sweep (`/api/cron/whatsapp`) picks up anything left over.
- **Queue** (`server/whatsapp/queue.ts`):
  - Postgres only.
  - A worker leases a conversation (compare-and-swap on `leaseUntil`, 90 s) and handles its jobs oldest first.
  - Retries back off 15 s → 60 s → 5 min.
  - After 4 attempts a job is `DEAD` and the person gets an apology.
- **Deciding the answer** (`server/whatsapp/agent.ts`, `decide`), in this order:
  1. STOP/START
  2. a link code
  3. sign-in for unknown or expired numbers
  4. account commands (menu, switch, logout, workspace choice)
  5. workspace picker
  6. the tool router
- **Tool router** (`server/whatsapp/router.ts`), in this order:
  1. tapped ids
  2. answers to pending questions
  3. deterministic intent matching (`lib/whatsapp-intent.ts`)
  4. the AI router (chooses one tool from the ones the role allows)
  5. the menu
- **Tools** (`server/whatsapp/tools/*`): a fixed, typed registry over existing Aura services (home, opportunities, suggestions, campaigns, approvals, drafts, calendar, analytics, business context, connections, account, generate/edit/submit post, image generation, social publishing, approve/reject, connect account).
- **Sending** (`server/whatsapp/whatsapp.service.ts`, `client.ts`):
  - Free-form messages only inside Meta's 24-hour window, never after STOP.
  - Retryable Meta errors back off over 6 attempts.
  - Statuses (`sent` / `delivered` / `read` / `failed`) are applied from webhooks.
- **Website side:**
  - `/whatsapp/link/[token]`: confirm a sign-in.
  - `/whatsapp/connect/[intent]`: a signed link that starts the existing OAuth flow.
  - `/dashboard/whatsapp-assistant`: status, own links, workspace on/off, 7-day stats, problems, conversations, message a member.
- **Notifications** (`server/whatsapp/notify.ts`, `notifyUser`): other features (LinkedIn/connector callbacks, connection health, Instagram processing) send a short message to a linked user's number, subject to the same window and opt-out rules.

## 2. User-facing behaviour

### On WhatsApp

| Situation | What happens |
|---|---|
| Unknown number says anything | Welcome text plus a "Log in to Aura" CTA button with a single-use link (expires in 10 minutes). At most 5 links per number per hour. |
| Link confirmed on the website | The page shows a 6-digit code (and a one-tap `wa.me` link when `WHATSAPP_DISPLAY_NUMBER` is set). The person sends the code back; formats "123456", "123 456" and "LINK 123-456" are accepted. |
| Code arrives from the same number | "✅ This WhatsApp number is now linked to your Aura account". Then the workspace picker, or the main menu when only one workspace allows WhatsApp. 5 wrong codes cancel the sign-in. |
| "hi", "menu", "help", "home" … | The main menu: a list of up to 10 categories this role can use (Dashboard, Content Studio, Campaigns, AI Opportunities, Recommendations, Business Context, Content Calendar, Pending Approvals, Analytics, Connected Accounts). "account" opens Account Settings. |
| "switch" / "workspace" | Workspace picker, listing only workspaces the user belongs to that have WhatsApp turned on |
| "logout", "unlink" … | Unlinks the number |
| STOP / START | Opt out / opt in. Nothing is sent after STOP except the confirmation. |
| A request ("show my latest opportunities", "write a LinkedIn post about our new menu") | Intent match or AI routing to one tool, checked against the role |
| Approve / reject / publish / connect | The assistant shows exactly what will happen, with **Yes / Cancel** buttons. The confirmation is single use and expires in 10 minutes. A second explicit yes is asked when Aura needs a person to vouch for unverified facts or review flags. |

### On the website

| Screen | Route | What the user can do | Roles |
|---|---|---|---|
| Confirm sign-in | `/whatsapp/link/[token]` (`components/whatsapp/link-whatsapp.tsx`) | Signed out → redirected to log in and back. Signed in → see the last 4 digits and profile name of the number, then **Confirm** (shows the code) or **This isn't me** (cancels). Viewing does not use up the link. | Any signed-in user |
| Connect from WhatsApp | `/whatsapp/connect/[intent]` (route handler) | Verifies the signed intent (15-minute TTL) is for this user and that they may still connect, then starts the LinkedIn or Meta OAuth flow. Errors redirect to `/dashboard/settings/connections?error=…`. | The user it was made for, with `linkedin:connect` (LinkedIn) or `company:update` (Meta) |
| WhatsApp assistant | `/dashboard/whatsapp-assistant` (`app/dashboard/whatsapp-assistant/page.tsx`, `components/whatsapp/assistant-controls.tsx`) | **Everyone:** whether WhatsApp is configured (missing variable names only), whether it is on here, and their own linked numbers (state, workspace, last used) with **Unlink**. **Owners/admins also:** on/off toggle, members using WhatsApp here (with **Message member**), 7-day message counts and statuses, problems (failed sends and dead jobs), recent conversations for this workspace only. | View: member. Manage: `company:update` |

## 3. How it works

### 3.1 Webhook (`app/api/webhooks/whatsapp/route.ts`)

- **`GET`:** answers Meta's subscription handshake with `hub.challenge` (plain text) when `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN`. Otherwise 403.
- **`POST`:**
  - Returns 503 if any of the four required variables is missing (fail closed).
  - Returns 413 above 1,000,000 bytes.
  - Verifies the signature in constant time over the raw text. A bad signature gets 401, and nothing is parsed or stored.
  - `parseWebhook(body, phoneNumberId)` ignores changes for other numbers. A signed but unreadable payload is acknowledged and logged so Meta does not redeliver it forever.
  - `processWebhook`:
    - `recordInbound` finds or creates the `WhatsAppConversation` by `waIdHash = keyedHash(waId)`, stores the number AES-256-GCM encrypted plus its last 4 digits, and moves `lastInboundAt` forward only.
    - It stores the `WhatsAppMessage(INBOUND, RECEIVED)` once per `wamid` and creates its `WhatsAppJob(QUEUED)`.
    - `applyStatus` applies delivery statuses forward only (`shouldApplyStatus`).
  - Returns 200 with counts, then `waitUntil(drainConversations({ budgetMs: 50_000 }))`.
  - A storage failure returns 500 so Meta redelivers. Duplicates are recognised on the retry.

### 3.2 Queue (`queue.ts`)

- **`drainConversation`:**
  - Leases the conversation for `LEASE_MS = 90_000`.
  - Repeatedly takes the head job (oldest `QUEUED`/`RUNNING`) and claims it with a compare-and-set on status + attempts.
  - Runs `handleInbound`.
  - Stops when less than 20 s of budget remains.
- **Failures:**
  - A failed job goes back to `QUEUED` with `runAfter` backed off (15 s, 60 s, 5 min) and blocks the jobs behind it, so order is kept.
  - At `MAX_JOB_ATTEMPTS = 4` it becomes `DEAD`, and the person gets `FALLBACK_TEXT`.
  - A `RUNNING` job older than 2 minutes is treated as abandoned.
- **Concurrency:** `drainConversations` runs up to `WHATSAPP_WORKER_CONCURRENCY` (default 48) conversations in parallel.
- **`sweepQueue` (cron):**
  - Drains up to 25 due conversations.
  - Runs `retryDueMessages` (outbound retries).
  - Runs `applyRetention`, which deletes message text and jobs older than `WHATSAPP_RETENTION_DAYS` (default 90), unlinked idle conversations entirely, and spent challenges.
  - Advances Instagram posts still processing (`advanceProcessing`).

### 3.3 Answering one message (`handler.ts` → `agent.ts` → `router.ts`)

1. **Idempotency:** if a threaded outbound reply to this message exists, stop (`already_answered`). Otherwise mark the inbound message read.
2. **Flood limit:** 20 handled messages per conversation per minute (`REPLY_LIMIT`). STOP is exempt.
3. **`decide`:**
   1. **Opt keywords:** STOP, UNSUBSCRIBE, STOP ALL, OPT OUT, OPTOUT, START, SUBSCRIBE, OPT IN, UNSTOP. They update `optedOut` and audit `WHATSAPP_OPTED_OUT` / `WHATSAPP_OPTED_IN`. An opted-out conversation gets no reply.
   2. **Link code:** a 6-digit code with a `CONFIRMED` challenge pending calls `completeWithCode`. Errors are `wrong`, `locked` (5 attempts), `expired` or `no_pending`.
   3. **`resolveSession`:**
     - `unlinked` or `expired` means a new sign-in link.
     - Otherwise it re-reads `CompanyMember` and the workspace's WhatsApp setting on **every** message.
     - It auto-selects the only allowed workspace.
     - It reports `lostAccess` as `removed` or `turned_off`.
   4. **Account commands:** they also drop any pending confirmation.
   5. **Workspace check:** no active workspace means the picker.
   6. **Route:** `route()` runs with a `ToolContext` built only from the session (`userId`, `companyId`, `role`).
4. **`route`:**
   - A pending confirmation is answered only by the very next message. Anything else drops it.
   - Then, in order: reply ids (`menu`, `cat:`, `tool:`, `connect:`, `plat:`, `pub:go`, `draft:`, `confirm:`, `cancel:`, `act:<action>:<draftId>`), awaited answers (topic, social topic, platforms, edit instructions; 10-minute TTL), typed yes/no, `matchIntent`, and finally `aiRoute`.
5. **`aiRoute`:**
   - Uses `completeStructured` with `tier cheap`, `effort low`, `maxTokens 300`, a 15 s timeout and 1 attempt.
   - The model sees only the tools the role may use (draft actions only when a draft is open) and the last 6 messages **of this workspace**, fenced as data.
   - It must return `{tool, args, clarify}`. An unknown or disallowed tool id is ignored.
6. **`runTool`:**
   - Checks `mayUse(tool, role)` against `lib/rbac.ts`.
   - Validates `args` with the tool's Zod schema.
   - Then runs it.
7. **Replies:**
   - `sendContent` sends each part, threading only the first to the inbound message.
   - Progress notes ("Writing your post…") go out unthreaded via `sendNow`.
   - The handled `companyId` is stamped on the inbound message.

### 3.4 Tools and permissions

| Tool id | Category | Permission | Wraps |
|---|---|---|---|
| `home`, `opportunities`, `suggestions`, `campaigns`, `approvals`, `drafts`, `calendar`, `analytics`, `business`, `connections`, `account` | read | none (any member) | `getAuraHome`, `listOpportunities`, `getSuggestions`, `listCampaigns`, `listReviewQueue`, `listDrafts`, `getAnalytics`, `getBusinessContext`, `listConnections`, … |
| `show_draft`, `publish_preview` | content | none | `getDraft`, `previewPublishing` |
| `generate_post`, `edit_draft`, `submit_draft`, `generate_image`, `use_image`, `plan_social_post` | content | `content:create` | `generateDraft`, image jobs (`enqueueJob`/`runJob`), `attachAsset` |
| `approve_draft`, `reject_draft` | approvals | `content:approve` | `runReviewAction` (same AI review, compliance and fact checks as the web) |
| `publish_draft` | content | `content:publish` | `publishToPlatforms` (multi-network one-click publishing) |
| `connect_account` | connections | `company:update` | `signIntent` → `/whatsapp/connect/[intent]` |

Approve, reject and publish first store a `PendingAction` with a random nonce in `WhatsAppAccountLink.state` (`PENDING_TTL_MS = 10 min`). Only `confirm:<nonce>` or a typed yes as the next message runs it. Blocking review or fact-check problems cannot be overridden from WhatsApp. `facts_need_review` and `review_needs_human` ask for a second explicit yes.

### 3.5 Linking (`link.service.ts`, `lib/whatsapp-link.ts`)

1. **Issue the link:** `issueChallenge` cancels earlier unfinished challenges and creates one with `tokenHash = sha256(token)` and `expiresAt = +10 min`. The URL is `/whatsapp/link/<token>`.
2. **Confirm on the website:** `confirmChallenge` (same-origin check, signed-in user, 10 per 10 min) moves `ISSUED → CONFIRMED` with a compare-and-swap. It stores `sha256(code)` with a new 10-minute expiry, audits `WHATSAPP_LINK_CONFIRMED`, and returns the code once.
3. **Complete with the code:** `completeWithCode` compares hashes and counts wrong attempts. At 5 the challenge is `CANCELLED`. A correct code moves it to `COMPLETED` and upserts `WhatsAppAccountLink` with `expiresAt = +30 days` (`SESSION_TTL_MS`). It audits `WHATSAPP_LINKED`, plus `WHATSAPP_UNLINKED` (reason `replaced`) for a previous owner.
4. **Choose a workspace:** `selectWorkspace` accepts only workspaces the user is a member of with WhatsApp on, and audits `WHATSAPP_WORKSPACE_SELECTED`.
5. **Unlink:** from WhatsApp (`unlinkConversation`) or the web (`revokeLinkForUser`), audited `WHATSAPP_UNLINKED`.

### 3.6 Sending (`whatsapp.service.ts`, `client.ts`)

- **`sendContent`:**
  - Refuses opted-out conversations unless `allowOptedOut`.
  - Outside the 24-hour window (`SERVICE_WINDOW_MS`) it records the message as `FAILED` without sending.
  - Otherwise it stores `OUTBOUND, PENDING` and calls the Graph API `messages` endpoint (15 s timeout).
- **Retries:**
  - Retryable Meta codes (1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004) get one quick retry for throttling codes (`WHATSAPP_QUICK_RETRY_MS`, default 1000), then backoff of 1 min, 5 min, 15 min, 1 h, 3 h, up to `MAX_ATTEMPTS = 6`, via `retryDueMessages`.
  - Non-retryable errors (e.g. 131047, outside the window) fail at once and audit `WHATSAPP_SEND_FAILED`.
- **Content shapes:** `OutboundContent` covers text, buttons (≤ 3), lists (≤ 10 rows), CTA URL buttons and images. `fitContent` clamps to Meta's interactive limits, and text is limited to 4,096 chars.

### 3.7 Workspace setting and admin messages

- **On/off setting:** `Company.preferences.whatsappAssistant.enabled`, on by default. `setWhatsAppEnabled` merges into `preferences` and audits `WHATSAPP_SETTINGS_UPDATED`. Turning it off removes the workspace from choices, and active users are moved off on their next message.
- **Admin messages:** `sendAdminMessage` lets an owner or admin send 1-1,000 chars of text to a member who uses WhatsApp in this workspace. Recipients outside the 24-hour window or opted out are skipped. The message is signed with the sender's name and audited `WHATSAPP_ADMIN_MESSAGE_SENT`.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Webhook | `app/api/webhooks/whatsapp/route.ts` | Handshake, signature, store + queue, `waitUntil` drain |
| Cron | `app/api/cron/whatsapp/route.ts` | `sweepQueue` (CRON_SECRET) |
| API | `app/api/whatsapp/{features,conversations,send,settings,links,links/[id],link/confirm,link/cancel}/route.ts` | Website API (section 6) |
| Page | `app/dashboard/whatsapp-assistant/page.tsx` | Dashboard |
| Page | `app/whatsapp/link/[token]/page.tsx` | Sign-in confirmation |
| Route | `app/whatsapp/connect/[intent]/route.ts` | Connect landing → OAuth |
| Component | `components/whatsapp/assistant-controls.tsx` | `WhatsAppToggle`, `UnlinkButton`, `MessageMemberButton` |
| Component | `components/whatsapp/link-whatsapp.tsx` | Confirm / cancel UI and code display |
| Service | `server/whatsapp/whatsapp.service.ts` | `recordInbound`, `sendContent`, `sendText`, `retryDueMessages`, `applyStatus`, `processWebhook` |
| Service | `server/whatsapp/queue.ts` | Leases, jobs, `drainConversation(s)`, `sweepQueue`, `applyRetention` |
| Service | `server/whatsapp/handler.ts` | `handleInbound` (idempotency, flood limit, send) |
| Service | `server/whatsapp/agent.ts` | `decide` |
| Service | `server/whatsapp/router.ts` | `route`, `runTool`, `aiRoute` |
| Service | `server/whatsapp/tools/{registry,types,state,read,content,social,approval,connect}.ts` | Tool registry, menus, session state, tools |
| Service | `server/whatsapp/link.service.ts` | Challenges, sessions, workspace selection, unlinking |
| Service | `server/whatsapp/client.ts` | Graph API client, error classification |
| Service | `server/whatsapp/{settings,dashboard.service,admin-message,notify,features,connect-intent}.ts` | Workspace setting, dashboard data, admin message, notifications, feature list, signed connect intents |
| Lib | `lib/whatsapp.ts` | Config, signature, payload schema/parsing, window, opt keywords, content shapes and limits |
| Lib | `lib/whatsapp-link.ts` | TTLs, code parsing, commands, session state, `wa.me` links, same-origin check, role labels |
| Lib | `lib/whatsapp-intent.ts` | Deterministic intent matching, platform parsing, typed yes/no |
| Lib | `lib/whatsapp-format.ts` | WhatsApp text formatting helpers |
| Scripts | `scripts/verify-whatsapp*.ts`, `scripts/whatsapp-check.ts`, `scripts/demo-whatsapp.ts`, `scripts/demo-whatsapp-local.ts`, `scripts/load/whatsapp-load.ts`, `scripts/load/meta-stub.ts` | Verifiers, live Meta check, demos, load test and local Graph stub |
| Tests | `tests/whatsapp*.test.ts` (10 files) | See section 10 |

## 5. Data model

| Model / enum | Key fields | Notes |
|---|---|---|
| `WhatsAppConversation` | `waIdHash` (unique HMAC), `waIdEncrypted`, `waIdLast4`, `profileName?`, `lastInboundAt?`, `lastMessageAt`, `optedOut`, `optedOutAt?`, `leaseUntil?` | One per number. Has messages, jobs, challenges and an optional link. |
| `WhatsAppLinkChallenge` | `conversationId`, `tokenHash` (unique), `status`, `userId?`, `codeHash?`, `codeAttempts`, `expiresAt`, `confirmedAt?`, `completedAt?` | Two-way sign-in |
| `WhatsAppAccountLink` | `conversationId` (unique), `userId`, `activeCompanyId?`, `linkedAt`, `lastUsedAt`, `expiresAt`, `revokedAt?`, `revokedReason?`, `state` JSON | The WhatsApp "session". `state` holds `draftId`, `pending`, `awaiting`, tagged with its workspace. |
| `WhatsAppJob` | `conversationId`, `messageId` (unique), `status`, `attempts`, `runAfter`, `startedAt?`, `finishedAt?`, `lastError?` | Indexed on `(status, runAfter)` and `(conversationId, status, createdAt)` |
| `WhatsAppMessage` | `conversationId`, `direction`, `wamid?` (unique), `type`, `body?`, `payload?`, `status`, `replyToId?`, `companyId?`, `attempts`, `nextAttemptAt?`, `errorCode?`, `errorMessage?`, timestamps | `companyId` decides which workspace's dashboard may show it |
| Enums | `WhatsAppDirection` (INBOUND, OUTBOUND), `WhatsAppMessageStatus` (RECEIVED, PENDING, SENT, DELIVERED, READ, FAILED), `WhatsAppLinkChallengeStatus` (ISSUED, CONFIRMED, COMPLETED, CANCELLED), `WhatsAppJobStatus` (QUEUED, RUNNING, DONE, DEAD) | |
| Uses | `Company.preferences.whatsappAssistant`, `CompanyMember`, `ContentDraft`, `ContentPublication`, `AuditLog` | |

## 6. API endpoints

Full reference: [INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| GET | `/api/webhooks/whatsapp` | Meta subscription handshake | `WHATSAPP_VERIFY_TOKEN` |
| POST | `/api/webhooks/whatsapp` | Messages and statuses | `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET` |
| GET, POST | `/api/cron/whatsapp` | Sweep: jobs, send retries, retention, Instagram processing | `Bearer $CRON_SECRET` |
| GET | `/api/whatsapp/features` | What this role can do on WhatsApp here (from the tool registry) | Session, member |
| GET | `/api/whatsapp/conversations?limit=&messages=` | Conversations handled for the active workspace | Session. `company:update` sees all members; others see their own numbers. |
| POST | `/api/whatsapp/send` | Owner/admin text to a member using WhatsApp here | Same-origin, `company:update`, 10/min |
| PATCH | `/api/whatsapp/settings` | Turn WhatsApp on/off for the workspace | Same-origin, `company:update` |
| GET | `/api/whatsapp/links` | Own linked numbers (last 4 only) | Session |
| DELETE | `/api/whatsapp/links/:id` | Unlink one of your own numbers (404 for others') | Same-origin, session |
| POST | `/api/whatsapp/link/confirm` | Confirm a sign-in link, get the code | Same-origin, session, 10 per 10 min |
| POST | `/api/whatsapp/link/cancel` | "This isn't me" | Same-origin, session |
| GET | `/whatsapp/connect/:intent` | Start OAuth from a WhatsApp connect link | Session; intent signed for this user |

## 7. External services

- **Meta WhatsApp Cloud API** (Graph API, default `v23.0`): send messages, mark read, receive webhooks.
- **Facebook/Instagram/LinkedIn** publishing through `server/content/multi-publish.service.ts` (see [20 Publishing](../20-publishing-execution-and-scheduling/)).
- **AI provider** via `server/ai/claude.ts` for routing and content generation (see [23 AI Layer](../23-ai-layer/)).

| Variable | Required | Purpose |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | yes | System-user token |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | The central number's id |
| `WHATSAPP_APP_SECRET` | yes | Webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | yes | Webhook handshake |
| `WHATSAPP_GRAPH_API_VERSION` | no | Default `v23.0` |
| `WHATSAPP_DISPLAY_NUMBER` | no | Enables `wa.me` one-tap code links; shown on the dashboard |
| `WHATSAPP_WORKER_CONCURRENCY` | no | Default 48 |
| `WHATSAPP_QUICK_RETRY_MS` | no | Default 1000 |
| `WHATSAPP_RETENTION_DAYS` | no | Default 90 (minimum 1) |
| `WHATSAPP_GRAPH_BASE_URL` | never in production | Loopback-only override for the local stub and load tests |
| `ENCRYPTION_KEY`, `CRON_SECRET`, `APP_URL`, `NEXTAUTH_SECRET` | yes (shared) | Number encryption/hashing, cron auth, absolute links, sessions |

See [ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

- **Kick:** the webhook calls `drainConversations` through `waitUntil` (budget 50 s, route `maxDuration 60`). Normal replies need nothing else.
- **Sweep:** `GET|POST /api/cron/whatsapp` should run every 1-5 minutes. It is **not** in `vercel.json`; per [WHATSAPP-ASSISTANT.md](../../../WHATSAPP-ASSISTANT.md), use Vercel Pro cron or an external scheduler.
- **Without the sweep:** throttled sends are not retried, lost kicks are not picked up, retention does not run, and Instagram processing notices are not sent.
- **Image generation from WhatsApp** uses the platform job system (`server/jobs/job.service.ts`, `runners`). See [24](../24-platform-jobs-and-deployment/).

## 9. Security & permissions

- **Webhook authentication:**
  - HMAC-SHA256 of the raw body, compared in constant time before parsing.
  - 503 when not configured.
  - Body size capped.
- **Idempotency:** `wamid` is unique, and the reply-exists check prevents double answers. Every state change in linking and the queue is a compare-and-swap.
- **A number alone grants nothing:** linking needs a signed-in website confirmation plus the code from the same number. Tokens and codes are stored only as SHA-256 hashes. Links last 10 min, codes 10 min, sessions 30 days. 5 code attempts, 5 links per hour.
- **Fresh authorization:**
  - Membership, role and the workspace's WhatsApp setting are re-read on every message.
  - Tools get `companyId` from the session only.
  - Each tool declares an RBAC permission, checked by `runTool`.
  - The AI router only picks among allowed tools, and user text is fenced as data.
- **Human confirmation:** approve, reject, publish and connect need a single-use, 10-minute confirmation answered by the next message. Blocking review or fact-check results cannot be overridden.
- **Tenant isolation:**
  - Messages are stamped with `companyId`.
  - AI history and dashboards read only the active workspace's messages.
  - Session state is tagged with its workspace.
  - `/api/whatsapp/conversations` shows non-managers only their own numbers.
- **Personal data:**
  - The number is stored as an HMAC (`keyedHash`) for lookup, encrypted (`encrypt`, AES-256-GCM) for replying, and its last 4 digits for display.
  - Message text is deleted after the retention period.
  - Never-linked idle conversations are deleted entirely.
- **Website routes:** `isSameOrigin` on every state-changing call. Rate limits on confirm (10/10 min) and send (10/min).
- **Meta policy:** free-form replies only inside 24 hours, STOP honoured at once, no marketing or template sends.

## 10. Testing

**Unit tests** (`tests/`):

- `whatsapp.test.ts`: webhook handshake and signature, payload parsing.
- `whatsapp-service.test.ts`: Cloud API client and the sending service.
- `whatsapp-client.test.ts`: Graph host rules.
- `whatsapp-link.test.ts`: linking rules.
- `whatsapp-session-state.test.ts`: session state.
- `whatsapp-agent.test.ts`: intent matching without a model.
- `whatsapp-social.test.ts`: social publishing requests.
- `whatsapp-assistant.test.ts`: messages recorded against their workspace.
- `whatsapp-dashboard.test.ts`: the assistant page.
- `whatsapp-connect-route.test.ts`: the connect landing route.

**Verify scripts** (against a running app and real database):

- `pnpm verify:whatsapp`: handshake, signature, queue.
- `pnpm verify:whatsapp-link`: account linking.
- `pnpm verify:whatsapp-agent`: menu, reads, drafts, approvals.
- `pnpm verify:whatsapp-social`: social publishing.

**Other scripts:**

- `pnpm whatsapp:check`: live Meta credentials check, optional `--to` send.
- `pnpm demo:whatsapp`: Cloudflare tunnel demo.
- `pnpm whatsapp:local`: local sandbox.
- `pnpm load:meta-stub` + `pnpm load:whatsapp`: load test.

## 11. Configuration & limits

| Setting | Value | Source |
|---|---|---|
| Sign-in link / code / session TTL | 10 min / 10 min / 30 days | `lib/whatsapp-link.ts` |
| Code attempts / links per hour | 5 / 5 | `lib/whatsapp-link.ts` |
| Confirmation TTL | 10 min | `PENDING_TTL_MS` |
| Awaited answer TTL | 10 min | `AWAIT_TTL_MS` |
| Connect intent TTL | 15 min | `connect-intent.ts` |
| Replies per conversation | 20 / minute | `REPLY_LIMIT` |
| Lease / stale RUNNING | 90 s / 2 min | `queue.ts` |
| Job attempts / backoff | 4 / 15 s, 60 s, 5 min | `queue.ts` |
| Send attempts / backoff | 6 / 1 min, 5 min, 15 min, 1 h, 3 h | `whatsapp.service.ts` |
| Graph request timeout | 15 s | `client.ts` |
| Webhook body | ≤ 1,000,000 bytes | webhook route |
| Text length | 4,096 chars | `MAX_TEXT_LENGTH` |
| Admin message | 1-1,000 chars, 10/min per sender | `ADMIN_MESSAGE_MAX`, send route |
| Sweep batch | 25 conversations, 50 s budget | `sweepQueue` |
| Retention | 90 days (env) | `WHATSAPP_RETENTION_DAYS` |

## 12. Known limitations & future work

- **No templates.** Aura sends only free-form replies inside the 24-hour window. Proactive notifications outside it fail by design. Template drafts are in [WHATSAPP-TEMPLATES.md](../../../WHATSAPP-TEMPLATES.md) ("Not implemented in code").
- **The sweep is not scheduled.** `/api/cron/whatsapp` is not in `vercel.json`, so retries and retention depend on an external scheduler.
- **Rate limits are per process.** The flood, confirm and send limits use the in-memory `lib/rate-limit`.
- **One central number** serves every workspace; there is no per-workspace number.
- **Menus are bounded by WhatsApp's UI.** Lists hold 10 rows and button sets 3, so the 11th category (Account Settings) is reached by typing "account".

## 13. Related documents

- [WHATSAPP-ASSISTANT.md](../../../WHATSAPP-ASSISTANT.md) (architecture, setup, operations)
- [WHATSAPP-TEST-SETUP.md](../../../WHATSAPP-TEST-SETUP.md), [WHATSAPP-DEMO.md](../../../WHATSAPP-DEMO.md), [WHATSAPP-PRODUCTION.md](../../../WHATSAPP-PRODUCTION.md), [WHATSAPP-SCALABILITY.md](../../../WHATSAPP-SCALABILITY.md), [WHATSAPP-TEMPLATES.md](../../../WHATSAPP-TEMPLATES.md)
- [SANDBOX.md](../../../SANDBOX.md), [META-INTEGRATION.md](../../../META-INTEGRATION.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md), [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md)
- Sibling features: [11 Content Studio](../11-content-studio/), [13 Review & Approval](../13-review-approval-versions-and-trace/), [19 Connections](../19-connections-and-connectors/), [20 Publishing](../20-publishing-execution-and-scheduling/), [02 Workspaces & Roles](../02-workspaces-team-and-roles/), [23 AI Layer](../23-ai-layer/), [24 Platform Jobs](../24-platform-jobs-and-deployment/)
- [Architecture](./02-ARCHITECTURE.md)
