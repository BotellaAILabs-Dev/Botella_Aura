# AI Reviewer / quality check

Before generated content enters the approval workflow, a separate review step
evaluates it, independently of the step that wrote it. The review produces a
structured result: **pass**, **needs human review** or **fail**. It never
changes the content.

| Part                             | Where                                                                    |
| -------------------------------- | ------------------------------------------------------------------------ |
| Rules, schema, thresholds (pure) | `lib/content-review.ts`                                                  |
| Running a review for a draft     | `server/content/review.service.ts` (`reviewDraft`, `ensureReview`)       |
| API                              | `GET` and `POST /api/content/drafts/:id/review`                          |
| Enforced                         | `transition` in `server/content/content.service.ts` (submit and approve) |
| Shown                            | the draft page's **Review** panel, a header badge, and a queue badge     |

## 1. When it runs

| Moment                                                                                 | What happens                                                                                                     |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A draft is generated (Content Studio, Autopilot, campaigns)                            | Reviewed straight away (trigger `generated`).                                                                    |
| A draft is rewritten (regenerate, shorten, tone… or "Regenerate with review feedback") | Reviewed again (`regenerated`).                                                                                  |
| A person clicks **Review again**                                                       | `manual`                                                                                                         |
| Submit for approval / approve                                                          | If the stored review is not of the body as it now stands, it is reviewed again first (`submitted` / `approval`). |

A manual edit, a variation switch or an undo changes the body, so the stored
review becomes **out of date**. The page says so, and the next submit or
approval reviews the piece again. A review is matched to its body by a
fingerprint (`bodyHash`).

If a review breaks while a draft is being generated, the draft is still saved,
and it is reviewed when it is submitted.

## 2. Reviewer input

The independent reviewer is a separate model call with **its own
instructions** (`REVIEWER_SYSTEM`). It never sees the writer's prompt or
system instructions. It is given:

- **The finished piece**, as a reader sees it, with its call to action and
  hashtags.
- **The format and channel**, and their length limits.
- **The business**: name, industry, what it does and what it sells.
- **The audience and goal.**
- **The brand voice**: summary, tone, phrases, topics to avoid.
- **The recommendation and Content Brief it was made from**: the action, key
  message, reason, expected outcome, call to action and evidence. If the piece
  wasn't made from a recommendation, the person's request instead.
- **Business facts the piece may use**: the knowledge it was written from, with
  personal data redacted.
- **Whether alcohol marketing rules apply.**

Alongside it, two deterministic checks run on the same body:

- **The rules** (`lib/content-quality.ts`): alcohol code, topics to avoid,
  length, hashtags, call to action, robotic phrasing.
- **The fact check** (`lib/fact-check.ts`).

## 3. Reviewer output schema

The model returns JSON (`reviewerOutputSchema`) with three parts:

- **`dimensions`**: a score from 1 to 5 for each dimension, with a reason.
- **`issues`**: each issue has a dimension, a severity (`blocker`, `major` or
  `minor`), the problem, a quote from the piece, and a suggested fix.
- **`summary`**: the reviewer's short verdict.

The schema has **no field for copy**, so a reviewer cannot hand back a rewrite.
Anything extra in its answer is dropped. A quote is kept only if those words
really appear in the piece.

The stored result (`ContentReview`, in `aiMetadata.review`) contains:

| Field                                                           | Meaning                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                                        | `pass`, `review_required` or `fail`                                                                                                                           |
| `score`                                                         | 0–100, weighted over the dimensions that were assessed                                                                                                        |
| `dimensions[]`                                                  | per dimension: score (0–100), verdict (`pass`, `review`, `fail`, `not_assessed`), a one-line summary, and who assessed it (`reviewer`, `rules`, `fact_check`) |
| `issues[]`                                                      | dimension, severity, message, quote, suggestion and source, blockers first                                                                                    |
| `failed[]`                                                      | the dimensions that failed — what must change                                                                                                                 |
| `humanReviewReasons[]`                                          | why a person must look                                                                                                                                        |
| `reviewer`                                                      | whether the model review ran, which model, and why not if it didn't                                                                                           |
| `bodyHash`, `reviewedAt`, `trigger`, `durationMs`, `thresholds` | which body was reviewed, when, why, and against which bar                                                                                                     |
| `acknowledgedBy`                                                | the approver who confirmed they looked, when one did                                                                                                          |

The last five earlier reviews are kept in `aiMetadata.reviewHistory`.

## 4. Dimensions

| Dimension                | Weight | Also checked by                                    |
| ------------------------ | ------ | -------------------------------------------------- |
| Relevance                | 1      | —                                                  |
| Accuracy                 | 1.5    | the fact check and the unsupported-claim rules     |
| Brand voice              | 1      | —                                                  |
| Audience fit             | 1      | —                                                  |
| Channel fit              | 0.75   | the length and hashtag rules                       |
| Clarity                  | 1      | the robotic-phrase and repetition rules (warnings) |
| Call to action           | 0.75   | the CTA rule, when the format or brief needs one   |
| Completeness             | 0.75   | schema, required parts, placeholder text           |
| Recommendation alignment | 1      | —                                                  |
| Compliance               | 1.5    | the alcohol code and topics to avoid               |

## 5. Quality thresholds

|                              |                               |
| ---------------------------- | ----------------------------- |
| A dimension **passes**       | at 75 or above (4–5 out of 5) |
| A dimension **needs review** | from 50 to 74 (3 out of 5)    |
| A dimension **fails**        | below 50 (1–2 out of 5)       |
| The overall score **passes** | at 70 or above                |
| The overall score **fails**  | below 50                      |

## 6. Pass, review required, fail

**Fail** — any of these:

- a dimension fails;
- a rule breach (`block`) is found;
- the fact check has a must-fix claim;
- a required part is missing;
- the overall score is below 50.

**Needs human review** — no failure, but any of these:

- a dimension needs review;
- a fact-check claim could not be verified;
- the independent reviewer did not run (quota, outage, or an unreadable
  answer);
- the reviewer skipped a dimension;
- the overall score is below 70.

**Pass** — everything else.

Two rules keep the review honest:

- **The model alone never fails a piece on legal or factual grounds.** If it
  scores Accuracy or Compliance low, or calls an issue there a blocker, the
  piece goes to **a person**. Only the rules and the fact check can fail those
  two dimensions.
- **A rule breach always fails**, whatever the model scored.

## 7. What each state allows

| Review             | Submit for approval                                             | Approve                                                                                                                                    |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Pass               | yes                                                             | yes                                                                                                                                        |
| Needs human review | yes, marked **Needs human review** on the page and in the queue | only when the approver ticks "I've looked at what the review marked for human review"; recorded as `acknowledgedBy` and in the audit entry |
| Fail               | **refused (409)**, naming the failed checks                     | refused                                                                                                                                    |

Every submit and approve audit entry records the review status, score, failed
dimensions, and whether the approver confirmed a human review.

## 8. Regeneration

When the review fails or needs a person, the panel offers **Regenerate with
review feedback** (`POST /refine` with `{ action: "fix_review" }`):

- The writer is given the review's issues, taken from the **stored review on
  the server**, not from the request.
- The previous version goes into the draft's history, so the rewrite can be
  undone.
- The new version is reviewed again automatically.

Regenerating is always a step the person chooses. The reviewer itself never
changes the piece.

## Checking it

```bash
pnpm test tests/content-review.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:review
```
