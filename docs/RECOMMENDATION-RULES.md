# Recommendation Rules & Guardrails

What Aura can and cannot recommend. **A recommendation is never made just
because a model produced one.** It is made because an opportunity passed
these rules. Every rule is plain logic, stated as data in
[`lib/recommendation-rules.ts`](../lib/recommendation-rules.ts), enforced by
the engine ([RECOMMENDATION-ENGINE.md](RECOMMENDATION-ENGINE.md)) and tested on
its own.

| Piece | Where |
| --- | --- |
| The rules (pure) | [`lib/recommendation-rules.ts`](../lib/recommendation-rules.ts) |
| Enforcement | [`server/recommendations/engine.service.ts`](../server/recommendations/engine.service.ts), [`recommendation.service.ts`](../server/recommendations/recommendation.service.ts) |
| Tests | [`tests/recommendation-rules.test.ts`](../tests/recommendation-rules.test.ts) (each rule on its own); `pnpm verify:guardrails` (through the real engine and database) |

Every recommendation now carries three guardrail fields:
- **`executable`:** whether it may be acted on
- **`blockers`:** why not, if not
- **`flags`:** what it rests on that is uncertain, or what it conflicts with

A blocked recommendation is **advice, not a task**. It is shown, but it can't
be started or completed, and its execution brief leads to review, not to the
work.

---

## 1. Eligibility

An opportunity can be recommended only if:
- it is open (detected, reviewed or recommended)
- its relevance window hasn't passed
- it has at least one piece of current evidence
- it has no recommendation already in play
- the business is within the frequency limits (section 5)

These are checked **before any work is done**, including any model call.

## 2. Minimum evidence

Current evidence, counted from the opportunity's evidence and never from the
model's word:

| Recommendation type | Needs |
| --- | --- |
| Content, audience, other | 1 current signal |
| Campaign (a series) | **2** current signals: a series is a bigger bet than one post |
| Competitive response | 1 current signal **from a tracked competitor** |
| Channel | The business's own statement that it uses the channel |
| Optimisation | 1 current signal **from the business's own results or learned patterns** |

An action whose type isn't met is set aside, with the reason. The next
supported action is used instead, if there is one.

## 3. Confidence thresholds and low-confidence behaviour

| Confidence | Result |
| --- | --- |
| **High, Medium** | Executable recommendation |
| **Low** | **Advisory.** Stored and shown, flagged "low confidence — review the evidence before acting on it", priority capped (never high or urgent), and **not executable** until a person accepts it. Accepting it is the review; it then becomes executable, unless another blocker remains. |

Confidence is never above the opportunity's. It is capped at medium when the
recommendation rests on anything unconfirmed: an assumed audience,
unconfirmed or out-of-date business information, or business context that
changed since detection.

## 4. Priority

Priority is calculated from four inputs:
- **Impact:** the opportunity's (low, medium or high)
- **Effort:** of the **chosen action** (a post is low, a series medium)
- **Confidence:** the recommendation's
- **Time left:** before its relevance date

The formula weights impact most, then low effort, then confidence. It gives a
0–100 score: **High** at 66 or more, **Medium** at 33 or more, otherwise
**Low**. **Urgent** needs at least medium confidence, a score of 50 or more,
and 7 or fewer days left. **Low confidence caps the score at 65**, so it can
never be high or urgent. The reason is stored with every recommendation (e.g.
"high impact, low effort (one post), high confidence, 12 day(s) left").

That is the recommendation's own priority. Which recommendations to
**surface first** is decided separately, on every read, by
[RECOMMENDATION-PRIORITIZATION.md](RECOMMENDATION-PRIORITIZATION.md).

## 5. Frequency limits

| Limit | Value |
| --- | --- |
| New recommendations per workspace | **10** per rolling 24 hours |
| Waiting for a decision at once | **15** |
| Recommendations for one channel | **5** per rolling 7 days |

Over a limit, generation is refused with the reason, and nothing is stored.

## 6. Duplicates and repetition

- **Per opportunity:** only one recommendation in play.
- **Across opportunities:** a recommendation with the same type and channel
  and a near-identical title is refused as a **duplicate** if a similar one is
  in play or was made in the last **14 days**, or was **rejected** in the last
  **30 days**. "Near-identical" means 60% or more of the meaningful title
  words in common, ignoring filler words and word endings, so "prices are
  climbing" matches "prices climb".
- **Repetition:** the same action on the same channel rejected **3 times in
  30 days**, with none accepted, is **muted**. It isn't proposed again; the
  next supported action is used instead. One acceptance lifts the mute.

## 7. Unsupported channels

| Channel status | Result |
| --- | --- |
| The business doesn't use it | **Not executable** (blocked). The engine never chooses it; a person's edit to it is stored as advice. |
| Used, and connected | Executable; Aura can publish and measure it |
| Used, connectable, not connected | Executable; drafted in Aura, publish after connecting |
| Used, with no Aura integration | Executable as a draft; the business publishes by hand |

The execution brief states which: `publishing: 'aura' | 'manual'`.

## 8. Unavailable integrations

Which integration publishes to each channel:

| Channel | Integration | Available |
| --- | --- | --- |
| LinkedIn | LinkedIn | Yes |
| Instagram | Meta | Yes |
| X | X | Not yet |
| YouTube | YouTube | Not yet |
| Blog | WordPress | Not yet |
| Newsletter | None (Mailchimp only reads data) | No |

**"Connect this channel" is recommended only for a channel Aura can actually
connect.** This closes a real gap: the engine could previously recommend
connecting YouTube, which is impossible today.

## 9. Expiration

- A recommendation is relevant until its opportunity's window closes, and
  **never more than 30 days** after it was made.
- A recommendation still waiting for a decision expires after that.
  Accepted and in-progress ones are commitments and don't expire.
- An opportunity that expires expires its open recommendation.

## 10. Conflicting recommendations

Two recommendations in play conflict when they:
- **rest on the same evidence with different actions**, or
- **both answer the same competitor**.

Neither is dropped, since both may be worth doing. **Each is flagged with the
other**, and the higher-priority one is marked "this one goes first".

---

## Acceptance

| Criterion | How |
| --- | --- |
| Aura only generates recommendations that meet defined requirements | Eligibility, minimum evidence, frequency and duplicate rules are checked by the engine before storing. A failing recommendation is refused with the reason, and the refusal is in the audit log. |
| Unsupported actions are not recommended as executable actions | Unused channels, unavailable integrations and low confidence → `executable: false` with blockers. Blocked recommendations can't be started or completed, and their execution brief leads to review. |
| Duplicate/repetitive recommendations are controlled | One in play per opportunity · cross-opportunity duplicates refused · repeated rejections muted · per-channel and daily limits |
| Low-confidence recommendations are appropriately flagged | Flagged, priority capped, advisory until a person accepts |
