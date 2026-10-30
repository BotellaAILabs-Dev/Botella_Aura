# Specifications — Botella Aura

The technical specifications Aura is built to: runtime, platform limits, content and media specs, AI budgets,
security and quality gates. Every value is taken from the code; the file holding each value is named so it can be
checked or changed.

## 1. Runtime and toolchain

| Item | Specification | Source |
| --- | --- | --- |
| Node.js | ≥ 20 | `package.json → engines` |
| Package manager | pnpm ≥ 9 (lockfile `pnpm-lock.yaml`; CI installs with `--frozen-lockfile`) | `pnpm-workspace.yaml` |
| Framework | Next.js 14.2.18, App Router, React 18.3 | `package.json` |
| Language | TypeScript 5.6, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, target ES2022, path alias `@/*` | `tsconfig.json` |
| Database | PostgreSQL (16 locally via Docker `postgres:16-alpine`; Neon in production) | `docker-compose.yml` |
| ORM | Prisma 5.22 — 61 models, 49 migrations | `prisma/schema.prisma`, `prisma/migrations/` |
| Auth | NextAuth v4 (JWT sessions) + Prisma adapter; credentials, Google, LinkedIn OIDC | `lib/auth.ts` |
| Validation | Zod 3 for every input, AI output and handoff contract | `lib/validations/*` |
| Styling | Tailwind CSS 3.4 + shadcn/ui pattern (Radix + cva) | `tailwind.config.ts`, `components/ui/` |
| Tests | Vitest 2 + Testing Library + jsdom; Playwright-core for responsive checks | `vitest.config.ts` |

## 2. Hosting and serverless limits

| Item | Specification | Source |
| --- | --- | --- |
| Region | Vercel `sin1` (Singapore), next to Neon `ap-southeast-1` | `vercel.json` |
| Function duration | `maxDuration` 60 s on every route (valid on all Vercel plans); long work runs as resumable jobs | route files |
| Build | `pnpm run vercel-build`: package extension → `prisma generate` → `scripts/migrate-deploy.mjs` → `next build` | `package.json` |
| Migration on deploy | Connection errors retried 5× with backoff (~30 s); migration errors fail at once; `ALLOW_DEPLOY_WITHOUT_MIGRATIONS=1` downgrades an unreachable DB to a warning | `scripts/migrate-deploy.mjs` |
| Database connections | Pooled `DATABASE_URL` at runtime; direct `DIRECT_URL` for migrations (PgBouncer breaks advisory locks) | `prisma/schema.prisma` |
| Cron (Vercel) | `/api/cron/publish` `0 9 * * *` · `/api/cron/connections` `0 6 * * *` · `/api/cron/briefing` `0 5 * * 1` | `vercel.json` |
| Other cron routes | trends, competitors, outreach, discovery, memory, analytics, intelligence, advisor, campaigns, whatsapp, jobs — `Authorization: Bearer $CRON_SECRET`. **Not scheduled in `vercel.json`** (only three crons are): they run only when called by an external scheduler or by hand | `app/api/cron/*` |
| Security headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` | `next.config.mjs` |
| Native packages | `@resvg/resvg-js` kept out of the server bundle (`serverComponentsExternalPackages`); `sharp` is external by default; creative fonts traced in | `next.config.mjs` |

## 3. Roles and permissions

| Permission | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- |
| `company:update` | ✓ | ✓ | | |
| `company:delete` | ✓ | | | |
| `company:manageBilling` | ✓ | | | |
| `members:invite` / `members:remove` | ✓ | ✓ | | |
| `linkedin:connect` | ✓ | ✓ | | |
| `content:create` | ✓ | ✓ | ✓ | |
| `content:approve` / `content:publish` | ✓ | ✓ | | |

Source: `lib/rbac.ts`. A company can never be left without an owner.

## 4. Social platform media specs

| Platform | Aspect ratios | Default | File types | Max size | Dimensions (min–max px) | Media required |
| --- | --- | --- | --- | --- | --- | --- |
| LinkedIn | 1:1, 4:5, 16:9 | 1:1 | PNG, JPEG | 10 MB | 200–4000 | No |
| Instagram | 1:1, 4:5, 9:16 | 4:5 | JPEG (PNG re-encoded to JPEG for Instagram) | 8 MB | 320–1440 | **Yes** |
| Facebook | 1:1, 4:5, 16:9 | 1:1 | PNG, JPEG | 8 MB | 200–4000 | No |
| X (Twitter) | 16:9, 1:1 | 16:9 | PNG, JPEG, WebP | 5 MB | 200–4096 | No |

Generation sizes per ratio: 1:1 → 1024×1024 · 4:5 → 1024×1280 · 16:9 → 1344×768 · 9:16 → 768×1344.
Source: `lib/platforms.ts`. Instagram carousels take 2–10 items; Reels need an S3 bucket.

## 5. Content format and length specs

| Format / network | Soft limit (chars) | Hard limit (chars) | Source |
| --- | --- | --- | --- |
| LinkedIn post | 1,500 | 3,000 | `lib/content-playbook.ts` |
| Instagram caption | 1,000 | 2,200 | same |
| Facebook post | 600 | 5,000 | same |
| X post | 240 | 280 | same |
| X thread | 1,680 (6 × 280) | 3,360 (12 × 280) | same |
| Blog | 12,000 | 40,000 | same |
| Email | 2,000 | 6,000 | same |
| Ad | 400 | 1,200 | same |
| Campaign copy | 1,600 | 2,400 | same |
| Promo | 700 | 1,300 | same |

Nine generation formats are defined once in `lib/content-formats.ts`: LinkedIn/social post, image post (caption),
carousel (3–10 images), thread, blog, email, ad, campaign copy, promo. Email and ad are copy-only (never
scheduled or published). The Content Brief has 16 fields (`lib/content-brief.ts`, version 1).

## 6. Branded creative specs

| Item | Specification | Source |
| --- | --- | --- |
| Output sizes | 1080×1080, 1080×1350, 1080×1920, 1920×1080 PNG | `lib/creative/` |
| Layouts | hero, split, frame, offer, editorial, spotlight | same |
| Creative types | 10 | same |
| Fonts | 4 bundled OFL pairings (include the ₹ sign) in `assets/fonts` | same |
| Text fitting | Measured from font metrics; never cropped or overlapping; unfittable text refused | `server/media/creative/` |
| Logo | Composited from the uploaded file (never drawn by AI); tints: original, white, black, brand | `server/media/logo-overlay` |
| Negative prompt | Max 400 characters (stored prompts replay through a 400-char schema) | `lib/photo-realism.ts` |

## 7. AI specifications

| Item | Specification | Source |
| --- | --- | --- |
| Providers | Anthropic Claude (primary), Google Gemini (fallback); neither → labelled template fallback | `server/ai/claude.ts` |
| Model tiers | cheap / standard / premium (Claude: Haiku 4.5 / Sonnet 5 / Opus 4.8; Gemini: `gemini-3.5-flash-lite` for all) | same |
| Retries | Transient failures and empty completions: up to 3 attempts in total (`MAX_ATTEMPTS`; `maxAttempts` lowers it for deadline-bound callers) | same |
| Structured output | Zod-validated; one extra attempt with the validation error fed back; malformed output is never saved | same |
| Long outputs | Streamed above 8,000 max tokens | same |
| Generation context budget | 3,200 tokens with per-section caps; secrets, card numbers and internal ids removed | `lib/generation-context.ts` |
| AI reviewer | 11 dimensions scored 1–5 (incl. brand safety); dimension pass ≥ 75, fail < 50; overall pass ≥ 70, fail < 50 | `lib/content-review.ts` |
| Recommendation limits | 10 per day, 15 awaiting a decision, 5 per channel per week; expiry capped at 30 days | `lib/recommendation-rules.ts` |
| Business Context snapshot | Rebuilt when sources change or after 6 h | `server/business-context/` |
| Marketing Memory | No insights below 10 measured posts | `server/memory/metrics.ts` |
| Image generation | Gemini: 25 s per attempt, one retry; up to 4 images per call | `server/media/providers/gemini.ts` |
| Content plan | Weekly drafts in parallel inside a 45 s budget; runs considered dead after 2 min | `server/planner/calendar-draft.ts` |

## 8. WhatsApp assistant specs

| Item | Specification |
| --- | --- |
| Transport | Meta WhatsApp Cloud API, one central number; webhook signed with `X-Hub-Signature-256` |
| Queue | Postgres work queue; per-conversation ordering (lease), backoff, dead letter; tested with 1,000 simulated users |
| Concurrency | `WHATSAPP_WORKER_CONCURRENCY` default 48 conversations per process |
| Retention | Message text kept `WHATSAPP_RETENTION_DAYS` (default 90) days |
| Linking | Single-use hashed link token + 6-digit code; 30-day sessions |
| Safety | Approve / reject / publish need a single-use explicit "yes"; 24-hour messaging window respected; STOP / START |

## 9. Security specifications

| Item | Specification |
| --- | --- |
| Secrets at rest | AES-256-GCM with `ENCRYPTION_KEY` (32 bytes) for OAuth tokens and connector keys |
| Hashed tokens | Password reset, invitations, extension tokens, WhatsApp link tokens stored as SHA-256 only |
| Passwords | bcrypt (`bcryptjs`), minimum 8 characters |
| OAuth | Browser binding + PKCE verifier on every connector flow; Meta `signed_request` HMAC with replay window |
| Workspace isolation | Every query scoped by `companyId`; foreign ids → 404; static + HTTP tests (`verify:access`, `verify:recommendation-security`) |
| Rate limiting | Sliding window on public auth endpoints (`lib/rate-limit.ts`) |
| Outbound links | `safeExternalUrl` allows http(s) only; SSRF-safe redirects |
| Sandbox overrides | Honoured only for loopback hosts; `env:check --production` fails if set |

## 10. Quality gates

| Gate | Command | Standard at handover |
| --- | --- | --- |
| Type check | `pnpm typecheck` | Clean |
| Lint | `pnpm lint` | Clean |
| Format | `pnpm format:check` | Prettier |
| Unit tests | `pnpm test` | 2,141 passing (147 suites) |
| Pages | `pnpm verify:pages` | 45 of 45 dashboard pages render |
| End-to-end | `pnpm verify:*` (66 scripts) | Pass against a running app (`VERIFY_BASE_URL`, default port 3001) |
| Responsive | `pnpm verify:responsive` | 375 / 768 / 1280 px |
| Build | `pnpm build` | Clean |

Rule: run only **one** `next dev` per checkout — two servers sharing `.next` produce false 500 errors.
