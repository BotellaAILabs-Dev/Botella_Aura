# Opportunity → Recommendation

The foundation the Sprint 8 recommendation engine builds on. **It is not the
engine:** nothing here decides *what* to recommend. It fixes how a
recommendation is connected to the opportunity it answers, so the engine can
consume opportunities without the data model changing underneath it.

- An **opportunity** is something Aura noticed
  ([OPPORTUNITY-MODEL.md](OPPORTUNITY-MODEL.md)).
- A **recommendation** is what Aura proposes the business *do* about it.

| Piece | Where |
| --- | --- |
| Hand-off contract, eligibility, status sync (pure) | [`lib/recommendation-handoff.ts`](../lib/recommendation-handoff.ts) |
| Creating and deciding recommendations | [`server/recommendations/recommendation.service.ts`](../server/recommendations/recommendation.service.ts) |
| Schema | `Recommendation`, `RecommendationEvidence` in [`prisma/schema.prisma`](../prisma/schema.prisma); migration `20261005090000_recommendation_foundation` |
| Tests | [`tests/recommendation-handoff.test.ts`](../tests/recommendation-handoff.test.ts); `pnpm verify:recommendation-handoff` against a real database |

---

## 1. Relationship

```
Opportunity 1 ──── * Recommendation 1 ──── * RecommendationEvidence
     │                                              │
     └── OpportunitySignal ◄── opportunitySignalId ─┤
              │                                     │
              └── Signal ◄────────── signalId ──────┘
```

- **A recommendation references its originating opportunity** with
  `Recommendation.opportunityId`.
- **An opportunity can have several recommendations over time**, but only
  **one open** (`PROPOSED`) at a time.
- **An opportunity never depends on a recommendation existing.** It is stored,
  reviewed and decided on its own.
- **Recommendations outlive their opportunity.** If an opportunity is deleted,
  its recommendations keep everything they were built from: the reference
  becomes `null` (`onDelete: SetNull`).

### Recommendation schema

| Field | Purpose |
| --- | --- |
| `opportunityId` | The opportunity it answers (nullable, see above) |
| `status` | `PROPOSED` → `ACCEPTED` / `REJECTED` / `WITHDRAWN` |
| `title`, `summary` | Start as the opportunity's own; can be overridden |
| `content` | **What to do. Written by the Sprint 8 engine;** `{}` until then |
| `confidence`, `confidenceReason`, `priority`, `priorityScore` | Handed over from the opportunity |
| `handoff`, `handoffVersion` | The exact hand-off it was built from (section 2), and its version |
| `contextRevision`, `contextFingerprint`, `contextFields` | The Business Context it was built against |
| `createdBy` | `user:<id>`, `rule:…`, or a model name |
| `decidedAt`, `decidedById`, `decisionNote` | Who decided, when and why |

Sprint 8 adds what the engine needs (actions, channels, schedule…) **by
adding columns or filling `content`**. Nothing above needs to change.

## 2. Data passed: the hand-off

`GET /api/opportunities/:id/handoff` returns `OpportunityHandoff` (version
`1`, validated by `opportunityHandoffSchema`):

| Part | Contents |
| --- | --- |
| `opportunity` | id, type, status, title, summary, rationale, angle, detector details (channels, content ideas, timing, rule criteria, AI reasoning), detected / last seen / relevant-until dates |
| `assessment` | confidence and its reason, priority and score, **impact and effort** |
| `evidence[]` | Every piece of evidence (section 4) |
| `context` | What business context the recommendation needs (section 3) |
| `provenance` | Source, what detected it, the rule id or the AI model and prompt version |

**Gap fixed:** impact and effort used to be calculated into priority and then
discarded, so a recommendation could not start from them. They are now stored
on the opportunity (`impact`, `effort`). For opportunities stored before this
change they are `null`, and the engine should treat them as unknown.

The hand-off is stored on the recommendation as it was at creation, so a
recommendation can always show what it was based on, even after the
opportunity changes.

## 3. Required context

| Field | Meaning |
| --- | --- |
| `snapshotView: "recommendation"` | The engine reads the business through `getContextSnapshot(companyId, { view: 'recommendation' })`, which has all sections. This is the same snapshot every AI workflow uses. |
| `fields` | The Business Context fields the opportunity relies on (e.g. `audience.stated`) |
| `shakyFields` | Of those, the ones that are **now** unconfirmed or out of date. The engine must not present a recommendation built on these as certain; it should ask the matching question first or say what it is assuming. |
| `revision`, `fingerprint` | The context the opportunity was detected against |
| `changedSinceDetection` | Whether the business context has changed since (null if not recorded) |

## 4. Evidence that carries forward

**All of it.** Each piece of the opportunity's evidence is **copied** into
`RecommendationEvidence` when the recommendation is created, rather than
shared, so later evidence changes on the opportunity don't silently change
what a recommendation was based on.

Each copy keeps:
- **Links:** `opportunitySignalId` to the opportunity's evidence row, and
  `signalId` to the normalised signal. Both are kept while they exist.
- **Content:** kind, record id, label, detail, URL and observed date.
- **Reliability:** the signal's reliability at hand-off time.

In the hand-off, each piece is also marked:
- **`current: false`** if its signal has expired or been pruned since detection
- **`supports`:** how the detector said it supports the opportunity (from AI
  detection)

## 5. Eligibility

An opportunity can become a recommendation only if:
- it is **open**: detected, reviewed, or already recommended
- its **relevance window hasn't passed**
- it has **at least one piece of current evidence**; a recommendation built
  only on expired signals would be recommending yesterday's opening
- it has **no other open recommendation**

The hand-off reports `eligibility: { eligible, reasons[] }`. Creating a
recommendation from an ineligible opportunity returns 409 with the reasons.

## 6. Keeping the two in step

One decision, recorded on both sides, in the same transaction:

| Event | Opportunity | Recommendation |
| --- | --- | --- |
| Recommendation created | → `RECOMMENDED` | `PROPOSED` |
| Recommendation accepted | → `ACCEPTED` | `ACCEPTED` |
| Recommendation rejected | → `REJECTED` | `REJECTED` |
| Recommendation withdrawn | unchanged; can be recommended again | `WITHDRAWN` |
| Opportunity accepted directly | `ACCEPTED` | open one → `ACCEPTED` |
| Opportunity rejected directly | `REJECTED` | open one → `REJECTED` |
| Opportunity expired | `EXPIRED` | open one → `WITHDRAWN` |

All opportunity moves still go through `transitionOpportunity`, so the
opportunity's history is complete. Decisions are compare-and-swap: a
recommendation is decided once, and a second attempt gets a 409.

The **Recommend** button on the Opportunities page now creates a
recommendation (instead of only changing the status), so every recommended
opportunity has one.

## 7. API and interfaces

| Endpoint | Purpose | Who |
| --- | --- | --- |
| `GET /api/opportunities/:id/handoff` | The hand-off and its eligibility: **the engine's input** | Any member |
| `GET /api/opportunities/:id/recommendations` | Recommendations made from an opportunity | Any member |
| `POST /api/opportunities/:id/recommendations` `{ title?, summary? }` | Create one (201; 409 if ineligible or one is open) | Owners and admins |
| `POST /api/recommendations/:id/decision` `{ decision, note? }` | `ACCEPTED`, `REJECTED` or `WITHDRAWN` (409 if already decided) | Owners and admins |
| `GET /api/opportunities/:id` | Now also lists its recommendations | Any member |

Service functions for the engine to call directly:
- `getOpportunityHandoff(companyId, opportunityId)`
- `createRecommendationFromOpportunity({ …, createdBy, content })`: the engine
  passes its own `createdBy` (model name) and `content`
- `decideRecommendation({ … })`
- `listRecommendations(companyId, { opportunityId })`

## Left for Sprint 8

- Deciding what to recommend: the engine reads the hand-off and the
  `recommendation` snapshot, and writes `content`.
- A Recommendations page in the app.
- Choosing which opportunities to turn into recommendations automatically, and
  when.
