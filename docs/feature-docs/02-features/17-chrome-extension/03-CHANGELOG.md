# Chrome Extension (Human Action Layer) — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 26 Jul 2026 (`d648252` — feat(extension): Module 2 — Chrome Extension v1, the human action layer (Sprint 4)) |
| Last changed | 16 Oct 2026 (`6672bf3`) |
| Commits | 13 |
| Days with changes | 9 |
| Lines in this feature's files | +3,196 / −93 |
| By status | Fresh addition 10, Fix 2, Update 1 |
| Committed by | dspraneeth07 (8), srbaggari (4), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 4 – Competitors, Extension, Outreach | 4 | 26 Jul |
| Sprint 5 – Lead Discovery & Marketing Memory | 1 | 26 Jul |
| Sprint 6 – Campaigns, Analytics, Billing | 1 | 27 Jul |
| Client feedback & UX review | 2 | 31 Jul – 24 Aug |
| AI graphics, autonomy & guided setup | 1 | 01 Sep |
| Client requests, image providers & performance | 1 | 07 Sep |
| Sprint 9 – Recommendation to Content | 3 | 13 Oct – 16 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `d648252` | Fresh addition | **feat(extension): Module 2 — Chrome Extension v1, the human action layer (Sprint 4)**<br/>The architectural centerpiece: every LinkedIn action happens through a real human clicking inside their own browser. The backend never touches linkedin.com. | dspraneeth07 | 26-Jul-2026 | 21 |
| 2 | `fdde091` | Fresh addition | **feat(outreach): Module 3 — Outreach Intelligence (Sprint 4)**<br/>Detect leads from LEGITIMATE public signal, draft brand-voice-grounded outreach, approve it, and hand approved items to the extension queue for a human send. | dspraneeth07 | 26-Jul-2026 | 2 |
| 3 | `cb77149` | Fresh addition | **feat(engagement): Module 4 — Engagement Copilot (Sprint 4)**<br/>AI-drafted LinkedIn comments for posts the user is ALREADY viewing — drafted and posted from the extension, with the web app as the read-only system of record. | dspraneeth07 | 26-Jul-2026 | 5 |
| 4 | `31bbbbd` | Update | **docs(sprint4): README + .env.example + extension README for all 4 modules**<br/>Documents Competitor Intelligence, the Chrome Extension, Outreach, and Engagement Copilot; new optional env (GITHUB_TOKEN, CRUNCHBASE_API_KEY, EXTENSION_ALLOWED_ORIGIN); and the new CRON_SECRET-protected cron endpoints. | dspraneeth07 | 26-Jul-2026 | 1 |
| 5 | `8755674` | Fresh addition | **feat(memory): Module 2 — Marketing Memory / Learning Loop (Sprint 5)**<br/>The retention/moat feature: the product remembers what works and feeds it back into every future generation. | dspraneeth07 | 26-Jul-2026 | 3 |
| 6 | `f4ee9be` | Fresh addition | **feat(hardening): Module 4 — production hardening (Sprint 6)**<br/>multi-tenant isolation tests (release-blocker, NON-NEGOTIABLE #3): prove a user acting for company B cannot read company A's campaigns, leads, content, or billing via the real scoped getters. Full migration chain (Sprint 1-6) verified to apply cleanly on a fresh database.; | dspraneeth07 | 27-Jul-2026 | 1 |
| 7 | `cbb746b` | Fix | **fix(extension,metrics): reliable composer injection + honest metrics matching**<br/>extension: inject into LinkedIn's Quill composer/comment box via execCommand('insertText') (goes through the editor's real input pipeline — raw DOM writes get reverted by Quill) with broader selectors + a clearer clipboard fallback ("copied — press Ctrl+V").; | dspraneeth07 | 31-Jul-2026 | 1 |
| 8 | `45618d2` | Fresh addition | **feat: consolidated client feedback — Phases 1–3**<br/>Phase 1 (critical fixes). Five of the seven reported issues had root causes different from the symptom: | dspraneeth07 | 24-Aug-2026 | 8 |
| 9 | `2b82ea8` | Fresh addition | **feat(content-studio): AI graphic generation, media attachment and platform-aware publishing**<br/>Content Studio can now read a generated post, work out what it is about, write an image prompt for it, produce a graphic, attach it to the post and push the whole thing into the EXISTING publishing queue. | srbaggari | 01-Sep-2026 | 6 |
| 10 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 11 | `756ce60` | Fresh addition | **feat(approval): unified approval model for content, campaigns and outreach**<br/>One set of states, transitions and approval records for Content Studio drafts, campaign tasks and outreach messages (lib/approval.ts, server/approval/approval.service.ts). No migration: the unified state is derived from each module's status and schedule; | srbaggari | 13-Oct-2026 | 2 |
| 12 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 2 |
| 13 | `6672bf3` | Fresh addition | **feat(sprint9): campaign/outreach creation, execution handoff, permissions, failure recovery, E2E**<br/>Connect Campaign & Outreach Creation; Campaign and Outreach creation handoffs from eligible recommendations (lib/creation-handoff.ts): recommendation context, audience, goal, CTA, channel and content requirements mapped with their sources; gaps stated, nothing invented. | srbaggari | 16-Oct-2026 | 4 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
