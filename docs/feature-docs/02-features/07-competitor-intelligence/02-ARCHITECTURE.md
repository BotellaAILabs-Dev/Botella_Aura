# Competitor Intelligence — Architecture

Competitor Intelligence works in two stages, both on the server. A tracking pass captures each competitor's public signal into a `CompetitorSnapshot`. A report pass merges a week of snapshots into one `CompetitorReport` per company and ISO week. Next.js server pages and client components sit on top of a small set of `/api/competitors` routes. A cron route runs the same two services on a schedule.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Dashboard UI"]
    PageC["competitors/page.tsx"]
    PageR["competitors/reports/page.tsx"]
    Mgr["competitor-manager.tsx"]
    Gen["generate-report-button.tsx"]
    View["report-view.tsx"]
  end
  subgraph API["API routes"]
    RList["/api/competitors<br/>GET POST"]
    RItem["/api/competitors/:id<br/>PATCH DELETE"]
    RTrack["/api/competitors/:id/track<br/>POST"]
    RRep["/api/competitors/reports<br/>POST"]
    RCron["/api/cron/competitors<br/>GET POST"]
  end
  subgraph SVC["server/competitors"]
    SvcC["competitor.service.ts"]
    SvcT["tracking.service.ts"]
    SvcR["report.service.ts"]
    Diff["diff.ts"]
    Src["sources: website, news,<br/>github, linkedin stub"]
  end
  AI{{"AI layer<br/>server/ai/claude.ts"}}
  Ext{{"Websites, Google News RSS,<br/>GitHub REST API"}}
  DB[("PostgreSQL<br/>CompetitorProfile, Snapshot, Report")]

  Mgr -->|"fetch"| RList
  Mgr -->|"fetch"| RItem
  Mgr -->|"Track now"| RTrack
  Gen -->|"Generate now"| RRep
  PageC -->|"listCompetitors"| SvcC
  PageR -->|"listReports"| SvcR
  PageR --> View
  RList --> SvcC
  RItem --> SvcC
  RTrack --> SvcT
  RRep --> SvcT
  RRep --> SvcR
  RCron --> SvcT
  RCron --> SvcR
  SvcT --> Src
  SvcT --> Diff
  Src --> Ext
  Diff --> AI
  SvcR --> AI
  SvcC --> DB
  SvcT --> DB
  SvcR --> DB
```

How to read it:

- **Pages.** The two server pages read from the services directly.
- **Writes.** The three client components write only through the API routes.
- **Two services, three callers.** `tracking.service.ts` and `report.service.ts` are the only pieces that reach external systems. "Track now", "Generate now" and the cron job all call them.
- **AI and its fallback.** AI calls go through `diff.ts` (per-page summaries) and `report.service.ts` (the weekly report). Both have deterministic fallbacks when no provider is configured.

## Main flow

This is the "Generate now" path. The weekly cron runs the same two service calls for every company, without a session.

```mermaid
sequenceDiagram
  participant UI as Browser
  participant API as /api/competitors/reports
  participant T as tracking.service
  participant S as sources
  participant D as diff.ts
  participant AI as AI layer
  participant R as report.service
  participant DB as PostgreSQL

  UI->>API: POST Generate now
  API->>API: requireActiveCompany and company:update check
  API->>T: trackCompany companyId
  loop each competitor with trackingEnabled
    T->>DB: load profile and latest snapshot
    T->>S: capturePage homepage and pricing
    S-->>T: text or skipped reason
    alt first capture
      T->>D: summarizePositioning
      D->>AI: cheap tier summary
    else hash changed
      T->>D: diffTexts then summarizeChange
      D->>AI: cheap tier summary
    else unchanged
      Note over T,D: no AI call
    end
    T->>S: fetchCompetitorNews and fetchGitHubSignal
    T->>DB: create CompetitorSnapshot and audit
  end
  API->>R: generateWeeklyReport
  R->>DB: snapshots in ISO week window
  opt AI provider configured and competitors exist
    R->>AI: standard tier structured report
  end
  R->>DB: upsert CompetitorReport on companyId and weekStart
  R-->>API: report
  API-->>UI: 201 id and weekStart
  UI->>UI: router.refresh
```

How to read it:

- **The loop.** One snapshot is written per tracking-enabled competitor. The `alt` block shows the only three cases for a page capture.
- **When the AI is called.** An AI summary is requested only for a first capture (to record positioning) or when the hash changed (to describe the diff).
- **The report step.** It always writes a row. If the AI is skipped or fails, the payload is deterministic.
- **Re-running.** Running it again in the same week overwrites that week's report.

## Data model

```mermaid
erDiagram
  Company ||--o{ CompetitorProfile : "tracks"
  Company ||--o{ CompetitorReport : "receives weekly"
  CompetitorProfile ||--o{ CompetitorSnapshot : "captured as"

  CompetitorProfile {
    string id PK
    string companyId FK
    string name
    string url
    string pricingUrl
    string linkedInUrl
    string githubOrg
    string notes
    boolean trackingEnabled
    datetime createdAt
  }
  CompetitorSnapshot {
    string id PK
    string competitorId FK
    datetime capturedAt
    string homepageHash
    string homepageText
    string pricingHash
    string pricingText
    json changesSummary
  }
  CompetitorReport {
    string id PK
    string companyId FK
    datetime weekStart
    datetime weekEnd
    json payload
    string model
    datetime generatedAt
  }
```

How to read it:

- **Cascades.** All three tables cascade on delete. Removing a competitor deletes its snapshots, and deleting a company deletes everything.
- **No link from reports to snapshots.** `CompetitorReport` has no foreign key to snapshots. It is a derived digest, unique on `(companyId, weekStart)`, and its `payload` refers to competitors by `competitorId` inside the JSON.
- **JSON shapes.** The `changesSummary` and `payload` JSON follow the `ChangesSummary` and `CompetitorReportPayload` types in `server/competitors/types.ts`.

## Design decisions

- **Public sources only, and LinkedIn as an honest stub.** No official API scope exists for an arbitrary company-page feed, and scraping is off-limits. So `sources/linkedin.ts` always reports itself unavailable, and the reason appears in `skipped` instead of being silently omitted.
- **Hash first, AI second.** A SHA-256 of normalized text answers "did anything change?" for free. AI summaries are only bought for real changes or a first capture. The normalize, hash and diff core is pure and unit-tested.
- **A baseline on the first capture.** A new competitor used to produce an empty first report that looked broken. `summarizePositioning` now records what the page currently claims, so the first report has content.
- **Coverage and skipped reasons are stored with the data.** Each report section carries `coverage`, and each snapshot carries `skipped`, so "nothing changed" can be told apart from "nothing was read".
- **Degrade, never fail.** Every source catches its own errors and returns empty or `null`. Every AI call has a deterministic fallback. `trackCompany` and the cron loop log a failed competitor or company and move on.
- **Idempotent per ISO week.** Upserting on `(companyId, weekStart)` with `weekStart` set to Monday 00:00 UTC makes "Generate now" and the cron job safe to repeat.
- **Normalize stored JSON at the boundary.** `readChangesSummary` guarantees the arrays the type promises. Older snapshots lacking `news` and `skipped` once crashed the page.
- **Reuse the knowledge pipeline's polite fetcher.** `politeFetchHtml` and `htmlToText` from `server/knowledge/` give robots.txt compliance and throttling without a second implementation.
- **Manage permissions follow `company:update`.** Competitor setup is a workspace-configuration act, so it is limited to OWNER and ADMIN, while any member can read.
