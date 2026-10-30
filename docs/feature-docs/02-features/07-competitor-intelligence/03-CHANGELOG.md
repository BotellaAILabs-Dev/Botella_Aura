# Competitor Intelligence — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`4db020e` — feat(dashboard): persistent app shell + settings) |
| Last changed | 05 Oct 2026 (`39c4048`) |
| Commits | 10 |
| Days with changes | 8 |
| Lines in this feature's files | +2,504 / −54 |
| By status | Fresh addition 5, Fix 4, Change 1 |
| Committed by | dspraneeth07 (5), srbaggari (4), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Sprint 4 – Competitors, Extension, Outreach | 1 | 26 Jul |
| Client feedback & UX review | 2 | 24 Aug – 27 Aug |
| AI graphics, autonomy & guided setup | 4 | 02 Sep – 03 Sep |
| Client requests, image providers & performance | 1 | 07 Sep |
| Sprint 7 – Business Context & Opportunities | 1 | 05 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `7430dea` | Fresh addition | **feat(competitors): Module 1 — Competitor Intelligence (Sprint 4)**<br/>Add/remove/edit competitors at /dashboard/competitors and a tracking pipeline that pulls ONLY legitimate public signal:; website change detection (robots-respecting fetch + hash + line diff), with a Claude-written human-readable change summary (deterministic fallback); | dspraneeth07 | 26-Jul-2026 | 18 |
| 3 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 6 |
| 4 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 1 |
| 5 | `d332d46` | Fix | **fix(ui): Competitors and Trends crashed on stored payloads that predate their types**<br/>Both pages returned a 500. Both for the same reason: a JSON column was CAST to an interface and then trusted. | srbaggari | 02-Sep-2026 | 2 |
| 6 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 2 |
| 7 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 1 |
| 8 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 2 |
| 9 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 3 |
| 10 | `39c4048` | Change | **security: validate data access for Business Context and opportunities**<br/>Review of how Business Context, signals, opportunities and recommendations are isolated between users, businesses and workspaces, with tests. | srbaggari | 05-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
