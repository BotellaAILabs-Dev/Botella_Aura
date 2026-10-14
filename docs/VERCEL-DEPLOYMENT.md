# Deploying Botella Aura to Vercel

Everything in `.env` is gitignored and therefore **does not exist on Vercel**.
The deployment reads its configuration from Vercel's own environment variable
store, and nothing else. That single fact is behind most "it works locally but
not on the deployment" reports — including a graphic generator that renders but
refuses to generate.

---

## 1. Environment variables

Vercel Dashboard → your project → **Settings → Environment Variables**. Add each
one, tick **Production**, **Preview** and **Development**, Save.

**Environment variable changes do not affect deployments that already exist.**
After saving, go to **Deployments → ⋯ → Redeploy**, or push a commit.

### Required — the app will not boot without these

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | The **pooled** connection string. Serverless opens many short-lived connections, so this must go through the pooler — append `?pgbouncer=true&connection_limit=1` on Supabase/Neon. |
| `DIRECT_URL` | The **direct**, non-pooled string. `prisma migrate deploy` needs it, because PgBouncer's transaction pooling breaks the advisory locks migrations take. If your provider gives one URL only, set this to the same value — that is always safe. |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | The deployment's public URL, e.g. `https://your-app.vercel.app` |
| `ENCRYPTION_KEY` | Must decode to **exactly 32 bytes** or `lib/crypto.ts` throws at startup. `openssl rand -base64 32` |

### Required for the AI features to do anything

| Variable | Notes |
| --- | --- |
| `GEMINI_API_KEY` | Powers **both** text generation and image generation. `server/ai/claude.ts` falls back to Gemini when Anthropic is absent, and `server/media/providers/gemini.ts` accepts this same key for images. One key, both features. |
| `CRON_SECRET` | Any long random string. The cron routes **fail closed** — without this every scheduled run is rejected with 401. Vercel attaches it as `Authorization: Bearer $CRON_SECRET` automatically. |

`ANTHROPIC_API_KEY` is an alternative to `GEMINI_API_KEY` and takes precedence
when both are set.

### Optional, per feature

| Variable | Enables |
| --- | --- |
| `OPENAI_API_KEY` / `STABILITY_API_KEY` / `REPLICATE_API_TOKEN` | Additional image providers beyond Gemini |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Billing |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | LinkedIn publishing |
| `RESEND_API_KEY` **or** `SMTP_*` | Outbound email (invites, password resets) |
| `ASSET_S3_*` | Moves generated images out of Postgres into S3 |

You do **not** need `APP_URL`. `lib/app-url.ts` already reads Vercel's automatic
`VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL`.

---

## 2. Why the graphic generator says "No image model is configured"

It is not a bug, and not a missing feature. `app/api/content/drafts/[id]/graphics/route.ts`
refuses **before** queueing anything:

```ts
if (!isAnyProviderConfigured()) throw new NoImageProviderError();  // 503
```

`isAnyProviderConfigured()` is true only when one of `GOOGLE_AI_API_KEY`,
`GEMINI_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `OPENAI_API_KEY`,
`STABILITY_API_KEY` or `REPLICATE_API_TOKEN` is present **on the deployment**.

Failing fast is deliberate: a queued job that was always going to be rejected is
worse than an immediate, specific error.

**Fix:** add `GEMINI_API_KEY` in Vercel, then redeploy.

The studio diagnoses itself — open a draft, click **Generate graphic**, and if a
dashed box lists the provider env var names, that is exactly this condition.

### Where the graphic generator lives

It is not on the Content Studio list and not in the create dialog. It renders
inside an individual draft, at `/dashboard/content/[id]`, as a card titled
**"Graphic generation"**. If you have no drafts, there is nowhere for it to
appear — create one first.

---

## 3. Plan limits

`vercel.json` in this repo is written to deploy on **any plan, including Hobby**.

| | Hobby | Pro |
| --- | --- | --- |
| Cron jobs | 2, once per day | 40, any schedule |
| Function `maxDuration` | 60s | 300s |

Accordingly:

- **Every route caps `maxDuration` at 60**, which is valid everywhere.
- **`vercel.json` ships 2 crons**, the two that cannot be triggered any other
  way: `publish` (nothing goes out without it) and `briefing` (the home page).

Graphic generation does **not** depend on cron. The browser calls
`POST /api/jobs/:id/run` directly, so generation works on Hobby.

### Restoring the full schedule on Pro

There are thirteen cron routes. On Pro, replace the `crons` array in `vercel.json`
with the complete set — each schedule is the one documented in that route's own
header comment:

```json
"crons": [
  { "path": "/api/cron/jobs",         "schedule": "*/5 * * * *" },
  { "path": "/api/cron/publish",      "schedule": "0,15,30,45 * * * *" },
  { "path": "/api/cron/intelligence", "schedule": "0 5 * * *" },
  { "path": "/api/cron/campaigns",    "schedule": "0 9 * * *" },
  { "path": "/api/cron/outreach",     "schedule": "0 12 * * *" },
  { "path": "/api/cron/trends",       "schedule": "0 13 * * *" },
  { "path": "/api/cron/briefing",     "schedule": "0 5 * * 1" },
  { "path": "/api/cron/advisor",      "schedule": "0 6 * * 1" },
  { "path": "/api/cron/analytics",    "schedule": "0 8 * * 1" },
  { "path": "/api/cron/memory",       "schedule": "0 10 * * 1" },
  { "path": "/api/cron/discovery",    "schedule": "0 11 * * 1" },
  { "path": "/api/cron/competitors",  "schedule": "0 13 * * 1" },
  { "path": "/api/cron/whatsapp",     "schedule": "*/5 * * * *" }
]
```

The WhatsApp sweep (`/api/cron/whatsapp`) retries replies Meta throttled,
picks up messages a lost `waitUntil` left behind, and deletes message text
past its retention period. Normal replies do not wait for it. On Hobby, call
it from any free external scheduler every few minutes with
`Authorization: Bearer $CRON_SECRET` (see docs/WHATSAPP-ASSISTANT.md).

On Pro you may also raise `maxDuration` back to `300` on the AI-heavy routes
(`api/jobs/[id]/run`, `api/advisor`, `api/briefing`, `api/competitors/reports`,
`api/intelligence`, `api/planner`, `api/trends/refresh`). This is an
optimisation, not a requirement — see below.

### Why capping at 60s is safe

The long-running work is queue-backed and **resumable**. Images are persisted
one at a time as they arrive, and a retry only makes up the shortfall
(`server/media/generation.service.ts`):

```ts
const alreadyDone = args.jobId ? await assetsForJob(companyId, args.jobId) : [];
const remaining = variations - alreadyDone.length;
```

A run killed at image 3 of 4 leaves two real assets and regenerates only the
missing one — it does not bill the workspace twice. The cron routes process
companies one at a time and commit each as it finishes, so a timeout part-way
through loses no completed work.

---

## 4. Region

`"regions": ["iad1"]` pins functions to US East to sit next to the database.
Vercel's default is already `iad1`, so this changes nothing today — it is here so
a future project-setting change cannot silently move functions away from the
database and add a network hop to every query.

**If you move the database, change this.** Cross-region adds 200–300ms to every
roundtrip, and a dashboard page makes several.

---

## 5. Migrations

`package.json` runs them for you on deploy:

```
vercel-build: prisma generate && prisma migrate deploy && next build
```

`postinstall` also runs `prisma generate`. You do not need to run either by
hand — but note that a **stale local** Prisma client causes
`Cannot read properties of undefined (reading 'findFirst')`. If you see that in
local dev after pulling schema changes, run `pnpm db:generate`.

---

## 6. Deployment checklist

1. All **Required** variables above are set in Vercel
2. `GEMINI_API_KEY` set → AI text and image generation work
3. `CRON_SECRET` set → scheduled jobs are not rejected
4. `DATABASE_URL` is the pooled URL; `DIRECT_URL` is the direct one
5. Redeploy after any variable change
6. Sign in, create a draft, open it, click **Generate graphic**
