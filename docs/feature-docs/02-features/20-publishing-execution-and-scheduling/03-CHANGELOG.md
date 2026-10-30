# Publishing, Execution Engine & Scheduling — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`b9d41bd` — feat(content): brand voice, generator, approval + publish services) |
| Last changed | 22 Oct 2026 (`183a772`) |
| Commits | 16 |
| Days with changes | 12 |
| Lines in this feature's files | +3,795 / −182 |
| By status | Fresh addition 13, Fix 3 |
| Committed by | srbaggari (10), dspraneeth07 (6) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 3 – Content Studio & Knowledge | 2 | 23 Jul |
| Client feedback & UX review | 1 | 31 Jul |
| AI graphics, autonomy & guided setup | 4 | 01 Sep – 03 Sep |
| Client requests, image providers & performance | 1 | 08 Sep |
| Sprint 8 – Recommendations | 1 | 06 Oct |
| Sprint 9 – Recommendation to Content | 4 | 13 Oct – 16 Oct |
| Sprint 10 – Connections & Execution | 3 | 17 Oct – 22 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `b9d41bd` | Fresh addition | **feat(content): brand voice, generator, approval + publish services**<br/>Brand Voice Profile (Claude-analyzed, human-editable) injected into every generation; generator for 4 content types (retrieve KB -&gt; inject voice -&gt; Zod-validate); approval state machine where PUBLISHED is reachable ONLY from APPROVED (service-layer guarantee); | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `a2e0e83` | Fresh addition | **feat(content): Content Studio API routes**<br/>Knowledge sync/upload, brand-voice generate/edit, content generate/refine, draft edit + approval transitions + publish + schedule + bulk, campaigns, and the protected scheduled-publish cron. Zod-validated; RBAC on publish/schedule. | dspraneeth07 | 23-Jul-2026 | 1 |
| 3 | `48a4f76` | Fresh addition | **feat(linkedin): personal-profile API publishing + fix stale API version**<br/>request w_member_social (the self-serve "Share on LinkedIn" scope) so approved LinkedIn posts publish straight to the connected member's own profile via the official /rest/posts API — no extension, no company-page Marketing approval.; | dspraneeth07 | 31-Jul-2026 | 1 |
| 4 | `2b82ea8` | Fresh addition | **feat(content-studio): AI graphic generation, media attachment and platform-aware publishing**<br/>Content Studio can now read a generated post, work out what it is about, write an image prompt for it, produce a graphic, attach it to the post and push the whole thing into the EXISTING publishing queue. | srbaggari | 01-Sep-2026 | 1 |
| 5 | `f537101` | Fresh addition | **feat(publishing): recommend when to publish, and act on it under settings**<br/>Audited the seven capabilities against what actually exists. Understanding the business, generating content and creatives, monitoring performance and proactively preparing work were all already there. Two were genuinely missing, and they turned out to be the same gap seen from both ends. | srbaggari | 03-Sep-2026 | 1 |
| 6 | `bd97890` | Fix | **fix(cron): make scheduled jobs actually run on Vercel**<br/>Twelve cron routes existed and none of them could ever fire in production. | dspraneeth07 | 03-Sep-2026 | 1 |
| 7 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 1 |
| 8 | `dab7355` | Fresh addition | **feat(publishing): publish to Facebook Pages**<br/>Requested by the client: "add Facebook as an option." | dspraneeth07 | 08-Sep-2026 | 1 |
| 9 | `2979cf1` | Fresh addition | **feat(content-studio): platform-aware, quality-checked AI copywriting**<br/>Turns Content Studio from prompt-to-text into a marketing assistant, built on the existing generator and Business Context (no parallel systems). | srbaggari | 06-Oct-2026 | 1 |
| 10 | `756ce60` | Fresh addition | **feat(approval): unified approval model for content, campaigns and outreach**<br/>One set of states, transitions and approval records for Content Studio drafts, campaign tasks and outreach messages (lib/approval.ts, server/approval/approval.service.ts). No migration: the unified state is derived from each module's status and schedule; | srbaggari | 13-Oct-2026 | 1 |
| 11 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 2 |
| 12 | `aeaf1c8` | Fix | **fix(whatsapp,publishing): post-implementation audit fixes; JPEG for Instagram**<br/>Found in the post-implementation audit and fixed:; A pending approve/publish now lapses on any account command too ("menu", "switch", logout, workspace), so a later "ok" cannot run it.; | srbaggari | 14-Oct-2026 | 1 |
| 13 | `6672bf3` | Fresh addition | **feat(sprint9): campaign/outreach creation, execution handoff, permissions, failure recovery, E2E**<br/>Connect Campaign & Outreach Creation; Campaign and Outreach creation handoffs from eligible recommendations (lib/creation-handoff.ts): recommendation context, audience, goal, CTA, channel and content requirements mapped with their sources; gaps stated, nothing invented. | srbaggari | 16-Oct-2026 | 4 |
| 14 | `73b0ad3` | Fresh addition | **feat(connections): Connection Manager, connection flow, capabilities, token lifecycle, health**<br/>Connection Manager data model: provider, channels, provider account id, granted scopes, credential reference, setup stage, health, execution history, capabilities; ConnectedAccount table for provider -&gt; account -&gt; page relationships; LinkedIn mirrored without its token; REVOKED status. | srbaggari | 17-Oct-2026 | 3 |
| 15 | `a68c4c8` | Fresh addition | **feat(execution): Meta V1 integration, execution model and state machine, provider routing, timezones**<br/>Execution job model: one Execution per (post, network) with workspace, recommendation, opportunity, content/assets, approved version, channel, provider, connection, target page/profile, schedule, status, attempts, provider response and error; ExecutionEvent for every state change; | srbaggari | 21-Oct-2026 | 16 |
| 16 | `183a772` | Fresh addition | **feat(content, meta, launch): Content Studio control, image refinement and preview, Meta review prep, production readiness**<br/>Content Studio; Recommendations workspace: compare versions, use one (others kept), edit, refine, regenerate or revert ONE version, add 1-3 more recommendations; Per-version CTA, website, address, phone and email (post details), never written by the AI; typed details must be confirmed before approval; | srbaggari | 22-Oct-2026 | 3 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
