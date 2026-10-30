# Authentication & Accounts — Architecture

Authentication is NextAuth v4 with a Prisma adapter and JWT sessions, plus three small custom routes for sign-up and password reset. Edge middleware does the cheap redirect; server helpers in `lib/auth-helpers.ts` re-check the session wherever data is loaded.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Browser"]
    Login["login-form.tsx"]
    Signup["signup-form.tsx"]
    Social["social-buttons.tsx"]
    Reset["forgot / reset forms"]
  end
  MW["middleware.ts<br/>withAuth"]
  subgraph API["API routes"]
    NA["/api/auth/[...nextauth]"]
    SU["/api/auth/signup"]
    FP["/api/auth/forgot-password"]
    RP["/api/auth/reset-password"]
  end
  subgraph LIB["lib"]
    AuthOpts["auth.ts<br/>authOptions"]
    SocialCfg["social-signin.ts"]
    LI["auth-linkedin.ts"]
    Pw["password.ts"]
    RL["rate-limit.ts"]
    Helpers["auth-helpers.ts"]
  end
  subgraph SVC["Services"]
    UserSvc["user.service.ts"]
    TokSvc["auth-token.service.ts"]
    Mail["lib/email.ts"]
  end
  DB[("PostgreSQL<br/>User, Account, PasswordResetToken, AuditLog")]
  Google{{"Google OAuth"}}
  LinkedIn{{"LinkedIn OAuth"}}

  Login --> NA
  Social --> NA
  Signup --> SU
  Reset --> FP
  Reset --> RP
  NA --> AuthOpts
  AuthOpts --> SocialCfg
  AuthOpts --> LI
  AuthOpts --> Pw
  AuthOpts --> DB
  AuthOpts --> Google
  LI --> LinkedIn
  SU --> RL
  SU --> UserSvc
  FP --> TokSvc
  FP --> Mail
  RP --> TokSvc
  UserSvc --> DB
  TokSvc --> DB
  MW -->|"JWT cookie check"| Helpers
```

The forms on the left post either to NextAuth (sign-in, OAuth) or to the three custom routes (sign-up, reset). `social-signin.ts` decides both which providers `authOptions` builds and which buttons appear, so the two cannot disagree. All persistent state is in PostgreSQL; Google and LinkedIn are only called during the OAuth dance.

## Main flow

```mermaid
sequenceDiagram
  participant UI as Signup form
  participant SU as /api/auth/signup
  participant US as user.service
  participant DB as PostgreSQL
  participant NA as NextAuth route
  UI->>SU: POST name, email, password
  SU->>SU: rateLimit signup per IP, 5 per minute
  SU->>US: createUserWithPassword
  US->>DB: find user by email
  alt email exists
    US-->>SU: EmailAlreadyInUseError
    SU-->>UI: 409
  else new email
    US->>US: bcrypt hash, cost 12
    US->>DB: transaction create User OWNER and audit USER_SIGNED_UP
    SU-->>UI: 201 id, email, name
    UI->>NA: signIn credentials, redirect false
    NA->>DB: load user, bcrypt compare
    NA-->>UI: JWT session cookie, 30 days
    UI->>UI: push callbackUrl or /onboarding
  end
```

Sign-up is a two-step client flow: the custom route creates the account, then the form signs in through NextAuth's Credentials provider so the same session code path is used for every login. An invitee arriving with `?callbackUrl=/invite/...` is returned to the invite instead of onboarding.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> ISSUED: forgot-password for a known email
  ISSUED --> USED: reset-password with valid token
  ISSUED --> EXPIRED: 1 hour passes
  ISSUED --> REVOKED: another token for the same user is used
  USED --> [*]
  EXPIRED --> [*]
  REVOKED --> [*]
```

This is the life of a `PasswordResetToken`. There is no status column: `ISSUED` means `usedAt` is null and `expiresAt` is in the future, `USED` and `REVOKED` both set `usedAt`, and `EXPIRED` is computed from `expiresAt`. Any token that is not `ISSUED` is rejected with the same "invalid or has expired" message.

## Data model

```mermaid
erDiagram
  User ||--o{ Account : "has"
  User ||--o{ Session : "has"
  User ||--o{ PasswordResetToken : "requests"
  User ||--o{ CompanyMember : "belongs to"
  User {
    string id PK
    string email
    string passwordHash
    string name
    enum role
    datetime emailVerified
  }
  Account {
    string id PK
    string userId FK
    string provider
    string providerAccountId
  }
  Session {
    string id PK
    string userId FK
    string sessionToken
    datetime expires
  }
  PasswordResetToken {
    string id PK
    string userId FK
    string tokenHash
    datetime expiresAt
    datetime usedAt
  }
  CompanyMember {
    string id PK
    string userId FK
    string companyId FK
    enum role
  }
```

`Account` holds one row per OAuth provider a user has signed in with, which is how a Google and a password login end up on the same `User`. `Session` and `VerificationToken` exist for the adapter but are not used at runtime with JWT sessions. `CompanyMember` is shown for orientation; it is owned by the workspaces feature.

## Design decisions

- **JWT sessions** because the Credentials provider requires them; it also keeps session reads off the database.
- **One predicate for providers and buttons** (`lib/social-signin.ts`) after a real failure where a button appeared without its provider and produced an unexplained NextAuth error.
- **Custom LinkedIn provider** typed `oauth` against `/v2/userinfo`, because the bundled provider calls retired v2 profile endpoints and OIDC id_token verification against LinkedIn has been unreliable.
- **Email account linking allowed, but only for verified emails**, so "log in with Google" reaches the workspace created with a password without letting an unverified address take it over.
- **Import-free password policy module** so client forms do not bundle `bcryptjs` and its Node polyfills.
- **Hashed, single-use, 1-hour reset tokens** with neutral responses, so a database leak or the endpoint itself cannot be used to take over or enumerate accounts.
- **No `SessionProvider`**: the session is read on the server, avoiding a `/api/auth/session` request on every page load.
