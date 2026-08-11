# Botella Aura — V2 Features: Feasibility & Dependency Analysis

> What we can build **now with zero external dependencies**, what's **partially**
> possible, and what's **blocked** — with the exact API/data each blocker needs.
> Grounded in the current codebase (Claude is already integrated; we already have
> a campaign planner, analytics, Marketing Memory, competitor tracking, and a
> performance-metrics pipeline).

**Last updated:** V2 planning.

---

## 0. The one insight that explains everything

Almost every V2 feature is **AI reasoning + content analysis + our own first-party
data** — all of which we can do **today** with:
- **Claude** (`claude-opus-4-8`) — already wired (`server/ai/claude.ts`). No new dependency.
- **Our own data** — leads, campaigns, drafts, competitor web snapshots, Marketing Memory.
- **Pure algorithms** — readability, cadence, gap detection (no API at all).
- **A curated "awareness-days" dataset we build ourselves** (no API).

There is **exactly one hard blocker**, and it's the same one behind every
"performance / health score" ask:

> **🔴 Real published-post performance metrics** — impressions, reach, likes,
> clicks, comments on content *after it's live*. We can't invent these; they must
> come from a real source.

Those sources (already modeled as `PerformanceSource`):
1. **`MANUAL`** — the user types numbers in. ✅ Works today, no API.
2. **`EXTENSION_DOM`** — the browser extension reads metrics from the page. ✅ Built, but the extension itself has a Chrome issue to fix.
3. **`LINKEDIN_API` / GA4 / Meta** — platform analytics APIs. 🔴 Need setup/approval/cost.

**So: ~80% of the V2 list ships now with no external API. The remaining ~20% is
the "how did our posts actually perform" data — and even that already works via
manual entry or the extension; the APIs just automate it.**

Legend: ✅ doable now (no external API) · 🟡 partial (engine now, full value needs real metrics) · 🔴 blocked on a specific API.
Effort: **S** ≤1 day · **M** 2–4 days · **L** 1–2 weeks.

---

## 1. Executive summary (per feature)

| # | Feature | Overall | Ships now without any API? | Main blocker (if any) |
|---|---------|---------|-----------------------------|-----------------------|
| 1 | **AI Marketing Planner** | ✅ | **Yes** — enhances existing planner + calendar | None |
| 2 | **AI Marketing Advisor** | ✅ | **Yes** | None (competitor part uses existing keyless tracking) |
| 3 | **AI Marketing Coach** | 🟡 | **Engine yes; value scales with data** | Real performance metrics (extension/manual now; APIs later) |
| 4 | **AI Marketing Intelligence Dashboard** | 🟡 | **Content + Brand Intelligence: yes. Performance scores: partial** | Published-post metrics for the "Performance" tiles |
| 5 | **AI Competitor Intelligence** | ✅ | **Mostly yes** (public web + gap analysis) | Richer with Meta Ad Library (free) + social APIs |

**Bottom line:** we can build the majority — including the highest-value pieces
(monthly AI planner, proactive advisor, and the pre-publish Content & Brand
quality scoring) — **with no new external dependency at all.**

---

## 2. The blocker APIs (only relevant to "real performance metrics")

Everything in this table is **optional** — it *automates/enriches* data we can
already get manually or via the extension. Nothing here blocks the AI features
themselves.

| API | Unlocks | Cost | Approval / friction | Free alternative we already support |
|-----|---------|------|---------------------|--------------------------------------|
| **LinkedIn Marketing / Community Management API** | Real post impressions/engagement on Company Pages; publishing | Free | **Hard** — LinkedIn app review/approval (weeks) | Extension (`EXTENSION_DOM`) or manual entry |
| **Google Analytics (GA4) Data API** | Website traffic, conversions, campaign attribution | Free | Easy (OAuth, self-serve) | — (website-only; not post metrics) |
| **Meta Graph API** (FB/IG Insights) | Post reach/engagement on FB & IG | Free | Medium — app review for insights scopes | Extension / manual |
| **Meta Ad Library API** | **Competitors' active ads** (public) | Free | Easy (public) | — (great for competitor intel) |
| **Google Search Console API** | Search queries/rankings for the site | Free | Easy (OAuth) | — |
| **X / Twitter API** | Post metrics + publishing | **Paid** ($100+/mo for useful tier) | Easy but paid | Extension / manual |
| **YouTube Data API** | Channel/video analytics | Free | Easy (OAuth) | — |

**Key point:** none of these block the *intelligence*. They feed the
`PerformanceSnapshot` table that the Coach and the Dashboard's "Performance"
tiles read from. Today that table is fed by **manual entry** and the
**extension** — so those features already function; the APIs just make the data
flow automatic and richer.

---

## 3. Feature-by-feature breakdown

### 1) AI Marketing Planner — ✅ fully doable now

*Enhances the existing `server/campaigns/planner.ts` (already produces day-by-day
plans) + the content calendar.*

| Capability | Status | How / what's needed | Effort |
|------------|--------|---------------------|--------|
| Monthly content calendar from brand + goals | ✅ | Extend the existing planner to a month view; Claude + brand voice + Memory. **No API.** | M |
| Industry awareness days + seasonal campaigns | ✅ | Build a **curated awareness-days dataset** (JSON, per country/industry) we own; Claude enriches. **No API.** | M |
| Automatic content gap detection | ✅ | Pure logic: compare scheduled `ContentDraft`s vs target cadence/topic coverage + Claude summary. **No API.** | S |
| Smart reminders (pending / unscheduled) | ✅ | Query logic over draft status/`scheduledFor`; in-app now, email via Resend (already wired). **No API.** | S |
| Dynamic rescheduling on priority change | ✅ | Claude re-plans `CampaignTask`/drafts. **No API.** | M |

**Verdict:** build now. Zero external dependency. Mostly *enhancing* code we have.

---

### 2) AI Marketing Advisor — ✅ doable now

*Proactive recommendations. Reuses trends (keyless, live), geo (just added),
competitor tracking, and the awareness dataset.*

| Capability | Status | How / what's needed | Effort |
|------------|--------|---------------------|--------|
| Industry & location campaign ideas | ✅ | Claude + company profile + the geo filters we just shipped. **No API.** | S |
| Seasonal / festival opportunities | ✅ | Awareness-days dataset + Claude. **No API.** | S |
| Awareness-day recommendations | ✅ | Dataset lookup by industry/country. **No API.** | S |
| Trending topic suggestions | ✅ | Our **existing keyless trend engine** (Google/Bing/HN/Reddit). **No API.** | S |
| Competitor-inspired campaign ideas | 🟡→✅ | Uses **existing competitor tracking** (public web/RSS) + Claude. Works now; richer with Meta Ad Library (free). | M |

**Verdict:** build now. The competitor-inspired part works on public data we
already collect; free Meta Ad Library later makes it sharper.

---

### 3) AI Marketing Coach — 🟡 engine ready now, value scales with data

*The engine already exists: `server/memory/` (Marketing Memory, performance,
metrics) + `server/analytics/`. The question is **how much real performance data
flows in.***

| Capability | Status | Why | What unlocks full value |
|------------|--------|-----|--------------------------|
| Best-performing content formats | 🟡 | Needs which posts did well → real metrics | Extension/manual now; LinkedIn/Meta API later |
| Recommended posting frequency | 🟡 | Correlates cadence with engagement | Same |
| Optimal publishing times | 🟡 | Needs timestamped engagement | Same |
| Strategies from past performance | 🟡 | Same | Same |
| Improve **consistency** | ✅ | Cadence adherence is **our own data** — no metrics needed | Nothing |
| Improve **engagement** | 🟡 | Needs real engagement data | Extension/manual/API |

**How it behaves today (honest):** with **no** performance data, the Coach can
only give **generic best-practices** (clearly labeled as such — no fake numbers,
consistent with our "hasData:false" analytics principle). As soon as data flows
in (a few manual entries, or the extension reporting), it becomes **data-driven
and specific**. This is a *data-availability* gradient, not a code blocker.

**Verdict:** build the Coach now; it degrades gracefully. Pair it with a
one-tap "log this post's numbers" (manual) so it's useful on day one, and it gets
automatic once analytics connectors land.

---

### 4) AI Marketing Intelligence Dashboard — split verdict

This is really **two very different things**, and the split matters:

#### 4a) Content Intelligence + Brand Intelligence — ✅ **fully doable now (high value)**

These analyze the **content itself before it's published** — no live metrics needed.

| Tile | Status | How (no external API) | Effort 


|
|------|--------|------------------------|--------|
| AI Content Quality Score | ✅ | Claude rubric over the draft | M |
| Hook Strength Analysis | ✅ | Claude scores the opening line | S |
| Readability Score | ✅ | **Pure algorithm** (Flesch–Kincaid) — no AI, no API | S |
| CTA Effectiveness | ✅ | Claude detects/评 rates the CTA | S |
| Engagement **Prediction** | ✅* | Claude **estimate**, clearly labeled "predicted," not measured | M |
| Brand Consistency Score | ✅ | Claude vs the stored Brand Voice Profile | M |
| Tone-of-Voice Validation | ✅ | Claude vs brand voice | S |
| Vocabulary Recommendations | ✅ | Claude vs brand vocabulary | S |
| Improvement suggestions **before approval** | ✅ | Claude, injected into the approval screen | M |

> \* "Engagement prediction" is an AI **estimate**, not real data — we label it as
> a prediction so it's never mistaken for measured performance. It gets calibrated
> once real metrics exist (see 4b).

**This is arguably the most valuable slice of the whole V2 list — "optimize every
piece before it's published" — and it needs zero external API.** Build now.

#### 4b) Marketing / Campaign Performance + Overall Score — 🟡 partial

| Tile | Status | Blocker |
|------|--------|---------|
| Lead Generation Health | ✅ | Our own `Lead`/outreach data — no API | 
| Competitor Visibility | 🟡 | Our competitor tracking (keyless) — works, richer with APIs |
| Campaign Performance (reach/engagement) | 🔴 | **Real published-post metrics** → GA4 / LinkedIn / Meta, or extension/manual |
| Marketing Performance (impressions/clicks) | 🔴 | Same |
| Overall Marketing Score | 🟡 | Composite; computable now but the metrics-based components are the gap |

**Verdict:** ship the dashboard shell + the **Content/Brand Intelligence** tiles +
**Lead Gen Health** now. The **Performance** tiles show an honest "connect an
analytics source to unlock" state until GA4/LinkedIn/Meta or extension/manual data
is available (consistent with the existing `hasData:false` pattern).

---

### 5) AI Competitor Intelligence — ✅ mostly doable now

*Builds on existing `server/competitors/` (tracking, diffing, reports).*

| Capability | Status | How / what's needed | Effort |
|------------|--------|---------------------|--------|
| What activities competitors are executing | 🟡→✅ | Existing keyless tracking of competitor **public web/RSS**; add **Meta Ad Library (free API)** for their ads | M |
| Gaps / opportunities missing from our strategy | ✅ | Claude compares competitor snapshots vs our content/strategy. **No API.** | M |
| AI next-best-action recommendations | ✅ | Claude. **No API.** | S |

**Verdict:** build now on public data + Claude gap analysis. Meta Ad Library
(free, public) is the single best *optional* add for competitor ad visibility.

---

## 4. Consolidated view

### ✅ Build now — ZERO external API dependency (recommended first)
1. **AI Marketing Planner** (monthly calendar, awareness days, gap detection, reminders, rescheduling)
2. **AI Marketing Advisor** (industry/geo/seasonal/trending/competitor-inspired ideas)
3. **Content Intelligence** (quality, hook, readability, CTA, engagement estimate)
4. **Brand Intelligence** (consistency, tone, vocabulary, pre-approval suggestions)
5. **Competitor gap analysis + next-best actions**
6. **AI Marketing Coach** — the engine (degrades to best-practices; add manual "log numbers")
7. **Lead Generation Health** tile

> All of the above rely only on **Claude (already integrated)**, our **own data**,
> **pure algorithms**, and a **curated awareness-days dataset we build**. No
> approvals, no new paid services.

### 🟡 Build the engine now, data improves it over time
- **AI Marketing Coach** performance-specific advice (best formats/times/frequency)
- **Dashboard Performance/Overall Score** tiles

These work on **manual entry** and the **extension** today; they become automatic
and richer with analytics APIs.

### 🔴 True external blockers (only for automatic real metrics)
| Need | Blocked feature parts | Fix |
|------|-----------------------|-----|
| Published-post metrics | Coach (formats/times), Dashboard Performance tiles | GA4 (easy) + LinkedIn (approval) + Meta (review), **or** fix the extension, **or** manual entry |
| Competitor **ads** visibility | Competitor "activities" richness | Meta Ad Library (free, easy) |

**Not a blocker but required for one thing:** invite/reminder **emails** need
`RESEND_API_KEY` (already wired — just set the key).

---

## 5. Recommended build order (phased)

**Phase A — "Pre-publish intelligence" (no dependencies, highest visible value):**
Content Intelligence + Brand Intelligence + the pre-approval "improve this" panel.
→ Every draft gets a quality/brand score and suggestions before approval. Pure Claude + algorithms.

**Phase B — "Proactive planning" (no dependencies):**
AI Marketing Planner (monthly calendar + awareness days + gaps + reminders) and
AI Marketing Advisor. Reuses the existing planner and trends.

**Phase C — "Competitor gaps" (no hard dependencies):**
Competitor gap analysis + next-best actions; optionally wire the free Meta Ad Library.

**Phase D — "Performance-driven" (data-gated):**
AI Marketing Coach data-driven mode + Dashboard Performance tiles. Ship with
manual entry + extension first; then add GA4 (easy), then LinkedIn/Meta as
approvals land. Overall Marketing Score composes everything above.

**Cross-cutting prerequisites to line up in parallel (not code — procurement):**
- Fix the **browser extension** Chrome issue (unblocks `EXTENSION_DOM` metrics for free).
- Start **LinkedIn Marketing API** approval now (long lead time).
- Set **`RESEND_API_KEY`** for reminders/invites.
- (Optional, easy) GA4 + Meta Ad Library OAuth apps.

---

## 6. One-line answer to "what can we do without APIs?"

> **Everything except automatically pulling real published-post metrics.** The AI
> planner, advisor, coach engine, competitor gap analysis, and — most valuably —
> the pre-publish Content & Brand quality scoring all ship now on Claude + our own
> data with **no external API and no approvals**. The only thing that genuinely
> needs an external source is "how did our live posts actually perform," and even
> that already works via manual entry or the extension today; GA4/LinkedIn/Meta
> just automate it.
