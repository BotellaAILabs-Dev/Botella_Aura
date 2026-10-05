# Opportunity Data Model

An **opportunity** is something Aura noticed that the business could act on: a
trend worth joining, a competitor move worth answering, a gap in what it
publishes. Each one is stored as its own record:
- independent of any recommendation
- carrying the evidence it came from, linked to the underlying signal records
- moving through a tracked lifecycle

| Piece | Where |
| --- | --- |
| Tables | `Opportunity`, `OpportunitySignal`, `OpportunityEvent` (migration `20261002120000_opportunities`) |
| Rules: vocabulary, lifecycle, confidence, priority, relevance | [`lib/opportunities.ts`](../lib/opportunities.ts) (pure) |
| Storing and lifecycle | [`server/opportunities/opportunity.service.ts`](../server/opportunities/opportunity.service.ts) |
| Advisor → opportunities | [`server/opportunities/from-advisor.ts`](../server/opportunities/from-advisor.ts) |
| HTTP | `GET /api/opportunities`, `GET /api/opportunities/:id`, `POST /api/opportunities/:id/status` |
| Tests | [`tests/opportunities.test.ts`](../tests/opportunities.test.ts); `pnpm verify:opportunities` against a real database |

---

## Schema

### `Opportunity`

| Field | Meaning |
| --- | --- |
| `type` | See the types table below |
| `status` | Lifecycle state (below) |
| `title`, `summary`, `rationale`, `angle` | What it is, why now, and how to approach it differently |
| `details` (JSON) | What acting on it looks like: channels, content ideas, timing, and the competitor that inspired it |
| `source` | `ADVISOR`, `TRENDS`, `COMPETITORS`, `MEMORY`, `ANALYTICS` or `MANUAL` |
| `detectedBy` | The model or rule that produced it (e.g. `deterministic`, or a model id) |
| `priority`, `priorityScore` | `LOW`, `MEDIUM`, `HIGH` or `URGENT`, plus a 0–100 score for ordering |
| `confidence`, `confidenceReason` | `LOW`, `MEDIUM` or `HIGH`, and why |
| `detectedAt`, `lastSeenAt` | First detected; last seen again by a detector |
| `relevantUntil`, `expiredAt` | Its relevance window, and when it actually expired |
| `statusChangedAt`, `reviewedAt`, `recommendedAt`, `decidedAt`, `decidedById`, `decisionNote` | Lifecycle timestamps; who decided and why |
| `contextRevision`, `contextFingerprint`, `contextFields` | Link to the Business Context: the version it was detected against, the snapshot it used, and the business facts it relies on |
| `dedupeKey` | Unique per workspace, so detecting the same opportunity again updates it instead of duplicating it |

### `OpportunitySignal`: the evidence

| Field | Meaning |
| --- | --- |
| `kind` | The signal record type: `COMPETITOR_SNAPSHOT`, `TREND_ITEM`, `MEMORY_INSIGHT`, `CONTENT_DRAFT`, `ANALYTICS_REPORT`, `KNOWLEDGE_CHUNK`, `LEAD_SIGNAL`, `BUSINESS_CONTEXT`, or `EXTERNAL` |
| `refId` | The record's id in its table. A trend item is `<digestId>:<itemId>`. Null only when no single record applies, e.g. a summary of several drafts or an external link |
| `label`, `detail`, `url`, `observedAt` | The observation itself |
| `fingerprint` | Unique per opportunity, so the same evidence is never stored twice |

`opportunitiesForSignal(kind, refId)` goes the other way: from a signal record
to every opportunity it supports.

### `OpportunityEvent`: the lifecycle history

Every status change, with `fromStatus`, `toStatus`, `actorId` (null for the
system, e.g. expiry) and a `note`.

---

## Types

| Type | Default relevance |
| --- | --- |
| Trending topic | 14 days |
| Competitor move | 30 days |
| Seasonal moment | 30 days, or the event date the detector supplies |
| Content gap, What is working, Other | 60 days |
| Competitive gap | 90 days |
| Audience segment, Channel | 120 days |

A detector can pass its own `relevantUntil`.

## Lifecycle

```
DETECTED ─► REVIEWED ─► RECOMMENDED ─► ACCEPTED
    │           │            │
    └───────────┴────────────┴──► REJECTED ─► (reopen) REVIEWED
    └───────────┴────────────┴──► EXPIRED     (relevance window passed)
```

- **Skipping ahead is allowed.** A person can accept straight from DETECTED; the
  history records what happened.
- **Final states:** ACCEPTED, and EXPIRED. An expired opportunity comes back
  only by being **detected again with fresh evidence**, which reopens it as
  DETECTED.
- **Disallowed transitions** are refused with 409.
- **Concurrent changes:** status changes are compare-and-swap, so of two
  simultaneous decisions exactly one wins and the other gets a 409.
- **Expiry:** `expireOpportunities` expires open opportunities past their
  window. It runs whenever the advisor runs and before every list, so a stale
  opportunity is never shown as open.

## Evidence, confidence and priority

- **Evidence is required.** An opportunity with no evidence is refused.
- **Confidence comes from the evidence, never from the detector's say-so:**
  - one piece of evidence → LOW
  - two or more → MEDIUM
  - three or more from at least two kinds of signal → HIGH
  - It is also capped by the detector's own rating.
  - It is capped at **MEDIUM** when the opportunity relies on business facts
    that are unconfirmed, stale or missing (§9 of
    [BUSINESS-CONTEXT-MODEL.md](BUSINESS-CONTEXT-MODEL.md)). An opportunity
    aimed at a guessed audience is itself a guess.
- **Priority** comes from impact, effort and confidence. **URGENT** means worth
  doing *and* closing within 7 days.

## Re-detection

| Existing status | Detected again |
| --- | --- |
| none | Created as DETECTED, with its evidence and a history entry |
| DETECTED / REVIEWED / RECOMMENDED | New evidence added; confidence and priority recalculated over all evidence; relevance window extended |
| EXPIRED | Reopened as DETECTED with the new evidence; the history records why |
| ACCEPTED / REJECTED | Left alone: a re-detection never overrides a person's decision |

## Detectors

**The advisor** stores every opportunity it generates. Each piece of its
evidence now carries the record it came from: competitor snapshot id, trend
digest and item id, or memory insight id. Each report item records its
`opportunityId`.

Storing is best-effort: a failure is logged and never stops the advisor.
Competitive *gaps* in the advisor report are not stored yet, because they have
no evidence references to link.

## Relationship with Recommendations

Opportunities are stored and tracked without any recommendation existing. A
`Recommendation` references the opportunity it answers (`opportunityId`),
carries its evidence forward, and keeps the two statuses in step. See
[OPPORTUNITY-RECOMMENDATION.md](OPPORTUNITY-RECOMMENDATION.md).
