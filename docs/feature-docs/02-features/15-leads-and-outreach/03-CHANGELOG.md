# Lead Discovery & Outreach Intelligence — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`4db020e` — feat(dashboard): persistent app shell + settings) |
| Last changed | 16 Oct 2026 (`6672bf3`) |
| Commits | 28 |
| Days with changes | 18 |
| Lines in this feature's files | +7,746 / −391 |
| By status | Fresh addition 18, Fix 8, Change 1, Update 1 |
| Committed by | dspraneeth07 (17), srbaggari (10), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Sprint 4 – Competitors, Extension, Outreach | 1 | 26 Jul |
| Sprint 5 – Lead Discovery & Marketing Memory | 2 | 26 Jul |
| Sprint 6 – Campaigns, Analytics, Billing | 1 | 27 Jul |
| Client feedback & UX review | 9 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 5 | 01 Sep – 03 Sep |
| Client requests, image providers & performance | 3 | 07 Sep – 17 Sep |
| Sprint 7 – Business Context & Opportunities | 2 | 29 Sep – 01 Oct |
| Sprint 9 – Recommendation to Content | 4 | 13 Oct – 16 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `fdde091` | Fresh addition | **feat(outreach): Module 3 — Outreach Intelligence (Sprint 4)**<br/>Detect leads from LEGITIMATE public signal, draft brand-voice-grounded outreach, approve it, and hand approved items to the extension queue for a human send. | dspraneeth07 | 26-Jul-2026 | 25 |
| 3 | `1700ba5` | Fresh addition | **feat(leads): Module 1 — Lead Discovery Engine (Sprint 5)**<br/>Proactive, criteria-based prospecting on top of Sprint 4's reactive outreach. | dspraneeth07 | 26-Jul-2026 | 19 |
| 4 | `8755674` | Fresh addition | **feat(memory): Module 2 — Marketing Memory / Learning Loop (Sprint 5)**<br/>The retention/moat feature: the product remembers what works and feeds it back into every future generation. | dspraneeth07 | 26-Jul-2026 | 4 |
| 5 | `fc794a1` | Fresh addition | **feat(billing): Module 3 — Stripe subscriptions + entitlements (Sprint 6)**<br/>Subscription model mirrored from Stripe via SIGNATURE-VERIFIED webhooks (/api/webhooks/stripe): the signing secret is checked before any payload is trusted; unverified/tampered requests are rejected with 400 and never touch the DB (NON-NEGOTIABLE #4). | dspraneeth07 | 27-Jul-2026 | 1 |
| 6 | `cbb746b` | Fix | **fix(extension,metrics): reliable composer injection + honest metrics matching**<br/>extension: inject into LinkedIn's Quill composer/comment box via execCommand('insertText') (goes through the editor's real input pipeline — raw DOM writes get reverted by Quill) with broader selectors + a clearer clipboard fallback ("copied — press Ctrl+V").; | dspraneeth07 | 31-Jul-2026 | 1 |
| 7 | `d996c48` | Change | **polish(ui): remove internal "Sprint N" labels + working overview + more trends**<br/>strip all customer-facing "Sprint N" wording from the UI (overview, sidebar chips, onboarding, coming-soon, settings, leads, LinkedIn card, reset page).; rewrite the dashboard overview: the empty-state cards were disabled teasers (the "Connect" button did nothing) — now every card is a real link to its live feature (Co… | dspraneeth07 | 31-Jul-2026 | 1 |
| 8 | `ea1e976` | Fix | **fix/improve: SMTP email, PDF upload, content speed, outreach history, lead dedup**<br/>Email: add SMTP transport (nodemailer) — works with any SMTP provider (Gmail app password, SendGrid, SES, etc.). Selection: SMTP → Resend → console.; Knowledge base: PDF upload route pinned to Node runtime + 60s maxDuration + a clear ~4MB size guard (serverless body cap) so big/scanned PDFs fail with an actionable mess… | dspraneeth07 | 10-Aug-2026 | 5 |
| 9 | `ef9dd58` | Fix | **fix/feat: campaign selector, lead fit score, invite status, connectors, extension beta**<br/>Broken-flow + visibility fixes from client review:; Campaign selector: no more dead "— none —" — loads campaigns and defaults to the first; shows an empty-state (+ link to Campaigns) and disables "From a campaign" when none exist. Generate is guarded.; | dspraneeth07 | 13-Aug-2026 | 2 |
| 10 | `8e2daed` | Fresh addition | **feat(P1): outreach sequence+stepper, marketing-memory correction, content hashtag separation**<br/>Outreach: messages now render in send order (connection note first, then numbered follow-ups) with a visible progression stepper Draft -&gt; Pending -&gt; Approved -&gt; Queued -&gt; Sent (approve = queued in the extension). Sequence explainer + rejected state.; | dspraneeth07 | 17-Aug-2026 | 2 |
| 11 | `bed5963` | Fresh addition | **feat(P2/P3): validation + guidance polish sweep**<br/>Shared LinkedIn URL validator (lib/linkedin-url.ts): validates and distinguishes person (/in/) vs company (/company/) pages. Wired into create-lead, outreach edit-lead, and engagement-target inputs with live person/company hints + blocking on invalid input.; | dspraneeth07 | 17-Aug-2026 | 6 |
| 12 | `0328c42` | Fix | **fix(leads-table): separate Company/Contact columns + fit score X/100 with why (UX review criticals)**<br/>Split the merged 'Lead' column into distinct Company and Contact columns; company-only leads clearly marked 'no contact yet'.; Fit score now shows the scale (X/100) with the 'why this score' rationale on hover, matching the outreach board. | dspraneeth07 | 17-Aug-2026 | 2 |
| 13 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 18 |
| 14 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 8 |
| 15 | `96c1f1a` | Fresh addition | **feat: confidence-gated bulk approval + app-wide background job indicator**<br/>Closes the last two gaps against the screens review. | dspraneeth07 | 01-Sep-2026 | 4 |
| 16 | `26bc4de` | Update | **chore: declare the two config routes dynamic**<br/>Both read the session via headers(), so Next could never statically prerender them — it attempted anyway on every build and logged a fallback for each. Now that captureException also logs stack traces, that noise filled the build output with what look like errors but are not. | dspraneeth07 | 01-Sep-2026 | 1 |
| 17 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 3 |
| 18 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 2 |
| 19 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 3 |
| 20 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 2 |
| 21 | `127a692` | Fix | **fix: audience validation, image variations, campaign states, query cost**<br/>Four workstreams, each starting from a defect invisible at current data volume. | srbaggari | 17-Sep-2026 | 2 |
| 22 | `5bb000f` | Fresh addition | **feat(brand): connect brand knowledge to every AI workflow**<br/>Brand knowledge was assembled independently at each AI call site, and every one picked a different subset. An audit of the workflows that call a model found brand voice wired into most of them -- and the business description and audience wired into two. | srbaggari | 17-Sep-2026 | 1 |
| 23 | `b3c4f0f` | Fresh addition | **feat(context): add unified Business Context data model**<br/>One structure for everything Aura knows about a workspace's business, so onboarding, AI workflows, recommendations, content, analytics and memory read the same facts through the same rules. | srbaggari | 29-Sep-2026 | 2 |
| 24 | `720c22e` | Fresh addition | **feat(context): connect existing Aura sources to the Business Context layer**<br/>Audit every existing store of business information, map it into the unified context, connect the remaining AI workflows to the context service, and prove no business information is lost. | srbaggari | 01-Oct-2026 | 1 |
| 25 | `c33077b` | Fresh addition | **feat(review): unified review experience for generated Aura work**<br/>One review screen, one queue and one set of actions for every piece of generated work — Content Studio drafts (which campaigns, the planner, Autopilot and suggestions produce) and outreach messages. | srbaggari | 13-Oct-2026 | 4 |
| 26 | `756ce60` | Fresh addition | **feat(approval): unified approval model for content, campaigns and outreach**<br/>One set of states, transitions and approval records for Content Studio drafts, campaign tasks and outreach messages (lib/approval.ts, server/approval/approval.service.ts). No migration: the unified state is derived from each module's status and schedule; | srbaggari | 13-Oct-2026 | 4 |
| 27 | `000e1c7` | Fresh addition | **feat(versions): edit & version management for generated content**<br/>Every state of a Content Studio draft or outreach message is kept as a numbered version (lib/versions.ts, server/versions), in aiMetadata.versions — no migration. | srbaggari | 13-Oct-2026 | 2 |
| 28 | `6672bf3` | Fresh addition | **feat(sprint9): campaign/outreach creation, execution handoff, permissions, failure recovery, E2E**<br/>Connect Campaign & Outreach Creation; Campaign and Outreach creation handoffs from eligible recommendations (lib/creation-handoff.ts): recommendation context, audience, goal, CTA, channel and content requirements mapped with their sources; gaps stated, nothing invented. | srbaggari | 16-Oct-2026 | 10 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
