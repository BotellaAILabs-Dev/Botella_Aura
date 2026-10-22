# WhatsApp Cloud API: Meta's free test environment

This connects Aura's existing WhatsApp assistant to Meta's test phone number. No code is rebuilt. Everything below is taken from the repository; the audit was run on 22 Oct 2026.

**Status: not connected.**
- None of the four WhatsApp variables are set yet. `pnpm whatsapp:check` reports them missing.
- Connectivity counts as proven only when `pnpm whatsapp:check` shows Meta answering HTTP 200.

---

## 1. What the integration does

| Piece | File | Verified |
| --- | --- | --- |
| Configuration | `lib/whatsapp.ts` `whatsAppConfig()`: needs `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; optional `WHATSAPP_GRAPH_API_VERSION` | WhatsApp is off (503 on the webhook) until all four are set |
| Webhook | `app/api/webhooks/whatsapp/route.ts`, i.e. `https://<host>/api/webhooks/whatsapp` | **GET:** echoes `hub.challenge` only when `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN` (otherwise 403). **POST:** body capped at 1 MB; only the `messages` field is read, and only for our Phone number ID. |
| Signature check | `lib/whatsapp.ts` `verifySignature()` | Every POST must carry `X-Hub-Signature-256: sha256=<HMAC-SHA256(raw body, WHATSAPP_APP_SECRET)>`. The comparison is constant-time. A bad or missing signature gets 401 and nothing is stored. |
| Sending | `server/whatsapp/client.ts` `sendTextMessage()` / `sendMessage()` | `POST https://graph.facebook.com/<version>/<phone-number-id>/messages` with `Authorization: Bearer <token>`. Returns Meta's message id (wamid). Times out after 15 s. Meta's errors are classified as retryable or not. The token is redacted from every message and log. |
| API version | `DEFAULT_GRAPH_VERSION = 'v23.0'` | Override with `WHATSAPP_GRAPH_API_VERSION` |
| Delivery status | `server/whatsapp/whatsapp.service.ts` `processWebhook` | Meta's `statuses` (sent → delivered → read, or failed) update the stored reply, matched by wamid |
| Load-test stub | `WHATSAPP_GRAPH_BASE_URL` | Must **not** be set. It only accepts localhost, so the token can't leak elsewhere. |

### The temporary test token

The code works with it. The token is used as-is, as a Bearer token.

- It **expires after about 24 hours**. After that every call fails with code **190**, which Aura reports as "The WhatsApp access token is invalid or expired".
- Nothing refreshes it automatically: copy a new one, or switch to a permanent System User token (see `docs/META-APP-SETUP.md`).

### What the test environment limits

- **Recipients:** the test number can message at most **5** phone numbers that you add and verify in the dashboard. Anything else fails with **131030**, "not on the allowed recipient list".
- **Templates:** Aura sends **free-form text only**. It has no message templates, by design.
  - WhatsApp accepts free-form text only **within 24 hours of the recipient messaging the number**. Otherwise it fails with **131047**.
  - So, for an outgoing test, **message the test number from your phone first**.
  - Alternatively, use the test script's `--template` option. It sends Meta's built-in `hello_world` template, which needs no window. This option is in the test script only; the app doesn't send templates.
- **Webhooks:** to *receive* messages, and to see delivery statuses, Meta must reach your webhook over **public HTTPS**. `localhost` doesn't work; use a tunnel (§3, step 9).

### Missing configuration (from the audit)

1. The four `WHATSAPP_*` variables. None are set.
2. A public HTTPS address for the webhook. `NEXTAUTH_URL` is `localhost` and `APP_URL` isn't set.
3. The test recipient (your number), added and verified in the dashboard.

No code is missing for a test-environment connection.

---

## 2. Where the secrets go

| Variable | Value | Where to store it |
| --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | Temporary token (API Setup) | Local testing: **`.env`** in the project root (git-ignored). Deployment: **Vercel → Project → Settings → Environment Variables**. |
| `WHATSAPP_PHONE_NUMBER_ID` | Test number's Phone number ID | Same places |
| `WHATSAPP_APP_SECRET` | App settings → Basic → App secret | Same places |
| `WHATSAPP_VERIFY_TOKEN` | A random string you generate | Same places, and the webhook form in Meta |

- **Never commit these values or paste them into chat, tickets or screenshots.**
- **Never add a `NEXT_PUBLIC_` prefix:** that would ship the value to browsers.
- **Restart the dev server after editing `.env`.** On Vercel, redeploy instead.
- Your `.env` doesn't contain these four names yet. Add four lines yourself, in your editor, putting the values between the quotes:

  ```
  WHATSAPP_ACCESS_TOKEN=""
  WHATSAPP_PHONE_NUMBER_ID=""
  WHATSAPP_APP_SECRET=""
  WHATSAPP_VERIFY_TOKEN=""
  ```

---

## 3. In the Meta Developer Dashboard

Labels may differ slightly as Meta updates the dashboard.

1. **Open the app.** Go to <https://developers.facebook.com/apps> and open your app (or **Create app** → the WhatsApp use case → Business type → connect your Business Portfolio).
2. **Open WhatsApp API Setup.** In the left menu: **WhatsApp → API Setup** (in some layouts, **Use cases → Customize → API Setup**).
3. **Find the test phone number.**
   - In **Step 1: Select phone numbers**, the **From** field shows Meta's **test number** (a US +1 number), created for you.
   - Under it are its **Phone number ID** and the **WhatsApp Business Account ID**.
4. **Add your number as a test recipient.**
   - In the **To** field, choose **Manage phone number list**, then **Add phone number**.
   - Enter your WhatsApp number with its country code.
5. **Verify the recipient.**
   - Meta sends a code to that number by WhatsApp (or SMS). Enter it.
   - The number then appears in the **To** list. You can repeat this for up to 5 numbers.
6. **Copy the Phone number ID.** It's the **Phone number ID** under the From number, a long string of digits and *not* the phone number. Store it in `WHATSAPP_PHONE_NUMBER_ID`.
7. **Find the WhatsApp Business Account ID.**
   - It's shown under the From number, and also in Business Settings → Accounts → WhatsApp accounts.
   - **Aura doesn't use it**, so it has no variable. Keep a note of it for the System User token later.
8. **Copy the temporary access token.**
   - At the top of API Setup, under **Temporary access token**, click **Generate access token**. Sign in with Facebook and allow access to the WhatsApp account if asked.
   - Copy the token **straight into** `WHATSAPP_ACCESS_TOKEN` in `.env`, then clear your clipboard.
   - It expires in about 24 hours.
9. **Copy the App secret and create the verify token.**
   - **App secret:** **App settings → Basic → App secret → Show**. Store it in `WHATSAPP_APP_SECRET`.
   - **Verify token:** in a terminal, run `openssl rand -hex 24`. Store the output in `WHATSAPP_VERIFY_TOKEN`.
   - Restart Aura (`pnpm dev`).
10. **Make the webhook reachable.** This is only needed to *receive* messages and see delivery statuses.
    - Run a tunnel to the dev server, for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
    - Set `APP_URL` in `.env` to the https address it prints, then restart.
    - In Meta, go to **WhatsApp → Configuration → Webhook → Edit**:
      - **Callback URL:** `https://<tunnel-host>/api/webhooks/whatsapp`
      - **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`
    - Click **Verify and save**. It succeeds only if Aura is running with all four variables set.
    - Under **Webhook fields**, **Subscribe** to **messages**.

---

## 4. Testing

1. **Check the credentials with Meta:**
   ```
   pnpm whatsapp:check
   ```
   - It shows which variables are set (names only), the API version, and **Meta's actual answer** for your Phone number ID.
   - Expect: `ok  Meta answered HTTP 200: number +1 555… ("Test Number")`.
2. **Open the 24-hour window.** From your phone, send any message to the test number.
3. **Send through Aura's own sending service.** Use your number with country code, digits only:
   ```
   pnpm whatsapp:check --to <your number>
   ```
   - Expect: `ok  Meta accepted the message (HTTP 200). Message id: wamid.…`, and the message arriving on your phone.
   - Without step 2, Meta answers **131047**. Run `--template` instead to send `hello_world`.
4. **Check the delivery status.**
   - **Without a webhook:** check the phone. Status callbacks can only arrive by webhook.
   - **With the webhook (step 10):**
     - Message the test number from your phone, for example "help".
     - Aura receives it, checks its signature, and replies.
     - Meta's `sent → delivered → read` statuses update the reply. Watch the dev server log, and the WhatsApp assistant page in Aura.
     - The first message from an unlinked phone gets the linking prompt (docs/WHATSAPP-ASSISTANT.md).

### Errors you may see

| Code | Meaning | Fix |
| --- | --- | --- |
| 190 | Token invalid or expired | Generate a new temporary token in API Setup and put it in `.env`; restart |
| 100 ("does not exist / missing permissions") | Wrong Phone number ID, or the token belongs to another app or WhatsApp account | Copy the Phone number ID from the same API Setup page as the token |
| 10 / 200 | The token lacks a permission | Regenerate the token in API Setup for this app |
| 131030 | Recipient not on the test list | Add and verify the number (§3, steps 4–5) |
| 131047 | No open 24-hour window | Message the test number first, or use `--template` |
| 133010 | Number not registered with the Cloud API | Only applies to real numbers; register the number |
| Webhook "Verify and save" fails | Aura not reachable over HTTPS, not running with all four variables, or the verify token differs | Check the tunnel URL, restart Aura, compare tokens |
| Webhook POSTs get 401 | `WHATSAPP_APP_SECRET` isn't this app's secret | Copy it again from App settings → Basic |

---

## 5. Checklist

| Step | Status |
| --- | --- |
| Existing integration audited (config, webhook, signature, sender, version, temporary token) | **Done** |
| Diagnostic script `pnpm whatsapp:check` added (real Graph API; no secrets printed) | **Done** |
| Test number located in API Setup | Pending (you) |
| Your number added and verified as a test recipient | Pending (you) |
| `WHATSAPP_PHONE_NUMBER_ID` in `.env` | Pending (you) |
| WhatsApp Business Account ID noted (not used by Aura) | Pending (you) |
| `WHATSAPP_ACCESS_TOKEN` (temporary) in `.env` | Pending (you) |
| `WHATSAPP_APP_SECRET` in `.env` | Pending (you) |
| `WHATSAPP_VERIFY_TOKEN` in `.env` | Pending (you) |
| `pnpm whatsapp:check` gets HTTP 200 from Meta | Pending: run after the above |
| Outgoing message accepted (wamid returned) and received on the phone | Pending |
| Webhook verified and `messages` subscribed (needs a tunnel + `APP_URL`) | Pending |
| Inbound message answered by Aura; delivery status received | Pending |
| Replace the temporary token with a permanent System User token | Later (`docs/META-APP-SETUP.md`) |
