# Aura Home, What Matters Now & Weekly Briefing — Architecture

Aura Home is a Server Component. On every request it reads from several services in parallel and passes the results through pure rule modules (`lib/aura-home.ts`, `lib/what-matters.ts`). Two scheduled pipelines write the snapshots that Home also reads. The weekly Autopilot cycle stores a `WorkspaceBriefing`. The daily intelligence run stores an `IntelligenceSnapshot`.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Pages and components"]
    Home["app/dashboard/page.tsx"]
    Intel["app/dashboard/intelligence/page.tsx"]
    BView["briefing-view.tsx<br/>getting-started.tsx"]
    IView["intelligence-view.tsx"]
  end
  subgraph API["API routes"]
    RBrief["/api/briefing"]
    RIntel["/api/intelligence"]
    CronB["/api/cron/briefing"]
    CronI["/api/cron/intelligence"]
    RJobs["/api/jobs INTELLIGENCE"]
  end
  subgraph SVC["Server services"]
    SvcHome["home.service.ts"]
    SvcWM["what-matters.service.ts"]
    SvcAuto["autopilot.service.ts"]
    SvcBrief["briefing.service.ts"]
    SvcIntel["intelligence.service.ts"]
  end
  subgraph LIB["Pure rules"]
    LibHome["lib/aura-home.ts"]
    LibWM["lib/what-matters.ts"]
    LibText["text-metrics.ts"]
  end
  DB[("PostgreSQL")]
  AI{{"Anthropic or Gemini via server/ai/claude.ts"}}
  Img{{"Image providers"}}

  Home --> SvcHome
  Home --> SvcBrief
  Home --> BView
  BView -->|"POST force"| RBrief
  Intel --> SvcIntel
  Intel --> IView
  IView --> RJobs
  RBrief --> SvcAuto
  CronB --> SvcAuto
  RIntel --> SvcIntel
  CronI --> SvcIntel
  RJobs --> SvcIntel
  SvcHome --> SvcWM
  SvcHome --> LibHome
  SvcWM --> LibWM
  SvcAuto --> SvcBrief
  SvcIntel --> LibText
  SvcHome --> DB
  SvcWM --> DB
  SvcBrief --> DB
  SvcIntel --> DB
  SvcAuto -->|"generateDraft"| AI
  SvcAuto -->|"one graphic per post"| Img
  SvcIntel -->|"reword suggestions"| AI
```

How to read it: the Home page goes straight to the services; it has no API route of its own. Only three paths can reach a model or image provider: Autopilot (writing posts and graphics), the intelligence run (rewording suggestions), and the manual and cron triggers that start them. The briefing service only reads and writes the database. Both cron routes and the manual POST routes call the same service functions, so a run started by hand and a scheduled run behave the same way.

## Main flow

```mermaid
sequenceDiagram
  participant U as Browser
  participant P as app/dashboard/page.tsx
  participant H as home.service getAuraHome
  participant W as what-matters.service
  participant B as briefing.service
  participant DB as PostgreSQL
  U->>P: GET /dashboard
  P->>P: requireUser and resolveActiveCompany
  par Parallel loads
    P->>B: getLatestBriefing companyId
    B->>DB: findFirst WorkspaceBriefing order by weekStart desc
  and
    P->>H: getAuraHome companyId now
    H->>DB: suggestions, counts, opportunities, results, activity, readiness
    H->>W: getWhatMatters
    W->>DB: opportunities, signals, coverage
    W-->>H: WhatMatters state, items, gaps
    Note over H: each part wrapped in part() and falls back on error
    H-->>P: AuraHome
  end
  P-->>U: Home with This week briefing
  opt User clicks run now
    U->>P: POST /api/briefing force true
    Note over P: content create plus 2 per hour rate limit
    P->>B: runAutopilot then generateBriefing upsert
    P-->>U: ran, activity, briefing then router refresh
  end
```

How to read it: the briefing and the live Home data load at the same time. Inside `getAuraHome`, each of the seven sources is isolated by `part()`, so a failing source (analytics, for example) only blanks its own section. The optional block is the manual "catch me up" run. It writes through the same Autopilot path as the Monday cron, and the page then re-renders with `router.refresh()`.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> WORKING: runAutopilot upsert
  WORKING --> READY: generateBriefing assembled
  WORKING --> FAILED: assembly threw
  READY --> READY: re-assemble same week, readAt reset
  FAILED --> WORKING: next run, not skipped as already ran
  READY --> WORKING: manual run with force
  READY --> [*]
```

How to read it: one `WorkspaceBriefing` row exists per company per ISO week. A run sets the row to `WORKING` and then to `READY`. If assembly throws, the row becomes `FAILED` with an `error`. A non-forced run skips writing posts when the week already has a row that is not FAILED: it only re-assembles the briefing, which keeps the row `READY`. A FAILED week is retried in full. When Autopilot is disabled, `generateBriefing` writes the row directly as `READY`, without the WORKING step.

## Data model

```mermaid
erDiagram
  Company ||--o{ WorkspaceBriefing : "has weekly"
  Company ||--o{ IntelligenceSnapshot : "has daily"
  Company ||--o{ ContentDraft : "owns"
  WorkspaceBriefing {
    string id PK
    string companyId FK
    datetime weekStart
    datetime weekEnd
    enum status
    json payload
    json activity
    string error
    string model
    datetime generatedAt
    datetime readAt
  }
  IntelligenceSnapshot {
    string id PK
    string companyId FK
    datetime date
    json payload
    int overallScore
    string model
    datetime generatedAt
  }
  Company {
    string id PK
    json preferences
  }
  ContentDraft {
    string id PK
    string companyId FK
    enum status
    datetime scheduledFor
    datetime publishedAt
  }
```

How to read it: the feature owns two snapshot tables. `WorkspaceBriefing` is unique on `(companyId, weekStart)` and `IntelligenceSnapshot` is unique on `(companyId, date)`. Both are upserted, so re-running replaces the snapshot instead of adding a new one. Autopilot settings live in `Company.preferences.autopilot`. Autopilot creates and updates `ContentDraft` rows. Everything else Home shows is read live from other features' tables (opportunities, signals, recommendations, leads, analytics).

## Design decisions

- **Recommendation-led Home, computed live.** The old Home was a weekly snapshot whose "Needs you" counts could be up to 7 days old. The sections above "This week" are now computed on every request, and the briefing is kept below them as Aura's weekly report.
- **One failing source never breaks Home.** `part()` returns a fallback and logs a warning, so analytics, suggestions or another source can fail without taking the page down. `verify:home` simulates such an outage.
- **No fabrication.** What matters now has explicit `insufficient` and `quiet` states and a list of gaps. The briefing records `coverage.skipped` reasons instead of filling sections with placeholders. Results show "—" instead of a misleading zero.
- **The briefing assembles; it does not generate.** `assembleBriefing` makes no model calls, so it is instant and costs nothing, and a briefing can be rebuilt at any time. The payload is a snapshot of that week.
- **Autopilot is built to avoid unwanted spending.**
  - It runs unless a workspace turns it off.
  - It is idempotent per week.
  - It takes graphics only from the plan allowance that is left, and posts are still written when graphics are not.
  - It asks for exactly one image variation.
  - Any unknown `publishMode` falls back to `review`.
  - Auto-approval requires `auto` mode, a connected channel and the weekly cap of 5.
- **Cron and manual runs share one code path.** `POST /api/briefing` and `/api/cron/briefing` both call `runAutopilot`, so they cannot drift apart. Cron routes export `GET = POST` for Vercel Cron.
- **Scores are deterministic; the model only gives advice.** Intelligence scores come from `text-metrics.ts` and ratios over real rows. The model may reword and reorder suggestions, but impact and priority are recomputed by the code. Unmeasured areas are excluded from the overall score instead of being counted as zero, and a setup-only score is labelled as setup progress.
- **Pure rule modules.** `lib/aura-home.ts` and `lib/what-matters.ts` have no database access and are unit-tested directly. The services only load data and map it to the rule inputs.
