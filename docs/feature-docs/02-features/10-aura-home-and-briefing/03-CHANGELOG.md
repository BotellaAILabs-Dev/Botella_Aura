# Aura Home, What Matters Now & Weekly Briefing — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`4db020e` — feat(dashboard): persistent app shell + settings) |
| Last changed | 17 Oct 2026 (`73b0ad3`) |
| Commits | 24 |
| Days with changes | 15 |
| Lines in this feature's files | +8,059 / −846 |
| By status | Fresh addition 18, Fix 4, Change 2 |
| Committed by | srbaggari (14), dspraneeth07 (9), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Client feedback & UX review | 5 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 6 | 01 Sep – 03 Sep |
| Client requests, image providers & performance | 1 | 07 Sep |
| Sprint 7 – Business Context & Opportunities | 1 | 04 Oct |
| Sprint 8 – Recommendations | 6 | 07 Oct – 08 Oct |
| Sprint 9 – Recommendation to Content | 3 | 13 Oct |
| Sprint 10 – Connections & Execution | 1 | 17 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `d996c48` | Change | **polish(ui): remove internal "Sprint N" labels + working overview + more trends**<br/>strip all customer-facing "Sprint N" wording from the UI (overview, sidebar chips, onboarding, coming-soon, settings, leads, LinkedIn card, reset page).; rewrite the dashboard overview: the empty-state cards were disabled teasers (the "Connect" button did nothing) — now every card is a real link to its live feature (Co… | dspraneeth07 | 31-Jul-2026 | 1 |
| 3 | `dc5e65b` | Fresh addition | **feat: Viewer role, Resend emails, Connectors module, geo trend filters**<br/>Read-only VIEWER role (enum + RBAC content:create gate + team UI). A viewer can browse but cannot create content or change settings.; Real invite/reset emails via Resend when RESEND_API_KEY is set (REST API, no new dep); falls back to console so a mail outage never breaks flows.; | dspraneeth07 | 07-Aug-2026 | 1 |
| 4 | `5ec850b` | Fresh addition | **feat(dashboard+demo): action-first dashboard + connected sample data seed**<br/>Dashboard now leads with an 'Action needed' panel (drafts awaiting approval, outreach to approve/send, new leads) from real per-company counts, plus a latest-trend peek and an honest all-caught-up empty state. Generic feature cards demoted to 'Jump into a workflow'.; | dspraneeth07 | 13-Aug-2026 | 2 |
| 5 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 11 |
| 6 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 5 |
| 7 | `c320f33` | Fix | **fix(intelligence): label a setup-stage score as setup, not marketing health**<br/>Found by running the real onboarding path against a live database rather than only unit-testing the pieces. | dspraneeth07 | 01-Sep-2026 | 3 |
| 8 | `6ce3933` | Change | **perf: stop background pollers leaking loops on remount**<br/>Reported as the UI lagging and swallowing clicks. | dspraneeth07 | 01-Sep-2026 | 1 |
| 9 | `165d1c1` | Fresh addition | **feat(agent): Aura works for you — autonomous weekly cycle and briefing home**<br/>Aura was a dashboard with twelve separate AI tools. The capability to be an employee was already there — eleven cron jobs, a campaign orchestrator, a monthly planner, advisor opportunities, intelligence snapshots, competitor reports, marketing memory. | srbaggari | 02-Sep-2026 | 6 |
| 10 | `94e3926` | Fresh addition | **feat(onboarding): guide setup as a sequence, derived from real data**<br/>Setup was a three-step wizard followed by a loose list of four suggestions. The wizard ended with "You're all set", which was not true — Aura knew the company name and nothing else — and the four suggestions had no order, no sense of whether you had done them, and no statement of what any of them would buy you. | srbaggari | 03-Sep-2026 | 2 |
| 11 | `f537101` | Fresh addition | **feat(publishing): recommend when to publish, and act on it under settings**<br/>Audited the seven capabilities against what actually exists. Understanding the business, generating content and creatives, monitoring performance and proactively preparing work were all already there. Two were genuinely missing, and they turned out to be the same gap seen from both ends. | srbaggari | 03-Sep-2026 | 1 |
| 12 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 2 |
| 13 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 2 |
| 14 | `c55518c` | Fresh addition | **feat(opportunities): add Opportunities view**<br/>A page for viewing the opportunities Aura has detected, at /dashboard/opportunities. | srbaggari | 04-Oct-2026 | 1 |
| 15 | `3517195` | Fresh addition | **feat(recommendations): build the "Aura Suggests" experience**<br/>The first dedicated recommendation experience: Aura proactively says what the business should consider doing next, in plain language. Built on the existing recommendation model, engine, ranking and lifecycle. | srbaggari | 07-Oct-2026 | 1 |
| 16 | `060a036` | Fresh addition | **feat(home): refactor the dashboard into a recommendation-led Aura Home**<br/>Home now answers, in order: what matters right now, what Aura suggests, and what happened recently — live, instead of a weekly snapshot. | srbaggari | 07-Oct-2026 | 5 |
| 17 | `fc50373` | Fresh addition | **feat(home): build the "What Matters Now" section**<br/>A concise summary of the current business situation, built only from what Aura has recorded (lib/what-matters.ts, server/home/what-matters.service.ts). | srbaggari | 07-Oct-2026 | 6 |
| 18 | `9f5a3ef` | Fresh addition | **feat(recommendations): connect existing Aura modules to recommendations**<br/>Recommendations now know which Aura module carries them out, take their context there, and hand each module typed data — ready for the execution workflow (Sprint 10) without building it yet. | srbaggari | 07-Oct-2026 | 2 |
| 19 | `bc24572` | Fresh addition | **feat(recommendations): recommendation history and quality validation**<br/>Two tickets in one commit (they share the suggestion pipeline: autosuggest.service, suggestions page and service). | srbaggari | 08-Oct-2026 | 1 |
| 20 | `bb6ad7e` | Fresh addition | **feat(recommendations): empty and insufficient-data states**<br/>Aura says clearly when it does not have enough information to recommend, gives one next step for each gap, and never fills the page with a generic suggestion (lib/data-readiness.ts). | srbaggari | 08-Oct-2026 | 2 |
| 21 | `756ce60` | Fresh addition | **feat(approval): unified approval model for content, campaigns and outreach**<br/>One set of states, transitions and approval records for Content Studio drafts, campaign tasks and outreach messages (lib/approval.ts, server/approval/approval.service.ts). No migration: the unified state is derived from each module's status and schedule; | srbaggari | 13-Oct-2026 | 1 |
| 22 | `000e1c7` | Fresh addition | **feat(versions): edit & version management for generated content**<br/>Every state of a Content Studio draft or outreach message is kept as a numbered version (lib/versions.ts, server/versions), in aiMetadata.versions — no migration. | srbaggari | 13-Oct-2026 | 1 |
| 23 | `c39a554` | Fresh addition | **feat(trace): recommendation -&gt; content traceability**<br/>Every generated asset keeps the chain from the business opportunity to its approved version (lib/trace.ts, server/trace) in aiMetadata.trace — no migration: | srbaggari | 13-Oct-2026 | 1 |
| 24 | `73b0ad3` | Fresh addition | **feat(connections): Connection Manager, connection flow, capabilities, token lifecycle, health**<br/>Connection Manager data model: provider, channels, provider account id, granted scopes, credential reference, setup stage, health, execution history, capabilities; ConnectedAccount table for provider -&gt; account -&gt; page relationships; LinkedIn mirrored without its token; REVOKED status. | srbaggari | 17-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
