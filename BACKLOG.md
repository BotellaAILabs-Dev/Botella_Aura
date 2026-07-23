# Botella Aura — Backlog & Open Items (Sprints 1–2)

> Living doc of everything **not done**, **stubbed**, or **required** so far, plus
> what each future sprint will need. Grounded in the actual code. Update as items
> land. Legend: 🔴 blocker · 🟠 important · 🟡 nice-to-have · ✅ done · 🔑 needs a credential.

---

## 1. API keys & credentials required

These unlock features that are **built but inert** without the key. Nothing here
is a code change — it's procurement + `.env`. See [`.env.example`](.env.example)
for exact variable names.

| # | Provider | Env vars | Where to get it | Priority | What's broken without it |
|---|----------|----------|-----------------|----------|--------------------------|
| 1 | 🔑 **Anthropic (Claude)** | `ANTHROPIC_API_KEY` (opt. `ANTHROPIC_MODEL`) | [console.anthropic.com](https://console.anthropic.com) → API Keys | 🔴 | Trend digests fall back to basic non-AI summaries; onboarding smart-defaults use heuristics. Content Studio (S3) & Outreach (S4) can't work at all. |
| 2 | 🔑 **Reddit** | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → "script" app | 🟠 | Reddit trend source is skipped (shown as "not connected", never faked). HN + Google News still work keyless. |
| 3 | 🔑 **LinkedIn** | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) → add "Sign In with LinkedIn using OpenID Connect"; redirect `…/api/linkedin/callback` | 🟠 | "Connect LinkedIn" shows "not configured". |
| 4 | 🔑 **Cron secret** | `CRON_SECRET` | Self-generate: `openssl rand -base64 32` | 🟠 | Scheduled digest endpoint `POST /api/cron/trends` returns 401. Manual "Refresh" still works. |
| 5 | 🔑 **Google OAuth** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials); redirect `…/api/auth/callback/google` | 🟡 | "Continue with Google" button is hidden. Email/password still works. |
| 6 | 🔑 **X / Twitter** | `TWITTER_BEARER_TOKEN` | [developer.x.com](https://developer.x.com) | 🟡 | X trend source stays off (feature-flagged). Optional. |
| 7 | 🔑 **Email (Resend)** | `RESEND_API_KEY`, `EMAIL_FROM` | [resend.com](https://resend.com) | 🟠 | Password-reset & future invite emails only `console.log` (see `lib/email.ts`). Nothing actually sends. |
| 8 | 🔑 **Production Postgres** | `DATABASE_URL` (pooled) | Neon / Supabase / RDS | 🔴 (prod) | Currently local Docker Postgres only. |

**Keyless & working today:** Hacker News (Firebase API) + Google News (RSS). Proven live.

---

## 2. Sprint 1 — deferred / stubbed

| Item | Status | Notes / where |
|------|--------|---------------|
| Email delivery (password reset, verification) | 🟠 stub | `lib/email.ts` console transport. Swap to Resend, no call-site change. Needs #7. |
| Email verification flow | 🟡 not built | `User.emailVerified` column exists; no send/verify UX. |
| Team invitations | 🟠 not built | Members list is **view-only** (`/dashboard/settings`). RBAC (`lib/rbac.ts`) + `members:invite` permission exist; need invite email + accept flow. |
| Billing / plans | 🟡 not built | `OWNER` role + `company:manageBilling` permission reserved; no Stripe/paywall. |
| Rate limiting on public endpoints | 🟠 not built | `/api/auth/signup` & `/api/auth/forgot-password` have no throttle → abuse/enumeration risk at scale. |
| Google OAuth | 🟡 inert | Needs #5. Provider wired; button conditional on env. |

---

## 3. Sprint 2 — deferred / stubbed

### LinkedIn
| Item | Status | Notes |
|------|--------|-------|
| Basic profile connect (OIDC) | ✅ done | Encrypted tokens, CSRF, disconnect+revoke, audited. Needs #3 to exercise. |
| **Automated token refresh** | 🟠 partial | `needsReconnect` state + UI exist, but LinkedIn "Sign In" OIDC tokens generally aren't refreshable without the refresh-token program. No background refresh implemented — user re-connects. Revisit when we hold refresh tokens. |
| **Company-page reads** | 🔴 stubbed | Needs LinkedIn **Community Management API / Marketing Developer Platform** approval. Not available on self-serve OIDC. Flagged in `server/services/linkedin.service.ts`. |
| **Publishing to LinkedIn** | 🔴 stubbed | Same approval gate + `w_member_social` scope. Human-approval gate must precede (core principle). Lands with Content Studio publish (S3+). |

### Trend Intelligence
| Item | Status | Notes |
|------|--------|-------|
| HN + Google News sources | ✅ done | Keyless, live-verified. |
| Reddit source | ✅ done | Needs #2. |
| X/Twitter source | 🟡 off | Feature-flagged; needs #6. |
| AI summaries + suggested angles | ✅ done | Real with #1; deterministic fallback without. |
| Semantic dedup / clustering | 🟡 not built | Current dedup is exact id + normalized-title only. Needs embeddings/vector search (see §5, Python candidate). |
| Source-fetch caching | 🟡 not built | Every digest re-fetches. Fine now; add cache to cut latency/quota at scale. |
| More sources (YouTube, Mastodon, GitHub trending) | 🟡 backlog | Drop-in via `TrendSource` interface in `server/trends/sources/`. |
| Cron scheduling wired to a real scheduler | 🟠 not wired | Endpoint exists; needs Vercel Cron entry or external crontab (see README). |

---

## 3b. Sprint 3 (Content Studio) — deferred / stubbed

| Item | Status | Notes |
|------|--------|-------|
| Knowledge ingestion (website+robots, blog RSS, upload) | ✅ done | Live-verified (robots + throttle). PDF = text-layer only (`unpdf`); **scanned/OCR PDFs not handled** 🟡. |
| Retrieval | ✅ keyword+recency | **Semantic/vector search not built** 🟠 — the flagged home for a small **Python ML service** (embeddings + pgvector). `retrieve()` interface stays the same. |
| Brand Voice Profile | ✅ done | Needs `ANTHROPIC_API_KEY` for real analysis; heuristic fallback otherwise. |
| Content generator (4 types) | ✅ done | Requires `ANTHROPIC_API_KEY` (503 without). Runs **in-request** (single Claude call — fine now; batch/campaign gen should move to the worker, §I1). |
| Approval queue + state machine | ✅ done | Publish-gate enforced in service + tested. |
| Draft manual editing | 🟡 basic | Inline edit is a **validated JSON textarea** + per-type preview. **Rich per-type field editors** are a polish item. Refine (AI feedback) is the primary edit path. |
| **LinkedIn Company Page auto-publish** | 🔴 gated | Wired to official `/rest/posts`, but needs **Community Management API approval + `w_organization_social` scope + `LINKEDIN_ORG_URN`**. Until then → "copy for manual posting" (honest, never faked). |
| Carousel / thread / blog native publish | 🟠 manual | LinkedIn API doesn't natively publish these → copy-for-manual by design. |
| Ingestion at scale | 🟠 | Website sync runs in-request (throttled, ~1.2s/page). Move to the worker/queue (§I1) before large tenants. |
| Campaign Builder UI | 🟡 stub | `Campaign` model + tagging exist; full builder UI is a later sprint. |

## 4. Cross-cutting / infrastructure — NOT built (the scaling gaps)

| # | Item | Priority | Why it matters |
|---|------|----------|----------------|
| I1 | **Background worker + durable queue** | 🔴 (S3) | Digest job runs **inline & sequentially** in the cron request (`app/api/cron/trends/route.ts`). Won't scale past a few dozen companies, and agentic Content Studio/Outreach work will exceed serverless time limits. Extract to a Node worker + queue (Inngest/Trigger.dev, or pg-boss/BullMQ). **Same TS codebase**, reuses `server/*`. |
| I2 | **Claude token/cost budgets + global rate coordination** | 🟠 | No cap on tokens/cost per company/day; no cross-tenant rate coordination beyond per-call retry (`lib/http.ts`). Add budgets + a shared limiter before heavy fan-out. |
| I3 | **Observability** | 🟠 | `lib/logger.ts` is console-JSON only. Need a sink (Datadog/Axiom) + error monitoring (Sentry) + request tracing. |
| I4 | **CI pipeline** | 🟠 | No GitHub Actions. Add: install → typecheck → lint → test → build on PR. |
| I5 | **E2E / integration tests** | 🟡 | Only unit tests (41). Add Playwright for auth→onboarding→dashboard and a digest smoke test. |
| I6 | **Secrets management (prod)** | 🟠 | `.env` only. Use host secret store (Vercel/Doppler/1Password) in prod. Rotate `ENCRYPTION_KEY` policy documented. |
| I7 | **DB connection pooling** | 🟠 (prod) | Prisma singleton exists; use a pooled `DATABASE_URL` (PgBouncer/Neon pooler) for serverless. |
| I8 | **Deployment config** | 🟠 | No `vercel.json`/Dockerfile committed for the app (only `docker-compose.yml` for local DB). Define host + cron + env. |
| I9 | **Webhook/queue for LinkedIn token expiry & digest failures** | 🟡 | Surface failures (currently only logged + audited). |

---

## 5. When to introduce Python (and where)

Decision from the architecture review: **stay TypeScript for agent orchestration.**
Introduce a **targeted Python microservice only** for our *own* ML — not for calling Claude:

- Embeddings + **vector search** (semantic trend clustering/dedup — §3).
- Fine-tuned classifiers / RAG over large corpora.
- Heavy analytics (≈ Sprint 7).

Keep the seam clean now (a job/queue interface, §I1) so this can be **added behind an internal API** without refactoring. Until then, no Python.

---

## 6. Upcoming sprints — what each will need

| Sprint | Feature | New keys/infra needed | Depends on |
|--------|---------|-----------------------|------------|
| **3** | Content Studio (generate posts/carousels) | #1 Anthropic (required) | I1 worker/queue; `ContentDraft` table (already scaffolded); the `/dashboard/content/new?trendId=` hand-off (already wired on trend cards) |
| **4** | Outreach drafting | #1; possibly enrichment data source | I1; human-approval gate |
| **5** | Competitors | (uses existing `CompetitorProfile` + trend competitor watch) | — |
| **6** | Engagement Copilot | #1; LinkedIn publish approval (§3) | Browser extension (separate build) |
| **7** | Analytics | Possibly Python ML service (§5); analytics store | — |
| **2→3** | LinkedIn **publish** path | LinkedIn Marketing/Community API **approval** (§3) | Human-in-the-loop approval UI |

---

## 7. Known minor tech-debt / polish

- [ ] 🟡 Overview page (`/dashboard`) still shows Sprint-2 cards as disabled buttons — could link "Connect LinkedIn" → `/dashboard/settings/connections` and "trend digest" → `/dashboard/trends` now that they exist.
- [ ] 🟡 `next-env.d.ts` is gitignored (standard) — confirm CI regenerates it via `next build`.
- [ ] 🟡 Trend config smart-defaults seed on settings-page load + digest gen; consider a dedicated onboarding-completion hook so a company's first digest is meaningful before they visit settings.
- [ ] 🟡 Line endings: repo has mixed LF/CRLF warnings on Windows — add a `.gitattributes` (`* text=auto eol=lf`) to normalize.
- [ ] 🟡 Prisma 5.22 → 7.x available; plan an upgrade pass.
- [ ] 🟡 `docs/sprint1-jira-import.csv` shows as deleted in the working tree (pre-existing) — decide keep vs remove.

---

## 8. Production-readiness checklist (before real customers)

- [ ] 🔴 Managed Postgres + pooled connection (#8, I7)
- [ ] 🔴 Background worker/queue live (I1)
- [ ] 🔴 Real secrets store; `ENCRYPTION_KEY` + `NEXTAUTH_SECRET` set & rotated (I6)
- [ ] 🟠 Email provider live (#7) so password reset actually sends
- [ ] 🟠 Rate limiting on auth endpoints (§2)
- [ ] 🟠 Error monitoring + logging sink (I3)
- [ ] 🟠 CI green on every PR (I4)
- [ ] 🟠 Cron scheduler wired (I8) + `CRON_SECRET` set
- [ ] 🟡 E2E smoke tests (I5)
- [ ] 🟡 Load/scale test the digest fan-out

---

_Last updated: end of Sprint 2. Keep this in sync as items land._
