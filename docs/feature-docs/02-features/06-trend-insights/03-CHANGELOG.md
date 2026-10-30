# Trend Insights — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`4db020e` — feat(dashboard): persistent app shell + settings) |
| Last changed | 26 Oct 2026 (`30757de`) |
| Commits | 21 |
| Days with changes | 14 |
| Lines in this feature's files | +3,258 / −208 |
| By status | Fresh addition 13, Fix 5, Change 2, Update 1 |
| Committed by | dspraneeth07 (15), srbaggari (5), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Sprint 2 – Trends, AI & LinkedIn | 2 | 23 Jul |
| Sprint 3 – Content Studio & Knowledge | 2 | 23 Jul |
| Client feedback & UX review | 6 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 5 | 01 Sep – 03 Sep |
| Client requests, image providers & performance | 1 | 07 Sep |
| Sprint 7 – Business Context & Opportunities | 2 | 01 Oct – 05 Oct |
| Post-review hardening | 2 | 26 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `e0a9a44` | Fresh addition | **feat(trends): trend sources, scoring, config + digest engine**<br/>Modular sources implementing a shared TrendSource interface (Hacker News + Google News keyless; Reddit app-only OAuth; X/Twitter behind a feature flag), a pure fixture-testable scoring engine (recency decay + engagement + keyword/ competitor relevance), per-company config with AI smart-defaults (Claude with a determini… | dspraneeth07 | 23-Jul-2026 | 9 |
| 3 | `a9c716b` | Fresh addition | **feat(trends): digest API + Trend Intelligence dashboard**<br/>Protected cron endpoint (idempotent per company/day), manual refresh, and Zod-validated config API. Replaces the placeholder /dashboard/trends with a real digest feed (source badges, AI summary + suggested angle, Content Studio hand-off, 7-day history, empty/first-run states) and a keyword/source config page. | dspraneeth07 | 23-Jul-2026 | 7 |
| 4 | `6e42264` | Fresh addition | **feat(trends): real-time keyless multi-source news on every refresh**<br/>Expands the News source to Google News (with the when:Nd freshness operator) + Bing News RSS per keyword, adds a hard recency window and cache:'no-store' so every refresh fetches genuinely new items. Reddit now works KEYLESS via its public .rss feeds when no API keys are set (OAuth stays the richer upgrade). | dspraneeth07 | 23-Jul-2026 | 3 |
| 5 | `18f20b0` | Fresh addition | **feat(trends): add curated keyless publisher feeds (TechCrunch, Verge, BBC…)**<br/>Always-ingested public RSS from major tech/business/marketing outlets for breadth, keyword-filtered to stay on-topic when keywords are configured. Live: ~140 fresh items/fetch across Google News, Bing, and 10 curated publishers — all keyless, all dated today. | dspraneeth07 | 23-Jul-2026 | 1 |
| 6 | `d996c48` | Change | **polish(ui): remove internal "Sprint N" labels + working overview + more trends**<br/>strip all customer-facing "Sprint N" wording from the UI (overview, sidebar chips, onboarding, coming-soon, settings, leads, LinkedIn card, reset page).; rewrite the dashboard overview: the empty-state cards were disabled teasers (the "Connect" button did nothing) — now every card is a real link to its live feature (Co… | dspraneeth07 | 31-Jul-2026 | 1 |
| 7 | `dc5e65b` | Fresh addition | **feat: Viewer role, Resend emails, Connectors module, geo trend filters**<br/>Read-only VIEWER role (enum + RBAC content:create gate + team UI). A viewer can browse but cannot create content or change settings.; Real invite/reset emails via Resend when RESEND_API_KEY is set (REST API, no new dep); falls back to console so a mail outage never breaks flows.; | dspraneeth07 | 07-Aug-2026 | 6 |
| 8 | `ef9dd58` | Fix | **fix/feat: campaign selector, lead fit score, invite status, connectors, extension beta**<br/>Broken-flow + visibility fixes from client review:; Campaign selector: no more dead "— none —" — loads campaigns and defaults to the first; shows an empty-state (+ link to Campaigns) and disables "From a campaign" when none exist. Generate is guarded.; | dspraneeth07 | 13-Aug-2026 | 1 |
| 9 | `912ee54` | Fresh addition | **feat(trends): AI digest synthesis, trending hashtags, seasonal moments, competitor mentions**<br/>Digest now carries a top-level AI summary + prioritized weekly recommendations + trending hashtags (one Claude call, deterministic fallback so it always ships).; Seasonal/event-based moments from a curated first-party calendar (server/trends/seasonal.ts) biased by the company's keywords/industry.; | dspraneeth07 | 17-Aug-2026 | 5 |
| 10 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 3 |
| 11 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 2 |
| 12 | `26bc4de` | Update | **chore: declare the two config routes dynamic**<br/>Both read the session via headers(), so Next could never statically prerender them — it attempted anyway on every build and logged a fallback for each. Now that captureException also logs stack traces, that noise filled the build output with what look like errors but are not. | dspraneeth07 | 01-Sep-2026 | 1 |
| 13 | `d332d46` | Fix | **fix(ui): Competitors and Trends crashed on stored payloads that predate their types**<br/>Both pages returned a 500. Both for the same reason: a JSON column was CAST to an interface and then trusted. | srbaggari | 02-Sep-2026 | 1 |
| 14 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 2 |
| 15 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 1 |
| 16 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 1 |
| 17 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 18 | `720c22e` | Fresh addition | **feat(context): connect existing Aura sources to the Business Context layer**<br/>Audit every existing store of business information, map it into the unified context, connect the remaining AI workflows to the context service, and prove no business information is lost. | srbaggari | 01-Oct-2026 | 2 |
| 19 | `39c4048` | Change | **security: validate data access for Business Context and opportunities**<br/>Review of how Business Context, signals, opportunities and recommendations are isolated between users, businesses and workspaces, with tests. | srbaggari | 05-Oct-2026 | 2 |
| 20 | `73bac4f` | Fresh addition | **feat(content): brand safety, source fidelity, image realism, logo colours**<br/>Addresses the review feedback on image generation, text generation, brand safety and publishing. | dspraneeth07 | 26-Oct-2026 | 3 |
| 21 | `30757de` | Fresh addition | **feat(nav, trends, onboarding): six-group navigation, localized trend sources**<br/>Addresses the product review's navigation, trends and onboarding findings. | dspraneeth07 | 26-Oct-2026 | 4 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
