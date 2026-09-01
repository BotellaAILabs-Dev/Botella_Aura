# Botella Aura — Remediation Report

**Every issue from the screens review, fixed.**

Fourteen reported problems traced to eight underlying defects — fixed, and
verified against a live database.

|                  |                                                           |
| ---------------- | --------------------------------------------------------- |
| **Prepared for** | Product, Design & Engineering                             |
| **Source**       | Product Implementation Feedback — Screens Review          |
| **Status**       | All items closed                                          |
| **Commits**      | `ac4d45e` · `96c1f1a` · `c320f33` · `a6b1747` · `d99e0f8` |
| **Date**         | 1 September 2026                                          |

---

## The headline finding

### Three of the four P0 failures were one bug

The review reported the brand-voice preview, the monthly calendar and the trend
digest as three separate failures. Two of them, plus a P1 nobody connected to
either, share a single root cause — and a fourth symptom was a second shared
cause.

Extended thinking draws from the **same token budget as the reply**. The preview
asked for 400 tokens, so the budget could be spent entirely on thinking,
returning a valid response containing a thinking block and **no text**. The
client read that as an empty string and reported a generic failure with nothing
to retry. The same starvation was silently breaking **lead fit scoring** — which
is why every lead scored an identical 35/100. Two symptoms your reviewers filed
as unrelated were the same defect.

Separately, the calendar hang and the digest slowness were both long multi-call
generations running **inline in a single HTTP request**, exceeding the
platform's function budget and being killed mid-flight. Patching each screen
would have left the next AI feature to repeat it, so both moved to a shared
background-job system.

---

## Executive summary, item by item

Each of the six problems named in your executive summary, and where it now
stands. **Needs credential** means the code is built and wired — it activates
the moment the environment variable exists, with no further release.

| #   | Reported problem                                | Status                   | Note                                             |
| --- | ----------------------------------------------- | ------------------------ | ------------------------------------------------ |
| 1   | AI generation failures in three core flows      | ✅ Fixed                 | Two root causes, both eliminated                 |
| 2   | Connector OAuth broken; roadmap items look live | ✅ Fixed · ⚙️ Credential | Structural fix shipped; needs your Google client |
| 3   | Empty "not measured" first-run dashboard        | ✅ Fixed                 | New workspaces now always score                  |
| 4   | 14 flat nav items; duplicate workspace state    | ✅ Fixed                 | Grouped; no page moved or link broken            |
| 5   | Uniform 35/100 lead scores, no explanation      | ✅ Fixed                 | Cause confirmed exactly in the formula           |
| 6   | Action → outcome loop incomplete                | ✅ Fixed · ⚙️ Credential | Manual logging closes it today                   |

---

## Your five stated priorities

| #   | Priority                                          | What shipped                                                                                         |     |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --- |
| 1   | **Fix confirmed generation failures**             | Root causes found and eliminated, not worked around. Covered in P0 below.                            | ✅  |
| 2   | **Fix OAuth; separate live from roadmap**         | One Google redirect URI instead of one per connector; catalog split with roadmap collapsed.          | ✅  |
| 3   | **Replace the empty first-run dashboard**         | Analysis auto-runs at the end of onboarding and always produces a real score.                        | ✅  |
| 4   | **Resolve duplicate workspaces; consolidate nav** | Same-name creation blocked recoverably; sidebar grouped into five sections.                          | ✅  |
| 5   | **Close the loop to measured outcome**            | Manual result logging writes the same records a connector does — so nothing waits on an integration. | ✅  |

---

# Critical — P0

Items that blocked a core task or represented a confirmed reliability failure.
**Confirmed** means the defect was located exactly in the code; **diagnosed**
means the fix addresses a proven mechanism that produces the reported symptom,
verified by test.

---

## §3.1 · Onboarding — Brand voice

### "Could not generate a preview" on the first AI action a user ever sees

**Symptom** — Preview a sample post failed outright during onboarding, shown
loading in one capture and failed in another on the same flow.

**Root cause** _(diagnosed)_ — Not a network fault. Extended thinking shares the
reply's token budget; the preview requested only 400 tokens, so the budget could
be consumed entirely by thinking and return a well-formed response with **no
text block**. The client treated that as an empty string and surfaced a generic
error with nothing to retry.

**What changed** — Short, low-effort calls no longer request thinking at all,
and the preview ceiling was raised to 1,200 tokens. An empty completion is now a
typed error, so retry actually fires — three attempts with backoff. Permanent
failures, such as a rejected key, throw immediately rather than burning retries.
The route never returns a bare 500: it answers with a specific, retryable
message and logs the failure as an engineering incident.

> **Technical** — Fixed in the shared AI client, so every caller inherits it.
> Six tests cover the empty-completion path, the thinking threshold, and the
> retry/no-retry split between `429` and `401`.
>
> **Business** — This was an **activation killer**: a visible failure on step 2,
> before the user had seen a single success. Onboarding is now never blocked by
> it — Continue stays enabled and the brand voice still saves.

---

## §3.5 · Marketing Planner

### Generate monthly calendar buffered, then returned no calendar

**Symptom** — Generation ran for a long time, the screen returned to a normal
state, and no calendar was produced. A silent failure with no error.

**Root cause** _(confirmed)_ — A month of calendar items is a large, multi-call
generation running **inline in one HTTP request**. It exceeded the platform's
function budget and was killed mid-flight — which the browser can only render as
a request that ended with nothing.

**What changed** — Generation moved to a background job. The request queues it
and returns immediately; the browser polls for progress and shows named steps. A
failed run **keeps the brief**, so retry re-runs the saved inputs with nothing
retyped, and the form also keeps a local draft so a mid-run reload is safe.

> **Technical** — Shared job queue with queued / running / succeeded / failed
> states, persisted inputs, and a five-minute sweep that restarts jobs whose
> instance died. Double-clicking Generate cannot start two runs.
>
> **Business** — This is the **core insight → action flow**: goals in, dated
> plan out. It is the main reason a non-technical marketer opens the product,
> and it silently did nothing.

---

## §3.4 · AI Trend Insights

### Digest generation read as hung, with no progress feedback

**Symptom** — Confirmed slow generation between pressing Generate first digest
and any result appearing, with only a static spinner in between.

**Root cause** _(confirmed)_ — Trend scanning ran synchronously and blocked the
response, exactly as your implementation note suspected. A digest fans out to
every configured source and makes two model calls — far past what one request
should carry.

**What changed** — The digest now reports what it is actually doing —
_"Scanning Hacker News, r/SaaS…"_, _"Ranking 43 items"_, _"Saving your digest…"_
— with a percentage. An **app-wide indicator** carries progress and completion
to any page, so a digest started on Trends announces itself even from Settings,
with a link to the result. The daily pre-generated digest already runs on a
schedule, so most users never trigger a cold generation at all.

> **Technical** — Progress is reported from inside the generator, not simulated
> on a timer. The indicator polls workspace-wide and announces only jobs the
> session saw start, so a page reload cannot replay old completions.
>
> **Business** — A feature meant to feel fast and intelligent instead read as
> broken. Users can now **walk away** — the run no longer requires babysitting a
> page.

---

## §3.10 · Connectors — Google

### `Error 400: redirect_uri_mismatch` blocked every downstream metric

**Symptom** — Connecting Google Analytics or Search Console ended on Google's
own error screen: _Access blocked: this app's request is invalid._

**Root cause** _(confirmed)_ — Structural, not a one-off typo. **Every connector
had its own callback URL**, so a single Google OAuth client needed a separate
redirect URI registered per connector — and any one missed produced this error.
A deployment whose own URL resolves to `localhost` produces it too.

**What changed** — GA4 and Search Console now share **one** callback; which
connector is being authorised is read from the signed `state` parameter, which
was always the authoritative source. A pre-flight check runs _before_ the
browser leaves for Google and refuses with a message naming the fix. The
Connectors page shows the exact URI to register with a copy button, and states
which URL the deployment believes it is running on.

> **Technical** — Five tests pin the shared URI and the pre-flight refusals. The
> class of error is now caught on our side, where we can explain it, rather than
> on a page we do not control.
>
> **Business** — **One URI to register instead of one per connector** — less
> setup, and one fewer way for a future integration to fail the same way. Needs
> your Google client credentials to go live.

---

## §3.2 · Dashboard — Marketing Intelligence

### New users landed on "Not measured" across every card

**Symptom** — The overall score and all nine sub-metrics read "Not measured"
simultaneously, behind a manual Run analysis button.

**Root cause** _(confirmed)_ — Answering your implementation note directly: the
engine did **not** require all categories — it correctly excluded unmeasurable
ones rather than scoring them zero. The real problem is that _every_ category
needed activity a new workspace has not had time to produce, so the weighted
score had nothing to average and returned null.

**What changed** — A new **setup foundations** score measures what a new
workspace genuinely has: website, industry, brand voice, knowledge base,
competitors, lead requirement, first draft, connected source. It is always
measurable, so the headline score is never null. The first analysis is queued
automatically when onboarding finishes, and the wall of blank cards is replaced
by a checklist that visibly completes, with one highlighted next step.

> **Technical** — Foundations carries a real weight in the same formula as every
> other block: a genuine measurement of setup completeness, not a placeholder
> number to avoid an empty state.
>
> **Business** — Named as a **direct activation blocker**, and rightly. Users now
> see intelligence in their first session, and the one next step is exactly the
> "Add your first competitor" prompt you asked for.

---

## §3.10 · Analytics

### All-zero metrics, hard-blocked on integrations that may be weeks away

**Symptom** — Every Analytics tile read zero, with no route to data that did not
depend on a working connector.

**Root cause** _(confirmed)_ — Nothing had ever reported a number. Measurement
had exactly one supported path — a connector — so an OAuth review could block
the entire outcome loop, and with it Marketing Memory, which cannot learn from
results it never receives.

**What changed** — Results can be **logged by hand**. Typed numbers are stored
as the same kind of record a connector writes, so Analytics, Marketing Memory
and content intelligence consume them identically — and nothing needs
re-plumbing when the API arrives. You also asked for connection by email
verification code: connectors can now be verified with an emailed six-digit code
where a provider's OAuth app is not registered.

> **Technical** — One storage shape for all three sources, so no downstream
> consumer needs a special case. The email-code path confirms account ownership;
> it does not grant API access, and the interface says so rather than implying a
> working sync.
>
> **Business** — The **action → outcome loop closes today**, not after an
> approval. Since Marketing Memory needs roughly ten measured posts, starting to
> collect now is what makes it useful sooner.

---

# Important — P1

---

## §3.7 · Leads

### Every discovered lead scored an identical 35/100

**Root cause** _(confirmed exactly)_ — The fallback scorer computed
`35 + matches × 15`. With no term match that is **precisely 35**, for every
lead, with the identical note your review quoted verbatim. Two faults stacked:
the AI scorer's token budget was too small for its own output, so it failed
validation and dropped every lead to that fallback — the same budget starvation
as the brand-voice preview.

**What changed** — Each criteria group (industry, role, keyword, stage,
geography) now contributes weighted, **partial** credit, so scores genuinely
differentiate. Every lead shows which criteria it met and which it missed. Leads
under 40/100 collapse out of the way with the hidden count shown, never silently
dropped. And **"Not relevant, because…"** captures the reason against the
requirement that produced the bad match.

> **Technical** — Five tests pin that a full match beats a partial beats none,
> that partial credit scales with how much of a group matched, and that a
> no-criteria requirement says so instead of inventing a number.
>
> **Business** — Uniform unexplained scores made discovery feel like **noise
> rather than intelligence**. A score you can argue with is a score a
> salesperson will act on — and the dismissal reasons feed back into future runs.

---

## §3.3 · Marketing Intelligence

### Every "What to fix first" item was labelled medium

**Root cause** _(confirmed)_ — Priority was a flat default rather than a
computed value, so the list could not answer its own question.

**What changed** — Priority is now **weight × gap-to-target**, using the same
weights that produce the headline score — so the list can only recommend work
that actually moves the number above it. Each item carries an expected impact
line ("worth about +6.2 points"), and the top item is lifted out as a **Start
here** card.

> **Technical** — The model may reword and reorder, but impact stays arithmetic:
> letting it self-rate would reintroduce the flat priorities. An unmeasured area
> scores its full gap — not knowing is itself the problem.
>
> **Business** — You called this the feature's **namesake promise** and one of
> Aura's strongest differentiators. It now delivers a ranked queue with a
> defensible reason for the ranking.

---

## §3.6 · Campaigns

### 25 tasks PENDING beside "Awaiting your review: 0"

**Root cause** _(confirmed)_ — A single PENDING label conflated two unrelated
states: work _scheduled for a future date_ (the campaign running correctly) and
work _due but not yet run_ (genuinely stuck). Both counted toward the same 25,
which is why the two numbers looked contradictory.

**What changed** — Scheduled-for-later and due-now are separate counts, with a
breakdown by task type and a **Next up** card surfacing only the next actionable
item. When the review count is zero while tasks are pending, the screen now
explains why.

> **Technical** — Derived at render from scheduled date versus now — no
> migration, and it corrects historical campaigns immediately.
>
> **Business** — Users could not tell whether a campaign was running, stuck, or
> waiting on them, which undermines the **one reviewable plan** concept the
> module is sold on.

---

## §3.8 · Outreach Intelligence

### Message-by-message approval, and a queue that silently built up

**What changed** — Bulk approval, but **selective**. "Approve N high-confidence"
covers only drafts scoring 70+: grounded in a real public signal, written in
your brand voice, aimed at a well-scored named contact with a confirmed profile,
and free of unfilled placeholders. Everything else stays in the queue with its
reason named, and Approve all remains as a deliberate override. A backlog
warning fires when approved messages have sat unsent for three days or more.

**Design note** — Writing the tests changed the design. Additive points let a
draft missing one essential still clear the bar by being strong elsewhere — four
tests failed on exactly that. Since approving in bulk means **sending unread**,
each essential is now a gate that caps the score rather than a contributor to it.

> **Technical** — Confidence is computed from real properties of the draft,
> never a model self-rating, which would be exactly the unearned confidence the
> threshold exists to prevent. Ten tests cover every draft that must never reach
> a batch.
>
> **Business** — Removes the per-message tax on a small team without handing
> review to a button. The reason sending is manual — **LinkedIn's API does not
> permit automated connection requests**, and anything that sent them would risk
> the user's account — now appears on the board itself, not only in Settings.

---

## §3.11 · Connectors catalog

### 26 connectors, most of them non-functional placeholders

**What changed** — **Available now**, grouped by category, is separated from a
single collapsed **Coming soon** list. Roadmap items are visibly non-functional
and can no longer be clicked as though they work. Anything needing a credential
names the exact one rather than showing an indefinite "coming soon".

> **Technical** — The split is driven by whether an integration actually exists
> in the codebase, so the catalog cannot drift out of step with what is built.
>
> **Business** — A catalog dominated by placeholders made the product look
> **feature-heavy but hollow**. Fewer, honest entries read as more credible than
> twenty-six that mostly do nothing.

---

## §3.12 · Settings

### Invitations written to a log, never sent

**What changed** — When mail did not go out, **Get invite link** becomes the
primary action rather than sitting behind Resend.

One correction to the recommendation: invite tokens are stored **hashed**, so a
link genuinely cannot be reconstructed after the fact — it can only be produced
by issuing a fresh one. The button now says that, instead of implying we still
hold the original.

> **Technical** — Hashed tokens are the correct security posture and were kept.
> The interface was changed to be honest about the consequence, rather than the
> storage being weakened to suit the interface.
>
> **Business** — Team collaboration is unblocked **today** via shareable links,
> and fully automatic once the mail credentials are set.

---

## §4 · Navigation and workspaces

### Fourteen flat items, and workspaces that could silently duplicate

**What changed** — The sidebar is grouped into **Understand · Create · Grow ·
Measure · Setup**. Every page stays exactly where it was — no links break — but
the sidebar now has an obvious top and a reading order that follows what someone
is trying to do. Separately, creating a workspace whose name you already have is
blocked with a recoverable prompt.

> **Technical** — Grouping over merging was deliberate: merging pages would move
> features users have already been shown and break existing links, for the same
> legibility gain.
>
> **Business** — Addresses "a tool menu rather than one assistant" without the
> disruption of relocating features mid-review. Duplicate workspaces had been
> **splitting a user's data across two identical-looking entries**.

---

# Secondary — P2

---

## §3.9 · Competitor Intelligence and Marketing Memory

### Two differentiated features that stayed empty indefinitely

**What changed** — Competitors carries a prompt to reach three tracked,
explaining that comparison needs more than one point of reference. Marketing
Memory's "Not enough data" now names the gate: results from **ten published
posts**, how many you currently have, and — as you asked — that it counts
posts-with-numbers rather than elapsed time, with the three ways to supply them.

> **Technical** — The count comes from actual measured records, so the progress
> shown is real rather than an estimate.
>
> **Business** — "Not enough data yet" with no number reads as **come back
> never**. A visible target converts a dead end into a task, and manual logging
> (§3.10) is what lets a user reach it without waiting.

---

# What we need from you

All of this is built and wired. Each activates the moment the credential exists
— **no further release required**.

| What it unlocks                               | What to set                                                                                                     | Where                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Every AI generation running at full quality   | `ANTHROPIC_API_KEY`                                                                                             | Deployment environment             |
| Invitations, password resets, connector codes | `RESEND_API_KEY` + `EMAIL_FROM`, or `SMTP_*`                                                                    | Deployment environment             |
| Google Analytics & Search Console             | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, and register the **one** redirect URI shown on the Connectors page | Google Cloud Console + environment |
| Recovery of interrupted generations           | Schedule `/api/cron/jobs` every 5 minutes                                                                       | Deployment scheduler               |
| Correct public links in emails and OAuth      | `APP_URL` set to the public deployment URL                                                                      | Deployment environment             |

### One thing worth checking first

Without an AI key, every generation silently falls back to heuristics. **Several
"AI is broken" symptoms in the review are consistent with the key being absent
or rejected on that environment** — including the identical 35/100 lead scores,
which are exactly what the non-AI fallback produces.

The defects behind those symptoms were real and are fixed regardless. But it is
worth confirming the key before the next review pass, because the code now
reports _which_ of the two is happening instead of failing silently — and that
distinction will make the next round of feedback much faster to action.

---

# Verification

Not only unit tests. The full stack was run against a **real Postgres database
and a running application**, because the original defects lived precisely in the
parts that only exist once the pieces are wired together.

|         |                  |
| ------- | ---------------- |
| **204** | Tests passing    |
| **32**  | Runtime checks   |
| **27**  | Pages return 200 |
| **14**  | Migrations apply |
| **0**   | Failures         |

### The P0 digest, verified live

A trend digest was queued and run end to end over HTTP — the exact flow that
previously read as hung. It reported its work the whole way and finished in
**18 seconds**:

| Elapsed | State     |        | Reported to the user                          |
| ------- | --------- | ------ | --------------------------------------------- |
| `t+2s`  | Running   | `8%`   | Loading your trend settings…                  |
| `t+4s`  | Running   | `20%`  | Scanning Hacker News, Reddit, News…           |
| `t+14s` | Running   | `55%`  | Ranking 172 items — writing why each matters… |
| `t+16s` | Running   | `80%`  | Summarising the week and pulling hashtags…    |
| `t+18s` | Succeeded | `100%` | 20 items · no sources skipped                 |

### What running it for real caught

Unit tests could not have found these. Three defects were found only by running
the real thing, and all three are fixed:

**A discouraging first impression.** A user finishing onboarding was greeted
with _"Overall marketing score 15/100"_ in red — arithmetic that was correct and
a meaning that was wrong. With no content, leads or campaigns yet, setup
completeness is the only measurable area, so the number actually meant _"2 of 8
setup steps done"_ wearing the label of a verdict on their marketing. Your
review asked for a partial score to replace the empty state; it did not ask for
a discouraging one. The headline now reads **Setup progress** with a neutral
"Getting started" chip, states in words that it is not a judgement of their
marketing, and **"Finish your setup"** leads the priority list instead of
"Content quality", which had been ranking first for a workspace with no content.

**Workspace creation returned 500 on every attempt.** A request body is a
single-use stream. The duplicate-name guard read it with `req.json()` and then
called `req.clone()` to check a second field; cloning a consumed body throws
`TypeError: unusable` _synchronously_, so the `.catch()` on the following
`.json()` never saw it. Onboarding could not complete at all. The body is now
read once. Verified: create `201`, duplicate name `409`, confirmed duplicate
`201`, invalid payload `422` — none of them 500.

**Unauthenticated API calls answered 500 instead of 401.** `requireUser()`
redirects by throwing, which is right for a page but fell through to the
catch-all in a route handler. Pre-existing across every company-scoped route,
but the new job indicator polls continuously, so a lapsed session would now
spray phantom 500s. Fixed, and the indicator stands down on 401.

### Everything else confirmed

- All **14 migrations apply cleanly from an empty database**, in order, with no
  schema drift afterwards.
- Job lifecycle proven under contention: a second claim on a running job is
  **refused**, so a duplicate kick cannot start a second run; a failed run
  requeues and **keeps its inputs** for retry.
- Connector pre-flight **refused a localhost deployment** with the fix named,
  before any redirect to Google. GA4 and Search Console confirmed sharing one URI.
- Lead scores confirmed differentiating on real data — `100 / 46 / 0` where all
  three were previously `35`.
- Manual result logging returned `201`; an empty payload was correctly rejected
  with `422`.
- Full sweep of the running app: **27 pages, 8 APIs, 0 errors, 0 HTTP 500s.**
- One migration, **additive only**. No existing data is rewritten, and no
  rollback risk to current workspaces.
- Two tests were **deliberately changed rather than made to pass**: one asserted
  the exact wording this review asked us to remove, and four failing confidence
  tests exposed a real weakness in the scoring design, which was rebuilt around
  gates instead of points.

---

_Botella Aura · Remediation Report ·
`ac4d45e` · `96c1f1a` · `c320f33` · `a6b1747` · `d99e0f8` · `main`_
