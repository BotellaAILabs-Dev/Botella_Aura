# Recommendation Prioritisation

Decides **which recommendations to surface first**, based on business
relevance, urgency, confidence and potential impact.

**This is a prioritisation mechanism, not a permanent "best recommendation"
ranking.** The order is computed on every read, from the business as it is at
that moment: its goals and channels, what is closing, and what it has
accepted, turned down or deferred. The same recommendation can rise or fall
from one day to the next. Ranking never changes a recommendation's stored
priority, which is just one of its inputs.

| Piece | Where |
| --- | --- |
| Factors, weights, bands, tie-breaking (pure) | [`lib/recommendation-ranking.ts`](../lib/recommendation-ranking.ts) |
| Loading inputs, "Not now" | [`server/recommendations/ranking.service.ts`](../server/recommendations/ranking.service.ts) |
| API | `GET /api/recommendations/surface` · `POST /api/recommendations/:id/snooze` |
| Tests | [`tests/recommendation-ranking.test.ts`](../tests/recommendation-ranking.test.ts); `pnpm verify:prioritization` against a real database |

**What is ranked:** recommendations waiting for a decision (generated or
presented), and ones accepted (as is or edited) but not yet started. Recommendations already in progress, or
finished, aren't competing for attention.

---

## 1. Priority factors

Each factor adds or removes points, **always with its reason**. The score is
the sum of the factors, kept within 0–100.

| Factor | Effect |
| --- | --- |
| **Opportunity priority** | The recommendation's own priority score (from its opportunity's impact, the chosen action's effort, confidence and time) contributes up to **+50** |
| **Confidence** | High **+10** · Medium **+4** · Low **−10** |
| **Business goals** | Relates to the current goal or a running campaign's theme: **+10** |
| **Timing** | Closes within 3 days **+15** · within a week **+8** · waiting 14+ days for a decision **−5** |
| **Available channels** | Connected, so Aura can publish and measure it **+8** · can be connected **+2** · blocked (can't be acted on yet) **−25** |
| **Evidence** | None still current **−20** · two or more current pieces **+4** |
| **Status** | Accepted and waiting to start **+5** |
| **Previous decisions** (last 90 days) | Each similar one the business acted on **+6** (up to 2) · each similar one it turned down **−8** (up to 3) · each similar one it skipped **−3** (up to 3; "not now" is weaker than "no") · deferred more than once **−5** per extra time |

**"Similar"** means the same action on the same channel, or a near-identical
title (the same matching as the duplicate rules). A recommendation's own
decision never counts as its history.

All weights are data (`RANKING_WEIGHTS`), so the product rules can be tuned in
one place.

## 2. Bands

| Band | Rule |
| --- | --- |
| **Surface now** | Score **70+**, **and** at least one piece of current evidence, at least medium confidence, and nothing blocking it |
| **Next** | Score 40–69, or a score of 70+ held back by one of the conditions above, with the reason (e.g. "its evidence is no longer current") |
| **Later** | Below 40 |
| **Deferred** | "Not now" until a date (hidden unless asked for) |

So **every high-priority recommendation surfaced first has supporting
evidence**. A high score alone isn't enough.

## 3. Ranking and tie-breaking

The list is ordered by band, then by score. When scores are equal, ties break
in this fixed order:
1. the one closing sooner (no deadline last)
2. higher confidence
3. more current evidence
4. waiting longer (created earlier)
5. its id, so the order is total and **identical on every read**

There is no randomness: the same data always gives the same order.

## 4. Previous decisions and resurfacing

- **Accepting** similar recommendations lifts this one; the business has shown
  it acts on this kind of thing.
- **Rejecting** similar ones sinks this one. After 3 rejections in 30 days,
  the engine stops proposing that action at all
  ([RECOMMENDATION-RULES.md](RECOMMENDATION-RULES.md) §6).
- **"Not now"** (`POST /api/recommendations/:id/snooze { days }`, 1–30 days,
  default 7):
  - hides it until that date; it then **comes back**, and its explanation says
    "Back after you deferred it"
  - each further deferral lowers it
  - it is refused if the recommendation would stop being relevant while
    hidden, since that is a "no", not a "not now"
  - the deferral is recorded in its history

## 5. Explaining a position

Each surfaced recommendation includes:
- **rank, score and band**
- **factors:** every factor's points and reason
- **explanation:** one sentence, e.g. "Surface now (score 83): high priority
  (90/100) (+45); closes in 2 day(s) (+15); high confidence (+10)." If it is
  held back from the top, the explanation says why.
- **resurfaced:** whether it is back after being deferred

## API

`GET /api/recommendations/surface?includeHidden=1` returns
`{ recommendations: [{ rank, score, band, factors, explanation, heldBack, resurfaced, recommendation: { id, title, action, type, status, channel, priority, confidence, executable, relevantUntil, evidence } }] }`.
Any member can call it.

`POST /api/recommendations/:id/snooze { days? }` is for owners and admins. It
returns 409 if the recommendation can't be deferred.
