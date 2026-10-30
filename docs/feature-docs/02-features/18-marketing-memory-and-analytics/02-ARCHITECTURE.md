# Marketing Memory & Analytics — Architecture

Each source of real metrics writes a `PerformanceSnapshot`. Two read paths are built on top of those rows. Analytics adds them up into results and a weekly written report. Marketing Memory extracts patterns from them, and those patterns go back into the generation prompts through the Business Context and the campaign planner.

## Component architecture

```mermaid
flowchart LR
  subgraph UI["Dashboard pages"]
    PageMem["/dashboard/memory<br/>What works for you"]
    PageAn["/dashboard/analytics<br/>Results"]
  end
  subgraph In["Metric sources"]
    Ext["Chrome extension"]
    Manual["Log results dialog"]
    MetaCol["meta-insights.service.ts"]
  end
  subgraph API["API routes"]
    RMemGen["/api/memory/generate"]
    RMemId["/api/memory/[id]"]
    RMan["/api/analytics/manual"]
    RRep["/api/analytics/report"]
    RExt["/api/extension/metrics"]
    RCron["/api/cron/memory + /api/cron/analytics"]
  end
  subgraph Svc["Services"]
    Perf["performance.service.ts"]
    Extract["extraction.service.ts"]
    MemSvc["memory.service.ts"]
    AnSvc["analytics.service.ts"]
    RepSvc["report.service.ts"]
  end
  AI{{"server/ai/claude.ts<br/>Claude or Gemini"}}
  DB[("PostgreSQL<br/>PerformanceSnapshot<br/>MarketingMemory<br/>AnalyticsReport")]
  BC["Business Context + campaign planner"]

  Ext --> RExt --> Perf
  Manual --> RMan --> DB
  MetaCol --> DB
  PageMem --> RMemGen --> Extract
  PageMem --> RMemId --> MemSvc
  PageAn --> RRep --> RepSvc
  RCron --> Extract
  RCron --> RepSvc
  Perf --> DB
  Extract --> Perf
  Extract -->|"optional"| AI
  RepSvc --> AnSvc --> Perf
  RepSvc -->|"optional"| AI
  Extract --> DB
  MemSvc --> DB
  RepSvc --> DB
  DB -->|"active memories"| BC
```

Read the diagram from the sources on the left to the database on the right. All three sources end in `PerformanceSnapshot`. Only the extension path goes through `performance.service.ts`, because it has to match a post URL to a draft. `getContentPerformance` in `performance.service.ts` is the single read model that both `extraction.service.ts` and `analytics.service.ts` use. The AI client is optional on both paths, and each path has a deterministic fallback. Active `MarketingMemory` rows leave the feature through the Business Context and the campaign planner.

## Main flow

```mermaid
sequenceDiagram
  participant UI as AnalyzeButton
  participant API as /api/memory/generate
  participant EX as extraction.service
  participant PF as performance.service
  participant AI as server/ai/claude
  participant DB as PostgreSQL
  UI->>API: POST
  API->>API: requireActiveCompany and can content:approve
  API->>EX: generateMemories companyId
  EX->>PF: getContentPerformance
  PF->>DB: latest snapshot per published draft
  PF-->>EX: ContentPerf list with engagement and wordCount
  EX->>DB: deactivate active MarketingMemory rows
  alt fewer than 10 measured posts
    EX->>DB: create OTHER LOW not enough data note
  else enough data
    opt AI provider configured
      EX->>AI: completeStructured with extractedInsightsSchema
      AI-->>EX: up to 8 insights with basis
    end
    Note over EX: on AI error or no key use analyzeDeterministic
    EX->>DB: create one MarketingMemory per insight
  end
  EX->>DB: audit MARKETING_MEMORY_GENERATED
  EX-->>API: status sampleSize created
  API-->>UI: JSON then router.refresh
```

This is the on-demand "Analyze now" path. The weekly `/api/cron/memory` route runs the same `generateMemories` call for every company, without the session and permission check. The previous generation is always deactivated first, so after a run the page shows either the honest low-data note or the new set of insights, never both.

## Lifecycle / state machine

`MarketingMemory` has no status enum. Its lifecycle is the `isActive` flag plus the `editedByUser` mark in `supportingDataSummary`.

```mermaid
stateDiagram-v2
  [*] --> ACTIVE: generateMemories creates insight
  ACTIVE --> EDITED: PATCH corrects text
  EDITED --> EDITED: PATCH again
  ACTIVE --> INACTIVE: DELETE dismiss
  EDITED --> INACTIVE: DELETE dismiss
  ACTIVE --> INACTIVE: next generateMemories run
  EDITED --> INACTIVE: next generateMemories run
  INACTIVE --> [*]
```

`ACTIVE` and `EDITED` rows are both `isActive = true`, and both reach prompts. `EDITED` insights are ranked first and labelled "confirmed by the company". Dismissal and regeneration both make a row inactive without deleting it, so it stays auditable. Note that regeneration also makes `EDITED` rows inactive. Separately, an active insight older than 60 days counts as `stale` in the Business Context and is left out of prompts, but it stays active.

## Data model

```mermaid
erDiagram
  Company ||--o{ PerformanceSnapshot : "measures"
  Company ||--o{ MarketingMemory : "learns"
  Company ||--o{ AnalyticsReport : "reports"
  ContentDraft ||--o{ PerformanceSnapshot : "measured by"
  Company ||--o{ ContentDraft : "owns"
  PerformanceSnapshot {
    string id PK
    string companyId FK
    string contentDraftId FK
    enum source
    json metrics
    datetime capturedAt
  }
  MarketingMemory {
    string id PK
    string companyId FK
    enum insightType
    string insight
    enum confidence
    int sampleSize
    json supportingDataSummary
    boolean isActive
    datetime generatedAt
  }
  AnalyticsReport {
    string id PK
    string companyId FK
    datetime periodStart
    datetime periodEnd
    string summary
    json metrics
    datetime generatedAt
  }
  ContentDraft {
    string id PK
    string companyId FK
    enum status
    string publishedUrl
    datetime publishedAt
  }
```

`PerformanceSnapshot` is the raw fact table. A draft can have many snapshots, and only the newest one per draft is used. `MarketingMemory` and `AnalyticsReport` are derived outputs with no foreign key back to the snapshots they came from. Traceability comes from `supportingDataSummary.basis` and `sampleSize`. `AnalyticsReport` is unique on `(companyId, periodStart)`, which is what makes weekly generation idempotent.

## Design decisions

- **One snapshot shape for every source.** A manual entry is a normal `PerformanceSnapshot` with `source = MANUAL`, so Analytics, Memory and content intelligence need no special cases. The measurement loop can work before any OAuth connector is approved.
- **Honesty gates over plausible output.** `MIN_SAMPLE_FOR_INSIGHTS = 10`, the `hasData` flag, the at-least-one-metric rule and the "not enough data" note all exist so the product never shows invented insights or misleading zero charts.
- **Confidence comes from sample size, not from the model.** Confidence is a transparent function of the number of measured posts (15 and 30 thresholds), so users can see why an insight is LOW or HIGH.
- **AI is optional.** Extraction and the report both work without an AI key. The deterministic analysis emits an insight only when there is a clear gap (more than 25% or 20%).
- **Soft deletes.** Dismissed and superseded insights are set inactive rather than deleted, so earlier learnings stay auditable.
- **Memory reaches prompts through the Business Context.** The main generators get memory as a `memory` section of the Business Context, ranked, de-duplicated, freshness-filtered and capped at 12. A correction calls `invalidateContextSnapshot` because the model has no `updatedAt`.
- **No server-side LinkedIn fetch.** Personal-post numbers come from the user's own page DOM through the extension. The URL fallback match handles the difference between the URL used to post and the permalink viewed later.
- **Crons are idempotent per company and alias GET to POST,** so they work with Vercel Cron or any other scheduler. A failure for one company does not stop the others.
