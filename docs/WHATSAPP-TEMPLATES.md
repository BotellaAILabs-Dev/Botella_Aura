# WhatsApp message templates (proposed — NOT submitted)

Status: **draft for approval.** Nothing in this file has been submitted to
Meta. Do not submit until the business approves the wording.

## Why templates are needed: the 24-hour window

- When a user sends a message to Aura's WhatsApp number, a **customer service
  window** opens for 24 hours from that user's last message. Inside it Aura may
  send any free-form message. This is all the Aura WhatsApp assistant uses
  today (`server/whatsapp/*`): it only replies to messages.
- **Outside the window**, a business can only start a conversation with a
  pre-approved **message template**. A notification Aura sends on its own
  initiative ("your post was published", "content is waiting for review") will
  usually arrive outside the window, so it needs a template.
- Templates have a **category**: `UTILITY` (relates to a specific action or
  transaction the user is involved in), `MARKETING` (promotion, offers,
  re-engagement) or `AUTHENTICATION` (one-time codes). Meta reviews each
  template and may **re-categorise** it; marketing wording in a utility
  template is the usual reason.
- **Cost:** Meta charges per delivered template message, by category and by the
  recipient's country. Utility templates sent while a customer service window is
  open are not charged; free-form replies inside the window are not charged.
  Check Meta's current pricing page before enabling — this is a recurring cost
  that does not exist today.
- Users must have **opted in** to receive WhatsApp notifications from Aura.
  Linking a number to Aura and not having sent STOP is the natural opt-in, but
  the notification consent wording is a business decision (see below).

## Not implemented in code

Aura has **no template-sending code** yet. `scripts/whatsapp-check.ts
--template` sends Meta's sample `hello_world` only, for connectivity testing.
After approval, implementing the notifications needs:

1. A template sender (`POST /{PHONE_NUMBER_ID}/messages` with
   `type: "template"`) next to the existing text sender.
2. Hooks where the events already happen: draft submitted for review, schedule
   reminders (the publish cron), publication succeeded/failed
   (`server/content/publish.service.ts`, execution engine), campaign status.
3. Per-user notification preferences, and never sending to an opted-out number.
4. The WhatsApp Business Account ID (from WhatsApp Manager) to create templates;
   no env var exists for it because the app never creates templates itself.

## Conventions used below

- Language `en`. Placeholders are numbered `{{1}}`, `{{2}}` … with the
  `example` values Meta requires for review.
- No promotional words, offers, emojis or calls to buy — all five are
  `UTILITY`.
- Button URLs point to existing Aura pages. `https://APP_DOMAIN` must be
  replaced with the production domain (to confirm) before submission; Meta
  requires a fixed base URL with at most one variable at the end.
- Variable text must not contain newlines, tabs or more than four consecutive
  spaces (Meta rule) — the sender must sanitise titles.

Submission request (for reference, not to be run without approval):
`POST https://graph.facebook.com/v{N}/{WABA_ID}/message_templates` with the JSON
body shown for each template.

---

### 1. Content ready for review — `aura_content_review`

> {{1}} has a new {{2}} waiting for your review: "{{3}}". Open Aura to approve
> it, request changes or reject it.
>
> [Review content]

```json
{
  "name": "aura_content_review",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "{{1}} has a new {{2}} waiting for your review: \"{{3}}\". Open Aura to approve it, request changes or reject it.",
      "example": { "body_text": [["Acme Bakery", "LinkedIn post", "Three ways we cut delivery times"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "URL", "text": "Review content", "url": "https://APP_DOMAIN/dashboard/content/{{1}}", "example": ["cm2x8k1ab0001"] }
      ]
    }
  ]
}
```

Variables: 1 workspace name · 2 content type · 3 draft title (truncated) ·
button: draft ID. Send to: members with `content:approve`.

### 2. Scheduled post reminder — `aura_scheduled_post_reminder`

> Reminder: "{{1}}" for {{2}} is scheduled to publish on {{3}} at {{4}} ({{5}}).
> No action is needed if it is correct.
>
> [View schedule]

```json
{
  "name": "aura_scheduled_post_reminder",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Reminder: \"{{1}}\" for {{2}} is scheduled to publish on {{3}} at {{4}} ({{5}}). No action is needed if it is correct.",
      "example": { "body_text": [["Three ways we cut delivery times", "LinkedIn", "24 Oct 2026", "09:00", "Asia/Kolkata"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "URL", "text": "View schedule", "url": "https://APP_DOMAIN/dashboard/content/{{1}}", "example": ["cm2x8k1ab0001"] }
      ]
    }
  ]
}
```

Variables: 1 title · 2 channel · 3 date · 4 time · 5 workspace timezone
(`Company.timezone`). When to send (e.g. 1 hour before): to confirm.

### 3. Publishing completed — `aura_publish_completed`

> "{{1}}" was published to {{2}} on {{3}}.
>
> [View post]

```json
{
  "name": "aura_publish_completed",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "\"{{1}}\" was published to {{2}} on {{3}}.",
      "example": { "body_text": [["Three ways we cut delivery times", "LinkedIn", "24 Oct 2026 at 09:00"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "URL", "text": "View in Aura", "url": "https://APP_DOMAIN/dashboard/content/{{1}}", "example": ["cm2x8k1ab0001"] }
      ]
    }
  ]
}
```

The button opens Aura (which links to the live post) because Meta needs a
fixed base URL and post links differ by network.

### 4. Publishing failed — `aura_publish_failed`

> "{{1}}" could not be published to {{2}}. Reason: {{3}}. Open Aura to see the
> details and try again.
>
> [See details]

```json
{
  "name": "aura_publish_failed",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "\"{{1}}\" could not be published to {{2}}. Reason: {{3}}. Open Aura to see the details and try again.",
      "example": { "body_text": [["Three ways we cut delivery times", "Instagram", "the Instagram connection needs to be renewed"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "URL", "text": "See details", "url": "https://APP_DOMAIN/dashboard/executions?id={{1}}", "example": ["cm2x9q7cd0004"] }
      ]
    }
  ]
}
```

Reason text comes from the existing user-facing failure messages, never raw
API errors. Send only for final failures (FAILED / ACTION_REQUIRED), not for
automatic rate-limit retries. The `?id=` deep link is to be added to the
executions page (it currently lists, not filters).

### 5. Campaign update — `aura_campaign_update`

> Your campaign "{{1}}" is now {{2}}. {{3}} of {{4}} items are published.
>
> [Open campaign]

```json
{
  "name": "aura_campaign_update",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Your campaign \"{{1}}\" is now {{2}}. {{3}} of {{4}} items are published.",
      "example": { "body_text": [["Autumn launch", "active", "3", "8"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "URL", "text": "Open campaign", "url": "https://APP_DOMAIN/dashboard/campaigns/{{1}}", "example": ["cm2xa0lmn0007"] }
      ]
    }
  ]
}
```

Risk: "campaign" is a word Meta associates with marketing. This template
reports the status of the user's own work, which is utility, but Meta may
re-categorise it as MARKETING (higher price, and marketing opt-in rules). If
that happens, decide whether to drop it or keep it as marketing.

## Decisions needed before submission

- Approve wording of all five; confirm which ones are actually wanted.
- Production domain for button URLs.
- Opt-in wording and where users enable/disable each notification.
- Budget for per-template charges.
- Timing of the scheduled-post reminder.
- Display name / WhatsApp Business profile (must be approved before templates
  can be sent to real users at scale).
