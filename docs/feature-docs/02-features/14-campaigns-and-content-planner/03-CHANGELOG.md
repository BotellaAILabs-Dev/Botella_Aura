# Campaigns & Content Planner — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`a2e0e83` — feat(content): Content Studio API routes) |
| Last changed | 26 Oct 2026 (`30757de`) |
| Commits | 18 |
| Days with changes | 14 |
| Lines in this feature's files | +3,922 / −349 |
| By status | Fresh addition 13, Fix 4, Change 1 |
| Committed by | srbaggari (11), dspraneeth07 (6), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 3 – Content Studio & Knowledge | 1 | 23 Jul |
| Sprint 6 – Campaigns, Analytics, Billing | 1 | 27 Jul |
| Client feedback & UX review | 2 | 24 Aug – 27 Aug |
| AI graphics, autonomy & guided setup | 4 | 02 Sep – 03 Sep |
| Client requests, image providers & performance | 3 | 07 Sep – 17 Sep |
| Sprint 8 – Recommendations | 1 | 07 Oct |
| Sprint 9 – Recommendation to Content | 5 | 09 Oct – 16 Oct |
| Post-review hardening | 1 | 26 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `a2e0e83` | Fresh addition | **feat(content): Content Studio API routes**<br/>Knowledge sync/upload, brand-voice generate/edit, content generate/refine, draft edit + approval transitions + publish + schedule + bulk, campaigns, and the protected scheduled-publish cron. Zod-validated; RBAC on publish/schedule. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `43f4024` | Fresh addition | **feat(campaigns): Module 1 — Campaign Orchestrator (Sprint 6)**<br/>The "one command that ties every module together" — a reviewable 30-day plan. | dspraneeth07 | 27-Jul-2026 | 12 |
| 3 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 4 |
| 4 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 3 |
| 5 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 1 |
| 6 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 1 |
| 7 | `94e3926` | Fresh addition | **feat(onboarding): guide setup as a sequence, derived from real data**<br/>Setup was a three-step wizard followed by a loose list of four suggestions. The wizard ended with "You're all set", which was not true — Aura knew the company name and nothing else — and the four suggestions had no order, no sense of whether you had done them, and no statement of what any of them would buy you. | srbaggari | 03-Sep-2026 | 2 |
| 8 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 2 |
| 9 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 3 |
| 10 | `127a692` | Fix | **fix: audience validation, image variations, campaign states, query cost**<br/>Four workstreams, each starting from a defect invisible at current data volume. | srbaggari | 17-Sep-2026 | 7 |
| 11 | `5bb000f` | Fresh addition | **feat(brand): connect brand knowledge to every AI workflow**<br/>Brand knowledge was assembled independently at each AI call site, and every one picked a different subset. An audit of the workflows that call a model found brand voice wired into most of them -- and the business description and audience wired into two. | srbaggari | 17-Sep-2026 | 2 |
| 12 | `9f5a3ef` | Fresh addition | **feat(recommendations): connect existing Aura modules to recommendations**<br/>Recommendations now know which Aura module carries them out, take their context there, and hand each module typed data — ready for the execution workflow (Sprint 10) without building it yet. | srbaggari | 07-Oct-2026 | 3 |
| 13 | `89cf8a2` | Change | **perf(planner): generate the monthly calendar fast, bounded and complete**<br/>The Content Plan hung at "Monthly calendar - 35%": the whole month was one high-effort model call (up to 8k output tokens), retries stacked to ~12 min, the job runner is killed at 60s, and a stuck run was only noticed after 10 min - so Generate again reattached to the dead run. | srbaggari | 09-Oct-2026 | 4 |
| 14 | `4b2aada` | Fresh addition | **feat(recommendations): recommendation acceptance -&gt; creation flow**<br/>Accepting a recommendation now leads into the right creation workflow, already filled in, and whatever is made keeps the recommendation's context. | srbaggari | 09-Oct-2026 | 3 |
| 15 | `756ce60` | Fresh addition | **feat(approval): unified approval model for content, campaigns and outreach**<br/>One set of states, transitions and approval records for Content Studio drafts, campaign tasks and outreach messages (lib/approval.ts, server/approval/approval.service.ts). No migration: the unified state is derived from each module's status and schedule; | srbaggari | 13-Oct-2026 | 2 |
| 16 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 1 |
| 17 | `6672bf3` | Fresh addition | **feat(sprint9): campaign/outreach creation, execution handoff, permissions, failure recovery, E2E**<br/>Connect Campaign & Outreach Creation; Campaign and Outreach creation handoffs from eligible recommendations (lib/creation-handoff.ts): recommendation context, audience, goal, CTA, channel and content requirements mapped with their sources; gaps stated, nothing invented. | srbaggari | 16-Oct-2026 | 9 |
| 18 | `30757de` | Fresh addition | **feat(nav, trends, onboarding): six-group navigation, localized trend sources**<br/>Addresses the product review's navigation, trends and onboarding findings. | dspraneeth07 | 26-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
