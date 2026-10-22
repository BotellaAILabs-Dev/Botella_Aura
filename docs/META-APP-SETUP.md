# Setting up the real Meta app

This guide sets up Meta for Botella Aura's WhatsApp Cloud API, Facebook Pages and Instagram integrations.

Every environment variable, URL and permission below comes from the repository, not from Meta's examples. The audit was run on 22 Oct 2026.

**Status: not configured.** None of the Meta or WhatsApp variables are set in the local `.env`, and `NEXTAUTH_URL` points at localhost. Nothing here is "done" until the checks in §8 pass with the real credentials.

---

## 1. What the code uses (audit)

### Environment variables

The code reads these server-side. Never prefix them with `NEXT_PUBLIC_`.

| Variable | Read by | Required for |
| --- | --- | --- |
| `META_CLIENT_ID` | `server/connectors/providers.ts` (OAuth client id) | Facebook + Instagram connection |
| `META_CLIENT_SECRET` | providers (token exchange, long-lived token); `app/api/meta/deauthorize`, `app/api/meta/data-deletion` (signed_request HMAC) | Facebook + Instagram connection; Meta callbacks |
| `META_GRAPH_VERSION` | `lib/meta.ts` (optional, default `v23.0`) | — |
| `META_OAUTH_PKCE` | `server/connectors/providers.ts` (optional, off by default) | — |
| `META_REQUEST_INSIGHTS` | `lib/meta.ts` (optional; `true` also requests `read_insights`, `instagram_manage_insights`) | Impressions/reach analytics |
| `WHATSAPP_ACCESS_TOKEN` | `lib/whatsapp.ts` | WhatsApp (required) |
| `WHATSAPP_PHONE_NUMBER_ID` | `lib/whatsapp.ts` (also filters webhooks to this number) | WhatsApp (required) |
| `WHATSAPP_APP_SECRET` | `lib/whatsapp.ts`: verifies `X-Hub-Signature-256` on every webhook | WhatsApp (required) |
| `WHATSAPP_VERIFY_TOKEN` | `lib/whatsapp.ts`: webhook subscription handshake | WhatsApp (required) |
| `WHATSAPP_GRAPH_API_VERSION` | optional, default `v23.0` | — |
| `WHATSAPP_DISPLAY_NUMBER` | optional: the "open WhatsApp" button on the link page | — |
| `WHATSAPP_GRAPH_BASE_URL` | **load tests only**: never set in a real deployment | — |
| `APP_URL` (else `NEXTAUTH_URL`) | `lib/app-url.ts`: builds the OAuth redirect URI and the image links Meta fetches | Everything Meta calls back to |
| `ASSET_S3_*` | Instagram video (Reels, video carousels) | Instagram video only |
| `ENCRYPTION_KEY`, `CRON_SECRET` | token encryption; cron jobs | already set locally |

The code does **not** read any of these. Don't add them:

- a WhatsApp Business Account (WABA) ID
- a separate Instagram app id or secret
- a separate Facebook Login "configuration id" variable, except `META_LOGIN_CONFIG_ID`, which is optional and only for Facebook Login for Business (§3)

### URLs Meta calls (from the routes)

`<host>` is the public HTTPS address in `APP_URL`.

| Purpose | URL | Route |
| --- | --- | --- |
| Facebook Login redirect (Facebook + Instagram) | `https://<host>/api/connectors/meta/callback` | `app/api/connectors/[id]/callback/route.ts` |
| Deauthorize callback | `https://<host>/api/meta/deauthorize` | `app/api/meta/deauthorize/route.ts` (POST, `signed_request`) |
| Data deletion request | `https://<host>/api/meta/data-deletion` | `app/api/meta/data-deletion/route.ts` (POST, `signed_request`) |
| Data deletion status page (returned to Meta) | `https://<host>/meta/data-deletion?code=…` | `app/meta/data-deletion/page.tsx` |
| WhatsApp webhook (verify + events) | `https://<host>/api/webhooks/whatsapp` | `app/api/webhooks/whatsapp/route.ts` (GET handshake, POST signed events) |

Also relevant:

- **Connect starts at `POST /api/connectors/meta`.** It builds `https://www.facebook.com/v23.0/dialog/oauth` with `response_type=code`, `scope=…`, a signed `state`, and PKCE when it is on.
- **The Connectors page shows the exact redirect URI** this deployment will send, so you can copy it from there.
- **Only `/dashboard` and `/onboarding` require sign-in.** The callbacks and webhook above are public, as Meta needs them to be. Each one is authenticated by a signature.

### Permissions the code requests

These come from `lib/meta.ts` (`META_SCOPES`).

| Permission | Used for |
| --- | --- |
| `pages_show_list` | List the Pages the person manages |
| `pages_read_engagement` | Read the Page; required by Meta for Instagram publishing; post engagement analytics |
| `pages_manage_posts` | Publish to the Facebook Page |
| `instagram_basic` | Read the linked Instagram professional account; likes/comments analytics |
| `instagram_content_publish` | Publish to Instagram (image, carousel, Reel) |
| `business_management` | List Pages owned through a Business Portfolio |
| `read_insights` (only with `META_REQUEST_INSIGHTS=true`) | Facebook impressions/reach |
| `instagram_manage_insights` (only with `META_REQUEST_INSIGHTS=true`) | Instagram reach/views/saves |

WhatsApp uses no OAuth. It uses a System User token with `whatsapp_business_messaging`, which sends replies. Add `whatsapp_business_management` only if someone will manage the account through the API; the code doesn't.

**Instagram uses Facebook Login**, through the "Instagram API with Facebook Login". There is no separate Instagram OAuth: one Facebook login grants the Page and the Instagram account linked to it.

---

## 2. Meta products needed

| Integration | Meta product / use case | Notes |
| --- | --- | --- |
| WhatsApp assistant | **WhatsApp** (Cloud API), plus **Webhooks** on the `messages` field | One central Botella number. Replies only: the code sends free-form text inside the 24-hour window and has no message templates. |
| Facebook Pages publishing | **Facebook Login** (permissions above) | Pages API |
| Instagram publishing | Same Facebook Login, with the Instagram permissions | "Instagram API with Facebook Login". Instagram must be a Business or Creator account linked to the Page. |

## 3. One app or two?

**The code supports both.** Facebook/Instagram read `META_CLIENT_SECRET`, and the WhatsApp webhook reads `WHATSAPP_APP_SECRET`.

- **One app:** put the same App Secret in both variables.
- **Two apps:** put each app's own secret in its variable.

**Recommendation: one Business-type app**, owned by Botella's Business Portfolio. That means one App Review, one Business Verification, one set of URLs and one place to manage it.

**Both login products work with one app** (as of 22 Oct 2026):

- **Classic Facebook Login:** leave `META_LOGIN_CONFIG_ID` unset. Aura sends the permission list (`scope`).
- **Facebook Login for Business** (what a Business-type app usually offers):
  1. Open **Facebook Login for Business → Configurations → Create configuration**.
  2. **Token type: User access token.** Aura exchanges it for the ~60-day token and reads the Pages the person manages. A system-user token doesn't fit this flow.
  3. Add the **permissions in §1**.
  4. Put the configuration's ID in `META_LOGIN_CONFIG_ID`. Aura then sends `config_id` and no `scope`, as Meta recommends for the manual login flow.

Either way, Aura reads the permissions actually granted from `/me/permissions`, and the setup page lists any that are missing.

## 4. What needs App Review / Advanced Access

| Permission | Before App Review (Standard Access) | For real customers |
| --- | --- | --- |
| `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `business_management` | Work for **people with a role on the app** (Admin, Developer, Tester) and the Pages and Instagram accounts they manage. Enough to test everything end to end. | **Advanced Access**, via App Review plus **Business Verification** |
| `read_insights`, `instagram_manage_insights` | Same: app-role users only | Advanced Access (App Review) |
| `whatsapp_business_messaging` (System User token, Botella's own WABA) | Works with Meta's **test number**, which can message up to 5 verified recipient numbers | Using your *own* business number for your own business doesn't normally need App Review. It does need a **real phone number**, an approved **display name**, and **Business Verification** for higher messaging limits. Check under App Review → Permissions and features for your app. |

**Live mode.** Switch the app to **Live** before real customers connect. Live requires a Privacy Policy URL; see §9 item 3. App-role users can test in Development mode.

## 5. Step by step in the Meta dashboard

Dashboard labels change from time to time. Where a label differs, pick the option that adds the product named here.

### A. Before you start

1. **Get a public HTTPS address for the app.** Meta can't reach localhost:
   - Meta fetches post images from it, and sends webhooks to it.
   - Use the Vercel deployment, or a tunnel to your machine (`cloudflared` or `ngrok`) for testing.
2. **Set `APP_URL` to that address** (for example `https://aura.example.com`, no trailing slash) in the deployment, and locally if you test through a tunnel.
3. **Have a Meta Business Portfolio**, at <https://business.facebook.com>, in which you are an admin.
4. **Prepare test assets:**
   - a test **Facebook Page** you administer
   - an **Instagram professional account** (Business or Creator) linked to that Page (Page settings → Linked accounts → Instagram)

### B. Create the app

1. Open <https://developers.facebook.com/apps> and click **Create app**.
2. **Use case:**
   - Choose the WhatsApp use case: "Connect with customers through WhatsApp".
   - Add the Pages/Instagram one if the flow offers it (for example "Manage everything on your Page", or the Instagram API use case for content publishing).
   - If asked for an app type, choose **Business**.
3. Connect the app to **Botella's Business Portfolio**.
4. Open **App settings → Basic** and copy two values:

   | Value | Copy into |
   | --- | --- |
   | **App ID** | `META_CLIENT_ID` |
   | **App Secret** (click Show) | `META_CLIENT_SECRET`, **and** `WHATSAPP_APP_SECRET` if this is the same app |

5. On the same page, fill in:
   - Privacy Policy URL and Terms of Service URL (see §9, item 3)
   - App icon, category and contact email
   - **App domains:** your host

### C. Facebook Login (Facebook + Instagram)

1. **Add the login product.** Add **Facebook Login**, or **Facebook Login for Business** (then also create the configuration and set `META_LOGIN_CONFIG_ID`; see §3). Open its **Settings**.
2. **Valid OAuth Redirect URIs:** add `https://<host>/api/connectors/meta/callback` exactly. You can copy it from Aura → Your tools (Connectors), where the deployment shows the URI it sends.
3. **Login settings:** keep **Client OAuth login** and **Web OAuth login** on. Turn on **Enforce HTTPS** and **Use Strict Mode for redirect URIs**.
4. **Data deletion and deauthorize** (Facebook Login settings, or App settings → Basic):
   - Deauthorize callback URL: `https://<host>/api/meta/deauthorize`
   - Data deletion: choose the callback URL option, `https://<host>/api/meta/data-deletion`
5. **Request the permissions** in §1. Open **App Review → Permissions and features**, or the use case's **Customize** page. Standard Access is enough for app-role users to test.
6. **Add testers** under **App roles → Roles**, as Admins, Developers or Testers.

### D. WhatsApp

1. Open **WhatsApp → API Setup** (or **Getting started**). Meta gives you a **test number**. Copy:

   | Value | Copy into |
   | --- | --- |
   | **Phone number ID** (not the phone number) | `WHATSAPP_PHONE_NUMBER_ID` |
   | WhatsApp Business Account ID | Not used by the code. Keep it for step 4. |
   | Temporary access token (24 h) | `WHATSAPP_ACCESS_TOKEN`, for a **first test only** |

2. **Add recipients.** On the same page, add up to 5 recipient numbers you will test from, and verify each one.
3. **Generate a permanent token:**
   1. Open **Business Settings** (business.facebook.com) → **Users → System users**.
   2. Add a system user (Admin).
   3. **Assign assets:** add this **app** and the **WhatsApp account**, with full control.
   4. Click **Generate token**:
      - App: this app
      - Expiry: **Never**
      - Permissions: `whatsapp_business_messaging`, plus `whatsapp_business_management` if you will manage the account through the API
   5. Put the token in `WHATSAPP_ACCESS_TOKEN`, replacing the temporary one.
4. **Create a verify token:**
   - Generate a random string, for example `openssl rand -hex 24`.
   - Put it in `WHATSAPP_VERIFY_TOKEN` and deploy (or restart), so the app knows it before Meta checks.
5. **Configure the webhook** (WhatsApp → **Configuration**):
   - **Callback URL:** `https://<host>/api/webhooks/whatsapp`
   - **Verify token:** the same string as `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save**. Aura answers the handshake only when the token matches. If the four WhatsApp variables aren't set, it answers 503.
   - Under **Webhook fields**, **Subscribe** to **`messages`**. The code ignores every other field.
6. **Go live with a real number:**
   - **Add phone number** in the WhatsApp account.
   - Get the **display name** approved.
   - Complete **Business Verification**.
   - Update `WHATSAPP_PHONE_NUMBER_ID` to the new number's ID.
   - Optionally set `WHATSAPP_DISPLAY_NUMBER` (for example `+15551234567`).

### E. Where the values go

1. **Production:** Vercel → Project → **Settings → Environment Variables**, for Production (and Preview if used). Redeploy afterwards.
2. **Local testing:** `.env` in the project root. Restart the dev server afterwards.

Don't paste secrets into chat, tickets or commits; `.env` is git-ignored.

## 6. Checklists

**Facebook + Instagram**
- [ ] Public HTTPS host; `APP_URL` set to it
- [ ] App created, connected to the Business Portfolio
- [ ] `META_CLIENT_ID`, `META_CLIENT_SECRET` set; app redeployed
- [ ] Redirect URI `https://<host>/api/connectors/meta/callback` added
- [ ] Deauthorize and data-deletion URLs set
- [ ] Testers have app roles; test Page and linked Instagram professional account ready
- [ ] Aura: **Your tools → Facebook & Instagram → Connect** → allow everything → choose the Page → **Confirm** (Connection Manager shows Healthy)
- [ ] Approve a post in Aura and publish to Facebook and Instagram; check both posts appear
- [ ] Remove the app in Facebook settings: Aura shows the connection as removed
- [ ] `pnpm verify:meta` passes (needs the same `META_CLIENT_ID` and `META_CLIENT_SECRET`)

**WhatsApp**
- [ ] `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (permanent System User token), `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` set; redeployed
- [ ] Webhook `https://<host>/api/webhooks/whatsapp` verified and saved; `messages` subscribed
- [ ] Recipient number verified (test number)
- [ ] In Aura: WhatsApp assistant → link your number → send the code from WhatsApp → Aura replies
- [ ] `/api/cron/whatsapp` scheduled with `CRON_SECRET` (retries failed replies)
- [ ] For production: real number, display name approved, Business Verification

**App Review** (when ready for customers; see the checklist in `docs/META-INTEGRATION.md` §6)
- [ ] Business Verification
- [ ] Privacy Policy and Terms URLs live
- [ ] Screencast per permission; reviewer test account
- [ ] Advanced Access requested for each permission
- [ ] App switched to **Live**

## 7. How to verify each piece

| Check | Expect |
| --- | --- |
| Open Your tools: the Facebook & Instagram card | "Available" (not "Awaiting app credentials"); the redirect URI shown matches the Meta app |
| Connect, then open the Connection Manager | Setup confirmed; health **Healthy**; every required permission granted |
| Publish an approved post | Publishing page shows **Published** with a link |
| Meta's **Verify and save** on the webhook | Succeeds (Aura echoes the challenge) |
| Message the number from a verified phone | Aura replies; the WhatsApp assistant page shows the conversation |
| Webhook with a wrong signature (for example a curl POST) | 401 |

## 8. Not done until

Each item has to be checked against the real credentials, by the person doing the setup:

- [ ] A real Facebook post and a real Instagram post were published from Aura
- [ ] A real WhatsApp message was received and answered
- [ ] The deauthorize and data-deletion callbacks were triggered from Meta and handled

## 9. Gaps found that matter before connecting

1. **Facebook Login for Business `config_id`.** Supported since 22 Oct 2026 through the optional `META_LOGIN_CONFIG_ID` (see §3). No second app is needed.
2. **No public URL configured.** `NEXTAUTH_URL` is localhost and `APP_URL` isn't set. Instagram can't fetch images and Meta can't deliver webhooks until the app runs at a public HTTPS address. This is configuration, not code.
3. **No Privacy Policy or Terms pages in the app.** Meta needs both URLs for Live mode and App Review. They can be hosted anywhere public, for example the marketing site.
4. **Instagram video needs file storage.** `ASSET_S3_*` isn't set. Images work without it; Reels and video carousels don't.
5. **WhatsApp message templates aren't implemented.** Aura only replies inside WhatsApp's 24-hour window, and proactive notifications are sent only within it. That's fine for the assistant as built. Anything proactive outside the window, such as reminders, would need approved templates and code.
6. **Scheduled publishing runs once a day** (`vercel.json`). Unrelated to Meta setup, but it affects when posts reach Facebook and Instagram; see `docs/EXECUTION-ENGINE.md`.
