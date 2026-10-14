# WhatsApp assistant — architecture, setup and operations

Aura on WhatsApp: one central business number, run on Meta's official
WhatsApp Cloud API. People sign in from WhatsApp with their Aura account and
then use the features they already have on the website, such as drafts,
approvals, writing posts, connecting LinkedIn, Facebook or Instagram, and
publishing. Their role in the workspace decides what they can do, and
anything that publishes or changes something needs an explicit yes.

Related documents:
- [META-INTEGRATION.md](META-INTEGRATION.md): Facebook/Instagram login, tokens, App Review
- [WHATSAPP-SCALABILITY.md](WHATSAPP-SCALABILITY.md): the queue and the 1,000-person load test
- [VERCEL-DEPLOYMENT.md](VERCEL-DEPLOYMENT.md): plans and crons

## 1. Architecture

```
Meta Cloud API ──POST──▶ /api/webhooks/whatsapp
                          1. verify X-Hub-Signature-256 (raw body, app secret)
                          2. store message + QUEUED job in one transaction (wamid unique)
                          3. return 200 at once; waitUntil(drainConversations)
                                         │
                     server/whatsapp/queue.ts ── lease the conversation (one worker per person,
                                         │        messages answered in order; 48 per process)
                     handler.ts ── idempotent, rate limit 20/min, mark read
                                         │
                     agent.ts ── opt-out/in, sign-in, workspace choice, logout
                                         │  (linked + workspace chosen)
                     router.ts ── reply ids → deterministic intents → AI router (fenced, cheap tier)
                                         │
                     tools/*  ── zod-checked args, RBAC permission per tool, services Aura
                                 already has (content, review, publishing, connectors…)
                                         │
                     whatsapp.service.sendContent ── record, send, retry with backoff
/api/cron/whatsapp (sweep) ── lost kicks, expired back-offs, dead workers, due send
                               retries, retention
```

The workflow reuses Aura's existing services. It has no logic of its own for
content, review, publishing or OAuth. The WhatsApp layer handles transport,
identity, routing and confirmations.

| Area | Where |
|---|---|
| Webhook parsing, signatures, message shapes | `lib/whatsapp.ts` |
| Meta API client (token redacted from errors) | `server/whatsapp/client.ts` |
| Store, send, retry, delivery statuses | `server/whatsapp/whatsapp.service.ts` |
| Queue, sweep, retention | `server/whatsapp/queue.ts` |
| Account linking and sessions | `server/whatsapp/link.service.ts`, `lib/whatsapp-link.ts` |
| Conversation logic | `server/whatsapp/agent.ts`, `router.ts`, `tools/*` |
| Workspace on/off switch | `server/whatsapp/settings.ts` |
| Dashboard | `app/dashboard/whatsapp-assistant`, `server/whatsapp/dashboard.service.ts` |
| Multi-network publishing | `server/content/multi-publish.service.ts`, `publication-store.ts` |
| Instagram still processing (Reels) | `server/content/processing.service.ts` |
| What WhatsApp can do, per role | `server/whatsapp/features.ts` |
| Admin → member message | `server/whatsapp/admin-message.ts` |

### Data

| Model | Holds |
|---|---|
| `WhatsAppConversation` | One per number: a **hash** of the number plus its last 4 digits, profile name, opt-out, 24-hour window, worker lease |
| `WhatsAppMessage` | Each message in and out: text, delivery status, error, and the **workspace it was handled for** (`companyId`; null for sign-in and opt-out traffic) |
| `WhatsAppJob` | The work queue: QUEUED, RUNNING, DONE, or DEAD (dead letter, with its error) |
| `WhatsAppLinkChallenge` | Sign-in attempts: token hash, code hash, attempt count, expiry |
| `WhatsAppAccountLink` | Number ↔ user, active workspace, 30-day expiry, session state (pending confirmations) |
| `ContentPublication` | One row per draft and network: one publish at a time, never twice |

## 2. Setup

### Meta (one-time, by the business owner)

1. In Meta Business Manager, create or choose the business and add a
   **WhatsApp Business Account** with the central number. Verify the business
   and set the display name.
2. In the developer app, open **WhatsApp → API Setup** and note the
   **Phone number ID** (this is not the phone number itself).
3. Under **Business Settings → Users → System users**, create a system user,
   assign it the app and the WhatsApp account, and generate a **permanent
   token** with `whatsapp_business_messaging` (and `whatsapp_business_management`).
4. Under **WhatsApp → Configuration → Webhook**, set:
   - Callback URL: `https://<your-domain>/api/webhooks/whatsapp`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **messages** field.
5. Under **App settings → Basic**, copy the app secret into `WHATSAPP_APP_SECRET`.
6. For Facebook and Instagram, follow META-INTEGRATION.md: the app's Facebook
   Login, the redirect URI, the deauthorize URL and the data-deletion URL.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | yes | System-user token. Server only, never `NEXT_PUBLIC_` |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | The central number's ID |
| `WHATSAPP_APP_SECRET` | yes | Verifies webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | yes | Webhook handshake (`openssl rand -hex 24`) |
| `WHATSAPP_DISPLAY_NUMBER` | no | The number as people dial it; enables one-tap "open WhatsApp" links |
| `WHATSAPP_GRAPH_API_VERSION` | no | Default `v23.0` |
| `WHATSAPP_WORKER_CONCURRENCY` | no | Conversations per process (default 48, measured) |
| `WHATSAPP_QUICK_RETRY_MS` | no | Wait before the quick retry of a throttled send (default 1000) |
| `WHATSAPP_RETENTION_DAYS` | no | Days message text is kept (default 90) |
| `WHATSAPP_GRAPH_BASE_URL` | **never in production** | Load tests only: points sends at the local stub |
| `META_CLIENT_ID`, `META_CLIENT_SECRET`, `META_GRAPH_VERSION` | for FB/IG | See META-INTEGRATION.md |
| `CRON_SECRET`, `APP_URL`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET` | yes | Already required by Aura |

If the WhatsApp variables are missing, the webhook answers 503 and the
dashboard lists which variables are missing, by name only, never their values.

### Database

Apply the migrations (`pnpm prisma migrate deploy`). These are the WhatsApp
and publishing ones:

```
20261014090000_whatsapp_assistant
20261014100000_whatsapp_queue
20261014110000_whatsapp_account_link
20261014120000_whatsapp_session_state
20261014130000_content_publications
20261014140000_whatsapp_message_workspace
20261015090000_instagram_carousel_reels
```

### The sweep (cron)

`GET|POST /api/cron/whatsapp` with `Authorization: Bearer $CRON_SECRET`.
Run it every 1–5 minutes:
- **Vercel Pro:** add `{ "path": "/api/cron/whatsapp", "schedule": "*/5 * * * *" }`
  to `vercel.json` (see VERCEL-DEPLOYMENT.md).
- **Vercel Hobby:** Hobby allows two daily crons, and both are already used.
  Call the route from a free external scheduler, such as GitHub Actions or
  cron-job.org.

Normal replies do not depend on the sweep. Without it, three things stop:
- throttled replies are not retried later
- messages whose `waitUntil` was lost are not picked up
- old message text is not deleted

### Website API

| Endpoint | Who | What |
|---|---|---|
| `POST /api/webhooks/whatsapp` | Meta (signed) | Incoming messages and delivery statuses |
| `GET\|POST /api/cron/whatsapp` | Cron (`CRON_SECRET`) | The sweep (also finishes Instagram posts still processing) |
| `GET /api/whatsapp/features` | Signed-in member | What they can do on WhatsApp in the active workspace, by role, from the same registry the assistant runs |
| `GET /api/whatsapp/conversations` | Owners/admins: the workspace's; others: their own | Recent conversations handled for the active workspace only |
| `POST /api/whatsapp/send` | Owners/admins | A text to a **member of this workspace** using WhatsApp here — only inside the 24-hour window, never after STOP, signed with the sender's name, rate-limited (10/min), audited. Not for arbitrary numbers or marketing |
| `GET\|DELETE /api/whatsapp/links[/:id]` | Signed-in user | Their own linked numbers; unlink |
| `POST /api/whatsapp/link/confirm\|cancel` | Signed-in user | Website half of sign-in |
| `PATCH /api/whatsapp/settings` | Owners/admins | WhatsApp on/off for the workspace |

There is deliberately no endpoint that sends to any phone number. Replies go
out through the queue, and proactive messages would need Meta-approved
templates, which Aura does not send.

## 3. How people use it

1. A person messages the central number. If the number is not linked, Aura
   sends a **sign-in button**: a single-use link that lasts 10 minutes, with
   only a hash of it stored.
2. The link opens the website. The person signs in normally, using their
   password or Google on the website, never over WhatsApp. The page shows the
   last 4 digits of the number asking to link, and they confirm.
3. The website shows a **6-digit code**. They send it back **from the same
   number**, with 5 attempts allowed. Only then is the number linked, for 30
   days. Having the number alone is never enough, and neither is clicking a
   forwarded link.
4. They choose a workspace. Only workspaces they belong to **and** that have
   WhatsApp switched on are offered.
5. After that, they get a menu or can type freely: "show my drafts", "write a
   LinkedIn post about…", "post this to Facebook and Instagram", "connect
   LinkedIn".
6. Approving, rejecting and publishing each show what will happen, then need a
   **yes** that works once. It expires after 10 minutes and belongs to that
   workspace and that action. Publishing to several networks needs an
   approved draft and a person allowed to publish.
7. `LOGOUT` unlinks the number, `SWITCH` changes workspace, and `STOP` opts
   out of all messages. The website's WhatsApp assistant page also lists and
   unlinks numbers.

## 4. Security model

| Rule | How it is enforced |
|---|---|
| Only Meta can call the webhook | `X-Hub-Signature-256` HMAC over the raw body, compared in constant time, before anything is stored |
| Nothing is processed twice | `wamid` is unique; a reply that already exists is not sent again |
| A number alone grants nothing | Website confirmation by the signed-in user **plus** a code sent back from that number |
| No passwords or tokens in chat | Sign-in happens on the website only; links contain a random token, stored only as a hash; Meta tokens never appear in messages or logs |
| Tenant isolation | Each message re-reads membership and role; tools receive only the active `companyId`; session state is tagged with its workspace and discarded when the workspace changes; a forged reply id (such as another workspace's id or draft) is refused like an unknown one |
| Permissions | Each tool declares an RBAC permission, checked on the server before it runs |
| AI cannot override authorisation | The AI router only *chooses* a tool. User text is fenced as data, and the chosen tool still passes the permission check, argument validation and confirmation |
| Human approval | Approve, reject, publish and connect need an explicit yes that works once. Scheduled publishing never retries an interrupted attempt; it waits for a person |
| Double publishing | `ContentPublication` is claimed atomically per draft and network |
| Website routes | Same-origin check plus session; the setting needs `company:update` |
| Personal data | Numbers stored as a hash plus last 4 digits; message text deleted after `WHATSAPP_RETENTION_DAYS`; numbers that never linked are deleted entirely; Meta deauthorize and data-deletion callbacks are supported |
| Meta rules | Free-form replies only inside the 24-hour window; nothing proactive outside it; STOP is honoured at once; no marketing messages |

## 5. Workspace controls and dashboard

**Dashboard → Setup → WhatsApp assistant** (`/dashboard/whatsapp-assistant`):
- **Everyone** sees whether the integration is set up, whether WhatsApp is on
  for this workspace, and **their own** linked numbers, which they can unlink.
- **Owners and admins** (`company:update`) also see:
  - the on/off switch
  - who uses WhatsApp in this workspace
  - 7-day message counts and delivery statuses
  - failed and dead-lettered messages
  - recent conversations

  These cover only messages handled for **this** workspace. There is no
  platform-wide view: one person's activity in another workspace never
  appears.

Turning WhatsApp **off** for a workspace removes it from the choices, and
anyone using it there is moved off it on their next message, with a message
explaining why. The change is audited (`WHATSAPP_SETTINGS_UPDATED`).

## 6. Operations

| Situation | What happens / what to do |
|---|---|
| Meta throttling (130429, 131056) | One quick retry, then a backoff retry from the sweep |
| 24-hour window closed (131047) | The message is marked failed, not sent; the person must write first |
| Token invalid (190) | Every send fails; generate a new system-user token and update `WHATSAPP_ACCESS_TOKEN` |
| A message that keeps failing | It becomes `DEAD` after 4 attempts with its error kept; the person gets an apology and the conversation moves on. It is visible on the dashboard |
| Worker died mid-message | The lease expires in 90 s; the next worker or sweep resumes |
| Interrupted publish | Marked FAILED for a person to check; never retried automatically, to avoid double posts |
| Checking health | Dashboard counts and problems; logs prefixed `whatsapp:`; the sweep's JSON response |

## 7. Deployment checklist

- [ ] All migrations applied
- [ ] `WHATSAPP_*` (required four), `CRON_SECRET`, `APP_URL`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET` set in production
- [ ] `WHATSAPP_GRAPH_BASE_URL` **not** set
- [ ] Webhook URL verified in Meta, `messages` field subscribed
- [ ] Sweep scheduled every 1–5 minutes and returning 200
- [ ] Sending "Hi" from a test phone gets the sign-in button; linking completes; "menu" works
- [ ] A VIEWER cannot approve or publish, and an OWNER can, with a confirmation
- [ ] Facebook/Instagram: Page chosen, test post published to a test Page (development mode)
- [ ] Meta App Review submitted for the permissions in META-INTEGRATION.md. **Until it is approved, only app roles and testers can connect Facebook or Instagram**
- [ ] Business verification and display name approved in Meta

## 8. Verification

```
pnpm vitest run                    # unit and integration tests (in-memory database, fake Meta)
pnpm verify:whatsapp               # end-to-end against a running app and a real database
pnpm verify:whatsapp-link
pnpm verify:whatsapp-agent
pnpm verify:meta
pnpm verify:multi-publish
pnpm verify:whatsapp-social
pnpm load:meta-stub / load:whatsapp  # load test, see WHATSAPP-SCALABILITY.md
```

The verify scripts send webhooks to a running app, signed the way Meta signs
them, and use the real database. Replies really go to Meta's Cloud API. With
placeholder credentials, Meta refuses them and the refusal is recorded; that
is what the scripts check. Set `VERIFY_WHATSAPP_FROM` to an allowed test
number to receive replies on a phone. Delivery to real phones and real
Facebook/Instagram posts need real Meta credentials and test accounts, and
neither has been tested in this environment.
