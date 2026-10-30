# Onboarding & Guided Setup — Architecture

Onboarding is a client-side wizard that posts once to `POST /api/companies` and optionally asks `POST /api/onboarding/preview` for a sample post. Guided setup is a pure read model: `getOnboardingState` derives eight step states from existing tables every time the dashboard or `/dashboard/setup` renders.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Browser"]
    Wizard["onboarding-wizard.tsx"]
    Checklist["setup-checklist.tsx"]
  end
  subgraph Pages["Server pages"]
    OnbPage["app/onboarding/page.tsx"]
    SetupPage["app/dashboard/setup/page.tsx"]
    HomePage["app/dashboard/page.tsx"]
  end
  subgraph API["API routes"]
    Preview["/api/onboarding/preview"]
    Companies["/api/companies"]
    JobRun["/api/jobs/:id/run"]
  end
  subgraph SVC["Services and lib"]
    Steps["lib/onboarding.ts<br/>ONBOARDING_STEPS"]
    State["checklist.service.ts<br/>getOnboardingState"]
    CompanySvc["company.service.ts<br/>createCompanyForUser"]
    BC["business-context update rules"]
    Claude["server/ai/claude.ts"]
    Jobs["job.service.ts<br/>enqueueJob"]
  end
  DB[("PostgreSQL")]
  LLM{{"Anthropic or Gemini"}}

  OnbPage --> Wizard
  Wizard --> Preview
  Wizard --> Companies
  Wizard --> JobRun
  Preview --> Claude
  Claude --> LLM
  Companies --> CompanySvc
  CompanySvc --> BC
  CompanySvc --> DB
  Companies --> Jobs
  Jobs --> DB
  SetupPage --> State
  HomePage --> State
  State --> Steps
  State --> DB
  SetupPage --> Checklist
  HomePage --> Checklist
```

The left half is write-once onboarding: the wizard calls the preview route any number of times, then creates the workspace and kicks its first job. The right half is the read-only checklist: two pages call `getOnboardingState`, which combines the static step list in `lib/onboarding.ts` with counts from the database.

## Main flow

```mermaid
sequenceDiagram
  participant W as Onboarding wizard
  participant P as /api/onboarding/preview
  participant C as /api/companies
  participant S as company.service
  participant DB as PostgreSQL
  participant J as Job run route
  W->>W: steps Business, Audience, Voice with local validation
  opt user asks for a sample
    W->>P: POST profile and voice notes
    P-->>W: sample or null with note and retryable
  end
  W->>C: POST full payload and confirmDuplicate
  alt same name already exists and not confirmed
    C-->>W: 409
    W->>W: confirm dialog, then press Create again
  else created
    C->>S: createCompanyForUser
    S->>DB: transaction Company, OWNER member, audits
    C->>DB: enqueue INTELLIGENCE job
    C-->>W: 201 id and intelligenceJobId
    W->>W: set aura.activeCompany cookie
    W->>J: POST run, keepalive, not awaited
    W->>W: push /dashboard
  end
```

The preview never blocks progress: it always answers 200, with `sample: null` and a note when the AI is unavailable. The intelligence job is fired without waiting so the redirect is immediate; the generation queue's safety net picks it up if the kick is lost.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> NO_WORKSPACE: account created
  NO_WORKSPACE --> WIZARD: visit /onboarding or redirected from /dashboard
  WIZARD --> ONBOARDED: POST /api/companies succeeds
  ONBOARDED --> SETUP_IN_PROGRESS: checklist shows first incomplete step
  SETUP_IN_PROGRESS --> SETUP_IN_PROGRESS: a step's data is added or removed
  SETUP_IN_PROGRESS --> SETUP_FINISHED: all eight steps done
  SETUP_FINISHED --> SETUP_IN_PROGRESS: data behind a step is deleted
  SETUP_FINISHED --> [*]
```

These states are not stored anywhere except `Company.onboardedAt`. "Setup finished" is recomputed on every render, so deleting the last knowledge source or disconnecting the only channel reopens the matching step and brings the checklist back.

## Design decisions

- **Completion is derived, never stored.** A step is done when its data exists, so the checklist stays honest across devices and after deletions.
- **Exactly one current step.** Only the first incomplete step has a button, so the user always has one obvious next action.
- **Only the business step is required.** The rest are labelled as improvements, with a `why` stated as the outcome.
- **The wizard requires a description and an audience**, because a workspace that finished onboarding with only a name produced generic or invented drafts.
- **Market mode asked in the wizard**, because it is the largest fork in how content is written and every workspace previously fell back to B2B.
- **Onboarding data goes through the Business Context rules**, so it cannot store a value the settings pages would refuse.
- **Preview told to invent nothing**, so the first thing Aura writes for a new user is not a fabricated claim.
- **First analysis queued at creation**, so the dashboard is not blank on arrival.
