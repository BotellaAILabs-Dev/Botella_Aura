# Authentication & Accounts

> Lets a person create a Botella Aura account, sign in with email and password or with Google / LinkedIn, recover a forgotten password, and land on an invitation link already signed in. It exists because every other Aura feature is workspace-scoped and needs a trusted user identity first, and because the rules around it (no account enumeration, single-use reset tokens, verified-email account linking, same-site redirects only) are what keep someone else out of a business's marketing workspace.

## 1. Overview

Authentication is built on **NextAuth v4** (`next-auth`) with the **Prisma adapter** and the **JWT session strategy** (required by the Credentials provider). Three providers can be active:

| Provider | Id | When it is built | Scopes / notes |
| --- | --- | --- | --- |
| Email + password | `credentials` | Always | bcrypt (`bcryptjs`, cost 12) hash in `User.passwordHash` |
| Google | `google` | `GOOGLE_CLIENT_ID` **and** `GOOGLE_CLIENT_SECRET` set | `allowDangerousEmailAccountLinking: true`, gated by the `signIn` callback |
| LinkedIn | `linkedin` | `LINKEDIN_CLIENT_ID` **and** `LINKEDIN_CLIENT_SECRET` set | Custom provider (`lib/auth-linkedin.ts`), `openid profile email` only, `/v2/userinfo` |

LinkedIn sign-in is deliberately identity-only. Posting rights (`w_member_social`) belong to the separate LinkedIn connection flow (`server/services/linkedin.service.ts`), which a workspace owner grants on purpose.

Edge middleware protects `/dashboard/*` and `/onboarding/*`; server components and route handlers re-check the session (`requireUser`, `requireActiveCompany`) as defence in depth.

## 2. User-facing behaviour

| Route | Page file | What the user can do | Who |
| --- | --- | --- | --- |
| `/login` | `app/(auth)/login/page.tsx` | Log in with email + password; "Continue with Google / LinkedIn" buttons when configured; see a readable message for any `?error=` code; link to `/forgot-password` and `/signup`. Honors a same-site `?callbackUrl=` (default `/dashboard`). | Signed-out visitors |
| `/signup` | `app/(auth)/signup/page.tsx` | Create an account (name, work email, password). Social "Sign up with ..." buttons send to `/onboarding`. After success the user is auto-signed-in and sent to `callbackUrl` (e.g. an invite) or `/onboarding`. | Signed-out visitors |
| `/forgot-password` | `app/(auth)/forgot-password/page.tsx` | Request a reset link. Always shows the same neutral message. | Anyone |
| `/reset-password?token=...` | `app/(auth)/reset-password/page.tsx` | Set a new password (with confirm field). A missing token shows "This reset link is missing its token" with a link to request another. | Anyone holding a link |
| `/invite/[token]` | `app/invite/[token]/page.tsx` | Signed-out users are redirected to `/login?callbackUrl=/invite/<token>`; signed-in users see the "Join the team" card (Accept / Not now). Accept calls `POST /api/invitations/accept`, sets the `aura.activeCompany` cookie and opens `/dashboard`. | Signed-in invitee |
| Account menu | `components/dashboard/user-menu.tsx` | "Log out" calls `signOut({ callbackUrl: '/login' })`. | Any signed-in user |

The `(auth)` route group layout (`app/(auth)/layout.tsx`) redirects already-signed-in users to `/dashboard` and renders the centred card on the `aura-gradient` background.

Password rules shown on the signup form: "At least 8 characters, including a letter and a number."

## 3. How it works

### Sign-up (email + password)
1. `SignupForm` validates client-side with `signUpSchema` (react-hook-form + zod resolver).
2. `POST /api/auth/signup` rate-limits by IP (`signup:<ip>`, **5 requests / 60 s**), parses with `signUpSchema`, then calls `createUserWithPassword`.
3. `createUserWithPassword` lower-cases the email, throws `EmailAlreadyInUseError` (409) if it exists, hashes the password (`hashPassword`, bcrypt cost 12) and, in one transaction, creates the `User` with `role: 'OWNER'` and writes a `USER_SIGNED_UP` audit entry (`metadata.method: 'credentials'`, with IP and user agent).
4. The response is `{ id, email, name }` with status 201 (never the hash).
5. The form then calls `signIn('credentials', { redirect: false })`; on success it routes to `callbackUrl || '/onboarding'`, on failure it shows "Account created. Please log in." and routes to `/login`.

### Sign-in (credentials)
- `authorize()` in `lib/auth.ts` parses with `signInSchema`, loads the user by email, and returns `null` both for an OAuth-only user (no `passwordHash`) and for a wrong password — one generic failure, no user enumeration. The form shows "Incorrect email or password."

### Sign-in (Google / LinkedIn)
- `lib/social-signin.ts` is the single predicate (`socialProviderConfigured`) used both to build providers in `lib/auth.ts` and to decide which buttons `SocialButtons` renders, so a button can never appear for a provider that was not built. `partiallyConfiguredSocialProviders()` reports a provider with exactly one of its two env vars set.
- Both OAuth providers link to an existing account by email. The `signIn` callback refuses the link when `oauthEmailLinkable(profile)` is false, which happens only when `email_verified` is explicitly `false` (or `'false'`); a missing claim is accepted on purpose. A refusal redirects to `/login?error=EmailNotVerified`.
- The LinkedIn provider is typed `oauth` (not `oidc`) to avoid id_token JWKS verification, uses `client_secret_post`, and `checks: ['state']` only (no PKCE, because LinkedIn enables PKCE per app).
- On first OAuth sign-in the adapter creates the user; the `createUser` event writes `USER_SIGNED_UP` with `metadata.method: 'oauth'`.

### Session
- JWT strategy, `maxAge` **30 days** (`30 * 24 * 60 * 60`).
- `jwt` callback copies `id` and `role` (default `'OWNER'`) onto the token at sign-in; a token without `role` is backfilled from the database (`'MEMBER'` if missing).
- `session` callback exposes `session.user.id` and `session.user.role`.
- `getSession` is wrapped in React `cache` so one request decodes the session once; `cachedMembership` does the same for membership lookups.
- `signIn` / `signOut` events write `USER_LOGGED_IN` (with provider) and `USER_LOGGED_OUT` audit entries.
- There is no `SessionProvider` in `app/providers.tsx`; nothing calls `useSession`. The session is read on the server and user name/email/avatar are passed to the shell as props.

### Password reset
1. `POST /api/auth/forgot-password` rate-limits (`forgot:<ip>`, **5 / 60 s**), parses `forgotPasswordSchema`, and calls `createPasswordResetToken(email)`.
2. Unknown email is a silent no-op. For a known user, a 32-byte random token (`generateToken(32)`, base64url) is generated; only its SHA-256 hash is stored in `PasswordResetToken` with `expiresAt = now + 1 hour`; a `PASSWORD_RESET_REQUESTED` audit is written.
3. The link `<APP_URL>/reset-password?token=<raw>` is emailed via `sendPasswordResetEmail`. A delivery failure is logged server-side but the response is still the neutral "If an account exists for that email, a reset link is on its way."
4. `POST /api/auth/reset-password` rate-limits (`reset:<ip>`, **10 / 60 s**), parses `resetPasswordSchema`, then `resetPasswordWithToken` rejects missing / used / expired tokens with `InvalidResetTokenError` (400, "This reset link is invalid or has expired."). In one transaction it sets the new hash, marks the token used, marks every other unused token for the user used, and writes `PASSWORD_RESET_COMPLETED`.

### Redirect safety
- `safeRedirectPath()` (`lib/safe-url.ts`) accepts only paths starting with `/` (not `//`), and rejects backslashes and control characters. Used by `LoginForm`, `SignupForm` and the login page for social buttons.

### Error messages on /login
- `authErrorMessage(code)` (`lib/auth-errors.ts`) maps NextAuth v4 codes (`Configuration`, `AccessDenied`, `Verification`, `OAuthSignin`, `OAuthCallback`, `OAuthCreateAccount`, `OAuthAccountNotLinked`, `EmailCreateAccount`, `Callback`, `CredentialsSignin`, `SessionRequired`) plus `EmailNotVerified` to sentences; an unknown code gets "Sign-in did not complete. Please try again."

### Validation rules (`lib/validations/auth.ts`)
| Field | Rule |
| --- | --- |
| `email` | trimmed, lower-cased, required, valid email |
| `password` (new) | min `MIN_PASSWORD_LENGTH` = **8**, max `MAX_PASSWORD_LENGTH` = **72** (bcrypt byte limit), at least one letter and one number |
| `name` | trimmed, 1-80 characters |
| `token` (reset) | non-empty |

`lib/password-policy.ts` holds the two constants with **no imports**, so client forms can import them without pulling `bcryptjs` (and ~317 kB of Node polyfills) into the browser bundle.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/(auth)/layout.tsx` | Shared auth layout; redirects signed-in users to `/dashboard` |
| Page | `app/(auth)/login/page.tsx` | Login card, social buttons, `?error=` message |
| Page | `app/(auth)/signup/page.tsx` | Signup card, social buttons (callback `/onboarding`) |
| Page | `app/(auth)/forgot-password/page.tsx` | Request a reset link |
| Page | `app/(auth)/reset-password/page.tsx` | Set a new password from `?token=` |
| Page | `app/invite/[token]/page.tsx` | Invite landing; redirects signed-out users to login |
| Component | `components/auth/login-form.tsx` | Credentials sign-in via `signIn('credentials')` |
| Component | `components/auth/signup-form.tsx` | Calls `/api/auth/signup`, then auto-sign-in |
| Component | `components/auth/forgot-password-form.tsx` | Calls `/api/auth/forgot-password` |
| Component | `components/auth/reset-password-form.tsx` | Password + confirm; calls `/api/auth/reset-password` |
| Component | `components/auth/social-buttons.tsx` | Renders the enabled provider buttons ("Continue with" / "Sign up with") |
| Component | `components/auth/google-button.tsx`, `linkedin-button.tsx` | `signIn('google' / 'linkedin', { callbackUrl })` |
| Component | `components/auth/auth-divider.tsx` | "or" divider |
| Component | `components/auth/accept-invite.tsx` | Accept / decline an invitation |
| API | `app/api/auth/[...nextauth]/route.ts` | NextAuth catch-all (GET/POST) |
| API | `app/api/auth/signup/route.ts` | Create a local account |
| API | `app/api/auth/forgot-password/route.ts` | Start password reset |
| API | `app/api/auth/reset-password/route.ts` | Complete password reset |
| Lib | `lib/auth.ts` | `authOptions`: providers, callbacks, events, session config |
| Lib | `lib/auth-helpers.ts` | `getSession`, `getCurrentUser`, `requireUser`, `requireCompanyMembership`, `requireActiveCompany`, `requireCompanyRole` |
| Lib | `lib/auth-linkedin.ts` | `LinkedInSignIn` provider, `oauthEmailLinkable` |
| Lib | `lib/auth-errors.ts` | `authErrorMessage` |
| Lib | `lib/social-signin.ts` | `SOCIAL_PROVIDERS`, `socialProviderConfigured`, `enabledSocialProviders`, `partiallyConfiguredSocialProviders` |
| Lib | `lib/password.ts` | `hashPassword`, `verifyPassword` (bcrypt cost 12) |
| Lib | `lib/password-policy.ts` | `MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_LENGTH` (import-free) |
| Lib | `lib/validations/auth.ts` | Zod schemas shared by client and server |
| Lib | `lib/pkce.ts` | PKCE verifier/challenge and encrypted browser-binding cookie for the connector OAuth flows (not used by NextAuth sign-in) |
| Lib | `lib/safe-url.ts` | `safeRedirectPath` |
| Lib | `lib/rate-limit.ts` | In-memory sliding-window `rateLimit`, `clientIp` |
| Edge | `middleware.ts` | `withAuth` on `/dashboard/:path*`, `/onboarding/:path*` |
| Service | `server/services/user.service.ts` | `createUserWithPassword`, `getUserByEmail`, `getUserById`, `EmailAlreadyInUseError` |
| Service | `server/services/auth-token.service.ts` | `createPasswordResetToken`, `resetPasswordWithToken`, `InvalidResetTokenError` |
| Script | `scripts/auth-endpoints.ts` | `npm run auth:endpoints` prints the OAuth redirect URLs to register |
| Tests | `tests/auth-providers.test.ts`, `tests/password.test.ts`, `tests/validations.test.ts`, `tests/security-fixes.test.ts`, `tests/oauth-pkce.test.ts`, `tests/oauth-endpoints.test.ts` | See section 10 |

## 5. Data model

| Model | Key fields | Notes |
| --- | --- | --- |
| `User` | `id`, `email` (unique), `passwordHash?`, `name?`, `image?`, `role: SystemRole` (default `OWNER`), `emailVerified?` | `passwordHash` is null for OAuth-only users. Relations: `accounts`, `sessions`, `memberships`, `passwordResetTokens`, `auditLogs`, and others. |
| `Account` | `userId`, `type`, `provider`, `providerAccountId`, tokens | NextAuth adapter table; unique `(provider, providerAccountId)`; cascade on user delete |
| `Session` | `sessionToken` (unique), `userId`, `expires` | Adapter table; unused at runtime with the JWT strategy |
| `VerificationToken` | `identifier`, `token`, `expires` | Adapter table |
| `PasswordResetToken` | `userId`, `tokenHash` (unique), `expiresAt`, `usedAt?` | SHA-256 hash only; cascade on user delete |

Enum `SystemRole`: `OWNER`, `ADMIN`, `MEMBER`. This system role is separate from the per-workspace `CompanyRole` used for RBAC (see [02-workspaces-team-and-roles](../02-workspaces-team-and-roles/01-FEATURE-DETAILS.md)).

Audit actions written by this feature (`AuditAction` enum): `USER_SIGNED_UP`, `USER_LOGGED_IN`, `USER_LOGGED_OUT`, `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED`.

## 6. API endpoints

Full catalogue: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| GET, POST | `/api/auth/[...nextauth]` | NextAuth sign-in, OAuth callbacks (`/api/auth/callback/google`, `/api/auth/callback/linkedin`), sign-out, session, CSRF | Public (NextAuth) |
| POST | `/api/auth/signup` | Create an email/password account; 201 `{ id, email, name }`; 409 if email exists | Public; rate-limited 5 / min / IP |
| POST | `/api/auth/forgot-password` | Issue a reset token and email it; always the same 200 message | Public; rate-limited 5 / min / IP |
| POST | `/api/auth/reset-password` | Consume a token and set a new password | Public (token is the credential); rate-limited 10 / min / IP |
| POST | `/api/invitations/accept` | Accept an invitation (documented in feature 02) | Signed-in user |

Validation failures return 422 with field errors (`handleRouteError`); rate-limit refusals return 429.

## 7. External services

| Service | Used for | Env vars |
| --- | --- | --- |
| Google OAuth | "Continue with Google" | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| LinkedIn OAuth (OpenID Connect scopes) | "Continue with LinkedIn"; endpoints `https://www.linkedin.com/oauth/v2/authorization`, `https://www.linkedin.com/oauth/v2/accessToken`, `https://api.linkedin.com/v2/userinfo` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| Email transport (SMTP / Resend / console) | Password-reset email (`lib/email.ts`, see feature 02) | `SMTP_*`, `RESEND_API_KEY`, `EMAIL_FROM` |
| NextAuth | Session signing, callback base URL | `NEXTAUTH_SECRET`, `NEXTAUTH_URL` |

Reset links are built with `absoluteUrl()` from `lib/app-url.ts` (`APP_URL`, `NEXTAUTH_URL`, then the Vercel URL). See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md) and [AUTH-SETUP.md](../../../AUTH-SETUP.md) for the redirect URLs to register.

## 8. Background jobs & cron

Not applicable.

## 9. Security & permissions

- **No account enumeration:** credentials sign-in returns the same failure for unknown user, OAuth-only user and wrong password; forgot-password always returns the same message.
- **Password storage:** bcrypt cost 12; inputs over 72 characters are rejected rather than silently truncated; `hashPassword` refuses passwords under 8 characters as a second check.
- **Reset tokens:** 32 random bytes, only the SHA-256 hash stored, 1-hour TTL, single use, and all other outstanding tokens are revoked on success.
- **Verified-email linking:** OAuth account linking by email is refused when the provider says `email_verified: false`.
- **Open-redirect protection:** `safeRedirectPath` on every `callbackUrl`.
- **Rate limiting:** in-memory per instance (`lib/rate-limit.ts`); keys `signup:`, `forgot:`, `reset:` plus client IP from `x-forwarded-for` / `x-real-ip`.
- **Route protection:** `middleware.ts` redirects unauthenticated requests on `/dashboard/*` and `/onboarding/*` to `/login` with a `callbackUrl`; `requireUser()` redirects again in server code; inside route handlers that redirect becomes a 401 ("Not signed in...").
- **Audit trail:** every sign-up, login, logout and reset step is written to `AuditLog`.

## 10. Testing

| File | Covers |
| --- | --- |
| `tests/auth-providers.test.ts` | Provider list per env combination, half-configured providers left out, LinkedIn userinfo endpoint + identity-only scopes + no PKCE + profile mapping, `oauthEmailLinkable` and the `signIn` callback, `authErrorMessage` |
| `tests/password.test.ts` | bcrypt hashing, random salt, verify, OAuth-only (no hash) rejection, minimum length |
| `tests/validations.test.ts` | `auth validation schemas` block (password rules, email normalisation) |
| `tests/security-fixes.test.ts` | `post-login redirect` block (`safeRedirectPath`) |
| `tests/oauth-pkce.test.ts` | `lib/pkce.ts` primitives and binding cookie (used by connector OAuth) |
| `tests/oauth-endpoints.test.ts` | Redirect URI list and `NEXTAUTH_URL` mismatch detection behind `npm run auth:endpoints` |

There is no dedicated `pnpm verify:*` script for authentication; the end-to-end suites `pnpm verify:access` and `pnpm verify:permissions` sign real users in over HTTP as part of their setup.

## 11. Configuration & limits

| Setting | Value | Source |
| --- | --- | --- |
| Session lifetime | 30 days (JWT) | `lib/auth.ts` |
| bcrypt cost | 12 | `lib/password.ts` |
| Password length | 8-72, letter + number | `lib/password-policy.ts`, `lib/validations/auth.ts` |
| Reset token TTL | 1 hour | `server/services/auth-token.service.ts` |
| Signup rate limit | 5 / 60 s / IP | `app/api/auth/signup/route.ts` |
| Forgot-password rate limit | 5 / 60 s / IP | `app/api/auth/forgot-password/route.ts` |
| Reset-password rate limit | 10 / 60 s / IP | `app/api/auth/reset-password/route.ts` |
| Protected paths | `/dashboard/:path*`, `/onboarding/:path*` | `middleware.ts` |
| Env vars | `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `GOOGLE_CLIENT_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET` | see section 7 |

## 12. Known limitations & future work

- The rate limiter is in-process memory; behind several serverless instances it is best-effort. The code notes a shared store (Upstash/Redis) behind the same `rateLimit()` interface as the upgrade path.
- No email verification step for email/password sign-ups (`User.emailVerified` exists but is not set by this flow).
- No in-app "change password" or "link another provider" screen, although the `OAuthAccountNotLinked` message tells users to link from Settings.
- New credential users are always created with `SystemRole.OWNER`; the system role is not used for workspace RBAC.
- A missing `email_verified` claim is accepted on purpose; if a provider changed its response shape to omit it, linking would still be allowed.

## 13. Related documents

- [AUTH-SETUP.md](../../../AUTH-SETUP.md) — Google / LinkedIn credentials and redirect URLs
- [SPRINT-1-TECHNICAL.md](../../../SPRINT-1-TECHNICAL.md) — original auth design
- [SPRINT-6-TECHNICAL.md](../../../SPRINT-6-TECHNICAL.md) — rate limiting
- [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md)
- [02-workspaces-team-and-roles](../02-workspaces-team-and-roles/01-FEATURE-DETAILS.md) — memberships, invitations, email transport
- [03-onboarding-and-guided-setup](../03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md) — where new users go after sign-up
- [25-navigation-and-design-system](../25-navigation-and-design-system/01-FEATURE-DETAILS.md) — account menu and shell
