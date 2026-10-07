# Aura Suggests

The first dedicated recommendation experience. Aura proactively says what it
believes the business should consider doing next, in plain language. It is
built on the recommendation model, engine, ranking and lifecycle that
already exist; nothing about recommendations is duplicated.

| Piece | Where |
| --- | --- |
| A recommendation as a person reads it (pure) | [`lib/aura-suggests.ts`](../lib/aura-suggests.ts) |
| Loading, in ranked order | [`server/recommendations/suggestions.service.ts`](../server/recommendations/suggestions.service.ts) |
| Cards, actions, edit form | [`components/dashboard/suggestions/aura-suggests.tsx`](../components/dashboard/suggestions/aura-suggests.tsx) |
| Page | `/dashboard/suggestions` (sidebar: **Aura Suggests**, under Home) |
| Home | The top 3 suggestions are the second section of Aura Home ([AURA-HOME.md](AURA-HOME.md)), with "See all" |
| Tests | [`tests/aura-suggests.test.ts`](../tests/aura-suggests.test.ts); `pnpm verify:suggestions` (the real pipeline, from signals to suggestions) |

---

## What each suggestion says

```
✦ Aura Suggests   [Top pick] [Best done within 5 days]

Promote your fall bourbon selection
Post a carousel of your fall bourbon picks on Instagram this week.
› How to do it (3 steps)

Why
Interest in bourbon-related products has increased and your recent
content has focused heavily on whiskey.
Why now: Relates to your current goal (“fall”) · It’s only relevant for 5 more days

Expected outcome                 Based on
Increase engagement around       • Trend signal
your fall selection.             • Recent content performance
                                 • Business goals
                                 Strong evidence
› See the evidence (2)

[Create content →] [Edit] [Skip] [⋯ Not now · Not for us]
```

| Part | From | Plain-language rules |
| --- | --- | --- |
| **What** | Title and action | Headlines are the opportunity's own wording, with no "Post about:" prefix. The format is in the action line |
| **Why** | Rationale | The engine's bookkeeping ("Based on 2 pieces of evidence: …") is removed, because the evidence is shown on its own. It is written to "you", not "the business", in full sentences |
| **Why now** | Ranking factors | Only the reasons a person cares about: goal match, time left, past decisions, corroboration. Never scores or points |
| **Expected outcome** | Expected outcome | As written |
| **Based on** | Evidence kinds and the business-profile fields used | Trend signal · Competitor activity · Recent content performance · What has worked for you before · Your recent content · Your business documents · Customer interest · Business goals · Your audience · What your business offers · The channels you use · Your brand voice |
| **Evidence** | Each piece, one click away | Shows its source, what it says, when it was seen ("3 days ago"), a link when there is one, and a "No longer current" marker |
| **Confidence** | Confidence | Strong evidence · Good evidence · Early signal, worth a look at the evidence first |
| **Next step** | Execution brief | Create content · Add to your plan · Connect *channel* · Look at the competitor · Update your business profile |

No enum names, scores, ids, codes or internal fields reach the page. The
tests scan every part of every kind of suggestion for them, and also prove
that the scan catches such text when it is present.

## Actions

| Button | Does | Lifecycle |
| --- | --- | --- |
| **Create content** (or the step that fits) | Says yes and opens Content Studio with the recommendation as the brief, or the plan, connections, … | → Accepted |
| **Edit** | Change what, what to do, steps, expected outcome or channel. Saving says yes with your changes; the original is kept in its history | → Edited |
| **Skip** | Not now and not a no. It leaves the list, its opportunity stays open, and similar suggestions rank slightly lower | → Skipped |
| ⋯ **Not now** | Hidden for a week, then it comes back and says so | (status unchanged; deferral recorded) |
| ⋯ **Not for us** | A no; fewer like it are suggested | → Rejected |

- **Seen:** showing a suggestion records it as *presented*, once, with
  where it was shown and its rank.
- **Duplicates:** every action sends the status the person was looking at,
  so a stale screen gets "this changed since you opened it" instead of a
  second decision. Pressing a button twice records it once
  ([RECOMMENDATION-LIFECYCLE.md](RECOMMENDATION-LIFECYCLE.md)).
- **When something must be fixed first** (for example, a channel the
  business doesn't use), the main button reads "See what’s needed" and
  leads there without saying yes. A low-confidence suggestion shows a word
  of caution; saying yes counts as the review it needs.
- **You said yes to:** accepted and edited suggestions stay below the
  list, with their next step one click away, until they are started.
- **Who can act:** owners and admins act on suggestions. Everyone else sees
  them, with a note saying who can act.

## Wording at the source

So that suggestions read well when they are first written, the engine and
detection were reworded:
- The engine's reasons are written to "you": "you publish on LinkedIn",
  "it relates to your current goal or campaign".
- Titles have no stacked prefixes, and a drop in results reads "Win back
  your total engagement".
- Detection notes are sentences: "Acme Coffee made a change to its pricing,
  seen directly on its site".

Recommendations stored before this change are tidied when shown.

## Acceptance criteria

| Criterion | How |
| --- | --- |
| Recommendation is understandable without technical context | Plain wording at the source and when shown. No codes, scores or ids, checked on every kind of suggestion and on the engine's real output (`verify:suggestions`) |
| User can understand why Aura suggested it | **Why** (the reasoning), **Why now** (what puts it near the top), confidence in words |
| Supporting evidence is accessible | **Based on** lists the kinds of evidence; **See the evidence** shows each piece with its source, date, link and whether it is still current |
| User has a clear next action | One main button named for what it does, plus Edit and Skip; Not now and Not for us under ⋯ |
