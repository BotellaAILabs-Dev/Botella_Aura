# Screens Review — What Shipped

Every item from the screens-review document, with what was actually wrong and
what changed. Items needing your accounts or keys are called out at the end.

**Legend:** ✅ fixed · ⚙️ built, needs a credential from you

---

## Executive-summary items

| # | Item | Status |
|---|------|--------|
| 1 | Confirmed generation failures (brand voice, calendar, trend digest) | ✅ |
| 2 | Connector OAuth broken; roadmap items indistinguishable from live ones | ✅ / ⚙️ |
| 3 | Empty first-run dashboard, no early AI insight | ✅ |
| 4 | 14 flat nav items; duplicate workspace state | ✅ |
| 5 | Uniform 35/100 lead scores with no explanation | ✅ |
| 6 | Action → outcome loop incomplete (Analytics / Memory never populate) | ✅ / ⚙️ |

---

## P0 — Critical

### Brand voice preview: "Could not generate a preview"

**This was a real bug, and not a network one.** Extended thinking draws from the
same output-token budget as the reply. The preview asked for 400 tokens, so the
budget could be spent entirely on thinking and return a well-formed response
containing a thinking block and **no text**. The old client read that as an
empty string and reported a generic failure with nothing to retry.

- Low-effort/short calls no longer request thinking at all, and the preview's
  ceiling was raised to 1200 tokens.
- An empty completion is now a typed error, so the retry path actually fires
  (3 attempts with backoff). Permanent failures — a rejected key, a malformed
  request — throw immediately instead of burning retries.
- The route never returns a bare 500: it answers with a specific, retryable
  note, logs the failure as an incident for engineering, and **onboarding is
  never blocked** — Continue stays enabled and the brand voice is still saved.
- The same root cause was starving **lead fit scoring** (see below) and any
  other short generation. One fix, several symptoms.

### Monthly calendar hangs · Trend digest reads as hung · Intelligence needs a manual run

All three are the same shape: a long, multi-call AI generation running inline in
one HTTP request, exceeding the platform's function budget and being killed
mid-flight. Patching each screen would have left the next feature to repeat it,
so these now run as **background jobs**:

- The request queues the job and returns immediately; the browser kicks the
  runner without awaiting it and polls for progress.
- Real status lines instead of a spinner — "Scanning Hacker News, r/SaaS…",
  "Ranking 43 items", "Saving your digest…" — with a percentage.
- **The run survives leaving the page.** Come back and it reattaches to the job
  in progress rather than offering to start a second one.
- **A failed run keeps your brief.** Retry re-runs the saved inputs; nothing is
  retyped. The planner also keeps a local draft, so a mid-run reload is safe.
- Double-clicking Generate cannot start two runs.
- **An app-wide indicator reports progress and completion from any page.** A
  digest started on Trends announces itself even if you have navigated to
  Settings, with a "View it" link. Without this, "moved to a background job"
  would only be half true — you would still have to sit on the page that
  started it to learn what happened.
- A new sweep (every 5 min) restarts jobs whose instance was killed and fails
  anything past its retry budget with a message the UI can show. Previously an
  interrupted run stayed pending forever.
- The daily pre-generated digest cron already existed and is unchanged, so most
  users never trigger a cold generation at all.

### Connectors: Error 400 redirect_uri_mismatch

- **Root cause addressed, not just reported.** Every connector had its own
  callback URL, so Google needed one registered per connector and any missed one
  failed. GA4 and Search Console now share a single callback — the connector is
  read from the signed state parameter, which is authoritative anyway.
  **One URI to register, not two.**
- A **pre-flight check** runs before the browser leaves for the provider and
  refuses with a message naming the fix — most usefully when the deployment
  resolves its own URL to localhost, which is the usual cause in production.
- The Connectors page shows the **exact URIs to register, with a copy button**,
  and states which URL this deployment believes it is running on.
- If a provider still returns a mismatch, the message explains what it means
  instead of passing Google's wording through unchanged.

### Analytics all zeros

- **Log results manually** — type the numbers off a post. They are stored as the
  same kind of snapshot a connector writes, so Analytics, Marketing Memory and
  content intelligence all consume them identically and nothing needs re-plumbing
  when the API arrives. The measurement loop closes today.
- The empty state now explains the three routes to data rather than implying a
  wait.

### First-run dashboard: everything "Not measured"

- New **setup foundations** score, computed from onboarding data alone (website,
  industry, brand voice, knowledge base, competitors, lead requirement, first
  draft, connected source). It is always measurable, so **the headline score is
  never null** and the AI advice runs even for a brand-new workspace.
- **The first analysis is queued automatically when onboarding finishes** and
  kicked immediately, so the dashboard has a real score by the time you arrive.
  Opening Intelligence with no snapshot also starts one rather than waiting to
  be asked.
- The wall of blank cards is replaced by a **setup checklist that visibly
  completes**, with one highlighted next step chosen by weight.

---

## P1

**"What to fix first" — everything was "medium".** Priority was a flat default.
It is now weight × gap-to-target, using the same weights that produce the
headline score — so the list can only recommend work that actually moves the
number above it. Each item carries **"worth about +N points on your score"**, and
the top item is pulled out as a **Start here** card. The model may reword and
reorder, but impact stays arithmetic: letting it guess would put the flat
priorities straight back.

**Leads all scoring exactly 35/100.** That was the zero-match floor of
`35 + hits × 15` — every lead matching nothing landed on the identical number
with the identical unhelpful note. Now each criteria group (industry, role,
keyword, stage, geography) contributes weighted, **partial** credit, so scores
genuinely differentiate. Each lead shows **which criteria it met and missed**;
leads under 40/100 are **collapsed by default with the hidden count shown**
(never silently dropped); and **"Not relevant, because…"** captures the reason
against the requirement that produced the bad match. The AI scorer's token
budget was also too small for its own output — it was failing validation and
dropping every lead to the fallback, which is why the floor was so visible.

**Campaigns: "25 PENDING" beside "Awaiting review: 0".** PENDING conflated
"scheduled for a future date" (fine) with "due but not run" (stuck). These are
now separate counts, with a task-type breakdown, a **Next up** card, and an
explanation of why the review count is zero while tasks are pending.

**Outreach.** Bulk approval, but **selective**: "Approve N high-confidence"
covers only drafts scoring 70+ — grounded in a real public signal, written in
your brand voice, aimed at a well-scored named contact with a confirmed profile,
and free of unfilled placeholders. Everything else stays in the queue with the
reason named, and "Approve all" remains available as a deliberate override.
Each factor is a **gate, not a point**: a draft missing one essential cannot
clear the bar by being strong elsewhere, because approving in bulk means
sending unread. Plus a **backlog warning** when approved messages have sat
unsent for 3+ days, and the reason sending is manual — LinkedIn's API does not
permit automated connection requests, and anything that sent them would put your
account at risk — now stated on the board itself, not only in Settings.

**Connectors catalog.** "Available now" (grouped by category) is separated from a
single collapsed **Coming soon** list. Roadmap items are visibly non-functional
and can no longer be clicked as though they work.

**Navigation.** Grouped into Understand / Create / Grow / Measure / Setup. Every
page stays exactly where it was — no links break — but the sidebar now has an
obvious top and a reading order.

**Duplicate workspaces.** Creating a workspace whose name you already have is
blocked with a recoverable prompt, rather than silently producing two
indistinguishable entries with your data split across them.

**Invitations.** When mail did not go out, **"Get invite link"** becomes the
primary action. Invite tokens are stored hashed, so a link can only be produced
by issuing a fresh one — the button says that rather than implying we still hold
the original.

**Content Studio.** Per-column empty copy ("Nothing waiting on you" vs "Nothing
published yet") so a genuine empty state is not mistaken for a stalled load.

---

## P2

**Competitors.** A prompt to reach three tracked competitors, explaining that
comparison needs more than one reference point.

**Marketing Memory.** "Not enough data" now names the gate: results from
**10 published posts**, how many you have, and that it counts posts-with-numbers
rather than elapsed time — with the three ways to supply them.

---

## ⚙️ Needs something from you

These are built and wired. They light up the moment the credential exists — no
further code change.

| What | What to set | Where |
|------|-------------|-------|
| Invitation + reset emails, and connector email codes | RESEND_API_KEY + EMAIL_FROM, **or** the SMTP_* variables | Deployment env |
| Google connectors (GA4, Search Console) | GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, and register the **one** redirect URI shown on the Connectors page | Google Cloud Console + env |
| All AI generation quality | ANTHROPIC_API_KEY (or GEMINI_API_KEY) | Deployment env |
| Background job recovery | CRON_SECRET, and schedule /api/cron/jobs every 5 min | Deployment scheduler |
| Daily pre-generated digest | schedule /api/cron/trends daily | Deployment scheduler |

**Worth knowing:** without an AI key every generation falls back to heuristics.
Several "AI is broken" symptoms in the review are consistent with the key being
absent or rejected on that environment — the code now reports which, instead of
failing silently.

**Also new:** connectors can be verified with an **emailed 6-digit code** where a
provider's OAuth app is not registered yet. This confirms which account is yours
so results can be attributed; it does not grant API access, and the UI says so
rather than implying a working sync.

---

## Verification

- 200 tests pass (36 new), covering the empty-completion bug, the retry policy,
  score differentiation, priority ranking, the shared Google redirect URI, and
  every draft that must never reach a bulk approval.
- Production build and lint both clean.
- One migration (20260827120000_screens_review). Additive only — a new table for
  the job queue, new columns with defaults. No existing data is rewritten.
