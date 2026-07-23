# Botella Aura — AI Marketing Co-Pilot

> **Sprint 1: Foundation.** Auth, company onboarding, a production-grade
> dashboard shell, and a schema designed for the full 10-sprint roadmap.

Botella Aura researches trends, analyzes companies, generates on-brand content,
and drafts outreach — with a **human-in-the-loop approval step before anything
goes live**. Nothing auto-posts, auto-connects, or auto-comments. Ever.

---

## Quick start (under 10 minutes)

**Prerequisites:** Node ≥ 20, [pnpm](https://pnpm.io) ≥ 9, and a PostgreSQL
database. No local Postgres? Use the bundled Docker setup (step 2).

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres (optional — skip if you have your own)
docker compose up -d

# 3. Configure environment
cp .env.example .env
#   → then generate the two secrets (see “Environment variables” below)

# 4. Create the schema and seed a demo workspace
pnpm db:migrate       # applies prisma/migrations
pnpm db:seed          # creates the demo user + company

# 5. Run it
pnpm dev              # → http://localhost:3000
```

**Demo login:** `demo@botella.ai` / `Password123`

That's the whole loop: sign up, complete onboarding, land in the dashboard.

---

## Environment variables

Every variable is documented in [`.env.example`](.env.example). The two you
**must** generate locally:

```bash
# NEXTAUTH_SECRET — signs session JWTs
openssl rand -base64 32

# ENCRYPTION_KEY — AES-256-GCM key for tokens at rest (must be 32 bytes)
openssl rand -base64 32
```

| Variable                              | Required           | Purpose                                            |
| ------------------------------------- | ------------------ | -------------------------------------------------- |
| `DATABASE_URL`                        | ✅                 | PostgreSQL connection string                       |
| `NEXTAUTH_URL`                        | ✅                 | App base URL (`http://localhost:3000` in dev)      |
| `NEXTAUTH_SECRET`                     | ✅                 | Session/JWT signing secret                         |
| `ENCRYPTION_KEY`                      | ✅                 | Encrypts sensitive tokens at rest                  |
| `GOOGLE_CLIENT_ID` / `_SECRET`        | Optional           | Enables **Continue with Google**                   |
| `LINKEDIN_*`, `RESEND_*`, `ANTHROPIC_*` | Later sprints    | Documented now; unused in Sprint 1                 |

### Enabling Google OAuth

1. Create an OAuth client at
   [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Add the redirect URI: `http://localhost:3000/api/auth/callback/google`
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

The Google button only renders when both variables are present, so the app runs
fine without it.

---

## Scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Start the dev server                                |
| `pnpm build`        | Production build (runs `prisma generate` first)     |
| `pnpm start`        | Serve the production build                           |
| `pnpm lint`         | ESLint                                              |
| `pnpm typecheck`    | `tsc --noEmit` (strict)                             |
| `pnpm test`         | Vitest unit tests                                   |
| `pnpm format`       | Prettier write                                      |
| `pnpm db:migrate`   | Apply migrations (dev)                              |
| `pnpm db:seed`      | Seed demo user + company                            |
| `pnpm db:studio`    | Open Prisma Studio                                  |

---

## Architecture

### Why this stack

- **Next.js 14 App Router (single app, API routes)** — one deployable unit and
  shared Zod schemas/types across client and server. A separate backend service
  would add ops overhead with no Sprint-1 benefit. If a heavy async workload
  appears later (e.g. trend crawling), it can be split into its own worker
  without touching this app's boundaries.
- **NextAuth v4** — stable and production-proven. New OAuth providers (LinkedIn
  in Sprint 2) are added as one entry in `lib/auth.ts`; the `Account` table
  already models arbitrary providers, so **no schema change** is needed.
- **Prisma + PostgreSQL** — typed data access; the schema is designed up front
  for all 10 sprints to avoid painful migrations.
- **bcryptjs** — pure-JS, so no native build step on Windows/CI.

### Folder structure

```
app/
  (auth)/            login, signup, forgot/reset-password  (route group)
  dashboard/         protected shell + overview, settings, feature placeholders
  onboarding/        post-signup wizard
  api/               validated route handlers (auth, companies)
  layout.tsx         root layout + providers
components/
  ui/                design-system primitives (Button, Card, Dialog, Badge, …)
  auth/              login/signup/reset forms
  onboarding/        multi-step wizard
  dashboard/         sidebar, topbar, company switcher, settings forms
  brand/             logo
lib/
  db.ts              Prisma client singleton
  auth.ts            NextAuth config (providers, callbacks, audit events)
  auth-helpers.ts    server-side session + company RBAC guards
  password.ts        bcrypt hash/verify
  crypto.ts          AES-256-GCM (tokens at rest) + reset-token hashing
  rbac.ts            role → permission matrix (can / assertCan)
  validations/       Zod schemas (single source of truth: client + server + tests)
  email.ts           transport abstraction (console in Sprint 1)
  api.ts             consistent JSON responses + error mapping
  nav.ts             single source of truth for sidebar/roadmap
server/
  services/          business logic, kept OUT of route handlers
    user, company, audit, auth-token
prisma/
  schema.prisma      full 10-sprint data model
  migrations/        committed SQL migrations
  seed.ts            demo data
types/               shared types + NextAuth session augmentation
tests/               Vitest (password, crypto, validations, company service)
middleware.ts        edge auth guard for /dashboard/* and /onboarding
```

### Request flow (defense in depth)

1. **Edge middleware** (`middleware.ts`) redirects unauthenticated users away
   from `/dashboard/*` and `/onboarding` before any code runs.
2. **API routes** validate every input with **Zod** before touching the DB, and
   enforce **company-scoped RBAC** (`requireCompanyRole`) where relevant.
3. **Services** (`server/services`) own all writes and wrap
   action + audit-log in a single Prisma transaction.

### Trust & safety: the audit trail

Every meaningful business action — signup, login, company creation, settings
updates (and, in later sprints, every AI suggestion / approval / publish) —
writes a typed `AuditLog` entry via `recordAudit()`. This is a product
principle (transparency + a future explainability feature), not an add-on.
Audit writes never break the primary action: a logging failure is recorded and
swallowed.

---

## Data model highlights

- **Multi-tenant from day one:** `Company` + `CompanyMember` join, so a user can
  belong to multiple workspaces with a per-company role (drives the topbar
  switcher and RBAC).
- **`Company.preferences (Json)`** — extensible bag for onboarding/AI-prompt
  signals alongside explicit columns, so later sprints add data without a
  migration.
- **Sprint 2–10 tables scaffolded now:** `LinkedInConnection` (encrypted token
  columns), `ContentDraft` (approval lifecycle enum), `TrendDigest`,
  `CompetitorProfile`. See inline comments in `prisma/schema.prisma`.

---

## Explicitly deferred to later sprints

- **LinkedIn OAuth + publishing (Sprint 2)** — table scaffolded; the provider
  plugs into `lib/auth.ts` at the marked spot. **Official LinkedIn API only —
  no scraping, no unofficial endpoints, no browser automation.**
- **Real email delivery (Sprint 2)** — `lib/email.ts` logs to the console in
  Sprint 1; swap in Resend/SendGrid with no call-site changes.
- **Trend Hunter, Content Studio, Outreach, Engagement, Analytics** — nav items
  render "Coming in Sprint N" placeholders driven by `lib/nav.ts`.
- **Team invitations / billing** — the RBAC pattern (`lib/rbac.ts`) and
  permissions exist; enforcement surfaces land with those features.

---

See [`DESIGN.md`](DESIGN.md) for design tokens and component conventions.
