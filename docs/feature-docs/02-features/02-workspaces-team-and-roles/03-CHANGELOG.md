# Workspaces, Team & Roles (RBAC) — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`7323404` — feat(auth): NextAuth authentication system + RBAC scaffold) |
| Last changed | 22 Oct 2026 (`183a772`) |
| Commits | 23 |
| Days with changes | 16 |
| Lines in this feature's files | +2,578 / −252 |
| By status | Fresh addition 16, Fix 6, Change 1 |
| Committed by | dspraneeth07 (14), srbaggari (9) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 3 | 23 Jul |
| Client feedback & UX review | 8 | 07 Aug – 27 Aug |
| AI graphics, autonomy & guided setup | 4 | 01 Sep – 03 Sep |
| Client requests, image providers & performance | 3 | 08 Sep – 17 Sep |
| Sprint 7 – Business Context & Opportunities | 2 | 30 Sep – 01 Oct |
| Sprint 9 – Recommendation to Content | 1 | 13 Oct |
| Sprint 10 – Connections & Execution | 2 | 21 Oct – 22 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `7323404` | Fresh addition | **feat(auth): NextAuth authentication system + RBAC scaffold**<br/>Email/password (bcrypt) + Google OAuth via NextAuth v4, JWT sessions with typed id/role, and edge middleware protecting /dashboard and /onboarding. Adds token-based password reset (hashed, single-use, no account enumeration), a role-&gt;permission RBAC matrix, AES-256-GCM helpers for tokens at rest, an email transport stu… | dspraneeth07 | 23-Jul-2026 | 2 |
| 2 | `5666a10` | Fresh addition | **feat(onboarding): 3-step company onboarding wizard**<br/>Company details -&gt; brand voice -&gt; confirmation, persisting to Company (with an extensible preferences JSON field). Creation runs in a transaction that adds the user as OWNER and writes COMPANY_CREATED + ONBOARDING_COMPLETED audit entries. Confirmation step sets the human-in-the-loop expectation up front. | dspraneeth07 | 23-Jul-2026 | 2 |
| 3 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 3 |
| 4 | `0176507` | Fresh addition | **feat(dashboard): rename Overview→Dashboard; fix Create Workspace**<br/>'Create Workspace' now works for existing users: it routes to /onboarding?new=1 (the page previously bounced anyone with a company back to /dashboard, so the button appeared dead). The new workspace is set active on creation. | dspraneeth07 | 07-Aug-2026 | 1 |
| 5 | `67280d6` | Fresh addition | **feat(team): invite teammates + role-based access**<br/>Team collaboration on a workspace: invite by email (emailed single-use accept link, 7-day expiry), accept flow (/invite/[token]), role management (Owner/Admin/Member) and member removal — all RBAC-gated and audited. Hard invariant enforced in the service: a company can never be left without an owner. | dspraneeth07 | 07-Aug-2026 | 6 |
| 6 | `dc5e65b` | Fresh addition | **feat: Viewer role, Resend emails, Connectors module, geo trend filters**<br/>Read-only VIEWER role (enum + RBAC content:create gate + team UI). A viewer can browse but cannot create content or change settings.; Real invite/reset emails via Resend when RESEND_API_KEY is set (REST API, no new dep); falls back to console so a mail outage never breaks flows.; | dspraneeth07 | 07-Aug-2026 | 3 |
| 7 | `ea1e976` | Fix | **fix/improve: SMTP email, PDF upload, content speed, outreach history, lead dedup**<br/>Email: add SMTP transport (nodemailer) — works with any SMTP provider (Gmail app password, SendGrid, SES, etc.). Selection: SMTP → Resend → console.; Knowledge base: PDF upload route pinned to Node runtime + 60s maxDuration + a clear ~4MB size guard (serverless body cap) so big/scanned PDFs fail with an actionable mess… | dspraneeth07 | 10-Aug-2026 | 1 |
| 8 | `ef9dd58` | Fix | **fix/feat: campaign selector, lead fit score, invite status, connectors, extension beta**<br/>Broken-flow + visibility fixes from client review:; Campaign selector: no more dead "— none —" — loads campaigns and defaults to the first; shows an empty-state (+ link to Campaigns) and disables "From a campaign" when none exist. Generate is guarded.; | dspraneeth07 | 13-Aug-2026 | 1 |
| 9 | `bed5963` | Fresh addition | **feat(P2/P3): validation + guidance polish sweep**<br/>Shared LinkedIn URL validator (lib/linkedin-url.ts): validates and distinguishes person (/in/) vs company (/company/) pages. Wired into create-lead, outreach edit-lead, and engagement-target inputs with live person/company hints + blocking on invalid input.; | dspraneeth07 | 17-Aug-2026 | 1 |
| 10 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 3 |
| 11 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 3 |
| 12 | `d99e0f8` | Fix | **fix(companies): workspace creation returned 500 on every attempt**<br/>A request body is a single-use stream. The duplicate-name guard I added read it with `await req.json()` and then called `req.clone()` to look for a second field. Cloning a request whose body is already disturbed throws `TypeError: unusable` — synchronously, so the `.catch()` chained onto the following `.json()` never s… | dspraneeth07 | 01-Sep-2026 | 1 |
| 13 | `94e3926` | Fresh addition | **feat(onboarding): guide setup as a sequence, derived from real data**<br/>Setup was a three-step wizard followed by a loose list of four suggestions. The wizard ended with "You're all set", which was not true — Aura knew the company name and nothing else — and the four suggestions had no order, no sense of whether you had done them, and no statement of what any of them would buy you. | srbaggari | 03-Sep-2026 | 5 |
| 14 | `f537101` | Fresh addition | **feat(publishing): recommend when to publish, and act on it under settings**<br/>Audited the seven capabilities against what actually exists. Understanding the business, generating content and creatives, monitoring performance and proactively preparing work were all already there. Two were genuinely missing, and they turned out to be the same gap seen from both ends. | srbaggari | 03-Sep-2026 | 1 |
| 15 | `35bb33e` | Change | **perf(dashboard): stop navigations blocking, and stop re-querying auth**<br/>Three changes, in descending order of what a user actually feels. | dspraneeth07 | 03-Sep-2026 | 1 |
| 16 | `0382184` | Fresh addition | **feat(settings): let each workspace choose its content formats**<br/>Requested by the client: "let users define what types of format they want to use — a blog draft and LinkedIn won't be as applicable for B2C vs B2B." | dspraneeth07 | 08-Sep-2026 | 2 |
| 17 | `b090ef2` | Fresh addition | **feat(onboarding): capture the business and its audience**<br/>The content engine already handles consumer and business audiences properly (audienceToPrompt, contentRulesFor). Onboarding collected neither, so every new workspace fell through to the fallback path -- "has not described its buyers yet" -- and got a generic business reader with B2B writing rules. | srbaggari | 17-Sep-2026 | 2 |
| 18 | `127a692` | Fix | **fix: audience validation, image variations, campaign states, query cost**<br/>Four workstreams, each starting from a defect invisible at current data volume. | srbaggari | 17-Sep-2026 | 1 |
| 19 | `c8bbf70` | Fresh addition | **feat(context): add Business Context service with validated updates**<br/>Aura features now read and write business information through one service instead of each keeping its own copy. | srbaggari | 30-Sep-2026 | 6 |
| 20 | `a3e3568` | Fix | **fix(context): stop concurrent writes erasing each other; ignore whitespace-only "changes"**<br/>Lost updates: Company.preferences is one JSON bag written by read-merge-write from both the Business Context write service and the autopilot settings route. Overlapping writes let the later one erase the earlier (e.g. a goal edit vanishing while AI voice generation saved). | srbaggari | 01-Oct-2026 | 1 |
| 21 | `7b5fa6e` | Fresh addition | **feat(content): configurable compliance & policy checks before approval**<br/>Every draft is checked against configurable rules for its content and channel before it can be submitted or approved. | srbaggari | 13-Oct-2026 | 1 |
| 22 | `a68c4c8` | Fresh addition | **feat(execution): Meta V1 integration, execution model and state machine, provider routing, timezones**<br/>Execution job model: one Execution per (post, network) with workspace, recommendation, opportunity, content/assets, approved version, channel, provider, connection, target page/profile, schedule, status, attempts, provider response and error; ExecutionEvent for every state change; | srbaggari | 21-Oct-2026 | 1 |
| 23 | `183a772` | Fresh addition | **feat(content, meta, launch): Content Studio control, image refinement and preview, Meta review prep, production readiness**<br/>Content Studio; Recommendations workspace: compare versions, use one (others kept), edit, refine, regenerate or revert ONE version, add 1-3 more recommendations; Per-version CTA, website, address, phone and email (post details), never written by the AI; typed details must be confirmed before approval; | srbaggari | 22-Oct-2026 | 2 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
