# Vercel deployment: audit and verification checklist

Audit run on 22 Oct 2026, against the repository. There was no Vercel access from here, so the Vercel-side steps below are manual.

## What the audit checked

| Area | Finding |
| --- | --- |
| Build command | `vercel.json` sets `pnpm run vercel-build`: `package-extension` → `prisma generate` → **`prisma migrate deploy`** (with retries, `scripts/migrate-deploy.mjs`) → `next build`. **Every deployment migrates its database.** |
| Build (`build` script) | Passes: compiled, 229 routes, exit 0 |
| Build (`vercel-build`, exactly as Vercel runs it) | Passes when the variables are real environment variables, as on Vercel (49 migrations, none pending locally, compiled). Run on a machine where they exist only in `.env`, the shell passes `DIRECT_URL` as empty. That's a local artifact, not a Vercel problem. |
| Typecheck / lint / unit tests | Clean / clean / 1,961 pass |
| `next.config.mjs` | `instrumentationHook` on; `@resvg/resvg-js` external, fonts traced into `/api/**` and `/dashboard/**`; images accept any https host (an open image proxy, a cost note already in the file) |
| `instrumentation.ts` + `lib/env-check.ts` | Runs once per server start on Node. It logs, by **name only**, which integrations are ready, off or partly configured, and flags secrets given a `NEXT_PUBLIC_` prefix, localhost or non-https URLs in production, a malformed `ENCRYPTION_KEY`, and the load-test stub. Never stops the app. |
| `env:check` (local) | Core and LinkedIn ready; WhatsApp, Meta and video storage off (credentials not set) |
| `env:check --production` against the local `.env` | 1 error, 1 warning, as expected: `NEXTAUTH_URL` is localhost (fine locally; must be the https domain on Vercel) |
| Function limits | Every `maxDuration` is ≤ 60 s (51 routes at 60, 2 at 30); no Edge-runtime routes. Fits every Vercel plan. |
| Webhooks | WhatsApp, Stripe, Meta deauthorize and Meta data-deletion: all `force-dynamic`, all read the raw body (`req.text()` / `formData()`) for signature checks, and WhatsApp runs on Node with `waitUntil` (`@vercel/functions`). Middleware only guards `/dashboard` and `/onboarding`, so the webhooks are reachable. |
| Crons | Vercel calls crons with GET. All scheduled routes export GET (= POST), and each checks `Authorization: Bearer $CRON_SECRET`. |
| OAuth callback domains | Meta, Google connectors, **LinkedIn** and the Stripe return links all build from `APP_URL`, then `NEXTAUTH_URL`, then Vercel's production URL. Checked under Production (URLs set), Production (only Vercel's variables) and local. |
| Secrets in the browser | No `NEXT_PUBLIC_` variable in the code. Scan of the production build's 97 browser files: **0** contain any of the 11 secret values in `.env`, and **0** contain a secret variable name. |

### Fixed during the audit

**LinkedIn's OAuth redirect and Stripe's checkout return links fell back to `http://localhost:3000` when `NEXTAUTH_URL` was unset.** Both now use the shared app-URL helper, like every other callback. When `NEXTAUTH_URL` is set, nothing changes; that's the configured case.

## Deployment blockers and risks

These are configuration, not code.

1. **Production must have, before deploying:**
   - `DATABASE_URL`, `DIRECT_URL` (the direct, non-pooled URL), `NEXTAUTH_SECRET` and `ENCRYPTION_KEY`
   - `NEXTAUTH_URL` and `APP_URL` set to the https production domain
   - `CRON_SECRET`

   Without the database variables, the build fails at the migration step.
2. **Deploying migrates production.** The four migrations of 16–21 Oct will run on the first Production build that hasn't applied them. See `docs/PRODUCTION-MIGRATION.md`: check the status and take a backup **first**.
3. **Preview must not use the production database.** Preview builds run `migrate deploy` too. Give Preview its own `DATABASE_URL` and `DIRECT_URL`, for example a Neon branch.
4. **The database must be reachable from Vercel's build machines.** An IP allowlist or a missing `sslmode=require` fails the build. `ALLOW_DEPLOY_WITHOUT_MIGRATIONS=1` exists only to work around that, and then you migrate by hand.
5. **Crons depend on the Vercel plan.**
   - `vercel.json` schedules 3 crons: publish at 09:00 daily, briefing Mondays at 05:00, connections at 06:00 daily.
   - Hobby plans allow only daily schedules, and limit how many crons a project may have. Check yours under **Settings → Cron Jobs** after deploying. If the plan rejects the third cron, the deployment says so.
   - Other jobs are **not** scheduled in `vercel.json`. They only run if something calls them with `CRON_SECRET`:
     - `/api/cron/whatsapp` (retries of failed WhatsApp replies)
     - advisor, analytics, campaigns, competitors, discovery, intelligence, jobs, memory, outreach, trends
   - Publishing once a day means scheduled posts can go out up to a day late.
6. **OAuth doesn't work on Preview URLs.** The redirects use the production domain, so a sign-in started on a preview finishes on production without the preview's binding cookie, and is refused. Test integrations on Production, or on a stable domain you register.
7. **Region:** functions run in `sin1` (Singapore). Keep the database in or near that region, or every query pays the distance.

## Vercel dashboard steps

1. **vercel.com → the Botella Aura project → Settings → General**
   - Framework: Next.js
   - **Build Command:** leave empty; `vercel.json` sets it
   - **Node.js Version:** 20.x or newer (`package.json` requires `>=20`)
   - **Install Command:** default; pnpm is detected from `pnpm-lock.yaml`
2. **Settings → Domains:** add the production domain, then use it for `NEXTAUTH_URL` and `APP_URL`.
3. **Settings → Environment Variables:** add the variables in `docs/DEPLOYMENT-ENV.md`.
   - Production: all of them.
   - Preview: its own database. No WhatsApp variables.
   - Mark every secret **Sensitive**.
   - Never use a `NEXT_PUBLIC_` prefix.
4. **Settings → Git:** confirm the Production Branch is `main`.
5. **Before the first deploy that contains the 16–21 Oct migrations,** do steps 1–2 of `docs/PRODUCTION-MIGRATION.md`: migration status, then backup.
6. **Deploy** (only with approval): **Deployments → Redeploy** the latest `main` deployment, or push to `main`.

## Verification after deploying

| # | Check | Pass when |
| --- | --- | --- |
| 1 | **Deployments → the deployment → Building** log | `prisma migrate deploy` printed "All migrations have been successfully applied" or "No pending migrations"; `✓ Compiled successfully`; status **Ready** |
| 2 | **Logs** (runtime), filtered on `environment` | `environment: configuration` with every configured integration **READY** and **no `ERROR:` lines** (names only, no values) |
| 3 | Open `https://<domain>/login` | Page loads; sign in works (NextAuth) |
| 4 | `https://<domain>/dashboard/connectors` | Meta and LinkedIn cards show **Available**, not "Awaiting app credentials". The redirect URI shown is `https://<domain>/api/connectors/meta/callback`. |
| 5 | `/dashboard/connections` and `/dashboard/executions` | Load. Existing connections show as connected (migrations applied). |
| 6 | `curl -i https://<domain>/api/cron/publish` with no auth header | `401`: crons are protected |
| 7 | **Settings → Cron Jobs** | The 3 crons are listed and enabled |
| 8 | `curl -i "https://<domain>/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"` | `403` (WhatsApp configured: wrong token refused) or `503` (WhatsApp not configured) |
| 9 | Meta: **WhatsApp → Configuration → Verify and save** with the real verify token | Succeeds |
| 10 | Connect LinkedIn and Facebook & Instagram from the deployed site | Each returns to `https://<domain>/…/callback` and shows **Connected / Healthy** in the Connection Manager |
| 11 | Locally: `DATABASE_URL=<prod> DIRECT_URL=<prod direct> pnpm prisma migrate status` (shell only) | "Database schema is up to date" |
