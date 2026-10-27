# Sign in with Google and LinkedIn

How logging in to Botella Aura is configured, and exactly which URLs to register
with each provider. Everything below is read from the repository, not from a
provider's examples.

Run `npm run auth:endpoints` for the live list, for whatever URL you are
actually serving. It prints the URLs, where each one is registered, and which
environment variables are still missing — never a value.

```
npm run auth:endpoints                 # uses APP_URL / NEXTAUTH_URL
npm run auth:endpoints 8081            # http://localhost:8081
npm run auth:endpoints aura.example.com
npm run auth:endpoints https://abc.trycloudflare.com
```

---

## 1. The three ways in

| Method | Provider id | Needs |
| --- | --- | --- |
| Email and password | `credentials` | nothing — always available |
| Google | `google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| LinkedIn | `linkedin` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |

A provider is built only when **both** halves of its credential pair are set
(`lib/social-signin.ts`). The login and signup pages ask that same module which
buttons to draw, so a button cannot appear for a provider that was not built —
which is what used to produce the unexplained "Try signing in with a different
account".

Half a pair set is the usual paste mistake, and the symptom is a button that
silently never appears. `npm run auth:endpoints` says so out loud.

---

## 2. Redirect URIs

Replace `<base>` with the URL you serve — `http://localhost:3001`,
`http://localhost:8081`, `https://aura.example.com`.

| URL | Registered in | For |
| --- | --- | --- |
| `<base>/api/auth/callback/google` | Google Cloud Console → Credentials → OAuth client → Authorised redirect URIs | Log in with Google |
| `<base>/api/auth/callback/linkedin` | LinkedIn Developers → Auth → Authorized redirect URLs | Log in with LinkedIn |
| `<base>/api/linkedin/callback` | LinkedIn Developers → Auth → Authorized redirect URLs | Connecting LinkedIn for publishing |
| `<base>/api/connectors/google/callback` | Google Cloud Console, same OAuth client | GA4 + Search Console connectors |
| `<base>/api/connectors/meta/callback` | Meta app → Facebook Login → Valid OAuth Redirect URIs | Facebook + Instagram |
| `<base>/api/connectors/hubspot/callback` | HubSpot developer app | HubSpot |
| `<base>/api/connectors/mailchimp/callback` | Mailchimp registered app | Mailchimp |
| `<base>/api/connectors/slack/callback` | Slack app → OAuth & Permissions | Slack |

Three things about these:

- **LinkedIn needs two of them.** Signing in and publishing are separate flows
  with different scopes on the one LinkedIn app, so both URLs must be
  registered. Registering only the one you were thinking about leaves the other
  half of the feature broken.
- **Google's two connectors share one callback** (`GOOGLE_REDIRECT_PATH` in
  `server/connectors/providers.ts`), so there is a single URI to register rather
  than one per connector, and nothing to miss.
- **A redirect URI is compared as an exact string.** Same scheme, same port, no
  trailing slash. `…/callback/` is not `…/callback`.

### `NEXTAUTH_URL` has to agree

NextAuth builds its callback from `NEXTAUTH_URL`, not from the port the server
happens to be listening on. Serving on 8081 with `NEXTAUTH_URL` still on 3000
sends the provider a URL nobody registered, and the provider — not Aura —
reports the mismatch. `npm run auth:endpoints <base>` checks this and prints the
line to change.

Registering extra URLs does no harm, so registering localhost **and** the
deployment URL together is the easy way to stop fighting this.

---

## 3. The LinkedIn app

Sign-in uses **Sign In with LinkedIn using OpenID Connect** — scopes
`openid profile email`, profile read from `https://api.linkedin.com/v2/userinfo`.
Add that product to the app or LinkedIn will not grant the scopes.

Aura defines this provider itself (`lib/auth-linkedin.ts`) instead of using
`next-auth/providers/linkedin`, because the bundled one still calls the retired
`/v2/me` profile API with an `r_liteprofile` projection. Those scopes are not
granted to an app created now, so the bundled provider fails at the *last* step
of the flow — after the person has already consented, which is the most
expensive moment to fail.

Publishing is the separate connection in `server/services/linkedin.service.ts`,
which also asks for `w_member_social` ("Share on LinkedIn"). Logging in is not
the moment to ask someone for permission to post as them, so sign-in never asks
for it.

PKCE is **not** sent to LinkedIn by default. LinkedIn enables it per app on
request, and sending a `code_challenge` to an app without it makes LinkedIn
refuse the token exchange. `LINKEDIN_OAUTH_PKCE=true` turns it on for the
publishing connection once LinkedIn has enabled it for the app; CSRF is covered
by the state check either way.

---

## 4. Account linking, and the one check on it

Both providers link by email address: logging in with Google finds the workspace
you signed up for with a password, instead of silently creating a second empty
one. That is `allowDangerousEmailAccountLinking`, and the danger in its name is
real — a provider that handed out an address it had never confirmed would let
anyone register that address there and walk into the matching Aura account.

So the `signIn` callback refuses an OAuth sign-in whose profile says
`email_verified: false` (`oauthEmailLinkable()` in `lib/auth-linkedin.ts`), and
sends the person to `/login?error=EmailNotVerified`. Google and LinkedIn both
confirm addresses and both report it.

A *missing* claim is allowed, deliberately: both providers document sending it,
so its absence means the response changed shape, and locking every user out of
sign-in is a worse failure than the one it would avert.

---

## 5. When sign-in fails

Every failure lands on `/login?error=<code>`, and the login page now explains
the code in a sentence (`lib/auth-errors.ts`). Before that it rendered a clean
login form with no indication anything had gone wrong, so the natural response
was to try again and conclude login was broken.

| Code | Usually means |
| --- | --- |
| `OAuthCallback` | the redirect URI is not registered, or does not match exactly |
| `Configuration` | a credential is missing on this deployment |
| `AccessDenied` | the person cancelled at the provider |
| `OAuthAccountNotLinked` | that email already has an account made another way |
| `EmailNotVerified` | the provider reports the address as unverified (§4) |

---

## 6. Checking it

```
npm run auth:endpoints 8081      # the URLs, and what is still missing
npm run env:check                # which integrations are configured, by name
npx vitest run tests/auth-providers.test.ts tests/oauth-endpoints.test.ts
```

Against a running app, this lists the providers it actually built:

```
curl -s http://localhost:3001/api/auth/providers
```

If a provider is missing there, no amount of registering URLs will help — its
credentials are not set.
