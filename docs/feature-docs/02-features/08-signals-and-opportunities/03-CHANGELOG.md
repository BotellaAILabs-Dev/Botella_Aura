# Signals & Opportunity Detection — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 24 Aug 2026 (`45618d2` — feat: consolidated client feedback — Phases 1–3) |
| Last changed | 08 Oct 2026 (`6eb6f24`) |
| Commits | 19 |
| Days with changes | 12 |
| Lines in this feature's files | +6,402 / −124 |
| By status | Fresh addition 13, Fix 4, Change 2 |
| Committed by | srbaggari (16), dspraneeth07 (2), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Client feedback & UX review | 1 | 24 Aug |
| AI graphics, autonomy & guided setup | 2 | 02 Sep – 03 Sep |
| Client requests, image providers & performance | 2 | 07 Sep – 17 Sep |
| Sprint 7 – Business Context & Opportunities | 8 | 01 Oct – 05 Oct |
| Sprint 8 – Recommendations | 6 | 05 Oct – 08 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 5 |
| 2 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 1 |
| 3 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 1 |
| 4 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 5 | `127a692` | Fix | **fix: audience validation, image variations, campaign states, query cost**<br/>Four workstreams, each starting from a defect invisible at current data volume. | srbaggari | 17-Sep-2026 | 1 |
| 6 | `720c22e` | Fresh addition | **feat(context): connect existing Aura sources to the Business Context layer**<br/>Audit every existing store of business information, map it into the unified context, connect the remaining AI workflows to the context service, and prove no business information is lost. | srbaggari | 01-Oct-2026 | 1 |
| 7 | `58d660d` | Fresh addition | **feat(opportunities): add Opportunity data model with evidence and lifecycle**<br/>Opportunities Aura detects are stored on their own, independently of recommendations, with evidence linked to the underlying signals and a tracked lifecycle. | srbaggari | 02-Oct-2026 | 8 |
| 8 | `285e4a4` | Fresh addition | **feat(signals): add signal aggregation layer for opportunity detection**<br/>Signals from every Aura source are normalised, de-duplicated and stored in one place for opportunity detection. | srbaggari | 02-Oct-2026 | 8 |
| 9 | `93ee292` | Fresh addition | **feat(opportunities): define opportunity detection rules**<br/>Deterministic rules decide when signals amount to a real opportunity; AI is left only the categories that need interpretation. | srbaggari | 04-Oct-2026 | 5 |
| 10 | `6f59ea9` | Fresh addition | **feat(opportunities): add AI-assisted opportunity detection**<br/>AI interprets signals for the opportunities rules cannot detect (content gaps, competitive gaps, audience segments), and every answer is validated before anything is stored. | srbaggari | 04-Oct-2026 | 6 |
| 11 | `c55518c` | Fresh addition | **feat(opportunities): add Opportunities view**<br/>A page for viewing the opportunities Aura has detected, at /dashboard/opportunities. | srbaggari | 04-Oct-2026 | 6 |
| 12 | `ad1237c` | Fresh addition | **feat(recommendations): prepare Opportunity -&gt; Recommendation integration**<br/>Foundation for the Sprint 8 recommendation engine: how a recommendation is connected to the opportunity it answers. Not the engine itself. | srbaggari | 05-Oct-2026 | 4 |
| 13 | `39c4048` | Change | **security: validate data access for Business Context and opportunities**<br/>Review of how Business Context, signals, opportunities and recommendations are isolated between users, businesses and workspaces, with tests. | srbaggari | 05-Oct-2026 | 2 |
| 14 | `18665a4` | Fresh addition | **feat(recommendations): define the Recommendation data model**<br/>The core model that turns an opportunity into a structured, actionable recommendation: Opportunity, What, Why, Action, Expected outcome, Evidence, Confidence, Priority, Channel, Audience, Status. | srbaggari | 05-Oct-2026 | 2 |
| 15 | `39e0131` | Fresh addition | **feat(recommendations): build the recommendation generation engine**<br/>Converts a validated opportunity into a structured, supported recommendation that fits the business as it is now. | srbaggari | 05-Oct-2026 | 1 |
| 16 | `c28b09c` | Fresh addition | **Recommendation Lifecycle: generated → presented → accepted/edited/skipped/rejected → completed**<br/>Statuses GENERATED, PRESENTED, ACCEPTED, EDITED, SKIPPED, REJECTED, IN_PROGRESS, COMPLETED (+ WITHDRAWN, EXPIRED); one transition table. Migration renames PROPOSED → GENERATED in place and backfills history.; | srbaggari | 06-Oct-2026 | 1 |
| 17 | `3517195` | Fresh addition | **feat(recommendations): build the "Aura Suggests" experience**<br/>The first dedicated recommendation experience: Aura proactively says what the business should consider doing next, in plain language. Built on the existing recommendation model, engine, ranking and lifecycle. | srbaggari | 07-Oct-2026 | 1 |
| 18 | `bf23770` | Fix | **fix(recommendations): Aura suggests on its own, and says why when it can't**<br/>Aura Suggests stayed empty: a recommendation was only made when a person pressed "Recommend" on an opportunity, and the empty page gave no reason. | srbaggari | 07-Oct-2026 | 1 |
| 19 | `6eb6f24` | Change | **security(recommendations): recommendation security and RLS validation**<br/>Validates that recommendations respect workspace boundaries at three layers (isolation is enforced in the application; database RLS was reviewed and set aside earlier — docs/DATA-ACCESS-SECURITY.md §1). | srbaggari | 08-Oct-2026 | 2 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
