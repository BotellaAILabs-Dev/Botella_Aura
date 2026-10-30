# Business Context & About My Business — Architecture

The Business Context has one read path and one write path. The read path builds a resolved context from the `Company` row and up to 13 other tables owned by other features. The write path accepts changes only to the business fields stored on `Company`. Two derived artefacts sit on top of the context: a stored, fingerprinted snapshot for AI workflows, and a list of questions about missing or doubtful facts. Each has its own table.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Browser"]
    Page["/dashboard/business<br/>page.tsx"]
    View["BusinessContextView"]
    Ask["AuraQuestions"]
  end
  subgraph API["API routes"]
    RouteBC["/api/business-context<br/>GET, PATCH"]
    RouteSnap["/api/business-context/snapshot<br/>GET, POST"]
    RouteQ["/api/business-context/questions<br/>GET, POST"]
  end
  subgraph SVC["server/business-context"]
    Read["business-context.service.ts<br/>getBusinessContext, prompts"]
    Build["build.ts + facts.ts<br/>resolve, trust, completeness"]
    Write["business-context-write.service.ts<br/>updateBusinessContext"]
    Rules["update.ts<br/>rules R1-R9"]
    Snap["snapshot.service.ts + snapshot.ts"]
    Ques["questions.service.ts"]
  end
  subgraph LIB["lib, pure and client-safe"]
    Model["business-context.ts<br/>schema, registry, freshness"]
    Patch["validations/business-context.ts<br/>strict patch schema"]
    QLib["business-context-questions.ts"]
    UILib["business-context-ui.ts"]
  end
  Writers["Other writers<br/>onboarding, settings, logo, brand voice"]
  Consumers["AI workflows<br/>content, opportunities, recommendations, advisor"]
  DB[("PostgreSQL<br/>Company, snapshot, questions, source tables")]

  Page --> Read
  Page --> Ques
  Page --> View
  Page --> Ask
  View -->|"PATCH"| RouteBC
  Ask -->|"POST"| RouteQ
  View --> UILib
  RouteBC --> Read
  RouteBC --> Write
  RouteSnap --> Snap
  RouteQ --> Ques
  Read --> Build
  Build --> Model
  Write --> Patch
  Write --> Rules
  Ques --> QLib
  Ques --> Write
  Snap --> Read
  Writers --> Write
  Consumers --> Read
  Consumers --> Snap
  Read -->|"reads"| DB
  Write -->|"CAS update + audit"| DB
  Snap -->|"stamp + upsert"| DB
  Ques -->|"history"| DB
```

Read the diagram from top to bottom. The server page calls the read service and the questions service directly. The two client components write only through the API routes.

Every write converges on `updateBusinessContext`, whether it comes from the page, a question answer, or another feature's writer (onboarding, the settings routes, logo upload, brand voice). Every read converges on `getBusinessContext`.

The `lib/` modules have no database access. Client components and tests import the same registry and rules that the server uses.

## Main flow

Editing a field on About my business:

```mermaid
sequenceDiagram
  participant UI as BusinessContextView
  participant API as PATCH /api/business-context
  participant W as updateBusinessContext
  participant P as planBusinessContextWrite
  participant DB as PostgreSQL
  participant R as getBusinessContext

  UI->>API: patch plus expectedRevision
  API->>API: requireActiveCompany and check company:update
  API->>W: patch, origin api, expectedRevision, confirm
  W->>W: businessContextPatchSchema.parse
  loop up to 3 attempts
    W->>DB: read Company row in a transaction
    alt updatedAt differs from expectedRevision
      W-->>API: BusinessContextConflictError 409
    end
    W->>P: stored row, patch, origin
    P-->>W: changed fields, data, references, confirmed
    opt nothing changed or confirmed
      W-->>API: no-op with unchanged revision
    end
    W->>DB: check logo asset belongs to the company
    W->>DB: updateMany where id and updatedAt match
    alt zero rows updated
      Note over W,DB: lost race, plan again from a fresh read
    else row updated
      W->>DB: recordAudit via business-context
    end
  end
  W-->>API: changed, confirmed, revision
  API->>R: reload the context
  R->>DB: Company and section queries in parallel
  R-->>API: resolved BusinessContext
  API-->>UI: changed, confirmed, context
  UI->>UI: keep the newer revision and router.refresh
```

The PATCH route checks permissions, then hands the raw patch to the write service. The write service validates the patch shape again, whatever the caller already checked.

Inside the transaction, three checks can stop the write:
- A stale revision fails immediately with 409.
- A rule refusal from `planBusinessContextWrite` returns 422, with every refused field reported at once.
- A lost compare-and-swap race causes the write to be re-planned. After 3 attempts it becomes a 409.

The route then rebuilds the context, so the client receives the new `meta.revision` with its response.

## Lifecycle / state machine

`BusinessContextQuestion.status` (`ContextQuestionStatus`):

```mermaid
stateDiagram-v2
  [*] --> OPEN: gap detected and question shown
  OPEN --> ANSWERED: answer or confirm
  OPEN --> SNOOZED: not now for 7 days
  OPEN --> DISMISSED: does not apply, non-critical only
  OPEN --> RESOLVED: gap filled elsewhere
  SNOOZED --> OPEN: shown again after the snooze
  SNOOZED --> RESOLVED: gap filled elsewhere
  SNOOZED --> ANSWERED: answer
  ANSWERED --> OPEN: gap returns
  RESOLVED --> OPEN: gap returns
  DISMISSED --> [*]
```

Questions are not stored as the source of truth. They are re-derived from the context on every request, and the table only remembers what happened to each question key.

`sync()` moves OPEN and SNOOZED rows to RESOLVED when their gap is gone. It moves ANSWERED and RESOLVED rows back to OPEN, with `timesAsked` reset, when the gap returns, for example when a goal goes stale again.

`markAsked` re-sets OPEN on an upsert when a question is shown again. DISMISSED is final, and critical questions can never reach it. Resting after 3 unanswered asks is a time filter in `isAskable`, not a separate status.

## Data model

```mermaid
erDiagram
  Company ||--o| BusinessContextSnapshot : "has one stored snapshot"
  Company ||--o{ BusinessContextQuestion : "asked about"
  Company ||--o{ AuditLog : "audited changes"
  Company {
    string id PK
    string name
    string website
    string industry
    string brandVoiceNotes
    json brandVoiceProfile
    json preferences
    string logoUrl
    datetime updatedAt
  }
  BusinessContextSnapshot {
    string id PK
    string companyId FK
    int version
    string fingerprint
    string sourceStamp
    json payload
    datetime generatedAt
    datetime invalidatedAt
  }
  BusinessContextQuestion {
    string id PK
    string companyId FK
    string questionKey
    enum status
    int timesAsked
    datetime lastAskedAt
    datetime snoozedUntil
    datetime answeredAt
    string answeredById
    datetime createdAt
    datetime updatedAt
  }
  AuditLog {
    string id PK
    string companyId FK
    enum action
    json metadata
  }
```

How the tables are used:
- **`Company`** holds every writable business fact. Some are columns. The rest are in the `preferences` JSON, under the keys `business`, `marketingProfile`, `brand`, `contentFormats` and `factMeta`. `updatedAt` doubles as the context revision.
- **`BusinessContextSnapshot`** has a unique `companyId`, so there is exactly one stored full snapshot per workspace. Views are cut from it on read.
- **`BusinessContextQuestion`** is unique on `(companyId, questionKey)`, where `questionKey` is `<kind>:<field>`.
- **`AuditLog`** gets one row per real change, with `metadata.via = 'business-context'`.

Both owned tables cascade-delete with their company. The other source tables the read path uses (memory, competitors, trend config, plans, campaigns, connections, knowledge, drafts, analytics) belong to other features and are not drawn here.

## Design decisions

- **One resolved structure, one registry.** `CONTEXT_FIELDS` records each field's requirement, source precedence, resolution strategy, consumers and fix-it link in one place. Before this, every workflow chose its own fragment of the business, and lead scoring described the company to the model with its tone notes.
- **Stated facts beat derived ones, and nothing is dropped silently.** Settings beat a single month's plan, and plan values only fill gaps (`inferred`). Each overridden value is kept in `meta.issues` so a person can settle it.
- **Trust is per fact, not per table.** The same column can hold a user-typed value or an AI seed. `preferences.factMeta` records the origin of each written path, and AI-derived values are never trusted until a person confirms them. Prompts and snapshots label or separate assumptions instead of stating them as facts.
- **A single validated write path.** Every screen keeps its own request schema and error wording. Adapters with alias maps turn its input into one strict patch, so a value cannot enter the context by a side door.
  - Quality rules judge only changed values, because forms re-send every field.
  - AI may write only `voice.profile`.
- **Optimistic concurrency plus compare-and-swap.** `expectedRevision` (`Company.updatedAt`) stops one user from overwriting another's edit. The retried compare-and-swap on `updatedAt` stops concurrent writers to the shared `preferences` bag, such as voice generation and goal edits, from erasing each other.
- **A stored snapshot refreshed by a source stamp.** One cheap aggregate per source table catches edits in every module without hooks in those modules. A 6-hour TTL covers freshness that changes with the date alone. The fingerprint hashes content, not build time, so AI output can be traced to the exact business state it was produced from.
- **Pure core, thin I/O.** `build.ts`, `facts.ts`, `update.ts`, `snapshot.ts` and the `lib/` modules have no database access. The rules can be unit-tested and shared with client components, and they cannot differ between callers.
- **Ask instead of assume.** Gaps become questions with anti-nagging rules (12-hour ask cooldown, 7-day snooze, rest after 3 asks). Prompts carry a NOT YET KNOWN block, so models say what they do not know rather than inventing it.
