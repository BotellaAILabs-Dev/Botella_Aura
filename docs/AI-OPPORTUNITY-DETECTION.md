# AI-Assisted Opportunity Detection

Some opportunities need *interpretation*, not rules. For example: a theme
competitors keep returning to, a topic the business has never covered, or a
group of people engaging for a reason no single signal states. Aura uses AI to
find these, and then holds every AI answer to the same standard as a rule. The
model may **interpret** the evidence; it may never **assert** facts of its own.

| Piece | Where |
| --- | --- |
| Prompt, output schema, validation (pure) | [`lib/ai-opportunity-detection.ts`](../lib/ai-opportunity-detection.ts) |
| Running it for a workspace, storing, fallback | [`server/opportunities/ai-detection.service.ts`](../server/opportunities/ai-detection.service.ts) |
| Trigger | Every advisor run (after the rules); `POST /api/opportunities/detect` (`?ai=0` runs the rules only) |
| Tests | [`tests/ai-opportunity-detection.test.ts`](../tests/ai-opportunity-detection.test.ts) (each check on its own); `pnpm verify:ai-detection` against a real database |

Deterministic rules come first ([OPPORTUNITY-DETECTION-RULES.md](OPPORTUNITY-DETECTION-RULES.md)).
AI only adds to what they find. It never edits or replaces their results.

---

## 1. Categories

Only the categories the rules cannot judge:

| Category | Minimum evidence (checked against the cited signals) |
| --- | --- |
| `CONTENT_GAP` | At least **1** competitor or market signal |
| `COMPETITIVE_GAP` | At least **2** competitor or market signals: a theme, not one move |
| `AUDIENCE_SEGMENT` | At least **1** signal from the business's own results or learned patterns |

Anything else the model returns, such as a trending topic, is rejected
(`type-not-allowed`). The rules already cover those categories.

## 2. Input

- **Business Context Snapshot**, opportunity view
  ([CONTEXT-SNAPSHOT](../lib/business-context-snapshot.ts)):
  - confirmed, current facts only
  - unconfirmed facts are labelled as assumptions
  - missing information is listed as gaps
- **Fact keys:** the only business facts the model may rely on, e.g.
  `identity.description`. Unconfirmed keys are marked `ASSUMPTION`.
- **Relevant normalised signals** (up to 40):
  - current signals only
  - market stories must relate to the business
  - signals that were evidence in a rejected opportunity are left out
  - most reliable and most recent first
  - each is given a short reference (`S1`, `S2`…), so citations can be
    checked mechanically

## 3. Required output

Structured JSON. Each opportunity must contain:

| Field | Required |
| --- | --- |
| `type`, `title`, `summary`, `angle` | What the opportunity is |
| `reasoning` | Why the evidence adds up to it |
| `evidence[]` | `{ signal: "S3", supports: "how it supports this" }`, at least one |
| `businessFacts[]` | The fact keys it relies on |
| `assumptions[]` | Anything it had to assume; must be empty to be accepted |
| `confidence`, `confidenceReason` | `LOW` / `MEDIUM` / `HIGH`, and why |
| `impact`, `effort` | `low` / `medium` / `high` |

The model is told that an empty list is a valid answer, and to prefer
proposing nothing over assuming.

## 4. Validation

Every opportunity is checked on its own, deterministically. One that fails any
check is **rejected with its reasons and never stored**. The others in the same
response are unaffected.

| Check | Rejection code |
| --- | --- |
| Matches the schema, including confidence | `invalid-shape` |
| One of the AI categories | `type-not-allowed` |
| Every cited reference is a signal that was supplied | `unknown-signal` |
| Enough cited signals of the kind the category needs | `insufficient-evidence` |
| Every business fact relied on exists in the context | `unknown-business-fact` |
| No declared assumptions | `declared-assumption` |
| Every figure it states appears in a cited signal or the context | `unsupported-number` |
| Not the same category over the same evidence as one already accepted | `duplicate` |
| At most 5 per run | `over-limit` |

**No unsupported business facts:** the model can only rely on facts by key, and
an unknown key is rejected. A figure is the commonest way an invented fact gets
in ("40% of your buyers…"), so any percentage, amount of money, or number of 10
or more must appear in its sources. Small counts and the current year are
allowed.

## 5. Confidence

Confidence is captured three ways and stored with the opportunity:
- the model's claim
- what the cited signals' reliability supports (the same thresholds as the
  rules)
- the value kept, which is the **lower** of the two

The stored value is then also subject to the evidence-count and
unconfirmed-context caps that every opportunity gets. When the model's claim is
lowered, a warning is recorded. Low-confidence AI opportunities are capped at
MEDIUM priority, like any other.

## 6. Storage

AI opportunities are stored as `Opportunity` rows with source `AI_DETECTION`
and `detectedBy: ai:<model>`, **separately from the signals**:
- **Evidence:** links to the cited signals (`signalId`). It is the signal's own
  text, not the model's paraphrase.
- **Signals:** the AI never modifies them.
- **`details.ai`:**
  - the model and prompt version
  - the snapshot fingerprint
  - confidence (claimed, evidence-based, kept)
  - for each cited signal, how the model said it supports the opportunity
  - the facts relied on, including any assumed ones
  - warnings
- **Duplicates:** an open opportunity of the same type that cites the same
  record (found by a rule, the advisor, or an earlier AI run) receives the new
  evidence instead of a second opportunity being created.

## 7. Fallback

| Status | When | What happens |
| --- | --- | --- |
| `skipped` | No AI provider, or fewer than 2 relevant signals | The model is not called; rule results stand |
| `failed` | Provider error, or a response that isn't the required JSON even after one corrective retry | Nothing stored; rule results stand |
| `rejected` | The response parsed, but every opportunity failed validation | Nothing stored |
| `partial` | Some valid, some not | The valid ones are stored; the rest are rejected |
| `ok` | Everything returned was valid, including "nothing to propose" | Stored |

Every run that calls the model is written to the audit log
(`OPPORTUNITY_AI_DETECTION_RUN`) with:
- its status and model
- the snapshot fingerprint
- the number of signals sent
- each rejected opportunity with its reasons

This makes invalid output reviewable instead of silently dropped. AI detection
failing never fails the advisor or the detect request.

## Testing

- **`tests/ai-opportunity-detection.test.ts`:**
  - the prompt contents
  - signal selection
  - each validation check on its own
  - confidence capping
  - the low-confidence priority cap
  - the stored shape
- **`pnpm verify:ai-detection`:** runs the service against a real database with
  a scripted stand-in for the model, checking:
  - a mixed response stores only the valid opportunity
  - each invalid one is rejected for the right reason and flagged in the audit
    log
  - evidence links to the signals, and the signals are untouched
  - a reworded repeat merges instead of duplicating
  - broken output, provider errors and all-invalid responses store nothing
  - the model isn't called when there is nothing to interpret
