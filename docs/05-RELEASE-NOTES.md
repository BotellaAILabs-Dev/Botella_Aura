# Release Notes — Botella Aura

What each release delivered, written for product owners, customers' success teams and engineers. The
commit-level list is in [04-CHANGELOG.md](04-CHANGELOG.md).

> **Versioning.** Releases are milestone versions, one per sprint or phase, assigned retrospectively. No git tags
> exist yet and `package.json` still reports `0.1.0`. To make them official, see
> [Tagging these releases](#tagging-these-releases).

## Release summary

| Version | Date | Name | Commits | Headline |
| --- | --- | --- | --- | --- |
| [0.14.0](#0140--post-review-hardening) | 26–27 Oct 2026 | Post-review hardening | 11 | Brand safety, realistic images, simpler navigation, LinkedIn sign-in, Meta sandbox |
| [0.13.0](#0130--connections-and-execution) | 17–22 Oct 2026 | Connections and execution | 5 | Connection Manager, execution engine, Meta V1, App Review readiness |
| [0.12.0](#0120--from-recommendation-to-content) | 9–16 Oct 2026 | From recommendation to content | 20 | Content Brief, 9 formats, AI reviewer, compliance, approval, WhatsApp assistant |
| [0.11.0](#0110--recommendations-and-aura-suggests) | 5–8 Oct 2026 | Recommendations and Aura Suggests | 26 | Recommendation engine, Aura Suggests, a new Aura Home |
| [0.10.0](#0100--business-context-and-opportunities) | 29 Sep – 5 Oct 2026 | Business Context and Opportunities | 17 | One trusted Business Context; signals and opportunity detection |
| [0.9.0](#090--client-requests-image-providers-and-performance) | 7–17 Sep 2026 | Client requests, image providers and performance | 21 | Single-image posts, Facebook Pages, faster dashboard, two new image providers |
| [0.8.0](#080--ai-graphics-autonomy-and-guided-setup) | 1–3 Sep 2026 | AI graphics, autonomy and guided setup | 28 | AI graphics, a weekly autonomous cycle, guided setup |
| [0.7.0](#070--client-feedback-and-ux-review) | 31 Jul – 27 Aug 2026 | Client feedback and UX review | 27 | Team invites, Viewer role, action-first dashboard, every review fix |
| [0.6.0](#060--campaigns-analytics-billing-and-hardening) | 27 Jul 2026 | Campaigns, analytics, billing | 5 | Campaign Orchestrator, Analytics, Stripe billing |
| [0.5.0](#050--lead-discovery-and-marketing-memory) | 26 Jul 2026 | Lead Discovery and Marketing Memory | 3 | Prospecting with fit scores; the learning loop |
| [0.4.0](#040--competitors-chrome-extension-outreach-engagement) | 26 Jul 2026 | Competitors, extension, outreach, engagement | 6 | Four growth modules and the Chrome extension |
| [0.3.1](#031--deployment-setup) | 24 Jul 2026 | Deployment setup | 3 | Serverless deployment on Netlify |
| [0.3.0](#030--content-studio-and-knowledge-base) | 23 Jul 2026 | Content Studio and Knowledge Base | 13 | Brand-voice content with an approval gate |
| [0.2.0](#020--trends-ai-and-linkedin) | 23 Jul 2026 | Trends, AI and LinkedIn | 8 | Trend intelligence, the AI service, LinkedIn connection |
| [0.1.0](#010--foundation) | 23 Jul 2026 | Foundation | 11 | Project, schema, design system, sign-in, onboarding |

---

## 0.14.0 — Post-review hardening
**26–27 October 2026 · 11 commits · last commit `bfb715d`**

Responds to the product review on images, text, brand safety, navigation and publishing.

**Highlights**
- **Brand safety.** A deterministic classifier checks source material before any model sees it. Copy written
  from a sensitive source (for example news about deaths) can no longer turn into a promotional post. This is
  enforced in six places, including a new critical review dimension.
- **Stays true to the source.** Drafts keep the topic of the trend that prompted them; variations are checked for
  topic drift; the reviewer now sees the source material.
- **More realistic images.** The negative prompt is reordered so the anti-"AI look" terms always fit, with
  people-realism guidance. Logos can be tinted original, white, black or brand colour.
- **Simpler navigation.** Twenty-one sidebar links became six groups: Home, Your market, Create, Customers,
  Results, Setup. No URL changed.
- **Local trends.** Google News headlines follow the workspace's country; industry feeds are matched to the
  business. Onboarding gains a "where you operate" step.
- **Sign in with LinkedIn** (OpenID Connect), with clear sign-in error messages and `npm run auth:endpoints` to
  print every redirect URI to register.
- **Meta sandbox.** `npm run sandbox` runs Facebook, Instagram and WhatsApp end to end without a Meta account.

**Fixes**
- Gemini fallback now honours the model tier (a slow moving alias was making the WhatsApp assistant time out).
- WhatsApp no longer reuses network choices from a previous post; secrets pasted into a brief are redacted before
  review; brand details are never squeezed out of image prompts; minor JSON slips from the model are repaired.
- Verification scripts resolve their base URL consistently and say which Meta mode they need.

**Upgrade notes**
- No database migrations.
- New optional settings: `GEMINI_MODEL_CHEAP`, `GEMINI_MODEL_STANDARD`, `GEMINI_MODEL_PREMIUM`;
  `META_GRAPH_BASE_URL` (sandbox only, never in production).

**Tests:** 2,141 passing.

---

## 0.13.0 — Connections and execution
**17–22 October 2026 · 5 commits · last commit `0bc1a58` · Sprint 10**

**Highlights**
- **Connection Manager.** Connect → authenticate → authorise → choose account or Page → confirm. Granted
  permissions are read from the provider; tokens refresh proactively; disconnect revokes at the provider; six
  health statuses with a daily sweep.
- **Execution engine.** One execution per post and network, with a state machine (Approved → Ready →
  Scheduled/Queued → Executing → Completed, or Failed → Retry / Action required). Provider routing checks channel,
  content type, connection health and permissions before anything runs.
- **Scheduling with timezones.** Workspace timezone, DST-safe conversion, cancel and retry from the new
  Publishing page.
- **Meta V1.** Post ids stored, organic engagement collected, insights behind `META_REQUEST_INSIGHTS`.
- **Content Studio control.** Compare and pick recommendation versions; per-version CTA, website, address, phone
  and email (never written by AI); refine one image with an instruction; image version history; logo on/off/space
  per image; full-screen preview.
- **Meta App Review readiness.** Public privacy, terms and data-deletion pages; submission package; WhatsApp
  production checklist and templates.
- **Production readiness.** Environment checks at start-up, migration rehearsal, private S3 buckets via presigned
  reads, SSRF-safe redirects, security headers.

**Upgrade notes**
- Migrations: `20261017090000_connection_manager` (backfills existing connections),
  `20261021090000_execution_engine` (backfills executions).
- New optional settings: `LINKEDIN_API_VERSION`, `META_LOGIN_CONFIG_ID`, `META_REQUEST_INSIGHTS`.

**Tests:** 2,041 passing.

---

## 0.12.0 — From recommendation to content
**9–16 October 2026 · 20 commits · last commit `6672bf3` · Sprint 9**

**Highlights**
- **Accept → create.** Saying yes to a suggestion opens the right workflow already filled in: a draft, a campaign
  plan or a month's content plan, with the recommendation's context kept on whatever is made.
- **Content Brief.** A versioned 16-field brief is the source of truth for every draft. Missing fields are named,
  never invented.
- **Every format.** Nine formats defined once, including the new **Campaign copy** and **Promo**. A missing
  required CTA blocks approval.
- **Visual brief.** Each recommendation that needs an image gets a subject, palette, mood and channel-correct size.
- **Variations** (shorter, longer, new tone, new CTA, new headline, another channel, another image) with a
  facts guardrail.
- **Fact check, AI reviewer and compliance.** Claims are checked against trusted facts; an independent reviewer
  scores the piece; a per-workspace compliance policy (with alcohol, health and finance rule packs) runs before
  approval.
- **One review screen and approval model** for drafts, campaign tasks and outreach; **numbered versions** (v1 always
  recoverable); **traceability** from business fact to approved version.
- **Branded creatives.** Photograph + typography + brand colours + real logo, exported as PNG in four sizes.
- **WhatsApp assistant.** Ask what is waiting, write a post, approve and publish from WhatsApp, with an explicit
  "yes" for every approval. **One-click publishing** to Facebook, Instagram and LinkedIn.
- **Campaign and outreach creation** from recommendations; an **execution handoff** package for the engine.

**Fixes:** permission gaps for Viewers and Members closed; idempotent generation; conditional saves (no
last-write-wins); plain-language provider errors; Instagram images sent as JPEG.

**Upgrade notes**
- Migrations: `20261012090000_content_campaign_promo`, `20261014090000_whatsapp_assistant`,
  `20261014100000_whatsapp_queue`, `20261014110000_whatsapp_account_link`, `20261014120000_whatsapp_session_state`,
  `20261014130000_content_publications`, `20261014140000_whatsapp_message_workspace`,
  `20261015090000_instagram_carousel_reels`, `20261016090000_campaign_creation_context`,
  `20261016100000_execution_handoff`.
- New settings: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
  `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_DISPLAY_NUMBER`, `META_OAUTH_PKCE`,
  `LINKEDIN_OAUTH_PKCE`; `WHATSAPP_GRAPH_BASE_URL` for load tests only.
- New dependencies: `sharp`, `satori`, `@resvg/resvg-js`, `@vercel/functions`; dev `playwright-core`.

**Tests:** 1,893 passing; 25 of 26 end-to-end suites (one needs live AI quota).

---

## 0.11.0 — Recommendations and Aura Suggests
**5–8 October 2026 · 26 commits · last commit `d42c062` · Sprint 8**

**Highlights**
- **Recommendation engine.** Turns an opportunity into what to do, why, how and the expected outcome. It picks
  the best supported action, writes it from templates (a model may only reword, and is validated), and caps
  confidence by the evidence.
- **Guardrails.** Eligibility, minimum evidence, frequency limits (10 a day, 15 awaiting a decision, 5 per channel
  per week), duplicate and repeat protection, unsupported channels never executable.
- **Prioritisation** into now / next / later with every factor explained; **"Not now"** snooze.
- **Lifecycle.** Generated → Presented → Accepted / Edited / Skipped / Rejected → In progress → Completed, with
  full history.
- **Aura Suggests** — plain-language suggestions with evidence one click away and one clear next step; Aura
  suggests on its own and says why when it cannot.
- **Aura Home** rebuilt around what matters now, top suggestions, active opportunities, results versus last week
  and recent activity — each section loads independently.
- **History, quality validation and empty states** that name exactly what Aura needs before it can help.
- **Content Studio** writes for each platform's conventions, adds Email and Ad formats, quality and
  alcohol-marketing checks, one-click rewrites with undo.
- **Platform:** Vercel functions moved next to the database (Singapore), deploys survive brief database outages,
  a database connection checker.

**Upgrade notes**
- Migrations: `20261006090000_recommendation_model`, `20261007090000_recommendation_engine`,
  `20261008090000_recommendation_guardrails`, `20261009090000_recommendation_prioritization`,
  `20261010090000_content_email_ad`, `20261011090000_recommendation_lifecycle` (renames PROPOSED → GENERATED in
  place).
- Optional: `ALLOW_DEPLOY_WITHOUT_MIGRATIONS=1` for builds that cannot reach the database.

**Tests:** 1,260 passing; Sprint 8 end-to-end 29 checks; 39 of 39 pages.

---

## 0.10.0 — Business Context and Opportunities
**29 September – 5 October 2026 · 17 commits · last commit `1f4b431` · Sprint 7**

**Highlights**
- **One Business Context.** Everything Aura knows about a business in one structure, read and written through one
  validated service. Each fact carries its source, confidence and freshness.
- **Business Context Snapshot** for AI workflows: only trusted, current facts; assumptions labelled; rebuilt when
  sources change or after 6 hours.
- **About my business** page: completeness score, needs-attention list, badges for source and freshness, inline
  edits and confirm-without-editing.
- **Aura asks** for missing or doubtful information instead of assuming.
- **Signals** from trends, competitors, results, memory and the business context, de-duplicated.
- **Opportunity detection** by five deterministic rules plus validated AI; the **Opportunities** page with
  evidence, reasoning and status actions.
- **Data-access security** review with tests; unsafe `javascript:` links blocked.

**Fixes:** concurrent edits no longer erase each other; no-op saves and false conflicts removed.

**Upgrade notes**
- Migrations: `20261001090000_business_context_snapshot`, `20261002090000_business_context_questions`,
  `20261002120000_opportunities`, `20261002150000_signals`, `20261003090000_opportunity_source_business_context`,
  `20261003120000_ai_opportunity_detection`, `20261005090000_recommendation_foundation`. All additive.

**Tests:** 867 passing; Sprint 7 flow 33 checks; access 38 checks.

---

## 0.9.0 — Client requests, image providers and performance
**7–17 September 2026 · 21 commits · last commit `db08739`**

**Highlights**
- **Single-image post** format; **Facebook Page publishing**; each workspace chooses its content formats.
- **Onboarding captures the business and its audience**, and brand knowledge now reaches every AI workflow
  (campaign plans, outreach, replies, image briefs).
- **New image providers:** Agnes AI and Hugging Face (FLUX.1-schnell, free tier).
- **Faster dashboard:** navigation paints immediately, results are cached between requests, and the login page
  no longer ships the password library to the browser.

**Fixes:** dates that broke page hydration outside the server's locale; jobs that could never succeed are no
longer retried forever; image jobs no longer stall at 10%; failed jobs no longer reported as gateway errors.

**Upgrade notes**
- Migrations: `20260907120000_content_draft_updated_at_index`, `20260908120000_single_image_post`,
  `20260916120000_campaign_completed_audit`, `20260916140000_hot_list_sort_indexes`,
  `20260917120000_image_provider_agnes`, `20260917150000_image_provider_huggingface`.
- New optional settings: `AGNES_API_KEY`, `AGNES_API_BASE_URL`, `AGNES_IMAGE_MODEL`, `HUGGINGFACE_API_KEY`,
  `HUGGINGFACE_MODEL_ID`, `HUGGINGFACE_API_BASE`.

---

## 0.8.0 — AI graphics, autonomy and guided setup
**1–3 September 2026 · 28 commits · last commit `caf8e50`**

**Highlights**
- **AI graphics in Content Studio.** Aura reads a post, writes an image prompt, generates a graphic, attaches it
  and queues it for publishing — through a provider-independent interface (OpenAI, Google, Stability, Replicate).
  Users can also upload their own graphics.
- **Aura works for you.** A weekly autonomous cycle writes the week's posts, illustrates them and assembles a
  briefing for the home page.
- **Guided setup** in seven ordered steps derived from real data; **business materials by kind** (pitch decks,
  brand guidelines as PPTX/DOCX).
- **B2C vs B2B writing**, audience-focused content and per-task model tiers.
- **Publish-time recommendations** and optional automatic publishing under explicit settings.
- **Confidence-gated bulk approval** and an app-wide background job indicator.
- Features renamed after what the user gets, not how they work.

**Fixes:** workspace creation failing with 500; unauthenticated API calls answering 500 instead of 401;
background pollers leaking; cron jobs that could never fire on Vercel; deployment limits valid on every plan;
Google image model reachable by a standard key.

**Upgrade notes**
- Migrations: `20260901120000_graphic_generation`, `20260902090000_media_uploads`,
  `20260902120000_weekly_briefing`, `20260903090000_material_categories`.
- New settings: `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `GOOGLE_AI_API_KEY`, `GOOGLE_IMAGE_MODEL`,
  `STABILITY_API_KEY`, `STABILITY_IMAGE_MODEL`, `REPLICATE_API_TOKEN`, `REPLICATE_IMAGE_MODEL`, `ASSET_S3_*`,
  `META_CLIENT_ID`, `META_CLIENT_SECRET`, `META_GRAPH_VERSION`, `ANTHROPIC_MODEL_CHEAP/_STANDARD/_PREMIUM`.

---

## 0.7.0 — Client feedback and UX review
**31 July – 27 August 2026 · 27 commits · last commit `ac4d45e`**

**Highlights**
- **Google Gemini** as an alternate AI provider; **LinkedIn profile publishing** through the official API.
- **Team collaboration:** invite by email, accept flow, roles, a read-only **Viewer** role; invitation status,
  resend and truthful email delivery results.
- **Email** through SMTP or Resend; **Connectors** module with available vs coming-soon status.
- **Onboarding polish:** URL validation, industry autocomplete, tone chips and a live brand-voice preview.
- **Action-first dashboard** and a connected, clearly labelled demo data set.
- Every P0–P3 item from the client review and the screens review fixed: campaign selector, lead fit score out of
  100 with reasons, separate company and contact, outreach sequence and status stepper, correctable Marketing
  Memory, AI trend digest with hashtags and seasonal moments.
- Deployments on Railway and Vercel + Neon.

**Fixes:** brand copy extracted from JavaScript-rendered sites; reliable extension text insertion; AI calls that
returned empty text when thinking used the whole budget.

**Upgrade notes**
- Migrations: `20260807224247_team_invitations`, `20260807230628_viewer_role_and_geo_trends`,
  `20260824090000_client_review_phases`, `20260827120000_screens_review`.
- New settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `APP_URL`,
  `HUBSPOT_CLIENT_ID/_SECRET`, `MAILCHIMP_CLIENT_ID/_SECRET`, `SLACK_CLIENT_ID/_SECRET`.

---

## 0.6.0 — Campaigns, Analytics, Billing and Hardening
**27 July 2026 · 5 commits · last commit `50d7ecb` · Sprint 6**

- **Campaign Orchestrator:** one goal becomes a reviewable 30-day plan whose tasks trigger the existing pipelines.
- **Analytics dashboard** built only on real captured data, with a weekly summary.
- **Stripe subscriptions** with signature-verified webhooks and plan entitlements.
- **Production hardening:** tenant-isolation tests, rate limiting on public auth endpoints, error monitoring.
- Migration: `20260727135058_sprint6_campaigns_billing_analytics`. New settings: `STRIPE_*`, `SENTRY_DSN`.

## 0.5.0 — Lead Discovery and Marketing Memory
**26 July 2026 · 3 commits · last commit `1eefb76` · Sprint 5**

- **Lead Discovery Engine:** saved criteria, weekly auto-run, fit scores with rationale.
- **Marketing Memory:** real metrics only, insights fed back into every generation.
- Migrations: `20260726120205_sprint5_lead_discovery`, `20260726122320_sprint5_marketing_memory`. New settings:
  `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX`.

## 0.4.0 — Competitors, Chrome Extension, Outreach, Engagement
**26 July 2026 · 6 commits · last commit `ba01e09` · Sprint 4**

- **Competitor Intelligence:** website change detection, public news, GitHub activity, weekly report.
- **Chrome Extension v1:** the human action layer — every LinkedIn action is a real click by the user.
- **Outreach Intelligence:** leads from public signals, brand-voice drafts, approval, then the extension queue.
- **Engagement Copilot:** comment drafts for posts the user is already viewing.
- Migrations: `20260726044920_sprint4_competitor_intelligence`, `20260726050633_sprint4_extension_token`,
  `20260726053906_sprint4_outreach_engagement`. New settings: `GITHUB_TOKEN`, `CRUNCHBASE_API_KEY`,
  `EXTENSION_ALLOWED_ORIGIN`.

## 0.3.1 — Deployment setup
**24 July 2026 · 3 commits · last commit `1914052`**

- Netlify configuration for the server-rendered app; Prisma binary target for serverless; separate pooled and
  direct database URLs. New setting: `DIRECT_URL`.

## 0.3.0 — Content Studio and Knowledge Base
**23 July 2026 · 13 commits · last commit `18f20b0` · Sprint 3**

- **Knowledge base:** website, blog/RSS and file ingestion (robots.txt-compliant), chunking and retrieval.
- **Brand voice** profile, human-editable, injected into every generation.
- **Content Studio:** four content types, schema-validated generation, the approval state machine
  (Published only from Approved), queue, editor and calendar.
- **Real-time keyless news** from Google News, Bing, Reddit RSS, Hacker News and curated feeds.
- Migration: `20260723151014_sprint3_content_studio`. New setting: `LINKEDIN_ORG_URN`.

## 0.2.0 — Trends, AI and LinkedIn
**23 July 2026 · 8 commits · last commit `1ff9ad2` · Sprint 2**

- The single **Claude AI service** and shared HTTP client.
- **Trend intelligence:** sources, scoring and an idempotent daily digest.
- **LinkedIn** official OAuth connect and disconnect, tokens encrypted at rest.
- Migrations: `20260723070803_sprint2_trend_config`, `20260723124640_sprint2_linkedin_fields`. New settings:
  `ANTHROPIC_MODEL`, `REDDIT_*`, `TWITTER_BEARER_TOKEN`, `CRON_SECRET`.

## 0.1.0 — Foundation
**23 July 2026 · 11 commits · last commit `4da9da5` · Sprint 1**

- Next.js 14 + TypeScript project, Prisma schema designed for the 10-sprint roadmap, design system.
- Authentication (email/password and Google), password reset, role-based access, AES-256-GCM helpers.
- Three-step company onboarding and the dashboard shell with workspace switching.
- Migration: `0_init`. Settings: `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`,
  `GOOGLE_CLIENT_ID/_SECRET`, `ANTHROPIC_API_KEY`.

---

## Known issues in the current release

| Issue | Impact | Workaround / next step |
| --- | --- | --- |
| Meta App Review pending | Customers cannot publish to Facebook/Instagram yet | Use the sandbox or test users; submit the App Review package |
| WhatsApp production number pending | Assistant limited to allow-listed test numbers | Complete business verification and templates |
| Only 3 of 14 cron routes scheduled | Trends, competitors, discovery, memory, analytics and the job reaper do not run automatically | Add them to `vercel.json` or an external scheduler |
| Some write routes lack a role check | Viewers can change knowledge base, brand voice and trend settings; any member can issue an extension token via API | Add `can(role, …)` checks — see [SRS §7](02-SRS.md) |
| Cron secret compared with `===` in 12 routes | Theoretical timing side channel | Use the shared constant-time helper |

---

## Tagging these releases

The commands below create annotated tags at the last commit of each release (run once, then
`git push origin --tags`). They have **not** been run.

```bash
git tag -a v0.1.0  4da9da5 -m "Foundation"
git tag -a v0.2.0  1ff9ad2 -m "Trends, AI and LinkedIn"
git tag -a v0.3.0  18f20b0 -m "Content Studio and Knowledge Base"
git tag -a v0.3.1  1914052 -m "Deployment setup"
git tag -a v0.4.0  ba01e09 -m "Competitors, Chrome Extension, Outreach, Engagement"
git tag -a v0.5.0  1eefb76 -m "Lead Discovery and Marketing Memory"
git tag -a v0.6.0  50d7ecb -m "Campaigns, Analytics, Billing and Hardening"
git tag -a v0.7.0  ac4d45e -m "Client feedback and UX review"
git tag -a v0.8.0  caf8e50 -m "AI graphics, autonomy and guided setup"
git tag -a v0.9.0  db08739 -m "Client requests, image providers and performance"
git tag -a v0.10.0 1f4b431 -m "Business Context and Opportunities"
git tag -a v0.11.0 d42c062 -m "Recommendations and Aura Suggests"
git tag -a v0.12.0 6672bf3 -m "From recommendation to content"
git tag -a v0.13.0 0bc1a58 -m "Connections and execution"
git tag -a v0.14.0 bfb715d -m "Post-review hardening"
```
