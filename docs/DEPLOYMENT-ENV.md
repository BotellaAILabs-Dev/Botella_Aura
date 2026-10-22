# Environment variables: local, Vercel Preview, Vercel Production

This covers the core settings plus the Meta (WhatsApp, Facebook, Instagram) and LinkedIn integrations. Every name is the one the code reads; the placeholders are in `.env.example`.

**Check what is set (names only, never values):**
- `pnpm env:check` checks against the local rules.
- `pnpm env:check --production` checks against the production rules.
- At server start, the same report is written to the log (`instrumentation.ts`).

## Variables

| Variable | Needed for | Local | Preview | Production | Secret |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | Everything | ✓ | ✓ (a separate database is best) | ✓ | yes |
| `NEXTAUTH_SECRET` | Sign-in | ✓ | ✓ | ✓ | yes |
| `NEXTAUTH_URL` | Sign-in (NextAuth, Google login); fallback for every OAuth redirect when `APP_URL` is unset | `http://localhost:3000` | see note | `https://<your domain>` | no |
| `APP_URL` | **OAuth redirects** (Meta, Google connectors, LinkedIn), Stripe return links and the image links Meta fetches; falls back to `NEXTAUTH_URL`, then Vercel's production URL | tunnel URL when testing Meta | see note | `https://<your domain>` (same host as `NEXTAUTH_URL`) | no |
| `ENCRYPTION_KEY` | Stored tokens (AES-256-GCM); 32 bytes base64 | ✓ | ✓ | ✓, **never change it** once tokens are stored | yes |
| `CRON_SECRET` | Scheduled jobs (publishing, WhatsApp retries, connection checks) | optional | optional | ✓ | yes |
| `META_CLIENT_ID` | Facebook & Instagram | when testing | optional | ✓ | no |
| `META_CLIENT_SECRET` | Facebook & Instagram; Meta deauthorize / data-deletion callbacks | when testing | optional | ✓ | yes |
| `META_GRAPH_VERSION`, `META_OAUTH_PKCE`, `META_REQUEST_INSIGHTS` | Optional tuning | — | — | optional | no |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp | when testing | **no** (see note) | ✓ | yes |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp | when testing | no | ✓ | no |
| `WHATSAPP_APP_SECRET` | WhatsApp webhook signature | when testing | no | ✓ | yes |
| `WHATSAPP_VERIFY_TOKEN` | WhatsApp webhook handshake | when testing | no | ✓ | yes |
| `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_DISPLAY_NUMBER` | Optional | — | — | optional | no |
| `WHATSAPP_GRAPH_BASE_URL` | **Load tests only**: never on Vercel | — | — | **must be unset** | — |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | LinkedIn | ✓ (set) | optional | ✓ | the secret is |
| `LINKEDIN_API_VERSION` | LinkedIn posting (`YYYYMM`). Optional: the code default is `202610` (`lib/linkedin-api.ts`), LinkedIn’s latest on 22 Oct 2026 and supported to at least Oct 2027. `env:check` warns once a version is a year old. | — | — | optional | no |
| `LINKEDIN_ORG_URN`, `LINKEDIN_OAUTH_PKCE` | Optional | — | — | optional | no |
| `ASSET_S3_ENDPOINT`, `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY` (+ `ASSET_S3_REGION`, `ASSET_S3_PUBLIC_BASE_URL`) | Instagram video (Reels) | optional | optional | for video | the keys are |

Other variables (AI providers, Google, email and so on) are unchanged and documented in `.env.example`.

### Notes

**Preview deployments**
- Each preview gets a different URL, and OAuth redirect URIs must be registered exactly. So Meta and LinkedIn connect only on hosts you have registered.
- Either leave those integrations off in Preview, or give previews a stable branch domain and register it.

**WhatsApp in Preview**
- One WhatsApp number has **one** webhook URL, which should point at Production.
- Don't put the WhatsApp variables in Preview with the same number. A preview could then send messages as the real number.
- For preview testing, use a separate Meta app or test number.

**Keeping secrets server-side**
- Never add `NEXT_PUBLIC_` to any of these names: Next.js inlines `NEXT_PUBLIC_*` into browser code. `env:check` reports it as an error if you do.
- The code uses no `NEXT_PUBLIC_` variables at all. A scan of the production build found **no secret value** in any browser file.

## Vercel dashboard steps

1. Open <https://vercel.com> → your team → the **Botella Aura** project.
2. Go to **Settings → Environment Variables**.
3. For each variable, click **Add New** (or **Add Another**):
   1. **Key:** the exact name from the table.
   2. **Value:** paste it directly from its source (Meta dashboard, LinkedIn app, your password manager).
   3. **Sensitive:** turn on for every variable marked secret above, so its value can't be read back later.
   4. **Environments:** tick **Production**, and **Preview** only where the table says so. Tick **Development** only if you use `vercel env pull`.
   5. Click **Save**.
4. **Production** also needs:
   - `NEXTAUTH_URL` and `APP_URL` set to the production domain, for example `https://app.botella.example`: https, no trailing slash, the same host for both.
   - The same host registered with Meta and LinkedIn:
     - Meta: `https://<domain>/api/connectors/meta/callback`, `/api/meta/deauthorize`, `/api/meta/data-deletion`, and the webhook `/api/webhooks/whatsapp`
     - LinkedIn: `https://<domain>/api/linkedin/callback`
5. **Redeploy.** Variables apply only to new deployments: go to **Deployments** → the latest Production deployment → **⋯ → Redeploy**, or push a commit.
6. **Check the deployment.**
   - Open the deployment's **Logs** and find `environment: configuration`.
   - Every integration you configured should say **READY**, with no `ERROR:` lines.
   - An `ERROR` line names the problem, never a value.
7. **Run the database migrations** against the production database: `prisma migrate deploy`, run by the build or by hand.

CLI alternative: `vercel env add WHATSAPP_ACCESS_TOKEN production`. It prompts for the value, so the value isn't saved in your shell history.

## Local development

- Put values in `.env` in the project root. It's git-ignored, along with `.env*.local`, `.env.development` and `.env.production`; only `.env.example` is tracked.
- Restart `pnpm dev` after editing.
- Check with `pnpm env:check`. For WhatsApp, also run `pnpm whatsapp:check` (`docs/WHATSAPP-TEST-SETUP.md`).
