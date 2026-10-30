# Changelog

All notable changes to **Botella Aura**, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **About the version numbers.** No git tags exist yet and `package.json` still reports `0.1.0`. The versions below are milestone versions assigned to each sprint or phase, so every commit belongs to exactly one release. To make them official, tag the last commit of each release (listed in its header) — see [05-RELEASE-NOTES.md](05-RELEASE-NOTES.md#tagging-these-releases).

Each entry links its commit. A commit-by-commit table with status, details and author is in [feature-docs/03-changelog/CHANGELOG.md](feature-docs/03-changelog/CHANGELOG.md).

## [Unreleased]

### Documentation

- Project documentation set: Product Brief, SRS, Architecture, this Changelog and Release Notes in `docs/`, and the feature documentation in `docs/feature-docs/` (25 features, API references, environment variables, resources and specifications).

## [0.14.0] — 2026-10-26 → 2026-10-27 · Post-review hardening

_Hardening · 11 commits · +7,092 / −587 lines · last commit `bfb715d`_

### Added

- Brand safety, source fidelity, image realism, logo colours (`73bac4f`)
- Six-group navigation, localized trend sources (`30757de`)
- Sign in with LinkedIn, and one list of every redirect URI (`0965b7c`)
- Facebook and Instagram join the local stand-in for Meta (`0572bf2`)

### Fixed

- Honour the model tier on the Gemini path; local WhatsApp loop (`38083a5`)
- Four defects the full verifier sweep found (`6cff62e`)
- Verify:access resolves its base URL like every other script (`cb26fb5`)
- The refusal suites say which Meta they need, instead of failing (`fc62acb`)

### Documentation

- List the sandbox, the endpoint printout and the env check (`e8fa375`)
- Update README.md (`0743562`)
- Update README.md (`bfb715d`)

## [0.13.0] — 2026-10-17 → 2026-10-22 · Connections and execution

_Sprint 10 · 5 commits · +17,787 / −546 lines · last commit `0bc1a58`_

### Added

- Connection Manager, connection flow, capabilities, token lifecycle, health (`73b0ad3`)
- Meta V1 integration, execution model and state machine, provider routing, timezones (`a68c4c8`)
- Content Studio control, image refinement and preview, Meta review prep, production readiness (`183a772`)

### Documentation

- Update README.md (`15c2e0c`)
- Update README.md (`0bc1a58`)

### Database migrations

- `20261017090000_connection_manager`
- `20261021090000_execution_engine`

### New environment variables

- `LINKEDIN_API_VERSION`, `META_LOGIN_CONFIG_ID`, `META_REQUEST_INSIGHTS`

## [0.12.0] — 2026-10-09 → 2026-10-16 · From recommendation to content

_Sprint 9 · 20 commits · +60,949 / −1,380 lines · last commit `6672bf3`_

### Added

- Recommendation acceptance -> creation flow (`4b2aada`)
- Recommendation-to-content brief, the source of truth for creation (`cc1836e`)
- Context assembly for content generation (`1063040`)
- Contextual content generation for every format (`b9ed6cf`)
- Visual / asset generation context from the recommendation (`c821a5e`)
- Content generation variations with a facts guardrail (`d78aace`)
- Factual validation before approval (`22880c0`)
- AI reviewer / quality check before approval (`c6cfd2c`)
- Configurable compliance & policy checks before approval (`7b5fa6e`)
- Unified review experience for generated Aura work (`c33077b`)
- Branded marketing creatives in Content Studio (`13327f6`)
- Unified approval model for content, campaigns and outreach (`756ce60`)
- Edit & version management for generated content (`000e1c7`)
- Recommendation -> content traceability (`c39a554`)
- Connect recommendation workflow to Content Studio; photorealistic images (`da25b2d`)
- WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing (`f6b35db`)
- Campaign/outreach creation, execution handoff, permissions, failure recovery, E2E (`6672bf3`)

### Changed

- Generate the monthly calendar fast, bounded and complete (`89cf8a2`)

### Fixed

- Post-implementation audit fixes; JPEG for Instagram (`aeaf1c8`)

### Documentation

- Update README.md (`43222ea`)

### Database migrations

- `20261012090000_content_campaign_promo`
- `20261014090000_whatsapp_assistant`
- `20261014100000_whatsapp_queue`
- `20261014110000_whatsapp_account_link`
- `20261014120000_whatsapp_session_state`
- `20261014130000_content_publications`
- `20261014140000_whatsapp_message_workspace`
- `20261015090000_instagram_carousel_reels`
- `20261016090000_campaign_creation_context`
- `20261016100000_execution_handoff`

### New environment variables

- `META_OAUTH_PKCE`, `LINKEDIN_OAUTH_PKCE`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_GRAPH_BASE_URL`, `WHATSAPP_DISPLAY_NUMBER`

## [0.11.0] — 2026-10-05 → 2026-10-08 · Recommendations and Aura Suggests

_Sprint 8 · 26 commits · +29,990 / −1,559 lines · last commit `d42c062`_

### Added

- Define the Recommendation data model (`18665a4`)
- Build the recommendation generation engine (`39e0131`)
- Define recommendation rules and guardrails (`a8eaf2d`)
- Build recommendation prioritization (`e69363a`)
- Platform-aware, quality-checked AI copywriting (`2979cf1`)
- Recommendation Lifecycle: generated → presented → accepted/edited/skipped/rejected → completed (`c28b09c`)
- Build the "Aura Suggests" experience (`3517195`)
- Refactor the dashboard into a recommendation-led Aura Home (`060a036`)
- Build the "What Matters Now" section (`fc50373`)
- Connect existing Aura modules to recommendations (`9f5a3ef`)
- Recommendation context handoff contract for Sprint 9 (`39dc103`)
- Recommendation history and quality validation (`bc24572`)
- Empty and insufficient-data states (`bb6ad7e`)

### Changed

- Recommendation security and RLS validation (`6eb6f24`)

### Fixed

- Reliable Gemini image generation and previews (`c00bb2f`)
- Stop Gemini truncating JSON answers; much faster generation (`b973e45`)
- Aura suggests on its own, and says why when it can't (`bf23770`)
- Put the functions in the same region as the database (`f214f68`)

### Documentation

- Correct the documented Google image model default (`e4e8884`)

### Tests, build and tooling

- Fix the remaining project-wide lint errors (`b34225c`)
- Sync pnpm-lock.yaml with package.json (`b0a5db5`)
- Skip non-secret config keys in secrets scanning (`0e4a49a`)
- Trigger a rebuild to test the git integration (`aad80c8`)
- Stop a brief database outage from killing the deploy (`14498db`)
- Add a database connection checker that names the failing layer (`14f30c9`)
- Sprint 8 end-to-end testing: full-flow verify script and test report (`d42c062`)

### Database migrations

- `20261006090000_recommendation_model`
- `20261007090000_recommendation_engine`
- `20261008090000_recommendation_guardrails`
- `20261009090000_recommendation_prioritization`
- `20261010090000_content_email_ad`
- `20261011090000_recommendation_lifecycle`

## [0.10.0] — 2026-09-29 → 2026-10-05 · Business Context and Opportunities

_Sprint 7 · 17 commits · +26,974 / −783 lines · last commit `1f4b431`_

### Added

- Add unified Business Context data model (`b3c4f0f`)
- Add Business Context service with validated updates (`c8bbf70`)
- Add source, confidence and freshness to business facts (`ea0f2af`)
- Add Business Context Snapshot for AI workflows (`b6e4763`)
- Connect existing Aura sources to the Business Context layer (`720c22e`)
- Turn About My Business into the view of the Business Context (`4015d13`)
- Ask for missing business information instead of assuming (`00470c4`)
- Add Opportunity data model with evidence and lifecycle (`58d660d`)
- Add signal aggregation layer for opportunity detection (`285e4a4`)
- Define opportunity detection rules (`93ee292`)
- Add AI-assisted opportunity detection (`6f59ea9`)
- Add Opportunities view (`c55518c`)
- Prepare Opportunity -> Recommendation integration (`ad1237c`)

### Changed

- Validate data access for Business Context and opportunities (`39c4048`)

### Fixed

- Stale-revision conflicts, no-op saves, rejected company names (`8a1e822`)
- Stop concurrent writes erasing each other; ignore whitespace-only "changes" (`a3e3568`)

### Tests, build and tooling

- Sprint 7 end-to-end validation of the Business Context -> Opportunity flow (`1f4b431`)

### Database migrations

- `20261001090000_business_context_snapshot`
- `20261002090000_business_context_questions`
- `20261002120000_opportunities`
- `20261002150000_signals`
- `20261003090000_opportunity_source_business_context`
- `20261003120000_ai_opportunity_detection`
- `20261005090000_recommendation_foundation`

## [0.9.0] — 2026-09-07 → 2026-09-17 · Client requests, image providers and performance

_Client review · 21 commits · +6,458 / −598 lines · last commit `db08739`_

### Added

- Add the single-image post (`c6ee2e8`)
- Publish to Facebook Pages (`dab7355`)
- Let each workspace choose its content formats (`0382184`)
- Capture the business and its audience (`b090ef2`)
- Connect brand knowledge to every AI workflow (`5bb000f`)
- Add Agnes AI as a Content Studio model (`6311973`)
- Add Hugging Face to the standalone generator (`40b8a18`)
- Add Hugging Face to the Content Studio model selector (`db08739`)

### Changed

- Stop repeating the same work on every navigation (`a64bdc4`)
- Stop shipping bcryptjs to the browser (`8f92dfc`)

### Fixed

- Stop dates breaking hydration in every non-server locale (`6689fca`)
- Stop retrying failures that cannot succeed (`788d418`)
- Audience validation, image variations, campaign states, query cost (`127a692`)
- Name the Google provider accurately and explain the quota (`c8cbd50`)
- Accept AGNES in the request schema (`2071e8a`)
- Point at the API routes that actually exist (`fbe34c6`)
- Stop parking doomed generations at 10% forever (`3c7916e`)
- Stop reporting a failed job as a gateway error (`39222b5`)

### Documentation

- Correct the optimizePackageImports note (`d74dc69`)
- Work log for 7 September 2026 (`584710a`)

### Tests, build and tooling

- Declare @testing-library/dom, the missing peer (`2fcb812`)

### Database migrations

- `20260907120000_content_draft_updated_at_index`
- `20260908120000_single_image_post`
- `20260916120000_campaign_completed_audit`
- `20260916140000_hot_list_sort_indexes`
- `20260917120000_image_provider_agnes`
- `20260917150000_image_provider_huggingface`

### New environment variables

- `AGNES_API_KEY`, `AGNES_API_BASE_URL`, `AGNES_IMAGE_MODEL`, `HUGGINGFACE_API_KEY`, `HUGGINGFACE_MODEL_ID`, `HUGGINGFACE_API_BASE`

## [0.8.0] — 2026-09-01 → 2026-09-03 · AI graphics, autonomy and guided setup

_Client review · 28 commits · +21,976 / −790 lines · last commit `caf8e50`_

### Added

- Confidence-gated bulk approval + app-wide background job indicator (`96c1f1a`)
- AI graphic generation, media attachment and platform-aware publishing (`2b82ea8`)
- User-supplied graphics and the Custom format (`63cd095`)
- Aura works for you — autonomous weekly cycle and briefing home (`165d1c1`)
- Audience-focused writing and per-task model tiers (`366b881`)
- Name features after what the user gets, not how they work (`b1b1e29`)
- Guide setup as a sequence, derived from real data (`94e3926`)
- Learn from real business materials, by kind (`6045fcb`)
- Adapt strategy and messaging to the business profile (`b88ea1c`)
- Recommend when to publish, and act on it under settings (`f537101`)

### Changed

- Stop background pollers leaking loops on remount (`6ce3933`)
- Stop the poll loop leaking past unmount (`102c23c`)
- Stop navigations blocking, and stop re-querying auth (`35bb33e`)

### Fixed

- Label a setup-stage score as setup, not marketing health (`c320f33`)
- Answer 401 for unauthenticated API calls instead of 500 (`a6b1747`)
- Workspace creation returned 500 on every attempt (`d99e0f8`)
- Close three correctness gaps in generation and upload (`7da7d0e`)
- Competitors and Trends crashed on stored payloads that predate their types (`d332d46`)
- Make scheduled jobs actually run on Vercel (`bd97890`)
- Make the deployment succeed on any plan (`36ebc5c`)
- Call a Google image model the API key can actually reach (`caf8e50`)

### Documentation

- Record runtime verification results against a live database (`3612ac7`)
- Remediation report for the screens review (`4ea8681`)
- Graphic generation implementation report (`9e588ff`)
- Work log for 3 September 2026 (`e93795c`)

### Tests, build and tooling

- Declare the two config routes dynamic (`26bc4de`)
- Add comprehensive tests for graphic studio and media validation (`df858cf`)
- Add pnpm verify:pages — load every dashboard page against real data (`af61405`)

### Database migrations

- `20260901120000_graphic_generation`
- `20260902090000_media_uploads`
- `20260902120000_weekly_briefing`
- `20260903090000_material_categories`

### New environment variables

- `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `GOOGLE_AI_API_KEY`, `GOOGLE_IMAGE_MODEL`, `STABILITY_API_KEY`, `STABILITY_IMAGE_MODEL`, `REPLICATE_API_TOKEN`, `REPLICATE_IMAGE_MODEL`, `ASSET_S3_ENDPOINT`, `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`, `ASSET_S3_REGION`, `ASSET_S3_PUBLIC_BASE_URL`, `META_CLIENT_ID`, `META_CLIENT_SECRET`, `META_GRAPH_VERSION`, `ANTHROPIC_MODEL_CHEAP`, `ANTHROPIC_MODEL_STANDARD`, `ANTHROPIC_MODEL_PREMIUM`

## [0.7.0] — 2026-07-31 → 2026-08-27 · Client feedback and UX review

_Client review · 27 commits · +22,891 / −1,559 lines · last commit `ac4d45e`_

### Added

- Add Google Gemini as an alternate AI provider (`43ff16e`)
- Personal-profile API publishing + fix stale API version (`48a4f76`)
- Live-fetch reference URLs; fix(kb): clearer PDF errors (`80d4462`)
- Rename Overview→Dashboard; fix Create Workspace (`0176507`)
- Invite teammates + role-based access (`67280d6`)
- Viewer role, Resend emails, Connectors module, geo trend filters (`dc5e65b`)
- Validation, industry autocomplete, tone chips, live voice preview (`2daaf1e`)
- Action-first dashboard + connected sample data seed (`5ec850b`)
- Outreach sequence+stepper, marketing-memory correction, content hashtag separation (`8e2daed`)
- AI digest synthesis, trending hashtags, seasonal moments, competitor mentions (`912ee54`)
- Validation + guidance polish sweep (`bed5963`)
- Consolidated client feedback — Phases 1–3 (`45618d2`)

### Changed

- Remove internal "Sprint N" labels + working overview + more trends (`d996c48`)

### Fixed

- Extract brand copy from JavaScript-rendered sites (`ae01e19`)
- Reliable composer injection + honest metrics matching (`cbb746b`)
- Don't run migrations during Vercel build (`6a20d84`)
- SMTP email, PDF upload, content speed, outreach history, lead dedup (`ea1e976`)
- Campaign selector, lead fit score, invite status, connectors, extension beta (`ef9dd58`)
- Separate Company/Contact columns + fit score X/100 with why (UX review criticals) (`0328c42`)
- Screens review — P0 generation failures, OAuth, first-run, lead scoring (`ac4d45e`)

### Documentation

- Client-review status — done, remaining, blockers, actions (`4fd6490`)
- Update client-review status with latest shipped batch (`87be842`)
- Master project status — done, not-done, blockers, actions (all modules + client feedback + UX review) (`1ab7d72`)

### Tests, build and tooling

- Railway config + start:prod (runs migrations on deploy) (`b244bc2`)
- Vercel-build script (migrate + build) for Vercel deploys (`8da5c4d`)
- Implement code changes to enhance functionality and improve performance (`f3e9365`)
- Run migrations in vercel-build (auto-apply schema on deploy) (`88319e6`)

### Database migrations

- `20260807224247_team_invitations`
- `20260807230628_viewer_role_and_geo_trends`
- `20260824090000_client_review_phases`
- `20260827120000_screens_review`

### New environment variables

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `APP_URL`, `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`

## [0.6.0] — 2026-07-27 · Campaigns, Analytics, Billing and Hardening

_Sprint 6 · 5 commits · +3,812 / −73 lines · last commit `50d7ecb`_

### Added

- Module 1 — Campaign Orchestrator (Sprint 6) (`43f4024`)
- Module 2 — Analytics Dashboard (Sprint 6) (`584923e`)
- Module 3 — Stripe subscriptions + entitlements (Sprint 6) (`fc794a1`)
- Module 4 — production hardening (Sprint 6) (`f4ee9be`)

### Documentation

- README production deploy + secrets checklist, .env.example, SPRINT-6-TECHNICAL.md (`50d7ecb`)

### Database migrations

- `20260727135058_sprint6_campaigns_billing_analytics`

### New environment variables

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY`, `SENTRY_DSN`

## [0.5.0] — 2026-07-26 · Lead Discovery and Marketing Memory

_Sprint 5 · 3 commits · +3,950 / −4 lines · last commit `1eefb76`_

### Added

- Module 1 — Lead Discovery Engine (Sprint 5) (`1700ba5`)
- Module 2 — Marketing Memory / Learning Loop (Sprint 5) (`8755674`)

### Documentation

- README + .env.example + SPRINT-5-TECHNICAL.md (`1eefb76`)

### Database migrations

- `20260726120205_sprint5_lead_discovery`
- `20260726122320_sprint5_marketing_memory`

### New environment variables

- `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX`

## [0.4.0] — 2026-07-26 · Competitors, Chrome Extension, Outreach, Engagement

_Sprint 4 · 6 commits · +8,609 / −75 lines · last commit `ba01e09`_

### Added

- Module 1 — Competitor Intelligence (Sprint 4) (`7430dea`)
- Module 2 — Chrome Extension v1, the human action layer (Sprint 4) (`d648252`)
- Module 3 — Outreach Intelligence (Sprint 4) (`fdde091`)
- Module 4 — Engagement Copilot (Sprint 4) (`cb77149`)

### Documentation

- README + .env.example + extension README for all 4 modules (`31bbbbd`)
- Sprint 4 technical documentation (`ba01e09`)

### Database migrations

- `20260726044920_sprint4_competitor_intelligence`
- `20260726050633_sprint4_extension_token`
- `20260726053906_sprint4_outreach_engagement`

### New environment variables

- `GITHUB_TOKEN`, `CRUNCHBASE_API_KEY`, `EXTENSION_ALLOWED_ORIGIN`

## [0.3.1] — 2026-07-24 · Deployment setup

_Hosting · 3 commits · +95 / −4 lines · last commit `1914052`_

### Fixed

- Resolve Netlify build failure on Prisma binaryTargets (`e7473eb`)
- Separate DIRECT_URL for migrations (serverless Postgres) (`1914052`)

### Tests, build and tooling

- Netlify config for the server-rendered Next.js app (`a83acfa`)

### New environment variables

- `DIRECT_URL`

## [0.3.0] — 2026-07-23 · Content Studio and Knowledge Base

_Sprint 3 · 13 commits · +6,418 / −71 lines · last commit `18f20b0`_

### Added

- Sprint 3 schema — knowledge base, campaigns, content fields (`8aea773`)
- Schema-validated structured generation (completeStructured) (`48afe94`)
- Ingestion pipeline + retrieval (`1286a84`)
- Brand voice, generator, approval + publish services (`b9d41bd`)
- Content Studio API routes (`a2e0e83`)
- Content Studio UI (queue, editor, calendar, KB) (`c71046e`)
- Real-time keyless multi-source news on every refresh (`6e42264`)
- Add curated keyless publisher feeds (TechCrunch, Verge, BBC…) (`18f20b0`)

### Documentation

- Sprint 3 README + BACKLOG + env (Content Studio, LinkedIn org URN) (`8eeea1b`)
- Sprint 1 Technical Documentation (`d475381`)
- Sprint 2 Technical Documentation (`6899f31`)
- Sprint 3 Technical Documentation (`c790586`)

### Tests, build and tooling

- Sprint 3 tests (content schemas, state machine, retrieval) (`e4d1b3f`)

### Database migrations

- `20260723151014_sprint3_content_studio`

### New environment variables

- `LINKEDIN_ORG_URN`

## [0.2.0] — 2026-07-23 · Trends, AI and LinkedIn

_Sprint 2 · 8 commits · +3,537 / −100 lines · last commit `1ff9ad2`_

### Added

- Sprint 2 schema — trend config + LinkedIn profile fields (`e0a48b3`)
- Reusable Claude service + shared HTTP client (`bea3b50`)
- Trend sources, scoring, config + digest engine (`e0a9a44`)
- Digest API + Trend Intelligence dashboard (`a9c716b`)
- Official OAuth connect/disconnect + Connections UI (`f00f1af`)

### Removed

- Sprint Jira csv (`1ff9ad2`)

### Documentation

- README + .env.example for Sprint 2 (LinkedIn, trends, cron) (`c6c8aff`)

### Tests, build and tooling

- Sprint 2 unit tests (scoring, Claude wrapper, HN connector) (`b2468ab`)

### Database migrations

- `20260723070803_sprint2_trend_config`
- `20260723124640_sprint2_linkedin_fields`

### New environment variables

- `ANTHROPIC_MODEL`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`, `TWITTER_BEARER_TOKEN`, `CRON_SECRET`

## [0.1.0] — 2026-07-23 · Foundation

_Sprint 1 · 11 commits · +12,800 / −0 lines · last commit `4da9da5`_

### Added

- Prisma schema for the full 10-sprint roadmap (`f67bb06`)
- Design system foundation (`64c9b5a`)
- NextAuth authentication system + RBAC scaffold (`7323404`)
- 3-step company onboarding wizard (`5666a10`)
- Persistent app shell + settings (`4db020e`)

### Fixed

- Load .env so `pnpm db:seed` works standalone (`c243776`)

### Documentation

- README (setup, env, architecture) + DESIGN.md tokens (`c04359f`)
- Add Sprint 1 Jira bulk-import CSV (epics + stories, status To Do) (`4da9da5`)

### Tests, build and tooling

- Scaffold Next.js 14 + TypeScript project foundation (`09971ac`)
- Unit tests for password, crypto, validation, and company service (`11d9daf`)
- Approve trusted dependency builds for reproducible install (`1823514`)

### Database migrations

- `0_init`

### New environment variables

- `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `ANTHROPIC_API_KEY`

---

_Generated from the git history on 30 Oct 2026: 204 commits, 49 migrations._
