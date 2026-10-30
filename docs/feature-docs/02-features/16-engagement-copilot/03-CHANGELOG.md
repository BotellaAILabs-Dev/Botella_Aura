# Engagement Copilot — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`4db020e` — feat(dashboard): persistent app shell + settings) |
| Last changed | 01 Oct 2026 (`720c22e`) |
| Commits | 9 |
| Days with changes | 8 |
| Lines in this feature's files | +680 / −79 |
| By status | Fresh addition 8, Fix 1 |
| Committed by | dspraneeth07 (4), srbaggari (4), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Sprint 4 – Competitors, Extension, Outreach | 1 | 26 Jul |
| Client feedback & UX review | 2 | 17 Aug – 24 Aug |
| AI graphics, autonomy & guided setup | 2 | 02 Sep |
| Client requests, image providers & performance | 2 | 07 Sep – 17 Sep |
| Sprint 7 – Business Context & Opportunities | 1 | 01 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `cb77149` | Fresh addition | **feat(engagement): Module 4 — Engagement Copilot (Sprint 4)**<br/>AI-drafted LinkedIn comments for posts the user is ALREADY viewing — drafted and posted from the extension, with the web app as the read-only system of record. | dspraneeth07 | 26-Jul-2026 | 6 |
| 3 | `bed5963` | Fresh addition | **feat(P2/P3): validation + guidance polish sweep**<br/>Shared LinkedIn URL validator (lib/linkedin-url.ts): validates and distinguishes person (/in/) vs company (/company/) pages. Wired into create-lead, outreach edit-lead, and engagement-target inputs with live person/company hints + blocking on invalid input.; | dspraneeth07 | 17-Aug-2026 | 1 |
| 4 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 2 |
| 5 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 1 |
| 6 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 1 |
| 7 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 8 | `5bb000f` | Fresh addition | **feat(brand): connect brand knowledge to every AI workflow**<br/>Brand knowledge was assembled independently at each AI call site, and every one picked a different subset. An audit of the workflows that call a model found brand voice wired into most of them -- and the business description and audience wired into two. | srbaggari | 17-Sep-2026 | 1 |
| 9 | `720c22e` | Fresh addition | **feat(context): connect existing Aura sources to the Business Context layer**<br/>Audit every existing store of business information, map it into the unified context, connect the remaining AI workflows to the context service, and prove no business information is lost. | srbaggari | 01-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
