# Aura Home

The home page (`/dashboard`), refactored from a weekly-briefing dashboard into
a recommendation-led Home. It answers three questions, in order:

1. **What matters right now?**
2. **What does Aura suggest I do?**
3. **What happened recently?**

| Piece | Where |
| --- | --- |
| Rules: what matters now, active opportunities, results, activity (pure) | [`lib/aura-home.ts`](../lib/aura-home.ts) |
| Loading, live and in parallel | [`server/home/home.service.ts`](../server/home/home.service.ts) |
| Sections | [`components/dashboard/home/home-sections.tsx`](../components/dashboard/home/home-sections.tsx) |
| Page | [`app/dashboard/page.tsx`](../app/dashboard/page.tsx) |
| Tests | [`tests/aura-home.test.ts`](../tests/aura-home.test.ts); `pnpm verify:home` (a real workspace, end to end) |

---

## Review of the old dashboard

The home page was the **weekly briefing**. It was already ordered by work
rather than numbers, but every part of it was a snapshot taken once a week.

| Old element | Decision | Why |
| --- | --- | --- |
| Headline, summary, "Catch me up" | **Kept**, under "This week" | Aura's weekly report on its own work |
| Ready for you (posts Aura wrote) | **Kept**, under "This week" | Actionable |
| This week (content calendar) | **Kept**, under "This week" | Actionable |
| Competitor moves | **Kept**, under "This week" | Context, with "what it means" |
| What Aura could not do | **Kept** | Honest gaps |
| Setup checklist | **Kept** | It is the next action until setup is done |
| Needs you | **Replaced** by *Waiting on you*, under *What matters now* | It was a weekly count that could be up to 7 days stale. It is now live |
| What to do next | **Removed** | An older heuristic list that duplicated Aura Suggests. Recommendations now come from one place |
| Business insights | **Replaced** by *Results* | Bare numbers with no comparison (for example "Posts with a graphic 3/5"). Results now compare with last week |
| Go deeper links | **Kept** as *Everything else* | Every tool stays one click away |

The weekly briefing itself (service, emails, payload) is unchanged; only
what the Home page renders from it changed.

## Structure

```
Good to see you, Dana
Here’s what matters for Botella right now.

[Setup checklist — until setup is done]

● What matters now                  ← live: the situation, from real records
  1 opportunity worth acting on (1 closing soon) and 2 changes to know about.
  [Opportunity] Respond to Acme’s pricing change — why it matters ·
                Strong evidence · ✦ See Aura’s suggestion
  [Change]      Total engagement down 40% — why it matters
  Waiting on you: [2 posts to approve · Review →]

✦ Aura Suggests                      See all (5)
  [top 3 suggestions: what · why · expected outcome · based on · evidence
   · Create content / Edit / Skip]

Active opportunities  All (7)  │  Results — this week vs last   See what worked
  Trending topic · Closes in 3 days │  Posts published 3  ↑ Up 50%
  Join the conversation on …        │  Engagement 120     ↑ Up 20%
  Competitor move · Aura has a      │  Marketing health 64/100 ↑ 4 points
  suggestion …                      │  Suggestions acted on 3 of 5

This week — Aura’s weekly briefing
  [headline · Catch me up · Ready for you · calendar · competitor moves]

Recent activity — the last two weeks
  Dana said yes to “Respond to Acme’s pricing change”   1 hour ago
  Aura made 5 new suggestions                           yesterday

Everything else: Content Studio · Content plan · Market trends · …
```

## What matters now

The business situation in a few lines: active, high-relevance opportunities
and important changes in current signals. Every item is tied to its
opportunity or signal, says why it matters, and links to its suggestion.
When there isn't enough information, the section says so instead of
inventing anything. Full rules: [WHAT-MATTERS-NOW.md](WHAT-MATTERS-NOW.md).

Under it, **Waiting on you** lists the work ready for a person, each with
its action:
- posts to approve
- suggestions you said yes to (with their next step, for example Create
  content)
- approved posts to schedule
- new leads to review
- outreach ready to send

## The other sections

- **Aura Suggests:** the top 3 suggestions, with the actions they already
  have ([AURA-SUGGESTS.md](AURA-SUGGESTS.md)), and "See all (n)".
- **Active opportunities:** up to 4 open opportunities. Those closing
  within a week come first, then by priority. Each shows its type, when it
  closes, whether Aura already has a suggestion for it, and why. Each links
  to the opportunity; "All opportunities (n)" links to the full list.
- **Results:** each number is compared with last week: posts published,
  engagement, marketing health (since the last check), and suggestions
  acted on in the last 30 days. When there is no data yet it shows "—" and
  says when the number will appear, never a misleading zero. Each tile links
  to its detail.
- **Recent activity:** the last two weeks of real records: suggestions
  made, accepted, edited, skipped or turned down; opportunities spotted;
  posts written and published; competitor changes noticed; weekly briefings.
  Each says who did it (Aura, or the person's first name). Three or more of
  Aura's routine actions of one kind within a day read as one line ("Aura
  made 5 new suggestions"); a person's actions are never folded.

## Reliability

Each section loads on its own. If one source fails, that section is left out
and the failure is logged; the rest of Home still renders. `verify:home`
simulates an outage to prove this.

## Acceptance criteria

| Criterion | How |
| --- | --- |
| Opens with actionable context rather than disconnected metrics | *What matters now* comes first: the situation from real opportunities and changes, each linked to its suggestion, then what is waiting on you. Numbers sit lower and are compared, not just listed |
| Recommendations are prominent | *Aura Suggests* is the second section, with the top 3 suggestions and their actions on Home itself |
| Opportunities can be accessed | *Active opportunities* links to each one and to the full list. High-relevance ones also lead *What matters now* |
| Existing important dashboard functionality remains accessible | The weekly briefing ("This week"), setup, and every tool (sidebar and *Everything else*) are kept. The old "Needs you" and "Business insights" live on in better form |
