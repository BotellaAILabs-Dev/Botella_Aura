# Recommendation Lifecycle

What people do with Aura's recommendations, and how it is recorded. Every
action is persisted with **what** was done, **who** did it, **from where**,
**when**, and its **detail**. History is never rewritten, so Aura can tell
an accepted recommendation from an edited, skipped or rejected one, and
every move can be audited.

| Piece | Where |
| --- | --- |
| Statuses, moves, actions, edit diff, outcome (pure) | [`lib/recommendations.ts`](../lib/recommendations.ts) |
| Transitions, present, edit, history | [`server/recommendations/recommendation.service.ts`](../server/recommendations/recommendation.service.ts) |
| Schema | `Recommendation` (`presentedAt`, `decidedAt`, `editedAt`, …) · `RecommendationEvent` (`action`, `source`, `metadata`) in [`prisma/schema.prisma`](../prisma/schema.prisma) |
| Migration | [`20261011090000_recommendation_lifecycle`](../prisma/migrations/20261011090000_recommendation_lifecycle/migration.sql) |
| Tests | [`tests/recommendation-lifecycle.test.ts`](../tests/recommendation-lifecycle.test.ts); `pnpm verify:lifecycle` against a real database |

---

## 1. Statuses

```
GENERATED ─► PRESENTED ─► ACCEPTED ─┬─► IN_PROGRESS ─► COMPLETED
    │             │                  └──────────────────► COMPLETED
    │             ├──────► EDITED ───┘  (accepted with changes; can be edited again)
    │             ├──────► SKIPPED      "not now" (no negative signal beyond a small one)
    │             └──────► REJECTED     "no" (lowers similar recommendations)
    └─ any decision can also be made on one never formally presented

GENERATED · PRESENTED · ACCEPTED · EDITED · IN_PROGRESS ─► WITHDRAWN
GENERATED · PRESENTED ─► EXPIRED   (relevance window passed undecided)
```

| Status | Meaning | Stamped |
| --- | --- | --- |
| `GENERATED` | Made by the engine (or a person); nobody has seen it yet | `createdAt` |
| `PRESENTED` | Shown to a person who can act on it | `presentedAt` (first time only) |
| `ACCEPTED` | Yes, as is | `decidedAt`, `decidedById`, `decisionNote` |
| `EDITED` | Yes, with changes; each change is in its history | `decidedAt`, `decidedById`, `editedAt` |
| `SKIPPED` | Passed over: not now, not a no | `decidedAt`, `decidedById`, `decisionNote` |
| `REJECTED` | No | `decidedAt`, `decidedById`, `decisionNote` |
| `IN_PROGRESS` | Being carried out | `startedAt` |
| `COMPLETED` | Done | `completedAt` |
| `WITHDRAWN` | Taken back or replaced | `decidedAt`, `decidedById` |
| `EXPIRED` | Its window passed before a decision | `expiredAt` |

- **Final:** skipped, rejected, completed, withdrawn and expired. A new
  recommendation is made instead, so each one's history stays what it was.
- **Not reversible:** an accepted recommendation cannot become rejected or
  skipped (withdraw it instead), and a rejected one cannot be accepted.
- **Execution** states beyond `IN_PROGRESS` arrive in Sprint 10.
- **Existing data:** the migration renames `PROPOSED` → `GENERATED` in place
  and backfills every existing history entry's action and source.

## 2. Actions — the history

Every move is one `RecommendationEvent`, never edited or deleted:

| Field | |
| --- | --- |
| `action` | `generate` · `present` · `accept` · `edit` · `skip` · `reject` · `start` · `complete` · `withdraw` · `expire` · `defer` ("Not now", which keeps the status) |
| `fromStatus` → `toStatus` | The move |
| `source` | `user` (a person) · `engine` (Aura made it) · `system` (expiry) · `opportunity` (a decision made on its opportunity, carried over) |
| `actorId` | The person, if any |
| `note` | Why, if given |
| `metadata` | Detail. For an **edit**, each changed field `{ from, to }`, so the original is never lost. For a **presentation**, where it was shown (`surface`) and its `rank`, `score` and `band`. For a **deferral**, until when |
| `createdAt` | When |

**Telling outcomes apart:** `recommendationOutcome(history)` gives
`accepted` · `edited` · `skipped` · `rejected` · `withdrawn` · `expired` ·
`undecided`. It looks at the first decision, and an edit means "accepted with
changes" even after a plain accept. Ranking uses the same distinction: a
similar rejection counts **−8**, a similar skip **−3**, and an accept or edit
**+6** ([RECOMMENDATION-PRIORITIZATION.md](RECOMMENDATION-PRIORITIZATION.md)).

## 3. Duplicate transitions are prevented

| Situation | Result |
| --- | --- |
| The same move again (a double click, a retried request) | No-op: `changed: false`, **no** history entry |
| Presenting one already presented | No-op; it is recorded once, at first sight |
| An edit that changes nothing | No-op, with no history entry |
| A further edit that does change something | A new `edit` entry; both are kept |
| `expectedStatus` given, and it has moved since | **409** "changed since you opened it", nothing applied |
| A move the lifecycle doesn't allow | **409**, with the current status |
| Two decisions at the same moment | Compare-and-swap on the status: one wins, the other gets 409 or a no-op. It is recorded exactly once |

## 4. Kept in step with the opportunity

In the same transaction:

| Recommendation | Opportunity |
| --- | --- |
| generated | → Recommended |
| accepted, **edited** | → Accepted |
| rejected | → Rejected |
| presented, **skipped** | unchanged (it can be recommended again) |
| in progress, completed, withdrawn, expired | unchanged |

Accepting, rejecting or expiring an **opportunity** directly carries the
same decision onto its generated or presented recommendation, with
`source: opportunity`.

## 5. Edits

`PATCH /api/recommendations/:id { changes, note?, expectedStatus? }`

- Editable fields: `title`, `summary`, `action`, `steps`, `rationale`,
  `expectedOutcome`, `outcomeMetric`, `channel`, `contentType`, `audience`.
  Its evidence, opportunity link, confidence and priority are not editable.
- The edited recommendation is validated as a whole, so an edit cannot
  leave it invalid.
- Editing counts as the review that a low-confidence recommendation needs.
  The channel guardrails are applied again, so moving it to a channel the
  business doesn't use blocks execution again.

## 6. API

| | |
| --- | --- |
| `POST /api/recommendations/presented { ids, surface?, positions? }` | Marks recommendations as shown. Idempotent. A viewer's view isn't recorded |
| `POST /api/recommendations/:id/decision { decision, note?, expectedStatus? }` | Accept, skip, reject or withdraw |
| `POST /api/recommendations/:id/status { status, note?, expectedStatus? }` | Any move a person may make: accept, skip, reject, start, complete, withdraw. Presented, edited and expired are set by Aura or by an edit |
| `PATCH /api/recommendations/:id { changes, … }` | Edit |
| `GET /api/recommendations/:id/history` | The full history, oldest first, with who did each step, every timestamp, and the outcome |

Writes need `company:update` (owners and admins). Recording a presentation
needs `content:create`. Every route is scoped to the caller's own workspace;
the static guard in [`tests/data-access-security.test.ts`](../tests/data-access-security.test.ts)
checks each one.

## 7. Acceptance criteria

| Criterion | How |
| --- | --- |
| User actions are persisted | Every action is a `RecommendationEvent` with action, actor, source, time and detail, plus the stamps on the recommendation (`verify:lifecycle`) |
| History is retained | Events are only ever added; edits keep each field's `from → to`; final states are final |
| Aura can distinguish accepted, rejected, edited and skipped | Distinct statuses and actions, `recommendationOutcome`, and ranking weights per outcome |
| Transitions are predictable and auditable | One transition table; repeats are no-ops; stale and simultaneous actions are refused; every move is in the history with who and why |
