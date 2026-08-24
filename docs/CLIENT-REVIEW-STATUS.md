# Botella Aura — Consolidated Client Feedback: Status

> Tracks every item from the consolidated feedback (Phases 1–3): what's **done**,
> what's **remaining** (and why), what's **blocked** (and by what), and the
> **action** + **owner** for each.
>
> **Owner** = who has to act: **Us** (engineering) · **You** (client — accounts,
> approvals, keys, decisions) · **Both**.
> **Status:** ✅ done · 🟡 partial · ⬜ not started · 🔴 blocked.

**Guiding principle (yours):** stabilise core workflows → then AI features →
then the broader marketing-intelligence layer. That is the order this batch was
built in.

---

## 📌 Summary of this batch

All three phases are implemented. Nine of the twenty items needed a real bug fix
rather than a feature; those are described with their root cause below, because
several were not what they looked like from the outside.

Two items remain gated on things only you can provide (a Google developer
account for the Chrome Web Store, and LinkedIn's API approval). Everything else
works now, and the two gated items have working alternatives in-product today.

---

## Phase 1 — Critical / Core Functionality

| # | Item | Status | Owner |
|---|------|--------|-------|
| 1.1 | Invitation email delivery | ✅ Fixed | Us + **your** mail credentials |
| 1.2 | Browser extension available for testing | ✅ Fixed | Us |
| 1.3 | Leads → Outreach | ✅ Fixed | Us |
| 1.4 | Engagement targets not persisting | ✅ Fixed | Us |
| 1.5 | Lead categorization by requirement | ✅ Done | Us |
| 1.6 | AI Trend Insights — "Something went wrong" | ✅ Fixed | Us |
| 1.7 | AI Competitor Intelligence — "No activities found" | ✅ Fixed | Us |

### 1.1 Invitation email delivery — the UI was lying

**Root cause.** `sendEmail()` caught every failure and silently fell back to
writing the message to the server log, then returned success either way. With no
mail provider configured — or with one that rejected the message — the UI showed
"Mail Sent / Pending" while nothing ever left the building.

**Fixed.**
- `sendEmail()` now returns a truthful result (`delivered`, `transport`,
  `error`, `notConfigured`) and never reports a send that did not happen.
- The real outcome is persisted per invitation (`emailStatus`,
  `emailTransport`, `emailError`, `emailSentAt`) and shown in the team list as
  **Email delivered** / **Email failed** / **Email not sent**, with the
  provider's own error text.
- When delivery does not happen, the invite still works: a **Copy invite link**
  button and the full link appear inline, so onboarding is never blocked by a
  mail outage.
- New **Settings → Email delivery** panel: shows which transport is active, what
  is missing, and a **Send test email to me** button that reports the real
  provider response. This is how you verify the setup without guessing.
- Invite/reset links now resolve their base URL from `APP_URL` → `NEXTAUTH_URL`
  → the platform URL → the request host, instead of only `NEXTAUTH_URL`
  (which is why links could point at `localhost`). The panel warns when the
  resolved URL is local.
- Emails now send HTML as well as plain text.
- Covered by tests (`tests/email-delivery.test.ts`) that specifically assert a
  failed send is never reported as success.

**Needs from you:** set `RESEND_API_KEY` + `EMAIL_FROM`, **or** the `SMTP_*`
variables, on the deployment (5 minutes — see `.env.example`). Until then the
app now says plainly that email is not configured, rather than claiming
delivery.

### 1.2 Browser extension — installable and testable now

**Root cause.** The extension's `manifest.json` only granted host permissions
for `http://localhost:3000`. Against the deployed app, Chrome blocked every API
call and the pairing content script never ran — so it genuinely could not be
tested end-to-end anywhere but a developer's laptop.

**Fixed.**
- Manifest now covers the real deploy hosts (`*.vercel.app`, `*.netlify.app`,
  `*.up.railway.app`, `*.botella.ai`) plus `optional_host_permissions` for any
  custom domain, with a **Grant access to this URL** button in the popup that
  requests it and registers the pairing script for that origin.
- Failed calls now distinguish "the app is unreachable" from "Chrome blocked
  this origin" — previously identical, and fixed in opposite ways.
- Every deploy now packages the extension into a downloadable
  `.zip` (`scripts/package-extension.mjs`, dependency-free and cross-platform;
  the old packaging script was PowerShell-only and never ran in CI).
- **Settings → Browser extension** now has a **Download extension (.zip)**
  button and five-step sideload instructions.

**Result:** the extension can be installed and tested end-to-end today without a
store listing. Publishing to the Chrome Web Store still needs **your** Google
developer account (+ one-time $5 fee) and Google's review — see Blockers.

### 1.3 Leads → Outreach

**What we found.** Both pages already read the same `Lead` table, so leads
*were* on the Outreach board — but nothing in the UI said so, discovered leads
sat at status `NEW` with no obvious next step, and there was no way to see which
requirement a lead came from. Functionally present, practically invisible.

**Fixed.**
- Explicit hand-off: select leads on the Leads page → **Send to Outreach**. It
  qualifies them and lands you on the Outreach board already filtered to that
  requirement.
- The Leads page states the pipeline in-product: *Lead requirement → Fetch leads
  → Leads → Outreach*, and says every lead is already on the Outreach board.
- The Outreach board shows counts and provenance ("12 leads — 8 from lead
  discovery") and carries the same requirement filter as Leads.
- Both pages render dynamically, so a discovery run's results are never served
  from a stale cache.
- Both read through one `listLeads()` function, so a lead visible in one is
  guaranteed visible in the other by construction.

### 1.4 Engagement targets not persisting

**What we found.** Targets were being stored correctly. The Engagement page
never listed them — it mentioned a count inside a paragraph — and when there
were no comments yet it showed "No comments yet — add profiles to monitor in
settings", which reads exactly like the targets were gone.

**Fixed.** Targets are now listed and managed directly on the Engagement page,
with an "N saved to your workspace" confirmation and the date each was added.
The empty state now distinguishes "no comments yet, monitoring 3 profiles" from
"nothing set up".

### 1.5 Lead categorization

- Discovery requirements now carry a **Lead category** (e.g. *Distillery*,
  *Liquor Store*, *Head of Marketing*), defaulting to the requirement name.
- Every discovered lead is stamped with that category at creation. It is stored
  on the lead itself, so it survives renaming or deleting the requirement.
- Existing leads were backfilled from their discovery profile in the migration —
  nothing is left uncategorised after the upgrade.
- Filter **and** group by requirement on the Leads page, filter by requirement on
  the Outreach board, requirement shown on the lead detail page and on each
  outreach card, and manual leads can be filed into the same buckets.

### 1.6 AI Trend Insights — "Something went wrong"

**Root cause — two independent faults.**
1. `/api/trends/refresh` had no `maxDuration`, while every other long-running
   route in the app declares one. Digest generation fans out across every
   configured source and makes two model calls, so it routinely ran past the
   platform's default 10–15 s function budget; the request was killed and the UI
   showed the generic 500 message.
2. Digests are stored as JSON. Digests written by earlier builds lack fields the
   current page reads, and `payload.skippedSources.length` threw during render —
   taking the whole page down, because the app had **no error boundary at all**.

**Fixed.** The route declares a 300 s budget and returns the actual failure
reason instead of a generic 500. Stored payloads are normalized before render, so
an old digest degrades to "fewer sections" rather than a crash
(`tests/digest-payload.test.ts`). Error boundaries were added at
`/app/error.tsx` and `/app/dashboard/error.tsx`, so no future render failure can
produce an unattributed error screen again.

### 1.7 AI Competitor Intelligence — "No activities found"

**Root cause.** This was a genuine result reported badly. The first capture of a
competitor has no previous snapshot to diff against, so `hasChanges` is
necessarily false — a freshly-added competitor always produced a completely
empty report section, which is indistinguishable from a broken pipeline.

**Fixed.**
- The first capture now records a **baseline**: a factual summary of what the
  competitor's homepage and pricing page say *today*. The first report has real
  content instead of nothing.
- Reports now include GitHub activity properly (recent pushes, not only tagged
  releases — most orgs ship without tagging) and the captured news.
- Every empty section now explains itself: what was checked, how many snapshots
  exist in the window, when the last one was taken, and which sources were
  unavailable and why.
- The competitor list shows a **Baseline captured** badge with the positioning
  summary, so the first run visibly did something.

---

## Phase 2 — Important Workflow & AI Features

| # | Item | Status | Owner |
|---|------|--------|-------|
| 2.1 | Discover Leads — pre-run estimate | ✅ Done | Us |
| 2.2 | LinkedIn profile validation | ✅ Done | Us |
| 2.3 | Content Studio — campaign selection | ✅ Fixed | Us |
| 2.4 | AI Marketing Advisor | ✅ Built | Us |
| 2.5 | AI Marketing Planner | ✅ Built | Us |
| 2.6 | Crunchbase targeting | ✅ Integrated | **You** (key) |
| 2.7 | Connectors | ✅ Implemented | **Both** (app credentials) |

### 2.1 Discover Leads — know before you run
Press **Estimate** on any requirement to see, before spending anything:
expected results and how many are new after de-duplication, processing time,
and AI usage (model calls and output tokens). Nothing is invented — the numbers
come from your criteria, which sources you actually have connected, and that
requirement's own run history (and it says which). It also warns about
criteria that would search nothing and sources that are switched off.

### 2.2 LinkedIn profile validation
URLs are validated and classified as **personal profile** (`/in/`) vs **company
page** (`/company/`, `/school/`, `/showcase/`) wherever they are entered — leads,
engagement targets, and competitors. Competitors additionally warn when a
personal profile is entered where an organization page belongs.

### 2.3 Content Studio — campaign selection
With more than one campaign, nothing is auto-selected: the dropdown opens on
"Select a campaign…" and generation is blocked until you choose. A single
campaign still auto-selects (there is nothing to choose). Fixed because content
was silently being filed against a campaign nobody picked.

### 2.4 AI Marketing Advisor — new module (`/dashboard/advisor`)
Campaign opportunities built from what your competitors actually did (30 days of
snapshots), what your market is discussing (recent trend digests), what you have
already published, and what Marketing Memory has learned.

Two rules make it trustworthy: every opportunity **cites the specific
observations it came from** (expandable on each card), and anything the model
returns that does not trace back to a real observation is discarded. With no
signal at all it says so and tells you what to connect — it does not invent
plausible-sounding campaigns. Also lists **competitive gaps**: themes competitors
are consistently active on where you are absent. Each content idea has a
one-click **Draft** into Content Studio with the brief pre-filled.

### 2.5 AI Marketing Planner — new module (`/dashboard/planner`)
An explicit brief — business goals, campaign objectives, topics, audience, brand
guidelines, channels, cadence — generates a **dated monthly content calendar**.

The dates are computed by us (real weekdays of the requested month, spread to
your cadence) and the model fills those slots; it cannot invent dates, which is
what keeps "a monthly calendar" from degrading into a topic list. Each item has a
theme, title, hook, full brief, CTA, hashtags, and the objective it serves, plus a
one-click **Draft this** into Content Studio. Grounded in your brand voice
profile, knowledge base, and current trends — it says which. Idempotent per
month: regenerating replaces, never duplicates.

### 2.6 Crunchbase targeting
The official Crunchbase v4 integration is wired and now activates from the UI:
**Connectors → Crunchbase → Add key**. The key is verified against Crunchbase
before it is stored (encrypted at rest), and turns on funding/stage search in
Lead Discovery plus funding signals in Outreach — for that workspace, with no
redeploy. A deployment-wide `CRUNCHBASE_API_KEY` still works as a fallback.

**Needs from you:** a Crunchbase API key (paid). Without one, the source reports
itself as switched off rather than returning nothing silently.

### 2.7 Connectors — no longer "Coming Soon"
A real connector framework now backs the module:

- **OAuth connectors implemented:** Google Analytics (GA4), Google Search
  Console, HubSpot, Mailchimp, Slack. Full authorization-code flow with signed,
  time-limited CSRF state, automatic token refresh, and post-connect
  verification against the provider.
- **API-key connectors implemented:** Crunchbase, Google Custom Search, GitHub.
  Keys are verified with the provider *before* being saved — we never store a
  credential we could not authenticate with.
- All secrets encrypted at rest (AES-256-GCM) and never returned to the browser.
- **Test connection** re-verifies live, so "Connected" means "working", not "was
  working once".
- Connectors that need one-time app credentials show **Needs setup** and name the
  exact environment variables missing — instead of an indefinite "Coming soon".
- Each card says what connecting actually unlocks inside Aura.
- One accessor (`resolveCredential`) serves every feature, so connecting in the
  UI has exactly the same effect as setting the key on the server.

**Needs from you:** a one-time app registration per OAuth provider (client id +
secret). Redirect URIs and variable names are documented in `.env.example`.
Recommended order: **GA4** (free, highest value), then **Slack**.

---

## Phase 3 — AI Marketing Intelligence Dashboard ✅

New module at **`/dashboard/intelligence`**, also linked from the main dashboard.

**Design rule throughout:** the scores are deterministic and computed from your
real rows — the model is used only to turn them into advice, never to produce a
number. The dashboard is fully functional with no AI provider configured. And
anything that cannot be measured is reported as *not measured*, never as a zero:
"no campaigns" and "campaigns that are failing" must not look the same.

**Marketing Performance**
- Campaign Performance — planned tasks that produced output, minus failures
- Lead Generation Health — good-fit share **and** whether leads actually move
  into outreach (a pile of unworked leads is not a healthy pipeline)
- Competitor Visibility — how many competitors, and whether they are actually
  being captured
- Content Output — published vs drafted over 30 days
- Outreach Conversion — accepted connections and replies per message sent
- **Overall Marketing Score** — weighted across every area that had data, with
  the contributing numbers named, plus movement since the last run

**Content Intelligence** (scored from the writing itself, so a weak hook is
visible *before* you publish)
- AI Content Quality Score
- Hook Strength Analysis — length, specificity, tension, filler openers
- Readability Score — Flesch Reading Ease + grade level
- CTA Effectiveness — presence, kind, and placement of the ask
- Engagement Prediction — labelled as a forecast from the writing, and checked
  against real measured engagement where we have it
- Content Performance — measured engagement from real snapshots only
- Per-piece breakdown, **worst first** — a work queue, not a leaderboard, with
  "why this score" on every item

**Brand Intelligence**
- Brand Consistency Score — measured against your saved brand voice profile
- Tone of Voice Validation — each descriptor tested by an objective proxy
  ("concise" by sentence length, "no hype" by hype-word density, and so on), and
  honest about descriptors it cannot test objectively
- Vocabulary Recommendations — brand terms in use, terms defined but never used,
  words the writing is drifting toward, and explicit topics-to-avoid violations
- AI-generated improvement suggestions — ranked, each quoting the specific number
  that triggered it, each with a concrete next step and a link to where to do it

Snapshots are stored per day (`/api/cron/intelligence`, daily) so the movement
indicator is meaningful, and the advisor refreshes weekly
(`/api/cron/advisor`) — both protected by the existing `CRON_SECRET`.

---

## 🔴 Still blocked — needs your accounts / approvals

| # | Item | Blocker | What to do | Workaround today |
|---|------|---------|-----------|------------------|
| B1 | Chrome Web Store listing | Needs **your** Google developer account (+ $5 one-time) and Google's review (days) | Create the account, or hand it to us with the listing assets | **None needed** — the extension is downloadable and sideloadable from Settings and fully testable |
| B2 | LinkedIn publishing + company-page reads | LinkedIn Marketing API approval (weeks) | Start the app review now — the lead time is the whole problem | "Copy for manual posting" (already honest) |
| B3 | Real post performance metrics | Needs published-post numbers | Use the extension's metric sync, connect GA4, or enter manually | Extension sync + manual entry both work |
| B4 | OAuth connector credentials | One-time app registration per provider | Register GA4 first (free, highest value) | Connectors show exactly what's missing |
| B5 | Crunchbase enrichment | Paid API key | Buy a key, then paste it in Connectors | Source reports itself off; other sources unaffected |
| B6 | Emails reaching inboxes | Mail provider not configured on the deployment | Set `RESEND_API_KEY` + `EMAIL_FROM`, or `SMTP_*` (5 min) | Copyable invite links; Settings → Email delivery verifies it |

---

## Migration & deployment notes

- One migration: `20260824090000_client_review_phases`. Adds invitation email
  delivery columns, lead/requirement categories (**with a backfill** so existing
  discovered leads keep their origin), the `Connection` table, and the advisor /
  planner / intelligence tables. Applied automatically by
  `vercel-build` / `netlify:build`.
- `ENCRYPTION_KEY` is now **required** for connectors (it already existed for
  LinkedIn tokens).
- `pnpm build` now also packages the extension into
  `public/downloads/` — no extra step.
- Two new cron endpoints to schedule: `/api/cron/intelligence` (daily) and
  `/api/cron/advisor` (weekly).
- 169 tests pass, including new coverage for the email-delivery truth-telling,
  the trend-digest normalization, the content metrics, and the calendar
  scheduler. Production build is clean.
