# What Matters Now

The first section of Aura Home ([AURA-HOME.md](AURA-HOME.md)). It is a short
summary of the current business situation, built only from what Aura has
actually recorded:
- **active, high-relevance opportunities** (the Opportunity model), and
- **important changes** among current signals that no opportunity already
  covers.

| Piece | Where |
| --- | --- |
| Rules: selection, why it matters, states, gaps (pure) | [`lib/what-matters.ts`](../lib/what-matters.ts) |
| Loading from Opportunity, Signal, Recommendation | [`server/home/what-matters.service.ts`](../server/home/what-matters.service.ts) |
| Section | `WhatMattersNow` in [`components/dashboard/home/home-sections.tsx`](../components/dashboard/home/home-sections.tsx) |
| Tests | [`tests/what-matters.test.ts`](../tests/what-matters.test.ts); `pnpm verify:what-matters` (a real workspace through every state) |

---

## What it shows

```
● What matters now                                   [Based on limited information]
  1 opportunity worth acting on (1 closing soon) and 2 changes to know about.

  [Opportunity] [Closes in 3 days]  Competitor move · spotted 2 days ago
  Respond to Acme Coffee’s pricing change
  Why it matters: Acme Coffee made a change to its pricing, seen directly on its site.
  Strong evidence · Open the opportunity · ✦ See Aura’s suggestion

  [Change]  Your results · yesterday
  Total engagement down 40%
  Why it matters: Total engagement went from 500 to 300 between the last two
  periods. Worth finding out why before it goes further.
  Strong evidence · See where this came from

  Based on 14 current signals from market trends, competitors and your results, last checked today.

  Waiting on you: [2 posts to approve · Review →] [Next step on “…” · Create content →]
```

Each item shows:
- **What is happening:** the record's own title, never reworded into a claim.
- **Why it matters:** for an opportunity, the detector's reasoning. For a
  change, the signal's own summary plus one plain line on why that kind of
  change matters. Every figure comes from the record.
- **Source and age:** "Competitors · 3 days ago", "Trending topic · spotted
  2 days ago".
- **Confidence in words:** Strong evidence · Good evidence · Early sign
  (limited evidence), with weak items marked and listed last.
- **Urgency**, when the opportunity closes within two weeks.
- **The underlying record (`ref`)**, and a link to it: the opportunity, or
  the page the signal came from.
- **The related recommendation:** "See Aura’s suggestion" when one is
  waiting, "You said yes, see the next step" when accepted, or "Ask Aura
  for a suggestion" on an opportunity that has none.

## Selection

| | Included when | Limit |
| --- | --- | --- |
| **Opportunities** | Active (detected, reviewed or recommended) and high-relevance: high or urgent priority, a priority score of 60 or more, or closing within 7 days | 3, ordered by confidence, then closing soonest, then priority |
| **Changes** | Current (not expired, seen in the last 14 days), and an actual change: a competitor's pricing, homepage, release or news (not its standing positioning); a results metric that moved between two periods; or a market trend that is corroborated, reliable, or related to what the business follows | Fill the section to 5 in total, most reliable and strongest first |

A signal an opportunity already covers is not shown again. Facts about the
business itself, learned patterns, and a single results period with nothing
to compare against are context, not news, so they never appear as changes.

## Not fabricating: states

| State | When | What it shows |
| --- | --- | --- |
| **Ready** | Something stands out, on enough data | The situation in one line, built from the items, and the items |
| **Limited** | Something stands out, but every item is an early sign, or most sources are missing | The items, marked as early. The summary says to check the evidence; what would help is listed |
| **Quiet** | Enough sources, nothing stands out | "Nothing stands out right now", what Aura looked at, and anything still missing ("Aura could say more with: …") |
| **Insufficient** | No current signals and no open opportunities, or too little data to call it quiet | "Aura doesn't have enough information yet", what is missing, and where to add it. **No items** |

"What is missing" comes from coverage:
- no topics followed in the market
- no competitors tracked
- fewer than two results periods (two are needed to see a change)
- no goals in the business profile

The line "Based on N current signals from …" always says what the picture
rests on.

## Waiting on you

The to-do items Home showed before (posts to approve, suggestions you said
yes to, posts to schedule, new leads, outreach to send) sit in a small strip
under the section, each with its action. They are work waiting on a person,
not the business situation.

## Acceptance criteria

| Criterion | How |
| --- | --- |
| User can understand the current business situation quickly | A one-line summary, then at most five items, each with what, why, how sure and when |
| Each item is connected to an underlying opportunity or signal | Every item carries `ref` (opportunity or signal id) and links to it. `verify:what-matters` checks every item against the database |
| No fabricated insights when there is insufficient data | Insufficient and quiet states show no items. Titles and figures come only from records. Weak evidence is labelled; what is missing is listed. Tested on empty, profile-only and real workspaces |
