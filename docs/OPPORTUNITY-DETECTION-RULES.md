# Opportunity Detection Rules

How Aura decides whether a set of signals amounts to a real business
opportunity.

**Approach:** deterministic rules first, and AI only where interpretation is
actually required. Each rule is plain logic over the normalised signal store
([SIGNAL-AGGREGATION.md](SIGNAL-AGGREGATION.md)), is a pure function, and is
tested on its own. Every candidate a rule produces then passes the engine's
shared gates, which no rule can bypass.

| Piece | Where |
| --- | --- |
| Rules, thresholds and gates | [`lib/opportunity-detection.ts`](../lib/opportunity-detection.ts) (pure) |
| Priority cap for low confidence | `derivePriority` in [`lib/opportunities.ts`](../lib/opportunities.ts) |
| Running against a workspace | [`server/opportunities/detection.service.ts`](../server/opportunities/detection.service.ts) |
| Trigger | Every advisor run (after signal collection); `POST /api/opportunities/detect` |
| Tests | [`tests/opportunity-detection.test.ts`](../tests/opportunity-detection.test.ts) (each rule and gate on its own); `pnpm verify:detection` against a real database |

---

## 1. Initial categories and rules

| Rule | Category | Fires when | Minimum evidence | Impact / effort | One opportunity per |
| --- | --- | --- | --- | --- | --- |
| `competitor-move` | Competitor move | A tracked competitor changed its pricing or homepage, or shipped a release | **One HIGH-reliability change** seen directly on their site or GitHub, in the last 30 days. News and "current positioning" don't count. | Pricing: high / low. Otherwise: medium / low | Competitor, per month |
| `trending-topic` | Trending topic | Current stories match a topic the business follows (its market keywords or its industry) | **Two different stories** on the same topic in 14 days, **or one story seen in two or more places**; and at least one story MEDIUM reliability or better | High if the topic matches a running campaign theme, else medium / low | Topic, per ISO week |
| `proven-pattern` | What is working | A pattern learned from the business's own results | **One learned pattern of MEDIUM reliability or better** (enough results behind it), or one the user confirmed | Medium / low | Pattern |
| `results-shift` | What is working | A results metric moved ≥ 25% (and ≥ 3) between the last two periods | **One HIGH-reliability analytics movement.** A single period never qualifies. | Drop: high; jump: medium / medium | Metric, direction and report |
| `unconnected-channel` | Channel | The business publishes on a channel that isn't connected | The business stated the channel, and it has no connection | Low / low | Channel |

### Left to AI (interpretation required)

These need comparing *meaning*, not matching keys, so no rule attempts them:
- **Content gap:** what competitors talk about that the business hasn't
  covered.
- **Competitive gap:** a theme competitors keep returning to across unrelated
  signals.
- **Audience segment:** who is engaging, and why.

AI-assisted detection handles them
([AI-OPPORTUNITY-DETECTION.md](AI-OPPORTUNITY-DETECTION.md)). Its output is
validated against the signals it cites before anything is stored, and then
gets the same evidence, confidence, priority, duplicate and expiry treatment as
rule-detected opportunities. The rules themselves never call a model; titles
and angles come from templates.

## 2. Minimum evidence (all rules)

- **At least one current signal.** Expired signals never reach the rules.
- **Each rule's own minimum,** in the table above.
- **Low-reliability evidence alone never creates an opportunity** in a rule
  where reliability varies. For example, two Reddit threads on a topic are not
  a trend.

## 3. Confidence thresholds

Confidence comes from how **reliable** the evidence is, not just how much of it
there is:

| Confidence | Evidence |
| --- | --- |
| **HIGH** | Two or more distinct signals, at least one HIGH, none LOW |
| **MEDIUM** | At least one HIGH signal, or two or more MEDIUM-or-better |
| **LOW** | Anything less, including any amount of LOW-only evidence |

This is passed as the detector's claim. The stored confidence is the **lower**
of this, the evidence-count rule, and the business-context cap (an opportunity
that relies on unconfirmed business information can't be HIGH). The reason is
stored with it.

## 4. Priority rules

Priority comes from impact, effort, confidence and how soon the opportunity
closes (`LOW`, `MEDIUM`, `HIGH` or `URGENT`, plus a 0–100 score).

- **LOW confidence is capped at MEDIUM priority**, whatever the claimed impact.
  It can never be HIGH or URGENT. Before this rule, a low-confidence
  opportunity with high impact and low effort scored 83, which is HIGH. The cap
  applies to every detector, including the AI advisor.
- **URGENT** needs MEDIUM-or-better confidence, a worthwhile score, and closing
  within 7 days.
- A trending topic that matches a **running campaign theme** is rated high
  impact.

## 5. Duplicate handling

At three levels:

1. **Per rule:** a `dedupeKey` with a time bucket (above), so the same
   opportunity in the same period is one record. Detecting it again adds
   evidence and recalculates confidence and priority instead of creating a new
   one.
2. **Within a run:** two candidates of the same type that share any evidence
   are one opportunity. The more specific one (a business keyword before the
   broad industry) keeps all the evidence; the other is reported as a
   `duplicate`. Found in testing: the same two stories matched both "specialty
   coffee" and "Coffee".
3. **Across detectors:** an open opportunity of the same type that already cites
   one of the same records (e.g. one the AI advisor found) absorbs the new
   evidence instead of a second opportunity being created.

## 6. Expiration

Each opportunity is relevant until its newest evidence expires, or the rule's
default window if none:

| Rule | Default window |
| --- | --- |
| Competitor move | 30 days |
| Trending topic | 14 days |
| Proven pattern | 60 days |
| Results shift | 30 days |
| Unconnected channel | No expiry |

Past that, open opportunities expire automatically
([OPPORTUNITY-MODEL.md](OPPORTUNITY-MODEL.md)).

## 7. False-positive handling

| Guard | Effect |
| --- | --- |
| **Relevance** | A trending topic must relate to the business (its keywords or industry); unrelated stories are suppressed as `not-relevant`. Competitor, results, memory and business signals are about the business by construction. |
| **Stale evidence** | Expired signals are never used. |
| **No repeat of a rejection** | Signals used as evidence in an opportunity the business **rejected** are not proposed again (`already-rejected`). New evidence on the same theme still can be. A rejected opportunity is never reopened by re-detection. |
| **Rule muting** | A rule with **3 or more rejections and no acceptances in 60 days** is muted for 30 days from its latest rejection (`rule-muted`). One acceptance shows the rule isn't noise and lifts it. |
| **Transparency** | Every run reports what each rule recorded and what was suppressed, with the reason (`not-relevant`, `insufficient-evidence`, `already-rejected`, `rule-muted`, `duplicate`). |

## Testing

- **Each rule on its own:** each rule is a pure function with its own tests,
  showing when it fires and when it doesn't.
- **Each gate on its own:** confidence thresholds, the low-confidence priority
  cap, relevance, expiry, rejection suppression, muting and in-run de-duplication.
- **`pnpm verify:detection`:** seeds a throwaway workspace with signals for every
  rule and runs collect → detect → record end to end, checking:
  - every rule fires
  - low-reliability chatter is ignored
  - no LOW-confidence opportunity is HIGH or URGENT
  - a second run creates nothing new
  - a rejected topic isn't proposed again
  - a competitor move already found by the AI advisor is merged into, not
    duplicated
