# Workspaces, Team & Roles (RBAC) — Architecture

Every Aura request is resolved to one workspace (`Company`) through the caller's own `CompanyMember` rows, and every action is checked against the role matrix in `lib/rbac.ts`. Team management and invitations live in `server/services/team.service.ts`; outbound email goes through the truthful transport in `lib/email.ts`.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Browser"]
    Switcher["company-switcher.tsx"]
    Team["team-manager.tsx"]
    EmailCard["email-diagnostics-card.tsx"]
    Accept["accept-invite.tsx"]
  end
  subgraph API["API routes"]
    Companies["/api/companies"]
    CompanyId["/api/companies/:id"]
    CompanyX["/api/company/*"]
    Inv["/api/team/invitations"]
    Members["/api/team/members/:userId"]
    AcceptR["/api/invitations/accept"]
    EmailR["/api/settings/email"]
  end
  subgraph LIB["lib"]
    Helpers["auth-helpers.ts<br/>requireActiveCompany"]
    Active["active-company.ts"]
    RBAC["rbac.ts<br/>can, assertCan"]
    Mail["email.ts"]
  end
  subgraph SVC["Services"]
    CompanySvc["company.service.ts"]
    TeamSvc["team.service.ts"]
    Profile["company/profile.service.ts"]
  end
  DB[("PostgreSQL<br/>Company, CompanyMember,<br/>CompanyInvitation, AuditLog")]
  SMTP{{"SMTP or Resend"}}

  Switcher -->|"sets aura.activeCompany cookie"| Active
  Team --> Inv
  Team --> Members
  EmailCard --> EmailR
  Accept --> AcceptR
  Companies --> CompanySvc
  CompanyId --> CompanySvc
  CompanyX --> Profile
  Inv --> TeamSvc
  Members --> TeamSvc
  AcceptR --> TeamSvc
  EmailR --> Mail
  Inv --> Helpers
  Members --> Helpers
  CompanyX --> Helpers
  Helpers --> Active
  Helpers --> RBAC
  Active --> CompanySvc
  TeamSvc --> Mail
  Mail --> SMTP
  CompanySvc --> DB
  TeamSvc --> DB
  Profile --> DB
```

UI components call API routes; each route first resolves the user and active company through `requireActiveCompany` (or `requireCompanyRole` for an id in the path) and checks a permission with `can()`. Services do the database work and write audit rows; only the team service talks to the email transport.

## Main flow

```mermaid
sequenceDiagram
  participant Admin as TeamManager
  participant API as /api/team/invitations
  participant TS as team.service
  participant Mail as lib/email
  participant DB as PostgreSQL
  participant Invitee as Invitee browser
  participant Acc as /api/invitations/accept
  Admin->>API: POST email, role
  API->>API: requireActiveCompany and can members:invite
  API->>TS: inviteMember
  TS->>DB: check existing membership
  TS->>DB: upsert CompanyInvitation PENDING, token hash, 7 day expiry
  TS->>Mail: sendInvitationEmail with accept URL
  Mail-->>TS: delivered, transport, error
  TS->>DB: save emailStatus SENT or FAILED or NOT_CONFIGURED
  TS->>DB: audit COMPANY_MEMBER_INVITED and INVITATION_EMAIL_SENT or FAILED
  API-->>Admin: 201 acceptUrl and emailStatus
  Invitee->>Acc: POST token, signed in
  Acc->>TS: acceptInvitation
  TS->>DB: find by token hash, check PENDING, expiry, email match
  TS->>DB: transaction upsert CompanyMember, mark ACCEPTED, audit COMPANY_MEMBER_ADDED
  Acc-->>Invitee: companyId
  Invitee->>Invitee: set aura.activeCompany cookie, open /dashboard
```

The invitation row is created even when email fails, and the response always carries `acceptUrl`, so the admin can share the link by hand. Acceptance is the only step that creates a membership, and it requires the signed-in user's email to equal the invited one.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> PENDING: inviteMember
  PENDING --> PENDING: re-invite refreshes token and expiry
  PENDING --> ACCEPTED: acceptInvitation
  PENDING --> REVOKED: revokeInvitation
  PENDING --> EXPIRED: accept attempted after expiresAt
  REVOKED --> PENDING: re-invite same email
  EXPIRED --> PENDING: re-invite same email
  ACCEPTED --> PENDING: re-invite same email
  ACCEPTED --> [*]
```

`InvitationStatus` moves only through `team.service.ts`. Because there is one row per (company, email), re-inviting any address upserts the same row back to `PENDING` with a new token, which also invalidates the previous link. Separately, `emailStatus` records the delivery outcome of the latest send.

## Data model

```mermaid
erDiagram
  User ||--o{ CompanyMember : "has"
  Company ||--o{ CompanyMember : "has"
  Company ||--o{ CompanyInvitation : "issues"
  Company ||--o{ AuditLog : "records"
  Company {
    string id PK
    string name
    string slug
    string logoUrl
    string timezone
    json preferences
    datetime onboardedAt
  }
  CompanyMember {
    string id PK
    string userId FK
    string companyId FK
    enum role
  }
  CompanyInvitation {
    string id PK
    string companyId FK
    string email
    enum role
    string tokenHash
    enum status
    datetime expiresAt
    enum emailStatus
    string emailTransport
  }
  AuditLog {
    string id PK
    string companyId FK
    string userId FK
    enum action
    json metadata
  }
  User {
    string id PK
    string email
  }
```

`CompanyMember` is the join between users and workspaces and carries the role that RBAC reads. `CompanyInvitation` is unique on `(companyId, email)` and on `tokenHash`. Every team and workspace change writes an `AuditLog` row.

## Design decisions

- **One role matrix** in `lib/rbac.ts`, so access rules are reviewed in one place and routes only ask `can(role, permission)`.
- **Active company from the caller's memberships**, never trusted from input; most settings routes have no company id in the path at all.
- **Request-memoised lookups** (`cache` on `resolveActiveCompany` and membership) because the layout and page both resolve the same workspace on each navigation; `getCompaniesForUser` selects five columns instead of whole rows.
- **Always keep an owner**, and only owners can create or change owners.
- **Truthful email results** after a real bug where invitations showed "Mail sent" while only the console transport ran; the accept link is always returned for manual sharing.
- **Duplicate-name guard with explicit override** (`confirmDuplicate`) so a double submit does not silently create two identical workspaces.
- **Hashed invite tokens** mirroring password-reset tokens, so a database leak does not expose working links.
