# Software Requirements Specification — Botella Aura

| Field | Value |
| --- | --- |
| Product | Botella Aura — AI Marketing Co-Pilot (`botella-aura`) |
| Version | 0.1.0 |
| Date | 30 Oct 2026 |
| Status | Baseline as built |
| Repository | `botella-aura` (Git, branch `main`); development started 23 Jul 2026 |
| Document type | Software Requirements Specification (IEEE 830 / ISO/IEC/IEEE 29148 structure) |
| Related docs | [Overall architecture](feature-docs/01-overall-architecture/OVERALL-ARCHITECTURE.md) · [Feature docs](feature-docs/02-features/) · [Specifications](feature-docs/05-resources/SPECIFICATIONS.md) · [Internal API](feature-docs/04-api/INTERNAL-API.md) · [External APIs](feature-docs/04-api/EXTERNAL-APIS.md) · [Environment variables](feature-docs/06-environment/ENVIRONMENT-VARIABLES.md) · [Changelog](feature-docs/03-changelog/CHANGELOG.md) |

---

## 1. Introduction

### 1.1 Purpose

This document specifies the functional, interface, non-functional and data requirements of Botella Aura
version 0.1.0 as it is built at the date above. It is a baseline: each requirement describes behaviour that
exists in the code (or, where marked, behaviour that is planned or blocked), and each one is traced to a feature
document, the code that implements it and the test or verification script that proves it.

The intended readers are the product owner, engineers maintaining the system, testers writing acceptance tests,
reviewers preparing platform submissions (Meta App Review, LinkedIn API access) and anyone taking over the
codebase.

### 1.2 Scope

Botella Aura is an AI marketing co-pilot for small and medium businesses. It learns a business, watches its
market, decides what is worth doing, drafts the work and hands it to a person to approve before anything is
published or sent. It is delivered as:

- a multi-tenant SaaS web application (Next.js 14, TypeScript, Prisma/PostgreSQL, NextAuth);
- a Chrome Manifest V3 extension that acts as the human action layer inside the user's own LinkedIn session;
- a WhatsApp assistant on one central number through the Meta WhatsApp Cloud API.

The core loop is: **Business Context → Signals → Opportunities → Recommendations → Content Brief → Generation and
checks → human Review/Approval → Execution** (Meta and LinkedIn), with results feeding Marketing Memory and the
next round of signals.

In scope: the 25 features in [`feature-docs/02-features/`](feature-docs/02-features/), the platform services
they share and the external interfaces they use. Out of scope: the third-party platforms themselves, the content
of the legal pages (still drafts, see ISSUE-14) and features listed in the feature docs as future work, except
where a "Not implemented" requirement records a known gap.

### 1.3 Definitions, acronyms and abbreviations

| Term | Definition |
| --- | --- |
| Workspace / Company | The tenant. Every business record carries `companyId`; a user can belong to several workspaces. |
| Role | A workspace membership role: OWNER, ADMIN, MEMBER or VIEWER (`lib/rbac.ts`). |
| Business Context | The resolved, provenance-tracked model of what Aura knows about the business (source, confidence, freshness per fact). |
| Snapshot | The stored, bounded Business Context Snapshot read by AI workflows; rebuilt when sources change or after 6 h. |
| Signal | A normalised, de-duplicated observation from trends, competitors, analytics, memory or Business Context. |
| Opportunity | An evidence-backed chance to act, detected from signals by rules or validated AI. |
| Recommendation / Suggestion | A concrete action proposed for an opportunity ("Aura Suggests" is its plain-language presentation). |
| Content Brief | The versioned 16-field brief built from an accepted recommendation that drives generation. |
| Draft | A `ContentDraft` (or `OutreachMessage`) awaiting review, approval and execution. |
| Fingerprint | The hash of body, platform and ordered media bound to an approval; any change reopens approval. |
| Execution | A tracked attempt to publish one approved draft to one network. |
| Autopilot | The weekly job that writes and illustrates posts and assembles the weekly briefing. |
| Connector / Connection | An integration with an external service (OAuth or API key) and its stored, encrypted credentials. |
| Extension token | A bearer token (`aura_ext_…`) that authorises the Chrome extension for one user and workspace. |
| AES-256-GCM | Authenticated symmetric encryption used for secrets at rest. |
| API | Application Programming Interface. |
| CAS | Compare-and-swap: a conditional update that fails (409) when the row changed underneath. |
| CSE | Google Custom Search Engine. |
| HMAC | Hash-based Message Authentication Code. |
| IANA | Time-zone database names (e.g. `Asia/Kolkata`). |
| JWT | JSON Web Token (NextAuth session format). |
| MV3 | Chrome extension Manifest Version 3. |
| OIDC | OpenID Connect. |
| PKCE | Proof Key for Code Exchange (OAuth). |
| RBAC | Role-based access control. |
| SSRF | Server-side request forgery. |
| Zod | The TypeScript schema library used to validate every input, AI output and handoff contract. |

### 1.4 References

| Ref | Document |
| --- | --- |
| R1 | [Overall architecture](feature-docs/01-overall-architecture/OVERALL-ARCHITECTURE.md) |
| R2 | [Feature details, 25 features](feature-docs/02-features/) (one `01-FEATURE-DETAILS.md` per folder) |
| R3 | [Specifications](feature-docs/05-resources/SPECIFICATIONS.md) |
| R4 | [Internal API reference](feature-docs/04-api/INTERNAL-API.md) (181 route files, 250 operations) |
| R5 | [External APIs](feature-docs/04-api/EXTERNAL-APIS.md) |
| R6 | [Environment variables](feature-docs/06-environment/ENVIRONMENT-VARIABLES.md) |
| R7 | [Changelog](feature-docs/03-changelog/CHANGELOG.md) |
| R8 | [`lib/rbac.ts`](../lib/rbac.ts) — role → permission matrix |
| R9 | [`prisma/schema.prisma`](../prisma/schema.prisma) — data model (61 models) |
| R10 | [Meta App Review submission](META-APP-REVIEW-SUBMISSION.md), [Meta integration](META-INTEGRATION.md), [Sandbox](SANDBOX.md) |
| R11 | IEEE Std 830-1998 and ISO/IEC/IEEE 29148:2018, requirements engineering (structure only) |

Where a document and the code disagree, the code is authoritative and this specification follows the code.

### 1.5 Document conventions

**Requirement IDs.** Functional requirements are `FR-<AREA>-NN`, where `AREA` is a short code per feature (AUTH,
WS, ONB, KB, BC, TRD, CMP, OPP, REC, HOME, CNT, MED, REV, CPN, LEAD, ENG, EXT, MEM, CONN, EXE, WA, BIL, AI, PLT,
NAV). Non-functional requirements are `NFR-<CAT>-NN` (PERF, SEC, PRIV, REL, SCAL, MAINT, USE, PORT, AUD, COMP).
Open issues are `ISSUE-NN`. IDs are stable; a retired requirement keeps its ID.

**Wording.** "The system shall" states a mandatory, testable behaviour. Values (limits, statuses, roles, error
codes) are the ones in the code at the baseline date.

**Priority.**

| Priority | Meaning |
| --- | --- |
| Must | Core to the product loop, safety, security or tenant isolation; release cannot proceed without it. |
| Should | Important for a complete product; a workaround exists. |
| Could | Desirable; deferrable without harm. |

**Verification method.**

| Method | Meaning |
| --- | --- |
| Test (`tests/*.test.ts[x]`) | Vitest unit or component suite run by `pnpm test`. |
| `pnpm verify:*` | End-to-end script run against a running app (`VERIFY_BASE_URL`, default port 3001). |
| Inspection | Code or configuration review against the requirement. |
| Demonstration | Manual walk-through of the running product. |

**Status.**

| Status | Meaning |
| --- | --- |
| Implemented | Built and verified as stated. |
| Partially implemented | Built, but a stated condition does not hold in the current configuration (e.g. a cron route that is not scheduled, or a permission gap). |
| Blocked (external) | Code complete; waiting on a third-party approval (e.g. Meta App Review, LinkedIn API access). |
| Not implemented | A known gap recorded so it can be traced; no code yet. |

---

## 2. Overall description

### 2.1 Product perspective

Aura is a new, self-contained product. It is one Next.js application that serves the web UI and the API, backed
by one PostgreSQL database, with two additional clients (the Chrome extension and WhatsApp) and a set of optional
external services. Every external call goes through one HTTP client (`lib/http.ts`) or one AI client
(`server/ai/claude.ts`). A missing key turns a feature into a labelled fallback rather than an error.

| Component | Role | Talks to |
| --- | --- | --- |
| Web app (browser) | All screens for owners, admins, members and viewers | Aura API over HTTPS with a NextAuth session cookie |
| Chrome extension (MV3) | Inserts approved posts, outreach and comments into LinkedIn's own composer for a person to send; syncs status and metrics back | Aura API with `Authorization: Bearer aura_ext_…`; LinkedIn page DOM (client side only) |
| WhatsApp assistant | Read, draft, approve and publish by message, with the same permissions as the web | Meta WhatsApp Cloud API → Aura webhook; Aura → Graph `messages` |
| Aura server (Vercel, region `sin1`) | Route handlers, services, background jobs, cron routes | PostgreSQL (Neon), optional S3-compatible bucket, external services below |
| AI providers | Text: Anthropic Claude (primary), Google Gemini (fallback). Images: Gemini, OpenAI, Stability, Replicate, Hugging Face, Agnes | Server only |
| Social platforms | Meta Graph API (Facebook Pages, Instagram, WhatsApp); LinkedIn REST API | Server only (the extension uses the LinkedIn UI) |
| Public data sources | Google News, Bing News, RSS, Reddit, Hacker News, X (flagged off), GitHub, company and competitor websites | Server only; robots.txt honoured |
| Business services | Google OAuth / GA4 / Search Console, HubSpot, Mailchimp, Slack, Crunchbase, Google CSE, Stripe, Resend/SMTP | Server only |

The server never logs in to LinkedIn and never scrapes it.

### 2.2 Product functions

| Function group | Features (section) |
| --- | --- |
| Access and tenancy | Authentication & Accounts (3.1); Workspaces, Team & Roles (3.2); Onboarding & Guided Setup (3.3) |
| Learn the business | Knowledge Base & Brand Voice (3.4); Business Context & About My Business (3.5) |
| Watch the market | Trend Insights (3.6); Competitor Intelligence (3.7); Signals & Opportunity Detection (3.8) |
| Decide | Recommendations & Aura Suggests (3.9); Aura Home, What Matters Now & Weekly Briefing (3.10) |
| Create | Content Studio (3.11); Media, Graphics & Marketing Creatives (3.12); Campaigns & Content Planner (3.14) |
| Approve | Review, Approval, Versions & Traceability (3.13) |
| Reach customers | Lead Discovery & Outreach (3.15); Engagement Copilot (3.16); Chrome Extension (3.17) |
| Execute | Connections, Connectors & OAuth (3.19); Publishing, Execution Engine & Scheduling (3.20); WhatsApp AI Assistant (3.21) |
| Learn from results | Marketing Memory & Analytics (3.18) |
| Commercial | Billing, Plans & Entitlements (3.22) |
| Platform | AI Layer (3.23); Platform: Jobs, Cron, Security & Deployment (3.24); Navigation, Dashboard Shell & Design System (3.25) |

### 2.3 User classes and characteristics

Permissions are defined once in `lib/rbac.ts`. A refused action returns HTTP 403; a workspace can never be left
without an OWNER.

| Role | Description | Permissions (`lib/rbac.ts`) |
| --- | --- | --- |
| OWNER | Creator of the workspace; accountable for billing and the workspace itself | All: `company:update`, `company:delete`, `company:manageBilling`, `members:invite`, `members:remove`, `linkedin:connect`, `content:create`, `content:approve`, `content:publish` |
| ADMIN | Marketing lead or agency manager running the workspace day to day | All except `company:delete` and `company:manageBilling` |
| MEMBER | Contributor who drafts content | `content:create` only (cannot approve, publish, connect channels or change settings) |
| VIEWER | Stakeholder or client who reads | None (read-only); see ISSUE-01 to ISSUE-03 for routes that do not yet enforce this |
| WhatsApp user | A linked Aura user acting through WhatsApp | The same role as on the web, re-read on every message |
| Extension user | A signed-in user who paired the extension | The same role as on the web, re-read on every request |
| Platform operator | Deploys and configures the system (not a workspace role) | Environment variables, cron scheduler, platform app registrations |

Users are assumed to be marketing practitioners, not engineers: the UI uses outcome-named labels and plain
language, never enum names, scores or ids.

### 2.4 Operating environment

| Item | Environment |
| --- | --- |
| Server runtime | Node.js ≥ 20; Next.js 14.2.18 (App Router), React 18.3; serverless functions on Vercel region `sin1`, `maxDuration` 60 s |
| Database | PostgreSQL — Neon (`ap-southeast-1`) in production via pooled `DATABASE_URL` and direct `DIRECT_URL`; PostgreSQL 16 (`postgres:16-alpine`) locally via Docker |
| Object storage | Optional S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO); Postgres storage when absent |
| Browser | Current evergreen browsers; layouts verified at 375, 768 and 1280 px |
| Extension | Google Chrome with Manifest V3, installed unpacked from `public/downloads/botella-aura-extension.zip` |
| WhatsApp | Any WhatsApp client messaging the central Botella number |
| Alternative hosts | Netlify and Railway configurations exist in the repository; Vercel is the reference deployment |

### 2.5 Design and implementation constraints

- **Language and toolchain:** TypeScript 5.6 `strict` (`noUncheckedIndexedAccess`, `noImplicitOverride`), pnpm ≥ 9 with a frozen lockfile, Prisma 5.22, NextAuth v4 (JWT sessions), Zod 3, Tailwind CSS 3.4 with shadcn/ui primitives.
- **Layering:** edge middleware → route handler (Zod, session, workspace scope, RBAC, entitlement) → service (business rules, state machines, audit) → `lib` (pure rules). All writes live in services.
- **Single clients:** every model call goes through `server/ai/claude.ts`; every outbound HTTP call through `lib/http.ts`.
- **Serverless limit:** every route has `maxDuration` 60 s; longer work runs as resumable `GenerationJob`s or cron sweeps.
- **Human approval:** nothing is published or sent without a person's approval bound to a content fingerprint; `PUBLISHED` is reachable only from `APPROVED`.
- **No fabrication:** facts carry provenance; quality rules, fact check and AI reviewer block unsupported figures; empty states say what is missing.
- **Public sources only:** robots.txt honoured, per-origin throttling, no LinkedIn scraping or automated clicking.
- **Schema changes:** only through Prisma migrations (49 migrations at baseline, `0_init` plus 48 dated); approval, versions, trace and compliance policy live in JSON columns and needed no migration.
- **Execution gate:** `CONTEXTUAL_EXECUTION_ENABLED = false` (`lib/execution-gate.ts`) keeps campaigns and outreach created from recommendations out of execution.

### 2.6 Assumptions and dependencies

| ID | Assumption or dependency | Effect if not met |
| --- | --- | --- |
| DEP-01 | **Meta App Review** approves the Facebook Login / Instagram permissions requested in [META-APP-REVIEW-SUBMISSION.md](META-APP-REVIEW-SUBMISSION.md) (Pages publishing, Instagram content publishing; `read_insights` and `instagram_manage_insights` for detailed insights) | Facebook and Instagram publishing and detailed Meta insights work only for app testers (FR-EXE-02, FR-CONN-15) |
| DEP-02 | **WhatsApp Cloud API** production access (business verification, production number) | The assistant runs on a test number only |
| DEP-03 | **LinkedIn Community Management API** approval (`w_organization_social`) and `LINKEDIN_ORG_URN` | Company Page posting unavailable; member-profile posting (`w_member_social`) works (FR-EXE-16) |
| DEP-04 | An official LinkedIn API scope for company data | LinkedIn competitor signals stay skipped (FR-CMP-07) |
| DEP-05 | At least one AI text key (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`) | Generation returns 503; other AI features fall back to labelled deterministic output |
| DEP-06 | An external scheduler (or additions to `vercel.json`) calls the 11 unscheduled cron routes | Daily/weekly automation for trends, competitors, advisor, intelligence, campaigns, outreach, discovery, memory, analytics, WhatsApp sweep and job reaper does not run (ISSUE-04) |
| DEP-07 | An email transport (SMTP or Resend) in production | Invitations and resets are logged to the console and reported as "not sent" |
| DEP-08 | Stripe keys and price ids | Billing shows "not configured"; workspaces stay on trial |
| DEP-09 | A 32-byte `ENCRYPTION_KEY`, `NEXTAUTH_SECRET` and `CRON_SECRET` | Connectors cannot store credentials; sessions fail; cron routes refuse all calls |
| DEP-10 | An S3-compatible bucket | Video upload and Instagram Reels are unavailable; images are stored in Postgres |
| DEP-11 | Users act on LinkedIn through the extension themselves | Outreach and comments are never sent automatically by design |

---

## 3. Functional requirements

Each subsection corresponds to one feature folder, in folder order. The feature document is the detailed source
for every value quoted.

### 3.1 Authentication & Accounts

Feature folder: [`01-authentication-and-accounts`](feature-docs/02-features/01-authentication-and-accounts/01-FEATURE-DETAILS.md)

Lets a person create an account, sign in with email and password or Google / LinkedIn, recover a forgotten password and reach an invitation link signed in.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-AUTH-01 | The system shall let a visitor create an account with name (1-80 characters), work email (trimmed, lower-cased, valid) and a password of 8-72 characters containing at least one letter and one number, returning 201 `{ id, email, name }` and never the password hash. | Must | `tests/validations.test.ts` | Implemented |
| FR-AUTH-02 | The system shall reject sign-up with an email that already exists with HTTP 409, and shall store passwords only as bcrypt hashes with cost 12. | Must | `tests/password.test.ts` | Implemented |
| FR-AUTH-03 | The system shall return one identical failure ("Incorrect email or password.") for an unknown user, an OAuth-only user without a password and a wrong password, so accounts cannot be enumerated. | Must | `tests/password.test.ts` | Implemented |
| FR-AUTH-04 | The system shall offer "Continue with Google" and "Continue with LinkedIn" only when both the client id and client secret for that provider are configured, and shall never render a button for a provider that was not built. | Should | `tests/auth-providers.test.ts` | Implemented |
| FR-AUTH-05 | The system shall request only the `openid profile email` scopes for LinkedIn sign-in, keeping posting rights (`w_member_social`) for the separate LinkedIn connection flow. | Must | `tests/auth-providers.test.ts` | Implemented |
| FR-AUTH-06 | The system shall refuse to link an OAuth sign-in to an existing account by email when the provider reports `email_verified: false`, redirecting to `/login?error=EmailNotVerified`. | Must | `tests/auth-providers.test.ts` | Implemented |
| FR-AUTH-07 | The system shall issue JWT sessions with a lifetime of 30 days and redirect unauthenticated requests to `/dashboard/*` and `/onboarding/*` to `/login` with a `callbackUrl`, returning 401 from route handlers. | Must | `pnpm verify:access` | Implemented |
| FR-AUTH-08 | The system shall respond to a forgot-password request with the same neutral message whether or not the email exists, and for a known user email a link containing a 32-byte random token of which only the SHA-256 hash is stored, valid for 1 hour. | Must | Inspection | Implemented |
| FR-AUTH-09 | The system shall reject a missing, used or expired reset token with HTTP 400 ("This reset link is invalid or has expired."), and on success shall set the new password, mark the token used and revoke every other unused reset token for that user in one transaction. | Must | Inspection | Implemented |
| FR-AUTH-10 | The system shall rate-limit public auth endpoints per client IP: sign-up 5 requests / 60 s, forgot-password 5 / 60 s and reset-password 10 / 60 s, answering HTTP 429 when exceeded. | Must | Inspection | Partially implemented |
| FR-AUTH-11 | The system shall accept a post-login `callbackUrl` only when it is a same-site path starting with `/` (not `//`) without backslashes or control characters, defaulting to `/dashboard`. | Must | `tests/security-fixes.test.ts` | Implemented |
| FR-AUTH-12 | The system shall map every NextAuth error code and `EmailNotVerified` on `/login` to a readable sentence, using "Sign-in did not complete. Please try again." for unknown codes. | Should | `tests/auth-providers.test.ts` | Implemented |
| FR-AUTH-13 | The system shall write `USER_SIGNED_UP`, `USER_LOGGED_IN`, `USER_LOGGED_OUT`, `PASSWORD_RESET_REQUESTED` and `PASSWORD_RESET_COMPLETED` audit entries for the corresponding events. | Should | Inspection | Implemented |
| FR-AUTH-14 | The system shall verify the email address of new email/password accounts before treating it as verified. | Could | Inspection | Not implemented |

### 3.2 Workspaces, Team & Roles (RBAC)

Feature folder: [`02-workspaces-team-and-roles`](feature-docs/02-features/02-workspaces-team-and-roles/01-FEATURE-DETAILS.md)

Makes the `Company` the tenant for all data, lets users switch workspaces, invite teammates at a role and manage members under one role matrix (`lib/rbac.ts`).

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-WS-01 | The system shall enforce the role matrix in `lib/rbac.ts`: OWNER has all permissions; ADMIN has every permission except `company:delete` and `company:manageBilling`; MEMBER has only `content:create`; VIEWER has none, and a refused action shall return HTTP 403 "Your role (X) is not permitted to: Y". | Must | `pnpm verify:permissions` | Implemented |
| FR-WS-02 | The system shall scope every workspace query to a company taken from the caller's own memberships, falling back to the first membership when the `aura.activeCompany` cookie names a company the user does not belong to, and shall return 404 for cross-workspace ids. | Must | `pnpm verify:access`, `tests/tenant-isolation.test.ts` | Implemented |
| FR-WS-03 | The system shall create a workspace (name 2-80 characters) with a unique slug (suffixed `-1`, `-2`, … on collision), an OWNER membership for the creator and `COMPANY_CREATED` and `ONBOARDING_COMPLETED` audits in one transaction. | Must | `tests/company-service.test.ts` | Implemented |
| FR-WS-04 | The system shall refuse to create a workspace whose name matches (case-insensitively) one of the user's existing workspaces with HTTP 409 unless `confirmDuplicate` is true. | Should | `tests/request-body.test.ts` | Implemented |
| FR-WS-05 | The system shall let users with `members:invite` (OWNER, ADMIN) invite an email at a role, storing only the SHA-256 hash of a 32-byte token with a 7-day expiry and keeping one active invitation per (company, email); only an OWNER may invite an OWNER. | Must | `pnpm verify:permissions` | Implemented |
| FR-WS-06 | The system shall refuse to invite a person who is already a member with HTTP 409 "That person is already a member." | Should | Inspection | Implemented |
| FR-WS-07 | The system shall record the actual email outcome of each invitation as `SENT`, `FAILED` or `NOT_CONFIGURED` with transport and error, and shall always return the `acceptUrl` so the link can be shared manually. | Must | `tests/email-delivery.test.ts` | Implemented |
| FR-WS-08 | The system shall accept an invitation only when it is `PENDING`, unexpired and addressed to the signed-in user's email, returning 400 for invalid or expired (setting status `EXPIRED`) and 403 for an email mismatch. | Must | Inspection | Implemented |
| FR-WS-09 | The system shall let users with `members:remove` change a member's role or remove a member, allowing only an OWNER to grant or change the OWNER role. | Must | `pnpm verify:permissions` | Implemented |
| FR-WS-10 | The system shall refuse to demote or remove the last OWNER of a workspace with HTTP 409 "This is the only owner. Assign another owner first." | Must | Inspection | Implemented |
| FR-WS-11 | The system shall select the email transport in order SMTP, Resend, console, never report a console-only send as delivered, and let users with `company:update` view transport diagnostics and send a test email to themselves. | Should | `tests/email-delivery.test.ts` | Implemented |
| FR-WS-12 | The system shall restrict workspace settings writes (audience, brand, formats, contact, timezone, compliance) to `company:update`, autopilot settings to `content:approve`, and cap logo uploads at 4,000,000 bytes. | Must | `pnpm verify:permissions` | Implemented |
| FR-WS-13 | The system shall let an OWNER delete a workspace (`company:delete`). | Could | Inspection | Not implemented |

### 3.3 Onboarding & Guided Setup

Feature folder: [`03-onboarding-and-guided-setup`](feature-docs/02-features/03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md)

A four-step wizard creates the workspace and starts its first analysis; an eight-step checklist derived from real data guides the optional setup.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-ONB-01 | The system shall present a four-step onboarding wizard (Business, Audience, Voice, What happens next) to every signed-in user without a workspace, and redirect users who have one to `/dashboard` unless the URL carries `?new=1`. | Must | Demonstration | Implemented |
| FR-ONB-02 | The system shall require a business description of 20-600 characters and an audience of 10-600 characters, accept company name 2-80, industry up to 80, offerings up to 400, goals up to 600 and brand voice notes up to 2,000 characters, and normalise a bare website domain to `https://`. | Must | `tests/validations.test.ts` | Implemented |
| FR-ONB-03 | The system shall let the user choose market mode B2B or B2C (default B2B) and tone chips (8 per market mode), composing them with free-text notes into one saved brand-voice string. | Should | `tests/onboarding.test.ts` | Implemented |
| FR-ONB-04 | The system shall pass wizard input through the Business Context write rules and, on submit, create the workspace, the OWNER membership and an `INTELLIGENCE` job, set the active-company cookie and open `/dashboard`. | Must | `pnpm verify:flow` | Implemented |
| FR-ONB-05 | The system shall ask the user to confirm and resubmit when the workspace name duplicates one of their workspaces (HTTP 409). | Should | Demonstration | Implemented |
| FR-ONB-06 | The system shall offer a brand-voice preview that generates one short sample post (LinkedIn for B2B, Instagram/Facebook for B2C) from the wizard data only, with 1,200 max tokens, 45 s timeout and up to 2 attempts, and shall save nothing. | Should | Inspection | Implemented |
| FR-ONB-07 | The system shall never block onboarding on the preview: with no AI provider it returns `sample: null` with `retryable: false`, and on AI failure it returns `sample: null` with `retryable: true`. | Must | Inspection | Implemented |
| FR-ONB-08 | The system shall compute the eight ordered setup steps (business, market, materials, brand, audience, channels, plan, review) from database rows, with only `business` required, rather than from tickable flags. | Must | `tests/onboarding.test.ts`, `pnpm verify:onboarding` | Implemented |
| FR-ONB-09 | The system shall mark exactly one checklist step as current (the first incomplete in order) and show its action button. | Should | `pnpm verify:onboarding` | Implemented |
| FR-ONB-10 | The system shall show the checklist on the dashboard home until setup is finished (full before the first briefing, compact after) and show "Setup is complete" on `/dashboard/setup` when every step is done. | Should | Demonstration | Implemented |
| FR-ONB-11 | The system shall ensure the first intelligence run happens even if the client kick of `POST /api/jobs/:id/run` is lost, via the `POST /api/cron/jobs` safety net. | Should | Inspection | Partially implemented |
| FR-ONB-12 | The system shall preserve wizard answers across a page refresh. | Could | Inspection | Not implemented |

### 3.4 Knowledge Base & Brand Voice

Feature folder: [`04-knowledge-base-and-brand-voice`](feature-docs/02-features/04-knowledge-base-and-brand-voice/01-FEATURE-DETAILS.md)

Stores the company's website, blog and uploaded materials as categorised, searchable chunks and maintains a human-reviewed Brand Voice Profile used by every generation prompt.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-KB-01 | The system shall ingest the company website from the homepage, `/about`, `/about-us`, `/company` and `/blog`, respecting robots.txt for user agent `BotellaAuraBot/0.1`, waiting 1,200 ms between fetches, using a 10 s timeout with 1 retry and never executing page JavaScript. | Must | Inspection | Implemented |
| FR-KB-02 | The system shall skip pages with 60 or fewer characters of text or whose first 200 characters duplicate an already-seen page, and mark the source `SYNCED` with "No readable pages found" when none qualify. | Should | Inspection | Implemented |
| FR-KB-03 | The system shall discover an RSS/Atom feed from the homepage and ingest up to 12 entries longer than 120 characters, setting the source to `ERROR` on fetch failure without failing the website sync. | Should | Inspection | Implemented |
| FR-KB-04 | The system shall accept uploads of `.pdf`, `.docx`, `.pptx`, `.txt`, `.md` and `.markdown` up to 4,000,000 bytes, returning 413 for larger files, 415 for other types and 422 when fewer than 20 characters can be extracted (scanned PDFs). | Must | `tests/materials.test.ts`, `pnpm verify:materials` | Implemented |
| FR-KB-05 | The system shall tag each upload with one of nine material categories, pre-selecting a guess from the filename that the user must confirm, and drop an unknown category value to uncategorised rather than rejecting the upload. | Should | `tests/materials.test.ts` | Implemented |
| FR-KB-06 | The system shall replace, in one transaction, all chunks for the same (company, source type, source URL or filename) on re-sync or re-upload so no duplicates are created. | Must | `pnpm verify:materials` | Implemented |
| FR-KB-07 | The system shall split text into chunks of up to 3,200 characters, splitting long paragraphs on sentence boundaries and dropping chunks under 80 characters. | Should | Inspection | Implemented |
| FR-KB-08 | The system shall retrieve the top 6 (default) of the 400 newest chunks by keyword relevance × category weight (1.0-1.6) × recency decay (30-day half-life, floor 0.7, none for timeless categories), falling back to the most recent chunks when nothing matches. | Must | `tests/retrieve.test.ts`, `pnpm verify:materials` | Implemented |
| FR-KB-09 | The system shall label excerpts in prompts by category (truncated to 800 characters), marking competitor material as context only never to be adopted as the company's voice or claims. | Must | `tests/materials.test.ts`, `tests/brand-context.test.ts` | Implemented |
| FR-KB-10 | The system shall report material coverage for the 8 prompted categories, highlighting the highest-weight missing kind and the count of uncategorised chunks. | Should | `pnpm verify:materials` | Implemented |
| FR-KB-11 | The system shall generate a Brand Voice Profile from 8 retrieved, redacted chunks and onboarding notes using the standard AI tier (max 1,500 tokens), fall back to a deterministic heuristic when no provider is configured or the call fails, and generate it lazily on first use by content, comment and outreach drafting. | Must | Inspection | Implemented |
| FR-KB-12 | The system shall validate the Brand Voice Profile against `brandVoiceProfileSchema` on save (422 on bad shape) and on every read, and record a human save as a confirmation of `voice.profile`. | Must | Inspection | Implemented |
| FR-KB-13 | The system shall allow AI-origin writes to change only `voice.profile` (rule R6) and write `KNOWLEDGE_SOURCE_SYNCED`, `KNOWLEDGE_DOCUMENT_UPLOADED`, `BRAND_VOICE_GENERATED` and `BRAND_VOICE_UPDATED` audits. | Must | `tests/business-context-service.test.ts` | Implemented |
| FR-KB-14 | The system shall restrict knowledge upload, website sync and brand-voice regeneration or edit to roles with write permission; as built, any workspace member including VIEWER can perform them because the routes check only workspace membership. | Must | Inspection | Partially implemented |
| FR-KB-15 | The system shall let users delete an uploaded document or source, or change an upload's category after ingestion. | Could | Inspection | Not implemented |

### 3.5 Business Context & About My Business

Feature folder: [`05-business-context`](feature-docs/02-features/05-business-context/01-FEATURE-DETAILS.md)

One resolved, provenance-tracked structure for everything Aura knows about the business, read by every AI workflow and written through one validated service, shown and edited on `/dashboard/business`.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-BC-01 | The system shall resolve the Business Context (schema version 2) from its sources for 24 registered fields using each field's precedence, union or layered strategy, recording a `value_conflict` issue when a lower-precedence source disagrees. | Must | `tests/business-context.test.ts` | Implemented |
| FR-BC-02 | The system shall record per fact its source, source type, confidence, trusted flag, capture date and freshness (`stale` at the field's maximum age, `aging` at 75%, `unknown` without a capture date), capping values borrowed from a fallback at `medium` and never trusted. | Must | `tests/business-facts.test.ts` | Implemented |
| FR-BC-03 | The system shall compute a completeness score of 0-100% weighting required fields 2, recommended 1 and optional 0, treating fields in unloaded sections as unknown rather than missing. | Should | `tests/business-context.test.ts` | Implemented |
| FR-BC-04 | The system shall render workflow-specific prompt preambles for nine presets, adding a NOT YET KNOWN block for missing required/recommended fields and a RELIABILITY NOTES block for untrusted or stale facts, and label AI-suggested competitors so they are never named as competitors in output. | Must | `tests/business-context-service.test.ts` | Implemented |
| FR-BC-05 | The system shall accept business-information writes only through `updateBusinessContext` with a strict patch schema limited to identity, audience, objectives, preferred channels and voice fields, rejecting module-owned fields with a message naming the owning module. | Must | `tests/business-context-service.test.ts`, `pnpm verify:context-sources` | Implemented |
| FR-BC-06 | The system shall enforce field caps (name and industry 80, description 600, offerings 400, audience 600, goals 600, voice notes 2,000, hex colours) and rules R3-R8 (minimum lengths name 2 / description 20 / audience 10, placeholder refusal, required fields not clearable, AI writes limited to `voice.profile`, no-op not stored, section merge), returning all refusals as HTTP 422 with per-field details. | Must | `tests/business-context-service.test.ts` | Implemented |
| FR-BC-07 | The system shall apply optimistic concurrency: a PATCH whose `expectedRevision` differs from the company's current revision returns HTTP 409, and lost compare-and-swap races are re-planned up to 3 attempts before returning 409. | Must | `tests/business-context-service.test.ts` | Implemented |
| FR-BC-08 | The system shall allow PATCH context, POST questions and POST snapshot only for `company:update` (OWNER, ADMIN), returning 403 otherwise, while all members including VIEWER can read; read-only users shall see a view-only notice. | Must | `pnpm verify:access` | Implemented |
| FR-BC-09 | The system shall maintain one stored snapshot per workspace and rebuild it when forced, missing, of a different version, invalidated, when the SHA-256 source stamp over 13 sources changes, or after 6 hours. | Must | `tests/context-snapshot.test.ts`, `pnpm verify:engine` | Implemented |
| FR-BC-10 | The system shall place only trusted, non-stale facts in the snapshot's main sections, putting others in `assumptions` (or `omitted` in strict mode), and bound it by the `SNAPSHOT_LIMITS` caps (e.g. 8 insights, 8 competitors, 10 keywords, 280-character excerpts). | Must | `tests/context-snapshot.test.ts` | Implemented |
| FR-BC-11 | The system shall detect missing, conflicting, stale and unverified facts and ask up to 3 questions on the page (1-20 via API), counting a showing as asked at most once per 12 h, snoozing "Not now" for 7 days, resting after 3 unanswered asks for 3 days (critical) or 14 days (others), and refusing dismissal of a critical question with 422. | Must | `tests/context-questions.test.tsx`, `pnpm verify:readiness` | Implemented |
| FR-BC-12 | The system shall refuse an answer to a question whose gap is already filled with 409, and save accepted answers through `updateBusinessContext` with origin `settings`, marking the question `ANSWERED`. | Should | `tests/context-questions.test.tsx` | Implemented |
| FR-BC-13 | The system shall support a `?ask=<field>` deep link that brings that field's question to the front even if snoozed or resting, while honouring a dismissal. | Should | `tests/about-my-business.test.tsx` | Implemented |
| FR-BC-14 | The system shall write an audit entry with `changedFields`, `origin` and any `confirmedFields` for every real change and shall not audit a no-op. | Should | Inspection | Implemented |
| FR-BC-15 | The system shall ensure every stored business value is reachable in the context, superseded with a recorded conflict, or intentionally unmapped, failing the coverage audit on any LOST value. | Should | `tests/context-sources.test.ts`, `pnpm verify:context-sources` | Implemented |

### 3.6 Trend Insights

Feature folder: [`06-trend-insights`](feature-docs/02-features/06-trend-insights/01-FEATURE-DETAILS.md)

A daily, brand-safety-checked digest of market topics from Hacker News, Reddit, news RSS and (optionally) X, scored, enriched by AI and shown as "Market trends".

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-TRD-01 | The system shall generate at most one `TrendDigest` per company per UTC day, upserting on `(companyId, date)` so a re-run replaces that day's digest instead of duplicating it. | Must | Inspection (`server/trends/digest.service.ts`) | Implemented |
| FR-TRD-02 | The system shall fetch Hacker News, Reddit and news sources in parallel, and fetch X / Twitter only when its source toggle is explicitly on and `TWITTER_BEARER_TOKEN` and at least 1 keyword are set; a source that fails shall contribute 0 items without failing the digest. | Must | `tests/hackernews-source.test.ts`, `tests/trend-sources.test.ts` | Implemented |
| FR-TRD-03 | The system shall never fabricate items for an unconfigured source (Reddit with no subreddit, news with no keyword or feed, X without a token) and shall list such sources in `skippedSources`, shown to the user as a banner linking to trend settings. | Must | Inspection | Implemented |
| FR-TRD-04 | The system shall de-duplicate items by id and normalised title and score each as `0.35·recency + 0.30·engagement + 0.35·relevance` (0–100, 24 h recency half-life, engagement saturating at 500), keeping the top 20 items ordered by score, newest first on ties. | Must | `tests/scoring.test.ts` | Implemented |
| FR-TRD-05 | The system shall classify every item for brand safety (`clear` / `caution` / `unsuitable`) before any model call, keep the stricter of the deterministic and model verdicts, discard the AI angle for unsuitable items, and label them "Not for promotion" or "Handle with care" in the UI. | Must | `tests/brand-safety.test.ts` | Implemented |
| FR-TRD-06 | The system shall produce a digest synthesis with a summary, at most 4 recommendations and up to 12 hashtags from the first 12 items, excluding items marked not for promotion from recommendations and hashtags. | Should | Inspection | Implemented |
| FR-TRD-07 | The system shall still produce a digest with deterministic summaries, angles and hashtags, labelled `model = "fallback"` ("basic summaries"), when no AI provider is configured or the AI call fails. | Must | `pnpm verify:signals` (seeds and consumes digests); Inspection | Implemented |
| FR-TRD-08 | The system shall add up to 4 seasonal moments occurring within 45 days from a curated first-party calendar, and competitor mentions found by case-insensitive name match (≥ 2 characters) in item titles. | Could | Inspection (`server/trends/seasonal.ts`) | Implemented |
| FR-TRD-09 | The system shall let users view the latest digest or any digest from the last 7 days (`?date=YYYY-MM-DD`) and open Content Studio from a trend card via `/dashboard/content/new?trendId=<id>`. | Must | `pnpm verify:pages` | Implemented |
| FR-TRD-10 | The system shall run an on-demand refresh as a `TREND_DIGEST` background job that requires `content:create` (OWNER, ADMIN, MEMBER), reuses an in-flight job, reports progress at 8/20/55/80/95 % and allows up to 3 attempts. | Must | Inspection (`app/api/jobs/route.ts`, `server/jobs/runners.ts`) | Implemented |
| FR-TRD-11 | The system shall validate trend configuration with `updateTrendConfigSchema`: up to 25 keywords (1–80 chars), up to 15 subreddits matching `^[A-Za-z0-9_]{2,50}$`, up to 10 RSS feed URLs, up to 25 competitor names, and `timeRangeDays` 1–90 (default 4). | Must | Inspection (`lib/validations/trends.ts`) | Implemented |
| FR-TRD-12 | The system shall restrict changes to trend configuration and synchronous refresh (`PUT /api/trends/config`, `POST /api/trends/refresh`) to roles with a write permission; as built these routes check membership only, so a VIEWER can change trend config or trigger a refresh (see ISSUE in §7). | Should | Inspection (`app/api/trends/config/route.ts`) | Partially implemented |
| FR-TRD-13 | The system shall seed smart defaults once per company (8–12 keywords, 4–8 subreddits, 0–5 competitors via AI, or a heuristic without AI), capped at 15 / 10 / 10, and never overwrite them after a user save (`defaultsSeeded = true`). | Should | Inspection (`server/services/trend-config.service.ts`) | Implemented |
| FR-TRD-14 | The system shall refresh digests automatically once a day for every company through `/api/cron/trends` authenticated by `Authorization: Bearer $CRON_SECRET` (401 when unset); the route exists but is not scheduled in `vercel.json`. | Should | Inspection (`vercel.json`, `app/api/cron/trends/route.ts`) | Partially implemented |
| FR-TRD-15 | The system shall record `TREND_CONFIG_UPDATED`, `TREND_DIGEST_REQUESTED`, `TREND_DIGEST_GENERATED` and `AI_SUGGESTION_GENERATED` audit entries, and render stored digests from older builds without crashing (`normalizeDigestPayload`). | Should | `tests/digest-payload.test.ts` | Implemented |

### 3.7 Competitor Intelligence

Feature folder: [`07-competitor-intelligence`](feature-docs/02-features/07-competitor-intelligence/01-FEATURE-DETAILS.md)

Tracks a workspace's competitors through public sources only (homepage, pricing page, Google News, GitHub), stores change snapshots and produces a weekly AI report.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-CMP-01 | The system shall let OWNER and ADMIN (`company:update`) add, edit and remove competitors (name 2–120 chars, URLs ≤ 300 chars, GitHub login ≤ 39 chars, notes ≤ 2,000 chars) and return 403 to MEMBER and VIEWER. | Must | Inspection (`app/api/competitors/route.ts`) | Implemented |
| FR-CMP-02 | The system shall let any workspace member view the competitor list with each competitor's latest snapshot, and return 404 for a competitor id from another workspace. | Must | `pnpm verify:access` | Implemented |
| FR-CMP-03 | The system shall fetch the homepage and pricing page only when robots.txt allows, with a 1,200 ms throttle, 10 s timeout, 1 retry and user agent `BotellaAuraBot/0.1`, keeping at most 20,000 characters of text. | Must | Inspection (`server/competitors/sources/website.ts`) | Implemented |
| FR-CMP-04 | The system shall detect page changes by SHA-256 hash of normalised text, record the first capture as a baseline (no change), make no AI call when the hash is unchanged, and on change compute a line diff capped at 40 added / 40 removed lines. | Must | `tests/competitor-diff.test.ts` | Implemented |
| FR-CMP-05 | The system shall summarise each change in 1–2 sentences with the cheap AI tier (400 tokens) and fall back to a deterministic summary when no AI provider is configured or the call fails. | Should | `tests/competitor-diff.test.ts` | Implemented |
| FR-CMP-06 | The system shall collect up to 8 Google News items per competitor that are no older than 10 days, contain the competitor name in the title and are de-duplicated by link, and the 5 most recently pushed public GitHub repos plus the latest release when a GitHub org is set. | Should | Inspection (`server/competitors/sources/news.ts`, `github.ts`) | Implemented |
| FR-CMP-07 | The system shall never fetch LinkedIn company pages and shall record the LinkedIn source as skipped with the reason that an official API scope is required. | Must | Inspection (`server/competitors/sources/linkedin.ts`) | Blocked (external) |
| FR-CMP-08 | The system shall record in every snapshot which sources were skipped and why, and in every report section its coverage (snapshots, sources checked, sources skipped, baseline only). | Should | Inspection | Implemented |
| FR-CMP-09 | The system shall refuse a tracking pass for a competitor with `trackingEnabled = false` with HTTP 409 "Tracking is disabled for this competitor.". | Should | Inspection (`app/api/competitors/[id]/track/route.ts`) | Implemented |
| FR-CMP-10 | The system shall generate one weekly report per company per ISO week (Monday 00:00 UTC), upserted on `(companyId, weekStart)`, with per-competitor launches, pricing changes, notable activity and takeaway plus an overall synthesis, using a deterministic report when AI is unavailable or fails. | Must | `tests/competitor-diff.test.ts` (`startOfIsoWeekUTC`) | Implemented |
| FR-CMP-11 | The system shall let OWNER and ADMIN generate the current week's report on demand ("Generate now"), tracking all competitors in sequence within the 60 s route limit, and list the 12 most recent reports. | Should | Inspection (`app/api/competitors/reports/route.ts`) | Implemented |
| FR-CMP-12 | The system shall run weekly tracking and report generation for every company via `/api/cron/competitors` with `Bearer $CRON_SECRET` (fails closed); the route is not scheduled in `vercel.json`. | Should | Inspection (`vercel.json`) | Partially implemented |
| FR-CMP-13 | The system shall let managers pause tracking per competitor; `trackingEnabled` can be changed only through `PATCH /api/competitors/:id`, with no UI toggle. | Could | Inspection (`components/dashboard/competitors/competitor-manager.tsx`) | Partially implemented |
| FR-CMP-14 | The system shall audit every add, update (with changed fields), remove, snapshot, report request and report generation, and read legacy or empty `changesSummary` JSON without failing. | Should | `tests/stored-payload-tolerance.test.ts` | Implemented |

### 3.8 Signals & Opportunity Detection

Feature folder: [`08-signals-and-opportunities`](feature-docs/02-features/08-signals-and-opportunities/01-FEATURE-DETAILS.md)

Aggregates observations from five sources into one signal store and turns them into evidence-backed opportunities through rules, validated AI detection and the advisor, with a tracked lifecycle.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-OPP-01 | The system shall collect signals from 5 sources (TRENDS, COMPETITORS, ANALYTICS, MEMORY, BUSINESS_CONTEXT) over a 30-day lookback, skip and report a failing source while the rest still run, and expire signals after 14 / 30 / 45 / 60 days respectively (business context: none). | Must | `pnpm verify:signals`, `tests/signals.test.ts` | Implemented |
| FR-OPP-02 | The system shall de-duplicate signals by `dedupeKey` (canonical URL without tracking params, or a text key), keep at most 20 sightings per signal, raise reliability one step when seen more than once (never above HIGH), and be idempotent on repeated collection. | Must | `pnpm verify:signals`, `tests/signals.test.ts` | Implemented |
| FR-OPP-03 | The system shall create analytics signals only for metrics that moved at least 25 % and at least 3 in absolute terms between the latest two reports. | Should | `tests/signals.test.ts` | Implemented |
| FR-OPP-04 | The system shall detect opportunities with 5 deterministic rules (`competitor-move`, `trending-topic`, `proven-pattern`, `results-shift`, `unconnected-channel`) reading up to 500 current signals. | Must | `pnpm verify:detection`, `tests/opportunity-detection.test.ts` | Implemented |
| FR-OPP-05 | The system shall suppress rule candidates that have no current evidence, are not relevant to the business, reuse evidence from a rejected opportunity, or duplicate one in the same run, and mute a rule for 30 days after 3 or more rejections with no acceptance in 60 days. | Must | `tests/opportunity-detection.test.ts` | Implemented |
| FR-OPP-06 | The system shall run AI detection only for `CONTENT_GAP`, `COMPETITIVE_GAP` and `AUDIENCE_SEGMENT`, with at least 2 and at most 40 signals, and accept at most 5 opportunities per run. | Should | `pnpm verify:ai-detection`, `tests/ai-opportunity-detection.test.ts` | Implemented |
| FR-OPP-07 | The system shall reject an AI-detected opportunity that cites an unknown signal, relies on a business fact not in the snapshot, declares assumptions, states a number not present in a cited signal or the snapshot, or lacks the required evidence per category, and shall audit each run (`OPPORTUNITY_AI_DETECTION_RUN`, up to 20 rejections). | Must | `pnpm verify:ai-detection`, `tests/ai-opportunity-detection.test.ts` | Implemented |
| FR-OPP-08 | The system shall skip AI detection (status `skipped`) and use the advisor's deterministic fallback when no AI provider is configured, while rule-based detection continues unaffected. | Must | `pnpm verify:ai-detection` | Implemented |
| FR-OPP-09 | The system shall refuse to record an opportunity with no evidence (1–50 evidence items required, http(s) URLs only) and derive its confidence from distinct evidence (capped at MEDIUM when a relied-on business field is untrusted, stale or missing) and priority as LOW / MEDIUM / HIGH / URGENT from impact, effort, confidence and time left. | Must | `pnpm verify:opportunities`, `tests/opportunities.test.ts` | Implemented |
| FR-OPP-10 | The system shall merge a re-detection into the existing open opportunity (adding evidence, recomputing confidence and priority, extending the window), never override an ACCEPTED or REJECTED decision, and reopen an EXPIRED one to DETECTED. | Must | `pnpm verify:opportunities`, `pnpm verify:detection` | Implemented |
| FR-OPP-11 | The system shall enforce the lifecycle DETECTED → REVIEWED → RECOMMENDED → ACCEPTED / REJECTED / EXPIRED (REJECTED may reopen to REVIEWED; ACCEPTED is final) with a compare-and-swap that returns 409 on a disallowed or concurrent change, and record every change as an `OpportunityEvent`. | Must | `pnpm verify:opportunities`, `tests/opportunities.test.ts` | Implemented |
| FR-OPP-12 | The system shall expire open opportunities whose `relevantUntil` has passed before every list and at the start of each advisor run, and mirror ACCEPTED / REJECTED / EXPIRED onto their open recommendations. | Must | `pnpm verify:opportunities` | Implemented |
| FR-OPP-13 | The system shall restrict detection, signal refresh, status changes and "Recommend" to `company:update` (OWNER, ADMIN) and advisor report generation to `content:create` (OWNER, ADMIN, MEMBER), allow all members to read, and return 404 for another workspace's ids. | Must | `pnpm verify:access` | Implemented |
| FR-OPP-14 | The system shall generate a daily advisor report ("Campaign ideas") with at most 6 campaign opportunities and 4 competitive gaps over a 30-day lookback, dropping opportunities that cite no supplied evidence and returning an honest empty report when there is no competitor or trend evidence. | Should | Inspection (`server/advisor/advisor.service.ts`) | Implemented |
| FR-OPP-15 | The system shall run the advisor (with expiry, collection and both detectors) for every company via `/api/cron/advisor` with `Bearer $CRON_SECRET`; the route is not scheduled in `vercel.json`. | Should | Inspection (`vercel.json`) | Partially implemented |
| FR-OPP-16 | The system shall show each opportunity's evidence with links to the Aura page holding the underlying record and, for accepted opportunities, a type-specific next step (e.g. Content Studio brief, Competitors, Connectors). | Should | `tests/opportunity-ui.test.ts` | Implemented |

### 3.9 Recommendations & Aura Suggests

Feature folder: [`09-recommendations-and-aura-suggests`](feature-docs/02-features/09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md)

A rules-first engine turns each open opportunity into one concrete, evidence-backed recommendation, guarded, quality-checked, ranked for "now" and presented in plain language with one next step.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-REC-01 | The system shall generate a recommendation only from an opportunity in an active status, inside its relevance window and with current evidence, and return 409 when the opportunity already has a live recommendation. | Must | `pnpm verify:recommendation-handoff`, `tests/recommendation-handoff.test.ts` | Implemented |
| FR-REC-02 | The system shall select the action deterministically from the opportunity type's catalogue (e.g. `TRENDING_TOPIC`: post, series), setting aside actions that need an unused channel, an unknown audience, more days than remain (series ≥ 7 days) or missing evidence. | Must | `pnpm verify:engine`, `tests/recommendation-engine.test.ts` | Implemented |
| FR-REC-03 | The system shall enforce minimum evidence per recommendation type (1 current signal; CAMPAIGN 2; COMPETITIVE_RESPONSE 1 from COMPETITORS; CHANNEL 1 from BUSINESS_CONTEXT; OPTIMIZATION 1 from ANALYTICS or MEMORY) and reject with "No action this business can take is supported by the available data." when nothing remains. | Must | `pnpm verify:guardrails`, `tests/recommendation-rules.test.ts` | Implemented |
| FR-REC-04 | The system shall store no more than 10 new recommendations per workspace per rolling 24 h, 15 awaiting a decision, and 5 per channel per rolling 7 days. | Must | `pnpm verify:guardrails`, `tests/recommendation-rules.test.ts` | Implemented |
| FR-REC-05 | The system shall refuse duplicates (same type and channel with title Jaccard similarity ≥ 0.6 against one in play or created in the last 14 days, or rejected in the last 30 days) and mute an action + channel rejected 3 or more times in 30 days with none accepted. | Must | `pnpm verify:guardrails` | Implemented |
| FR-REC-06 | The system shall allow an optional model (tier standard, 2,000 max tokens) to reword only the template text, and fall back to the template with a flag when model output cites evidence not supplied, uses facts not in the snapshot, declares assumptions or states unsupported figures. | Must | `pnpm verify:engine`, `tests/recommendation-engine.test.ts` | Implemented |
| FR-REC-07 | The system shall cap a recommendation's confidence at its opportunity's (and at MEDIUM when flagged), never extend the opportunity's relevance window, and cap relevance at 30 days from creation. | Must | `tests/recommendations.test.ts` | Implemented |
| FR-REC-08 | The system shall mark a recommendation not executable when its confidence is LOW (until a person accepts it), its channel is not one the business uses, or a CHANNEL recommendation targets a connector that is not `available` (only LinkedIn and Instagram today). | Must | `pnpm verify:guardrails` | Implemented |
| FR-REC-09 | The system shall run 8 quality checks (schema, business_context, evidence, opportunity, actionability, expected_outcome, channel, confidence) before presentation, hide `blocked` suggestions, and show OWNER/ADMIN a "Held back by Aura's quality checks" list with a plain reason. | Must | `pnpm verify:quality`, `tests/recommendation-quality.test.ts` | Implemented |
| FR-REC-10 | The system shall rank open and accepted recommendations on every read into bands now (score ≥ 70 with current evidence, at least medium confidence and no blocker), next (≥ 40), later and hidden (snoozed), with a top-three-factor explanation. | Must | `pnpm verify:prioritization`, `tests/recommendation-ranking.test.ts` | Implemented |
| FR-REC-11 | The system shall enforce the recommendation lifecycle (GENERATED, PRESENTED, ACCEPTED, EDITED, SKIPPED, REJECTED, IN_PROGRESS, COMPLETED, WITHDRAWN, EXPIRED) with a compare-and-swap that returns 409 "Someone else updated this recommendation first" on concurrent change, and append every change to `RecommendationEvent`. | Must | `pnpm verify:lifecycle`, `tests/recommendation-lifecycle.test.ts` | Implemented |
| FR-REC-12 | The system shall restrict accept, edit, skip, reject, withdraw, status change, snooze and "Get Aura's suggestions" to `company:update` (OWNER, ADMIN), and creation from an accepted recommendation to `content:create`. | Must | `pnpm verify:recommendation-security` | Implemented |
| FR-REC-13 | The system shall allow edits only to `title`, `summary`, `action`, `steps`, `rationale`, `expectedOutcome`, `outcomeMetric`, `channel`, `contentType` and `audience`, recording only changed fields and never allowing evidence to be edited. | Must | `tests/recommendations.test.ts` | Implemented |
| FR-REC-14 | The system shall let a user defer a suggestion ("Not now") for 1–30 days (default 7), refusing with 409 when it would stop being relevant while hidden. | Should | `pnpm verify:prioritization` | Implemented |
| FR-REC-15 | The system shall auto-suggest after each detection (25 s budget) and on request (5 opportunities, 40 s budget per run), refusing when the business description/offerings or channels are unknown, honouring repeat holds (skipped 14 d, withdrawn 14 d, rejected 30 d) and withdrawing any suggestion whose quality verdict is `blocked`. | Must | `pnpm verify:autosuggest` | Implemented |
| FR-REC-16 | The system shall present each suggestion in plain language (what, why, expected outcome, "Based on" evidence, one next step) with no enum names, scores or ids, showing up to 20 per list. | Must | `pnpm verify:suggestions`, `tests/aura-suggests.test.ts` | Implemented |
| FR-REC-17 | The system shall record a suggestion as PRESENTED (idempotent, up to 100 ids per call) only for viewers holding `content:create`; VIEWER views shall not be recorded. | Should | `pnpm verify:suggestions` | Implemented |
| FR-REC-18 | The system shall route each recommendation to one of 10 Aura modules with `?rec=<id>` and pass a versioned Context Handoff (v1) whose fields each carry their source and whose content brief is capped at 2,000 characters. | Must | `pnpm verify:modules`, `pnpm verify:context-handoff`, `tests/aura-modules.test.ts` | Implemented |
| FR-REC-19 | The system shall accept an open suggestion when creation starts from it (requires `company:update` as well as `content:create`), link what was created, and move an accepted recommendation to IN_PROGRESS. | Must | `pnpm verify:creation`, `tests/recommendation-creation.test.ts` | Implemented |
| FR-REC-20 | The system shall report data readiness as `ready`, `limited` or `blocked` with the first thing to fix, across 7 scenarios (business context, channels, signals, opportunities, low confidence, connected channel, performance data). | Should | `pnpm verify:readiness`, `tests/data-readiness.test.ts` | Implemented |
| FR-REC-21 | The system shall show a suggestion history with outcome filters and learned patterns once at least 4 answers form a pattern; learning candidates shall feed Marketing Memory (as built they are computed but not yet written to it). | Could | `pnpm verify:history`, `tests/recommendation-history.test.ts` | Partially implemented |
| FR-REC-22 | The system shall scope every recommendation query to the active workspace, return 404 "Recommendation not found" for another workspace's id, and audit every engine run as `RECOMMENDATION_GENERATED`. | Must | `tests/recommendation-security.test.ts`, `pnpm verify:recommendation-security` | Implemented |
| FR-REC-23 | The system shall expire open recommendations whose `relevantUntil` has passed (lazily, before listing), leaving the opportunity unchanged. | Should | `pnpm verify:lifecycle` | Implemented |

### 3.10 Aura Home, What Matters Now & Weekly Briefing

Feature folder: [`10-aura-home-and-briefing`](feature-docs/02-features/10-aura-home-and-briefing/01-FEATURE-DETAILS.md)

The recommendation-led home page, the "What matters now" situation summary, the weekly Autopilot briefing and the daily AI Marketing Intelligence score.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-HOME-01 | The system shall render Aura Home live on every request with What matters now, Waiting on you, the top 3 suggestions, up to 4 active opportunities, Results tiles, This week and up to 8 recent-activity lines from the last 14 days. | Must | `pnpm verify:home`, `tests/aura-home.test.ts` | Implemented |
| FR-HOME-02 | The system shall isolate each Home loader so that one failing source falls back to its empty value and the rest of the page still renders. | Must | `pnpm verify:home` (simulated source outage) | Implemented |
| FR-HOME-03 | The system shall list Waiting on you items in the order posts to approve, accepted suggestions, approved posts to schedule, new leads, outreach ready to send, omitting zero counts. | Should | `tests/aura-home.test.ts` | Implemented |
| FR-HOME-04 | The system shall order active opportunities with those closing within 7 days first, then by priority score and detection date, and label deadlines up to 30 days away. | Should | `tests/aura-home.test.ts` | Implemented |
| FR-HOME-05 | The system shall build What matters now from at most 5 items: up to 3 high-relevance opportunities (HIGH/URGENT, score ≥ 60 or ≤ 7 days left) plus important signal changes from the last 14 days not covered by an opportunity, explained only from the signal's own data. | Must | `pnpm verify:what-matters`, `tests/what-matters.test.ts` | Implemented |
| FR-HOME-06 | The system shall report a What matters now state of `ready`, `limited`, `quiet` or `insufficient` and list data gaps (no trend keywords, no competitors, fewer than 2 result periods, no goals) each with an action link, without fabricating items. | Must | `pnpm verify:what-matters`, `tests/what-matters.test.ts` | Implemented |
| FR-HOME-07 | The system shall compare Results tiles with the previous period (posts and engagement this vs last 7 days; suggestions acted on as "X of Y" over 30 days) and show "—" for engagement when there is no data. | Should | `tests/aura-home.test.ts` | Implemented |
| FR-HOME-08 | The system shall let OWNER/ADMIN decide on suggestions from Home, let roles with `content:create` run the briefing, and show VIEWER all of Home read-only. | Must | Inspection (`app/dashboard/page.tsx`) | Implemented |
| FR-HOME-09 | The system shall run Autopilot once per workspace per ISO week (idempotent unless forced, `WorkspaceBriefing` unique on `(companyId, weekStart)`), writing a default 3 and at most 5 posts from the marketing plan, or from the trend digest when the plan is short. | Must | `pnpm verify:briefing`, `tests/briefing.test.ts` | Implemented |
| FR-HOME-10 | The system shall generate at most 1 graphic per Autopilot post within the plan's remaining monthly image allowance, keep the post if the image fails, and explain any shortfall in the briefing activity. | Should | `pnpm verify:briefing` | Implemented |
| FR-HOME-11 | The system shall auto-approve Autopilot posts only when `publishMode` is `auto`, a channel is connected and fewer than 5 posts were auto-approved that week, treat unknown modes as `review`, and require `content:approve` to change Autopilot settings. | Must | `tests/briefing.test.ts` | Implemented |
| FR-HOME-12 | The system shall assemble the weekly briefing without any model call, from stored data only, with per-section coverage and a reason for each empty section, and still assemble it when Autopilot is disabled or fails. | Must | `pnpm verify:briefing` | Implemented |
| FR-HOME-13 | The system shall run Autopilot for every company each Monday at 05:00 UTC via `/api/cron/briefing` (scheduled in `vercel.json`) with `Bearer $CRON_SECRET`, refusing requests when the secret is unset. | Must | Inspection (`vercel.json`) | Implemented |
| FR-HOME-14 | The system shall limit manual briefing runs (`POST /api/briefing`, `content:create`) to 2 per hour per company and return 429 when exceeded; the limiter is in-memory per server instance. | Should | Inspection (`app/api/briefing/route.ts`) | Partially implemented |
| FR-HOME-15 | The system shall compute a daily AI Marketing Intelligence snapshot (unique per company per UTC day) as a weighted mean over score blocks that have data, label setup-only scores as setup progress, and rank up to 10 suggestions by impact toward a target of 80. | Should | `tests/intelligence-priority.test.ts`, `tests/text-metrics.test.ts` | Implemented |
| FR-HOME-16 | The system shall refresh intelligence snapshots daily for every company via `/api/cron/intelligence`; the route is not scheduled in `vercel.json`, so snapshots appear only on manual or UI-triggered runs. | Could | Inspection (`vercel.json`) | Partially implemented |
| FR-HOME-17 | The system shall let users mark a briefing as read, scoped by company (`PATCH /api/briefing`); the endpoint exists but the Home UI does not call it. | Could | Inspection (`components/dashboard/briefing/briefing-view.tsx`) | Partially implemented |

### 3.11 Content Studio (Generation, Brief, Formats, Quality)

Feature folder: [`11-content-studio`](feature-docs/02-features/11-content-studio/01-FEATURE-DETAILS.md)

Writes grounded marketing copy in 9 formats from a Content Brief, trend or campaign, and runs it through deterministic quality rules, a fact check, the workspace compliance policy and an independent AI Reviewer before it can be approved.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-CNT-01 | The system shall support exactly 9 content formats (`LINKEDIN_POST`, `IMAGE_POST`, `CAROUSEL`, `TWEET_THREAD`, `BLOG`, `EMAIL`, `AD`, `CAMPAIGN_COPY`, `PROMO`), each with a Zod output schema and per-format field limits, and shall refuse with 400 a format the workspace has disabled in Settings -> Content formats. | Must | `tests/content-formats.test.ts`, `tests/format-specs.test.ts`, `tests/content-schemas.test.ts` | Implemented |
| FR-CNT-02 | The system shall build a versioned (version 1) 16-field Content Brief from an accepted recommendation, classify each field as required / recommended / optional, report readiness as `ready`, `ready_with_gaps` or `blocked`, and refuse generation with 409 when `validateContentBrief()` fails. | Must | `tests/content-brief.test.ts`, `pnpm verify:content-brief` | Implemented |
| FR-CNT-03 | The system shall require `content:create` (OWNER, ADMIN, MEMBER) to generate, edit, refine, make variations, run a review, undo or submit a draft, and return 403 otherwise. | Must | `pnpm verify:contextual-generation`, Inspection | Implemented |
| FR-CNT-04 | The system shall generate 1 to 3 versions per request (always 1 for `BLOG`), accept a source brief of up to 2,000 characters, and return 422 for a network outside the format's allowed platforms (e.g. `TWEET_THREAD` only on X; `EMAIL`, `CAMPAIGN_COPY`, `PROMO` on none). | Must | `tests/platforms.test.ts`, `pnpm verify:contextual-generation` | Implemented |
| FR-CNT-05 | The system shall return the existing draft with `reused: true` when the same user repeats a generate request with the same `idempotencyKey` (8 to 64 characters). | Should | Inspection | Implemented |
| FR-CNT-06 | The system shall return 409 when the referenced recommendation is missing, belongs to another workspace, cannot be created from, or still needs acceptance. | Must | `pnpm verify:creation` | Implemented |
| FR-CNT-07 | The system shall assemble a generation context of up to 14 sections within a 3,200-token budget (tokens estimated as characters / 4), never dropping the required `brief`, `business` and `channel` sections and dropping the rest once fewer than 60 tokens remain. | Must | `tests/generation-context.test.ts`, `pnpm verify:generation-context` | Implemented |
| FR-CNT-08 | The system shall redact secrets, tokens, connection strings, Luhn-valid card numbers and internal cuid-style ids from all model context, and off-domain email addresses and phone numbers from documents, pages and earlier posts, recording counts per kind. | Must | `tests/generation-context.test.ts` | Implemented |
| FR-CNT-09 | The system shall include only knowledge passages sharing at least two topic words and earlier posts that are `APPROVED` or `PUBLISHED` within 120 days, and store the context trace (sections, drops, redactions, snapshot revision, chunk ids) in `aiMetadata.context`. | Should | `tests/generation-context.test.ts` | Implemented |
| FR-CNT-10 | The system shall classify source material as `clear`, `caution` or `unsuitable` over 11 sensitive topics before writing, and refuse promotional formats (`PROMO`, `AD`, `CAMPAIGN_COPY`) on an `unsuitable` source with 422 `source_not_marketable` and an audited refusal. | Must | `tests/brand-safety.test.ts` | Implemented |
| FR-CNT-11 | The system shall run deterministic quality checks on every version (length against soft/hard limits, hashtags, CTA, alcohol code for alcohol businesses, never-mention topics, unsupported claims and numbers, robotic phrasing, source-tone mismatch, unconfirmed post details) and attempt exactly one repair pass for blocking issues. | Must | `tests/content-quality.test.ts` | Implemented |
| FR-CNT-12 | The system shall enforce per-network copy limits (LinkedIn 1,500 soft / 3,000 hard; Instagram 1,000 / 2,200; Facebook 600 / 5,000; X 240 / 280; thread 1,680 / 3,360) and per-format limits for blog, email, ad, campaign copy and promo. | Must | `tests/content-quality.test.ts`, `tests/format-specs.test.ts` | Implemented |
| FR-CNT-13 | The system shall never let the model write post details (website, address, phone, email); these shall be stored in `body.details`, and typed values not from the business profile shall raise `details-unconfirmed`. | Must | `tests/post-details.test.ts` | Implemented |
| FR-CNT-14 | The system shall extract claims (number, date, absolute, business, market, contact), classify each as `supported`, `contradicted`, `unsupported`, `unverified` or `outdated` (evidence older than 180 days), and recompute the fact check on every draft-page load and at approval. | Must | `tests/fact-check.test.ts`, `pnpm verify:fact-check` | Implemented |
| FR-CNT-15 | The system shall store a versioned compliance policy (packs `general`, `alcohol`, `health`, `financial`, workspace rules, channel rules, required disclaimers) in `Company.preferences.compliancePolicy`, feed it to both writer and reviewer, and allow changes or reset only with `company:update`, while any member may test copy (up to 10,000 characters) against it. | Must | `tests/compliance-policy.test.ts`, `pnpm verify:compliance` | Implemented |
| FR-CNT-16 | The system shall run an independent AI Reviewer (standard tier, 25 s timeout, 1 attempt) scoring 11 weighted dimensions 1 to 5, combine it with the rules, fact check and policy into `pass`, `review_required` or `fail` (dimension pass >= 75, fail < 50; overall pass >= 70, fail < 50), and keep the previous 5 reviews. | Must | `tests/content-review.test.ts`, `pnpm verify:review` | Implemented |
| FR-CNT-17 | The system shall treat a review as stale when the body hash or the compliance policy hash changes, re-review it before submit or approval, and place the piece in `review_required` rather than passing it when the reviewer times out or fails. | Must | `pnpm verify:review` | Implemented |
| FR-CNT-18 | The system shall offer one-click rewrites (`regenerate`, `shorten`, `expand`, `tone`, `improve`, `custom` with feedback up to 1,000 characters, `fix_review`), return the draft to `DRAFT`, keep an undo history of 5 entries, and refuse rewrites of a `PUBLISHED` draft with 409. | Must | Inspection | Implemented |
| FR-CNT-19 | The system shall create variations (`shorter`, `longer`, `tone`, `cta`, `headline`, `channel`, `image`), keep at most 8 versions per draft without dropping the active one, flag `facts-changed` when a variation introduces a number, price, date, link, email or handle absent from the original and brief after one correction pass, and flag `topic-drift` below a 0.3 topic overlap. | Must | `tests/content-variations.test.ts`, `pnpm verify:variations`, `pnpm verify:content-control` | Implemented |
| FR-CNT-20 | The system shall rate-limit variation, rewrite, more-versions and CTA-option routes to 20 per minute per user and per-version edit and revert routes to 60 per minute per user. | Should | Inspection | Implemented |
| FR-CNT-21 | The system shall reject concurrent modifications using an `updatedAt` / `baseUpdatedAt` guard, returning 409 `concurrent_change` or `stale`. | Must | Inspection | Implemented |
| FR-CNT-22 | The system shall return 503 with "Add GEMINI_API_KEY (or ANTHROPIC_API_KEY)" when no AI provider is configured, and audit `CONTENT_DRAFT_CREATED` for every created draft. | Must | Inspection | Implemented |
| FR-CNT-23 | The system shall treat `EMAIL`, `AD`, `CAMPAIGN_COPY` and `PROMO` as copy-only formats that are never scheduled or published to a network. | Must | `tests/content-formats.test.ts` | Implemented |
| FR-CNT-24 | The system shall show drafts on a status board (latest 200), a monthly calendar (`?month=YYYY-MM`), and an empty state explaining that nothing publishes until approved. | Should | `pnpm verify:content-studio`, Demonstration | Implemented |

### 3.12 Media, Graphics & Marketing Creatives

Feature folder: [`12-media-graphics-and-creatives`](feature-docs/02-features/12-media-graphics-and-creatives/01-FEATURE-DETAILS.md)

Writes image prompts, generates, refines and versions images across six providers, places the uploaded logo, composes branded creatives, ingests uploads, stores media durably and validates it per network.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-MED-01 | The system shall write an image prompt (60 to 200 words) and negative prompt from the post, visual brief and brand when an LLM is configured, and fall back to a deterministic heuristic prompt (`source: 'heuristic'`) when it is not or the call fails. | Must | `tests/image-prompt.test.ts`, `pnpm verify:visual-context` | Implemented |
| FR-MED-02 | The system shall derive a visual brief with readiness `not_needed`, `blocked` (missing subject), `ready_with_gaps` or `ready`, and list each missing item with a fix link. | Should | `tests/visual-brief.test.ts`, `pnpm verify:visual-context` | Implemented |
| FR-MED-03 | The system shall generate images through a configured provider (OpenAI, Google, Agnes, Hugging Face, Stability, Replicate), never silently substituting an explicitly chosen provider (400 if unknown, 503 if unconfigured), and return 503 `NoImageProviderError` when none is configured. | Must | `tests/image-providers.test.ts`, `tests/image-provider-registry-sync.test.ts`, `tests/gemini-image-provider.test.ts` | Implemented |
| FR-MED-04 | The system shall generate 1 to 4 variations per request, clamped to the plan's per-request cap (2 Trial/Starter, 4 Growth/Agency) and remaining monthly allowance (20 / 100 / 500 / 4,000), returning 402 when the allowance is exhausted. | Must | `tests/image-generation.test.ts` | Implemented |
| FR-MED-05 | The system shall require `content:create` for every mutating media route (403 for VIEWER) and rate-limit generate, variant and creative requests to 6 per minute per user, prompt, upload and render to 20 per minute, and free-text generation to 10 per minute. | Must | `pnpm verify:creative`, Inspection | Implemented |
| FR-MED-06 | The system shall run generation, new-photo creatives, refine, regenerate and make-space as resumable `IMAGE_GENERATION` jobs (max 3 attempts, stuck after 3 minutes), deduplicated per draft (200 `reused` for the same input, 409 for a different input in flight), generating only the shortfall on retry. | Must | `tests/image-generation.test.ts`, `tests/job-dedupe.test.ts`, `tests/job-permanent-failure.test.ts` | Implemented |
| FR-MED-07 | The system shall map a requested aspect ratio (1:1, 4:5, 16:9, 9:16 or custom 256 to 4,096 px) to the nearest provider-supported ratio and report any substitution. | Should | `tests/image-aspect.test.ts` | Implemented |
| FR-MED-08 | The system shall validate stored images by magic bytes (PNG, JPEG, WEBP only), reject files over 12 MB or a longest edge over 4,096 px, and store bytes in Postgres by default or in an S3-compatible bucket when configured, falling back to the database if the bucket upload fails. | Must | `tests/media-validate.test.ts`, `tests/media-storage.test.ts`, `pnpm verify:graphics` | Implemented |
| FR-MED-09 | The system shall accept multipart uploads up to 4,000,000 bytes and URL imports (image <= 15 MB, video <= 100 MB), refusing non-http(s) URLs and private or link-local hosts, re-checking each of at most 3 redirects. | Must | `tests/media-upload.test.ts` | Implemented |
| FR-MED-10 | The system shall accept video (MP4/MOV, codec avc1/avc3/hvc1/hev1) only when an S3 bucket is configured, returning 409 otherwise, and publish video to Instagram only (<= 300 MB, 3 s to 15 min). | Should | `tests/media-upload.test.ts`, `tests/media-validate.test.ts` | Partially implemented |
| FR-MED-11 | The system shall store refine, regenerate and logo results as new versions of a variant (lineage in `GeneratedAsset.metadata`) and never overwrite an image; refine shall require an edit-capable provider (Gemini image model or `gpt-image-1`), else 503. | Must | `tests/image-variants.test.ts` | Implemented |
| FR-MED-12 | The system shall composite the uploaded logo file (never AI-drawn) inside a box of 20% width x 12% height with a 4.5% margin, tints original / white / black / brand, refusing placement when the logo would be under 24 px or when the logo is only a URL. | Must | `tests/logo-overlay.test.ts` | Implemented |
| FR-MED-13 | The system shall compose branded creatives in 10 types, 6 layouts, 4 sizes (1080x1080, 1080x1350, 1080x1920, 1920x1080) and 4 bundled font pairings, use user-typed text exactly, drop figures or event details not backed by the user, post, evidence or business facts, refuse an unfittable headline with 422, and fall back to a brand-colour background when no photo can be made. | Must | `tests/creative.test.ts`, `pnpm verify:creative` | Implemented |
| FR-MED-14 | The system shall serve asset bytes only to members of the asset's own company or to a valid HMAC-SHA256 signed URL (15-minute default TTL, constant-time comparison), returning 404 otherwise, and re-encode to JPEG on `?format=jpeg`. | Must | `tests/asset-url.test.ts`, `tests/instagram-media.test.ts` | Implemented |
| FR-MED-15 | The system shall validate attached media per platform (MIME, max size, min/max edge per `PLATFORM_SPECS`), require at least one item for Instagram and at most 10 carousel items. | Must | `tests/media-validate.test.ts`, `tests/publish-media.test.ts` | Implemented |
| FR-MED-16 | The system shall refuse attach, detach, upload, refine or regenerate on a `PUBLISHED` draft and deletion of an asset used by a published post with 409, and shall reopen approval when media on approved work changes. | Must | `pnpm verify:approval`, `pnpm verify:creative` | Implemented |
| FR-MED-17 | The system shall provide a free-text image generator (prompt 1 to 2,000 characters; Hugging Face, Google or Agnes) that returns a `data:` URI and does not persist an asset. | Could | Demonstration | Implemented |

### 3.13 Review, Approval, Versions & Traceability

Feature folder: [`13-review-approval-versions-and-trace`](feature-docs/02-features/13-review-approval-versions-and-trace/01-FEATURE-DETAILS.md)

The human-in-the-loop gate: one review queue and screen for content drafts and outreach messages, a fingerprint-bound approval model, numbered versions and the trace from Business Context to the approved version.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-REV-01 | The system shall present a review queue of `ContentDraft` and `OutreachMessage` items in `DRAFT` or `PENDING_APPROVAL` (100 most recent of each), filterable by Everything / Content / Outreach, sorted with `in_review` first, with a 140-character snippet and an empty state "Nothing waiting for review". | Must | `pnpm verify:unified-review` | Implemented |
| FR-REV-02 | The system shall render one review screen for both kinds (`content`, `outreach`) with editable fields, attached images, quality flags (Must fix / Check / Note), reviewer feedback, context, trace, approval and versions, and return 404 for any other kind or an item outside the active workspace. | Must | `tests/review-item.test.ts`, `pnpm verify:unified-review` | Implemented |
| FR-REV-03 | The system shall always show the full action set (Back, Edit, Save, Regenerate, Submit for approval, Reject, Schedule, Approve) and disable an unavailable action with an actionable reason. | Should | `tests/review-item.test.ts` | Implemented |
| FR-REV-04 | The system shall restrict content approve/reject to `content:approve` (OWNER, ADMIN), content edit/save/regenerate/submit/restore to `content:create`, scheduling to `content:publish`, and all outreach mutations to `content:approve`, re-checking the role on the server for every action. | Must | `pnpm verify:unified-review`, `pnpm verify:approval` | Implemented |
| FR-REV-05 | The system shall enforce the content state machine `DRAFT -> PENDING_APPROVAL \| REJECTED`, `PENDING_APPROVAL -> APPROVED \| REJECTED \| DRAFT`, `APPROVED -> PUBLISHED \| DRAFT \| REJECTED`, `REJECTED -> DRAFT`, with `PUBLISHED` terminal and reachable only from `APPROVED`. | Must | `tests/approval-state-machine.test.ts` | Implemented |
| FR-REV-06 | The system shall refuse submit and approval of a draft with a failed AI review (409 `review_failed`) and approval of a `review_required` draft without acknowledgement (409 `review_needs_human`). | Must | `pnpm verify:review` | Implemented |
| FR-REV-07 | The system shall refuse approval when any quality issue has severity `block`, a claim is contradicted (409 `facts_contradicted`) or must-fix (409 `facts_must_fix`), or the fact check needs review without confirmation (409 `facts_need_review`). | Must | `pnpm verify:fact-check`, `pnpm verify:approval` | Implemented |
| FR-REV-08 | The system shall perform status changes with a conditional update on `status` and `updatedAt` so that concurrent approvals or an edit during review fail with 409 `concurrent_change`, and refuse a stale save (409 `stale`) while keeping the edits in the browser. | Must | `pnpm verify:unified-review` | Implemented |
| FR-REV-09 | The system shall persist unsaved review edits in browser storage per item, restore them after reload, warn before leaving with unsaved edits, and disable Approve, Regenerate, Submit and Schedule until edits are saved or discarded. | Should | `tests/review-item.test.ts`, Demonstration | Implemented |
| FR-REV-10 | The system shall derive a unified approval state (`draft`, `generated`, `review_required`, `approved`, `rejected`, `scheduled`, `ready_for_execution`, `executed`) from the existing status columns, with `approved -> draft` as the only recorded way out of approved work and no exit from `executed`. | Must | `tests/approval.test.ts` | Implemented |
| FR-REV-11 | The system shall bind every approval to a 16-hex-character FNV-1a fingerprint of body, platform and ordered media, store the approved snapshot, approver (`person` or `autopilot`) and version, and keep up to 60 events (content snapshots on the newest 15). | Must | `tests/approval.test.ts`, `pnpm verify:approval` | Implemented |
| FR-REV-12 | The system shall refuse publishing, scheduling, mark-posted and extension execution of content whose fingerprint differs from the approved one with 409 `changed_after_approval`, and skip non-intact outreach in the extension queue. | Must | `pnpm verify:approval` | Implemented |
| FR-REV-13 | The system shall return approved or pending content to `DRAFT` and record the previous content when an edit, regeneration, image swap or network change alters its fingerprint, and record nothing when the fingerprint is unchanged. | Must | `tests/approval.test.ts`, `pnpm verify:approval` | Implemented |
| FR-REV-14 | The system shall keep a numbered version log per item (sources `generated`, `edited`, `regenerated`, `variation`, `undo`, `restored`), add no version for identical content, and cap it at 50 versions without dropping v1, the current or the approved version. | Must | `tests/versions.test.ts`, `pnpm verify:versions` | Implemented |
| FR-REV-15 | The system shall restore a version by adding it as a new version (never overwriting), returning 409 for the current version and 404 for a non-existent one. | Must | `tests/versions.test.ts`, `pnpm verify:versions` | Implemented |
| FR-REV-16 | The system shall record trace ids on each content draft (business-context revision, signals, opportunity, recommendation, brief, generated, reviewed and approved versions, media asset ids) at generation, each review and each approval, and resolve the chain with gaps reported when linked records are deleted. | Must | `tests/trace.test.ts`, `pnpm verify:trace` | Implemented |
| FR-REV-17 | The system shall expose flat trace rows for approved or published drafts (default 200, max 500) and include trace ids in approval and publish audit entries. | Should | `tests/trace.test.ts`, `pnpm verify:trace` | Implemented |
| FR-REV-18 | The system shall schedule only approved, non-copy-only content from the review screen given a workspace-zone local time or an ISO instant, and always refuse scheduling of outreach (409). | Must | `pnpm verify:unified-review` | Implemented |
| FR-REV-19 | The system shall write an audit entry for each status change carrying the approval action, version, hash, request IP and user agent. | Must | `pnpm verify:approval`, Inspection | Implemented |
| FR-REV-20 | The system shall sync linked campaign tasks (`GENERATED` <-> `APPROVED`) when a draft enters or leaves `APPROVED` / `PUBLISHED`, and attribute Autopilot approvals as `via: 'autopilot'`. | Should | `tests/approval.test.ts` | Implemented |
| FR-REV-21 | The system shall keep traceability ids for outreach messages. | Could | Inspection | Not implemented |

### 3.14 Campaigns & Content Planner

Feature folder: [`14-campaigns-and-content-planner`](feature-docs/02-features/14-campaigns-and-content-planner/01-FEATURE-DETAILS.md)

Turns a stated goal into an orchestrated campaign of scheduled tasks, or a monthly brief into a dated content calendar; every output lands as a draft for human approval.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-CPN-01 | The system shall create an orchestrated campaign through `POST /api/campaigns/orchestrate` only for users holding `content:approve` (OWNER, ADMIN), validating `name` 2–120 chars, `goal` 4–2,000 chars, `durationDays` 3–60 (default 30) and up to 20 themes of 1–80 chars. | Must | `tests/campaign-plan.test.ts` | Implemented |
| FR-CPN-02 | The system shall refuse campaign creation when the workspace already holds its plan's `maxActiveCampaigns` in `DRAFT`, `ACTIVE` or `PAUSED` (TRIAL 1, STARTER 2, GROWTH 10, AGENCY 100) or when its trial/subscription has ended. | Must | `tests/billing.test.ts` | Implemented |
| FR-CPN-03 | The system shall generate a day-by-day campaign plan with one Zod-validated AI call (`campaignPlanSchema`, max 4,000 tokens), drop days outside 1..`durationDays`, clear actions for modules that are not enabled, and fall back to a deterministic plan when no AI provider is configured or the call fails. | Must | `tests/campaign-plan.test.ts` | Implemented |
| FR-CPN-04 | The system shall materialise the plan as `CampaignTask` rows (`GENERATE_CONTENT`, `RUN_OUTREACH_BATCH`, `RUN_DISCOVERY`) scheduled at start + (day − 1), plus a `REVIEW_CHECKPOINT` task every 7 days, and audit `CAMPAIGN_CREATED` and `CAMPAIGN_PLAN_GENERATED`. | Must | Inspection | Implemented |
| FR-CPN-05 | The system shall save a campaign planned from a recommendation as `DRAFT` ("Planned"), refuse to execute, start or resume it (409 `execution_not_available`) while `CONTEXTUAL_EXECUTION_ENABLED = false`, and return 409 with a `fix` link when the recommendation cannot be turned into a campaign. | Must | `tests/creation-handoff-server.test.ts`, `pnpm verify:creation`, `pnpm verify:sprint9` | Implemented |
| FR-CPN-06 | The system shall execute due `PENDING` tasks on `ACTIVE` campaigns in batches of at most 100 per run, attributing work to the company OWNER, drafting outreach for at most 3 `NEW`/`QUALIFIED` leads per batch task, and marking tasks with no input `SKIPPED`. | Must | Inspection | Implemented |
| FR-CPN-07 | The system shall run the campaign executor daily through `/api/cron/campaigns` authorised by `Authorization: Bearer $CRON_SECRET`. | Must | Inspection | Partially implemented |
| FR-CPN-08 | The system shall mark a task whose execution throws as `FAILED` (first 500 chars of the error stored, `CAMPAIGN_TASK_FAILED` audited) and continue with the remaining tasks, and shall mark an `ACTIVE` campaign `COMPLETED` once it has tasks and none are `PENDING`. | Must | Inspection | Implemented |
| FR-CPN-09 | The system shall never publish or send anything from a campaign; executor output shall be `ContentDraft` / `OutreachMessage` drafts, and a linked task shall move `GENERATED` → `APPROVED` when its draft is approved or published and back when it leaves those states. | Must | `pnpm verify:approval` | Implemented |
| FR-CPN-10 | The system shall let `content:approve` holders pause and resume a campaign (`POST /api/campaigns/:id/status`), scoped by company (404 for another workspace), auditing `CAMPAIGN_PAUSED` / `CAMPAIGN_RESUMED`. | Should | `tests/tenant-isolation.test.ts` | Implemented |
| FR-CPN-11 | The system shall display a derived campaign state (Needs review, Behind, Running, Paused, Finished, Planned / Not started, Archived) and progress as done / total tasks, never the raw status enum. | Should | `tests/campaign-status.test.ts` | Implemented |
| FR-CPN-12 | The system shall generate a monthly content plan for `content:create` holders from a brief validated by `planInputsSchema` (business goals 10–1,500 chars, objectives 5–1,500, 1–6 channels from LinkedIn, Blog, Newsletter, X, Instagram, YouTube, 1–14 posts per week) on weekday slots only. | Must | `tests/planner-schedule.test.ts` | Implemented |
| FR-CPN-13 | The system shall draft the calendar within a 45 s budget (15 s strategy call, weeks in parallel, no call started with under 5 s left), fill any undelivered week or strategy from a deterministic outline and record which parts fell back. | Must | `tests/planner-draft.test.ts`, `pnpm verify:planner` | Implemented |
| FR-CPN-14 | The system shall store one `MarketingPlan` per company per month (regeneration replaces it), audit `MARKETING_PLAN_GENERATED`, treat a `MARKETING_PLAN` job as stuck after 2 minutes, and list the last 12 months. | Should | `tests/planner-draft.test.ts` | Implemented |
| FR-CPN-15 | The system shall let a user open any calendar item in Content Studio with one click ("Draft this") pre-filled with its type and brief. | Should | `pnpm verify:pages` | Implemented |

### 3.15 Lead Discovery & Outreach Intelligence

Feature folder: [`15-leads-and-outreach`](feature-docs/02-features/15-leads-and-outreach/01-FEATURE-DETAILS.md)

Finds and scores companies and people worth contacting from public sources and drafts brand-voice LinkedIn outreach that a human approves and sends by hand.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-LEAD-01 | The system shall detect leads from enabled public sources (GitHub, news, jobs, Crunchbase; default `{ crunchbase: false, github: true, jobs: true, news: true }`) matched against the workspace `OutreachConfig`, deduplicated by signal type and lowercased company, creating one `Lead` per company with attached `LeadSignal` rows. | Must | `tests/outreach-matching.test.ts` | Implemented |
| FR-LEAD-02 | The system shall run a discovery profile against GitHub, Crunchbase, Google Custom Search and robots.txt-gated company team pages (first 8 companies with a website, up to 8,000 chars of text), and create at most 25 new leads per run. | Must | Inspection | Implemented |
| FR-LEAD-03 | The system shall deduplicate discovery candidates within a run and against existing leads, treating companies as the same when normalised names match or token Jaccard ≥ 0.6 (legal suffixes stripped) and people when names match, are a ≥ 2-token subset or Jaccard ≥ 0.7. | Must | `tests/lead-dedup.test.ts` | Implemented |
| FR-LEAD-04 | The system shall score each new lead 0–100 with matched and missed criteria, using a cheap-tier AI call or, when AI is unavailable or fails, a deterministic weighting (industry 30, role 25, keyword 20, stage 15, geography 10; exactly 50 with no criteria). | Must | `tests/lead-scoring.test.ts` | Implemented |
| FR-LEAD-05 | The system shall extract only explicitly named people from team pages and return none, rather than guessing, when no AI provider is configured; no LinkedIn page or API shall be read. | Must | Inspection | Implemented |
| FR-LEAD-06 | The system shall show a pre-run estimate per profile (sources that will run, expected results, AI calls and tokens, warnings when Crunchbase or Custom Search is not connected) and record each run as a `DiscoveryRun` (`COMPLETED` or `FAILED`). | Should | Inspection | Implemented |
| FR-LEAD-07 | The system shall limit discovery runs per month by plan (Trial 10, Starter 25, Growth 150, Agency 2,000) for manual runs. | Must | `tests/billing.test.ts` | Implemented |
| FR-LEAD-08 | The system shall run weekly auto-run discovery (`/api/cron/discovery`) and daily signal detection (`/api/cron/outreach`) under `CRON_SECRET` bearer auth. | Should | Inspection | Partially implemented |
| FR-LEAD-09 | The system shall draft a `CONNECTION_NOTE` clipped to 300 characters and a `FOLLOWUP` per lead, grounded in the newest signal, 4 knowledge-base chunks and the brand voice, falling back to a deterministic template when AI is unavailable. | Must | Inspection | Implemented |
| FR-LEAD-10 | The system shall enforce the outreach state machine (`DRAFT` → `PENDING_APPROVAL`/`APPROVED`/`REJECTED`; `SENT` final), returning 409 `duplicate` for repeated actions and 409 `concurrent_change` on a concurrent status change. | Must | `pnpm verify:approval` | Implemented |
| FR-LEAD-11 | The system shall block approval (409 `outreach_checks_failed`) of a message that is empty, a connection note over 300 chars, contains a placeholder such as `[name]` or `{{…}}`, or fails a workspace compliance rule. | Must | `pnpm verify:approval` | Implemented |
| FR-LEAD-12 | The system shall offer one-click bulk approval only for drafts with a confidence score ≥ 70 (caps for missing signal, contact, fit, LinkedIn URL or placeholders) and process at most 100 messages per bulk request, each through the normal transition. | Should | `tests/outreach-confidence.test.ts` | Implemented |
| FR-LEAD-13 | The system shall require `content:approve` (OWNER, ADMIN) for every lead and outreach write or AI-spending action and `company:update` for targeting settings, while MEMBER and VIEWER may only read. | Must | `pnpm verify:permissions` | Implemented |
| FR-LEAD-14 | The system shall move a message to `SENT` (lead → `CONTACTED`, `OUTREACH_SENT` audited) only after approval and a human "Mark as sent" in the extension, and shall return an edited message to `DRAFT` with a new version. | Must | `tests/extension-permissions.test.ts`, `pnpm verify:versions` | Implemented |
| FR-LEAD-15 | The system shall keep recommendation-drafted outreach (up to 5 leads per suggestion) out of the extension queue while `CONTEXTUAL_EXECUTION_ENABLED = false`. | Must | `pnpm verify:creation` | Implemented |

### 3.16 Engagement Copilot

Feature folder: [`16-engagement-copilot`](feature-docs/02-features/16-engagement-copilot/01-FEATURE-DETAILS.md)

Drafts a brand-voice comment for the LinkedIn post the user is viewing, inside the Chrome extension, for the user to insert and post themselves.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-ENG-01 | The system shall read the visible LinkedIn post nearest the viewport centre client-side (up to 5,000 chars) and send only that text, author and URL to `POST /api/extension/engagement/draft`; the server shall never fetch LinkedIn content. | Must | Inspection | Implemented |
| FR-ENG-02 | The system shall validate the draft request (`postUrl` a URL, `postText` 1–6,000 chars, `author` ≤ 160 chars) and authorise it with an extension bearer token whose holder has `content:create`, returning 403 otherwise. | Must | Inspection | Implemented |
| FR-ENG-03 | The system shall draft a 1–3 sentence comment of at most 1,200 chars grounded in Business Context (`engagement` preset) and brand voice, with no hashtags, self-promotion or "Great post!". | Must | Demonstration | Implemented |
| FR-ENG-04 | The system shall fall back to a deterministic comment quoting the post's first sentence (≤ 80 chars) when no AI provider is configured or the call fails. | Should | Inspection | Implemented |
| FR-ENG-05 | The system shall store each draft as `EngagementComment(DRAFT)` with at most 2,000 chars of post excerpt and audit `ENGAGEMENT_COMMENT_DRAFTED`. | Must | Inspection | Implemented |
| FR-ENG-06 | The system shall insert the draft into LinkedIn's open comment editor, or copy it to the clipboard when none is open, and never click LinkedIn's post button. | Must | Demonstration | Implemented |
| FR-ENG-07 | The system shall mark a comment `POSTED` (idempotent) only for a `content:approve` holder and only within the extension caps (client 8/hour and 25/day; server 25/day, 429 beyond). | Must | `tests/extension-permissions.test.ts` | Implemented |
| FR-ENG-08 | The system shall let `company:update` holders add, relabel (upsert on company + URL) and remove engagement targets (label ≤ 120, URL ≤ 300 chars, normalised to `https://`), auditing `ENGAGEMENT_TARGET_ADDED` / `ENGAGEMENT_TARGET_REMOVED`. | Should | Inspection | Implemented |
| FR-ENG-09 | The system shall show the 50 most recent comments with status, author, excerpt and link on `/dashboard/engagement`, with a "No comments yet" empty state. | Should | `pnpm verify:pages` | Implemented |
| FR-ENG-10 | The system shall scope comment and target operations by the token's or session's `companyId` so another workspace's id is not found. | Must | `tests/extension-permissions.test.ts` | Implemented |
| FR-ENG-11 | The system shall use engagement targets in the extension to monitor the listed profiles. | Could | Inspection | Not implemented |
| FR-ENG-12 | The system shall let a user discard an unposted comment draft (status `DISCARDED`). | Could | Inspection | Not implemented |

### 3.17 Chrome Extension (Human Action Layer)

Feature folder: [`17-chrome-extension`](feature-docs/02-features/17-chrome-extension/01-FEATURE-DETAILS.md)

A Manifest V3 extension that inserts approved posts and outreach into LinkedIn's own composer for a human to send, then syncs status back to Aura.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-EXT-01 | The system shall issue extension tokens prefixed `aura_ext_` with 32 random bytes, store only their SHA-256 hash, expire them after 180 days, return the raw value once and audit `EXTENSION_TOKEN_ISSUED`. | Must | `tests/extension-token.test.ts` | Implemented |
| FR-EXT-02 | The system shall reject a bearer token with a missing prefix, unknown hash, revocation or past expiry, and shall re-read the user's membership on every request, returning 401 when it no longer exists. | Must | `tests/extension-token.test.ts` | Implemented |
| FR-EXT-03 | The system shall restrict token issuance to users with `linkedin:connect` (OWNER, ADMIN). | Should | Inspection | Partially implemented |
| FR-EXT-04 | The system shall let a user revoke only their own tokens and audit `EXTENSION_TOKEN_REVOKED`. | Must | Inspection | Implemented |
| FR-EXT-05 | The system shall pair the extension by accepting the token only from a same-window, same-origin `postMessage` with `source: 'botella-aura'` and `type: 'AURA_EXT_TOKEN'`, or by pasting it in the popup. | Must | Demonstration | Implemented |
| FR-EXT-06 | The system shall build the queue on each panel open from up to 50 `APPROVED` content drafts and 50 `APPROVED` outreach messages, excluding items changed since approval and outreach held by the execution gate. | Must | `pnpm verify:approval` | Implemented |
| FR-EXT-07 | The system shall insert the exact approved text (and image, where present) into LinkedIn's composer, fall back to the clipboard when no composer is open, and never click LinkedIn's submit button or run on a timer. | Must | Demonstration | Implemented |
| FR-EXT-08 | The system shall record a human action through `POST /api/extension/actions/complete` with per-type permission: `content:publish` for `content_draft` (→ `PUBLISHED`), `content:approve` for `outreach_message` (→ `SENT`) and `engagement_comment` (→ `POSTED`), idempotently, auditing `EXTENSION_ACTION_COMPLETED`. | Must | `tests/extension-permissions.test.ts` | Implemented |
| FR-EXT-09 | The system shall cap human actions at 8 per hour and 25 per day in the client and 25 per day on the server (429 at the cap). | Must | Inspection | Implemented |
| FR-EXT-10 | The system shall scope every extension lookup by the token's `companyId`, returning 404 for another workspace's item. | Must | `tests/extension-permissions.test.ts` | Implemented |
| FR-EXT-11 | The system shall serve queued media as base64 JSON from company-scoped assets and refuse videos with 422. | Should | Inspection | Implemented |
| FR-EXT-12 | The system shall accept metrics read from the user's own post page (`content:create`) and record them as `EXTENSION_DOM` performance snapshots. | Should | Inspection | Implemented |
| FR-EXT-13 | The system shall allow CORS from `chrome-extension://` / `moz-extension://` origins (or the pinned `EXTENSION_ALLOWED_ORIGIN`) with bearer-only auth, methods `GET, POST, OPTIONS` and max-age 86,400 s. | Must | Inspection | Implemented |
| FR-EXT-14 | The system shall package the extension into `public/downloads/botella-aura-extension.zip` at every build so each deploy serves an installable unpacked build. | Should | Inspection | Implemented |

### 3.18 Marketing Memory & Analytics

Feature folder: [`18-marketing-memory-and-analytics`](feature-docs/02-features/18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md)

Stores real performance numbers, shows them as Results, and turns them into data-backed "What works for you" patterns fed back into generation.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-MEM-01 | The system shall store performance readings as `PerformanceSnapshot` rows with source `EXTENSION_DOM`, `MANUAL` or `META_API`. | Must | Inspection | Implemented |
| FR-MEM-02 | The system shall attach an extension metric sync to the published draft with the same `publishedUrl`, else to the latest published draft from the last 14 days with no snapshots, else store it unattached. | Should | Inspection | Implemented |
| FR-MEM-03 | The system shall accept manual results from `content:approve` holders as non-negative integers (impressions ≤ 100,000,000; likes, comments, shares, clicks ≤ 10,000,000; followers ≤ 1,000,000,000), at least one required, checking draft ownership (404 otherwise). | Must | Inspection | Implemented |
| FR-MEM-04 | The system shall compute engagement as likes + comments×3 + reposts×4 + clicks×2. | Must | `tests/marketing-memory.test.ts` | Implemented |
| FR-MEM-05 | The system shall produce no insight below 10 measured published posts, storing instead a single "not enough data" note with the current count. | Must | `tests/marketing-memory.test.ts` | Implemented |
| FR-MEM-06 | The system shall assign insight confidence by sample size: HIGH ≥ 30, MEDIUM ≥ 15, otherwise LOW. | Must | `tests/marketing-memory.test.ts` | Implemented |
| FR-MEM-07 | The system shall extract up to 8 Zod-validated insights with an AI call and, when AI is unavailable or fails, emit deterministic format, length and timing insights only when the gap exceeds 1.25× (format, timing) or 20% (length) with at least 2 posts per bucket. | Must | `tests/marketing-memory.test.ts` | Implemented |
| FR-MEM-08 | The system shall let `content:approve` holders correct an insight (3–600 chars, marked `editedByUser`, context snapshot invalidated) or dismiss it as a soft delete, scoped to the workspace. | Should | Inspection | Implemented |
| FR-MEM-09 | The system shall feed up to 12 non-stale (≤ 60 days) active insights into content, planning, advisor, outreach, opportunity and recommendation prompts, user-edited first. | Must | `tests/business-context-service.test.ts` | Implemented |
| FR-MEM-10 | The system shall show Results for 7, 30 (default) or 90 days with seven top-line counts, an engagement trend, an outreach funnel (Sent → Connected → Replied) and a by-content-type breakdown, with an empty state when there is no data. | Must | `pnpm verify:pages` | Implemented |
| FR-MEM-11 | The system shall generate a weekly written report from the trailing 7 days, stored once per ISO week (upsert), using only the given numbers and falling back to a facts sentence. | Should | Inspection | Implemented |
| FR-MEM-12 | The system shall run memory extraction and the weekly report for every company through `/api/cron/memory` and `/api/cron/analytics` under `CRON_SECRET` bearer auth. | Should | Inspection | Partially implemented |
| FR-MEM-13 | The system shall let `content:approve` holders record `connectionAccepted` / `replyReceived` on a company-scoped outreach message, auditing `OUTREACH_OUTCOME_UPDATED`. | Should | Inspection | Implemented |
| FR-MEM-14 | The system shall export flat traceability rows per approved or published asset via `GET /api/analytics/traces` with `limit` 1–500. | Could | Inspection | Implemented |

### 3.19 Connections, Connectors & OAuth

Feature folder: [`19-connections-and-connectors`](feature-docs/02-features/19-connections-and-connectors/01-FEATURE-DETAILS.md)

Links a workspace to Meta, LinkedIn, Google, HubSpot, Mailchimp, Slack and API-key sources, storing encrypted credentials, granted scopes, health and capabilities that gate execution.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-CONN-01 | The system shall offer 10 available connectors (`meta`, `linkedin`, `ga4`, `search-console`, `hubspot`, `mailchimp`, `slack`, `crunchbase`, `google-cse`, `github`) and list 16 `coming_soon` connectors with no integration. | Must | `pnpm verify:connections` | Implemented |
| FR-CONN-02 | The system shall allow only `company:update` holders (OWNER, ADMIN) to connect, test, disconnect, select an account and confirm a connector, and only `linkedin:connect` holders to connect LinkedIn; any member may view. | Must | `tests/connection-manager.test.ts` | Implemented |
| FR-CONN-03 | The system shall refuse to start OAuth with 409 when the deployment is missing the provider's client id/secret or preflight finds a blocker (non-public app URL, wrong redirect URI), naming the problem. | Must | `tests/connector-redirect.test.ts` | Implemented |
| FR-CONN-04 | The system shall protect every OAuth flow with a signed state (HMAC with `NEXTAUTH_SECRET`, 10-minute TTL), a single-use encrypted httpOnly binding cookie (10 minutes) with PKCE verifier, and a callback check that the same user still holds `company:update`. | Must | `tests/oauth-pkce.test.ts`, `tests/meta-login.test.ts` | Implemented |
| FR-CONN-05 | The system shall encrypt access tokens, refresh tokens and API keys with AES-256-GCM (`ENCRYPTION_KEY`) and never return any `*Enc` field to the browser. | Must | `tests/connection-manager.test.ts` | Implemented |
| FR-CONN-06 | The system shall verify an API key with the provider before storing it and resolve credentials from the workspace connection first, falling back to the deployment env var, skipping undecryptable keys without throwing. | Must | Inspection | Implemented |
| FR-CONN-07 | The system shall exchange Meta's short-lived user token for a long-lived (~60-day) token, list the Pages with their linked Instagram accounts, and fail with `no_accounts` when the user manages no Pages. | Must | `tests/meta.test.ts`, `pnpm verify:meta` | Implemented |
| FR-CONN-08 | The system shall require account selection and confirmation (no missing core scopes, live health check) before a publishing connection reaches `CONFIRMED`, re-checking a chosen Meta Page live with Meta. | Must | `tests/connection-manager.test.ts` | Implemented |
| FR-CONN-09 | The system shall make a capability available only when the provider supports it on that channel, its scopes were granted, and health is `CONNECTED`, `HEALTHY` or `WARNING`. | Must | `tests/connection-manager.test.ts` | Implemented |
| FR-CONN-10 | The system shall warn 10 days before a non-refreshable token expires, mark a connection `ACTION_REQUIRED` after 3 consecutive failures or at once on a credential rejection (Meta code 190 or HTTP 401), and allow only a live check or reconnect to clear a blocking status. | Must | `tests/connection-manager.test.ts` | Implemented |
| FR-CONN-11 | The system shall run a daily connection sweep (`/api/cron/connections`, `0 6 * * *`, 50 per pass) that refreshes refreshable tokens expiring within 24 h and live-checks connections not checked for 6 h. | Should | `pnpm verify:connections` | Implemented |
| FR-CONN-12 | The system shall revoke credentials at the provider on disconnect (best effort; Meta `DELETE /me/permissions`, Google revoke, LinkedIn revoke) and audit `CONNECTOR_DISCONNECTED`. | Must | Inspection | Implemented |
| FR-CONN-13 | The system shall handle Meta deauthorize and data-deletion callbacks authenticated by `signed_request` HMAC (max age 15 minutes, 503 when the secret is unset), clearing tokens or deleting the user's Meta connections and returning a status URL with a 16-hex confirmation code. | Must | `tests/meta.test.ts` | Implemented |
| FR-CONN-14 | The system shall honour Graph base-URL overrides only for loopback hosts, otherwise using `https://graph.facebook.com` (Graph `v23.0`). | Must | `tests/graph-base.test.ts`, `pnpm verify:sandbox` | Implemented |
| FR-CONN-15 | The system shall collect Meta organic insights for posts from the last 30 days (each at most every 6 h, 50 per run), reading impressions/reach/saves only when `read_insights` / `instagram_manage_insights` were granted. | Should | `tests/meta-insights.test.ts` | Blocked (external) |

### 3.20 Publishing, Execution Engine & Scheduling

Feature folder: [`20-publishing-execution-and-scheduling`](feature-docs/02-features/20-publishing-execution-and-scheduling/01-FEATURE-DETAILS.md)

Publishes approved posts to Facebook, Instagram and LinkedIn now or at a scheduled time in the workspace timezone, tracking one execution per (draft, network) through a strict state machine.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-EXE-01 | The system shall publish a draft only when it is `APPROVED` (or is a second network for a piece already `PUBLISHED`) and its text, network and images still match the approved content hash; otherwise the publish shall be refused. | Must | `tests/execution-handoff.test.ts`, `pnpm verify:publishing` | Implemented |
| FR-EXE-02 | The system shall publish Facebook Page and Instagram posts through the official Meta Graph API (Instagram: container → status poll → `media_publish`). Implemented and proven against the local sandbox; live use for non-tester accounts is blocked on Meta App Review. | Must | `pnpm verify:sandbox`, `tests/instagram-processing.test.ts` | Blocked (external) |
| FR-EXE-03 | The system shall publish LinkedIn posts, with images through the Images API, to the member profile through the LinkedIn REST API (`w_member_social`, header `LinkedIn-Version: 202610`). | Must | `pnpm verify:publishing`, `tests/publishing.test.ts` | Implemented |
| FR-EXE-04 | The system shall return a "copy for manual posting" outcome with a reason for X (no API publisher), for copy-only types (email, ad), and for media that fails destination validation, and shall never report such content as published. | Must | `tests/publish-media.test.ts`, `tests/multi-publish.test.ts` | Implemented |
| FR-EXE-05 | The system shall hold at most one `ContentPublication` per (draft, network) using a unique key, compare-and-swap and a 3-minute publish lease, so that concurrent clicks or runs can never post the same content twice. | Must | `tests/failure-recovery.test.ts`, `pnpm verify:failure-recovery` | Implemented |
| FR-EXE-06 | The system shall move each `Execution` only along the allowed transitions of `lib/execution-state.ts` (`APPROVED`, `READY_FOR_EXECUTION`, `SCHEDULED`, `QUEUED`, `EXECUTING`, `COMPLETED`, `FAILED`, `ACTION_REQUIRED`, `CANCELLED`), record an `ExecutionEvent` per change, and reject an invalid move with 409 `invalid_transition`. | Must | `tests/execution-engine.test.ts`, `pnpm verify:execution` | Implemented |
| FR-EXE-07 | The system shall build a versioned execution handoff per approved post and network with readiness `ready` / `blocked` / `superseded` / `executed` and issue codes (e.g. `missing_connection`, `connection_expired`, `missing_permission`, `invalid_media`), each with a fix link, and re-validate it on every read. | Must | `tests/execution-handoff.test.ts` | Implemented |
| FR-EXE-08 | The system shall route each publish through ordered checks (channel executor, content-type support, connected, scopes and health, valid target account) and refuse with the first failing code before any network call. | Must | `tests/execution-engine.test.ts` | Implemented |
| FR-EXE-09 | The system shall classify failures so that rate-limited attempts become `FAILED` and are retried automatically after 5 min, 30 min and 2 h up to 3 attempts, while connection, content, routing and unknown-outcome failures become `ACTION_REQUIRED` and are never retried automatically. | Must | `tests/execution-engine.test.ts`, `pnpm verify:failure-recovery` | Implemented |
| FR-EXE-10 | The system shall restrict publish, schedule, cancel and retry to roles holding `content:publish` (OWNER, ADMIN), require a same-origin request on cancel and retry, and let any member view executions. | Must | `pnpm verify:execution`, `pnpm verify:permissions` | Implemented |
| FR-EXE-11 | The system shall refuse to cancel an execution that is `COMPLETED` or `EXECUTING`, and shall allow retry only from `FAILED` or `ACTION_REQUIRED` after re-routing. | Must | `tests/execution-engine.test.ts` | Implemented |
| FR-EXE-12 | The system shall accept schedule input as a wall time in the workspace IANA timezone (default `UTC`), a named zone, or an ISO instant, require it to be at least 1 minute and at most 366 days ahead, resolve DST gaps and overlaps with an explanatory note, and reject invalid input with 422. | Must | `tests/execution-engine.test.ts`, `tests/planner-schedule.test.ts`, `pnpm verify:scheduler` | Implemented |
| FR-EXE-13 | The system shall keep each scheduled UTC instant unchanged when the workspace timezone is changed, and restrict the change to `company:update`. | Should | `pnpm verify:scheduler` | Implemented |
| FR-EXE-14 | The system shall publish due scheduled drafts from `/api/cron/publish` (up to 100 per run, 45 s budget, then Instagram processing, retry sweep of up to 50, and Meta insights), authenticated by a constant-time `CRON_SECRET` bearer check; `vercel.json` runs it only daily at 09:00 UTC, so posts are not published at the minute scheduled. | Must | `tests/scheduler.test.ts`, `pnpm verify:scheduler` | Partially implemented |
| FR-EXE-15 | The system shall suggest best posting times learned from the workspace's own published posts when there are at least 3 posts per weekday, 8 in total and a 1.2× lift, and otherwise use per-platform default windows. | Could | `tests/publishing.test.ts` | Implemented |
| FR-EXE-16 | The system shall publish to a LinkedIn Company Page (`w_organization_social` with `LINKEDIN_ORG_URN` set). Code path exists; use is blocked until LinkedIn grants Community Management API access. | Should | `tests/linkedin-publish.test.ts` | Blocked (external) |

### 3.21 WhatsApp AI Assistant

Feature folder: [`21-whatsapp-assistant`](feature-docs/02-features/21-whatsapp-assistant/01-FEATURE-DETAILS.md)

Lets linked users read, create, approve and publish in Aura by messaging one central Botella number through the Meta WhatsApp Cloud API, with the same permissions and approvals as the web.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-WA-01 | The system shall answer Meta's webhook handshake only when `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN` (else 403), and shall verify `X-Hub-Signature-256` over the raw body in constant time before parsing (401 on mismatch, 503 when not configured, 413 above 1,000,000 bytes). | Must | `tests/whatsapp.test.ts`, `pnpm verify:whatsapp` | Implemented |
| FR-WA-02 | The system shall store each inbound message once per `wamid`, queue it in a Postgres work queue, and acknowledge Meta immediately, processing it after the response. | Must | `pnpm verify:whatsapp` | Implemented |
| FR-WA-03 | The system shall process each conversation's jobs in order under a 90 s lease, retry failed jobs after 15 s, 60 s and 5 min, and mark a job `DEAD` after 4 attempts and send the user an apology. | Must | `pnpm verify:whatsapp` | Implemented |
| FR-WA-04 | The system shall link a number to an Aura account only after a signed-in website confirmation of a single-use link (10 min, max 5 per number per hour) and a 6-digit code sent back from the same number (10 min, 5 wrong attempts cancel), storing tokens and codes only as SHA-256 hashes and creating a 30-day session. | Must | `tests/whatsapp-link.test.ts`, `pnpm verify:whatsapp-link` | Implemented |
| FR-WA-05 | The system shall re-read the user's membership, role and the workspace's WhatsApp setting on every message and offer only workspaces the user belongs to with WhatsApp enabled. | Must | `tests/whatsapp-session-state.test.ts`, `pnpm verify:whatsapp-agent` | Implemented |
| FR-WA-06 | The system shall route a message by tapped ids, pending answers, deterministic intent matching, then an AI router limited to the tools the role may use, and shall check each tool's RBAC permission and validate its arguments with Zod before running it. | Must | `tests/whatsapp-agent.test.ts`, `pnpm verify:whatsapp-agent` | Implemented |
| FR-WA-07 | The system shall require a single-use explicit confirmation, valid 10 minutes and answered by the next message, before approving, rejecting, publishing or connecting, and shall never allow blocking review or fact-check results to be overridden from WhatsApp. | Must | `tests/whatsapp-social.test.ts`, `pnpm verify:whatsapp-social` | Implemented |
| FR-WA-08 | The system shall honour STOP / UNSUBSCRIBE / OPT OUT and START / OPT IN keywords immediately and send nothing to an opted-out conversation except the confirmation. | Must | `tests/whatsapp.test.ts` | Implemented |
| FR-WA-09 | The system shall send free-form messages only inside Meta's 24-hour service window, recording messages outside it as `FAILED` without sending. | Must | `tests/whatsapp-service.test.ts` | Implemented |
| FR-WA-10 | The system shall retry retryable Meta send errors with backoff of 1 min, 5 min, 15 min, 1 h and 3 h up to 6 attempts, and fail non-retryable errors at once with an audit entry. | Should | `tests/whatsapp-service.test.ts` | Partially implemented |
| FR-WA-11 | The system shall limit each conversation to 20 handled messages per minute (STOP exempt). | Should | Inspection | Implemented |
| FR-WA-12 | The system shall store each phone number as an HMAC lookup key, AES-256-GCM ciphertext and last 4 digits only, and delete message text and jobs older than `WHATSAPP_RETENTION_DAYS` (default 90) in the cron sweep. | Must | `tests/whatsapp-assistant.test.ts` | Partially implemented |
| FR-WA-13 | The system shall stamp each handled message with its `companyId` and show conversations only for the active workspace, with non-managers seeing only their own numbers. | Must | `tests/whatsapp-assistant.test.ts`, `tests/whatsapp-dashboard.test.ts` | Implemented |
| FR-WA-14 | The system shall let `company:update` holders turn WhatsApp on or off for the workspace and send a 1-1,000 character message to a member (10 per minute), with same-origin checks and audit entries. | Should | `tests/whatsapp-dashboard.test.ts` | Implemented |
| FR-WA-15 | The system shall start LinkedIn or Meta OAuth from a signed connect link valid 15 minutes, only for the user it was issued to and only if they still hold `linkedin:connect` (LinkedIn) or `company:update` (Meta). | Should | `tests/whatsapp-connect-route.test.ts` | Implemented |
| FR-WA-16 | The system shall send WhatsApp template messages for notifications outside the 24-hour window. | Could | Inspection | Not implemented |

### 3.22 Billing, Plans & Entitlements

Feature folder: [`22-billing-and-plans`](feature-docs/02-features/22-billing-and-plans/01-FEATURE-DETAILS.md)

Gives each workspace a 14-day trial and Starter / Growth / Agency plans through Stripe's hosted Checkout and Customer Portal, and enforces plan limits on creation.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-BIL-01 | The system shall create a `TRIAL` subscription with status `TRIALING` ending 14 days after company creation, and treat a company with no subscription row as an active trial. | Must | `tests/billing.test.ts` | Implemented |
| FR-BIL-02 | The system shall start a Stripe hosted Checkout session (`mode: subscription`) for `STARTER`, `GROWTH` or `AGENCY`, carrying `companyId` in session and subscription metadata, and never collect card details in Aura. | Must | Demonstration | Implemented |
| FR-BIL-03 | The system shall open the Stripe Customer Portal only for a workspace with a stored Stripe customer, returning 503 otherwise. | Should | Demonstration | Implemented |
| FR-BIL-04 | The system shall restrict checkout and portal to roles with `company:manageBilling` (OWNER only), returning 403 otherwise and hiding the buttons for other roles. | Must | Inspection | Implemented |
| FR-BIL-05 | The system shall accept Stripe webhooks only after `constructEvent` verifies the `stripe-signature` against the raw body (503 if `STRIPE_WEBHOOK_SECRET` is missing, 400 if the header is missing or invalid) and return 500 on handler failure so Stripe retries. | Must | `tests/billing.test.ts` | Implemented |
| FR-BIL-06 | The system shall mirror subscription state from `checkout.session.completed` (ACTIVE), `customer.subscription.updated` (plan from price id, mapped status), `customer.subscription.deleted` (CANCELED, plan TRIAL) and `invoice.payment_failed` (PAST_DUE), auditing each, and ignore other events. | Must | `tests/billing.test.ts` | Implemented |
| FR-BIL-07 | The system shall block creation with HTTP 402 and an upgrade message when the trial has expired or the status is `PAST_DUE`, `CANCELED` or `INCOMPLETE`, while keeping all data readable. | Must | `tests/billing.test.ts` | Implemented |
| FR-BIL-08 | The system shall enforce per-plan limits on active campaigns (1/2/10/100), discovery runs per UTC month (10/25/150/2000), active LinkedIn accounts (1/1/3/25) and generated graphics per month (20/100/500/4000) for TRIAL/STARTER/GROWTH/AGENCY. | Must | `tests/billing.test.ts` | Implemented |
| FR-BIL-09 | The system shall cap graphic variations per request at 2 (TRIAL, STARTER) or 4 (GROWTH, AGENCY). | Should | Inspection | Implemented |
| FR-BIL-10 | The system shall run without Stripe configured, showing that billing is not configured and disabling checkout for plans without a price id. | Should | Inspection | Implemented |
| FR-BIL-11 | The system shall scope each subscription to its company so a workspace sees only its own subscription. | Must | `tests/tenant-isolation.test.ts` | Implemented |
| FR-BIL-12 | The system shall create the trial subscription for every workspace, including those whose owner never opens the billing page, so that trial expiry applies to all. | Should | Inspection | Partially implemented |

### 3.23 AI Layer (Claude / Gemini Client)

Feature folder: [`23-ai-layer`](feature-docs/02-features/23-ai-layer/01-FEATURE-DETAILS.md)

The single server-side module (`server/ai/claude.ts`) through which every feature calls Anthropic Claude or Google Gemini, owning model tiers, retries, JSON parsing, schema validation and failure messages.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-AI-01 | The system shall use Anthropic when `ANTHROPIC_API_KEY` is set, otherwise Gemini when `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` is set, otherwise throw `ClaudeNotConfiguredError`. | Must | `tests/ai-model-tiers.test.ts`, `tests/claude.test.ts` | Implemented |
| FR-AI-02 | The system shall resolve model tiers `cheap` / `standard` / `premium` (default `premium`) to `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-4-8` on Anthropic and `gemini-3.5-flash-lite` on Gemini, overridable by `ANTHROPIC_MODEL[_<TIER>]` and `GEMINI_MODEL[_<TIER>]`. | Must | `tests/model-tiers.test.ts`, `tests/ai-model-tiers.test.ts` | Implemented |
| FR-AI-03 | The system shall request adaptive thinking only when the model supports it, effort is not `low` and `maxTokens` ≥ 2,000, and shall not send the effort parameter to Haiku models. | Should | `tests/ai-completion.test.ts` | Implemented |
| FR-AI-04 | The system shall stream Anthropic completions when `maxTokens` ≥ 8,000 and apply a default per-attempt timeout of 120,000 ms. | Should | Inspection | Implemented |
| FR-AI-05 | The system shall retry transient failures (429, ≥ 500, network errors, empty completions) up to 3 attempts with 400 ms × attempt backoff, and shall not retry 400/401/403/404, a missing configuration, or an exhausted quota (per-day quota or reset > 30 s). | Must | `tests/ai-completion.test.ts`, `tests/ai-quota.test.ts` | Implemented |
| FR-AI-06 | The system shall validate structured output against the caller's Zod schema, re-ask once with the validation errors, and throw `SchemaValidationError` rather than return unvalidated data. | Must | `tests/ai-quota.test.ts` | Implemented |
| FR-AI-07 | The system shall not re-ask for schema validation when the error is a provider refusal (numeric status) or missing configuration. | Should | `tests/ai-quota.test.ts` | Implemented |
| FR-AI-08 | The system shall parse model JSON by unwrapping fences and isolating the outermost object or array, repairing trailing commas and bare keys without altering string contents, and rethrowing the original error if repair fails. | Should | `tests/model-json.test.ts`, `tests/claude.test.ts` | Implemented |
| FR-AI-09 | The system shall return HTTP 503 with fixed user-facing wording for provider failures (quota exhausted with an approximate wait, rate limit, or no answer), never exposing raw provider text, and capture the error to monitoring. | Must | `tests/ai-quota.test.ts` | Implemented |
| FR-AI-10 | The system shall ignore thinking blocks and throw `EmptyCompletionError` when a completion contains no text. | Must | `tests/claude.test.ts`, `tests/ai-completion.test.ts` | Implemented |
| FR-AI-11 | The system shall read provider keys only on the server and never send them to the browser. | Must | Inspection | Implemented |
| FR-AI-12 | The system shall fail over from Anthropic to Gemini when Anthropic is configured but failing. | Could | Inspection | Not implemented |

### 3.24 Platform: Jobs, Cron, Security & Deployment

Feature folder: [`24-platform-jobs-and-deployment`](feature-docs/02-features/24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md)

The shared infrastructure: background generation jobs, 14 protected cron routes, request layering and error envelope, outbound HTTP, rate limiting, logging, encryption, environment checks, security headers and deployment.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-PLT-01 | The system shall run long generations (`TREND_DIGEST`, `MARKETING_PLAN`, `INTELLIGENCE`, `IMAGE_GENERATION`) as `GenerationJob`s that return immediately and report progress `{ step, message, percent }` for polling. | Must | `tests/job-dedupe.test.ts` | Implemented |
| FR-PLT-02 | The system shall deduplicate job enqueues per company, kind and dedupe key under a Postgres advisory lock, reusing an active job (200) or creating a new one (201). | Must | `tests/job-dedupe.test.ts` | Implemented |
| FR-PLT-03 | The system shall claim a job atomically (`QUEUED → RUNNING`), retry a failed job up to 3 attempts unless the error is marked non-retryable, and keep up to 2,000 characters of the final error for the UI. | Must | `tests/job-permanent-failure.test.ts` | Implemented |
| FR-PLT-04 | The system shall reap stuck jobs from `/api/cron/jobs` (fuse 10 min default, 2 min `MARKETING_PLAN`, 3 min `IMAGE_GENERATION`; orphan after 60 s; up to 3 run per sweep) and delete finished jobs after 7 days; this route is not scheduled in `vercel.json`. | Should | Inspection | Partially implemented |
| FR-PLT-05 | The system shall protect all 14 `/api/cron/*` routes with `Authorization: Bearer $CRON_SECRET`, serving GET and POST, and refuse (401) when `CRON_SECRET` is unset. | Must | `tests/scheduler.test.ts`, `pnpm verify:scheduler` | Implemented |
| FR-PLT-06 | The system shall run scheduled work for trends, competitors, outreach, discovery, memory, analytics, intelligence, advisor, campaigns, whatsapp and jobs on a schedule; only `publish`, `briefing` and `connections` are scheduled in `vercel.json`. | Should | Inspection | Partially implemented |
| FR-PLT-07 | The system shall redirect unauthenticated requests to `/dashboard/*` and `/onboarding/*` to `/login` with a safe `callbackUrl`, and return 401 "Not signed in…" for expired sessions on API calls. | Must | `tests/security-fixes.test.ts` | Implemented |
| FR-PLT-08 | The system shall map route errors to one JSON envelope: 422 with field details for validation errors, 403 for forbidden, 503 for AI provider failures, the error's own status where set, and a generic 500 for anything else with capture. | Must | Inspection | Implemented |
| FR-PLT-09 | The system shall scope every service query by `companyId` and return 404 for another workspace's ids. | Must | `tests/tenant-isolation.test.ts`, `tests/data-access-security.test.ts`, `pnpm verify:access` | Implemented |
| FR-PLT-10 | The system shall make outbound HTTP calls with a 10 s timeout, up to 2 retries on network errors and 5xx (250 ms × 2^n), and redact credential query parameters in errors and logs. | Should | Inspection | Implemented |
| FR-PLT-11 | The system shall rate-limit public auth endpoints per IP (signup 5/min, forgot-password 5/min, reset 10/min) with an in-process sliding window. | Must | Inspection | Partially implemented |
| FR-PLT-12 | The system shall encrypt OAuth tokens and connector secrets with AES-256-GCM (12-byte random IV) using a 32-byte `ENCRYPTION_KEY`, and failing loudly when encryption is attempted without a valid key. | Must | `tests/crypto.test.ts` | Implemented |
| FR-PLT-13 | The system shall render external links only for `http:` / `https:` URLs and accept post-login redirects only to single-slash relative paths. | Must | `tests/safe-links-render.test.tsx`, `tests/security-fixes.test.ts` | Implemented |
| FR-PLT-14 | The system shall check environment configuration at boot and via `pnpm env:check [--production]`, reporting by variable name only, failing on missing core variables, partial groups, secret-looking `NEXT_PUBLIC_*` names, invalid `ENCRYPTION_KEY`, and (production) localhost URLs or sandbox Graph overrides. | Must | `tests/env-check.test.ts`, `pnpm env:check` | Implemented |
| FR-PLT-15 | The system shall honour `META_GRAPH_BASE_URL` and `WHATSAPP_GRAPH_BASE_URL` sandbox overrides only for loopback hosts. | Must | `tests/graph-base.test.ts`, `pnpm verify:sandbox` | Implemented |
| FR-PLT-16 | The system shall run database migrations on Vercel build, retrying connection errors up to 5 times with exponential backoff from 2 s and failing at once on migration errors. | Must | Inspection | Implemented |

### 3.25 Navigation, Dashboard Shell & Design System

Feature folder: [`25-navigation-and-design-system`](feature-docs/02-features/25-navigation-and-design-system/01-FEATURE-DETAILS.md)

The public home page, the protected dashboard shell with six-group sidebar navigation, shared loading and error boundaries, and the token-based design system.

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| FR-NAV-01 | The system shall show a public home page with a pricing preview for Starter, Growth and Agency built from `PLAN_LIMITS`, and redirect signed-in users to `/dashboard`. | Should | Inspection | Implemented |
| FR-NAV-02 | The system shall require a signed-in user and an active workspace for the dashboard, redirecting to `/onboarding` when the user has no workspace. | Must | `pnpm verify:pages` | Implemented |
| FR-NAV-03 | The system shall organise the dashboard into six navigation groups (Home, Your market, Create, Customers, Results, Setup) holding 20 pages, defined in one config (`lib/nav.ts`). | Must | `tests/nav-clarity.test.ts` | Implemented |
| FR-NAV-04 | The system shall expand only the group containing the current route, selecting it by the longest matching page `href`, and mark the current page with `aria-current="page"`. | Should | `tests/nav-clarity.test.ts` | Implemented |
| FR-NAV-05 | The system shall show a fixed 16rem sidebar from the `lg` breakpoint and, below it, a modal drawer (`w-72`, max 85% width) with the same navigation that closes on link or backdrop click. | Must | `pnpm verify:responsive` | Implemented |
| FR-NAV-06 | The system shall render every dashboard page at 375, 768 and 1280 px widths with HTTP 200, no error boundary, no horizontal scroll and a visible page header. | Must | `pnpm verify:responsive` | Implemented |
| FR-NAV-07 | The system shall show a skeleton loading state while a dashboard route loads and an in-shell error card with the error digest, "Try again" and "Back to dashboard" when a page fails. | Must | Inspection | Implemented |
| FR-NAV-08 | The system shall provide a topbar with the workspace switcher and an account menu showing name and email with "Settings" and "Log out". | Must | Inspection | Implemented |
| FR-NAV-09 | The system shall style all screens from HSL design tokens and shared `components/ui` primitives, with a visible `:focus-visible` ring on interactive elements. | Should | Inspection | Implemented |
| FR-NAV-10 | The system shall give every navigation item a short outcome-named label and a one-line description shown as a tooltip. | Should | `tests/nav-clarity.test.ts` | Implemented |
| FR-NAV-11 | The system shall offer a dark theme using the defined `.dark` tokens. | Could | Inspection | Not implemented |
| FR-NAV-12 | The system shall hide or mark navigation links to pages where the current role cannot act (e.g. VIEWER). | Could | Inspection | Not implemented |

---

## 4. External interface requirements

### 4.1 User interfaces

The dashboard shell (`app/dashboard/layout.tsx`, `components/dashboard/dashboard-shell.tsx`) wraps every
signed-in page. Navigation is defined once in `lib/nav.ts`: six groups, 20 pages; only the group containing the
current route is expanded.

| Group | Pages (route) |
| --- | --- |
| Home | Home (`/dashboard`), Aura Suggests (`/dashboard/suggestions`), Review & approve (`/dashboard/review`) |
| Your market | Marketing health (`/dashboard/intelligence`), Market trends (`/dashboard/trends`), Opportunities (`/dashboard/opportunities`), Competitors (`/dashboard/competitors`) |
| Create | Content plan (`/dashboard/planner`), Content Studio (`/dashboard/content`), Publishing (`/dashboard/executions`), Campaigns (`/dashboard/campaigns`) |
| Customers | Leads (`/dashboard/leads`), Outreach (`/dashboard/outreach`), Comments & replies (`/dashboard/engagement`) |
| Results | Results (`/dashboard/analytics`), What works for you (`/dashboard/memory`) |
| Setup | About my business (`/dashboard/business`), Your tools (`/dashboard/connectors`), WhatsApp assistant (`/dashboard/whatsapp-assistant`), Settings (`/dashboard/settings`) |

Outside the shell: the public home page with pricing preview (`/`), sign-in and sign-up, password reset, the
onboarding wizard (`/onboarding`), invitation acceptance, WhatsApp link and connect pages (`/whatsapp/link/[token]`,
`/whatsapp/connect/[intent]`), the Meta data-deletion status page (`/meta/data-deletion`) and draft legal pages.

| ID | Requirement | Verification |
| --- | --- | --- |
| UI-01 | Layout: fixed 16rem sidebar from the `lg` breakpoint; below it, a modal drawer (`w-72`, max 85% width); topbar 4rem with workspace switcher and account menu; content width `max-w-6xl`. | `pnpm verify:responsive` |
| UI-02 | Every dashboard page renders at 375, 768 and 1280 px with HTTP 200, no error boundary, no horizontal scroll and a visible page header. | `pnpm verify:responsive`, `pnpm verify:pages` (45 of 45 pages) |
| UI-03 | Each zero-data screen shows an empty state (`components/ui/empty-state.tsx`) that says what is missing and links to the action that fixes it (see [EMPTY-STATES.md](EMPTY-STATES.md)); data is never fabricated to fill a screen. | Demonstration |
| UI-04 | Loading uses a skeleton (`app/dashboard/loading.tsx`); a page failure shows an in-shell error card with digest, "Try again" and "Back to dashboard" (`app/dashboard/error.tsx`). | Inspection |
| UI-05 | Unavailable actions stay visible but disabled with an actionable reason (review screen, connectors, billing). | `tests/review-item.test.ts` |
| UI-06 | Labels name outcomes, not machinery; suggestions are shown in plain language without enum names, scores or ids. | `tests/nav-clarity.test.ts`, `tests/aura-suggests.test.ts` |

### 4.2 Software interfaces

| Interface | Purpose | Protocol / endpoint | Authentication |
| --- | --- | --- | --- |
| Anthropic Claude | Primary text generation, AI reviewer, routing, detection | Messages API via `@anthropic-ai/sdk`; streamed above 8,000 max tokens | API key `ANTHROPIC_API_KEY` |
| Google Gemini (text) | Fallback text provider | REST `POST /v1beta/models/{model}:generateContent` | `x-goog-api-key` (`GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY`) |
| Image providers | Image generation and refinement | Gemini `generateContent`/`:predict`; OpenAI `/v1/images/generations`, `/v1/images/edits`; Stability `/v2beta/stable-image/generate/core`; Replicate `/v1/predictions`; Hugging Face Inference; Agnes (OpenAI-compatible) | Per-provider API key or token |
| Meta Graph API (`v23.0`) | Facebook Page and Instagram publishing, permalinks, insights, Page listing, long-lived token exchange | HTTPS REST `https://graph.facebook.com/{version}/…` | OAuth user token → Page token; Facebook Login (optionally `config_id`) |
| WhatsApp Cloud API | Assistant messages | `POST /{phoneNumberId}/messages`; inbound webhook | System-user token; webhook `X-Hub-Signature-256` with app secret |
| LinkedIn | Sign-in (OIDC), member/organisation posts, image upload, revoke | `oauth/v2/authorization`, `oauth/v2/accessToken`, `v2/userinfo`, `rest/posts`, `rest/images?action=initializeUpload` (`LinkedIn-Version: 202610`) | OAuth 2.0 (+ PKCE when `LINKEDIN_OAUTH_PKCE`) |
| Google | Sign-in; GA4 and Search Console connectors; Custom Search | OAuth 2.0 endpoints; `analyticsadmin` `accountSummaries`; `searchconsole` `sites`; `customsearch/v1` | OAuth 2.0; API key + CX for CSE |
| HubSpot, Mailchimp, Slack | Connector OAuth and account details | Provider OAuth 2.0 endpoints | OAuth 2.0 (Mailchimp token exchange uses HTTP Basic) |
| Public sources | Trends, competitor news, lead signals | Google News and Bing News RSS, industry RSS feeds, Reddit RSS or OAuth API, Hacker News Firebase, X recent search (flagged off), GitHub REST, Crunchbase v4, direct website fetch | None, optional token or API key; robots.txt and user agent `BotellaAuraBot/0.1` for websites |
| Stripe | Subscriptions, hosted Checkout, Customer Portal | Stripe Node SDK; webhook `POST /api/webhooks/stripe` | Secret key; webhook `stripe-signature` verified on the raw body |
| Resend / SMTP | Invitations, password reset, test email | `POST https://api.resend.com/emails` or SMTP via `nodemailer` | API key or SMTP credentials |
| S3-compatible storage | Images and video; presigned reads (15 min; 1 h for Instagram) | S3 API | Access key id / secret |
| PostgreSQL | System of record | Prisma over TCP; pooled `DATABASE_URL`, direct `DIRECT_URL` for migrations | Connection string |
| Sentry (optional) | Error capture | Store API | `SENTRY_DSN` |

### 4.3 Communications interfaces

| Item | Requirement |
| --- | --- |
| Transport | All browser, extension, webhook and provider traffic uses HTTPS in production; `env:check --production` fails on localhost URLs. |
| API conventions | JSON bodies validated by Zod (422 `{ error, details }` on failure); status codes 400 / 401 / 403 / 404 (including another workspace's id) / 409 / 422 / 429 / 503 per [INTERNAL-API.md](feature-docs/04-api/INTERNAL-API.md). |
| Security headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Powered-By` removed (`next.config.mjs`). |
| OAuth redirect URIs | Base `APP_URL` (fallback `NEXTAUTH_URL`): `/api/connectors/<connector-id>/callback` per connector; Google GA4 and Search Console share `/api/connectors/google/callback`; LinkedIn posting connection `/api/linkedin/callback`; NextAuth sign-in callbacks under `/api/auth/callback/*`. `pnpm auth:endpoints` prints every redirect URI and webhook URL. |
| Inbound webhooks | WhatsApp `GET/POST /api/webhooks/whatsapp` (verify token handshake; `X-Hub-Signature-256`, ≤ 1,000,000 bytes); Stripe `POST /api/webhooks/stripe`; Meta `POST /api/meta/deauthorize` and `POST /api/meta/data-deletion` (`signed_request` HMAC, 15-minute replay window). |
| Cron | 14 routes under `/api/cron/*`, GET and POST, `Authorization: Bearer $CRON_SECRET`; refused when the secret is unset. `vercel.json` schedules `publish` (`0 9 * * *`), `connections` (`0 6 * * *`) and `briefing` (`0 5 * * 1`) only. |
| Outbound HTTP | `lib/http.ts`: 10 s timeout, up to 2 retries on network errors and 5xx, credential query parameters redacted from errors and logs, SSRF-safe redirects. |

### 4.4 Chrome extension interface

| Item | Specification |
| --- | --- |
| Package | Manifest V3, "Botella Aura — Action Layer", manifest version 0.3.0, plain JavaScript; built into `public/downloads/botella-aura-extension.zip` at every build; not on the Chrome Web Store. |
| Permissions | `storage`, `activeTab`, `scripting`; host permissions for localhost:3000, `*.vercel.app`, `*.netlify.app`, `*.up.railway.app`, `*.botella.ai`, `*.linkedin.com`; optional `https://*/*`, `http://*/*`. |
| Components | `background.js` service worker (sole API caller; token and API base in `chrome.storage.local`); `content/linkedin.js` panel on `https://www.linkedin.com/*`; `content/pairing.js` on the Aura origin; popup. |
| Authentication | `Authorization: Bearer aura_ext_…` (no cookies); token stored as SHA-256 hash, 180-day expiry, per user and workspace, revocable; membership re-read on every request. |
| Pairing | Same-window, same-origin `postMessage` with `source: 'botella-aura'`, `type: 'AURA_EXT_TOKEN'`, or paste in the popup. |
| Endpoints | `GET /api/extension/status`, `GET /api/extension/queue`, `POST /api/extension/actions/complete`, `GET /api/extension/media/:assetId`, `POST /api/extension/metrics`, `POST /api/extension/engagement/draft`; session-authenticated `GET/POST /api/extension/token`, `POST /api/extension/token/:id/revoke`. |
| CORS | Echoes `chrome-extension://` / `moz-extension://` origins (or pinned `EXTENSION_ALLOWED_ORIGIN`); methods GET, POST, OPTIONS; headers `authorization`, `content-type`; max-age 86,400 s. |
| Behaviour limits | Inserts text into LinkedIn's composer (clipboard fallback); never clicks LinkedIn's submit button and never runs on a timer; 8 actions/hour (client) and 25/day (client and server, 429 at cap). |

### 4.5 WhatsApp interface

| Item | Specification |
| --- | --- |
| Transport | Meta WhatsApp Cloud API, one central number for all workspaces; Graph `messages` endpoint (default `v23.0`, 15 s timeout); delivery statuses applied forward only. |
| Inbound | `GET /api/webhooks/whatsapp` returns `hub.challenge` only when `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN`; `POST` verified with `X-Hub-Signature-256` (HMAC-SHA256, `WHATSAPP_APP_SECRET`, constant time) before parsing; stored once per `wamid`; acknowledged immediately, processed from a Postgres work queue. |
| Commands | "hi" / "menu" / "help" / "home"; "account"; "switch" / "workspace"; "logout" / "unlink"; STOP / UNSUBSCRIBE / STOP ALL / OPT OUT; START / SUBSCRIBE / OPT IN / UNSTOP; 6-digit link code ("123456", "123 456", "LINK 123-456"); free text routed by intent matching and a role-limited AI tool router. |
| Message shapes | Text ≤ 4,096 characters, up to 3 reply buttons, lists of up to 10 rows, CTA URL buttons, images. |
| Policy | Free-form messages only inside the 24-hour service window; template messages not implemented; STOP/START honoured at once; single-use explicit "yes" (10 minutes) before approve, reject, publish or connect. |
| Linking | Signed-in website confirmation of a single-use link (10 minutes, max 5 per number per hour) plus a 6-digit code from the same number (10 minutes, 5 wrong attempts cancel); 30-day session. |
| Web surfaces | `/dashboard/whatsapp-assistant`; APIs under `/api/whatsapp/*`; sweep `/api/cron/whatsapp` (recommended every 1–5 minutes; not scheduled). |
| Required configuration | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`. |

---

## 5. Non-functional requirements

Values come from [SPECIFICATIONS.md](feature-docs/05-resources/SPECIFICATIONS.md) and the feature documents.

### 5.1 Performance

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-PERF-01 | The system shall complete every API route within the 60 s serverless `maxDuration`, moving longer work (trend digests, monthly plans, intelligence, image generation) into resumable background jobs that return immediately. | Must | Inspection (route files), `tests/job-dedupe.test.ts` | Implemented |
| NFR-PERF-02 | The system shall bound the generation context to 3,200 tokens with per-section caps. | Must | `tests/generation-context.test.ts`, `pnpm verify:generation-context` | Implemented |
| NFR-PERF-03 | The system shall draft a monthly content plan inside a 45 s budget, with weeks drafted in parallel and runs considered dead after 2 minutes. | Should | `tests/planner-draft.test.ts`, `pnpm verify:planner` | Implemented |
| NFR-PERF-04 | The system shall limit Gemini image generation to 25 s per attempt with one retry and up to 4 images per call. | Should | `tests/gemini-image-provider.test.ts` | Implemented |
| NFR-PERF-05 | The system shall bound automatic suggestion runs to 25 s after detection and 40 s per on-request run. | Should | `pnpm verify:autosuggest` | Implemented |
| NFR-PERF-06 | The system shall process the publish cron in at most 100 due drafts per run within a 45 s budget. | Must | `tests/scheduler.test.ts` | Implemented |
| NFR-PERF-07 | The system shall acknowledge WhatsApp webhooks before processing and handle up to `WHATSAPP_WORKER_CONCURRENCY` (default 48) conversations per process. | Must | `pnpm verify:whatsapp`, `pnpm load:whatsapp` | Implemented |
| NFR-PERF-08 | The system shall apply a 10 s timeout to outbound HTTP calls and a default 120,000 ms per-attempt timeout to AI completions. | Should | Inspection (`lib/http.ts`, `server/ai/claude.ts`) | Implemented |
| NFR-PERF-09 | The system shall not exceed the 60 s job limit with image-provider calls; as built, OpenAI, Agnes and Hugging Face (120 s), Stability (90 s) and Replicate (180 s) timeouts exceed it (only Gemini is tuned to 25 s). | Should | Inspection (`server/media/providers/*`) | Partially implemented |

### 5.2 Security

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-SEC-01 | The system shall encrypt OAuth tokens and connector secrets at rest with AES-256-GCM (12-byte random IV) using a 32-byte `ENCRYPTION_KEY`, and never return encrypted fields to the browser. | Must | `tests/crypto.test.ts`, `tests/connection-manager.test.ts` | Implemented |
| NFR-SEC-02 | The system shall store password-reset, invitation, extension and WhatsApp link tokens only as SHA-256 hashes. | Must | `tests/extension-token.test.ts`, `tests/whatsapp-link.test.ts` | Implemented |
| NFR-SEC-03 | The system shall hash passwords with bcrypt (cost 12) and require 8–72 characters with at least one letter and one number. | Must | `tests/password.test.ts`, `tests/validations.test.ts` | Implemented |
| NFR-SEC-04 | The system shall scope every query by `companyId` from the caller's own memberships and answer another workspace's id with 404. | Must | `pnpm verify:access`, `pnpm verify:recommendation-security`, `tests/tenant-isolation.test.ts`, `tests/data-access-security.test.ts` | Implemented |
| NFR-SEC-05 | The system shall enforce the `lib/rbac.ts` permission matrix on every write route. As built, knowledge-base, brand-voice, trend-config and extension-token routes check membership only (ISSUE-01 to ISSUE-03). | Must | `pnpm verify:permissions` | Partially implemented |
| NFR-SEC-06 | The system shall protect every OAuth flow with an HMAC-signed state (10-minute TTL), a single-use encrypted httpOnly binding cookie and a PKCE verifier. | Must | `tests/oauth-pkce.test.ts`, `tests/meta-login.test.ts` | Implemented |
| NFR-SEC-07 | The system shall verify every inbound webhook signature before parsing (Stripe `stripe-signature`, WhatsApp `X-Hub-Signature-256`, Meta `signed_request` with a 15-minute window). | Must | `tests/billing.test.ts`, `tests/whatsapp.test.ts`, `tests/meta.test.ts` | Implemented |
| NFR-SEC-08 | The system shall authenticate all 14 cron routes with `Bearer $CRON_SECRET` using a constant-time comparison. As built, only `publish` and `whatsapp` compare in constant time; 12 routes use `===` / `!==` (ISSUE-06). | Should | Inspection (`app/api/cron/*/route.ts`, `lib/cron-auth.ts`) | Partially implemented |
| NFR-SEC-09 | The system shall rate-limit public auth endpoints (sign-up 5/min, forgot-password 5/min, reset 10/min per IP) with a limit shared across instances. As built the sliding window is in process memory (ISSUE-09). | Must | Inspection (`lib/rate-limit.ts`) | Partially implemented |
| NFR-SEC-10 | The system shall render outbound links only for `http:`/`https:` URLs, accept only same-site relative `callbackUrl`s, and refuse URL imports to private or link-local hosts, re-checking each of at most 3 redirects. | Must | `tests/safe-links-render.test.tsx`, `tests/security-fixes.test.ts`, `tests/media-upload.test.ts` | Implemented |
| NFR-SEC-11 | The system shall serve asset bytes only to members of the owning workspace or through an HMAC-SHA256 signed URL (15-minute default TTL, constant-time check). | Must | `tests/asset-url.test.ts` | Implemented |
| NFR-SEC-12 | The system shall send the security headers `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. | Must | Inspection (`next.config.mjs`) | Implemented |
| NFR-SEC-13 | The system shall honour Graph base-URL sandbox overrides only for loopback hosts, and `env:check --production` shall fail when they are set. | Must | `tests/graph-base.test.ts`, `tests/env-check.test.ts` | Implemented |
| NFR-SEC-14 | The system shall keep AI and provider keys server-side only, and `env:check` shall fail on secret-looking `NEXT_PUBLIC_*` names. | Must | `tests/env-check.test.ts` | Implemented |

### 5.3 Privacy and data protection

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-PRIV-01 | The system shall redact secrets, tokens, connection strings, Luhn-valid card numbers and internal ids from all model context, and off-domain emails and phone numbers from documents, pages and earlier posts. | Must | `tests/generation-context.test.ts` | Implemented |
| NFR-PRIV-02 | The system shall store each WhatsApp phone number as an HMAC lookup key, AES-256-GCM ciphertext and last 4 digits only. | Must | `tests/whatsapp-assistant.test.ts` | Implemented |
| NFR-PRIV-03 | The system shall delete WhatsApp message text and jobs older than `WHATSAPP_RETENTION_DAYS` (default 90). The deletion runs in the `/api/cron/whatsapp` sweep, which is not scheduled. | Must | Inspection (`server/whatsapp/queue.ts`) | Partially implemented |
| NFR-PRIV-04 | The system shall collect only public data: honour robots.txt, throttle per origin (1,200 ms) and never fetch LinkedIn pages server-side. | Must | Inspection (`lib/http.ts`, `server/competitors/sources/linkedin.ts`) | Implemented |
| NFR-PRIV-05 | The system shall answer Meta deauthorize and data-deletion callbacks by clearing tokens or deleting the user's Meta connections and returning a status URL with a confirmation code. | Must | `tests/meta.test.ts` | Implemented |
| NFR-PRIV-06 | The system shall report environment problems by variable name only, never by value. | Must | `tests/env-check.test.ts` | Implemented |
| NFR-PRIV-07 | The system shall revoke provider credentials (best effort) on disconnect. | Should | Inspection | Implemented |
| NFR-PRIV-08 | The system shall publish an approved privacy policy, terms and data-deletion explanation. As built the legal pages are drafts (`lib/legal.ts` `approved: false`, `noindex`) (ISSUE-14). | Must | Inspection | Partially implemented |

### 5.4 Reliability and availability

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-REL-01 | The system shall degrade to a labelled deterministic fallback, or a `skipped` source with a reason, whenever an optional provider is missing or fails, never reporting silent success. | Must | `pnpm verify:ai-detection`, `pnpm verify:signals` | Implemented |
| NFR-REL-02 | The system shall retry transient AI failures up to 3 attempts and re-ask once on schema validation failure, never saving malformed output. | Must | `tests/ai-completion.test.ts`, `tests/ai-quota.test.ts` | Implemented |
| NFR-REL-03 | The system shall retry failed background jobs up to 3 attempts unless non-retryable, and reap stuck jobs; the reaper (`/api/cron/jobs`) is not scheduled. | Should | `tests/job-permanent-failure.test.ts` | Partially implemented |
| NFR-REL-04 | The system shall never publish the same content twice, using one `ContentPublication` per (draft, network), compare-and-swap and a 3-minute lease. | Must | `tests/failure-recovery.test.ts`, `pnpm verify:failure-recovery` | Implemented |
| NFR-REL-05 | The system shall retry rate-limited publishes after 5 min, 30 min and 2 h (3 attempts) and send other failures to `ACTION_REQUIRED` without automatic retry. | Must | `tests/execution-engine.test.ts` | Implemented |
| NFR-REL-06 | The system shall make every cron route idempotent per workspace and period so a double fire never duplicates work. | Must | Inspection | Implemented |
| NFR-REL-07 | The system shall retry database connection errors during deploy migration 5 times with backoff (about 30 s) and fail at once on migration errors. | Must | Inspection (`scripts/migrate-deploy.mjs`) | Implemented |
| NFR-REL-08 | The system shall process WhatsApp jobs in per-conversation order with leases, backoff and a dead letter after 4 attempts. | Must | `pnpm verify:whatsapp` | Implemented |
| NFR-REL-09 | The system shall isolate page data loaders (e.g. Aura Home) so one failing source does not break the page. | Should | `pnpm verify:home` | Implemented |

### 5.5 Scalability

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-SCAL-01 | The system shall run stateless on serverless functions with pooled database connections at runtime (`DATABASE_URL`) and direct connections for migrations (`DIRECT_URL`). | Must | Inspection (`prisma/schema.prisma`) | Implemented |
| NFR-SCAL-02 | The WhatsApp work queue shall sustain 1,000 simulated concurrent users. | Should | `pnpm load:whatsapp` | Implemented |
| NFR-SCAL-03 | The system shall store media in an S3-compatible bucket when configured, keeping Postgres storage as the fallback. | Should | `tests/media-storage.test.ts` | Implemented |
| NFR-SCAL-04 | The system shall bound resource use per workspace through plan limits (campaigns, discovery runs, LinkedIn accounts, graphics per month) and recommendation limits (10 per day, 15 awaiting decision, 5 per channel per week). | Must | `tests/billing.test.ts`, `tests/recommendation-rules.test.ts` | Implemented |
| NFR-SCAL-05 | Cron routes shall process all workspaces within the 60 s limit. As built, trends, competitors, advisor, intelligence and briefing loop over companies sequentially in one function (ISSUE-18). | Should | Inspection | Partially implemented |

### 5.6 Maintainability

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-MAINT-01 | The code shall type-check cleanly under TypeScript `strict` with `noUncheckedIndexedAccess` and `noImplicitOverride`. | Must | `pnpm typecheck` | Implemented |
| NFR-MAINT-02 | The code shall pass lint and Prettier format checks. | Must | `pnpm lint`, `pnpm format:check` | Implemented |
| NFR-MAINT-03 | The unit test suite shall pass (2,141 tests in 147 suites at baseline). | Must | `pnpm test` | Implemented |
| NFR-MAINT-04 | The 66 end-to-end `pnpm verify:*` scripts shall pass against a running app. | Must | `pnpm verify:*` | Implemented |
| NFR-MAINT-05 | The system shall keep business logic in services, pure rules in `lib`, one model client and one outbound HTTP client, and validate every input, AI output and handoff with Zod. | Must | Inspection | Implemented |
| NFR-MAINT-06 | The production build shall complete cleanly. | Must | `pnpm build` | Implemented |

### 5.7 Usability and accessibility

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-USE-01 | Every dashboard page shall be usable at 375, 768 and 1280 px without horizontal scroll. | Must | `pnpm verify:responsive` | Implemented |
| NFR-USE-02 | Navigation shall mark the current page with `aria-current="page"` and interactive elements shall show a visible `:focus-visible` ring. | Should | `tests/nav-clarity.test.ts`, Inspection | Implemented |
| NFR-USE-03 | User-facing text shall be plain language: outcome-named labels, no enum names, scores or ids, readable sentences for every auth and AI error. | Should | `tests/nav-clarity.test.ts`, `tests/aura-suggests.test.ts`, `tests/auth-providers.test.ts` | Implemented |
| NFR-USE-04 | Every empty state shall say what is missing and link to the fix. | Should | `pnpm verify:what-matters`, Demonstration | Implemented |
| NFR-USE-05 | The UI shall offer a dark theme and hide or mark links a role cannot act on. Not built (FR-NAV-11, FR-NAV-12). | Could | Inspection | Not implemented |

### 5.8 Portability and deployment

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-PORT-01 | The system shall run on Node.js ≥ 20 with pnpm ≥ 9 and a frozen lockfile. | Must | Inspection (`package.json`) | Implemented |
| NFR-PORT-02 | The Vercel build shall package the extension, run `prisma generate`, apply migrations and run `next build` (`pnpm run vercel-build`). | Must | Inspection | Implemented |
| NFR-PORT-03 | The system shall run locally against PostgreSQL 16 in Docker and against Neon in production, with Netlify and Railway configurations provided. | Should | Inspection (`docker-compose.yml`) | Implemented |
| NFR-PORT-04 | `pnpm env:check --production` shall fail on missing core variables, partial groups, an invalid `ENCRYPTION_KEY`, localhost URLs or sandbox overrides. | Must | `tests/env-check.test.ts` | Implemented |
| NFR-PORT-05 | Only one `next dev` server shall run per checkout, as two servers sharing `.next` produce false 500 errors. | Should | Inspection | Implemented |

### 5.9 Auditability

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-AUD-01 | The system shall write a typed `AuditLog` row in the same transaction as each audited action (sign-in, edits, AI runs, approvals, publishes, sends, connector changes, billing events). | Must | Inspection | Implemented |
| NFR-AUD-02 | Approval audit entries shall carry the approval action, version, hash, request IP and user agent. | Must | `pnpm verify:approval` | Implemented |
| NFR-AUD-03 | The system shall keep event histories for opportunities (`OpportunityEvent`), recommendations (`RecommendationEvent`) and executions (`ExecutionEvent`). | Must | `pnpm verify:opportunities`, `pnpm verify:lifecycle`, `pnpm verify:execution` | Implemented |
| NFR-AUD-04 | The system shall keep a trace from Business Context revision through signals, opportunity, recommendation, brief, versions and media to the approved version for every content draft. | Must | `pnpm verify:trace` | Implemented |
| NFR-AUD-05 | Audit rows shall survive workspace deletion (`AuditLog.companyId` set to null). | Should | Inspection (`prisma/schema.prisma`) | Implemented |

### 5.10 Compliance

| ID | Requirement | Priority | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-COMP-01 | The system shall require a human approval bound to a content fingerprint before any post is published, and a human click in LinkedIn for every outreach message and comment. | Must | `pnpm verify:approval` | Implemented |
| NFR-COMP-02 | For alcohol businesses the system shall apply the alcohol rules (`alcohol-minors`, `alcohol-driving`, `alcohol-excess`, `alcohol-health`, `alcohol-social`) and require "Please enjoy responsibly." (`responsible-drinking`). | Must | `tests/content-quality.test.ts`, `tests/compliance-policy.test.ts`, `pnpm verify:content-studio` | Implemented |
| NFR-COMP-03 | The system shall apply the workspace compliance policy (packs `general`, `alcohol`, `health`, `financial`; required disclaimers such as "Terms apply." on promotions) to writer and reviewer. | Must | `pnpm verify:compliance` | Implemented |
| NFR-COMP-04 | The system shall provide Meta deauthorize and data-deletion callbacks and a public deletion status page as Meta platform policy requires. | Must | `tests/meta.test.ts` | Implemented |
| NFR-COMP-05 | The system shall respect WhatsApp Business policy: 24-hour service window, STOP/START opt-out, and no messages to opted-out conversations except the confirmation. | Must | `tests/whatsapp.test.ts`, `tests/whatsapp-service.test.ts` | Implemented |
| NFR-COMP-06 | The system shall respect LinkedIn terms: no server-side scraping or login, no automated clicking, human action caps of 8/hour and 25/day. | Must | `tests/extension-permissions.test.ts`, Inspection | Implemented |
| NFR-COMP-07 | The system shall keep card data out of scope by using Stripe hosted Checkout and Customer Portal. | Must | Demonstration | Implemented |
| NFR-COMP-08 | The system shall classify source material for brand safety over 11 sensitive topics and refuse promotional formats on `unsuitable` sources. | Must | `tests/brand-safety.test.ts` | Implemented |

---

## 6. Data requirements

### 6.1 Data model

The schema is [`prisma/schema.prisma`](../prisma/schema.prisma): **61 models**, PostgreSQL. Every business table
carries `companyId` and is deleted with its workspace (cascade), except `AuditLog`, whose `companyId` is set to
null so the audit trail survives.

| Entity (model) | Purpose | Owner / scope | Retention |
| --- | --- | --- | --- |
| `User`, `Account`, `Session`, `VerificationToken` | Identity and NextAuth adapter data | User | Until the account is removed (no self-service account deletion) |
| `PasswordResetToken` | Reset links (SHA-256 hash) | User | 1-hour validity; marked used on reset, other unused tokens revoked |
| `Company`, `CompanyMember`, `CompanyInvitation` | Tenant, membership and role, invitations (hashed, 7-day expiry) | Workspace | Life of workspace |
| `AuditLog` | Typed audit trail | Workspace (nullable) | No automatic purge |
| `KnowledgeSource`, `KnowledgeChunk` | Website, blog and uploaded material as chunks | Workspace | Replaced on re-sync or re-upload; no delete endpoint |
| `BusinessContextSnapshot`, `BusinessContextQuestion` | Resolved context snapshot (one per workspace), gap questions | Workspace | Snapshot rebuilt on change or after 6 h |
| `TrendDigest`, `CompanyTrendConfig` | Daily digest (one per UTC day), sources config | Workspace | Kept; UI shows last 7 days |
| `CompetitorProfile`, `CompetitorSnapshot`, `CompetitorReport` | Tracked competitors, change snapshots, weekly reports | Workspace | Kept; last 12 reports listed |
| `Signal`, `Opportunity`, `OpportunitySignal`, `OpportunityEvent` | Signal store and opportunities with evidence and history | Workspace | Signals expire after 14–60 days by source but are not pruned |
| `Recommendation`, `RecommendationEvent`, `RecommendationEvidence` | Recommendations, history, evidence | Workspace | Expire at most 30 days after creation; rows kept |
| `ContentDraft`, `ContentMedia`, `GeneratedAsset` | Drafts (with approval, versions, trace in `aiMetadata`), media attachments, image/video assets | Workspace | Kept; assets used by a published post cannot be deleted |
| `Campaign`, `CampaignTask`, `MarketingPlan` | Campaigns, scheduled tasks, monthly plans (one per month) | Workspace | Kept |
| `Lead`, `LeadSignal`, `OutreachConfig`, `OutreachMessage`, `DiscoveryProfile`, `DiscoveryRun` | Leads, outreach drafts, discovery | Workspace | Kept |
| `EngagementTarget`, `EngagementComment` | Engagement copilot | Workspace | Kept (post excerpt ≤ 2,000 chars) |
| `ExtensionToken` | Extension bearer tokens (hash) | User + workspace | 180-day expiry; revocable |
| `PerformanceSnapshot`, `MarketingMemory`, `AnalyticsReport`, `IntelligenceSnapshot`, `AdvisorReport`, `WorkspaceBriefing` | Results, insights, reports, scores, briefings | Workspace | Kept; one report per period |
| `Connection`, `ConnectedAccount`, `ConnectorEmailVerification`, `LinkedInConnection` | Connector credentials (AES-256-GCM), accounts, verification codes | Workspace | Until disconnect or Meta data-deletion callback |
| `ContentPublication`, `Execution`, `ExecutionEvent`, `ExecutionHandoff` | Publishing state per (draft, network) and history | Workspace | Kept |
| `GenerationJob` | Background jobs | Workspace | Finished jobs deleted after 7 days (by the unscheduled jobs cron) |
| `WhatsAppConversation`, `WhatsAppLinkChallenge`, `WhatsAppAccountLink`, `WhatsAppJob`, `WhatsAppMessage` | WhatsApp sessions, linking, queue, messages | User / workspace-stamped | Message text and jobs deleted after 90 days (by the unscheduled WhatsApp sweep) |
| `Subscription` | Plan and Stripe state mirror | Workspace | Life of workspace |

### 6.2 JSON-stored structures

| Structure | Location | Contents and limits | Owner |
| --- | --- | --- | --- |
| Approval record | `ContentDraft.aiMetadata.approval`, `OutreachMessage.aiMetadata.approval` | `model: 1`, version, 16-hex FNV-1a hash, approved `{by, via, at, version, hash, snapshot}`, rejected `{by, at, reason, version}`, up to 60 events (snapshots on the newest 15) | `lib/approval.ts` |
| Version log | `aiMetadata.versions` (both models) | `model: 1`, current, approved `{n, by, at}`, up to 50 versions (v1, current and approved never dropped) | `lib/versions.ts` |
| Trace ids | `ContentDraft.aiMetadata.trace` | `model: 1`, traceId, Business Context revision and fields, signal ids, opportunity, recommendation, brief, generated/reviewed/approved versions, media asset ids | `lib/trace.ts` |
| Compliance policy | `Company.preferences.compliancePolicy` | Validated by `compliancePolicySchema` (`POLICY_VERSION = 1`); fingerprinted by `policyHash` | `lib/compliance-policy.ts` |
| Other draft metadata | `ContentDraft.aiMetadata` | `review`, `reviewHistory` (5), `quality`, `factCheck`, `brief`, `context` (generation trace), `variations` (8), undo `history` (5), `idempotencyKey`, `sourceMaterial` (4,000 chars) | `server/content/*` |
| Asset metadata | `GeneratedAsset.metadata` | Job ids, variant lineage `{rootId, parentId, version, action}`, logo placement, creative spec | `server/media/*` |
| Brand Voice Profile | `Company.brandVoiceProfile` | Tone descriptors (≤ 10), sentence length, vocabulary (≤ 20), common phrases (≤ 15), topics to avoid (≤ 15), formatting; validated by `brandVoiceProfileSchema` on save and on read | `server/content/brand-voice.service.ts` |

Every JSON structure is versioned (`model` or `version` field) and read through a tolerant parser, so rows written
by older builds still load.

### 6.3 Migrations policy

- Schema changes are made only through Prisma migrations in `prisma/migrations/`. The baseline holds **49
  migrations**: `0_init` plus 48 dated migrations; 24 were added in Phase 1 and 25 in Phase 2.
- Migrations are applied at deploy by `scripts/migrate-deploy.mjs` over `DIRECT_URL` (PgBouncer breaks advisory
  locks). Connection errors are retried 5 times; migration errors fail the build.
  `ALLOW_DEPLOY_WITHOUT_MIGRATIONS=1` downgrades an unreachable database to a warning.
- Features that only add JSON fields (approval, versions, trace, compliance policy) need no migration and must
  keep readers tolerant of older shapes.
- The Netlify build runs `prisma migrate deploy` without the retry wrapper (ISSUE-13).

---

## 7. Constraints, risks and open issues

| ID | Issue (from the code) | Impact | Recommendation |
| --- | --- | --- | --- |
| ISSUE-01 | Knowledge-base upload, website sync and brand-voice regenerate/edit (`app/api/knowledge/upload/route.ts`, `app/api/knowledge/sync/route.ts`, `app/api/brand-voice/route.ts`) check membership only; a VIEWER can write. | High — read-only users can change the material and voice every generation uses. | Require `company:update` (or `content:create` for uploads) with `can()`. |
| ISSUE-02 | `PUT /api/trends/config` and `POST /api/trends/refresh` check membership only; a VIEWER can change trend sources and trigger an AI-spending refresh. | Medium | Require `company:update` for config and `content:create` for refresh, or remove the legacy refresh route (the UI uses `/api/jobs`). |
| ISSUE-03 | `POST /api/extension/token` calls only `requireActiveCompany()`; any member, including VIEWER, can issue an extension token through the API (the UI restricts it to `linkedin:connect`). | Low–Medium — each write action is still role-checked, but a VIEWER token can read the approved queue. | Check `linkedin:connect` on issue. |
| ISSUE-04 | Only 3 of 14 cron routes are scheduled in `vercel.json` (`publish`, `connections`, `briefing`). Trends, competitors, advisor, intelligence, campaigns, outreach, discovery, memory, analytics, whatsapp and jobs run only when called. | High — daily digests, weekly competitor reports, campaign tasks, WhatsApp retries and retention, and the job reaper do not run automatically. | Add them to `vercel.json` or an external scheduler (WhatsApp every 1–5 min). |
| ISSUE-05 | `/api/cron/publish` runs once a day at 09:00 UTC. | High — scheduled posts go out at the next 09:00 UTC run, not at the scheduled minute. | Run the publish cron every few minutes (needs a plan that allows it, or an external scheduler). |
| ISSUE-06 | 12 cron routes (advisor, analytics, briefing, campaigns, competitors, connections, discovery, intelligence, jobs, memory, outreach, trends) compare `CRON_SECRET` with `===` / `!==`; only `publish` (`lib/cron-auth.ts`) and `whatsapp` use `timingSafeEqual`. All fail closed when unset. | Low — theoretical timing side channel. | Use `isCronAuthorized` from `lib/cron-auth.ts` in every cron route. |
| ISSUE-07 | Meta App Review pending for Facebook/Instagram publishing and insights permissions; WhatsApp production access pending. | High — FB/IG publishing and detailed insights limited to app testers; WhatsApp on a test number. | Complete the submission in [META-APP-REVIEW-SUBMISSION.md](META-APP-REVIEW-SUBMISSION.md); set `META_REQUEST_INSIGHTS=true` after approval. |
| ISSUE-08 | LinkedIn Community Management API (`w_organization_social`) not granted; no official scope for company data. | Medium — no Company Page posting; LinkedIn competitor signals skipped. | Apply for LinkedIn API access; set `LINKEDIN_ORG_URN`. |
| ISSUE-09 | Rate limiters (auth, briefing, WhatsApp flood/confirm/send, extension hourly cap) are in process memory or client-only. | Medium — limits are best effort across serverless instances. | Move to a shared store (e.g. Redis/Upstash) or Postgres. |
| ISSUE-10 | No email verification for credential sign-ups; an OAuth profile without an `email_verified` claim is accepted for linking. | Medium | Add verification email; refuse linking when the claim is absent. |
| ISSUE-11 | The trial `Subscription` row is created only from the billing page or checkout; a workspace without a row is treated as an active trial with no end date. | Medium — revenue leakage. | Create the trial row at workspace creation. |
| ISSUE-12 | Image-provider timeouts (90–180 s) exceed the 60 s job function limit. | Medium — jobs can be killed mid-call and retried. | Lower provider timeouts below the function budget or use async provider APIs. |
| ISSUE-13 | `/_next/image` allows `remotePatterns: '**'` (open image proxy); `netlify.toml` sets `X-Frame-Options: SAMEORIGIN` against `DENY` in `next.config.mjs`; Netlify migrations lack the retry wrapper. | Low–Medium | Restrict remote patterns; align headers; reuse `migrate-deploy.mjs`. |
| ISSUE-14 | Legal pages are drafts (`lib/legal.ts` `approved: false`, `noindex`, operator facts `null`). | High for launch — Meta App Review and app stores need a live privacy policy. | Complete and approve the legal facts. |
| ISSUE-15 | Outreach edit, submit and restore need `content:approve`, so MEMBERs cannot work on outreach. | Low | Decide the intended role; allow `content:create` for drafting if wanted. |
| ISSUE-16 | Approval fingerprints use FNV-1a (non-cryptographic); approval events capped at 60 and versions at 50 in JSON. | Low — detects accidental change, not tampering; old history dropped (audit log keeps status changes). | Use SHA-256 for fingerprints if tamper evidence is required. |
| ISSUE-17 | `CONTEXTUAL_EXECUTION_ENABLED = false`: campaigns and outreach created from recommendations are saved and approved but never executed. | Medium — by design for this release. | Enable after the contextual execution path is verified. |
| ISSUE-18 | Several cron routes loop over companies sequentially inside one 60 s function; competitor "Generate now" tracks all competitors in one request. | Medium at scale — later workspaces may be skipped. | Fan out per workspace through the job queue. |
| ISSUE-19 | `company:delete` exists but no route deletes a workspace; uploaded knowledge cannot be deleted or recategorised; signals are never pruned. | Low–Medium — data-lifecycle and privacy-request gaps. | Add workspace and document deletion; prune expired signals. |
| ISSUE-20 | No failover from Anthropic to Gemini when Anthropic is configured but failing. | Medium — AI outages surface as 503. | Fall back to Gemini on provider failure. |
| ISSUE-21 | Knowledge upload size caps disagree (route 4,000,000 bytes, service 10 MB). | Low | Use one constant. |
| ISSUE-22 | Documentation drift: the campaigns feature doc grants `content:approve` to MEMBER (code: OWNER, ADMIN only); `features.json` lists `/api/content/media` and `/api/content/creative`, which do not exist. | Low | **Resolved 30 Oct 2026:** the campaigns feature doc and the feature route map were corrected to match the code. |

---

## 8. Requirements traceability matrix

| Area | Feature folder | Main code paths | Verification |
| --- | --- | --- | --- |
| AUTH | [01-authentication-and-accounts](feature-docs/02-features/01-authentication-and-accounts/01-FEATURE-DETAILS.md) | `lib/auth.ts`, `lib/auth-linkedin.ts`, `lib/rate-limit.ts`, `middleware.ts`, `app/api/auth/*`, `server/services/user.service.ts` | `tests/auth-providers.test.ts`, `tests/password.test.ts`, `tests/validations.test.ts`, `tests/security-fixes.test.ts`; `pnpm verify:access` |
| WS | [02-workspaces-team-and-roles](feature-docs/02-features/02-workspaces-team-and-roles/01-FEATURE-DETAILS.md) | `lib/rbac.ts`, `lib/active-company.ts`, `lib/email.ts`, `app/api/companies/*`, `app/api/team/*`, `server/services/team.service.ts` | `tests/company-service.test.ts`, `tests/email-delivery.test.ts`, `tests/tenant-isolation.test.ts`; `pnpm verify:permissions`, `pnpm verify:access` |
| ONB | [03-onboarding-and-guided-setup](feature-docs/02-features/03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md) | `app/onboarding/page.tsx`, `components/onboarding/onboarding-wizard.tsx`, `app/api/onboarding/preview/route.ts`, `server/onboarding/checklist.service.ts` | `tests/onboarding.test.ts`; `pnpm verify:onboarding`, `pnpm verify:flow` |
| KB | [04-knowledge-base-and-brand-voice](feature-docs/02-features/04-knowledge-base-and-brand-voice/01-FEATURE-DETAILS.md) | `server/knowledge/*`, `server/content/brand-voice.service.ts`, `app/api/knowledge/*`, `app/api/brand-voice/route.ts` | `tests/materials.test.ts`, `tests/retrieve.test.ts`, `tests/brand-context.test.ts`; `pnpm verify:materials` |
| BC | [05-business-context](feature-docs/02-features/05-business-context/01-FEATURE-DETAILS.md) | `lib/business-context*.ts`, `server/business-context/*`, `app/api/business-context/*`, `app/dashboard/business/page.tsx` | `tests/business-context*.test.ts`, `tests/context-snapshot.test.ts`, `tests/context-questions.test.tsx`; `pnpm verify:context-sources`, `pnpm verify:engine`, `pnpm verify:readiness` |
| TRD | [06-trend-insights](feature-docs/02-features/06-trend-insights/01-FEATURE-DETAILS.md) | `server/trends/*`, `server/services/trend-config.service.ts`, `app/api/trends/*`, `app/api/cron/trends/route.ts` | `tests/scoring.test.ts`, `tests/trend-sources.test.ts`, `tests/brand-safety.test.ts`, `tests/digest-payload.test.ts` |
| CMP | [07-competitor-intelligence](feature-docs/02-features/07-competitor-intelligence/01-FEATURE-DETAILS.md) | `server/competitors/*`, `app/api/competitors/**`, `app/api/cron/competitors/route.ts` | `tests/competitor-diff.test.ts`, `tests/stored-payload-tolerance.test.ts`; `pnpm verify:access` |
| OPP | [08-signals-and-opportunities](feature-docs/02-features/08-signals-and-opportunities/01-FEATURE-DETAILS.md) | `lib/signals.ts`, `lib/opportunity-detection.ts`, `lib/ai-opportunity-detection.ts`, `server/signals/*`, `server/opportunities/*`, `server/advisor/*` | `tests/signals.test.ts`, `tests/opportunities.test.ts`, `tests/opportunity-detection.test.ts`; `pnpm verify:signals`, `pnpm verify:opportunities`, `pnpm verify:detection`, `pnpm verify:ai-detection` |
| REC | [09-recommendations-and-aura-suggests](feature-docs/02-features/09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md) | `lib/recommendation*.ts`, `lib/aura-suggests.ts`, `lib/aura-modules.ts`, `server/recommendations/*`, `app/api/recommendations/**` | `tests/recommendation*.test.ts`, `tests/aura-suggests.test.ts`; `pnpm verify:engine`, `verify:guardrails`, `verify:prioritization`, `verify:lifecycle`, `verify:quality`, `verify:suggestions`, `verify:autosuggest`, `verify:recommendation-security` |
| HOME | [10-aura-home-and-briefing](feature-docs/02-features/10-aura-home-and-briefing/01-FEATURE-DETAILS.md) | `app/dashboard/page.tsx`, `lib/aura-home.ts`, `lib/what-matters.ts`, `server/briefing/*`, `server/intelligence/*`, `app/api/cron/briefing/route.ts` | `tests/aura-home.test.ts`, `tests/what-matters.test.ts`, `tests/briefing.test.ts`; `pnpm verify:home`, `verify:what-matters`, `verify:briefing` |
| CNT | [11-content-studio](feature-docs/02-features/11-content-studio/01-FEATURE-DETAILS.md) | `app/api/content/generate/route.ts`, `server/content/*`, `lib/content-brief.ts`, `lib/generation-context.ts`, `lib/content-quality.ts`, `lib/content-review.ts`, `lib/fact-check.ts`, `lib/compliance-policy.ts` | `tests/content-*.test.ts`, `tests/fact-check.test.ts`, `tests/compliance-policy.test.ts`; `pnpm verify:content-brief`, `verify:generation-context`, `verify:review`, `verify:fact-check`, `verify:compliance`, `verify:variations`, `verify:content-studio` |
| MED | [12-media-graphics-and-creatives](feature-docs/02-features/12-media-graphics-and-creatives/01-FEATURE-DETAILS.md) | `server/media/**`, `app/api/content/drafts/[id]/graphics/**`, `app/api/content/drafts/[id]/creative/**`, `lib/visual-brief.ts`, `lib/platforms.ts` | `tests/image-*.test.ts`, `tests/media-*.test.ts`, `tests/logo-overlay.test.ts`, `tests/creative.test.ts`; `pnpm verify:graphics`, `verify:visual-context`, `verify:creative` |
| REV | [13-review-approval-versions-and-trace](feature-docs/02-features/13-review-approval-versions-and-trace/01-FEATURE-DETAILS.md) | `app/api/review/[kind]/[id]/**`, `server/review/*`, `server/approval/approval.service.ts`, `server/versions/*`, `lib/approval.ts`, `lib/versions.ts`, `lib/trace.ts` | `tests/approval*.test.ts`, `tests/versions.test.ts`, `tests/trace.test.ts`, `tests/review-item.test.ts`; `pnpm verify:unified-review`, `verify:approval`, `verify:versions`, `verify:trace` |
| CPN | [14-campaigns-and-content-planner](feature-docs/02-features/14-campaigns-and-content-planner/01-FEATURE-DETAILS.md) | `app/api/campaigns/**`, `app/api/planner/route.ts`, `server/campaigns/*`, `server/planner/*`, `lib/execution-gate.ts` | `tests/campaign-plan.test.ts`, `tests/campaign-status.test.ts`, `tests/planner-*.test.ts`; `pnpm verify:planner`, `verify:creation` |
| LEAD | [15-leads-and-outreach](feature-docs/02-features/15-leads-and-outreach/01-FEATURE-DETAILS.md) | `app/api/leads/**`, `app/api/outreach/**`, `server/leads/discovery/*`, `server/outreach/*` | `tests/lead-dedup.test.ts`, `tests/lead-scoring.test.ts`, `tests/outreach-*.test.ts`; `pnpm verify:approval`, `verify:permissions` |
| ENG | [16-engagement-copilot](feature-docs/02-features/16-engagement-copilot/01-FEATURE-DETAILS.md) | `app/api/engagement/**`, `app/api/extension/engagement/draft/route.ts`, `server/engagement/*`, `extension/content/linkedin.js` | `tests/extension-permissions.test.ts`; `pnpm verify:pages` |
| EXT | [17-chrome-extension](feature-docs/02-features/17-chrome-extension/01-FEATURE-DETAILS.md) | `extension/*`, `app/api/extension/**`, `server/extension/*`, `lib/extension-auth.ts`, `scripts/package-extension.mjs` | `tests/extension-token.test.ts`, `tests/extension-permissions.test.ts`; `pnpm verify:approval` |
| MEM | [18-marketing-memory-and-analytics](feature-docs/02-features/18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md) | `app/api/memory/**`, `app/api/analytics/**`, `server/memory/*`, `server/analytics/*` | `tests/marketing-memory.test.ts`; `pnpm verify:pages` |
| CONN | [19-connections-and-connectors](feature-docs/02-features/19-connections-and-connectors/01-FEATURE-DETAILS.md) | `app/api/connectors/**`, `app/api/connections/**`, `app/api/meta/**`, `server/connectors/*`, `server/connections/*`, `lib/crypto.ts`, `lib/pkce.ts` | `tests/connection-manager.test.ts`, `tests/oauth-pkce.test.ts`, `tests/meta*.test.ts`; `pnpm verify:connections`, `verify:meta`, `verify:sandbox` |
| EXE | [20-publishing-execution-and-scheduling](feature-docs/02-features/20-publishing-execution-and-scheduling/01-FEATURE-DETAILS.md) | `server/content/publish.service.ts`, `server/execution/*`, `lib/execution-state.ts`, `server/media/publishers/*`, `app/api/executions/**`, `app/api/cron/publish/route.ts` | `tests/execution-*.test.ts`, `tests/scheduler.test.ts`, `tests/publishing.test.ts`, `tests/failure-recovery.test.ts`; `pnpm verify:execution`, `verify:scheduler`, `verify:publishing`, `verify:failure-recovery`, `verify:sandbox` |
| WA | [21-whatsapp-assistant](feature-docs/02-features/21-whatsapp-assistant/01-FEATURE-DETAILS.md) | `app/api/webhooks/whatsapp/route.ts`, `app/api/whatsapp/**`, `server/whatsapp/*`, `app/api/cron/whatsapp/route.ts` | `tests/whatsapp*.test.ts`; `pnpm verify:whatsapp`, `verify:whatsapp-link`, `verify:whatsapp-agent`, `verify:whatsapp-social`, `load:whatsapp` |
| BIL | [22-billing-and-plans](feature-docs/02-features/22-billing-and-plans/01-FEATURE-DETAILS.md) | `app/api/billing/*`, `app/api/webhooks/stripe/route.ts`, `server/billing/*`, `lib/stripe.ts` | `tests/billing.test.ts`, `tests/tenant-isolation.test.ts` (no verify script) |
| AI | [23-ai-layer](feature-docs/02-features/23-ai-layer/01-FEATURE-DETAILS.md) | `server/ai/claude.ts` | `tests/claude.test.ts`, `tests/ai-completion.test.ts`, `tests/ai-quota.test.ts`, `tests/model-tiers.test.ts`, `tests/model-json.test.ts` |
| PLT | [24-platform-jobs-and-deployment](feature-docs/02-features/24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md) | `server/jobs/*`, `app/api/jobs/**`, `app/api/cron/*`, `lib/http.ts`, `lib/crypto.ts`, `lib/env-check.ts`, `lib/cron-auth.ts`, `next.config.mjs`, `vercel.json`, `scripts/migrate-deploy.mjs` | `tests/job-*.test.ts`, `tests/env-check.test.ts`, `tests/crypto.test.ts`, `tests/graph-base.test.ts`; `pnpm env:check`, `verify:access`, `verify:scheduler` |
| NAV | [25-navigation-and-design-system](feature-docs/02-features/25-navigation-and-design-system/01-FEATURE-DETAILS.md) | `app/dashboard/{layout,loading,error}.tsx`, `components/dashboard/*`, `lib/nav.ts`, `components/ui/*`, `tailwind.config.ts` | `tests/nav-clarity.test.ts`; `pnpm verify:responsive`, `verify:pages` |

---

## Appendix A. Requirement counts by area and status

### A.1 Functional requirements

| Area | Section | Total | Implemented | Partially implemented | Blocked (external) | Not implemented |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH | 3.1 | 14 | 12 | 1 | 0 | 1 |
| WS | 3.2 | 13 | 12 | 0 | 0 | 1 |
| ONB | 3.3 | 12 | 10 | 1 | 0 | 1 |
| KB | 3.4 | 15 | 13 | 1 | 0 | 1 |
| BC | 3.5 | 15 | 15 | 0 | 0 | 0 |
| TRD | 3.6 | 15 | 13 | 2 | 0 | 0 |
| CMP | 3.7 | 14 | 11 | 2 | 1 | 0 |
| OPP | 3.8 | 16 | 15 | 1 | 0 | 0 |
| REC | 3.9 | 23 | 22 | 1 | 0 | 0 |
| HOME | 3.10 | 17 | 14 | 3 | 0 | 0 |
| CNT | 3.11 | 24 | 24 | 0 | 0 | 0 |
| MED | 3.12 | 17 | 16 | 1 | 0 | 0 |
| REV | 3.13 | 21 | 20 | 0 | 0 | 1 |
| CPN | 3.14 | 15 | 14 | 1 | 0 | 0 |
| LEAD | 3.15 | 15 | 14 | 1 | 0 | 0 |
| ENG | 3.16 | 12 | 10 | 0 | 0 | 2 |
| EXT | 3.17 | 14 | 13 | 1 | 0 | 0 |
| MEM | 3.18 | 14 | 13 | 1 | 0 | 0 |
| CONN | 3.19 | 15 | 14 | 0 | 1 | 0 |
| EXE | 3.20 | 16 | 13 | 1 | 2 | 0 |
| WA | 3.21 | 16 | 13 | 2 | 0 | 1 |
| BIL | 3.22 | 12 | 11 | 1 | 0 | 0 |
| AI | 3.23 | 12 | 11 | 0 | 0 | 1 |
| PLT | 3.24 | 16 | 13 | 3 | 0 | 0 |
| NAV | 3.25 | 12 | 10 | 0 | 0 | 2 |
| **Total** | | **385** | **346** | **24** | **4** | **11** |

### A.2 Non-functional requirements

| Category | Total | Implemented | Partially implemented | Blocked (external) | Not implemented |
| --- | --- | --- | --- | --- | --- |
| Performance (NFR-PERF) | 9 | 8 | 1 | 0 | 0 |
| Security (NFR-SEC) | 14 | 11 | 3 | 0 | 0 |
| Privacy and data protection (NFR-PRIV) | 8 | 6 | 2 | 0 | 0 |
| Reliability and availability (NFR-REL) | 9 | 8 | 1 | 0 | 0 |
| Scalability (NFR-SCAL) | 5 | 4 | 1 | 0 | 0 |
| Maintainability (NFR-MAINT) | 6 | 6 | 0 | 0 | 0 |
| Usability and accessibility (NFR-USE) | 5 | 4 | 0 | 0 | 1 |
| Portability and deployment (NFR-PORT) | 5 | 5 | 0 | 0 | 0 |
| Auditability (NFR-AUD) | 5 | 5 | 0 | 0 | 0 |
| Compliance (NFR-COMP) | 8 | 8 | 0 | 0 | 0 |
| **Total** | **74** | **65** | **8** | **0** | **1** |

### A.3 Summary

| Set | Total | Implemented | Partially implemented | Blocked (external) | Not implemented |
| --- | --- | --- | --- | --- | --- |
| Functional | 385 | 346 | 24 | 4 | 11 |
| Non-functional | 74 | 65 | 8 | 0 | 1 |
| **All** | **459** | **411** | **32** | **4** | **12** |
