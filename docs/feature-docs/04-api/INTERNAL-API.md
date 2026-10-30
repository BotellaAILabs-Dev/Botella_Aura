# Botella Aura — Internal API Reference

Every HTTP endpoint the Aura web app serves: **181 route files, 250 operations**, grouped by feature. Descriptions are taken from each route's own documentation comment, so they match the code.

_Generated from the git history and source code on 30 Oct 2026._

## Conventions

| Topic | Rule |
| --- | --- |
| Base URL | `https://<your-host>` (local: `http://localhost:3000`). All paths below start with `/api`. |
| Authentication | NextAuth session cookie (JWT). `requireActiveCompany()` resolves the user **and** the active workspace from the user's own memberships; a forged workspace cookie is ignored. |
| Other auth types | Chrome extension: `Authorization: Bearer <extension token>`. Cron: `Authorization: Bearer $CRON_SECRET`. Webhooks: provider signature (Stripe `stripe-signature`, WhatsApp `X-Hub-Signature-256`, Meta `signed_request`). |
| Permissions | Role → permission matrix in `lib/rbac.ts` (below). Writes check a permission; a refusal is **403**. |
| Validation | Every body is parsed with a Zod schema from `lib/validations/*`. Failure is **422** `{ error: 'Validation failed', details: { field: [messages] } }`. |
| Success envelope | `jsonOk(data)` → the JSON object itself, status 200 (or 201). |
| Error envelope | `jsonError(message, status, details?)` → `{ error, details? }`. |
| Status codes | 400 bad input · 401 not signed in · 403 role not permitted · 404 not found **or another workspace's id** (nothing is revealed) · 409 stale revision / conflict · 422 validation or business rule refused · 429 rate limited · 503 AI provider unavailable. |
| Ids from other workspaces | Always answered 404, never 403, so existence is not leaked. |

### Role → permission matrix (`lib/rbac.ts`)

| Permission | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- |
| `company:update` | ✓ | ✓ | | |
| `company:delete` | ✓ | | | |
| `company:manageBilling` | ✓ | | | |
| `members:invite` | ✓ | ✓ | | |
| `members:remove` | ✓ | ✓ | | |
| `linkedin:connect` | ✓ | ✓ | | |
| `content:create` | ✓ | ✓ | ✓ | |
| `content:approve` | ✓ | ✓ | | |
| `content:publish` | ✓ | ✓ | | |

## Index

| Feature | Routes |
| --- | --- |
| [Authentication & Accounts](#01-authentication--accounts) | 4 |
| [Workspaces, Team & Roles (RBAC)](#02-workspaces-team--roles-rbac) | 14 |
| [Onboarding & Guided Setup](#03-onboarding--guided-setup) | 1 |
| [Knowledge Base & Brand Voice](#04-knowledge-base--brand-voice) | 3 |
| [Business Context & About My Business](#05-business-context--about-my-business) | 3 |
| [Trend Insights](#06-trend-insights) | 2 |
| [Competitor Intelligence](#07-competitor-intelligence) | 4 |
| [Signals & Opportunity Detection](#08-signals--opportunity-detection) | 9 |
| [Recommendations & Aura Suggests](#09-recommendations--aura-suggests) | 16 |
| [Aura Home, What Matters Now & Weekly Briefing](#10-aura-home-what-matters-now--weekly-briefing) | 2 |
| [Content Studio (Generation, Brief, Formats, Quality)](#11-content-studio-generation-brief-formats-quality) | 21 |
| [Media, Graphics & Marketing Creatives](#12-media-graphics--marketing-creatives) | 13 |
| [Review, Approval, Versions & Traceability](#13-review-approval-versions--traceability) | 3 |
| [Campaigns & Content Planner](#14-campaigns--content-planner) | 4 |
| [Lead Discovery & Outreach Intelligence](#15-lead-discovery--outreach-intelligence) | 16 |
| [Engagement Copilot](#16-engagement-copilot) | 2 |
| [Chrome Extension (Human Action Layer)](#17-chrome-extension-human-action-layer) | 8 |
| [Marketing Memory & Analytics](#18-marketing-memory--analytics) | 4 |
| [Connections, Connectors & OAuth](#19-connections-connectors--oauth) | 18 |
| [Publishing, Execution Engine & Scheduling](#20-publishing-execution-engine--scheduling) | 4 |
| [WhatsApp AI Assistant](#21-whatsapp-ai-assistant) | 8 |
| [Billing, Plans & Entitlements](#22-billing-plans--entitlements) | 4 |
| [Platform: Jobs, Cron, Security & Deployment](#24-platform-jobs-cron-security--deployment) | 18 |

## 01 Authentication & Accounts

Feature docs: [../02-features/01-authentication-and-accounts/](../02-features/01-authentication-and-accounts/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/auth/*nextauth` | Public (no session) — see route for its own checks | — |
| POST | `/api/auth/forgot-password` | Public (no session) — see route for its own checks | — |
| POST | `/api/auth/reset-password` | Public (no session) — see route for its own checks | — |
| POST | `/api/auth/signup` | Public (no session) — see route for its own checks | — |

### `GET | POST` /api/auth/*nextauth

- **Source:** [`app/api/auth/[...nextauth]/route.ts`](../../../app/api/auth/[...nextauth]/route.ts)
- **Auth:** Public (no session) — see route for its own checks

```text
NextAuth catch-all route (App Router). Handles sign-in, callbacks (incl.
Google OAuth, and LinkedIn in Sprint 2), sign-out, and session endpoints.
```

### `POST` /api/auth/forgot-password

- **Source:** [`app/api/auth/forgot-password/route.ts`](../../../app/api/auth/forgot-password/route.ts)
- **Auth:** Public (no session) — see route for its own checks
- **Request validation:** `forgotPasswordSchema`

```text
POST /api/auth/forgot-password — begin the reset flow.
Always responds 200 with the same message whether or not the email exists,
so the endpoint cannot be used to enumerate accounts. When a user matches, a
single-use token is created and the reset link is "sent" (console transport
in Sprint 1 — see lib/email.ts).
```

### `POST` /api/auth/reset-password

- **Source:** [`app/api/auth/reset-password/route.ts`](../../../app/api/auth/reset-password/route.ts)
- **Auth:** Public (no session) — see route for its own checks
- **Request validation:** `resetPasswordSchema`

```text
POST /api/auth/reset-password — complete the reset with a valid token.
Rate-limited (Sprint 6). The token service enforces single-use + expiry.
```

### `POST` /api/auth/signup

- **Source:** [`app/api/auth/signup/route.ts`](../../../app/api/auth/signup/route.ts)
- **Auth:** Public (no session) — see route for its own checks
- **Request validation:** `signUpSchema`

```text
POST /api/auth/signup — create a local email/password account.
Rate-limited (Sprint 6) + Zod-validated (NON-NEGOTIABLE #2) before any DB
access, then delegates to the user service (hashes password + audits).
```

## 02 Workspaces, Team & Roles (RBAC)

Feature docs: [../02-features/02-workspaces-team-and-roles/](../02-features/02-workspaces-team-and-roles/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/companies` | Signed-in session | — |
| PATCH | `/api/companies/:id` | Signed-in session + active workspace | — |
| PATCH | `/api/company/audience` | Signed-in session + active workspace | `company:update` |
| PATCH | `/api/company/autopilot` | Signed-in session + active workspace | `content:approve` |
| PATCH | `/api/company/brand` | Signed-in session + active workspace | `company:update` |
| GET · PATCH | `/api/company/contact` | Signed-in session + active workspace | `company:update` |
| PATCH | `/api/company/formats` | Signed-in session + active workspace | `company:update` |
| POST | `/api/company/logo` | Signed-in session + active workspace | `company:update` |
| GET · PATCH | `/api/company/timezone` | Signed-in session + active workspace | `company:update` |
| POST | `/api/invitations/accept` | Signed-in session | — |
| GET · POST | `/api/settings/email` | Signed-in session + active workspace | `company:update` |
| GET · POST | `/api/team/invitations` | Signed-in session + active workspace | `members:invite` |
| DELETE | `/api/team/invitations/:id` | Signed-in session + active workspace | `members:invite` |
| PATCH · DELETE | `/api/team/members/:userId` | Signed-in session + active workspace | `members:remove` |

### `GET | POST` /api/companies

- **Source:** [`app/api/companies/route.ts`](../../../app/api/companies/route.ts)
- **Auth:** Signed-in session
- **Request validation:** `createCompanySchema`

```text
Guard against accidentally creating the same workspace twice.

Slugs are uniquified automatically, so a repeated submit — a double
click, a back-navigation, a retried onboarding — silently produced a
second workspace with an identical name. The user then has two
indistinguishable entries in the switcher, and their data is split
across both with no hint as to which is which.

`confirmDuplicate` lets someone who genuinely wants a second workspace
of the same name proceed, so this blocks the accident without blocking
the intent.
```

### `PATCH` /api/companies/:id

- **Source:** [`app/api/companies/[id]/route.ts`](../../../app/api/companies/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `updateCompanySchema`

```text
PATCH /api/companies/:id — update a company profile (settings page).
RBAC: only OWNER/ADMIN may edit company settings (see lib/rbac.ts). The
requireCompanyRole guard throws ForbiddenError -> 403 for MEMBERs.
```

### `PATCH` /api/company/audience

- **Source:** [`app/api/company/audience/route.ts`](../../../app/api/company/audience/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `marketingProfileSchema`

```text
PATCH /api/company/audience — who this workspace markets to, and what it is
trying to achieve.

This is the single most valuable thing a user can tell Aura: the content
generator reads it on every draft (server/content/audience.ts), and the
planner uses it to pre-fill the brief. Same active-company scoping and same
permission as the brand route.
```

### `PATCH` /api/company/autopilot

- **Source:** [`app/api/company/autopilot/route.ts`](../../../app/api/company/autopilot/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `settingsSchema`

```text
PATCH /api/company/autopilot — what Aura is allowed to do on its own.

Turning on automatic publishing is the single most consequential setting in
the product: it is the one that can put something in public without a person
seeing it first. So it takes the strictest permission available here
('content:approve' — the same one a human needs to approve a post, because
that is exactly the authority being delegated), and every change is written
to the audit log with who made it.
```

### `PATCH` /api/company/brand

- **Source:** [`app/api/company/brand/route.ts`](../../../app/api/company/brand/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `brandAssetsSchema`

```text
PATCH /api/company/brand — the workspace's logo and colour palette.

Scoped to the caller's ACTIVE company rather than an id in the path, so there
is no company id to tamper with; the same reason the connector routes work
this way. Editing brand assets is a company settings change, so it takes the
same 'company:update' permission as the rest of settings.
```

### `GET | PATCH` /api/company/contact

- **Source:** [`app/api/company/contact/route.ts`](../../../app/api/company/contact/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `contactFactsSchema`

```text
The business's contact facts (address, phone, contact email), offered to
posts as pre-approved details (lib/post-details.ts).

GET   — the facts a post may use, including the website.
PATCH — { address?, phone?, contactEmail? } (owners and admins); an empty
        value removes it.
```

### `PATCH` /api/company/formats

- **Source:** [`app/api/company/formats/route.ts`](../../../app/api/company/formats/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `contentFormatsSchema`

```text
PATCH /api/company/formats — which content formats this workspace uses.

Narrowing here is a presentation choice, not a permission: it decides what
Content Studio offers, and the generate route enforces the same list so a
disabled format cannot be reached by posting to the API directly. Same
active-company scoping and permission as the audience and brand routes.
```

### `POST` /api/company/logo

- **Source:** [`app/api/company/logo/route.ts`](../../../app/api/company/logo/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/company/logo — upload the workspace logo (multipart `file`).

`runtime = nodejs` because this handles Buffers. The platform's own body-size
cap (~4.5 MB on Vercel) applies to multipart before this handler runs, which
is why the error below names a size rather than failing generically — the
same reasoning as the graphics upload route.
```

### `GET | PATCH` /api/company/timezone

- **Source:** [`app/api/company/timezone/route.ts`](../../../app/api/company/timezone/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
GET   /api/company/timezone — the workspace's timezone (any member).
PATCH /api/company/timezone { timezone } — change it (OWNER/ADMIN).

Changing the zone never moves a post already scheduled: its instant is
kept, and it is shown in the new zone (the response says how many).
```

### `POST` /api/invitations/accept

- **Source:** [`app/api/invitations/accept/route.ts`](../../../app/api/invitations/accept/route.ts)
- **Auth:** Signed-in session
- **Request validation:** `acceptInviteSchema`

```text
POST /api/invitations/accept — the logged-in user accepts an invite token.
```

### `GET | POST` /api/settings/email

- **Source:** [`app/api/settings/email/route.ts`](../../../app/api/settings/email/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
Email delivery diagnostics.

GET  — is a provider configured, which one, and what's missing.
POST — actually send a test message to the signed-in user and report the
       real provider response.

This exists because "the UI said Mail Sent but nothing arrived" is
unanswerable without a way to see the transport truth from inside the app.
```

### `GET | POST` /api/team/invitations

- **Source:** [`app/api/team/invitations/route.ts`](../../../app/api/team/invitations/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `members:invite`
- **Request validation:** `inviteMemberSchema`

```text
GET /api/team/invitations — pending invites for the active company.
```

### `DELETE` /api/team/invitations/:id

- **Source:** [`app/api/team/invitations/[id]/route.ts`](../../../app/api/team/invitations/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `members:invite`

```text
DELETE /api/team/invitations/:id — revoke a pending invite.
```

### `PATCH | DELETE` /api/team/members/:userId

- **Source:** [`app/api/team/members/[userId]/route.ts`](../../../app/api/team/members/[userId]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `members:remove`
- **Request validation:** `updateRoleSchema`

```text
DELETE /api/team/members/:userId — remove a member from the company.
```

## 03 Onboarding & Guided Setup

Feature docs: [../02-features/03-onboarding-and-guided-setup/](../02-features/03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/api/onboarding/preview` | Signed-in session | — |

### `POST` /api/onboarding/preview

- **Source:** [`app/api/onboarding/preview/route.ts`](../../../app/api/onboarding/preview/route.ts)
- **Auth:** Signed-in session
- **Request validation:** `previewSchema`

```text
The sample is written from the real profile, and is told plainly not to
invent anything.

The old prompt passed a name, an optional industry and a tone, then
asked for "a sample post about a recent win or insight". With no facts
to work from the model had to fabricate the win — so the first thing a
new user ever saw Aura write was a confident claim about something their
business had not done. That is worse than no preview: it teaches them,
correctly, not to trust the output.

The platform follows the market too. A LinkedIn post is the right shape
for a business buyer and the wrong one for a consumer brand, which was
hard-coded before.
```

## 04 Knowledge Base & Brand Voice

Feature docs: [../02-features/04-knowledge-base-and-brand-voice/](../02-features/04-knowledge-base-and-brand-voice/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST · PUT | `/api/brand-voice` | Signed-in session + active workspace | — |
| POST | `/api/knowledge/sync` | Signed-in session + active workspace | — |
| POST | `/api/knowledge/upload` | Signed-in session + active workspace | — |

### `GET | POST | PUT` /api/brand-voice

- **Source:** [`app/api/brand-voice/route.ts`](../../../app/api/brand-voice/route.ts)
- **Auth:** Signed-in session + active workspace

```text
POST — (re)generate the brand voice profile from ingested content.
```

### `POST` /api/knowledge/sync

- **Source:** [`app/api/knowledge/sync/route.ts`](../../../app/api/knowledge/sync/route.ts)
- **Auth:** Signed-in session + active workspace

```text
POST /api/knowledge/sync — (re)ingest the active company's website + blog.
```

### `POST` /api/knowledge/upload

- **Source:** [`app/api/knowledge/upload/route.ts`](../../../app/api/knowledge/upload/route.ts)
- **Auth:** Signed-in session + active workspace

```text
POST /api/knowledge/upload — multipart file upload added to the knowledge
base. Uses the Web FormData API (no extra dep).

Accepts the formats business material actually arrives in: .pdf, .docx and
.pptx alongside plain text. A `category` field records WHAT the document is
(pitch deck, brand guidelines, competitor intel...), which decides how
heavily it is weighted at retrieval time and how it is described to the
model — see lib/materials.ts.

`unpdf`/pdf.js needs the Node runtime (not Edge). PDF text extraction can be
slow, so we give it more time than the default. Note: serverless platforms
cap request bodies (~4.5 MB on Vercel) — larger files 413 before this runs, so
we surface a clear size hint below.
```

## 05 Business Context & About My Business

Feature docs: [../02-features/05-business-context/](../02-features/05-business-context/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · PATCH | `/api/business-context` | Signed-in session + active workspace | `company:update` |
| GET · POST | `/api/business-context/questions` | Signed-in session + active workspace | `company:update` |
| GET · POST | `/api/business-context/snapshot` | Signed-in session + active workspace | `company:update` |

### `GET | PATCH` /api/business-context

- **Source:** [`app/api/business-context/route.ts`](../../../app/api/business-context/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `businessContextUpdateSchema`

```text
The Business Context over HTTP, scoped to the caller's active workspace.

GET   — the resolved context: every field, where each value came from, which
        values conflicted, what is missing, and `meta.revision`.
PATCH — `{ patch, expectedRevision? }`. Validated by the patch schema and
        the update rules; 422 names each refused field, 409 means the
        workspace changed since `expectedRevision` was read.

No knowledge retrieval here (that needs a query and belongs to the workflow
asking), so `knowledge.passages` is always empty.
```

### `GET | POST` /api/business-context/questions

- **Source:** [`app/api/business-context/questions/route.ts`](../../../app/api/business-context/questions/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `actionSchema`, `querySchema`

```text
Questions Aura has about the business.

GET  ?workflow=content|opportunity|…&limit=3&markAsked=1
     The questions worth asking now — critical first, never one the user
     dismissed, put off, or has been asked too often. `markAsked=1` records
     that they were shown (counted at most once per 12 hours).
POST { key, action: 'answer', answer: { value } | { confirm: true } }
     { key, action: 'snooze' | 'dismiss' }
     Answering updates the Business Context through the same validated
     write path as every other edit. Returns the next questions.
```

### `GET | POST` /api/business-context/snapshot

- **Source:** [`app/api/business-context/snapshot/route.ts`](../../../app/api/business-context/snapshot/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `querySchema`

```text
The Business Context Snapshot for the active workspace.

GET  ?view=content|recommendation|opportunity|planning|outreach|engagement|full
     &strict=1  — the current snapshot for that workflow, rebuilt first if
     any source changed or it has expired. `status` and `reason` say which.
POST { view?, strict? } — rebuild now, whatever the stored state. For use
     right after a bulk change, or when someone wants to see it refreshed.
```

## 06 Trend Insights

Feature docs: [../02-features/06-trend-insights/](../02-features/06-trend-insights/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · PUT | `/api/trends/config` | Signed-in session | — |
| POST | `/api/trends/refresh` | Signed-in session | — |

### `GET | PUT` /api/trends/config

- **Source:** [`app/api/trends/config/route.ts`](../../../app/api/trends/config/route.ts)
- **Auth:** Signed-in session
- **Request validation:** `updateTrendConfigSchema`

```text
PUT /api/trends/config — update the active company's trend configuration.
```

### `POST` /api/trends/refresh

- **Source:** [`app/api/trends/refresh/route.ts`](../../../app/api/trends/refresh/route.ts)
- **Auth:** Signed-in session

```text
POST /api/trends/refresh — manual "Refresh digest" trigger for the active
company. Same idempotent generation as the cron job, scoped to one company.

Generation fans out to every configured source and makes two model calls, so
it regularly runs past the platform's default 10-15s function budget. Without
the longer budget below, the request was killed mid-flight and the UI showed a
bare "Something went wrong" — the exact symptom reported in review. Every
other long-running route in the app already declares this.
```

## 07 Competitor Intelligence

Feature docs: [../02-features/07-competitor-intelligence/](../02-features/07-competitor-intelligence/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/competitors` | Signed-in session + active workspace | `company:update` |
| PATCH · DELETE | `/api/competitors/:id` | Signed-in session + active workspace | `company:update` |
| POST | `/api/competitors/:id/track` | Signed-in session + active workspace | `company:update` |
| POST | `/api/competitors/reports` | Signed-in session + active workspace | `company:update` |

### `GET | POST` /api/competitors

- **Source:** [`app/api/competitors/route.ts`](../../../app/api/competitors/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `createCompetitorSchema`

```text
POST /api/competitors — add a competitor (OWNER/ADMIN).
```

### `PATCH | DELETE` /api/competitors/:id

- **Source:** [`app/api/competitors/[id]/route.ts`](../../../app/api/competitors/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `updateCompetitorSchema`

```text
DELETE /api/competitors/:id — remove a competitor (OWNER/ADMIN).
```

### `POST` /api/competitors/:id/track

- **Source:** [`app/api/competitors/[id]/track/route.ts`](../../../app/api/competitors/[id]/track/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/competitors/:id/track — run a tracking pass for one competitor now.
```

### `POST` /api/competitors/reports

- **Source:** [`app/api/competitors/reports/route.ts`](../../../app/api/competitors/reports/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/competitors/reports — "Generate now" (for demos).
Runs a fresh tracking pass across all competitors, then (re)generates this
week's report. OWNER/ADMIN only.
```

## 08 Signals & Opportunity Detection

Feature docs: [../02-features/08-signals-and-opportunities/](../02-features/08-signals-and-opportunities/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/advisor` | Signed-in session + active workspace | `content:create` |
| GET | `/api/opportunities` | Signed-in session + active workspace | — |
| GET | `/api/opportunities/:id` | Signed-in session + active workspace | — |
| GET | `/api/opportunities/:id/handoff` | Signed-in session + active workspace | — |
| GET · POST | `/api/opportunities/:id/recommendations` | Signed-in session + active workspace | `company:update` |
| POST | `/api/opportunities/:id/status` | Signed-in session + active workspace | `company:update` |
| POST | `/api/opportunities/detect` | Signed-in session + active workspace | `company:update` |
| GET | `/api/signals` | Signed-in session + active workspace | — |
| POST | `/api/signals/refresh` | Signed-in session + active workspace | `company:update` |

### `GET | POST` /api/advisor

- **Source:** [`app/api/advisor/route.ts`](../../../app/api/advisor/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
GET /api/advisor — the latest advisor report (no generation).
```

### `GET` /api/opportunities

- **Source:** [`app/api/opportunities/route.ts`](../../../app/api/opportunities/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `querySchema`

```text
GET /api/opportunities?status=DETECTED,REVIEWED&limit=50

The workspace's opportunities with their evidence, open ones first by
priority. Ones past their relevance window are expired before listing.
```

### `GET` /api/opportunities/:id

- **Source:** [`app/api/opportunities/[id]/route.ts`](../../../app/api/opportunities/[id]/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/opportunities/:id — one opportunity, its evidence and its full lifecycle history.
```

### `GET` /api/opportunities/:id/handoff

- **Source:** [`app/api/opportunities/[id]/handoff/route.ts`](../../../app/api/opportunities/[id]/handoff/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/opportunities/:id/handoff

What this opportunity hands a recommendation (lib/recommendation-handoff.ts):
the opportunity, its assessment, its evidence (marked current or not), the
business context it relies on, and how it was detected — plus whether it
can be recommended now, and why not. The input contract for the Sprint 8
recommendation engine.
```

### `GET | POST` /api/opportunities/:id/recommendations

- **Source:** [`app/api/opportunities/[id]/recommendations/route.ts`](../../../app/api/opportunities/[id]/recommendations/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
GET  /api/opportunities/:id/recommendations — recommendations made from it.
POST /api/opportunities/:id/recommendations { title?, action?, rationale?, … }

Generate a recommendation from this opportunity with the recommendation
engine (server/recommendations/engine.service.ts): it picks the action that
fits the business now, writes it, assesses it and checks it is supported.
Any field sent replaces the engine's. Returns the recommendation and the
generation report (chosen action, alternatives, flags). 422 with the
reasons if the data does not support any recommendation; 409 if one is
already in play.
```

### `POST` /api/opportunities/:id/status

- **Source:** [`app/api/opportunities/[id]/status/route.ts`](../../../app/api/opportunities/[id]/status/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
POST /api/opportunities/:id/status { status, note? }

Move an opportunity through its lifecycle. Only allowed transitions succeed
(409 otherwise, or if someone else changed it first); every change is kept
in its history with who made it and why.
```

### `POST` /api/opportunities/detect

- **Source:** [`app/api/opportunities/detect/route.ts`](../../../app/api/opportunities/detect/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/opportunities/detect — refresh signals and run opportunity
detection now: the deterministic rules (lib/opportunity-detection.ts), then
AI-assisted detection for what the rules cannot judge
(lib/ai-opportunity-detection.ts). Returns what each found and recorded,
what was suppressed or rejected, and why.

`?ai=0` runs the rules only. AI detection failing never fails the request:
its status and reason are reported under `ai`.

Then Aura writes suggestions for open opportunities that have none
(`suggestions`: what it created and what the guardrails skipped, and why).
```

### `GET` /api/signals

- **Source:** [`app/api/signals/route.ts`](../../../app/api/signals/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `querySchema`

```text
GET /api/signals?source=TRENDS,COMPETITORS&min=MEDIUM&relevant=1&limit=100

Normalised signals from every Aura source, newest first. Expired ones are
left out unless `expired=1`.
```

### `POST` /api/signals/refresh

- **Source:** [`app/api/signals/refresh/route.ts`](../../../app/api/signals/refresh/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/signals/refresh — gather signals from every source now.
Idempotent: running it twice stores nothing new.
```

## 09 Recommendations & Aura Suggests

Feature docs: [../02-features/09-recommendations-and-aura-suggests/](../02-features/09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/api/recommendations` | Signed-in session + active workspace | — |
| GET · PATCH | `/api/recommendations/:id` | Signed-in session + active workspace | `company:update` |
| GET | `/api/recommendations/:id/brief` | Signed-in session + active workspace | — |
| GET | `/api/recommendations/:id/context` | Signed-in session + active workspace | — |
| GET · POST | `/api/recommendations/:id/creation` | Signed-in session + active workspace | `company:update`, `content:create` |
| POST | `/api/recommendations/:id/decision` | Signed-in session + active workspace | `company:update` |
| GET | `/api/recommendations/:id/handoff` | Signed-in session + active workspace | — |
| GET | `/api/recommendations/:id/history` | Signed-in session + active workspace | — |
| GET | `/api/recommendations/:id/quality` | Signed-in session + active workspace | — |
| POST | `/api/recommendations/:id/snooze` | Signed-in session + active workspace | `company:update` |
| POST | `/api/recommendations/:id/status` | Signed-in session + active workspace | `company:update` |
| POST | `/api/recommendations/generate` | Signed-in session + active workspace | `company:update` |
| GET | `/api/recommendations/history` | Signed-in session + active workspace | — |
| POST | `/api/recommendations/presented` | Signed-in session + active workspace | `content:create` |
| GET | `/api/recommendations/readiness` | Signed-in session + active workspace | — |
| GET | `/api/recommendations/surface` | Signed-in session + active workspace | — |

### `GET` /api/recommendations

- **Source:** [`app/api/recommendations/route.ts`](../../../app/api/recommendations/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `querySchema`

```text
GET /api/recommendations?status=PROPOSED,ACCEPTED&opportunityId=…&limit=50

The workspace's recommendations, newest first, each with its evidence and
originating opportunity. Undecided ones past their relevance window are
expired before listing.
```

### `GET | PATCH` /api/recommendations/:id

- **Source:** [`app/api/recommendations/[id]/route.ts`](../../../app/api/recommendations/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `editSchema`

```text
PATCH /api/recommendations/:id { changes, note?, expectedStatus? }

Edit: accept the recommendation with changes (status EDITED). Only
EDITABLE_FIELDS may change — never its evidence, link or assessment. Every
changed field is kept in its history from → to; an edit that changes
nothing is a no-op (`changed: false`).
```

### `GET` /api/recommendations/:id/brief

- **Source:** [`app/api/recommendations/[id]/brief/route.ts`](../../../app/api/recommendations/[id]/brief/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `querySchema`

```text
GET /api/recommendations/:id/brief[?type=&platform=] — the Content Brief
(lib/content-brief.ts, version 1): the source of truth for what Aura is to
create from this recommendation. Every field with its source, what is
required, what is missing and what that means, and whether it can go to
Content Studio. `validation` is the same check run before generation;
`contentRequest` is the Content Studio request for it, ready to post —
null until it validates.

`type` and `platform` stand for the person's choice of format and network.
```

### `GET` /api/recommendations/:id/context

- **Source:** [`app/api/recommendations/[id]/context/route.ts`](../../../app/api/recommendations/[id]/context/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/recommendations/:id/context — the recommendation as it travels
between Aura's modules (lib/recommendation-context.ts): what, why, the
expected outcome, the module that carries it out and the related ones,
each with what to do there and what it receives. Read by the context bar
on any module page opened with `?rec=<id>`.
```

### `GET | POST` /api/recommendations/:id/creation

- **Source:** [`app/api/recommendations/[id]/creation/route.ts`](../../../app/api/recommendations/[id]/creation/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`, `content:create`
- **Request validation:** `bodySchema`

```text
/api/recommendations/:id/creation — creating from a recommendation
(lib/recommendation-creation.ts).

  GET   what "Create" means for it: the workflow, what it creates, whether it
        can happen now (`plan.state`) and why not, with the context any
        creation keeps (`provenance`) and, for content, the Content Studio
        request ready to post (`contentRequest`).
  POST  { module? } — get ready to create: says yes to it if still open
        (owners and admins only, like any decision), or 409 with the plain
        reason it cannot be created from. Returns the same shape, with
        `plan.href` the workflow to open.
```

### `POST` /api/recommendations/:id/decision

- **Source:** [`app/api/recommendations/[id]/decision/route.ts`](../../../app/api/recommendations/[id]/decision/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
POST /api/recommendations/:id/decision { decision, note?, expectedStatus? }

Accept, skip, reject or withdraw a recommendation. Accepting or rejecting
records the same decision on its opportunity; skipping or withdrawing
leaves the opportunity open. Making the same decision twice is a no-op
(`changed: false`); a different one after a decision is 409.
```

### `GET` /api/recommendations/:id/handoff

- **Source:** [`app/api/recommendations/[id]/handoff/route.ts`](../../../app/api/recommendations/[id]/handoff/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/recommendations/:id/handoff — the Recommendation Context Handoff
(lib/recommendation-context-handoff.ts, version 1): everything a content or
marketing brief needs, each value with its source, what is missing and what
that means, and whether it can go ahead (`readiness`). `contentRequest` is
the Content Studio generation request for it, ready to post — null when the
handoff is blocked or names no format.
```

### `GET` /api/recommendations/:id/history

- **Source:** [`app/api/recommendations/[id]/history/route.ts`](../../../app/api/recommendations/[id]/history/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/recommendations/:id/history — everything that happened to one
recommendation, oldest first: each action, from → to status, who (and
whether a person, the engine, the system or its opportunity), when, the
note, and the detail (an edit's field changes, where it was presented).
```

### `GET` /api/recommendations/:id/quality

- **Source:** [`app/api/recommendations/[id]/quality/route.ts`](../../../app/api/recommendations/[id]/quality/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/recommendations/:id/quality — the quality checks run before a
recommendation is presented (lib/recommendation-quality.ts): the verdict
(trusted / needs_review / blocked), each check with its status and reasons,
and the problems and warnings in words.
```

### `POST` /api/recommendations/:id/snooze

- **Source:** [`app/api/recommendations/[id]/snooze/route.ts`](../../../app/api/recommendations/[id]/snooze/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
POST /api/recommendations/:id/snooze { days? } — "Not now".

Hides it from the surfaced list for 1–30 days (default 7), after which it
comes back. 409 if it would stop being relevant while hidden.
```

### `POST` /api/recommendations/:id/status

- **Source:** [`app/api/recommendations/[id]/status/route.ts`](../../../app/api/recommendations/[id]/status/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
POST /api/recommendations/:id/status { status, note?, expectedStatus? }

Move a recommendation through its lifecycle: accept, skip, reject,
withdraw, start, complete. Only allowed moves succeed (409 otherwise, or if
someone else changed it first). Repeating the move it is already in is a
no-op (`changed: false`) — never a second history entry. `expectedStatus`
(the status the person was looking at) refuses an action taken on a stale
screen. Presented, edited and expired are set by Aura or by an edit
(POST …/presented, PATCH …/:id), not here.
```

### `POST` /api/recommendations/generate

- **Source:** [`app/api/recommendations/generate/route.ts`](../../../app/api/recommendations/generate/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/recommendations/generate — "Get Aura's suggestions": run the
recommendation engine over open opportunities that have no suggestion yet
(server/recommendations/autosuggest.service.ts). The engine's guardrails
still decide; what it skips comes back with the reason.
```

### `GET` /api/recommendations/history

- **Source:** [`app/api/recommendations/history/route.ts`](../../../app/api/recommendations/history/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/recommendations/history?outcome=&limit= — previous Aura
recommendations and what the business did with them, newest first
(lib/recommendation-history.ts): outcome, timestamps, who decided, what was
changed or made, the originating opportunity, whether Aura will suggest it
again — plus counts per outcome and the patterns ready for Marketing Memory.
```

### `POST` /api/recommendations/presented

- **Source:** [`app/api/recommendations/presented/route.ts`](../../../app/api/recommendations/presented/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `bodySchema`

```text
POST /api/recommendations/presented { ids, surface?, positions? }

The client shows recommendations to a person and reports which. Each one
never shown before moves GENERATED → PRESENTED, with where and at what rank
in its history; one already shown (or decided) is left alone. Idempotent —
reporting the same view twice records it once. Ids from another business
are ignored. Viewers are read-only: what they see is not recorded (a
recommendation is "presented" to the people who can act on it).
```

### `GET` /api/recommendations/readiness

- **Source:** [`app/api/recommendations/readiness/route.ts`](../../../app/api/recommendations/readiness/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/recommendations/readiness — whether Aura has enough information to
recommend anything (lib/data-readiness.ts): ready / limited / blocked, each
missing piece in words, and the next step for it.
```

### `GET` /api/recommendations/surface

- **Source:** [`app/api/recommendations/surface/route.ts`](../../../app/api/recommendations/surface/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/recommendations/surface?includeHidden=1

The workspace's recommendations in the order to surface them now: each
with its rank, score, band (now / next / later), the factors behind it and
a one-line explanation (lib/recommendation-ranking.ts). Computed on every
read — not a stored ranking. Deferred ones are left out unless asked for.
```

## 10 Aura Home, What Matters Now & Weekly Briefing

Feature docs: [../02-features/10-aura-home-and-briefing/](../02-features/10-aura-home-and-briefing/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST · PATCH | `/api/briefing` | Signed-in session + active workspace | `content:create` |
| GET · POST | `/api/intelligence` | Signed-in session + active workspace | `content:create` |

### `GET | POST | PATCH` /api/briefing

- **Source:** [`app/api/briefing/route.ts`](../../../app/api/briefing/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
POST /api/briefing — run the cycle now ("catch me up").

Deliberately the same code path as the cron, so what a person triggers by
hand and what runs on Monday morning cannot drift apart. `force` re-runs a
week that already ran, which is the point of a manual refresh — and it is
why this is gated on content:create and rate-limited: each run can write
posts and generate images.
```

### `GET | POST` /api/intelligence

- **Source:** [`app/api/intelligence/route.ts`](../../../app/api/intelligence/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
GET /api/intelligence — the latest computed snapshot (no recomputation).
```

## 11 Content Studio (Generation, Brief, Formats, Quality)

Feature docs: [../02-features/11-content-studio/](../02-features/11-content-studio/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST · PUT | `/api/company/compliance` | Signed-in session + active workspace | `company:update` |
| GET · PATCH | `/api/content/drafts/:id` | Signed-in session + active workspace | `content:create` |
| GET | `/api/content/drafts/:id/execution` | Signed-in session + active workspace | — |
| GET · POST · PATCH | `/api/content/drafts/:id/publications` | Signed-in session + active workspace | `content:approve`, `content:publish` |
| POST | `/api/content/drafts/:id/publish` | Signed-in session + active workspace | `content:publish` |
| POST | `/api/content/drafts/:id/queue` | Signed-in session + active workspace | `content:create`, `content:publish` |
| POST | `/api/content/drafts/:id/refine` | Signed-in session + active workspace | `content:create` |
| GET · POST | `/api/content/drafts/:id/review` | Signed-in session + active workspace | `content:create` |
| POST | `/api/content/drafts/:id/schedule` | Signed-in session + active workspace | `content:publish` |
| POST | `/api/content/drafts/:id/status` | Signed-in session + active workspace | — |
| GET | `/api/content/drafts/:id/trace` | Signed-in session + active workspace | — |
| POST | `/api/content/drafts/:id/undo` | Signed-in session + active workspace | `content:create` |
| POST | `/api/content/drafts/:id/variation` | Signed-in session + active workspace | `content:create` |
| POST | `/api/content/drafts/:id/variations` | Signed-in session + active workspace | `content:create` |
| PATCH | `/api/content/drafts/:id/variations/:index` | Public (no session) — see route for its own checks | — |
| POST | `/api/content/drafts/:id/variations/:index/cta-options` | Public (no session) — see route for its own checks | — |
| POST | `/api/content/drafts/:id/variations/:index/revert` | Public (no session) — see route for its own checks | — |
| POST | `/api/content/drafts/:id/variations/:index/rewrite` | Public (no session) — see route for its own checks | — |
| POST | `/api/content/drafts/:id/variations/more` | Public (no session) — see route for its own checks | — |
| POST | `/api/content/drafts/bulk` | Signed-in session + active workspace | — |
| POST | `/api/content/generate` | Signed-in session + active workspace | `content:create` |

### `GET | POST | PUT` /api/company/compliance

- **Source:** [`app/api/company/compliance/route.ts`](../../../app/api/company/compliance/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `compliancePolicySchema`, `testSchema`

```text
The workspace's compliance policy (lib/compliance-policy.ts).

  GET   — the rules in force (the defaults until the workspace saves its own)
  PUT   — save them (owners and admins); every review made under the old
          rules becomes out of date and runs again before approval
  POST  — { action: 'reset' } back to the defaults, or
          { action: 'test', policy?, type, platform?, text, cta? } — check a
          piece of copy against a policy (saved or not) without storing it
```

### `GET | PATCH` /api/content/drafts/:id

- **Source:** [`app/api/content/drafts/[id]/route.ts`](../../../app/api/content/drafts/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `retargetSchema`, `updateDraftSchema`

```text
Retargeting is its own payload shape.

Changing where a post is aimed is not an edit to its content, and must not go
through the body path — that would send an APPROVED draft back to DRAFT for
re-approval just because someone switched the platform selector to preview a
different image format.
```

### `GET` /api/content/drafts/:id/execution

- **Source:** [`app/api/content/drafts/[id]/execution/route.ts`](../../../app/api/content/drafts/[id]/execution/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/content/drafts/:id/execution — the Approval → Execution handoff
(lib/execution-handoff.ts) as it stands now: the structured package the
Execution Engine consumes, re-validated on every read so a connection that
expired since approval shows up here, with what to fix. 404 for another
workspace's draft; `handoff: null` while it has never been approved.
```

### `GET | POST | PATCH` /api/content/drafts/:id/publications

- **Source:** [`app/api/content/drafts/[id]/publications/route.ts`](../../../app/api/content/drafts/[id]/publications/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`, `content:publish`
- **Request validation:** `bodySchema`

```text
GET  /api/content/drafts/:id/publications — what each network would receive,
     whether it can go, and the publishing history.
POST /api/content/drafts/:id/publications { platforms, acknowledged? } —
     "Approve & Publish to Selected Platforms" (server/content/multi-publish.service.ts).

PATCH /api/content/drafts/:id/publications — check this piece's posts a
     network is still processing (an Instagram Reel) and finish any that
     are ready. Only completes what an approver already published.

409 with `code` facts_need_review / review_needs_human: the approver must
vouch for what Aura flagged — resend with acknowledged: true.
```

### `POST` /api/content/drafts/:id/publish

- **Source:** [`app/api/content/drafts/[id]/publish/route.ts`](../../../app/api/content/drafts/[id]/publish/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:publish`

```text
POST /api/content/drafts/:id/publish — publish an APPROVED draft.
RBAC: requires the content:publish permission. Returns a structured result:
`published` (real official-API post), `manual` (copy-for-manual fallback), or
`reconnect`. Never fakes a published state.
```

### `POST` /api/content/drafts/:id/queue

- **Source:** [`app/api/content/drafts/[id]/queue/route.ts`](../../../app/api/content/drafts/[id]/queue/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`, `content:publish`
- **Request validation:** `queueDraftSchema`, `scheduleInputSchema`

```text
POST /api/content/drafts/:id/queue — "Add to queue" from the post composer.

Composes what the user assembled — copy, graphic, platform, time — into the
EXISTING queue: it sets the platform and schedule and moves the draft to
PENDING_APPROVAL. There is no second queue and no second scheduler; the same
`runScheduledPublishes()` cron picks it up once a human approves it.

Requires `content:create`, not `content:publish`. Queueing is asking for
review, and a MEMBER who can draft should be able to ask — the approval that
actually authorises publishing is still gated separately.
```

### `POST` /api/content/drafts/:id/refine

- **Source:** [`app/api/content/drafts/[id]/refine/route.ts`](../../../app/api/content/drafts/[id]/refine/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `refineContentSchema`

```text
POST /api/content/drafts/:id/refine
  { action: 'regenerate' | 'shorten' | 'expand' | 'tone' | 'improve' | 'custom',
    tone?, feedback? }

Rewrite a draft with one click, or follow a custom note ("make it
punchier" — `{ feedback }` alone still works). The previous version is kept
so it can be undone. Returns the draft to DRAFT status (must be re-approved).
```

### `GET | POST` /api/content/drafts/:id/review

- **Source:** [`app/api/content/drafts/[id]/review/route.ts`](../../../app/api/content/drafts/[id]/review/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
The AI Reviewer for one draft (lib/content-review.ts).

  GET  — the stored review, and whether it still describes the draft
  POST — review the draft as it stands now, and store the result

Reviewing never changes the draft's content or status.
```

### `POST` /api/content/drafts/:id/schedule

- **Source:** [`app/api/content/drafts/[id]/schedule/route.ts`](../../../app/api/content/drafts/[id]/schedule/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:publish`
- **Request validation:** `scheduleInputSchema`

```text
POST /api/content/drafts/:id/schedule — schedule an APPROVED draft.

Body: { localTime: "2026-11-02T09:00" } in the workspace's timezone (or with
`timeZone`), or { scheduledFor } as an exact ISO instant. Past, too-soon and
too-far times are refused; a daylight-saving gap/overlap is resolved and
explained in `note`.
```

### `POST` /api/content/drafts/:id/status

- **Source:** [`app/api/content/drafts/[id]/status/route.ts`](../../../app/api/content/drafts/[id]/status/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `bodySchema`

```text
POST /api/content/drafts/:id/status — approve / reject / submit / request
changes. Maps a UI action to a validated state-machine transition; the
service enforces legality + audits every change (the approval backbone).
```

### `GET` /api/content/drafts/:id/trace

- **Source:** [`app/api/content/drafts/[id]/trace/route.ts`](../../../app/api/content/drafts/[id]/trace/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/content/drafts/:id/trace — why this asset exists (lib/trace.ts):
the business context, signals, opportunity, recommendation and brief
behind it, and which version was reviewed and approved — with every id.
```

### `POST` /api/content/drafts/:id/undo

- **Source:** [`app/api/content/drafts/[id]/undo/route.ts`](../../../app/api/content/drafts/[id]/undo/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
POST /api/content/drafts/:id/undo — restore the version before the last
rewrite, variation switch or edit. Re-checks its quality.
```

### `POST` /api/content/drafts/:id/variation

- **Source:** [`app/api/content/drafts/[id]/variation/route.ts`](../../../app/api/content/drafts/[id]/variation/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `bodySchema`

```text
POST /api/content/drafts/:id/variation { index } — switch the draft to
another of the versions it was generated with. Undoable.
```

### `POST` /api/content/drafts/:id/variations

- **Source:** [`app/api/content/drafts/[id]/variations/route.ts`](../../../app/api/content/drafts/[id]/variations/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `bodySchema`

```text
POST /api/content/drafts/:id/variations { kind, tone?, platform? }

Make a variation of a draft (lib/content-variations.ts) — shorter, longer,
another tone, an alternative CTA or headline, or a version for another
channel — added next to the original, never replacing it. Returns the new
version's index; switching to it is POST …/variation { index }.

`kind: 'image'` returns the request for another image (the latest image's
prompt, else one from the visual brief), to post to …/graphics, which
applies the plan's allowance.
```

### `PATCH` /api/content/drafts/:id/variations/:index

- **Source:** [`app/api/content/drafts/[id]/variations/[index]/route.ts`](../../../app/api/content/drafts/[id]/variations/[index]/route.ts)
- **Auth:** Public (no session) — see route for its own checks
- **Request validation:** `patchSchema`

```text
PATCH /api/content/drafts/:id/variations/:index
  { body, baseUpdatedAt? }  — save this version's fields (copy, CTA,
                             hashtags, details)
  { cta, baseUpdatedAt? }   — set only its call to action

Changes this version only. The version in use is the draft itself, so
saving it follows the draft's edit rules (an approved draft goes back to
draft); any other version changes on its own, never the draft.
```

### `POST` /api/content/drafts/:id/variations/:index/cta-options

- **Source:** [`app/api/content/drafts/[id]/variations/[index]/cta-options/route.ts`](../../../app/api/content/drafts/[id]/variations/[index]/cta-options/route.ts)
- **Auth:** Public (no session) — see route for its own checks

```text
POST /api/content/drafts/:id/variations/:index/cta-options

Suggested calls to action for one version — nothing is saved. Suggestions
that bring in a link, number, price or date not already known are dropped.
```

### `POST` /api/content/drafts/:id/variations/:index/revert

- **Source:** [`app/api/content/drafts/[id]/variations/[index]/revert/route.ts`](../../../app/api/content/drafts/[id]/variations/[index]/revert/route.ts)
- **Auth:** Public (no session) — see route for its own checks
- **Request validation:** `bodySchema`

```text
POST /api/content/drafts/:id/variations/:index/revert { baseUpdatedAt? }

Bring back this version's previous text (after an edit or rewrite). Only
this version changes.
```

### `POST` /api/content/drafts/:id/variations/:index/rewrite

- **Source:** [`app/api/content/drafts/[id]/variations/[index]/rewrite/route.ts`](../../../app/api/content/drafts/[id]/variations/[index]/rewrite/route.ts)
- **Auth:** Public (no session) — see route for its own checks
- **Request validation:** `bodySchema`

```text
POST /api/content/drafts/:id/variations/:index/rewrite { instruction? }

Regenerate ONE version (no instruction: a fresh take on the same angle) or
refine it with the person's own instruction. The other versions are not
touched; this version's previous text is kept so it can be reverted.
```

### `POST` /api/content/drafts/:id/variations/more

- **Source:** [`app/api/content/drafts/[id]/variations/more/route.ts`](../../../app/api/content/drafts/[id]/variations/more/route.ts)
- **Auth:** Public (no session) — see route for its own checks
- **Request validation:** `bodySchema`

```text
POST /api/content/drafts/:id/variations/more { count }

Write more recommendations (1–3) from angles not used yet, added next to
the existing versions — none of them is changed or removed, except that a
draft keeps at most 8 versions (the oldest unused go first, never the one
in use).
```

### `POST` /api/content/drafts/bulk

- **Source:** [`app/api/content/drafts/bulk/route.ts`](../../../app/api/content/drafts/bulk/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `bodySchema`

```text
POST /api/content/drafts/bulk — approve/reject multiple drafts at once.
```

### `POST` /api/content/generate

- **Source:** [`app/api/content/generate/route.ts`](../../../app/api/content/generate/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `generateContentSchema`

```text
POST /api/content/generate — generate a new draft from a trend/brief/campaign.
Returns the created draft id so the client can navigate to the detail view.
```

## 12 Media, Graphics & Marketing Creatives

Feature docs: [../02-features/12-media-graphics-and-creatives/](../02-features/12-media-graphics-and-creatives/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/content/drafts/:id/creative` | Signed-in session + active workspace | `content:create` |
| POST | `/api/content/drafts/:id/creative/render` | Signed-in session + active workspace | `content:create` |
| GET · POST | `/api/content/drafts/:id/graphics` | Signed-in session + active workspace | `content:create` |
| POST | `/api/content/drafts/:id/graphics/prompt` | Signed-in session + active workspace | `content:create` |
| GET · DELETE | `/api/content/graphics/:assetId` | Signed-in session + active workspace | `content:create` |
| POST · DELETE | `/api/content/graphics/:assetId/attach` | Signed-in session + active workspace | `content:create` |
| GET | `/api/content/graphics/:assetId/file` | Provider signature verified | — |
| POST | `/api/content/graphics/:assetId/logo` | Signed-in session + active workspace | — |
| POST | `/api/content/graphics/:assetId/refine` | Signed-in session + active workspace | — |
| POST | `/api/content/graphics/:assetId/regenerate` | Signed-in session + active workspace | — |
| GET | `/api/content/graphics/providers` | Signed-in session + active workspace | — |
| POST | `/api/content/graphics/upload` | Signed-in session + active workspace | `content:create` |
| POST | `/api/generate-image` | Signed-in session + active workspace | `content:create` |

### `GET | POST` /api/content/drafts/:id/creative

- **Source:** [`app/api/content/drafts/[id]/creative/route.ts`](../../../app/api/content/drafts/[id]/creative/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Plan entitlement:** `imageGeneration`
- **Request validation:** `generateCreativeSchema`

```text
Marketing creatives for one draft (server/media/creative).

  GET  — the draft's creatives (newest first, with their design), the
         photos that can be reused, the brand defaults, and any run in flight
  POST — { input, keepText? } queue a creative: copy + a new photograph +
         the layout. Returns a job to poll (POST /api/jobs/:id/run, GET
         /api/jobs/:id), like plain graphic generation.

Nothing here publishes: a creative is an image the person attaches, and the
post still needs approval.
```

### `POST` /api/content/drafts/:id/creative/render

- **Source:** [`app/api/content/drafts/[id]/creative/render/route.ts`](../../../app/api/content/drafts/[id]/creative/render/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `renderCreativeSchema`

```text
POST /api/content/drafts/:id/creative/render — { input, keepText }

Re-set a creative's words, layout, format or colours on the photo it
already has (or the brand background), in a second or two. No image is
generated and no AI is asked: the text is used exactly as given.
```

### `GET | POST` /api/content/drafts/:id/graphics

- **Source:** [`app/api/content/drafts/[id]/graphics/route.ts`](../../../app/api/content/drafts/[id]/graphics/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Plan entitlement:** `imageGeneration`
- **Request validation:** `generateGraphicSchema`

```text
Graphics for one draft.

POST does NOT generate inline. Four variations on a provider that returns one
image per call is four sequential round-trips, which outlives a serverless
function budget — the exact failure GenerationJob exists to solve. So this
queues a job and returns immediately; the client kicks
POST /api/jobs/:id/run and polls GET /api/jobs/:id, the same pattern the
trend digest and the monthly planner already use.

Everything that must fail FAST still happens here, before a job exists: the
role check, the rate limit, the plan allowance, and whether any provider is
configured at all. A queued job that was always going to be rejected is a
worse experience than an immediate, specific error.
```

### `POST` /api/content/drafts/:id/graphics/prompt

- **Source:** [`app/api/content/drafts/[id]/graphics/prompt/route.ts`](../../../app/api/content/drafts/[id]/graphics/prompt/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `generateImagePromptSchema`

```text
POST /api/content/drafts/:id/graphics/prompt

Analyse the draft's content and write an image prompt for it. Split from the
generation endpoint on purpose: writing the prompt is cheap and the user
should get to read and edit it before anything is paid for.
```

### `GET | DELETE` /api/content/graphics/:assetId

- **Source:** [`app/api/content/graphics/[assetId]/route.ts`](../../../app/api/content/graphics/[assetId]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
GET — one graphic's metadata (never its bytes; those have their own route).
```

### `POST | DELETE` /api/content/graphics/:assetId/attach

- **Source:** [`app/api/content/graphics/[assetId]/attach/route.ts`](../../../app/api/content/graphics/[assetId]/attach/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `attachGraphicSchema`, `detachGraphicSchema`

```text
Attach / detach a generated graphic to a post.

Both handlers re-read the draft afterwards and return its full media list, so
the composer renders from one authoritative response instead of guessing what
the attachment did to the ordering.
```

### `GET` /api/content/graphics/:assetId/file

- **Source:** [`app/api/content/graphics/[assetId]/file/route.ts`](../../../app/api/content/graphics/[assetId]/file/route.ts)
- **Auth:** Provider signature verified

```text
GET /api/content/graphics/:assetId/file — the image bytes.

Two ways in, and only two:

  1. A signed link (`?exp=&sig=`). Publishing to Instagram means handing
     Meta's servers a URL they can fetch with no session at all, so this path
     exists specifically for that. The signature is HMAC'd over the asset id
     and an expiry, so it cannot be edited to reach a different asset and
     stops working minutes later.

  2. A session that belongs to the asset's company. Membership is checked
     against the asset's OWN companyId rather than the caller's active
     workspace — someone who is a member of two companies should still not be
     able to pull an asset into the wrong one by switching tabs.

Anything else is a 404, not a 403: telling an unauthorised caller that an id
exists is itself a leak.
```

### `POST` /api/content/graphics/:assetId/logo

- **Source:** [`app/api/content/graphics/[assetId]/logo/route.ts`](../../../app/api/content/graphics/[assetId]/logo/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `imageLogoSchema`

```text
POST /api/content/graphics/:assetId/logo { draftId, mode, position, tint }

Change ONE image's logo setting; the result is its next version.
  include — the exact uploaded logo is placed on it (instant, no AI)
  none    — the logo-free image (instant, no AI)
  space   — the image model clears a corner for a logo (queued, counts as
            one image)
If the logo cannot be placed (none uploaded, unreadable), the image is
unchanged and `note` says why.

`tint` recolours the mark for legibility (white on a dark photograph, say).
Its shape and transparency are the uploaded file's; only its ink changes.
A change of tint alone is a real change, so it produces a new version.
```

### `POST` /api/content/graphics/:assetId/refine

- **Source:** [`app/api/content/graphics/[assetId]/refine/route.ts`](../../../app/api/content/graphics/[assetId]/refine/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `refineImageSchema`

```text
POST /api/content/graphics/:assetId/refine { draftId, instruction }

Refine one image with a single natural-language instruction. Queued (an
image model call); the result is this image's next version — the image
itself, the other variants and the post's text are untouched.
```

### `POST` /api/content/graphics/:assetId/regenerate

- **Source:** [`app/api/content/graphics/[assetId]/regenerate/route.ts`](../../../app/api/content/graphics/[assetId]/regenerate/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `bodySchema`

```text
POST /api/content/graphics/:assetId/regenerate { draftId }

Regenerate ONE variant from its original prompt (keeping its logo
setting). The new image is that variant's next version; the others are
not touched.
```

### `GET` /api/content/graphics/providers

- **Source:** [`app/api/content/graphics/providers/route.ts`](../../../app/api/content/graphics/providers/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/content/graphics/providers

What the model selector renders from. Reports every implemented provider with
whether THIS deployment can use it, and names the missing environment
variable when it cannot — the same honesty the Connectors page applies, so an
unconfigured provider reads as "add a key" rather than a dead radio button.

Also returns the workspace's remaining monthly allowance, so the studio can
show what a generation will spend before the user spends it.

Authenticated: the set of configured providers is deployment configuration,
not public information.
```

### `POST` /api/content/graphics/upload

- **Source:** [`app/api/content/graphics/upload/route.ts`](../../../app/api/content/graphics/upload/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `importImageUrlSchema`

```text
POST /api/content/graphics/upload?draftId=… — attach a graphic the user
supplies, instead of generating one.

Two ways in, one pipeline:
  multipart/form-data with `file`  → a file from their machine
  application/json with `url`      → a remote image, downloaded and stored
  … with `kind: "video"`           → a remote MP4/MOV (Instagram Reels and
                                     carousels; up to 100 MB, needs file
                                     storage — server/media/storage.ts)

A file upload that is a video (read from its bytes, not its name) goes the
video way too, within the same body-size cap — larger videos come by URL.

Both land in the same validate → store → persist path as a generated image,
so the resulting asset is indistinguishable downstream: same gallery, same
attachment, same platform validation, same publishing, same extension.

Remote images are COPIED rather than referenced. A post scheduled for next
week cannot depend on someone else's server still serving that file, and
LinkedIn needs the bytes to upload regardless.

`runtime = nodejs` because this handles Buffers; the platform's own body-size
cap (~4.5 MB on Vercel) applies to the multipart path before this runs, which
is why the error below names a size rather than a generic failure.
```

### `POST` /api/generate-image

- **Source:** [`app/api/generate-image/route.ts`](../../../app/api/generate-image/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Plan entitlement:** `imageGeneration`
- **Request validation:** `bodySchema`

```text
POST /api/generate-image — text-to-image across several providers.

WHY THIS ROUTE EXISTS AT ALL
----------------------------
The browser must never hold an image-provider key. A key shipped to the
client is a key published: it appears in the bundle, in devtools, and in any
saved copy of the page. So the browser posts a prompt and a model name here,
this route adds the credential server-side, and only an image comes back.

That is also why every key is read from `process.env` with no NEXT_PUBLIC_
prefix — Next inlines any NEXT_PUBLIC_* value into the client bundle at
build time, which would defeat the whole arrangement.

AUTHENTICATION IS PART OF KEEPING THE KEY PRIVATE
-------------------------------------------------
Hiding a key behind an endpoint anyone can call does not protect it; it just
means the whole internet spends the quota through our server instead of
holding the string. So this requires a signed-in user and is rate limited,
like every other route here that costs money.

AGNES AND GEMINI REUSE THE PROVIDER REGISTRY
--------------------------------------------
Both already exist as tested providers under server/media/providers, with
their own retry, fan-out and error mapping. Re-implementing them inline here
would mean two copies drifting apart — and the drift between the provider
list and the request schema has already caused one user-visible bug. Hugging
Face is handled inline because it is not part of that registry: it returns
raw image bytes rather than the JSON envelope the registry is built around.
```

## 13 Review, Approval, Versions & Traceability

Feature docs: [../02-features/13-review-approval-versions-and-trace/](../02-features/13-review-approval-versions-and-trace/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/api/analytics/traces` | Signed-in session + active workspace | — |
| GET · POST | `/api/review/:kind/:id` | Signed-in session + active workspace | — |
| GET · POST | `/api/review/:kind/:id/versions` | Signed-in session + active workspace | — |

### `GET` /api/analytics/traces

- **Source:** [`app/api/analytics/traces/route.ts`](../../../app/api/analytics/traces/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/analytics/traces?since=ISO&limit=N

For analytics and measurement: every approved or published asset with its
chain ids, flat — business context revision, signals, opportunity,
recommendation, brief, reviewed and approved versions, the approval, the
images, where it was published and its performance snapshots. One row per
asset; join on assetId or traceId.
```

### `GET | POST` /api/review/:kind/:id

- **Source:** [`app/api/review/[kind]/[id]/route.ts`](../../../app/api/review/[kind]/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `actionSchema`, `kindSchema`

```text
The unified review (lib/review-item.ts) for one item of generated work.

  GET   /api/review/:kind/:id — the item: content, asset, context, flags,
        reviewer feedback, and which actions are available
  POST  /api/review/:kind/:id — { action: save | regenerate | submit |
        approve | reject | schedule, … }, delegated to the module's service

kind: content | outreach.
```

### `GET | POST` /api/review/:kind/:id/versions

- **Source:** [`app/api/review/[kind]/[id]/versions/route.ts`](../../../app/api/review/[kind]/[id]/versions/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `kindSchema`, `restoreSchema`

```text
Versions of one item of generated work (lib/versions.ts).

  GET  — every version, newest first: who made it and when, how (generated,
         edited, regenerated, variation, undo, restored), its text, and
         which is the original, the current and the approved one
  POST — { version } make that version current. It comes back as a new
         version, so nothing is overwritten; approved work is reopened.
```

## 14 Campaigns & Content Planner

Feature docs: [../02-features/14-campaigns-and-content-planner/](../02-features/14-campaigns-and-content-planner/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/campaigns` | Signed-in session + active workspace | `content:create` |
| POST | `/api/campaigns/:id/status` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/campaigns/orchestrate` | Signed-in session + active workspace | `company:update`, `content:approve` |
| POST | `/api/planner` | Signed-in session + active workspace | `content:create` |

### `GET | POST` /api/campaigns

- **Source:** [`app/api/campaigns/route.ts`](../../../app/api/campaigns/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `createSchema`

```text
Campaigns — minimal CRUD so Content Studio can tag a draft to a campaign.
Full Campaign Builder UI arrives in a later sprint (model stubbed in Sprint 3).
```

### `POST` /api/campaigns/:id/status

- **Source:** [`app/api/campaigns/[id]/status/route.ts`](../../../app/api/campaigns/[id]/status/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `bodySchema`

```text
POST /api/campaigns/:id/status — pause/resume future task execution.
```

### `POST` /api/campaigns/orchestrate

- **Source:** [`app/api/campaigns/orchestrate/route.ts`](../../../app/api/campaigns/orchestrate/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`, `content:approve`
- **Plan entitlement:** `campaigns`
- **Request validation:** `createCampaignSchema`

```text
POST /api/campaigns/orchestrate — create an orchestrated campaign: generate
the AI day-by-day plan and materialize its task schedule. Gated by the
`campaigns` entitlement (plan limits) and content:approve RBAC.
```

### `POST` /api/planner

- **Source:** [`app/api/planner/route.ts`](../../../app/api/planner/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `planInputsSchema`

```text
POST /api/planner — generate the monthly content calendar from an explicit
brief (business goals, campaign objectives, topics, brand guidelines).
Idempotent per company/month: regenerating replaces that month's plan.
```

## 15 Lead Discovery & Outreach Intelligence

Feature docs: [../02-features/15-leads-and-outreach/](../02-features/15-leads-and-outreach/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/api/leads/:id/irrelevant` | Signed-in session + active workspace | `content:approve` |
| GET · POST | `/api/leads/discovery/profiles` | Signed-in session + active workspace | `content:approve` |
| PATCH · DELETE | `/api/leads/discovery/profiles/:id` | Signed-in session + active workspace | `content:approve` |
| GET | `/api/leads/discovery/profiles/:id/estimate` | Signed-in session + active workspace | — |
| POST | `/api/leads/discovery/profiles/:id/run` | Signed-in session + active workspace | `content:approve` |
| GET · PUT | `/api/outreach/config` | Signed-in session + active workspace | `company:update` |
| POST | `/api/outreach/detect` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/outreach/from-recommendation` | Signed-in session + active workspace | `company:update`, `content:approve` |
| GET · POST | `/api/outreach/leads` | Signed-in session + active workspace | `content:approve` |
| PATCH · DELETE | `/api/outreach/leads/:id` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/outreach/leads/:id/draft` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/outreach/leads/send-to-outreach` | Signed-in session + active workspace | `content:approve` |
| PATCH | `/api/outreach/messages/:id` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/outreach/messages/:id/outcome` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/outreach/messages/:id/status` | Signed-in session + active workspace | `content:approve` |
| GET · POST | `/api/outreach/messages/bulk` | Signed-in session + active workspace | `content:approve` |

### `POST` /api/leads/:id/irrelevant

- **Source:** [`app/api/leads/[id]/irrelevant/route.ts`](../../../app/api/leads/[id]/irrelevant/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `bodySchema`

```text
POST /api/leads/:id/irrelevant — "not relevant, because…".

Dismissing a bad lead silently throws away the most useful signal the system
gets: a human saying, in their own words, why the criteria produced a wrong
match. Stored on the lead and surfaced back in the discovery profile, so the
next run can be told what to stop returning instead of repeating the mistake.
```

### `GET | POST` /api/leads/discovery/profiles

- **Source:** [`app/api/leads/discovery/profiles/route.ts`](../../../app/api/leads/discovery/profiles/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `createDiscoveryProfileSchema`

```text
POST /api/leads/discovery/profiles — create a profile (OWNER/ADMIN).
```

### `PATCH | DELETE` /api/leads/discovery/profiles/:id

- **Source:** [`app/api/leads/discovery/profiles/[id]/route.ts`](../../../app/api/leads/discovery/profiles/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `updateDiscoveryProfileSchema`

```text
DELETE /api/leads/discovery/profiles/:id — remove a profile.
```

### `GET` /api/leads/discovery/profiles/:id/estimate

- **Source:** [`app/api/leads/discovery/profiles/[id]/estimate/route.ts`](../../../app/api/leads/discovery/profiles/[id]/estimate/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/leads/discovery/profiles/:id/estimate — what a run would produce,
how long it would take, and what it would cost in model usage. Shown before
"Run now" so nobody has to guess.
```

### `POST` /api/leads/discovery/profiles/:id/run

- **Source:** [`app/api/leads/discovery/profiles/[id]/run/route.ts`](../../../app/api/leads/discovery/profiles/[id]/run/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Plan entitlement:** `discovery`

```text
POST /api/leads/discovery/profiles/:id/run — run discovery now (OWNER/ADMIN).
```

### `GET | PUT` /api/outreach/config

- **Source:** [`app/api/outreach/config/route.ts`](../../../app/api/outreach/config/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `outreachConfigSchema`

```text
PUT /api/outreach/config — update targeting (OWNER/ADMIN).
```

### `POST` /api/outreach/detect

- **Source:** [`app/api/outreach/detect/route.ts`](../../../app/api/outreach/detect/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`

```text
POST /api/outreach/detect — run lead-signal detection now (OWNER/ADMIN).
```

### `POST` /api/outreach/from-recommendation

- **Source:** [`app/api/outreach/from-recommendation/route.ts`](../../../app/api/outreach/from-recommendation/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`, `content:approve`
- **Request validation:** `bodySchema`

```text
POST /api/outreach/from-recommendation { recommendationId, leadIds } — the
Outreach creation handoff (lib/creation-handoff.ts): draft a connection note
and follow-up for each chosen lead, written from the recommendation's
context and keeping it.

  - Same permission as drafting outreach (content:approve); saying yes to a
    still-open suggestion on the way is a decision (owners/admins), exactly
    as for Content Studio and Campaigns.
  - Only an eligible suggestion (aimed at people) — anything else is refused
    with the reason and where it is carried out instead.
  - Drafts land as DRAFT, in the normal review and approval flow. Sending
    waits for execution (lib/execution-gate.ts): approved messages from a
    suggestion never enter the send queue yet.
```

### `GET | POST` /api/outreach/leads

- **Source:** [`app/api/outreach/leads/route.ts`](../../../app/api/outreach/leads/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `createLeadSchema`

```text
GET /api/outreach/leads — leads with signals + messages (any member).
```

### `PATCH | DELETE` /api/outreach/leads/:id

- **Source:** [`app/api/outreach/leads/[id]/route.ts`](../../../app/api/outreach/leads/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `updateLeadSchema`

```text
PATCH /api/outreach/leads/:id — edit a lead (add person, status, etc.).
```

### `POST` /api/outreach/leads/:id/draft

- **Source:** [`app/api/outreach/leads/[id]/draft/route.ts`](../../../app/api/outreach/leads/[id]/draft/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`

```text
POST /api/outreach/leads/:id/draft — AI-draft connection note + follow-up.
```

### `POST` /api/outreach/leads/send-to-outreach

- **Source:** [`app/api/outreach/leads/send-to-outreach/route.ts`](../../../app/api/outreach/leads/send-to-outreach/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `sendToOutreachSchema`

```text
POST /api/outreach/leads/send-to-outreach — explicit hand-off of selected
leads into the outreach workflow (Lead requirement → Fetch leads → Leads →
Outreach). Qualifies them and reports which requirement buckets they came
from, so the UI can deep-link straight to the filtered Outreach board.
```

### `PATCH` /api/outreach/messages/:id

- **Source:** [`app/api/outreach/messages/[id]/route.ts`](../../../app/api/outreach/messages/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `updateOutreachMessageSchema`

```text
PATCH /api/outreach/messages/:id — edit draft text (returns it to DRAFT).
```

### `POST` /api/outreach/messages/:id/outcome

- **Source:** [`app/api/outreach/messages/[id]/outcome/route.ts`](../../../app/api/outreach/messages/[id]/outcome/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `outreachOutcomeSchema`

```text
POST /api/outreach/messages/:id/outcome — the user manually confirms whether
a sent outreach worked (connection accepted / reply received). No API exposes
this, so it's a human toggle — the "did it work" signal for Marketing Memory.
```

### `POST` /api/outreach/messages/:id/status

- **Source:** [`app/api/outreach/messages/[id]/status/route.ts`](../../../app/api/outreach/messages/[id]/status/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `outreachStatusActionSchema`

```text
POST /api/outreach/messages/:id/status — approve/reject/submit an outreach
message. Approving requires content:approve (OWNER/ADMIN). Approved messages
flow to the extension queue; only a human click there marks them SENT.
```

### `GET | POST` /api/outreach/messages/bulk

- **Source:** [`app/api/outreach/messages/bulk/route.ts`](../../../app/api/outreach/messages/bulk/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `bodySchema`

```text
POST /api/outreach/messages/bulk — approve or reject many messages at once.

Approving one message at a time is a real tax on a small team, and the
backlog it creates is why the outreach funnel stalls before anything reaches
Analytics. This is still an explicit human approval — the same transition,
the same audit entry per message, just not one click each.

Every id is re-checked against the caller's company inside the transition, so
a crafted list cannot reach another workspace's messages.
```

## 16 Engagement Copilot

Feature docs: [../02-features/16-engagement-copilot/](../02-features/16-engagement-copilot/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/engagement/targets` | Signed-in session + active workspace | `company:update` |
| DELETE | `/api/engagement/targets/:id` | Signed-in session + active workspace | `company:update` |

### `GET | POST` /api/engagement/targets

- **Source:** [`app/api/engagement/targets/route.ts`](../../../app/api/engagement/targets/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `createTargetSchema`

```text
POST /api/engagement/targets — add a monitored profile (OWNER/ADMIN).
```

### `DELETE` /api/engagement/targets/:id

- **Source:** [`app/api/engagement/targets/[id]/route.ts`](../../../app/api/engagement/targets/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
DELETE /api/engagement/targets/:id — stop monitoring a profile.
```

## 17 Chrome Extension (Human Action Layer)

Feature docs: [../02-features/17-chrome-extension/](../02-features/17-chrome-extension/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST · OPTIONS | `/api/extension/actions/complete` | Extension bearer token | — |
| POST · OPTIONS | `/api/extension/engagement/draft` | Extension bearer token | `content:create` |
| GET · OPTIONS | `/api/extension/media/:assetId` | Extension bearer token | — |
| POST · OPTIONS | `/api/extension/metrics` | Extension bearer token | `content:create` |
| GET · OPTIONS | `/api/extension/queue` | Extension bearer token | — |
| GET · OPTIONS | `/api/extension/status` | Extension bearer token | — |
| GET · POST | `/api/extension/token` | Signed-in session + active workspace | — |
| POST | `/api/extension/token/:id/revoke` | Signed-in session + active workspace | — |

### `POST | OPTIONS` /api/extension/actions/complete

- **Source:** [`app/api/extension/actions/complete/route.ts`](../../../app/api/extension/actions/complete/route.ts)
- **Auth:** Extension bearer token
- **Request validation:** `bodySchema`

```text
POST /api/extension/actions/complete — the human clicked send in the
extension; record the item as published/sent/posted (bearer auth). The
backend performs NO LinkedIn action — it only records the human's action.
Enforces the daily cap server-side as defense-in-depth (the extension already
caps client-side).
```

### `POST | OPTIONS` /api/extension/engagement/draft

- **Source:** [`app/api/extension/engagement/draft/route.ts`](../../../app/api/extension/engagement/draft/route.ts)
- **Auth:** Extension bearer token
- **Permission checked:** `content:create`
- **Request validation:** `draftCommentSchema`

```text
POST /api/extension/engagement/draft — the extension sends the text of a post
ALREADY VISIBLE in the user's own browser DOM; we return an on-brand comment
draft. No server-side LinkedIn fetch happens here (constraint #2). Bearer auth.
```

### `GET | OPTIONS` /api/extension/media/:assetId

- **Source:** [`app/api/extension/media/[assetId]/route.ts`](../../../app/api/extension/media/[assetId]/route.ts)
- **Auth:** Extension bearer token

```text
GET /api/extension/media/:assetId — one graphic, for the extension.

Returns base64 inside JSON rather than raw bytes, and that is deliberate.
The extension authenticates with a bearer token and no cookies, so every
request it makes is cross-origin and needs CORS headers on the response. The
existing extension helpers (`extJson`) attach those to JSON responses, and
the content script has to turn the image into a File object for LinkedIn's
uploader anyway — which means decoding it client-side either way.

Authorisation reuses the same extension token and company scoping as the rest
of /api/extension/*: `getAsset` is company-scoped, so a token for workspace A
cannot read workspace B's graphic. No new auth path was introduced.
```

### `POST | OPTIONS` /api/extension/metrics

- **Source:** [`app/api/extension/metrics/route.ts`](../../../app/api/extension/metrics/route.ts)
- **Auth:** Extension bearer token
- **Permission checked:** `content:create`
- **Request validation:** `extensionMetricsSchema`

```text
POST /api/extension/metrics — the extension reads the like/comment counts
already rendered on the user's OWN post page and syncs them (Sprint 5).
Same "only what's visible in your own DOM" constraint as the Engagement
Copilot — no server-side LinkedIn fetch. Bearer auth. Real numbers only.
```

### `GET | OPTIONS` /api/extension/queue

- **Source:** [`app/api/extension/queue/route.ts`](../../../app/api/extension/queue/route.ts)
- **Auth:** Extension bearer token

```text
GET /api/extension/queue — items awaiting a human click (bearer auth).
```

### `GET | OPTIONS` /api/extension/status

- **Source:** [`app/api/extension/status/route.ts`](../../../app/api/extension/status/route.ts)
- **Auth:** Extension bearer token

```text
GET /api/extension/status — bearer-auth connection + usage summary.
```

### `GET | POST` /api/extension/token

- **Source:** [`app/api/extension/token/route.ts`](../../../app/api/extension/token/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `issueSchema`

```text
Session-authenticated (same-origin) endpoints to issue + list extension
tokens. The raw token is returned exactly ONCE on issue; thereafter only
non-secret metadata is listable.
```

### `POST` /api/extension/token/:id/revoke

- **Source:** [`app/api/extension/token/[id]/revoke/route.ts`](../../../app/api/extension/token/[id]/revoke/route.ts)
- **Auth:** Signed-in session + active workspace

```text
POST /api/extension/token/:id/revoke — "Disconnect extension" (session auth).
```

## 18 Marketing Memory & Analytics

Feature docs: [../02-features/18-marketing-memory-and-analytics/](../02-features/18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/api/analytics/manual` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/analytics/report` | Signed-in session + active workspace | `content:approve` |
| PATCH · DELETE | `/api/memory/:id` | Signed-in session + active workspace | `content:approve` |
| POST | `/api/memory/generate` | Signed-in session + active workspace | `content:approve` |

### `POST` /api/analytics/manual

- **Source:** [`app/api/analytics/manual/route.ts`](../../../app/api/analytics/manual/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `bodySchema`

```text
POST /api/analytics/manual — record measured results by hand.

Analytics showing all zeros is not a rendering problem: nothing has ever
reported a number, because that needs a connector that may be weeks from
approval. Blocking the entire measurement loop on an OAuth review would also
block Marketing Memory, which cannot learn from results it never receives.

A manual snapshot is a first-class PerformanceSnapshot with source MANUAL —
the same shape a connector writes, so every downstream consumer (analytics
rollups, memory extraction, content intelligence) treats it identically and
nothing needs a special case.
```

### `POST` /api/analytics/report

- **Source:** [`app/api/analytics/report/route.ts`](../../../app/api/analytics/report/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`

```text
POST /api/analytics/report — generate this week's written report.
```

### `PATCH | DELETE` /api/memory/:id

- **Source:** [`app/api/memory/[id]/route.ts`](../../../app/api/memory/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`
- **Request validation:** `patchSchema`

```text
PATCH /api/memory/[id] — correct the wording of a learned insight.
DELETE /api/memory/[id] — dismiss an insight (soft-delete; stops feeding drafts).
Both require content:approve and are scoped to the active company.
```

### `POST` /api/memory/generate

- **Source:** [`app/api/memory/generate/route.ts`](../../../app/api/memory/generate/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:approve`

```text
POST /api/memory/generate — run pattern extraction now ("Analyze" button).
Honestly returns { status: 'insufficient' } for low-sample companies.
```

## 19 Connections, Connectors & OAuth

Feature docs: [../02-features/19-connections-and-connectors/](../02-features/19-connections-and-connectors/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/api/connections` | Signed-in session + active workspace | — |
| GET | `/api/connections/:connectorId` | Signed-in session + active workspace | — |
| POST | `/api/connections/:connectorId/confirm` | Signed-in session + active workspace | `company:update` |
| POST | `/api/connections/:connectorId/health` | Signed-in session + active workspace | `content:create` |
| POST | `/api/connections/:connectorId/select` | Signed-in session + active workspace | `company:update` |
| POST | `/api/connections/health` | Signed-in session + active workspace | `content:create` |
| GET | `/api/connectors` | Signed-in session + active workspace | — |
| GET · POST · DELETE | `/api/connectors/:id` | Signed-in session + active workspace | `company:update` |
| GET | `/api/connectors/:id/callback` | Signed-in session | `company:update` |
| POST | `/api/connectors/:id/email-verify` | Signed-in session + active workspace | `company:update` |
| POST | `/api/connectors/:id/test` | Signed-in session + active workspace | `company:update` |
| GET | `/api/connectors/preflight` | Signed-in session + active workspace | — |
| GET | `/api/linkedin/callback` | Signed-in session | `linkedin:connect` |
| GET | `/api/linkedin/connect` | Signed-in session | `linkedin:connect` |
| POST | `/api/linkedin/disconnect` | Signed-in session | `linkedin:connect` |
| POST | `/api/meta/data-deletion` | Provider signature verified | — |
| POST | `/api/meta/deauthorize` | Provider signature verified | — |
| GET · POST | `/api/meta/page` | Signed-in session + active workspace | `company:update` |

### `GET` /api/connections

- **Source:** [`app/api/connections/route.ts`](../../../app/api/connections/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/connections — the Connection Manager: every connection in the
active workspace with its accounts, permissions, health and capabilities.
Never includes a token (lib/connection-manager.ts toConnectionRecord).
```

### `GET` /api/connections/:connectorId

- **Source:** [`app/api/connections/[connectorId]/route.ts`](../../../app/api/connections/[connectorId]/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/connections/:connectorId — one connection and its setup steps.
```

### `POST` /api/connections/:connectorId/confirm

- **Source:** [`app/api/connections/[connectorId]/confirm/route.ts`](../../../app/api/connections/[connectorId]/confirm/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/connections/:connectorId/confirm — step 5: confirm the
connection. Only confirmed connections can execute. Runs a live health
check straight away so the status shown is real. OWNER/ADMIN.
```

### `POST` /api/connections/:connectorId/health

- **Source:** [`app/api/connections/[connectorId]/health/route.ts`](../../../app/api/connections/[connectorId]/health/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
POST /api/connections/:connectorId/health — re-check one connection with
its provider now (token, permissions, provider, account, recent failures).
Any member who can create content; viewers see the stored status.
```

### `POST` /api/connections/:connectorId/select

- **Source:** [`app/api/connections/[connectorId]/select/route.ts`](../../../app/api/connections/[connectorId]/select/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
POST /api/connections/:connectorId/select { accountId } — step 4 of the
connection flow: the account/page Aura uses. Meta Pages are re-checked
with Meta at the moment of choosing. OWNER/ADMIN (company:update).
```

### `POST` /api/connections/health

- **Source:** [`app/api/connections/health/route.ts`](../../../app/api/connections/health/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
POST /api/connections/health — re-check every connection in the workspace.
```

### `GET` /api/connectors

- **Source:** [`app/api/connectors/route.ts`](../../../app/api/connectors/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/connectors — this workspace's live connections (no secrets).
```

### `GET | POST | DELETE` /api/connectors/:id

- **Source:** [`app/api/connectors/[id]/route.ts`](../../../app/api/connectors/[id]/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `saveApiKeySchema`

```text
POST /api/connectors/:id — connect.

API-key connectors: the body carries the key, which is verified against the
provider before it is stored. OAuth connectors: returns the authorize URL for
the browser to follow (no body needed).
```

### `GET` /api/connectors/:id/callback

- **Source:** [`app/api/connectors/[id]/callback/route.ts`](../../../app/api/connectors/[id]/callback/route.ts)
- **Auth:** Signed-in session
- **Permission checked:** `company:update`

```text
GET /api/connectors/:id/callback — OAuth redirect target.

The connector is taken from the signed `state`, not from the path. Providers
that share one OAuth client across several connectors (Google: GA4 +
Search Console) therefore share one registered redirect URI, which is what
removes the `redirect_uri_mismatch` class of failure — there is a single URI
to register instead of one per connector. `state` is HMAC'd, so it is the
safer source of truth in any case.

Always redirects back to the Connectors page with a human-readable outcome in
the query string; the user never sees a raw JSON error at the end of an OAuth
dance.
```

### `POST` /api/connectors/:id/email-verify

- **Source:** [`app/api/connectors/[id]/email-verify/route.ts`](../../../app/api/connectors/[id]/email-verify/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
POST /api/connectors/:id/email-verify — the email + one-time code path.

Two steps on one route: `{ email }` sends a code, `{ code }` redeems it.
Keeping them together means the client never has to track which endpoint a
half-finished verification belongs to.
```

### `POST` /api/connectors/:id/test

- **Source:** [`app/api/connectors/[id]/test/route.ts`](../../../app/api/connectors/[id]/test/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/connectors/:id/test — re-verify stored credentials against the
provider right now. "Connected" should mean "working", not "was working once".
```

### `GET` /api/connectors/preflight

- **Source:** [`app/api/connectors/preflight/route.ts`](../../../app/api/connectors/preflight/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/connectors/preflight?id=ga4 — is this connector actually connectable
from THIS deployment, and what exactly must be registered with the provider?

Called before the browser follows an authorize URL, so a misconfiguration
surfaces as our message with the fix in it, rather than as the provider's
`Error 400: redirect_uri_mismatch` on a page we do not control.

With no `id`, returns every redirect URI this deployment expects — the
copy-paste list for setting up the OAuth clients in the first place.
```

### `GET` /api/linkedin/callback

- **Source:** [`app/api/linkedin/callback/route.ts`](../../../app/api/linkedin/callback/route.ts)
- **Auth:** Signed-in session
- **Permission checked:** `linkedin:connect`

```text
GET /api/linkedin/callback — OAuth redirect target. Verifies CSRF state,
exchanges the code for tokens (stored encrypted), and returns the user to the
Connections settings page with a status flag.
```

### `GET` /api/linkedin/connect

- **Source:** [`app/api/linkedin/connect/route.ts`](../../../app/api/linkedin/connect/route.ts)
- **Auth:** Signed-in session
- **Permission checked:** `linkedin:connect`

```text
GET /api/linkedin/connect — begin the official LinkedIn OAuth flow.
RBAC: only roles allowed to connect LinkedIn (OWNER/ADMIN — see lib/rbac.ts).
CSRF: we generate a random nonce, store its hash in an httpOnly cookie, and
embed companyId + nonce in the OAuth `state`, verified on callback.
```

### `POST` /api/linkedin/disconnect

- **Source:** [`app/api/linkedin/disconnect/route.ts`](../../../app/api/linkedin/disconnect/route.ts)
- **Auth:** Signed-in session
- **Permission checked:** `linkedin:connect`

```text
POST /api/linkedin/disconnect — revoke the token (best-effort) and delete the
stored connection for the active company. RBAC-guarded + audited.
```

### `POST` /api/meta/data-deletion

- **Source:** [`app/api/meta/data-deletion/route.ts`](../../../app/api/meta/data-deletion/route.ts)
- **Auth:** Provider signature verified

```text
POST /api/meta/data-deletion — Meta's "Data deletion request callback URL"
(App settings → Basic), required for App Review. Deletes the Meta
connection data for that Facebook user and answers, as Meta specifies,
with a status URL and a confirmation code. Authenticated by the
signed_request (HMAC with the app secret).
```

### `POST` /api/meta/deauthorize

- **Source:** [`app/api/meta/deauthorize/route.ts`](../../../app/api/meta/deauthorize/route.ts)
- **Auth:** Provider signature verified

```text
POST /api/meta/deauthorize — Meta's "Deauthorize callback URL" (App
settings → Facebook Login → Settings). Called when someone removes Aura in
their Facebook settings. Unauthenticated by design — Meta's signed_request,
HMAC-signed with the app secret, is the authentication.
```

### `GET | POST` /api/meta/page

- **Source:** [`app/api/meta/page/route.ts`](../../../app/api/meta/page/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`
- **Request validation:** `bodySchema`

```text
GET  /api/meta/page — the Pages the Meta connection can publish to, and the chosen one.
POST /api/meta/page { pageId } — publish to this Page (and its Instagram) from now on.

Choosing is managing a connection: OWNER/ADMIN (company:update), as for
connecting it.
```

## 20 Publishing, Execution Engine & Scheduling

Feature docs: [../02-features/20-publishing-execution-and-scheduling/](../02-features/20-publishing-execution-and-scheduling/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/api/executions` | Signed-in session + active workspace | — |
| GET | `/api/executions/:id` | Signed-in session + active workspace | — |
| POST | `/api/executions/:id/cancel` | Signed-in session + active workspace | — |
| POST | `/api/executions/:id/retry` | Signed-in session + active workspace | — |

### `GET` /api/executions

- **Source:** [`app/api/executions/route.ts`](../../../app/api/executions/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/executions?status=SCHEDULED,FAILED&draftId= — the workspace's
executions, newest activity first. Any member (no secrets in them).
```

### `GET` /api/executions/:id

- **Source:** [`app/api/executions/[id]/route.ts`](../../../app/api/executions/[id]/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/executions/:id — one execution: its state, every state change,
and the chain Business Context → Opportunity → Recommendation → Content →
Approval → Execution. 404 for another workspace's.
```

### `POST` /api/executions/:id/cancel

- **Source:** [`app/api/executions/[id]/cancel/route.ts`](../../../app/api/executions/[id]/cancel/route.ts)
- **Auth:** Signed-in session + active workspace
- **Request validation:** `bodySchema`

```text
POST /api/executions/:id/cancel { reason? } — Scheduled (or waiting) → Cancelled. OWNER/ADMIN.
```

### `POST` /api/executions/:id/retry

- **Source:** [`app/api/executions/[id]/retry/route.ts`](../../../app/api/executions/[id]/retry/route.ts)
- **Auth:** Signed-in session + active workspace

```text
POST /api/executions/:id/retry — run a Failed / Action-required execution
again now (re-routed first; a completed one never runs again). OWNER/ADMIN.
```

## 21 WhatsApp AI Assistant

Feature docs: [../02-features/21-whatsapp-assistant/](../02-features/21-whatsapp-assistant/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/api/whatsapp/conversations` | Signed-in session + active workspace | `company:update` |
| GET | `/api/whatsapp/features` | Signed-in session + active workspace | — |
| POST | `/api/whatsapp/link/cancel` | Signed-in session | — |
| POST | `/api/whatsapp/link/confirm` | Signed-in session | — |
| GET | `/api/whatsapp/links` | Signed-in session | — |
| DELETE | `/api/whatsapp/links/:id` | Signed-in session | — |
| POST | `/api/whatsapp/send` | Signed-in session + active workspace | `company:update` |
| PATCH | `/api/whatsapp/settings` | Signed-in session | `company:update` |

### `GET` /api/whatsapp/conversations

- **Source:** [`app/api/whatsapp/conversations/route.ts`](../../../app/api/whatsapp/conversations/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
GET /api/whatsapp/conversations?limit=20&messages=20 — WhatsApp
conversations handled for the ACTIVE workspace, newest first.

  owners / admins (company:update)  every member's conversation here
  everyone else                     their own number(s) only

Only messages handled for this workspace are included — never another
workspace's, never sign-in chatter from numbers not yet linked.
```

### `GET` /api/whatsapp/features

- **Source:** [`app/api/whatsapp/features/route.ts`](../../../app/api/whatsapp/features/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/whatsapp/features — what the signed-in person can do with Aura on
WhatsApp in the active workspace, in their role. Read from the same tool
registry the assistant runs on, so it matches the WhatsApp menu exactly.
Names of missing settings only, never their values.
```

### `POST` /api/whatsapp/link/cancel

- **Source:** [`app/api/whatsapp/link/cancel/route.ts`](../../../app/api/whatsapp/link/cancel/route.ts)
- **Auth:** Signed-in session
- **Request validation:** `bodySchema`

```text
POST /api/whatsapp/link/cancel { token } — "this isn't me": the link stops working.
```

### `POST` /api/whatsapp/link/confirm

- **Source:** [`app/api/whatsapp/link/confirm/route.ts`](../../../app/api/whatsapp/link/confirm/route.ts)
- **Auth:** Signed-in session
- **Request validation:** `bodySchema`

```text
POST /api/whatsapp/link/confirm { token } — the signed-in user confirms that
the WhatsApp number behind a sign-in link is theirs. Returns the 6-digit
code to send from that number (shown once; stored only as a hash). The link
is single-use: a second confirm, by anyone, is refused (409).
```

### `GET` /api/whatsapp/links

- **Source:** [`app/api/whatsapp/links/route.ts`](../../../app/api/whatsapp/links/route.ts)
- **Auth:** Signed-in session

```text
GET /api/whatsapp/links — the signed-in user's own linked WhatsApp numbers (last four digits only).
```

### `DELETE` /api/whatsapp/links/:id

- **Source:** [`app/api/whatsapp/links/[id]/route.ts`](../../../app/api/whatsapp/links/[id]/route.ts)
- **Auth:** Signed-in session

```text
DELETE /api/whatsapp/links/:id — unlink one of the signed-in user's own
WhatsApp numbers. Anyone else's link answers 404, the same as no link.
```

### `POST` /api/whatsapp/send

- **Source:** [`app/api/whatsapp/send/route.ts`](../../../app/api/whatsapp/send/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:update`

```text
POST /api/whatsapp/send { userId, text } — an owner or admin messages a
member of the active workspace on WhatsApp. Narrow by design
(server/whatsapp/admin-message.ts): only members using WhatsApp in this
workspace, only inside Meta's 24-hour window, never after STOP, text only,
signed with the sender's name, audited. Not for arbitrary numbers or
marketing.
```

### `PATCH` /api/whatsapp/settings

- **Source:** [`app/api/whatsapp/settings/route.ts`](../../../app/api/whatsapp/settings/route.ts)
- **Auth:** Signed-in session
- **Permission checked:** `company:update`

```text
PATCH /api/whatsapp/settings — turn WhatsApp access on or off for the
active workspace. Owners and admins only (company:update).
```

## 22 Billing, Plans & Entitlements

Feature docs: [../02-features/22-billing-and-plans/](../02-features/22-billing-and-plans/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/api/billing/checkout` | Signed-in session + active workspace | `company:manageBilling` |
| POST | `/api/billing/portal` | Signed-in session + active workspace | `company:manageBilling` |
| POST | `/api/webhooks/stripe` | Provider signature verified | — |
| GET · POST | `/api/webhooks/whatsapp` | Provider signature verified | — |

### `POST` /api/billing/checkout

- **Source:** [`app/api/billing/checkout/route.ts`](../../../app/api/billing/checkout/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:manageBilling`
- **Request validation:** `bodySchema`

```text
POST /api/billing/checkout — start a hosted Stripe Checkout for a plan.
```

### `POST` /api/billing/portal

- **Source:** [`app/api/billing/portal/route.ts`](../../../app/api/billing/portal/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `company:manageBilling`

```text
POST /api/billing/portal — open the hosted Stripe Customer Portal.
```

### `POST` /api/webhooks/stripe

- **Source:** [`app/api/webhooks/stripe/route.ts`](../../../app/api/webhooks/stripe/route.ts)
- **Auth:** Provider signature verified

```text
POST /api/webhooks/stripe — Stripe webhook receiver (Sprint 6, Module 3).

NON-NEGOTIABLE #4: the signature is verified with STRIPE_WEBHOOK_SECRET before
we trust ANY payload. An unverified/tampered request is rejected with 400 and
never touches the database. This route is intentionally unauthenticated (Stripe
calls it) — the signature IS the auth.
```

### `GET | POST` /api/webhooks/whatsapp

- **Source:** [`app/api/webhooks/whatsapp/route.ts`](../../../app/api/webhooks/whatsapp/route.ts)
- **Auth:** Provider signature verified

```text
/api/webhooks/whatsapp — Meta WhatsApp Cloud API webhook for Botella's
central number.

  GET   subscription handshake: echoes hub.challenge when hub.verify_token
        matches WHATSAPP_VERIFY_TOKEN
  POST  messages and statuses. Unauthenticated by design — Meta calls it —
        so the X-Hub-Signature-256 HMAC (WHATSAPP_APP_SECRET) over the raw
        body IS the authentication. Nothing is parsed or stored before it
        passes.

Nothing slow happens before the response: each message is stored with a
queued job and Meta is answered at once. The answering (AI, Aura services,
sending) runs after the response, via waitUntil (server/whatsapp/queue.ts);
the cron sweep picks up anything that does not finish.

Responses: 200 once stored; 401 for a bad signature; 500 only when storing
failed, so Meta redelivers; 503 (fail closed) when not configured.
```

## 24 Platform: Jobs, Cron, Security & Deployment

Feature docs: [../02-features/24-platform-jobs-and-deployment/](../02-features/24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md)

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET · POST | `/api/cron/advisor` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/analytics` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/briefing` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/campaigns` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/competitors` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/connections` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/discovery` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/intelligence` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/jobs` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/memory` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/outreach` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/publish` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/trends` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/cron/whatsapp` | `Authorization: Bearer $CRON_SECRET` | — |
| GET · POST | `/api/jobs` | Signed-in session + active workspace | `content:create` |
| GET | `/api/jobs/:id` | Signed-in session + active workspace | — |
| POST | `/api/jobs/:id/run` | Signed-in session + active workspace | `content:create` |
| GET | `/api/jobs/active` | Signed-in session + active workspace | — |

### `GET | POST` /api/cron/advisor

- **Source:** [`app/api/cron/advisor/route.ts`](../../../app/api/cron/advisor/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
POST /api/cron/advisor — refresh the AI Marketing Advisor's campaign
opportunities for every workspace.

Competitor moves are time-sensitive: an opportunity worth acting on this week
is worth nothing next month, so this runs on a schedule rather than waiting
for someone to press a button. Idempotent per company/day.

  Vercel Cron example (vercel.json):
    { "crons": [{ "path": "/api/cron/advisor", "schedule": "0 6 * * 1" }] }
```

### `GET | POST` /api/cron/analytics

- **Source:** [`app/api/cron/analytics/route.ts`](../../../app/api/cron/analytics/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
Vercel Cron invokes schedules with GET, never POST, so a POST-only handler
returns 405 and the job silently never runs. Vercel also attaches
`Authorization: Bearer $CRON_SECRET` itself when that variable is set, which
is exactly what `isAuthorized` already checks — so the same handler serves
both without weakening the guard. Manual/curl invocation over POST keeps
working unchanged.
```

### `GET | POST` /api/cron/briefing

- **Source:** [`app/api/cron/briefing/route.ts`](../../../app/api/cron/briefing/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
POST /api/cron/briefing — the weekly autonomous cycle.

This is the job that makes Aura an employee: for every workspace it writes
the week's posts, illustrates them, and assembles the Monday briefing.

Platform-agnostic (any scheduler), protected by the shared CRON_SECRET, and
modelled on app/api/cron/competitors/route.ts — sequential per company,
fail-closed auth, and one failing workspace is logged and skipped rather than
taking the whole run down.

Run it EARLY MONDAY, before people start their week:
  Vercel Cron:  { "path": "/api/cron/briefing", "schedule": "0 5 * * 1" }
  curl:         curl -X POST .../api/cron/briefing -H "authorization: Bearer $CRON_SECRET"

Safe to run more than once: `runAutopilot` is idempotent per company per
week, so a retry re-assembles the briefing without writing a second set of
posts or spending a second time on graphics.
```

### `GET | POST` /api/cron/campaigns

- **Source:** [`app/api/cron/campaigns/route.ts`](../../../app/api/cron/campaigns/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
Vercel Cron invokes schedules with GET, never POST, so a POST-only handler
returns 405 and the job silently never runs. Vercel also attaches
`Authorization: Bearer $CRON_SECRET` itself when that variable is set, which
is exactly what `isAuthorized` already checks — so the same handler serves
both without weakening the guard. Manual/curl invocation over POST keeps
working unchanged.
```

### `GET | POST` /api/cron/competitors

- **Source:** [`app/api/cron/competitors/route.ts`](../../../app/api/cron/competitors/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
POST /api/cron/competitors — weekly competitor tracking + report job.
Platform-agnostic (any scheduler): protect with the shared CRON_SECRET.
Mirrors app/api/cron/trends/route.ts: sequential per-company, fail-closed
auth, and a single company failure is logged and skipped, never fatal.

Vercel Cron (vercel.json):
  { "path": "/api/cron/competitors", "schedule": "0 13 * * 1" }  // Mondays
```

### `GET | POST` /api/cron/connections

- **Source:** [`app/api/cron/connections/route.ts`](../../../app/api/cron/connections/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
POST /api/cron/connections — token & connection health sweep: refreshes
tokens that expire within a day (where the provider allows), re-checks
connections not checked for six hours, and asks for reauthorization when
a connection expired, was revoked or lost a permission.

  Vercel Cron: hourly ("0 * * * *").
  Local: curl -X POST localhost:3000/api/cron/connections -H "authorization: Bearer $CRON_SECRET"
```

### `GET | POST` /api/cron/discovery

- **Source:** [`app/api/cron/discovery/route.ts`](../../../app/api/cron/discovery/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
Vercel Cron invokes schedules with GET, never POST, so a POST-only handler
returns 405 and the job silently never runs. Vercel also attaches
`Authorization: Bearer $CRON_SECRET` itself when that variable is set, which
is exactly what `isAuthorized` already checks — so the same handler serves
both without weakening the guard. Manual/curl invocation over POST keeps
working unchanged.
```

### `GET | POST` /api/cron/intelligence

- **Source:** [`app/api/cron/intelligence/route.ts`](../../../app/api/cron/intelligence/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
POST /api/cron/intelligence — daily recomputation of the AI Marketing
Intelligence snapshot for every workspace.

Running it on a schedule is what makes the dashboard's movement indicator
meaningful: a score is only comparable to yesterday's if yesterday's exists.
Idempotent per company/day (upsert on companyId+date), so a double-fire is safe.

  Vercel Cron example (vercel.json):
    { "crons": [{ "path": "/api/cron/intelligence", "schedule": "0 5 * * *" }] }
```

### `GET | POST` /api/cron/jobs

- **Source:** [`app/api/cron/jobs/route.ts`](../../../app/api/cron/jobs/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
POST /api/cron/jobs — the safety net under the generation queue.

Two things it fixes, both of which previously looked like a hang to the user:
a RUNNING job whose serverless instance was killed mid-flight, and a QUEUED
job whose client kick never arrived (tab closed, network dropped). Neither
can resolve itself, so this sweeps them: interrupted work is requeued and
retried, and anything past its retry budget is failed with a message the UI
can actually show.

  Vercel Cron example (vercel.json):
    { "crons": [{ "path": "/api/cron/jobs", "schedule": "*\/5 * * * *" }] }
```

### `GET | POST` /api/cron/memory

- **Source:** [`app/api/cron/memory/route.ts`](../../../app/api/cron/memory/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
Vercel Cron invokes schedules with GET, never POST, so a POST-only handler
returns 405 and the job silently never runs. Vercel also attaches
`Authorization: Bearer $CRON_SECRET` itself when that variable is set, which
is exactly what `isAuthorized` already checks — so the same handler serves
both without weakening the guard. Manual/curl invocation over POST keeps
working unchanged.
```

### `GET | POST` /api/cron/outreach

- **Source:** [`app/api/cron/outreach/route.ts`](../../../app/api/cron/outreach/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
Vercel Cron invokes schedules with GET, never POST, so a POST-only handler
returns 405 and the job silently never runs. Vercel also attaches
`Authorization: Bearer $CRON_SECRET` itself when that variable is set, which
is exactly what `isAuthorized` already checks — so the same handler serves
both without weakening the guard. Manual/curl invocation over POST keeps
working unchanged.
```

### `GET | POST` /api/cron/publish

- **Source:** [`app/api/cron/publish/route.ts`](../../../app/api/cron/publish/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
GET/POST /api/cron/publish — the scheduled-publish job
(docs/SCHEDULER.md). Protected by `Authorization: Bearer $CRON_SECRET`.

Safe to call as often as every minute, and by more than one scheduler at
once (Vercel Cron and an external one):
  - only APPROVED posts whose time has come, oldest first
  - each publish is claimed first (server/content/publication-store.ts), so
    overlapping runs can never post the same thing twice
  - a failed or manual attempt waits for a person; only rate-limited ones
    are retried automatically, after their backoff
  - work stops being started after ~45 s, so the function is never stopped
    mid-publish; whatever is left goes on the next run

  Local: curl -X POST localhost:3000/api/cron/publish -H "authorization: Bearer $CRON_SECRET"
```

### `GET | POST` /api/cron/trends

- **Source:** [`app/api/cron/trends/route.ts`](../../../app/api/cron/trends/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
POST /api/cron/trends — the scheduled daily digest job.

SCHEDULING (chosen approach): a plain protected HTTP endpoint triggered by a
cron scheduler. Justification: it's platform-agnostic and the leanest option
for Sprint 1's single-app deploy — Vercel Cron, GitHub Actions, or any
`curl` on a crontab can hit it, with no queue/worker infrastructure to run.
If volume grows, the same endpoint can enqueue per-company jobs instead of
looping inline — no caller changes.

  Vercel Cron example (vercel.json):
    { "crons": [{ "path": "/api/cron/trends", "schedule": "0 13 * * *" }] }
  Local test:
    curl -X POST localhost:3000/api/cron/trends -H "authorization: Bearer $CRON_SECRET"

Idempotent per company/day (upsert on companyId+date), so a double-fire is safe.
```

### `GET | POST` /api/cron/whatsapp

- **Source:** [`app/api/cron/whatsapp/route.ts`](../../../app/api/cron/whatsapp/route.ts)
- **Auth:** `Authorization: Bearer $CRON_SECRET`

```text
GET|POST /api/cron/whatsapp — the WhatsApp sweep (server/whatsapp/queue.ts):
messages no kick handled (a lost kick, an expired back-off, a worker that
died), then outgoing messages whose send retry is due. Messages whose
24-hour window has closed are failed rather than sent.

Authorised with CRON_SECRET like every cron route. GET too, because that is
what Vercel Cron sends. Schedule it every 1–5 minutes (Vercel Pro cron, or a
free external scheduler such as GitHub Actions or cron-job.org):
  curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/whatsapp
```

### `GET | POST` /api/jobs

- **Source:** [`app/api/jobs/route.ts`](../../../app/api/jobs/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`
- **Request validation:** `createSchema`

```text
POST /api/jobs — queue a long generation and return immediately.

The response is the job, not the result. The client then kicks
POST /api/jobs/:id/run (without awaiting it) and polls GET /api/jobs/:id.
That split is what keeps a five-minute digest off the request the user is
waiting on.
```

### `GET` /api/jobs/:id

- **Source:** [`app/api/jobs/[id]/route.ts`](../../../app/api/jobs/[id]/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/jobs/:id — poll target. Cheap by design; called every ~1.5s.
```

### `POST` /api/jobs/:id/run

- **Source:** [`app/api/jobs/[id]/run/route.ts`](../../../app/api/jobs/[id]/run/route.ts)
- **Auth:** Signed-in session + active workspace
- **Permission checked:** `content:create`

```text
A failed JOB is not a failed REQUEST.

This used to answer 502. Nothing consumed it — the client kicks this
endpoint fire-and-forget and reads the outcome by polling
/api/jobs/:id — so the status reached no code path. What it did reach
was the browser console, where a red 502 on our own origin reads as a
gateway or proxy failure and sends whoever is debugging to look for an
upstream that does not exist in this stack.

The run genuinely happened: it executed, it failed, and failJob has
recorded the real error and the right terminal state. So the request
succeeded, and the job's own status carries the bad news.
```

### `GET` /api/jobs/active

- **Source:** [`app/api/jobs/active/route.ts`](../../../app/api/jobs/active/route.ts)
- **Auth:** Signed-in session + active workspace

```text
GET /api/jobs/active — every generation in flight for this workspace, plus
anything that finished in the last few minutes.

This is what lets a background job actually be a background job. Polling from
the page that started it only works while the user stays there; the app-wide
indicator reads from here instead, so a digest started on Trends still
reports its progress — and its completion — from anywhere in the product.
```
