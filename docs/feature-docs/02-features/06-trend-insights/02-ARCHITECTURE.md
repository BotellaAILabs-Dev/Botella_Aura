# Trend Insights — Architecture

Trend Insights is a fetch → score → enrich → store pipeline. It has one orchestrator, `generateDigestForCompany` in `server/trends/digest.service.ts`, and three entry points: the background-job path used by the dashboard, the scheduled cron, and a legacy synchronous refresh route. Sources sit behind a single `TrendSource` interface. Scoring and seasonal lookup are pure functions. The result is one JSON `TrendDigest` row per company per UTC day.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Dashboard UI"]
    PageTrends["/dashboard/trends<br/>page.tsx"]
    PageCfg["/dashboard/settings/trends<br/>TrendConfigForm"]
    BtnRefresh["RefreshDigestButton<br/>useGenerationJob"]
  end

  subgraph API["API routes"]
    RouteJobs["/api/jobs + /api/jobs/:id/run"]
    RouteCfg["/api/trends/config"]
    RouteRefresh["/api/trends/refresh"]
    RouteCron["/api/cron/trends"]
  end

  subgraph SVC["Server services"]
    Runner["server/jobs/runners.ts<br/>TREND_DIGEST"]
    Digest["digest.service.ts<br/>generateDigestForCompany"]
    CfgSvc["trend-config.service.ts"]
    Scoring["scoring.ts + seasonal.ts"]
    Safety["lib/brand-safety.ts"]
    BC["business-context.service.ts"]
  end

  Sources["sources/index.ts<br/>HN, Reddit, News, X"]
  Claude{{"Anthropic Claude"}}
  Ext{{"HN API, Reddit, Google and Bing News RSS, X API"}}
  DB[("PostgreSQL<br/>TrendDigest, CompanyTrendConfig")]

  BtnRefresh -->|"queue and run"| RouteJobs
  PageCfg -->|"PUT"| RouteCfg
  RouteJobs --> Runner
  Runner --> Digest
  RouteRefresh --> Digest
  RouteCron -->|"per company"| Digest
  RouteCfg --> CfgSvc
  Digest --> CfgSvc
  Digest --> Sources
  Sources -->|"HTTP"| Ext
  Digest --> Scoring
  Digest --> Safety
  Digest --> BC
  Digest -->|"enrich + synthesise"| Claude
  CfgSvc --> DB
  Digest -->|"upsert"| DB
  PageTrends -->|"getRecentDigests"| DB
```

Read the diagram top to bottom.

- **Entry points:** three routes reach the same orchestrator. The jobs path (used by the Refresh button), the legacy refresh route and the cron loop all call `generateDigestForCompany`.
- **Config:** the orchestrator reads the company's config through `trend-config.service.ts`. That service also seeds smart defaults.
- **Fetching:** sources are fetched through the registry in `sources/index.ts`.
- **Processing:** items are ranked by the pure scoring module and safety-classified before Claude ever sees them.
- **Output:** the page never calls the API. It is a server component that reads the stored digests directly.

## Main flow

```mermaid
sequenceDiagram
  participant UI as RefreshDigestButton
  participant Jobs as /api/jobs
  participant Run as /api/jobs/id/run
  participant D as digest.service
  participant Cfg as trend-config.service
  participant Src as TrendSources
  participant AI as Claude
  participant DB as PostgreSQL

  UI->>Jobs: POST kind TREND_DIGEST
  Jobs-->>UI: job id, status QUEUED
  UI-)Run: POST fire and forget
  Run->>D: generateDigestForCompany trigger manual
  D->>Cfg: ensureTrendConfig, seedSmartDefaults, toFetchContext
  Cfg->>DB: read or create CompanyTrendConfig
  D->>Src: fetchTrendItems in parallel with allSettled
  Src-->>D: TrendItem lists, skipped sources noted
  D->>D: scoreAndRank limit 20
  D->>D: classifySource per item
  opt ANTHROPIC_API_KEY set
    D->>AI: completeStructured enrichment batch
    AI-->>D: aiSummary, suggestedAngle, suitableForPromotion
    D->>AI: completeStructured synthesis
    AI-->>D: summary, recommendations, hashtags
  end
  D->>D: upcomingSeasonalEvents, findCompetitorMentions
  D->>DB: upsert TrendDigest on companyId and date
  D->>DB: AuditLog TREND_DIGEST_GENERATED
  D-->>Run: digest row
  loop every 1.5 s until done
    UI->>Jobs: GET /api/jobs/id
    Jobs-->>UI: status and progress percent
  end
  UI->>UI: toast and router.refresh
```

How to read it:

- **Creating the job:** the browser queues a job and fires the run request without awaiting it.
- **Polling:** the browser then polls the job for progress. The orchestrator reports progress at 8, 20, 55, 80 and 95 %.
- **The `opt` block:** both Claude calls are optional. Without an API key, or when a call fails, deterministic fallbacks fill the same fields.
- **Other entry points:** the cron and the legacy refresh route call `generateDigestForCompany` directly with the same steps, just without the polling loop.

## Lifecycle / state machine

A digest has no status of its own. The manual run is tracked by the shared `GenerationJob` row (`kind = TREND_DIGEST`):

```mermaid
stateDiagram-v2
  [*] --> QUEUED: POST /api/jobs
  QUEUED --> RUNNING: claimJob on run
  RUNNING --> SUCCEEDED: digest upserted
  RUNNING --> FAILED: permanent error or attempts exhausted
  RUNNING --> QUEUED: retryable error or stuck, under 3 attempts
  SUCCEEDED --> [*]
  FAILED --> [*]
```

`claimJob` only succeeds for the caller that moves the row out of `QUEUED`, so a duplicate run request is a no-op. A `TREND_DIGEST` job with no activity for 10 minutes counts as stuck (the default `STUCK_AFTER_MS`). The job service may then retry it, up to `MAX_ATTEMPTS = 3`. The digest itself is idempotent per day, so a retry overwrites today's row instead of adding one.

## Data model

```mermaid
erDiagram
  Company ||--o| CompanyTrendConfig : "configures"
  Company ||--o{ TrendDigest : "one per UTC day"
  Company ||--o{ GenerationJob : "runs"
  CompanyTrendConfig {
    string id PK
    string companyId FK
    string keywords
    string subreddits
    string rssFeeds
    string competitorNames
    json enabledSources
    string geoCountry
    string geoRegion
    string geoCity
    string language
    int timeRangeDays
    boolean defaultsSeeded
    datetime updatedAt
  }
  TrendDigest {
    string id PK
    string companyId FK
    datetime date
    json payload
    datetime createdAt
  }
  GenerationJob {
    string id PK
    string companyId FK
    enum kind
    enum status
    json progress
    json result
    int attempts
  }
```

How to read it:

- **Owned models:** the feature owns `CompanyTrendConfig` (1:1 with `Company`) and `TrendDigest`. Both cascade-delete with the company.
- **Array columns:** the list fields of `CompanyTrendConfig` are native Postgres `text[]` columns. They are shown as `string` because of Mermaid's type limits.
- **Idempotency:** `TrendDigest` has a unique `(companyId, date)`, which is what makes generation idempotent. All digest content (items, synthesis, seasonal moments, competitor mentions, source counts) lives in the `payload` JSON.
- **Shared model:** `GenerationJob` is shared infrastructure. Only rows with `kind = TREND_DIGEST` belong to this feature.

## Design decisions

- **One `TrendSource` interface.** Every connector returns normalised `TrendItem[]` and declares `isConfigured()`. Scoring, enrichment and the UI are source-agnostic, and adding a source means one file plus one registry entry in `sources/index.ts`.
- **Never fabricate.** A source that is unconfigured is skipped and listed in `skippedSources`, and the page shows a banner for it. A source that fails contributes zero items. No placeholder data is generated for either case.
- **Idempotent per company/day.** The upsert on `(companyId, date)` makes a cron double-fire, a manual refresh, or a job retry safe. Each run replaces today's digest instead of duplicating it.
- **Pure, injectable scoring.** `scoreItem` and `upcomingSeasonalEvents` do no I/O and take `now` as a parameter, so they are deterministic in unit tests. The weights and half-life are named constants (`SCORING`).
- **Brand safety before the model.** `classifySource` runs on every item before enrichment. The model's verdict can only make an item *stricter*, and an unsuitable item never keeps a model-written angle. The fallback path follows the same rules. This was added after a news story about deaths produced a promotional post angle.
- **Schema-validated AI output.** Enrichment and synthesis use `completeStructured` with Zod schemas, so a reply with the wrong shape is detected instead of silently becoming "no enrichment".
- **Graceful AI fallback.** Without `ANTHROPIC_API_KEY`, or on an AI error, deterministic summaries, angles, recommendations and hashtags still produce a full digest, labelled `model: "fallback"`.
- **Background job for manual refresh.** A digest fans out to many feeds and makes two model calls, which can outlive a serverless function budget. Running it as a `GenerationJob` with progress reporting replaced an opaque spinner and timeouts.
- **Localised, industry-matched news.** Google News queries and topic headlines use the workspace's country and language. Industry press is chosen by regex on industry and keywords, and a business that matches nothing gets no industry feed rather than technology press.
- **Tolerant reads.** `normalizeDigestPayload` and the `UNKNOWN_SOURCE` fallback in `TrendCard` let a digest written by an older build render with fewer sections instead of crashing the page.
- **Sequential cron.** Companies are processed one at a time so tenants do not compete for shared third-party rate limits. Each digest is committed as it completes, so a timeout mid-run loses no finished work.
