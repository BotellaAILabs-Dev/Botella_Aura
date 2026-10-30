# Connections, Connectors & OAuth — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`f00f1af` — feat(linkedin): official OAuth connect/disconnect + Connections UI) |
| Last changed | 27 Oct 2026 (`fc62acb`) |
| Commits | 19 |
| Days with changes | 14 |
| Lines in this feature's files | +8,088 / −311 |
| By status | Fresh addition 13, Fix 5, Change 1 |
| Committed by | dspraneeth07 (12), srbaggari (6), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 2 – Trends, AI & LinkedIn | 1 | 23 Jul |
| Sprint 3 – Content Studio & Knowledge | 1 | 23 Jul |
| Client feedback & UX review | 6 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 1 | 01 Sep |
| Client requests, image providers & performance | 2 | 07 Sep – 08 Sep |
| Sprint 9 – Recommendation to Content | 2 | 14 Oct |
| Sprint 10 – Connections & Execution | 3 | 17 Oct – 22 Oct |
| Post-review hardening | 3 | 27 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `f00f1af` | Fresh addition | **feat(linkedin): official OAuth connect/disconnect + Connections UI**<br/>Company-scoped OpenID Connect flow (dedicated routes, not NextAuth sign-in): CSRF-protected connect, callback that exchanges the code and stores tokens AES-256-GCM encrypted at rest, and disconnect that best-effort revokes then deletes credentials. | dspraneeth07 | 23-Jul-2026 | 5 |
| 2 | `b9d41bd` | Fresh addition | **feat(content): brand voice, generator, approval + publish services**<br/>Brand Voice Profile (Claude-analyzed, human-editable) injected into every generation; generator for 4 content types (retrieve KB -&gt; inject voice -&gt; Zod-validate); approval state machine where PUBLISHED is reachable ONLY from APPROVED (service-layer guarantee); | dspraneeth07 | 23-Jul-2026 | 1 |
| 3 | `48a4f76` | Fresh addition | **feat(linkedin): personal-profile API publishing + fix stale API version**<br/>request w_member_social (the self-serve "Share on LinkedIn" scope) so approved LinkedIn posts publish straight to the connected member's own profile via the official /rest/posts API — no extension, no company-page Marketing approval.; | dspraneeth07 | 31-Jul-2026 | 1 |
| 4 | `d996c48` | Change | **polish(ui): remove internal "Sprint N" labels + working overview + more trends**<br/>strip all customer-facing "Sprint N" wording from the UI (overview, sidebar chips, onboarding, coming-soon, settings, leads, LinkedIn card, reset page).; rewrite the dashboard overview: the empty-state cards were disabled teasers (the "Connect" button did nothing) — now every card is a real link to its live feature (Co… | dspraneeth07 | 31-Jul-2026 | 1 |
| 5 | `dc5e65b` | Fresh addition | **feat: Viewer role, Resend emails, Connectors module, geo trend filters**<br/>Read-only VIEWER role (enum + RBAC content:create gate + team UI). A viewer can browse but cannot create content or change settings.; Real invite/reset emails via Resend when RESEND_API_KEY is set (REST API, no new dep); falls back to console so a mail outage never breaks flows.; | dspraneeth07 | 07-Aug-2026 | 2 |
| 6 | `ef9dd58` | Fix | **fix/feat: campaign selector, lead fit score, invite status, connectors, extension beta**<br/>Broken-flow + visibility fixes from client review:; Campaign selector: no more dead "— none —" — loads campaigns and defaults to the first; shows an empty-state (+ link to Campaigns) and disables "From a campaign" when none exist. Generate is guarded.; | dspraneeth07 | 13-Aug-2026 | 1 |
| 7 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 10 |
| 8 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 10 |
| 9 | `2b82ea8` | Fresh addition | **feat(content-studio): AI graphic generation, media attachment and platform-aware publishing**<br/>Content Studio can now read a generated post, work out what it is about, write an image prompt for it, produce a graphic, attach it to the post and push the whole thing into the EXISTING publishing queue. | srbaggari | 01-Sep-2026 | 3 |
| 10 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 11 | `dab7355` | Fresh addition | **feat(publishing): publish to Facebook Pages**<br/>Requested by the client: "add Facebook as an option." | dspraneeth07 | 08-Sep-2026 | 1 |
| 12 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 15 |
| 13 | `aeaf1c8` | Fix | **fix(whatsapp,publishing): post-implementation audit fixes; JPEG for Instagram**<br/>Found in the post-implementation audit and fixed:; A pending approve/publish now lapses on any account command too ("menu", "switch", logout, workspace), so a later "ok" cannot run it.; | srbaggari | 14-Oct-2026 | 1 |
| 14 | `73b0ad3` | Fresh addition | **feat(connections): Connection Manager, connection flow, capabilities, token lifecycle, health**<br/>Connection Manager data model: provider, channels, provider account id, granted scopes, credential reference, setup stage, health, execution history, capabilities; ConnectedAccount table for provider -&gt; account -&gt; page relationships; LinkedIn mirrored without its token; REVOKED status. | srbaggari | 17-Oct-2026 | 26 |
| 15 | `a68c4c8` | Fresh addition | **feat(execution): Meta V1 integration, execution model and state machine, provider routing, timezones**<br/>Execution job model: one Execution per (post, network) with workspace, recommendation, opportunity, content/assets, approved version, channel, provider, connection, target page/profile, schedule, status, attempts, provider response and error; ExecutionEvent for every state change; | srbaggari | 21-Oct-2026 | 6 |
| 16 | `183a772` | Fresh addition | **feat(content, meta, launch): Content Studio control, image refinement and preview, Meta review prep, production readiness**<br/>Content Studio; Recommendations workspace: compare versions, use one (others kept), edit, refine, regenerate or revert ONE version, add 1-3 more recommendations; Per-version CTA, website, address, phone and email (post details), never written by the AI; typed details must be confirmed before approval; | srbaggari | 22-Oct-2026 | 6 |
| 17 | `0965b7c` | Fresh addition | **feat(auth): sign in with LinkedIn, and one list of every redirect URI**<br/>LinkedIn sign-in, defined here rather than taken from next-auth/providers/linkedin: the bundled provider still calls the retired /v2/me profile API with an r_liteprofile projection, scopes a LinkedIn app created today is not granted. | dspraneeth07 | 27-Oct-2026 | 1 |
| 18 | `0572bf2` | Fresh addition | **feat(sandbox): Facebook and Instagram join the local stand-in for Meta**<br/>WhatsApp could already be exercised without a Meta account. Facebook and Instagram could not be exercised at all: between them they need a Meta app, a Page, an Instagram professional account linked to it, and a token that expires in about a day, so the publishers — including Instagram's container-and-poll cycle, the lo… | dspraneeth07 | 27-Oct-2026 | 2 |
| 19 | `fc62acb` | Fix | **fix(verify): the refusal suites say which Meta they need, instead of failing**<br/>Making the sandbox work broke four suites, and the breakage is inherent rather than a bug: they check what Aura does when Meta REFUSES a credential — that nothing is marked published, that reauthorization is asked for — and a stand-in that accepts cannot show any of it. | dspraneeth07 | 27-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
