# Knowledge Base & Brand Voice — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`64c9b5a` — feat(ui): design system foundation) |
| Last changed | 09 Oct 2026 (`1063040`) |
| Commits | 16 |
| Days with changes | 11 |
| Lines in this feature's files | +2,358 / −125 |
| By status | Fresh addition 13, Fix 3 |
| Committed by | dspraneeth07 (8), srbaggari (7), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Sprint 3 – Content Studio & Knowledge | 4 | 23 Jul |
| Client feedback & UX review | 3 | 31 Jul – 10 Aug |
| AI graphics, autonomy & guided setup | 2 | 02 Sep – 03 Sep |
| Client requests, image providers & performance | 2 | 07 Sep – 17 Sep |
| Sprint 7 – Business Context & Opportunities | 3 | 29 Sep – 30 Sep |
| Sprint 9 – Recommendation to Content | 1 | 09 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `64c9b5a` | Fresh addition | **feat(ui): design system foundation**<br/>Premium slate + indigo-violet token system (light/dark) and the reusable primitives every sprint needs: Button, Card, Input, Textarea, Label, Badge (with ContentStatus mapping), Dialog, DropdownMenu, Avatar, EmptyState, Toaster, and the brand Logo. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `1286a84` | Fresh addition | **feat(knowledge): ingestion pipeline + retrieval**<br/>Website ingestion (robots.txt-compliant, throttled, feed discovery), blog/RSS, and .txt/.md/.pdf uploads; paragraph-aware chunking; keyword+recency retrieval grounding generation. Idempotent per source. Semantic/vector search flagged as a backlog upgrade (future Python ML service). | dspraneeth07 | 23-Jul-2026 | 5 |
| 3 | `b9d41bd` | Fresh addition | **feat(content): brand voice, generator, approval + publish services**<br/>Brand Voice Profile (Claude-analyzed, human-editable) injected into every generation; generator for 4 content types (retrieve KB -&gt; inject voice -&gt; Zod-validate); approval state machine where PUBLISHED is reachable ONLY from APPROVED (service-layer guarantee); | dspraneeth07 | 23-Jul-2026 | 1 |
| 4 | `a2e0e83` | Fresh addition | **feat(content): Content Studio API routes**<br/>Knowledge sync/upload, brand-voice generate/edit, content generate/refine, draft edit + approval transitions + publish + schedule + bulk, campaigns, and the protected scheduled-publish cron. Zod-validated; RBAC on publish/schedule. | dspraneeth07 | 23-Jul-2026 | 3 |
| 5 | `c71046e` | Fresh addition | **feat(content): Content Studio UI (queue, editor, calendar, KB)**<br/>Approval queue (kanban + bulk actions + create dialog), per-type draft preview (LinkedIn card / carousel / thread / blog) with edit/refine/regenerate/approve/ reject/publish/schedule, trend hand-off page (Sprint 2 button now works), content calendar, and the knowledge-base + brand-voice settings page. | dspraneeth07 | 23-Jul-2026 | 1 |
| 6 | `ae01e19` | Fix | **fix(knowledge): extract brand copy from JavaScript-rendered sites**<br/>Sites built with Framer/Webflow/React serve almost no body text (the copy is painted by JS), so the crawler produced 0 chunks and the AI had no brand voice. Now htmlToText also reads &lt;title&gt;, meta description, Open Graph, and JSON-LD (the SEO copy JS sites always ship in HTML — we still never execute page JS). | dspraneeth07 | 31-Jul-2026 | 4 |
| 7 | `80d4462` | Fresh addition | **feat(content): live-fetch reference URLs; fix(kb): clearer PDF errors**<br/>Content generation now detects URLs in the brief (or the company website) and fetches those pages LIVE (robots-polite, no JS exec), injecting the real page text as grounding — so "write about our flagship product: &lt;url&gt;" reads the actual page instead of producing generic copy. Records referenceUsed in draft aiMetadata. | dspraneeth07 | 07-Aug-2026 | 1 |
| 8 | `ea1e976` | Fix | **fix/improve: SMTP email, PDF upload, content speed, outreach history, lead dedup**<br/>Email: add SMTP transport (nodemailer) — works with any SMTP provider (Gmail app password, SendGrid, SES, etc.). Selection: SMTP → Resend → console.; Knowledge base: PDF upload route pinned to Node runtime + 60s maxDuration + a clear ~4MB size guard (serverless body cap) so big/scanned PDFs fail with an actionable mess… | dspraneeth07 | 10-Aug-2026 | 1 |
| 9 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 1 |
| 10 | `6045fcb` | Fresh addition | **feat(knowledge): learn from real business materials, by kind**<br/>Two things stopped Aura learning from a company's actual documents. | srbaggari | 03-Sep-2026 | 8 |
| 11 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 12 | `5bb000f` | Fresh addition | **feat(brand): connect brand knowledge to every AI workflow**<br/>Brand knowledge was assembled independently at each AI call site, and every one picked a different subset. An audit of the workflows that call a model found brand voice wired into most of them -- and the business description and audience wired into two. | srbaggari | 17-Sep-2026 | 1 |
| 13 | `b3c4f0f` | Fresh addition | **feat(context): add unified Business Context data model**<br/>One structure for everything Aura knows about a workspace's business, so onboarding, AI workflows, recommendations, content, analytics and memory read the same facts through the same rules. | srbaggari | 29-Sep-2026 | 1 |
| 14 | `c8bbf70` | Fresh addition | **feat(context): add Business Context service with validated updates**<br/>Aura features now read and write business information through one service instead of each keeping its own copy. | srbaggari | 30-Sep-2026 | 1 |
| 15 | `ea0f2af` | Fresh addition | **feat(context): add source, confidence and freshness to business facts**<br/>Every business fact Aura uses is now traceable to where it came from and how reliable and current it is, and AI workflows never receive an unconfirmed assumption as a verified fact. | srbaggari | 30-Sep-2026 | 1 |
| 16 | `1063040` | Fresh addition | **feat(content): context assembly for content generation**<br/>The generation model now receives one assembled context package per draft (lib/generation-context.ts), instead of the live business context plus unfiltered knowledge and fetched pages. | srbaggari | 09-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
