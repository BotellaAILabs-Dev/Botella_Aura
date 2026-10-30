# Media, Graphics & Marketing Creatives — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 01 Sep 2026 (`2b82ea8` — feat(content-studio): AI graphic generation, media attachment and platform-aware publishing) |
| Last changed | 27 Oct 2026 (`0572bf2`) |
| Commits | 35 |
| Days with changes | 17 |
| Lines in this feature's files | +12,492 / −699 |
| By status | Fresh addition 22, Fix 12, Update 1 |
| Committed by | srbaggari (28), dspraneeth07 (6), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| AI graphics, autonomy & guided setup | 8 | 01 Sep – 03 Sep |
| Client requests, image providers & performance | 12 | 07 Sep – 17 Sep |
| Sprint 7 – Business Context & Opportunities | 1 | 01 Oct |
| Sprint 8 – Recommendations | 1 | 06 Oct |
| Sprint 9 – Recommendation to Content | 7 | 12 Oct – 16 Oct |
| Sprint 10 – Connections & Execution | 3 | 17 Oct – 22 Oct |
| Post-review hardening | 3 | 26 Oct – 27 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `2b82ea8` | Fresh addition | **feat(content-studio): AI graphic generation, media attachment and platform-aware publishing**<br/>Content Studio can now read a generated post, work out what it is about, write an image prompt for it, produce a graphic, attach it to the post and push the whole thing into the EXISTING publishing queue. | srbaggari | 01-Sep-2026 | 21 |
| 2 | `df858cf` | Update | **Add comprehensive tests for graphic studio and media validation**<br/>Implement tests for the GraphicStudio component, covering various user interactions and edge cases.; Add tests for image aspect ratio calculations and validations.; Introduce tests for image prompt generation and style handling.; Create tests for image provider configurations and validations.; | srbaggari | 01-Sep-2026 | 3 |
| 3 | `63cd095` | Fresh addition | **feat(content-studio): user-supplied graphics and the Custom format**<br/>Closes the two gaps against the Graphic Generation spec. | srbaggari | 02-Sep-2026 | 5 |
| 4 | `7da7d0e` | Fix | **fix(graphics): close three correctness gaps in generation and upload**<br/>1. Editing the prompt mid-run returned the OLD prompt's images. | srbaggari | 02-Sep-2026 | 2 |
| 5 | `165d1c1` | Fresh addition | **feat(agent): Aura works for you — autonomous weekly cycle and briefing home**<br/>Aura was a dashboard with twelve separate AI tools. The capability to be an employee was already there — eleven cron jobs, a campaign orchestrator, a monthly planner, advisor opportunities, intelligence snapshots, competitor reports, marketing memory. | srbaggari | 02-Sep-2026 | 2 |
| 6 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 1 |
| 7 | `94e3926` | Fresh addition | **feat(onboarding): guide setup as a sequence, derived from real data**<br/>Setup was a three-step wizard followed by a loose list of four suggestions. The wizard ended with "You're all set", which was not true — Aura knew the company name and nothing else — and the four suggestions had no order, no sense of whether you had done them, and no statement of what any of them would buy you. | srbaggari | 03-Sep-2026 | 1 |
| 8 | `caf8e50` | Fix | **fix(graphics): call a Google image model the API key can actually reach**<br/>Generation failed on every attempt with "Google could not generate the image (HTTP 404)", and the job then sat in "retrying" until the client gave up with "this is taking longer than expected". Three separate defects, each hiding the next. | dspraneeth07 | 03-Sep-2026 | 1 |
| 9 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 1 |
| 10 | `788d418` | Fix | **fix(jobs): stop retrying failures that cannot succeed**<br/>Image generation "goes into a loop and doesn't work" — reported by the client, and reproducible from the job rows: status QUEUED, progress "Hit a snag — retrying…", an error already recorded saying exactly why the run could never work. | dspraneeth07 | 08-Sep-2026 | 1 |
| 11 | `dab7355` | Fresh addition | **feat(publishing): publish to Facebook Pages**<br/>Requested by the client: "add Facebook as an option." | dspraneeth07 | 08-Sep-2026 | 1 |
| 12 | `127a692` | Fix | **fix: audience validation, image variations, campaign states, query cost**<br/>Four workstreams, each starting from a defect invisible at current data volume. | srbaggari | 17-Sep-2026 | 2 |
| 13 | `5bb000f` | Fresh addition | **feat(brand): connect brand knowledge to every AI workflow**<br/>Brand knowledge was assembled independently at each AI call site, and every one picked a different subset. An audit of the workflows that call a model found brand voice wired into most of them -- and the business description and audience wired into two. | srbaggari | 17-Sep-2026 | 1 |
| 14 | `c8cbd50` | Fix | **fix(images): name the Google provider accurately and explain the quota**<br/>Two problems visible at the exact moment a generation fails. | srbaggari | 17-Sep-2026 | 1 |
| 15 | `6311973` | Fresh addition | **feat(images): add Agnes AI as a Content Studio model**<br/>Agnes now appears in the model selector alongside OpenAI, Google Gemini, Stability and Replicate, and produces assets that are indistinguishable downstream: same gallery, same attachment, same platform validation, same publishing. | srbaggari | 17-Sep-2026 | 3 |
| 16 | `2071e8a` | Fix | **fix(images): accept AGNES in the request schema**<br/>Selecting Agnes in the Content Studio failed with a bare "Validation failed". IMAGE_PROVIDERS in lib/validations/media.ts is a hand-written mirror of the Prisma ImageProvider enum, and the previous commit added AGNES to the enum and the registry but not to that list -- so the studio offered a model whose requests the s… | srbaggari | 17-Sep-2026 | 1 |
| 17 | `fbe34c6` | Fix | **fix(agnes): point at the API routes that actually exist**<br/>The base URL was /v1, which returns 404 for every path on this host. Probing showed the same paths under /api/v1 returning 401 — so the routes live there, and /v1 is a plausible-looking guess that can never work whatever credential is supplied. | srbaggari | 17-Sep-2026 | 1 |
| 18 | `3c7916e` | Fix | **fix(images): stop parking doomed generations at 10% forever**<br/>A generation could sit at "Hit a snag — retrying… 10%" indefinitely while the client eventually gave up with "this is taking longer than expected". The job row showed the cause: | srbaggari | 17-Sep-2026 | 3 |
| 19 | `40b8a18` | Fresh addition | **feat(images): add Hugging Face to the standalone generator**<br/>/api/generate-image now takes a `model` and routes between three providers. Hugging Face is the default, being the only one of the three with a usable free tier. | srbaggari | 17-Sep-2026 | 1 |
| 20 | `db08739` | Fresh addition | **feat(images): add Hugging Face to the Content Studio model selector**<br/>FLUX.1-schnell now appears alongside OpenAI, Google Gemini, Agnes, Stability and Replicate, and produces assets indistinguishable downstream: same gallery, same attachment, same platform validation, same publishing. It was previously reachable only from the standalone generator panel. | srbaggari | 17-Sep-2026 | 3 |
| 21 | `720c22e` | Fresh addition | **feat(context): connect existing Aura sources to the Business Context layer**<br/>Audit every existing store of business information, map it into the unified context, connect the remaining AI workflows to the context service, and prove no business information is lost. | srbaggari | 01-Oct-2026 | 1 |
| 22 | `c00bb2f` | Fix | **fix(images): reliable Gemini image generation and previews**<br/>Switches the default Google image model to gemini-3.1-flash-lite-image (about 4s per image) and removes the ways a generated image could fail to appear or appear slowly. | srbaggari | 06-Oct-2026 | 2 |
| 23 | `c821a5e` | Fresh addition | **feat(media): visual / asset generation context from the recommendation**<br/>Recommendations that need a picture now give the image workflow a visual brief (lib/visual-brief.ts), carried in the Content Brief (`visual`). | srbaggari | 12-Oct-2026 | 5 |
| 24 | `13327f6` | Fresh addition | **feat(creative): branded marketing creatives in Content Studio**<br/>Content Studio now produces complete, ready-to-post marketing creatives: a photorealistic photograph, the campaign's words in professional typography, and the business's colours and logo, exported as one PNG. | srbaggari | 13-Oct-2026 | 25 |
| 25 | `756ce60` | Fresh addition | **feat(approval): unified approval model for content, campaigns and outreach**<br/>One set of states, transitions and approval records for Content Studio drafts, campaign tasks and outreach messages (lib/approval.ts, server/approval/approval.service.ts). No migration: the unified state is derived from each module's status and schedule; | srbaggari | 13-Oct-2026 | 1 |
| 26 | `da25b2d` | Fresh addition | **feat(content): connect recommendation workflow to Content Studio; photorealistic images**<br/>Content Studio &lt;-&gt; recommendation workflow; Create content dialog can start from an accepted Aura suggestion, opening the existing ?rec= brief workflow; manual brief/campaign creation unchanged; Board cards mark drafts written from a suggestion; | srbaggari | 14-Oct-2026 | 7 |
| 27 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 11 |
| 28 | `aeaf1c8` | Fix | **fix(whatsapp,publishing): post-implementation audit fixes; JPEG for Instagram**<br/>Found in the post-implementation audit and fixed:; A pending approve/publish now lapses on any account command too ("menu", "switch", logout, workspace), so a later "ok" cannot run it.; | srbaggari | 14-Oct-2026 | 6 |
| 29 | `6672bf3` | Fresh addition | **feat(sprint9): campaign/outreach creation, execution handoff, permissions, failure recovery, E2E**<br/>Connect Campaign & Outreach Creation; Campaign and Outreach creation handoffs from eligible recommendations (lib/creation-handoff.ts): recommendation context, audience, goal, CTA, channel and content requirements mapped with their sources; gaps stated, nothing invented. | srbaggari | 16-Oct-2026 | 1 |
| 30 | `73b0ad3` | Fresh addition | **feat(connections): Connection Manager, connection flow, capabilities, token lifecycle, health**<br/>Connection Manager data model: provider, channels, provider account id, granted scopes, credential reference, setup stage, health, execution history, capabilities; ConnectedAccount table for provider -&gt; account -&gt; page relationships; LinkedIn mirrored without its token; REVOKED status. | srbaggari | 17-Oct-2026 | 2 |
| 31 | `a68c4c8` | Fresh addition | **feat(execution): Meta V1 integration, execution model and state machine, provider routing, timezones**<br/>Execution job model: one Execution per (post, network) with workspace, recommendation, opportunity, content/assets, approved version, channel, provider, connection, target page/profile, schedule, status, attempts, provider response and error; ExecutionEvent for every state change; | srbaggari | 21-Oct-2026 | 3 |
| 32 | `183a772` | Fresh addition | **feat(content, meta, launch): Content Studio control, image refinement and preview, Meta review prep, production readiness**<br/>Content Studio; Recommendations workspace: compare versions, use one (others kept), edit, refine, regenerate or revert ONE version, add 1-3 more recommendations; Per-version CTA, website, address, phone and email (post details), never written by the AI; typed details must be confirmed before approval; | srbaggari | 22-Oct-2026 | 24 |
| 33 | `73bac4f` | Fresh addition | **feat(content): brand safety, source fidelity, image realism, logo colours**<br/>Addresses the review feedback on image generation, text generation, brand safety and publishing. | dspraneeth07 | 26-Oct-2026 | 9 |
| 34 | `6cff62e` | Fix | **fix(whatsapp, content, media): four defects the full verifier sweep found**<br/>Running all 65 verify scripts turned up five failures. One was a dev-server artifact (two `next dev` instances sharing .next corrupt the webpack graph; the same request succeeds on retry) and four were real. | dspraneeth07 | 27-Oct-2026 | 1 |
| 35 | `0572bf2` | Fresh addition | **feat(sandbox): Facebook and Instagram join the local stand-in for Meta**<br/>WhatsApp could already be exercised without a Meta account. Facebook and Instagram could not be exercised at all: between them they need a Meta app, a Page, an Instagram professional account linked to it, and a token that expires in about a day, so the publishers — including Instagram's container-and-poll cycle, the lo… | dspraneeth07 | 27-Oct-2026 | 2 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
