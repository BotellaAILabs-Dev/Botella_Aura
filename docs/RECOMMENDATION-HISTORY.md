# Recommendation History & Activity

Previous Aura suggestions and what the business did with them. The history
is a view over the lifecycle record (`RecommendationEvent`,
[RECOMMENDATION-LIFECYCLE.md](RECOMMENDATION-LIFECYCLE.md)), not a second
copy. It is also what stops Aura repeating itself, and what Marketing Memory
can learn from.

| Piece | Where |
| --- | --- |
| Outcomes, entries, repeat hold, learning candidates (pure) | [`lib/recommendation-history.ts`](../lib/recommendation-history.ts) |
| Loading | [`server/recommendations/history.service.ts`](../server/recommendations/history.service.ts) |
| Page | `/dashboard/suggestions/history` (the **History** button on Aura Suggests); filter with `?outcome=` |
| API | `GET /api/recommendations/history?outcome=&limit=` → `{ entries, counts, learning }` |
| Tests | [`tests/recommendation-history.test.ts`](../tests/recommendation-history.test.ts); `pnpm verify:history` (real recommendations, answered through the real lifecycle) |

---

## What the history shows

Every recommendation that has been answered appears, newest decision first.
Ones still waiting for an answer are on Aura Suggests, not here.

| | |
| --- | --- |
| **Outcome** | Accepted · Edited & accepted · In progress · **Completed** · Skipped · Turned down · Withdrawn · Expired. Filter by any of them, with counts |
| **Timestamps** | Suggested, decided (or expired), last edited, started, completed — each shown in the viewer's own time zone |
| **Who** | The person who decided; "Aura" when it expired; "Sam (on the opportunity)" when the decision was made on the opportunity |
| **Why** | Their note, when they left one |
| **What changed** | For edits: each field a person changed (headline, channel, steps…) |
| **What was made** | Drafts and campaigns modules made from it, linked |
| **Origin** | The originating opportunity, linked (`/dashboard/opportunities?focus=…`) |
| **Will it come back?** | Whether Aura will suggest it again, and when |
| **Full history** | Every step (suggested, accepted, edited, worked on…), by whom and when |

## Avoiding unnecessary repetition

`repeatHold` decides whether Aura may suggest an opportunity again, based on
what happened to its last suggestion:

| Last outcome | Held back |
| --- | --- |
| Accepted, edited, in progress, completed | For good: it was acted on |
| Skipped | 14 days ("not now" means ask later, not tomorrow) |
| Withdrawn | 14 days |
| Turned down | 30 days |
| Expired | Not held; it may come back if it still matters |

**Where it applies.** The automatic suggestion pass (after detection, and
"Get Aura's suggestions") respects the hold. A person who presses
"Recommend" on an opportunity is never held back.

**Fixed while building this.** A skipped opportunity's status stays
"recommended", and the pass used to consider only "detected" and "reviewed"
opportunities. So a skip could never come back at all. The pass now
considers every active opportunity with no suggestion in play, and the hold
decides when.

**Already in place.** The engine's own duplicate rules (no near-identical
suggestion within 14 days, or within 30 days of a rejection) and ranking
(similar rejections −8, skips −3) already read this history.

## Feeding Marketing Memory

`learningCandidates` turns the business's answers into patterns in exactly
Marketing Memory's shape: `insightType`, `insight`, `confidence`,
`sampleSize`, `supportingDataSummary` (the recommendation ids behind it).

**What counts:**
- **Only clear patterns:** at least 4 answers of a kind (by kind of
  suggestion, and by channel), and 75% or more one way. For example: "The
  business usually turns down post series (4 of 4)."
- **Skips are ignored:** "not now" says nothing about whether the idea was
  right.
- **Confidence grows with the sample:** low under 7, medium under 12, high
  from 12.

They are shown on the history page ("What Aura is learning from your
answers") and returned by the API. They are **not yet written** to Marketing
Memory: that is a later step, with the data already in its shape.

## Acceptance criteria

| Criterion | How |
| --- | --- |
| User can see previous Aura recommendations | The history page and API: every answered suggestion with its outcome, timestamps, who decided, what changed or was made, and its opportunity |
| Aura can use recommendation history to avoid unnecessary repetition | The repeat hold in the automatic pass (a skip waits 14 days, a rejection 30, an acted-on one never comes back), on top of the engine's history-based duplicate rules and ranking |
| History can eventually feed Marketing Memory | Learning candidates in Marketing Memory's own shape, with sample size, confidence and the recommendations behind them |
