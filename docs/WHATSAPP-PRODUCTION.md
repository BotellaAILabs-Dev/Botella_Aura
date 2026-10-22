# WhatsApp production checklist

Status: **checklist only.** No number has been registered, nothing purchased,
no production setting changed. Live messaging has **not** been verified —
only against the local Meta stub (`scripts/load/meta-stub.ts`).
Test-number setup is in [WHATSAPP-TEST-SETUP.md](WHATSAPP-TEST-SETUP.md);
first-time app setup in [META-APP-SETUP.md §5D](META-APP-SETUP.md).

Meta's WhatsApp rules (limits, pricing, review) change often — confirm each
item in WhatsApp Manager and Meta's developer docs on the day.

## 1. Production phone number

- [ ] Choose a number the business controls long-term (landline or mobile)
      that can receive an SMS or voice call for the one-time code.
- [ ] The number must **not** be active on the WhatsApp or WhatsApp Business
      app. If it is, delete that account first (or use Meta's migration path) —
      otherwise registration fails.
- [ ] WhatsApp Manager → **Phone numbers → Add phone number**: display name,
      category, verify by SMS/voice code.
- [ ] Register the number for Cloud API: `POST /{PHONE_NUMBER_ID}/register`
      with `messaging_product: "whatsapp"` and a 6-digit two-step
      verification PIN. Store the PIN in the business's password manager (not
      in the repo or env).
- [ ] Put the new **Phone number ID** in `WHATSAPP_PHONE_NUMBER_ID` (Vercel,
      Production) and optionally `WHATSAPP_DISPLAY_NUMBER` — only with your
      approval, then redeploy.

## 2. WhatsApp Business Account (WABA)

- [ ] WABA owned by the operator's Business Portfolio (the same one that owns
      the Meta app).
- [ ] Business profile: description, address, email, website `https://<host>`,
      profile picture (Aura logo).
- [ ] **Payment method** added in WhatsApp Manager → Payment settings
      (required before any template message can be sent; currency cannot be
      changed later). *Decision + purchase — not done.*
- [ ] Subscribe the app to the WABA so webhooks for the production number
      reach Aura: `POST /{WABA_ID}/subscribed_apps` with the System User token
      (the test number is subscribed automatically; a new WABA may not be).

## 3. Business verification

- [ ] Business Portfolio → Security Center → **Start verification** (legal
      name, address, phone, website, documents). Must match the operator
      named in the Privacy Policy.
- Needed for: higher messaging limits, display-name approval in many cases,
  Meta App Review for Facebook/Instagram, and an Official Business Account.

## 4. Display name review

- [ ] Display name follows Meta's rules: relates to the business (e.g.
      "Botella Aura"), consistent with the website and brand, no generic
      words alone, correct capitalisation, no emojis or extra punctuation.
- [ ] Wait for approval (WhatsApp Manager shows status). Rejection can be
      appealed or the name changed. Until approved, the number's sending is
      restricted.

## 5. Permanent System User token

- [ ] Business Settings → Users → **System users** → Admin system user
      (reuse the one from testing if it exists).
- [ ] Assign assets: the **app** and the **WABA** (full control).
- [ ] Generate token: expiry **Never**; permissions
      `whatsapp_business_messaging` (sending — what the code uses) and
      `whatsapp_business_management` (needed for templates and the
      `subscribed_apps` call).
- [ ] Store as `WHATSAPP_ACCESS_TOKEN` in Vercel Production — **with your
      approval**; never paste into chat, docs or logs. `npm run env:check
      -- --production` confirms presence without printing values.
- [ ] Rotate if exposed; regenerating invalidates the old token.

## 6. Production webhook

- [ ] App → WhatsApp → **Configuration**: Callback URL
      `https://<host>/api/webhooks/whatsapp`, Verify token =
      `WHATSAPP_VERIFY_TOKEN`, **Verify and save** (Aura answers only when the
      token matches; 503 if the WhatsApp variables are missing).
- [ ] Webhook fields: subscribe **`messages`** (the only field Aura reads).
- [ ] `WHATSAPP_APP_SECRET` = the app secret, so signatures
      (`X-Hub-Signature-256`) verify — unsigned or wrongly signed posts are
      refused.
- [ ] App in **Live** mode (webhooks for production numbers are not delivered
      to an app in Development mode).
- [ ] Schedule `/api/cron/whatsapp` (retention sweep) — not in `vercel.json`;
      see [SCHEDULER.md](SCHEDULER.md). *Production scheduler change — needs
      your approval.*
- [ ] Live test: message the production number from a personal phone, link
      the account, run one command, send STOP, then START. Only after this can
      live messaging be called verified.

## 7. Messaging limits

- Replies inside the 24-hour customer-service window (everything Aura does
  today) do not count toward the business-initiated limit.
- Business-initiated conversations (templates) are capped per rolling 24 h
  by unique recipients. New/unverified businesses start low (in the hundreds);
  limits rise automatically with verification, volume and quality rating.
- Quality rating (green/yellow/red) drops when users block or report the
  number — keep notifications opt-in and useful.
- Aura's own throttles: `MAX_LINKS_PER_HOUR` 5, code attempts 5. The rate
  limiter is in-memory per instance on Vercel (known gap).

## 8. Template approval

- Five UTILITY templates drafted in
  [WHATSAPP-TEMPLATES.md](WHATSAPP-TEMPLATES.md). **Not submitted.**
- [ ] Business approves wording and the opt-in text.
- [ ] Submit (WhatsApp Manager or `POST /{WABA_ID}/message_templates`);
      review typically takes minutes to a day; Meta may re-categorise.
- [ ] Implement template sending in code (not built — see the templates doc).

## 9. Messaging charges

Meta charges per delivered **template** message, by category and recipient
country; free-form replies within the customer-service window are free, and
utility templates sent inside an open window are free.

Indicative order of magnitude (Meta 2025 rate card, **verify current rates**):

| Category | India | United States |
| --- | --- | --- |
| Utility | ≈ US$0.001–0.002 per message | ≈ US$0.004 |
| Marketing | ≈ US$0.01 | ≈ US$0.025 |
| Service (user-initiated replies) | Free | Free |

Example: 50 users × 3 utility notifications a day × 30 days = 4,500 messages
≈ US$5–20 a month depending on country. Today's Aura (replies only) costs
nothing in WhatsApp fees.

## 10. Done when

- [ ] Real number registered, display name approved, business verified.
- [ ] Production env set and deployed (with approval).
- [ ] Webhook verified; a real inbound message received and answered
      (response logged from Meta, not the stub).
- [ ] STOP / START / Log out tested on a real phone.
