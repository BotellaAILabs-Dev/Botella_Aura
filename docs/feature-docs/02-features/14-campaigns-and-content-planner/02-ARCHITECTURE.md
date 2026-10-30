# Campaigns & Content Planner — Architecture

Campaigns and the Content Planner are two thin planning layers over the rest of Aura. The Campaign Orchestrator turns a goal into a stored plan and a `CampaignTask` schedule that a daily job executes by calling the existing content, outreach and discovery pipelines; the Content Planner turns a monthly brief into a dated calendar stored as a single `MarketingPlan` row. Neither publishes or sends anything — all output waits for human approval.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Dashboard pages"]
    PList["campaigns/page.tsx"]
    PNew["campaigns/new + campaign-form.tsx"]
    PDetail["campaigns/[id] + timeline + pause"]
    PPlan["planner/page.tsx + planner-view.tsx"]
  end
  subgraph API["API routes"]
    ROrch["/api/campaigns/orchestrate"]
    RStatus["/api/campaigns/:id/status"]
    RCron["/api/cron/campaigns"]
    RJobs["/api/jobs MARKETING_PLAN"]
  end
  subgraph SVC["Server services"]
    SCamp["campaign.service.ts"]
    SPlanner["campaigns/planner.ts"]
    SExec["executor.service.ts"]
    SCheck["checkpoint.service.ts"]
    SPlan["planner/plan.service.ts"]
    SDraft["calendar-draft.ts"]
  end
  Gate["lib/execution-gate.ts"]
  Pipes["Content generator, outreach drafter, lead discovery"]
  AI{{"AI layer server/ai/claude.ts"}}
  DB[("PostgreSQL")]

  PNew --> ROrch
  PDetail --> RStatus
  PPlan --> RJobs
  ROrch --> SCamp
  RStatus --> SCamp
  SCamp --> SPlanner
  SCamp --> Gate
  RCron --> SExec
  SExec --> Gate
  SExec --> Pipes
  SExec --> SCheck
  RJobs --> SPlan
  SPlan --> SDraft
  SPlanner --> AI
  SCheck --> AI
  SDraft --> AI
  SCamp --> DB
  SExec --> DB
  SPlan --> DB
  PList --> DB
```

The top row is server-rendered pages that read through services, and the client components that call the API routes. The campaign path splits into creation (`campaign.service.ts` and `planner.ts`) and execution (`executor.service.ts`, triggered only by the cron route). The execution gate is checked in both. The planner path runs through the shared generation-job system and ends in `calendar-draft.ts`. Every AI call goes through the shared AI layer.

## Main flow

Creating an orchestrated campaign, then the daily run that executes it.

```mermaid
sequenceDiagram
  participant UI as campaign-form.tsx
  participant API as /api/campaigns/orchestrate
  participant Svc as campaign.service
  participant Plan as campaigns/planner
  participant AI as AI layer
  participant DB as PostgreSQL
  participant Cron as /api/cron/campaigns
  participant Exec as executor.service
  participant Pipe as Existing pipelines

  UI->>API: POST name, goal, durationDays, modules, themes
  API->>API: content:approve check and campaigns entitlement
  opt recommendationId present
    API->>API: getCreation and campaignCreationHandoff
  end
  API->>Svc: createCampaign
  Svc->>Plan: generateCampaignPlan
  alt AI configured
    Plan->>AI: completeStructured with campaignPlanSchema
    AI-->>Plan: overview and days
    Plan->>Plan: gatePlan strips disabled modules
  else no AI or AI error
    Plan->>Plan: deterministicPlan
  end
  Plan-->>Svc: plan and model
  Svc->>DB: transaction - Campaign ACTIVE or DRAFT, CampaignTask rows, audits
  Svc-->>API: campaign
  API-->>UI: 201 id, status, execution blocked flag
  Note over Cron,Exec: Daily, Bearer CRON_SECRET
  Cron->>Exec: executeDueCampaignTasks
  Exec->>DB: due PENDING tasks of ACTIVE campaigns, max 100
  loop each task not held by the gate
    Exec->>Pipe: generateDraft or draftForLead or runDiscovery or checkpoint
    Pipe-->>Exec: draft id or run id
    Exec->>DB: task GENERATED or SKIPPED or FAILED plus audit
  end
  Exec->>DB: close campaigns with no PENDING task as COMPLETED
  Exec-->>Cron: processed, generated, skipped, failed, completed
```

Read it in two halves. Above the note, the request is synchronous: the plan is generated and the whole schedule is written in one transaction before the 201 response. Below the note, the cron call runs independently and moves tasks through their statuses. The output is drafts in the normal approval queues, never published posts or sent messages.

A second flow, the Content Planner, works the same way but runs as a background job.

```mermaid
sequenceDiagram
  participant UI as planner-view.tsx
  participant Jobs as /api/jobs
  participant Run as MARKETING_PLAN runner
  participant Svc as plan.service
  participant Draft as calendar-draft
  participant AI as AI layer
  participant DB as PostgreSQL

  UI->>Jobs: start MARKETING_PLAN with brief
  Jobs-->>UI: job id, client polls progress
  Run->>Svc: generateMarketingPlan
  Svc->>Svc: buildSchedule - weekday slots at postsPerWeek
  Svc->>DB: brand context, latest trend digest, knowledge retrieve
  alt AI configured
    Svc->>Draft: draftCalendar with 45 s deadline
    Draft->>AI: strategy call, up to 15 s
    par one call per week
      Draft->>AI: week items for its own slots
    end
    Draft-->>Svc: items, with outline for anything late
  else no AI
    Svc->>Svc: outlineCalendar from the brief
  end
  Svc->>DB: upsert MarketingPlan on companyId and month, audit
  Run-->>Jobs: month, items, model
  Jobs-->>UI: SUCCEEDED, page refreshes
```

The schedule (real dates) is computed before the model is asked, so the model only fills slots. Strategy and weeks share one deadline; anything not returned in time is filled from the brief and flagged in `payload.outline`. The upsert makes regeneration replace that month's plan.

## Lifecycle / state machine

Stored campaign status (`CampaignStatus`), as written by the code.

```mermaid
stateDiagram-v2
  [*] --> ACTIVE: orchestrate, planned from scratch
  [*] --> DRAFT: orchestrate from recommendation, or bare POST /api/campaigns
  ACTIVE --> PAUSED: pause
  PAUSED --> ACTIVE: resume
  ACTIVE --> COMPLETED: executor finds no PENDING task
  DRAFT --> ACTIVE: resume, only when not gated
  COMPLETED --> [*]
```

Campaign tasks (`CampaignTaskStatus`).

```mermaid
stateDiagram-v2
  [*] --> PENDING: materialised from plan
  PENDING --> GENERATED: executor produced output
  PENDING --> SKIPPED: nothing to do
  PENDING --> FAILED: error during run
  GENERATED --> APPROVED: linked draft approved or published
  APPROVED --> GENERATED: linked draft reopened
```

`ARCHIVED` exists in the enum and is filtered from lists but no code path sets it, so it is not shown. A `DRAFT` campaign held by the execution gate cannot move to `ACTIVE` (resume returns 409). What users see is not this enum: `lib/campaign-status.ts` derives Needs review, Behind, Running, Paused, Finished, Planned / Not started from the stored status plus task counts.

## Data model

```mermaid
erDiagram
  Company ||--o{ Campaign : "owns"
  Company ||--o{ MarketingPlan : "owns"
  Campaign ||--o{ CampaignTask : "schedules"
  Campaign ||--o{ ContentDraft : "groups"
  Campaign {
    string id PK
    string companyId FK
    string name
    string goal
    enum status
    datetime startDate
    datetime endDate
    int durationDays
    json modulesIncluded
    json plan
    string recommendationId
    json creationContext
  }
  CampaignTask {
    string id PK
    string campaignId FK
    string companyId FK
    datetime scheduledDate
    enum taskType
    enum status
    string topic
    string relatedContentDraftId
    string relatedDiscoveryRunId
    string checkpointSummary
    string error
  }
  MarketingPlan {
    string id PK
    string companyId FK
    datetime month
    json inputs
    json payload
    string model
    string createdById
    datetime generatedAt
  }
  ContentDraft {
    string id PK
    string campaignId FK
    enum status
  }
```

A campaign owns its plan as JSON and its schedule as `CampaignTask` rows; each task links to what it produced through `relatedContentDraftId` or `relatedDiscoveryRunId` (plain ids, not foreign-key relations). `MarketingPlan` is independent of campaigns and unique per company and month. Generated content drafts carry `campaignId`, which is how the checkpoint counts published pieces.

## Design decisions

- **Plan, then conduct.** The orchestrator only writes a plan and tasks; execution reuses `generateDraft`, `draftForLead` and `runDiscovery` so there is no second generation path and every output goes through the existing approval gate.
- **Validated AI output with a deterministic fallback.** `campaignPlanSchema` and `gatePlan` stop the model from adding days or modules the user did not enable, and `deterministicPlan` / `outlineCalendar` mean both tools still work with no AI provider.
- **Real dates before the model.** `buildSchedule` computes weekday slots, and the prompt forbids moving them, so the calendar cannot drift into an undated topic list.
- **Deadline-bounded parallel drafting.** The monthly plan used to be one large call that could exceed the 60 s runner; it is now a short strategy call plus concurrent per-week calls under a 45 s budget, with late parts filled from the brief.
- **Derived display state.** The raw enum cannot say whether a campaign needs attention, so `lib/campaign-status.ts` combines status with task counts, and every state names its action or says there is none.
- **Execution gate in one constant.** Work planned from recommendations can be created and reviewed now, but `CONTEXTUAL_EXECUTION_ENABLED` keeps the executor, resume and pause from running it until execution is switched on.
- **Owner attribution and audits.** Cron-driven work is attributed to the company owner so drafts have a real creator, and every step (`CAMPAIGN_*`, `MARKETING_PLAN_GENERATED`) is audited.
- **Isolated task failures.** A failing task is marked `FAILED` with its error, and the run carries on with the rest.
