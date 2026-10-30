# Workspaces, Team & Roles (RBAC)

> A workspace (a `Company`) is the tenant every piece of Aura data belongs to. This feature lets a user belong to several workspaces and switch between them, invite teammates by email at a role, change or remove members, and see whether an invitation email was really delivered. One role matrix (`lib/rbac.ts`) decides what each role may do, so access rules are not scattered across route handlers.

## 1. Overview

- **Tenant:** `Company`. A user joins a company through a `CompanyMember` row that carries a `CompanyRole`.
- **Roles:** `OWNER`, `ADMIN`, `MEMBER`, `VIEWER` (enum `CompanyRole`).
- **Permissions:** `lib/rbac.ts` maps each role to a fixed set of `Permission` strings; routes call `can()` / `assertCan()`.
- **Active workspace:** chosen by the `aura.activeCompany` cookie, falling back to the user's first membership (`resolveActiveCompany`).
- **Invitations:** `CompanyInvitation` rows with a hashed token, 7-day expiry, one active invite per (company, email), and a truthful email-delivery status.
- **Email transport:** `lib/email.ts` (SMTP, Resend, or console fallback) used for invitations, password resets, connector verification codes and the settings test email.
- **Workspace settings routes:** `/api/companies/:id` and the `/api/company/*` family (audience, brand, logo, formats, contact, timezone, compliance, autopilot), all scoped to the caller's membership.

## 2. User-facing behaviour

| Where | Route | What the user can do | Roles |
| --- | --- | --- | --- |
| Company switcher (topbar) | every `/dashboard/*` page | See the active workspace (logo or initials + name); switch to another workspace (writes the cookie for 1 year and refreshes); "Create workspace" opens `/onboarding?new=1` | Any member |
| Team members card | `/dashboard/settings` (`TeamManager`) | Invite by email with a role (Viewer / Member / Admin, plus Owner for owners); see pending invitations with expiry and delivery badge ("Email delivered", "Email failed", "Email not sent", "Email queued"); Resend; Revoke; change a member's role; remove a member | Manage controls need `members:invite` (OWNER, ADMIN); everyone sees the member list |
| Email diagnostics card | `/dashboard/settings` (`EmailDiagnosticsCard`) | See the configured transport and missing settings; send a test email to yourself | Rendered when `members:invite`; API needs `company:update` |
| Invite landing | `/invite/[token]` | Accept or decline (see feature 01) | Signed-in invitee whose email matches |
| Profile and settings cards | `/dashboard/settings`, `/dashboard/settings/*` | Edit timezone, contact facts, brand, audience, formats, logo, compliance, autopilot | Edit needs `company:update` (autopilot needs `content:approve`) |

UI rules in `TeamManager`: a member can never edit their own row; an ADMIN cannot edit an OWNER's row; the Owner option appears only for owners.

## 3. How it works

### Role matrix (`lib/rbac.ts`)

| Permission | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- |
| `company:update` | yes | yes | | |
| `company:delete` | yes | | | |
| `company:manageBilling` | yes | | | |
| `members:invite` | yes | yes | | |
| `members:remove` | yes | yes | | |
| `linkedin:connect` | yes | yes | | |
| `content:create` | yes | yes | yes | |
| `content:approve` | yes | yes | | |
| `content:publish` | yes | yes | | |

VIEWER has an explicit empty set (read-only). `assertCan` throws `ForbiddenError` (status 403) with "Your role (X) is not permitted to: Y".

### Resolving the active workspace
1. `requireActiveCompany()` (`lib/auth-helpers.ts`) calls `requireUser()`, then `resolveActiveCompany(user.id)`.
2. `resolveActiveCompany` loads `getCompaniesForUser` (five columns per membership: `id`, `name`, `slug`, `logoUrl`, `role`, ordered by membership `createdAt`), picks the company whose id matches the `aura.activeCompany` cookie, or the first one.
3. It then re-reads the membership (`cachedMembership`) and throws `ForbiddenError` if there is none. Both lookups are memoised per request with React `cache`.
4. Because the company comes from the caller's own memberships, a forged cookie for a company the user does not belong to falls back to their first company.

### Creating a workspace (`POST /api/companies`)
1. `requireUser()`; body read once and parsed with `createCompanySchema`.
2. Unless `confirmDuplicate` is true, a case-insensitive name clash with one of the user's own workspaces returns **409** ("You already have a workspace called ...").
3. `createCompanyForUser` runs in one transaction: generates a unique slug (`slugify(name)`, suffix `-1`, `-2`, ... on collision), plans the onboarding data through the Business Context rules (`planBusinessContextWrite` with `origin: 'onboarding'`), creates the `Company` with `onboardedAt = now` and an `OWNER` membership, and writes `COMPANY_CREATED` and `ONBOARDING_COMPLETED` audits.
4. Best-effort: enqueues an `INTELLIGENCE` job and returns `intelligenceJobId` with the 201 response. Failure to enqueue is logged and does not fail the request.

### Inviting (`inviteMember`)
1. Email trimmed and lower-cased. Inviting an `OWNER` requires the inviter to be `OWNER` (403).
2. If a user with that email is already a member: 409 "That person is already a member."
3. 32-byte random token; SHA-256 hash stored; `expiresAt = now + 7 days`. `upsert` on `(companyId, email)`: re-inviting refreshes token, role, expiry and resets status to `PENDING`.
4. Accept URL `absoluteUrl('/invite/<raw token>')` is emailed with `sendInvitationEmail`.
5. The real outcome is saved on the row: `emailStatus` = `SENT` (provider accepted), `NOT_CONFIGURED` (console transport) or `FAILED`; plus `emailTransport`, `emailError`, `emailSentAt`.
6. Audits: `COMPANY_MEMBER_INVITED` and either `INVITATION_EMAIL_SENT` or `INVITATION_EMAIL_FAILED`.
7. The response always contains `acceptUrl`, so an admin can copy and send the link manually when email did not go out.

### Accepting (`acceptInvitation`)
- Looks up by token hash. Not found or not `PENDING`: 400. Past `expiresAt`: status set to `EXPIRED`, 400. Email mismatch with the signed-in user: 403 "This invite was sent to X. Log in with that email to accept."
- In one transaction: upserts the `CompanyMember` with the invited role, marks the invite `ACCEPTED` with `acceptedAt`, writes `COMPANY_MEMBER_ADDED` (`via: 'invitation'`). Returns `companyId`; the client sets the active-company cookie.

### Revoking, role changes, removal
- `revokeInvitation`: invite must belong to the active company (404 otherwise); status `REVOKED`; audit `COMPANY_INVITATION_REVOKED`.
- `updateMemberRole`: target must exist (404). Granting `OWNER` or changing an existing owner requires the actor to be `OWNER` (403). Demoting the last owner fails with 409 "This is the only owner. Assign another owner first." Audit `COMPANY_MEMBER_ROLE_UPDATED`.
- `removeMember`: target must exist (404); removing the last owner fails with 409; audit `COMPANY_MEMBER_REMOVED`.

### Email transport (`lib/email.ts`)
- Selection, first match wins: `SMTP_HOST` -> SMTP (nodemailer, lazy import), `RESEND_API_KEY` -> Resend (`https://api.resend.com/emails`), otherwise console (logs only).
- `sendEmail` never throws; it returns `{ delivered, transport, providerId?, error?, notConfigured? }`. SMTP with zero accepted recipients counts as not delivered.
- `emailConfigProblems()` lists missing settings (e.g. SMTP without `SMTP_USER`/`SMTP_PASS`, Resend without `EMAIL_FROM`).
- Templates: `sendPasswordResetEmail` (link valid 1 hour), `sendInvitationEmail` (valid 7 days), `sendTestEmail`, `sendConnectorVerificationEmail` (code only, no link).

### Updating the company profile
- `PATCH /api/companies/:id` requires `requireCompanyRole(id, ['OWNER','ADMIN'])`, parses `updateCompanySchema`, and routes business fields through `updateBusinessContext` (`origin: 'settings'`). `logoUrl` is written directly with a `COMPANY_UPDATED` audit.
- The `/api/company/*` routes use the active company (no id in the path) and `can(role, 'company:update')` for writes; logo uploads cap at **4,000,000 bytes** and go through the same image pipeline as post graphics (`server/company/logo.service.ts`); profile JSON in `Company.preferences` is read with safe parsing and written by merge (`server/company/profile.service.ts`).

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/settings/page.tsx` | Settings home; renders `TeamManager` and `EmailDiagnosticsCard`; computes `canEdit` / `canManageTeam` |
| Component | `components/dashboard/team-manager.tsx` | Invite form, pending invitations with delivery badges, member list with role select / remove |
| Component | `components/dashboard/company-switcher.tsx` | Topbar workspace switcher and "Create workspace" |
| Component | `components/dashboard/email-diagnostics-card.tsx` | Calls `/api/settings/email` |
| API | `app/api/companies/route.ts` | List the user's workspaces; create a workspace |
| API | `app/api/companies/[id]/route.ts` | Update a company profile (OWNER/ADMIN) |
| API | `app/api/company/{audience,brand,logo,formats,contact,timezone,compliance,autopilot}/route.ts` | Active-company settings writes |
| API | `app/api/team/invitations/route.ts` | List / create invitations |
| API | `app/api/team/invitations/[id]/route.ts` | Revoke an invitation |
| API | `app/api/team/members/[userId]/route.ts` | Change role / remove member |
| API | `app/api/invitations/accept/route.ts` | Accept an invitation token |
| API | `app/api/settings/email/route.ts` | Email diagnostics and test send |
| Lib | `lib/rbac.ts` | `Permission`, role matrix, `can`, `assertCan`, `ForbiddenError` |
| Lib | `lib/active-company.ts` | `resolveActiveCompany` (cookie + fallback, request-memoised) |
| Lib | `lib/cookies.ts` | `ACTIVE_COMPANY_COOKIE = 'aura.activeCompany'` (client-safe) |
| Lib | `lib/auth-helpers.ts` | `requireCompanyMembership`, `requireActiveCompany`, `requireCompanyRole` |
| Lib | `lib/email.ts` | Transports, diagnostics, templates |
| Lib | `lib/validations/team.ts` | `inviteMemberSchema`, `updateRoleSchema`, `acceptInviteSchema` |
| Lib | `lib/validations/company.ts` | `createCompanySchema`, `updateCompanySchema`, `websiteSchema` |
| Service | `server/services/company.service.ts` | `createCompanyForUser`, `getCompaniesForUser`, `getMembership`, `getCompanyById`, `getCompanyMembers`, `updateCompany` |
| Service | `server/services/team.service.ts` | `getTeam`, `inviteMember`, `acceptInvitation`, `revokeInvitation`, `updateMemberRole`, `removeMember`, `TeamError` |
| Service | `server/company/profile.service.ts` | Read/write brand assets, business profile, contact facts, marketing profile, content formats in `Company.preferences` |
| Service | `server/company/logo.service.ts` | `storeCompanyLogo`, `logoAssetUrl` |
| Tests | `tests/company-service.test.ts`, `tests/email-delivery.test.ts`, `tests/tenant-isolation.test.ts`, `tests/request-body.test.ts` | See section 10 |

## 5. Data model

| Model / enum | Key fields | Notes |
| --- | --- | --- |
| `Company` | `id`, `name`, `slug` (unique), `website?`, `industry?`, `brandVoiceNotes?`, `logoUrl?`, `timezone` (default `UTC`), `preferences` (JSON, default `{}`), `brandVoiceProfile?` (JSON), `onboardedAt?` | Parent of almost every other model (cascade delete) |
| `CompanyMember` | `userId`, `companyId`, `role: CompanyRole` (default `MEMBER`) | Unique `(userId, companyId)`; cascade on user or company delete |
| `CompanyInvitation` | `companyId`, `email`, `role`, `tokenHash` (unique), `status: InvitationStatus`, `invitedById?`, `expiresAt`, `acceptedAt?`, `emailStatus: EmailDeliveryStatus`, `emailTransport?`, `emailError?`, `emailSentAt?` | Unique `(companyId, email)` |
| `CompanyRole` | `OWNER`, `ADMIN`, `MEMBER`, `VIEWER` | |
| `InvitationStatus` | `PENDING`, `ACCEPTED`, `REVOKED`, `EXPIRED` | |
| `EmailDeliveryStatus` | `PENDING`, `SENT`, `FAILED`, `NOT_CONFIGURED` | |
| `AuditLog` | `action`, `userId?`, `companyId?`, `metadata` | Actions: `COMPANY_CREATED`, `COMPANY_UPDATED`, `COMPANY_MEMBER_ADDED`, `COMPANY_MEMBER_REMOVED`, `COMPANY_MEMBER_INVITED`, `COMPANY_MEMBER_ROLE_UPDATED`, `COMPANY_INVITATION_REVOKED`, `INVITATION_EMAIL_SENT`, `INVITATION_EMAIL_FAILED`, `EMAIL_TEST_SENT`, `ONBOARDING_COMPLETED` |

`Company.preferences` holds JSON sub-objects read by `server/company/profile.service.ts` (brand assets, business profile, contact facts, marketing profile, content formats) and by autopilot.

## 6. API endpoints

Full catalogue: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| GET | `/api/companies` | Workspaces the user belongs to (`companies`, `activeCompanyId` = first) | Signed in |
| POST | `/api/companies` | Create a workspace (onboarding submit); 409 on duplicate name unless `confirmDuplicate` | Signed in |
| PATCH | `/api/companies/:id` | Update company profile | Member with role OWNER or ADMIN |
| PATCH | `/api/company/audience` | Audience, market mode, goals | `company:update` |
| PATCH | `/api/company/brand` | Logo and colour palette | `company:update` |
| POST | `/api/company/logo` | Upload logo (multipart `file`, max 4,000,000 bytes) | `company:update` |
| PATCH | `/api/company/formats` | Enabled content formats | `company:update` |
| GET, PATCH | `/api/company/contact` | Contact facts | GET any member; PATCH `company:update` |
| GET, PATCH | `/api/company/timezone` | Workspace timezone | GET any member; PATCH `company:update` |
| GET, PUT, POST | `/api/company/compliance` | Compliance policy (get / save / reset or test) | GET any member; writes `company:update` |
| PATCH | `/api/company/autopilot` | What Aura may do on its own | `content:approve` |
| GET | `/api/team/invitations` | Pending invitations | `members:invite` |
| POST | `/api/team/invitations` | Invite (or re-invite) by email and role | `members:invite`; OWNER role only by OWNER |
| DELETE | `/api/team/invitations/:id` | Revoke | `members:invite` |
| PATCH | `/api/team/members/:userId` | Change role | `members:remove`; owner rules in service |
| DELETE | `/api/team/members/:userId` | Remove member | `members:remove`; last-owner guard |
| POST | `/api/invitations/accept` | Accept invite token | Signed in; email must match |
| GET | `/api/settings/email` | Email transport diagnostics | `company:update` |
| POST | `/api/settings/email` | Send a test email to self | `company:update` |

## 7. External services

| Service | Used for | Env vars |
| --- | --- | --- |
| SMTP server (nodemailer) | Transactional email | `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` (or port 465), `EMAIL_FROM` |
| Resend API | Transactional email | `RESEND_API_KEY`, `EMAIL_FROM` (default sender `onboarding@resend.dev`) |
| App base URL | Invite links | `APP_URL` / `NEXTAUTH_URL` / Vercel URL via `lib/app-url.ts`; `isLocalAppUrl` warns when links would point to localhost |

See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

- Workspace creation enqueues one `INTELLIGENCE` generation job; the onboarding client kicks it with `POST /api/jobs/:id/run`. See [03-onboarding-and-guided-setup](../03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md).
- Invitation expiry is evaluated on accept (status flips to `EXPIRED` then); there is no sweeping job.

## 9. Security & permissions

- **Single permission source:** `lib/rbac.ts`. Routes check `can()` before acting and return 403 with a readable message.
- **Workspace scoping:** routes take the company from the caller's memberships (`requireActiveCompany`) or verify membership for an id in the path (`requireCompanyRole`); the `/api/company/*` routes have no company id to tamper with.
- **Owner protections:** only an OWNER can grant or change OWNER; the last OWNER can be neither demoted nor removed.
- **Invite tokens:** 32 random bytes, SHA-256 hash stored, 7-day expiry, one active per (company, email), email must match the accepting user.
- **Honest delivery:** invitation rows record what the transport actually did; the UI never claims "sent" for a console-only transport.
- **Validation:** Zod schemas on every body (`lib/validations/team.ts`, `lib/validations/company.ts`); failures are 422.

## 10. Testing

| File | Covers |
| --- | --- |
| `tests/company-service.test.ts` | `createCompanyForUser`: slug + OWNER membership, slug suffix on collision, `COMPANY_CREATED` and `ONBOARDING_COMPLETED` audits |
| `tests/email-delivery.test.ts` | Transport selection, `emailConfigProblems`, `sendEmail` never claiming delivery without a provider, Resend success/error, network failure |
| `tests/tenant-isolation.test.ts` | Cross-company reads of campaigns, leads, drafts, subscriptions, graphics are refused |
| `tests/request-body.test.ts` | Single-use request body (the `POST /api/companies` read-once fix) and `confirmDuplicate` parsing |
| `tests/validations.test.ts` | `company validation schemas` |

End-to-end (app running): `pnpm verify:access` (Business Context, signals, opportunities and recommendations isolated between two workspaces, role refusals for a VIEWER) and `pnpm verify:permissions` (two workspaces, every role, 404 for cross-workspace ids, 403 for forbidden actions).

## 11. Configuration & limits

| Setting | Value | Source |
| --- | --- | --- |
| Invitation TTL | 7 days | `server/services/team.service.ts` |
| Active-company cookie | `aura.activeCompany`, path `/`, max-age 31,536,000 s, `samesite=lax` | `lib/cookies.ts`, `company-switcher.tsx` |
| Company name | 2-80 characters | `lib/validations/company.ts` |
| Logo upload | 4,000,000 bytes | `app/api/company/logo/route.ts` |
| SMTP default port | 587 | `lib/email.ts` |

## 12. Known limitations & future work

- `company:delete` exists in the matrix but no route deletes a workspace.
- `GET /api/companies` reports `activeCompanyId` as the first company, not the cookie value; server components use `resolveActiveCompany` instead.
- The Settings UI offers no "leave workspace" for the current user (members cannot edit their own row).
- Expired invitations are only marked `EXPIRED` when someone tries to accept them; until then they stay `PENDING` (the UI computes "expired" from `expiresAt`).
- `CompanyRole` comment in the schema still says billing management is for "later sprints"; billing is live and limited to OWNER.

## 13. Related documents

- [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md), [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md)
- [SPRINT-1-TECHNICAL.md](../../../SPRINT-1-TECHNICAL.md) — original tenancy model
- [BUSINESS-CONTEXT-MODEL.md](../../../BUSINESS-CONTEXT-MODEL.md) — how profile writes are validated
- [CLIENT-REVIEW-STATUS.md](../../../CLIENT-REVIEW-STATUS.md)
- [01-authentication-and-accounts](../01-authentication-and-accounts/01-FEATURE-DETAILS.md)
- [03-onboarding-and-guided-setup](../03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md)
- [22-billing-and-plans](../22-billing-and-plans/01-FEATURE-DETAILS.md)
- [25-navigation-and-design-system](../25-navigation-and-design-system/01-FEATURE-DETAILS.md)
