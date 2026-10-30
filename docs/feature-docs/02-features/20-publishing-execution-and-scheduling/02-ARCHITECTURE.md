# Publishing, Execution Engine & Scheduling — Architecture

Publishing works in two layers. The **publication claim** (`ContentPublication`) makes sure a post is sent at most once. The **execution** (`Execution` + `ExecutionEvent`) is the visible lifecycle around that claim: each state change is checked against a fixed transition table and recorded. Scheduling stores UTC instants, and a protected cron route publishes whatever is due.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Dashboard"]
    UIExec["/dashboard/executions<br/>execution-list.tsx"]
    UIPost["Post page<br/>publish, schedule, status"]
  end
  subgraph API["API routes"]
    RExec["/api/executions/**"]
    RDraft["/api/content/drafts/[id]/<br/>publish, schedule, execution, publications"]
    RTz["/api/company/timezone"]
    RCron["/api/cron/publish"]
  end
  subgraph SVC["Services"]
    SPub["publish.service.ts"]
    SStore["publication-store.ts<br/>processing.service.ts"]
    SEngine["engine.service.ts"]
    SActions["execution-actions.service.ts"]
    SRoute["routing.service.ts"]
    SHand["execution-handoff.service.ts"]
    SSched["schedule-input.ts"]
  end
  subgraph LIB["Pure lib"]
    LState["execution-state.ts"]
    LRoute["execution-routing.ts"]
    LTz["timezone.ts"]
  end
  SConn["Connections<br/>health.service.ts"]
  DB[("PostgreSQL<br/>Execution, ExecutionEvent,<br/>ContentPublication, ExecutionHandoff")]
  Ext{{"Meta Graph API<br/>LinkedIn REST API"}}
  UIExec --> RExec
  UIPost --> RDraft
  UIPost --> RExec
  RExec --> SActions
  RDraft --> SPub
  RDraft --> SSched
  RDraft --> SHand
  RTz --> LTz
  RCron --> SPub
  RCron --> SActions
  RCron --> SStore
  SActions --> SPub
  SActions --> SRoute
  SPub --> SStore
  SPub --> SRoute
  SPub --> SEngine
  SRoute --> LRoute
  SRoute --> SConn
  SEngine --> LState
  SSched --> LTz
  SHand --> SEngine
  SStore --> DB
  SEngine --> DB
  SHand --> DB
  SPub -->|"official API"| Ext
```

User actions reach `publish.service.ts` either directly (publish now) or through `execution-actions.service.ts` (retry). The cron route drives the same publisher with `automatic: true`. Before any network call, `publish.service.ts` asks `routing.service.ts`, which uses the Connections health gate. Every outcome flows back into `engine.service.ts`, which is the only code that changes an execution's status.

## Main flow

```mermaid
sequenceDiagram
  participant Cron as Scheduler
  participant API as /api/cron/publish
  participant PUB as publish.service
  participant ST as publication-store
  participant RT as routing.service
  participant ENG as engine.service
  participant NET as Meta or LinkedIn
  participant DB as PostgreSQL
  Cron->>API: GET with Bearer CRON_SECRET
  API->>API: isCronAuthorized, set 45 s deadline
  API->>PUB: runScheduledPublishes now
  PUB->>DB: APPROVED drafts due, oldest first, max 100
  loop each due draft until deadline
    PUB->>PUB: assertPublishable and assertContentIntact
    PUB->>ST: claimPublication automatic
    ST->>DB: create PUBLISHING or compare-and-swap
    ST-->>ENG: syncFromPublication QUEUED then EXECUTING
    PUB->>RT: routeExecution channel, provider, scopes, health, page
    alt route refused
      RT->>DB: audit EXECUTION_ROUTING_FAILED
      PUB-->>ST: finish as MANUAL
    else route ok
      PUB->>NET: post text and media
      NET-->>PUB: post id, url or error
      PUB->>ST: finishPublication PUBLISHED, PROCESSING or MANUAL
    end
    ST-->>ENG: syncFromPublication COMPLETED, FAILED or ACTION_REQUIRED
    ENG->>DB: CAS status and ExecutionEvent
  end
  API->>API: advanceProcessing for Instagram
  API->>API: runExecutionSweep for rate-limit retries
  opt time left
    API->>API: collectMetaInsights
  end
  API-->>Cron: attempted, published, skipped, deferred
```

"Publish now" and "Retry now" follow the same inner steps, without the loop and with a person as the actor. The claim comes before routing and the network call, so two overlapping runs can't both reach the provider. When the deadline passes, no new publish starts; the remaining drafts are reported as `deferred` and picked up on the next run.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> APPROVED: approved
  APPROVED --> READY_FOR_EXECUTION: handoff ready
  APPROVED --> ACTION_REQUIRED: handoff blocked
  READY_FOR_EXECUTION --> SCHEDULED: time set
  READY_FOR_EXECUTION --> QUEUED: publish now
  SCHEDULED --> SCHEDULED: reschedule
  SCHEDULED --> QUEUED: due
  QUEUED --> EXECUTING: claimed
  EXECUTING --> EXECUTING: still processing
  EXECUTING --> COMPLETED: provider accepted
  EXECUTING --> FAILED: rate limited or refused
  EXECUTING --> ACTION_REQUIRED: connection, content, unknown outcome
  FAILED --> QUEUED: retry after backoff or by a person
  FAILED --> ACTION_REQUIRED: out of attempts
  ACTION_REQUIRED --> QUEUED: retry now
  READY_FOR_EXECUTION --> CANCELLED: cancel
  SCHEDULED --> CANCELLED: cancel
  QUEUED --> CANCELLED: cancel
  FAILED --> CANCELLED: cancel
  ACTION_REQUIRED --> CANCELLED: cancel
  CANCELLED --> APPROVED: approved again
  COMPLETED --> [*]
```

This shows the main transitions from `TRANSITIONS` in `lib/execution-state.ts`. A few less common ones are left out: back to `APPROVED` or `READY_FOR_EXECUTION`, `APPROVED --> CANCELLED`, `QUEUED --> SCHEDULED` and `QUEUED --> COMPLETED`. `COMPLETED` has no outgoing transitions, so a published post can never run again. Only rate-limited failures go back to `QUEUED` automatically. Unknown outcomes always stop at `ACTION_REQUIRED`, for a person to check.

Publication claim (`PublicationStatus`):

```mermaid
stateDiagram-v2
  [*] --> PUBLISHING: claim
  PUBLISHING --> PUBLISHED: accepted
  PUBLISHING --> PROCESSING: Instagram processing
  PUBLISHING --> MANUAL: fallback or reconnect
  PUBLISHING --> FAILED: stale lease, outcome unknown
  PROCESSING --> PUBLISHED: processing sweep
  FAILED --> PUBLISHING: person retries
  MANUAL --> PUBLISHING: person retries
  PUBLISHED --> [*]
```

`PUBLISHED` can't be claimed again. A `PUBLISHING` row older than the 3-minute lease becomes `FAILED` instead of being retried, because Aura can't tell whether the network received it. The scheduler never re-claims `FAILED` or `MANUAL` rows. Only a person can, or an execution retry for a rate limit.

## Data model

```mermaid
erDiagram
  ContentDraft ||--o{ Execution : "one per platform"
  ContentDraft ||--o{ ContentPublication : "one per platform"
  ContentDraft ||--o{ ExecutionHandoff : "one per platform"
  Execution ||--o{ ExecutionEvent : "records"
  Company ||--o{ Execution : "owns"
  Execution {
    string id PK
    string companyId FK
    string contentDraftId FK
    enum platform
    enum status
    string connectionId
    string targetExternalId
    string recommendationId
    string approvalId
    string contentHash
    datetime scheduledFor
    string scheduledTimeZone
    int attemptCount
    int maxAttempts
    datetime nextAttemptAt
    string externalId
    string errorCode
  }
  ExecutionEvent {
    string id PK
    string executionId FK
    string companyId
    string actor
    string actorUserId
    string reason
    json detail
    datetime at
  }
  ContentPublication {
    string id PK
    string contentDraftId FK
    enum platform
    enum status
    string contentHash
    int attempts
    datetime startedAt
    string externalId
  }
  ExecutionHandoff {
    string id PK
    string contentDraftId FK
    enum platform
    enum status
    json payload
    json issues
    int contentVersion
  }
```

All three per-draft tables are unique on (`contentDraftId`, `platform`), so one post sent to Facebook and Instagram has two executions, two publication claims and two handoffs. `ExecutionEvent` is append-only history. Its `from` and `to` status columns are left out of the diagram only because `to` is a Mermaid keyword. The trace ids on `Execution` (`recommendationId`, `approvalId` and the others) are plain strings, not foreign keys, so deleting upstream records never breaks the publishing history.

## Design decisions

- **Claim separate from lifecycle.** The publication claim's only job is to prevent duplicate posts, and it stays small. The execution adds visibility, retries and cancellation without weakening that guarantee.
- **Compare-and-swap on every transition.** Concurrent actors (cron, a person, a second scheduler) can't overwrite each other. The loser sees the change and gets a 409.
- **Retry only when the post certainly did not go out.** Rate limits are the only automatic retry. Timeouts and interrupted attempts need a person, because posting twice is worse than posting late.
- **Route before calling the network.** Provider, permissions, health and target page are decided up front and saved on the execution, so a refusal is explained and audited instead of returned as a raw provider error.
- **Honest fallback.** When an API path is missing (X, copy-only types, wrong media), the result is `manual` with the text copied and a reason. It is never reported as published.
- **UTC storage, workspace-zone input and display.** Wall times are converted on the server in the business's IANA zone, with DST handled per date. Changing the zone never moves a scheduled instant.
- **Time-boxed cron.** A 45 s budget inside a 60 s function means a publish is never cut off halfway. The job can be called every minute and by several schedulers at once.
- **GET equals POST on the cron route.** Vercel Cron sends GET, and manual or external schedulers can use either method with the same bearer check.
