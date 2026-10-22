# Meta App Review & WhatsApp production — checklist

Status key: ✅ done in code · 🟡 drafted, needs approval · ⬜ not started /
needs the business · 🔒 needs real credentials or Meta.

Submission text, recordings and reviewer instructions:
[META-APP-REVIEW-SUBMISSION.md](META-APP-REVIEW-SUBMISSION.md). WhatsApp
production: [WHATSAPP-PRODUCTION.md](WHATSAPP-PRODUCTION.md). Video storage:
[MEDIA-STORAGE.md](MEDIA-STORAGE.md).

`<host>` = the production domain (to confirm). Setup steps are in
[META-APP-SETUP.md](META-APP-SETUP.md); permissions and their justifications
in [META-INTEGRATION.md §2](META-INTEGRATION.md).

## 1. Public URLs Meta asks for (App settings → Basic)

| Field | URL | Status |
| --- | --- | --- |
| Privacy Policy URL | `https://<host>/privacy` | 🟡 page built, DRAFT banner, `noindex` |
| Terms of Service URL | `https://<host>/terms` | 🟡 page built, DRAFT banner, `noindex` |
| Data deletion — **callback** URL (preferred) | `https://<host>/api/meta/data-deletion` | ✅ verified locally (signed_request, confirmation code, status page) |
| Data deletion — instructions URL (alternative) | `https://<host>/data-deletion` | 🟡 page built |
| Deauthorize callback URL | `https://<host>/api/meta/deauthorize` | ✅ verified locally |
| Valid OAuth redirect URI | `https://<host>/api/connectors/meta/callback` | ✅ |

Meta accepts **either** a deletion callback **or** an instructions URL; Aura
has both. Use the callback; the instructions page is linked from the privacy
policy and the site footer.

All three pages are public (middleware only guards `/dashboard` and
`/onboarding`) and work without signing in.

Before submitting, the pages must be **final**: fill every `null` in
`lib/legal.ts`, have the text reviewed, set `approved: true` (removes the
DRAFT banner and `noindex`), and deploy. Meta's reviewers reject placeholder
policies, so do not submit while "[to confirm]" markers are visible.

## 2. Business and app details

- ⬜ Business verification in Meta Business Manager (legal name, address,
  documents — must match the privacy policy's operator).
- ⬜ App icon (1024×1024), category, privacy/contact email (same mailbox as
  `LEGAL.privacyEmail`).
- ⬜ App domain = `<host>`; site URL.
- ⬜ App switched to **Live** mode only after the above.

## 3. Permissions (Facebook & Instagram)

| Permission | Needed for | Status |
| --- | --- | --- |
| pages_show_list | Page picker | 🔒 Advanced Access request |
| pages_read_engagement | Page details and post results | 🔒 |
| pages_manage_posts | Publish approved posts to the Page | 🔒 |
| instagram_basic | Find the Instagram account linked to the Page | 🔒 |
| instagram_content_publish | Publish approved posts to Instagram | 🔒 |
| business_management | Pages owned by a Business Portfolio | 🔒 only if needed |
| read_insights / instagram_manage_insights | Impressions and reach (`META_REQUEST_INSIGHTS=true`) | ⬜ optional — request only if turned on |

For each requested permission:

- ⬜ A written use-case description (start from META-INTEGRATION §2 "Why";
  mention that nothing is published without human approval).
- ⬜ A screencast: sign in to Aura → Your tools → Connect Facebook &
  Instagram → Facebook permission dialog → Page picker → approve a post →
  publish → the post on the Page / Instagram account. English UI, captions
  explaining each step.
- 🔒 At least one successful API call per permission from the app in the last
  30 days (Meta requires this before Advanced Access can be requested) — only
  possible with the real app and a test Page.

## 4. Reviewer access

- ⬜ A dedicated reviewer Aura account (email + password, owner of a test
  workspace with onboarding complete and one approved post ready to publish).
  Shared in the review form, not in the repo.
- ⬜ Step-by-step instructions in the review notes (copy the screencast steps).
- ⬜ Confirm the reviewer can reach `<host>` (no IP restriction, no Vercel
  password protection on production).

## 5. WhatsApp production

- 🔒 Real WhatsApp Business Account and phone number (not the test number);
  number verified; display name approved.
- ⬜ WhatsApp Business profile: description, website, email, address.
- 🔒 `whatsapp_business_messaging` (and `whatsapp_business_management` if
  templates are managed via API) Advanced Access.
- 🔒 Webhook pointed at `https://<host>/api/webhooks/whatsapp`, subscribed to
  `messages`; verified with `npm run whatsapp:check`.
- ⬜ Payment method on the WhatsApp Business Account (template messages are
  charged).
- 🟡 Message templates — five drafted in
  [WHATSAPP-TEMPLATES.md](WHATSAPP-TEMPLATES.md), **not submitted**; template
  sending is not implemented in code.
- ⬜ Messaging limit tier starts at a low daily cap of unique users and rises
  with quality; no action needed at launch.
- ⬜ Schedule `/api/cron/whatsapp` (retention sweep) — not in `vercel.json`
  today; see [SCHEDULER.md](SCHEDULER.md).

## 6. Data handling questions in the review form

Meta's Data Use Checkup / data-handling questions ask about processors,
data sharing with authorities, and where data is stored. Answers depend on
the business decisions below; draft answers from the privacy policy once
final.

## 7. Business decisions still open

1. Operator's legal name, registered address, and the entity that does
   business verification.
2. Privacy contact email (monitored mailbox) and support email.
3. Effective date; how users are told about changes.
4. Governing law and courts; liability, warranty and indemnity clauses
   (lawyer).
5. Applicable privacy laws (GDPR / UK GDPR / India DPDP / US states),
   controller vs processor role, legal bases, international transfers.
6. Production hosting, database and file-storage providers and regions;
   backup retention.
7. Which AI providers are enabled in production; whether their plans allow
   training on submitted data.
8. Retention after account closure; audit-log retention.
9. Minimum age.
10. Account/workspace deletion: deadline for completing requests, and whether
    to build self-service deletion (not available today).
11. Whether a Meta deletion request should also remove the workspace's record
    of posts already published.
12. Pricing, renewals and refunds wording for the Terms.
13. WhatsApp: template wording, notification opt-in wording, budget for
    template charges, production number and display name.
14. Production domain.
