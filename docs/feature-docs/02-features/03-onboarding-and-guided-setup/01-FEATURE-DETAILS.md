# Onboarding & Guided Setup

> Turns a brand-new account into a working Aura workspace. A four-step wizard collects what the business does, who it sells to and how it should sound (with an optional AI sample post in that voice), then creates the workspace and starts its first analysis. After that, an ordered eight-step setup checklist, derived from real data, walks the user through the optional steps that make Aura's output better. It exists because Aura cannot write anything useful until it knows the business, and a new user otherwise has no idea what to do first.

## 1. Overview

Two parts:

1. **Onboarding wizard** (`/onboarding`) — outside the dashboard shell. Steps: **Business**, **Audience**, **Voice**, **What happens next**. Submitting calls `POST /api/companies`, which creates the `Company`, the OWNER membership and the first `INTELLIGENCE` job.
2. **Guided setup checklist** (`/dashboard/setup`, and on the dashboard home) — eight ordered steps from `lib/onboarding.ts`, whose completion is computed by `server/onboarding/checklist.service.ts` from database rows. Nothing is a tickable flag.

## 2. User-facing behaviour

| Route | File | What the user sees / can do | Who |
| --- | --- | --- | --- |
| `/onboarding` | `app/onboarding/page.tsx` | The wizard. Users with no workspace always see it. Users who already have one are redirected to `/dashboard` unless the URL has `?new=1` (from "Create workspace" in the company switcher). | Signed-in user (middleware-protected) |
| `/dashboard` | `app/dashboard/page.tsx` | `SetupChecklist` at the top while setup is not finished: full list before the first briefing exists, `compact` variant after. Hidden once finished. | Any member |
| `/dashboard/setup` | `app/dashboard/setup/page.tsx` | "Set up Aura" page with the full checklist; a "Setup is complete" card with "Go to your week" when every step is done. `force-dynamic`. | Any member |
| `/dashboard/settings` | `app/dashboard/settings/page.tsx` | "Setup progress" button linking to `/dashboard/setup` | Any member |
| `/dashboard` (no workspace) | `app/dashboard/layout.tsx` | Redirects to `/onboarding` | Signed-in user without a membership |

### Wizard steps (`components/onboarding/onboarding-wizard.tsx`)

| # | Label | Heading | Fields | Validation (from `lib/validations/company.ts`) |
| --- | --- | --- | --- | --- |
| 0 | Business | "What does your business do?" | Company name, website, industry (suggestion list per market mode), description, offerings | name 2-80; website optional, bare domain accepted and normalised to `https://`; industry up to 80; description **20-600** (required); offerings up to 400 |
| 1 | Audience | "Who are you selling to?" | Market mode (B2B / B2C cards), audience, goals | `marketMode` in `B2C`/`B2B`; audience **10-600** (required); goals up to 600 |
| 2 | Voice | "How should Aura sound?" | Tone chips (8 per market mode), free-text brand voice notes, "preview" sample post | brand voice notes up to 2000 |
| 3 | What happens next | "Your workspace is ready. Here is what happens next." | `ConfirmationSummary`: the remaining checklist steps (excluding business, audience and review), what Aura does every Monday, and the approval promise | — |

Placeholders are worked examples per market mode (e.g. a payroll company for B2B, a coffee roaster for B2C). Tone chips and notes are composed into one saved string: `Tone: A, B.` followed by the notes.

The last step's button is **"Enter Botella Aura"**, which submits.

### Setup checklist steps (`lib/onboarding.ts`)

| Order | Id | Title | Link | Required | Done when |
| --- | --- | --- | --- | --- | --- |
| 1 | `business` | Add your business information | `/dashboard/business` | yes | business profile has a `description` (`hasBusinessProfile`) |
| 2 | `market` | Tell Aura where you operate | `/dashboard/settings/trends` | no | `CompanyTrendConfig.geoCountry` is set |
| 3 | `materials` | Upload your marketing materials | `/dashboard/settings/knowledge-base` | no | at least one `KnowledgeSource` |
| 4 | `brand` | Add your brand assets | `/dashboard/settings/brand` | no | logo or any of primary / secondary / accent colour (`hasBrandAssets`) |
| 5 | `audience` | Define your audience and goals | `/dashboard/settings/audience` | no | audience or goals set (`hasMarketingProfile`) |
| 6 | `channels` | Connect your marketing channels | `/dashboard/settings/connections` | no | at least one `Connection` with status `CONNECTED` (excluding mirrored rows) plus `LinkedInConnection` rows |
| 7 | `plan` | Generate your first marketing plan | `/dashboard/planner` | no | at least one `MarketingPlan` |
| 8 | `review` | Review your first week of work | `/dashboard` | no | at least one `WorkspaceBriefing` |

Each step also has a `why` (the outcome it buys), a `cta` and an icon. Done steps show a detail such as "3 sources", "Logo and colours", "Hyderabad, IN" or "Aura has reported in".

## 3. How it works

### Wizard submit
1. Step navigation validates locally: `validateBusiness()` on step 0 and `validateAudience()` on step 1 before Continue.
2. `finish()` posts to `/api/companies` with all fields plus `confirmDuplicate`.
3. On **409** (a workspace with the same name already exists for this user) the wizard shows a browser `confirm()`; on yes it sets `duplicateConfirmed` and asks the user to press Create again.
4. On 201 it writes the `aura.activeCompany` cookie for the new company (1 year), fires `POST /api/jobs/<intelligenceJobId>/run` with `keepalive: true` without awaiting it, toasts "Workspace created!" (or "New workspace created!" with `?new=1`) and routes to `/dashboard`.
5. Server side, `createCompanyForUser` passes the wizard payload through `onboardingPatch` and `planBusinessContextWrite(..., 'onboarding', ONBOARDING_ALIASES)` so onboarding obeys the same Business Context rules as the settings pages, then creates the company with `onboardedAt = now`, an OWNER membership, and `COMPANY_CREATED` + `ONBOARDING_COMPLETED` audits, all in one transaction (see feature 02).

### Brand voice preview (`POST /api/onboarding/preview`)
- Requires a signed-in user; nothing is saved.
- Body (`previewSchema`): `name` (1-80, required), optional `industry`, `description`, `offerings`, `marketMode`, `audience`, `brandVoiceNotes`.
- If Claude is not configured: 200 with `sample: null`, note "Add your AI key to preview a real sample in your voice.", `retryable: false`.
- Otherwise builds a system prompt from the profile facts, the market-mode content rules (`contentRulesFor`), and instructions to use only the given facts and invent nothing. B2C asks for one short Instagram/Facebook post; B2B for one short LinkedIn post.
- Calls `complete()` with `maxTokens: 1200`, `effort: 'low'`, `timeoutMs: 45_000`, up to **2 attempts**. Route `maxDuration` is 60 s.
- On failure it logs an error and still returns 200 with `sample: null`, a specific note and `retryable: true`, so onboarding is never blocked by the preview.

### Checklist state (`getOnboardingState(companyId)`)
1. Reads the company (`industry`, `website`, `brandVoiceNotes`, `preferences`) and, in parallel, six counts / lookups: knowledge sources, connected connections, LinkedIn connections, marketing plans, workspace briefings, trend config geo fields.
2. Parses brand assets, marketing profile and business profile from `Company.preferences` (`server/company/profile.service.ts`).
3. Computes `done` and `detail` together per step so they cannot disagree.
4. Marks exactly one step `current`: the first incomplete one in order.
5. Returns `{ steps, completed, total, finished, nextStep }`.

`SetupChecklist` (`components/dashboard/onboarding/setup-checklist.tsx`) shows a button only on the current step; in `compact` mode it hides steps that are neither done nor current.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/onboarding/page.tsx` | Gate (`?new=1`), renders the wizard outside the shell |
| Page | `app/dashboard/setup/page.tsx` | Full setup checklist page |
| Page | `app/dashboard/page.tsx` | Shows the checklist on the home page until finished |
| Page | `app/dashboard/layout.tsx` | Redirects users with no workspace to `/onboarding` |
| Component | `components/onboarding/onboarding-wizard.tsx` | Four-step wizard, tone chips, preview, duplicate handling, submit |
| Component | `components/dashboard/onboarding/setup-checklist.tsx` | Checklist UI (`full` / `compact`) |
| API | `app/api/onboarding/preview/route.ts` | Throwaway sample post in the brand voice |
| API | `app/api/companies/route.ts` | Workspace creation (owned by feature 02) |
| Lib | `lib/onboarding.ts` | `ONBOARDING_STEP_IDS`, `ONBOARDING_STEPS`, `onboardingStep()` |
| Lib | `lib/validations/company.ts` | `companyStep1Schema`, `companyAudienceSchema`, `companyStep2Schema`, `createCompanySchema` |
| Lib | `lib/validations/profile.ts` | `MARKET_MODES`, `hasBusinessProfile`, `hasBrandAssets`, `hasMarketingProfile` |
| Service | `server/onboarding/checklist.service.ts` | `getOnboardingState` |
| Service | `server/services/company.service.ts` | `createCompanyForUser` |
| Service | `server/company/profile.service.ts` | Readers for the profile JSON in `Company.preferences` |
| Service | `server/content/audience.ts` | `contentRulesFor(marketMode)` used by the preview |
| Service | `server/ai/claude.ts` | `complete`, `isClaudeConfigured`, `ClaudeNotConfiguredError` |
| Tests | `tests/onboarding.test.ts`, `tests/validations.test.ts`, `tests/company-service.test.ts` | See section 10 |
| Script | `scripts/verify-onboarding.ts` | `pnpm verify:onboarding` against a real database |

## 5. Data model

The feature owns no models; it creates and reads these:

| Model | Fields used | How |
| --- | --- | --- |
| `Company` | `name`, `slug`, `website`, `industry`, `brandVoiceNotes`, `preferences` (business profile, marketing profile incl. market mode / audience / goals, brand assets), `onboardedAt` | Created by the wizard; read by the checklist |
| `CompanyMember` | `role = OWNER` | Created with the company |
| `CompanyTrendConfig` | `geoCountry`, `geoCity`, `geoRegion` | `market` step |
| `KnowledgeSource` | count | `materials` step |
| `Connection` | count where `status = CONNECTED` | `channels` step |
| `LinkedInConnection` | count | `channels` step |
| `MarketingPlan` | count | `plan` step |
| `WorkspaceBriefing` | count | `review` step |
| `GenerationJob` | kind `INTELLIGENCE` | Queued on workspace creation |
| `AuditLog` | `COMPANY_CREATED`, `ONBOARDING_COMPLETED` | Written on creation |

## 6. API endpoints

Full catalogue: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| POST | `/api/onboarding/preview` | Generate a short sample post from the wizard data (not saved) | Signed in |
| POST | `/api/companies` | Create the workspace from the wizard (feature 02) | Signed in |
| POST | `/api/jobs/:id/run` | Kick the first intelligence job (generation-jobs feature) | Signed in member |

## 7. External services

| Service | Used for | Env vars |
| --- | --- | --- |
| Anthropic Claude, or Gemini as fallback (via `server/ai/claude.ts`) | Brand voice preview | `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` (`isClaudeConfigured()` is true if either is set) |

See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

- Workspace creation enqueues an `INTELLIGENCE` job (`enqueueJob`) so the dashboard has a first marketing-health result when the user arrives. The wizard kicks it immediately; if that request never lands, the generation queue's safety-net route `POST /api/cron/jobs` requeues stalled work.
- The `review` step completes when the weekly briefing (`/api/cron/briefing`, Mondays 05:00 UTC in `vercel.json`) has produced a `WorkspaceBriefing`.

## 9. Security & permissions

- `/onboarding` is protected by `middleware.ts` and `requireUser()`.
- The preview route requires a session but no workspace (the workspace does not exist yet); it stores nothing.
- Workspace creation always makes the creator `OWNER` of the new workspace only.
- The checklist is read for the active company resolved from the user's memberships; no ids come from the client.
- All wizard input is Zod-validated server-side by `createCompanySchema` and then filtered through the Business Context write rules.

## 10. Testing

| File | Covers |
| --- | --- |
| `tests/onboarding.test.ts` | Step sequence and order, every step links somewhere real, `why` phrased as an outcome, only business is required, no duplicate destinations, brand colour parsing and `hasBrandAssets`, `hasMarketingProfile`, `audienceToPrompt`, B2B vs B2C content rules, market step placed early |
| `tests/validations.test.ts` | Company schemas (description and audience minimums, website normalisation) |
| `tests/company-service.test.ts` | Workspace creation, slug, OWNER membership, audits |
| `scripts/verify-onboarding.ts` | `pnpm verify:onboarding`: saving on a settings page flips the right step, exactly one "do this next", and the data reaches content and image prompts. Writes to the first company and restores its `preferences` afterwards. |

`pnpm verify:flow` onboards a business through the real onboarding service as part of its end-to-end flow check.

## 11. Configuration & limits

| Setting | Value | Source |
| --- | --- | --- |
| Wizard steps | 4 | `STEPS` in `onboarding-wizard.tsx` |
| Checklist steps | 8 (1 required) | `lib/onboarding.ts` |
| Description length | 20-600 | `companyStep1Schema` |
| Audience length | 10-600 | `companyAudienceSchema` |
| Brand voice notes | up to 2000 | `companyStep2Schema` |
| Preview tokens / attempts / timeout | 1200 / 2 / 45 s (route max 60 s) | `app/api/onboarding/preview/route.ts` |
| Default market mode | `B2B` | wizard initial state |

## 12. Known limitations & future work

- Wizard progress lives in React state only; refreshing the page mid-wizard loses the answers.
- The duplicate-name confirmation uses a browser `confirm()` dialog and requires pressing Create a second time.
- The `market`, `materials`, `brand`, `channels` and `plan` steps are completed on other pages; the wizard does not collect them.
- `POST /api/cron/jobs` (the job safety net) is not listed in the `vercel.json` crons, so if the client kick is lost the first intelligence run depends on that route being scheduled elsewhere.

## 13. Related documents

- [SPRINT-1-TECHNICAL.md](../../../SPRINT-1-TECHNICAL.md) — original onboarding design
- [BUSINESS-CONTEXT-MODEL.md](../../../BUSINESS-CONTEXT-MODEL.md) — the write rules onboarding goes through
- [AURA-HOME.md](../../../AURA-HOME.md), [EMPTY-STATES.md](../../../EMPTY-STATES.md)
- [01-authentication-and-accounts](../01-authentication-and-accounts/01-FEATURE-DETAILS.md)
- [02-workspaces-team-and-roles](../02-workspaces-team-and-roles/01-FEATURE-DETAILS.md)
- [10-aura-home-and-briefing](../10-aura-home-and-briefing/01-FEATURE-DETAILS.md)
- [25-navigation-and-design-system](../25-navigation-and-design-system/01-FEATURE-DETAILS.md)
