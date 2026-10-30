# Authentication & Accounts — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`7323404` — feat(auth): NextAuth authentication system + RBAC scaffold) |
| Last changed | 27 Oct 2026 (`0965b7c`) |
| Commits | 11 |
| Days with changes | 10 |
| Lines in this feature's files | +1,867 / −51 |
| By status | Fresh addition 7, Change 3, Fix 1 |
| Committed by | dspraneeth07 (9), srbaggari (2) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Sprint 3 – Content Studio & Knowledge | 1 | 23 Jul |
| Sprint 6 – Campaigns, Analytics, Billing | 1 | 27 Jul |
| Client feedback & UX review | 4 | 31 Jul – 24 Aug |
| AI graphics, autonomy & guided setup | 1 | 03 Sep |
| Client requests, image providers & performance | 1 | 17 Sep |
| Sprint 9 – Recommendation to Content | 1 | 14 Oct |
| Post-review hardening | 1 | 27 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `7323404` | Fresh addition | **feat(auth): NextAuth authentication system + RBAC scaffold**<br/>Email/password (bcrypt) + Google OAuth via NextAuth v4, JWT sessions with typed id/role, and edge middleware protecting /dashboard and /onboarding. Adds token-based password reset (hashed, single-use, no account enumeration), a role-&gt;permission RBAC matrix, AES-256-GCM helpers for tokens at rest, an email transport stu… | dspraneeth07 | 23-Jul-2026 | 22 |
| 2 | `b9d41bd` | Fresh addition | **feat(content): brand voice, generator, approval + publish services**<br/>Brand Voice Profile (Claude-analyzed, human-editable) injected into every generation; generator for 4 content types (retrieve KB -&gt; inject voice -&gt; Zod-validate); approval state machine where PUBLISHED is reachable ONLY from APPROVED (service-layer guarantee); | dspraneeth07 | 23-Jul-2026 | 1 |
| 3 | `f4ee9be` | Fresh addition | **feat(hardening): Module 4 — production hardening (Sprint 6)**<br/>multi-tenant isolation tests (release-blocker, NON-NEGOTIABLE #3): prove a user acting for company B cannot read company A's campaigns, leads, content, or billing via the real scoped getters. Full migration chain (Sprint 1-6) verified to apply cleanly on a fresh database.; | dspraneeth07 | 27-Jul-2026 | 3 |
| 4 | `d996c48` | Change | **polish(ui): remove internal "Sprint N" labels + working overview + more trends**<br/>strip all customer-facing "Sprint N" wording from the UI (overview, sidebar chips, onboarding, coming-soon, settings, leads, LinkedIn card, reset page).; rewrite the dashboard overview: the empty-state cards were disabled teasers (the "Connect" button did nothing) — now every card is a real link to its live feature (Co… | dspraneeth07 | 31-Jul-2026 | 1 |
| 5 | `67280d6` | Fresh addition | **feat(team): invite teammates + role-based access**<br/>Team collaboration on a workspace: invite by email (emailed single-use accept link, 7-day expiry), accept flow (/invite/[token]), role management (Owner/Admin/Member) and member removal — all RBAC-gated and audited. Hard invariant enforced in the service: a company can never be left without an owner. | dspraneeth07 | 07-Aug-2026 | 3 |
| 6 | `ea1e976` | Fix | **fix/improve: SMTP email, PDF upload, content speed, outreach history, lead dedup**<br/>Email: add SMTP transport (nodemailer) — works with any SMTP provider (Gmail app password, SendGrid, SES, etc.). Selection: SMTP → Resend → console.; Knowledge base: PDF upload route pinned to Node runtime + 60s maxDuration + a clear ~4MB size guard (serverless body cap) so big/scanned PDFs fail with an actionable mess… | dspraneeth07 | 10-Aug-2026 | 1 |
| 7 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 1 |
| 8 | `35bb33e` | Change | **perf(dashboard): stop navigations blocking, and stop re-querying auth**<br/>Three changes, in descending order of what a user actually feels. | dspraneeth07 | 03-Sep-2026 | 1 |
| 9 | `8f92dfc` | Change | **perf(auth): stop shipping bcryptjs to the browser**<br/>The auth pages carried more First Load JS than the entire dashboard: 289 kB on /login and /signup against 94-146 kB for every dashboard route. A login form should be the lightest page in the app. | srbaggari | 17-Sep-2026 | 3 |
| 10 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 4 |
| 11 | `0965b7c` | Fresh addition | **feat(auth): sign in with LinkedIn, and one list of every redirect URI**<br/>LinkedIn sign-in, defined here rather than taken from next-auth/providers/linkedin: the bundled provider still calls the retired /v2/me profile API with an r_liteprofile projection, scopes a LinkedIn app created today is not granted. | dspraneeth07 | 27-Oct-2026 | 8 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
