# Resources — Botella Aura

Everything you need to work on Aura in one place: the project's dependencies and specifications, where to get
every account and key, the official documentation for each technology and provider, and the internal documents
and tools in this repository.

| Document | What it holds |
| --- | --- |
| [DEPENDENCIES.md](DEPENDENCIES.md) | Every npm package with version, purpose and usage count; native packages; every npm script |
| [SPECIFICATIONS.md](SPECIFICATIONS.md) | Runtime, hosting limits, roles, media and content specs, AI budgets, security, quality gates |
| [../06-environment/ENVIRONMENT-VARIABLES.md](../06-environment/ENVIRONMENT-VARIABLES.md) | Every environment variable: purpose, where used, where and how to get it |
| [../04-api/INTERNAL-API.md](../04-api/INTERNAL-API.md) | Every Aura API route |
| [../04-api/EXTERNAL-APIS.md](../04-api/EXTERNAL-APIS.md) | Every third-party API Aura calls |

## 1. Accounts and consoles (where to get keys)

| Service | Console | What you get there |
| --- | --- | --- |
| Neon (PostgreSQL) | https://console.neon.tech | `DATABASE_URL` (pooled), `DIRECT_URL` (direct) |
| Vercel | https://vercel.com/dashboard | Deployments, env vars, cron, logs |
| Anthropic | https://console.anthropic.com | `ANTHROPIC_API_KEY` |
| Google AI Studio | https://aistudio.google.com/apikey | `GEMINI_API_KEY`, `GOOGLE_AI_API_KEY` |
| Google Cloud Console | https://console.cloud.google.com/apis/credentials | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Google Programmable Search | https://programmablesearchengine.google.com | `GOOGLE_CSE_CX` (key: https://developers.google.com/custom-search/v1/overview) |
| Meta for Developers | https://developers.facebook.com/apps | `META_CLIENT_ID`, `META_CLIENT_SECRET`, `META_LOGIN_CONFIG_ID`, WhatsApp app secret |
| Meta Business Settings | https://business.facebook.com/settings | WhatsApp system-user token, phone number id |
| LinkedIn Developers | https://www.linkedin.com/developers/apps | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| OpenAI | https://platform.openai.com/api-keys | `OPENAI_API_KEY` |
| Stability AI | https://platform.stability.ai/account/keys | `STABILITY_API_KEY` |
| Replicate | https://replicate.com/account/api-tokens | `REPLICATE_API_TOKEN` |
| Hugging Face | https://huggingface.co/settings/tokens | `HUGGINGFACE_API_KEY` (needs "Make calls to Inference Providers") |
| Stripe | https://dashboard.stripe.com | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price ids |
| Resend | https://resend.com | `RESEND_API_KEY` |
| Reddit | https://www.reddit.com/prefs/apps | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| GitHub | https://github.com/settings/tokens | `GITHUB_TOKEN` |
| Crunchbase | https://data.crunchbase.com/docs/using-the-api | `CRUNCHBASE_API_KEY` |
| HubSpot | https://developers.hubspot.com | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` |
| Mailchimp | https://mailchimp.com/developer | `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET` |
| Slack | https://api.slack.com/apps | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| Sentry | https://sentry.io | `SENTRY_DSN` |
| Chrome Web Store | https://chrome.google.com/webstore/devconsole | Published extension id → `EXTENSION_ALLOWED_ORIGIN` |

## 2. Technology documentation

| Technology | Documentation |
| --- | --- |
| Next.js 14 (App Router) | https://nextjs.org/docs/14 |
| React 18 | https://react.dev |
| TypeScript | https://www.typescriptlang.org/docs |
| Prisma 5 | https://www.prisma.io/docs |
| PostgreSQL | https://www.postgresql.org/docs |
| NextAuth v4 | https://next-auth.js.org |
| Zod 3 | https://zod.dev |
| Tailwind CSS 3 | https://v3.tailwindcss.com/docs |
| Radix UI | https://www.radix-ui.com/primitives |
| shadcn/ui | https://ui.shadcn.com |
| Vitest | https://vitest.dev |
| Playwright | https://playwright.dev |
| satori | https://github.com/vercel/satori |
| resvg-js | https://github.com/yisibl/resvg-js |
| sharp | https://sharp.pixelplumbing.com |
| Vercel (functions, cron, regions) | https://vercel.com/docs |
| Neon | https://neon.tech/docs |
| Chrome extensions (Manifest V3) | https://developer.chrome.com/docs/extensions |
| Mermaid (diagrams in these docs) | https://mermaid.js.org |

## 3. Provider API documentation

| Provider | Documentation |
| --- | --- |
| Anthropic Claude | https://docs.anthropic.com |
| Google Gemini API | https://ai.google.dev/api |
| Meta Graph API | https://developers.facebook.com/docs/graph-api |
| Instagram Platform | https://developers.facebook.com/docs/instagram-platform |
| WhatsApp Cloud API | https://developers.facebook.com/docs/whatsapp/cloud-api |
| Meta App Review | https://developers.facebook.com/docs/app-review |
| LinkedIn APIs | https://learn.microsoft.com/en-us/linkedin/ |
| Google OAuth 2.0 | https://developers.google.com/identity/protocols/oauth2 |
| Google Analytics Admin API | https://developers.google.com/analytics/devguides/config/admin/v1 |
| Search Console API | https://developers.google.com/webmaster-tools |
| OpenAI Images | https://platform.openai.com/docs/guides/images |
| Stability AI | https://platform.stability.ai/docs/api-reference |
| Replicate | https://replicate.com/docs |
| Hugging Face Inference | https://huggingface.co/docs/inference-providers |
| Stripe | https://docs.stripe.com |
| Resend | https://resend.com/docs |
| Reddit API | https://www.reddit.com/dev/api |
| Hacker News API | https://github.com/HackerNews/API |
| GitHub REST API | https://docs.github.com/en/rest |
| Crunchbase API | https://data.crunchbase.com/docs/using-the-api |

## 4. In this repository

| Resource | Path | Purpose |
| --- | --- | --- |
| Product documentation | [`docs/PRODUCT-DOCUMENTATION.md`](../../PRODUCT-DOCUMENTATION.md) | Full product and technical reference (Sprints 1–6) |
| Project status | [`docs/PROJECT-STATUS.md`](../../PROJECT-STATUS.md) | Done / not done / blockers (as of 17 Aug) |
| README | [`README.md`](../../../README.md) | Quick start, env, scripts, sandbox |
| Design system | [`DESIGN.md`](../../../DESIGN.md) | Colour tokens, type, components |
| Backlog | [`BACKLOG.md`](../../../BACKLOG.md) | Deferred ideas |
| Feature documents | [`docs/*.md`](../../) | 81 per-feature technical docs and sprint test reports |
| Schema | [`prisma/schema.prisma`](../../../prisma/schema.prisma) | 61 models |
| Migrations | [`prisma/migrations/`](../../../prisma/migrations/) | 49 migrations |
| Seeds | [`prisma/seed.ts`](../../../prisma/seed.ts), [`prisma/seed-demo.ts`](../../../prisma/seed-demo.ts) | Demo login `demo@botella.ai` / `Password123`; connected sample story |
| Env template | [`.env.example`](../../../.env.example) | Every variable name with guidance |
| Chrome extension | [`extension/`](../../../extension/) | MV3 extension source (`extension/README.md`) |
| Fonts for creatives | [`assets/fonts/`](../../../assets/fonts/) | Bundled OFL fonts |
| Verification scripts | [`scripts/`](../../../scripts/) | 66 `verify:*` suites, sandbox, env check, DB checker |
| Unit tests | [`tests/`](../../../tests/) | 147 Vitest suites |
| Local database | [`docker-compose.yml`](../../../docker-compose.yml) | Postgres 16 on port 5432 |
| Deploy configs | [`vercel.json`](../../../vercel.json), [`netlify.toml`](../../../netlify.toml), [`railway.json`](../../../railway.json) | Hosting targets |

## 5. Tools that answer common questions

| Question | Command |
| --- | --- |
| Is my environment complete? | `npm run env:check` (`-- --production` for production rules) |
| Which OAuth redirect URIs do I register? | `npm run auth:endpoints [port\|host\|url]` |
| Why can't the app reach the database? | `node scripts/check-db.mjs "<DATABASE_URL>"` — names the failing layer |
| Will pending migrations apply? | `pnpm db:rehearse` |
| Can I test Meta publishing without Meta? | `npm run sandbox` then `npm run sandbox check` |
| Can I test WhatsApp without a phone? | `npm run whatsapp:local serve`, then `say "<message>"` or `script` |
| Does every page render? | `pnpm verify:pages` |
| Is tenant isolation intact? | `pnpm verify:access`, `pnpm verify:recommendation-security` |
| Browse the database | `pnpm db:studio` |
