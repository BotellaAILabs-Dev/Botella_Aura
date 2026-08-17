# Botella Aura — Master Project Status

_Last updated: 2026-08-17_

The single, authoritative record of **what is done**, **what is not done (and why)**,
the **blockers**, and the **actions** — across the whole product, the client
feedback list, and the UX review.

**Legend:** ✅ done & deployed · 🟡 partial / best-effort · ⬜ not started · 🔴 blocked (needs an external account, approval, or key) · 🧩 feature gap (real new build, not a bug)

**Product principle (client's):** _fix broken flows → make the workflow visible → add usability polish._

---

## 0. TL;DR

- **Every "broken flow" the client and the UX review flagged is fixed.**
- **Every CRITICAL / HIGH / MEDIUM / LOW review finding is resolved**, except three that are genuinely external-blocked (Chrome Web Store, real connector OAuth, live analytics) and two that are real feature work (post images, separate CTA field).
- The app is **live on Vercel + Neon**, auto-deploys from `main`, typecheck + production build clean, **130/130 tests passing**.
- What's left is: **your accounts/keys** (extension, LinkedIn API, connector OAuth, Crunchbase), a couple of **optional enhancements**, and **data-gated** features (forecasting, analytics deltas) that only become meaningful once real metrics accrue.

---

## 1. What is DONE (by module)

### 1.1 Foundation & platform
- ✅ Next.js 14 (App Router) + TypeScript strict, Prisma + PostgreSQL (Neon), NextAuth (credentials + Google).
- ✅ Multi-tenant workspaces (Company + members); active-company switching.
- ✅ **RBAC** with 4 roles: Owner / Admin / Member / **Viewer** (read-only).
- ✅ Append-only **audit trail** for every meaningful action.
- ✅ **Human approval gate** enforced in the service layer — nothing publishes or sends without an explicit human Approve. (Core trust guarantee.)
- ✅ Deployed: Vercel (frontend) + Neon (Postgres); migrations run on deploy.
- ✅ Email transport chain: SMTP → Resend → console fallback.

### 1.2 Onboarding
- ✅ 3-step flow with progress indicator and "why we need this" copy.
- ✅ **Website URL validation** (onBlur) + **industry autocomplete** (datalist).
- ✅ Brand-voice step: **tone chips** + structured guidance.
- ✅ **"Preview a sample post"** — see the brand voice before finishing.
- ✅ "You're always in control" trust screen.

### 1.3 Dashboard
- ✅ Renamed **Overview → Dashboard** (nav + page).
- ✅ **Action-first panel** ("Action needed"): live counts of drafts awaiting approval, outreach to approve, approved outreach ready to send, approved content ready to publish, new leads to review — each deep-links to the work.
- ✅ Latest-trend peek; honest **"all caught up"** empty state.
- ✅ **Create Workspace** works.

### 1.4 Team & collaboration
- ✅ **Invite by email** + role selector.
- ✅ **Pending invitations list** with **Pending / Accepted / Expired** status.
- ✅ **Resend** + send confirmation.
- ✅ Last-owner guard; role change / remove.
- ✅ **Per-role tooltips** (Owner/Admin/Member/Viewer).

### 1.5 Connectors
- ✅ Dedicated **Connectors module** with 24 integrations listed.
- ✅ Clear **Available vs Coming-soon** status (LinkedIn available; rest roadmap).

### 1.6 AI Trend Insights
- ✅ Renamed **Trend Intelligence → AI Trend Insights**.
- ✅ **Geo & scope filters**: country, region, city, language, time range.
- ✅ Keyless multi-source engine (Hacker News, Google/Bing News, curated RSS, Reddit) with per-source transparency ("No key needed" / "needs token").
- ✅ Per-item **"why this matters" + suggested angle**.
- ✅ **AI digest summary + prioritized weekly recommendations** (top-level synthesis).
- ✅ **Trending hashtags** distilled from the day's items.
- ✅ **Seasonal / event-based moments** (curated first-party calendar, biased by your keywords/industry).
- ✅ **Competitor trend comparison** (lightweight): trend items that mention a tracked competitor are surfaced.
- ✅ **Refresh-frequency + zero-result** explainers.
- ✅ Removed internal "Sprint" terminology from all user-facing copy.

### 1.7 Content Studio
- ✅ Types: LinkedIn post / Carousel / X thread / Blog.
- ✅ **Campaign selector fixed** (no dead "— none —"; empty-state + disabled when none).
- ✅ Brief-driven generation; grounded in brand voice + knowledge base + live URL fetch.
- ✅ Kanban (Draft / Pending / Approved / Published) + full draft detail with complete action set.
- ✅ **Hashtags shown as a separate, labeled block** (distinct from post copy).
- ✅ Honest **publishing-limitation notice** ("Copy for manual posting" until API access).
- ✅ Faster generation (effort tuned by type).

### 1.8 Leads & Discovery
- ✅ Discovery profiles (industries, roles, stage, geography, keywords) with **Run now** + run history.
- ✅ **"What to expect"** before Run now (typical time + count).
- ✅ **Auto-run weekly** with **next scheduled date** shown.
- ✅ **Lead fit score X/100** with **"why this score"** rationale (table hover + outreach board).
- ✅ **Separate Company / Contact columns**; company-only leads clearly marked.
- ✅ **"Signals · Msgs"** clarified with tooltips (0 is normal, not broken).
- ✅ Manual add-lead with trust copy.

### 1.9 Outreach Intelligence
- ✅ AI-drafted connection notes + follow-ups, personalized to the lead's signals.
- ✅ **Visible status stepper**: Draft → Pending → Approved → **Queued** → Sent (approve = queued in the extension).
- ✅ **Sequence labeling**: connection note first, then numbered follow-ups, with an explainer that follow-ups only send after the connection is accepted.
- ✅ Approve / request-changes / reject; edit re-drafts.
- ✅ **"Did it work?"** manual outcome toggles (feed Marketing Memory).
- ✅ **LinkedIn URL validation** distinguishing **person (/in/) vs company (/company/)** pages.
- ✅ Outreach history + connection status.

### 1.10 Engagement Copilot
- ✅ Monitored profiles/pages with **LinkedIn URL validation** + **examples of good targets**.
- ✅ Extension-only comment drafting (nothing fetched server-side); web app is the read-only history.

### 1.11 Competitor Intelligence
- ✅ Tracked competitors (website/pricing change detection, public news, GitHub).
- ✅ Honest "skipped" states (e.g. LinkedIn pending API access).
- ✅ Weekly competitor report.

### 1.12 Marketing Memory (learning loop)
- ✅ Data-gated insights (won't fabricate on thin data; honest "not enough data yet").
- ✅ **Correct an individual insight** (edit wording, stamped "edited by you").
- ✅ **Dismiss an insight** (soft-delete; stops feeding future drafts).
- ✅ Best/worst content + engagement-over-time chart.

### 1.13 Campaign Orchestrator
- ✅ Goal → audience → 30-day plan → tasks that trigger the existing pipelines (never publishes directly).
- ✅ **Demo data** populates one full connected campaign end-to-end so the value is verifiable.

### 1.14 Analytics
- ✅ Funnel, engagement-over-time, by-content-type, weekly report structure.
- ✅ Real numbers appear once metrics exist (demo seed provides sample numbers).

### 1.15 Chrome Extension
- ✅ Companion extension: pairing token, action queue, revoke.
- ✅ Excellent security copy (token scoped to action queue, revocable).
- ✅ Clearly labeled **Internal / Beta** (see blockers).

### 1.16 Demo data
- ✅ **Connected, clearly-labeled sample story**: Trend → Campaign → Content (every status) → Leads (+ signals) → Outreach (every status) → Performance → Marketing Memory → Competitor.
- ✅ Scoped to the demo workspace only; real/new workspaces stay genuinely empty.
- ✅ Idempotent — run via `pnpm db:seed:demo`.

---

## 2. What is NOT done (and why)

### 2.1 🔴 Blocked — needs YOUR account / approval / key
| Item | Blocker | What we need from you |
|------|---------|-----------------------|
| **Chrome extension on the Web Store** | Google requires a developer account (+$5) and review; we can't submit for you. | Create/confirm the Chrome Web Store developer account (or hand us access). Until then it stays Internal/Beta. |
| **Real connector OAuth** (GA4, Meta, HubSpot, etc.) | Each integration needs its own app registration + secrets (some need review). | Pick 1–2 to build first (GA4 + Meta Ad Library are free/easy); approve the app registrations. |
| **LinkedIn publishing + company-page reads** | LinkedIn Marketing / Community Management API approval (weeks). | Start the LinkedIn app review now (long lead time). |
| **Live analytics / real post metrics** | Needs GA4 / LinkedIn / Meta APIs, or the extension, or manual entry. | Connect GA4 (easy) and/or fix the extension path; LinkedIn/Meta need approvals. |
| **Crunchbase enrichment** | Paid Crunchbase API key. | Buy a key (guidance is in-product), or keep the keyless path. |
| **Emails actually sending in prod** | `RESEND_API_KEY`+`EMAIL_FROM` or `SMTP_*` not set in Vercel. | Set the email env vars in Vercel (5 min). Code is done. |

### 2.2 🧩 Feature gaps — real new build (not review "bugs")
| Item | Why it's not done | Effort |
|------|-------------------|--------|
| **Post images / visuals** | Content is text-only; generating on-brand images needs an image pipeline (model + storage) or a Canva/Figma connector. | M–L |
| **Separate CTA field** | Hashtags are now separated; a distinct CTA needs a schema + generation change. | M |

### 2.3 🟡 Data-gated — built or partial, but only meaningful with more data
| Item | Why |
|------|-----|
| **Trend forecasting** | Needs weeks of accumulated trend history we've just started collecting. The collector runs now; forecasts become meaningful over time. |
| **Analytics comparison / trend indicators (vs prior period)** | Renders nothing until real post metrics accumulate. Structure is ready. |

### 2.4 ⬜ Optional enhancements (nice-to-have, no blocker)
| Item | Notes |
|------|-------|
| **Save & monitor trends** | Can be built with **no DB migration** (store in company preferences). Ready to do on request. |
| **Onboarding Step-1 live micro-preview** | A sample trend/headline updating as you type (Step-2 sample-post preview already exists). |
| **More contextual examples** across empty states | The Content Studio empty-state copy is the model to replicate on Campaigns/Leads/Memory. |

---

## 3. Client feedback list — item-by-item

### Numbered asks (1–6)
| # | Item | Status |
|---|------|--------|
| 1 | Campaign selector fix | ✅ |
| 2 | Team invitation status + resend + confirmation | ✅ |
| 3 | Chrome extension (store publish / Internal-Beta label) | 🟡 labeled Internal/Beta · 🔴 store publish |
| 4 | Lead fit score X/100 + "why" | ✅ |
| 5 | Lead table Company vs Contact | ✅ |
| 6 | Demo data (connected, labeled, empty states kept) | ✅ |

### P1 — High priority
| Item | Status |
|------|--------|
| Dashboard actionable items first | ✅ |
| Outreach status progression (Draft→Pending→Approved→Queued→Sent) | ✅ |
| Outreach sequence labels (connection vs follow-up + order) | ✅ |
| Campaign Orchestrator — populate + test one full campaign | ✅ (demo data) · QA pass recommended |
| Content output — separate CTA/hashtags + publishing limits | 🟡 hashtags ✅ · CTA field 🧩 |
| Connectors — Available vs Coming Soon | ✅ |
| Marketing Memory — correct individual insights | ✅ |

### P2 — Medium priority
| Item | Status |
|------|--------|
| Website URL validation + industry guidance | ✅ |
| Brand Voice preview before onboarding completes | ✅ |
| Show what Aura learned after Brand Voice analysis | ✅ |
| Trend refresh frequency + zero-result behavior | ✅ |
| Crunchbase key guidance | ✅ |
| Lead Discovery expected results/time before Run now | ✅ |
| Next scheduled date for Auto-run weekly | ✅ |
| Clarify "Signals: 0 · 0 msg" | ✅ |
| LinkedIn URL validation + person vs company | ✅ |
| Engagement Target examples | ✅ |
| Analytics comparison / trend indicators | 🟡 data-gated |

### P3 — Nice to have
| Item | Status |
|------|--------|
| Onboarding live preview of a sample trend/post | 🟡 sample-post preview exists |
| Role tooltips (Owner/Admin/Member/Viewer) | ✅ |
| More contextual examples for Engagement Targets | ✅ |

### Trend "Additional Enhancements"
| Item | Status |
|------|--------|
| Industry-specific trending topics | ✅ (industry/keyword biased) |
| Competitor trend comparison | ✅ (lightweight mentions) |
| Trending hashtags | ✅ |
| Seasonal / event-based trends | ✅ |
| AI trend summary + recommendations | ✅ |
| Trend forecasting | 🟡 data-gated |
| Save & monitor trends | ⬜ optional (no-migration path ready) |

---

## 4. UX review — findings by severity

- **CRITICAL** (7): campaign "— none —" ✅ · invite status ✅ · fit score scale/why ✅ · lead company/contact ✅ · Marketing Memory correction (HIGH, built) ✅ · **extension dev-mode 🔴** · Campaign Orchestrator verifiability ✅ (demo).
- **HIGH** (5): dashboard actionable items ✅ · outreach status chip ✅ · Marketing Memory edit ✅ · **content images/CTA 🧩** · **connectors availability 🔴**.
- **MEDIUM** (all): sprint-copy removal ✅ · brand-voice learned summary ✅ · Crunchbase guidance ✅ · discovery expectations ✅ · outreach sequence ✅ · "Signals" clarity ✅ · analytics-zero 🟡 (data-gated).
- **LOW** (all): website/industry validation ✅ · role tooltips ✅ · refresh/zero-result copy ✅ · next auto-run date ✅ · LinkedIn URL validation ✅ · engagement examples ✅ · analytics benchmarks 🟡 (data-gated).
- **ENHANCEMENTS**: step-1 live preview ⬜ · brand-voice structure ✅ · empty-state consistency ✅.

**Net:** all CRITICAL/HIGH/MEDIUM/LOW resolved except the 2 external-blocked (🔴) and 1 feature-gap (🧩); a few data-gated (🟡) and optional (⬜) remain.

---

## 5. What YOU need to do (unblocks the most)

1. **Email in prod** — set `RESEND_API_KEY` + `EMAIL_FROM` (or `SMTP_*`) in Vercel. _5 min._
2. **LinkedIn API approval** — start the Marketing/Community API review now (long lead time).
3. **Chrome Web Store** — create/confirm a Google developer account (or hand us access).
4. **First connectors** — tell us which 1–2 matter for the demo (recommend GA4 + Meta Ad Library — free).
5. **Crunchbase** — buy a key, or keep the keyless path.

---

## 6. How to run / operate

- **Local dev:** `pnpm install` → set `.env` (`DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `ANTHROPIC_API_KEY`) → `pnpm db:migrate` → `pnpm dev`.
- **Base seed (demo login):** `pnpm db:seed` → `demo@botella.ai` / `Password123`.
- **Full demo data:** `pnpm db:seed:demo` (populates the connected sample story on the demo workspace only).
- **Quality gates:** `pnpm typecheck` · `pnpm build` · `pnpm test` (130 tests).
- **Deploy:** push to `main` → Vercel builds + runs migrations automatically.

---

## 7. Recommended next steps (our side, no blockers)

1. **Save & monitor trends** (no migration).
2. **Post images** (image generation or Canva/Figma connector) + **separate CTA field**.
3. **Final QA pass** (client's 10-step order) against the deployed build.
4. Replicate the Content Studio empty-state copy pattern on Campaigns/Leads/Memory.

---

_See also: [CLIENT-REVIEW-STATUS.md](CLIENT-REVIEW-STATUS.md) (client feedback tracking) and the sprint technical docs._
