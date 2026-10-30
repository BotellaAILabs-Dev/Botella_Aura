# Navigation, Dashboard Shell & Design System — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`09971ac` — chore: scaffold Next.js 14 + TypeScript project foundation) |
| Last changed | 26 Oct 2026 (`30757de`) |
| Commits | 37 |
| Days with changes | 20 |
| Lines in this feature's files | +2,844 / −279 |
| By status | Fresh addition 28, Update 3, Change 3, Fix 3 |
| Committed by | dspraneeth07 (23), srbaggari (12), SRBaggari (2) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 5 | 23 Jul |
| Sprint 2 – Trends, AI & LinkedIn | 1 | 23 Jul |
| Sprint 3 – Content Studio & Knowledge | 1 | 23 Jul |
| Sprint 4 – Competitors, Extension, Outreach | 3 | 26 Jul |
| Sprint 5 – Lead Discovery & Marketing Memory | 2 | 26 Jul |
| Sprint 6 – Campaigns, Analytics, Billing | 3 | 27 Jul |
| Client feedback & UX review | 5 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 4 | 01 Sep – 03 Sep |
| Client requests, image providers & performance | 2 | 07 Sep |
| Sprint 7 – Business Context & Opportunities | 2 | 01 Oct – 04 Oct |
| Sprint 8 – Recommendations | 4 | 06 Oct – 07 Oct |
| Sprint 9 – Recommendation to Content | 2 | 13 Oct – 14 Oct |
| Sprint 10 – Connections & Execution | 2 | 21 Oct – 22 Oct |
| Post-review hardening | 1 | 26 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `09971ac` | Update | **chore: scaffold Next.js 14 + TypeScript project foundation**<br/>Strict TS, ESLint + Prettier, Tailwind, Vitest, pnpm, and a documented .env.example. Adds docker-compose for one-command local Postgres. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `64c9b5a` | Fresh addition | **feat(ui): design system foundation**<br/>Premium slate + indigo-violet token system (light/dark) and the reusable primitives every sprint needs: Button, Card, Input, Textarea, Label, Badge (with ContentStatus mapping), Dialog, DropdownMenu, Avatar, EmptyState, Toaster, and the brand Logo. | dspraneeth07 | 23-Jul-2026 | 13 |
| 3 | `7323404` | Fresh addition | **feat(auth): NextAuth authentication system + RBAC scaffold**<br/>Email/password (bcrypt) + Google OAuth via NextAuth v4, JWT sessions with typed id/role, and edge middleware protecting /dashboard and /onboarding. Adds token-based password reset (hashed, single-use, no account enumeration), a role-&gt;permission RBAC matrix, AES-256-GCM helpers for tokens at rest, an email transport stu… | dspraneeth07 | 23-Jul-2026 | 1 |
| 4 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 7 |
| 5 | `c04359f` | Update | **docs: README (setup, env, architecture) + DESIGN.md tokens** | dspraneeth07 | 23-Jul-2026 | 1 |
| 6 | `a9c716b` | Fresh addition | **feat(trends): digest API + Trend Intelligence dashboard**<br/>Protected cron endpoint (idempotent per company/day), manual refresh, and Zod-validated config API. Replaces the placeholder /dashboard/trends with a real digest feed (source badges, AI summary + suggested angle, Content Studio hand-off, 7-day history, empty/first-run states) and a keyword/source config page. | dspraneeth07 | 23-Jul-2026 | 2 |
| 7 | `c71046e` | Fresh addition | **feat(content): Content Studio UI (queue, editor, calendar, KB)**<br/>Approval queue (kanban + bulk actions + create dialog), per-type draft preview (LinkedIn card / carousel / thread / blog) with edit/refine/regenerate/approve/ reject/publish/schedule, trend hand-off page (Sprint 2 button now works), content calendar, and the knowledge-base + brand-voice settings page. | dspraneeth07 | 23-Jul-2026 | 1 |
| 8 | `7430dea` | Fresh addition | **feat(competitors): Module 1 — Competitor Intelligence (Sprint 4)**<br/>Add/remove/edit competitors at /dashboard/competitors and a tracking pipeline that pulls ONLY legitimate public signal:; website change detection (robots-respecting fetch + hash + line diff), with a Claude-written human-readable change summary (deterministic fallback); | dspraneeth07 | 26-Jul-2026 | 1 |
| 9 | `fdde091` | Fresh addition | **feat(outreach): Module 3 — Outreach Intelligence (Sprint 4)**<br/>Detect leads from LEGITIMATE public signal, draft brand-voice-grounded outreach, approve it, and hand approved items to the extension queue for a human send. | dspraneeth07 | 26-Jul-2026 | 1 |
| 10 | `cb77149` | Fresh addition | **feat(engagement): Module 4 — Engagement Copilot (Sprint 4)**<br/>AI-drafted LinkedIn comments for posts the user is ALREADY viewing — drafted and posted from the extension, with the web app as the read-only system of record. | dspraneeth07 | 26-Jul-2026 | 1 |
| 11 | `1700ba5` | Fresh addition | **feat(leads): Module 1 — Lead Discovery Engine (Sprint 5)**<br/>Proactive, criteria-based prospecting on top of Sprint 4's reactive outreach. | dspraneeth07 | 26-Jul-2026 | 1 |
| 12 | `8755674` | Fresh addition | **feat(memory): Module 2 — Marketing Memory / Learning Loop (Sprint 5)**<br/>The retention/moat feature: the product remembers what works and feeds it back into every future generation. | dspraneeth07 | 26-Jul-2026 | 1 |
| 13 | `43f4024` | Fresh addition | **feat(campaigns): Module 1 — Campaign Orchestrator (Sprint 6)**<br/>The "one command that ties every module together" — a reviewable 30-day plan. | dspraneeth07 | 27-Jul-2026 | 1 |
| 14 | `584923e` | Fresh addition | **feat(analytics): Module 2 — Analytics Dashboard (Sprint 6)**<br/>The client-presentable RESULTS view (distinct from Marketing Memory's learnings). | dspraneeth07 | 27-Jul-2026 | 1 |
| 15 | `f4ee9be` | Fresh addition | **feat(hardening): Module 4 — production hardening (Sprint 6)**<br/>multi-tenant isolation tests (release-blocker, NON-NEGOTIABLE #3): prove a user acting for company B cannot read company A's campaigns, leads, content, or billing via the real scoped getters. Full migration chain (Sprint 1-6) verified to apply cleanly on a fresh database.; | dspraneeth07 | 27-Jul-2026 | 1 |
| 16 | `d996c48` | Change | **polish(ui): remove internal "Sprint N" labels + working overview + more trends**<br/>strip all customer-facing "Sprint N" wording from the UI (overview, sidebar chips, onboarding, coming-soon, settings, leads, LinkedIn card, reset page).; rewrite the dashboard overview: the empty-state cards were disabled teasers (the "Connect" button did nothing) — now every card is a real link to its live feature (Co… | dspraneeth07 | 31-Jul-2026 | 2 |
| 17 | `0176507` | Fresh addition | **feat(dashboard): rename Overview→Dashboard; fix Create Workspace**<br/>'Create Workspace' now works for existing users: it routes to /onboarding?new=1 (the page previously bounced anyone with a company back to /dashboard, so the button appeared dead). The new workspace is set active on creation. | dspraneeth07 | 07-Aug-2026 | 1 |
| 18 | `dc5e65b` | Fresh addition | **feat: Viewer role, Resend emails, Connectors module, geo trend filters**<br/>Read-only VIEWER role (enum + RBAC content:create gate + team UI). A viewer can browse but cannot create content or change settings.; Real invite/reset emails via Resend when RESEND_API_KEY is set (REST API, no new dep); falls back to console so a mail outage never breaks flows.; | dspraneeth07 | 07-Aug-2026 | 2 |
| 19 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 2 |
| 20 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 2 |
| 21 | `96c1f1a` | Fresh addition | **feat: confidence-gated bulk approval + app-wide background job indicator**<br/>Closes the last two gaps against the screens review. | dspraneeth07 | 01-Sep-2026 | 1 |
| 22 | `2b82ea8` | Fresh addition | **feat(content-studio): AI graphic generation, media attachment and platform-aware publishing**<br/>Content Studio can now read a generated post, work out what it is about, write an image prompt for it, produce a graphic, attach it to the post and push the whole thing into the EXISTING publishing queue. | srbaggari | 01-Sep-2026 | 1 |
| 23 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 3 |
| 24 | `35bb33e` | Change | **perf(dashboard): stop navigations blocking, and stop re-querying auth**<br/>Three changes, in descending order of what a user actually feels. | dspraneeth07 | 03-Sep-2026 | 2 |
| 25 | `a64bdc4` | Change | **perf(dashboard): stop repeating the same work on every navigation**<br/>Follows 35bb33e, which made a navigation paint immediately and collapsed the duplicate auth lookups within a request. What was still missing was anything holding a result BETWEEN requests — plus two reads that get slower the longer the product is used. | SRBaggari | 07-Sep-2026 | 2 |
| 26 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 27 | `4015d13` | Fresh addition | **feat(business): turn About My Business into the view of the Business Context**<br/>A new About my business page (/dashboard/business) is the user-facing representation of the trusted Business Context: what Aura knows about the business, where each detail came from, how current it is, and what is missing — editable in place. | srbaggari | 01-Oct-2026 | 1 |
| 28 | `c55518c` | Fresh addition | **feat(opportunities): add Opportunities view**<br/>A page for viewing the opportunities Aura has detected, at /dashboard/opportunities. | srbaggari | 04-Oct-2026 | 1 |
| 29 | `c00bb2f` | Fix | **fix(images): reliable Gemini image generation and previews**<br/>Switches the default Google image model to gemini-3.1-flash-lite-image (about 4s per image) and removes the ways a generated image could fail to appear or appear slowly. | srbaggari | 06-Oct-2026 | 1 |
| 30 | `b34225c` | Update | **chore(lint): fix the remaining project-wide lint errors**<br/>scripts/verify-briefing.ts, scripts/verify-graphics.ts: checks written as `cond ? ok(...) : fail(...)` expression statements become if/else (same logic; @typescript-eslint/no-unused-expressions).; tailwind.config.ts: import tailwindcss-animate instead of require() (@typescript-eslint/no-require-imports). | srbaggari | 06-Oct-2026 | 1 |
| 31 | `3517195` | Fresh addition | **feat(recommendations): build the "Aura Suggests" experience**<br/>The first dedicated recommendation experience: Aura proactively says what the business should consider doing next, in plain language. Built on the existing recommendation model, engine, ranking and lifecycle. | srbaggari | 07-Oct-2026 | 1 |
| 32 | `9f5a3ef` | Fresh addition | **feat(recommendations): connect existing Aura modules to recommendations**<br/>Recommendations now know which Aura module carries them out, take their context there, and hand each module typed data — ready for the execution workflow (Sprint 10) without building it yet. | srbaggari | 07-Oct-2026 | 1 |
| 33 | `c33077b` | Fresh addition | **feat(review): unified review experience for generated Aura work**<br/>One review screen, one queue and one set of actions for every piece of generated work — Content Studio drafts (which campaigns, the planner, Autopilot and suggestions produce) and outreach messages. | srbaggari | 13-Oct-2026 | 1 |
| 34 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 1 |
| 35 | `a68c4c8` | Fresh addition | **feat(execution): Meta V1 integration, execution model and state machine, provider routing, timezones**<br/>Execution job model: one Execution per (post, network) with workspace, recommendation, opportunity, content/assets, approved version, channel, provider, connection, target page/profile, schedule, status, attempts, provider response and error; ExecutionEvent for every state change; | srbaggari | 21-Oct-2026 | 1 |
| 36 | `183a772` | Fresh addition | **feat(content, meta, launch): Content Studio control, image refinement and preview, Meta review prep, production readiness**<br/>Content Studio; Recommendations workspace: compare versions, use one (others kept), edit, refine, regenerate or revert ONE version, add 1-3 more recommendations; Per-version CTA, website, address, phone and email (post details), never written by the AI; typed details must be confirmed before approval; | srbaggari | 22-Oct-2026 | 2 |
| 37 | `30757de` | Fresh addition | **feat(nav, trends, onboarding): six-group navigation, localized trend sources**<br/>Addresses the product review's navigation, trends and onboarding findings. | dspraneeth07 | 26-Oct-2026 | 2 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
