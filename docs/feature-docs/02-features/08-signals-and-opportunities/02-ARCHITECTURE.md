# Signals & Opportunity Detection — Architecture

Signals and opportunities are a pipeline: source modules (trends, competitors, analytics, memory, Business Context) are normalised into a `Signal` store, three detectors turn signals into candidate opportunities, and one write path (`recordOpportunity`) stores them with evidence, derived confidence and priority. Pure rules live in `lib/` and are unit-tested; database work lives in `server/`; API routes only authenticate, check permissions, validate and call services.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Dashboard"]
    PageOpp["/dashboard/opportunities<br/>opportunities-view.tsx"]
    PageAdv["/dashboard/advisor<br/>advisor-view.tsx"]
  end
  subgraph API["API routes"]
    RSig["/api/signals<br/>/api/signals/refresh"]
    ROpp["/api/opportunities<br/>/:id, /:id/status"]
    RDet["/api/opportunities/detect"]
    RAdv["/api/advisor<br/>/api/cron/advisor"]
    RRec["/api/opportunities/:id/recommendations"]
  end
  subgraph SVC["Server services"]
    SvcSig["signal.service.ts<br/>normalize.ts"]
    SvcRule["detection.service.ts"]
    SvcAi["ai-detection.service.ts"]
    SvcAdv["advisor.service.ts<br/>from-advisor.ts"]
    SvcOpp["opportunity.service.ts"]
  end
  subgraph LIB["Pure lib"]
    LibSig["lib/signals.ts"]
    LibRule["lib/opportunity-detection.ts"]
    LibAi["lib/ai-opportunity-detection.ts"]
    LibOpp["lib/opportunities.ts<br/>lib/opportunity-ui.ts"]
  end
  DB[("PostgreSQL<br/>Signal, Opportunity, AdvisorReport")]
  AI{{"Anthropic or Gemini"}}
  RecEng["Recommendation engine<br/>feature 09"]

  PageOpp --> ROpp
  PageOpp --> RDet
  PageOpp --> RRec
  PageAdv --> RAdv
  RSig --> SvcSig
  ROpp --> SvcOpp
  RDet --> SvcRule
  RDet --> SvcAi
  RAdv --> SvcAdv
  RRec --> RecEng
  SvcAdv -->|"collect, detect, record"| SvcSig
  SvcAdv --> SvcRule
  SvcAdv --> SvcAi
  SvcRule --> SvcOpp
  SvcAi --> SvcOpp
  SvcAdv --> SvcOpp
  SvcSig --> LibSig
  SvcRule --> LibRule
  SvcAi --> LibAi
  SvcOpp --> LibOpp
  SvcSig --> DB
  SvcOpp --> DB
  SvcAi --> AI
  SvcAdv --> AI
```

Read top to bottom: the two dashboard pages call API routes, routes call services, services use pure lib modules for rules and write to PostgreSQL. All three detectors (rules, AI detection, advisor) converge on `opportunity.service.ts`, which is the only code that writes `Opportunity` rows. The advisor service is also an orchestrator: one advisor run collects signals and runs both other detectors before recording its own opportunities. Recommending an opportunity hands off to the recommendation engine in [../09-recommendations-and-aura-suggests](../09-recommendations-and-aura-suggests/).

## Main flow

The primary request is "Look for new opportunities" on the Opportunities page.

```mermaid
sequenceDiagram
  participant UI as Opportunities page
  participant API as /api/opportunities/detect
  participant Det as detection.service
  participant Sig as signal.service
  participant AiS as ai-detection.service
  participant Model as AI provider
  participant Opp as opportunity.service
  participant DB as PostgreSQL

  UI->>API: POST detect
  API->>API: requireActiveCompany and company:update check
  API->>Det: runDetection with collect true
  Det->>Sig: collectSignals
  Sig->>DB: read 5 sources, upsert Signal rows by dedupeKey
  Det->>DB: listSignals limit 500, rule history, rejected evidence
  Det->>Det: rules, gates, muting, merge within run
  loop each accepted candidate
    Det->>DB: find open same-type opportunity citing same records
    Det->>Opp: recordOpportunity
    Opp->>DB: create or update Opportunity, OpportunitySignal, OpportunityEvent
  end
  opt ai is not 0
    API->>AiS: runAiDetection
    AiS->>DB: context snapshot and up to 40 selected signals
    alt provider configured and at least 2 signals
      AiS->>Model: completeStructured prompt ai-detect-v1
      Model-->>AiS: JSON opportunities
      AiS->>AiS: validateAiOutput
      AiS->>Opp: recordOpportunity for each valid item
      AiS->>DB: audit OPPORTUNITY_AI_DETECTION_RUN
    else
      AiS-->>API: status skipped with reason
    end
  end
  API->>API: suggestFromOpportunities budget 25s
  API-->>UI: outcomes, suppressed, mutedRules, ai, suggestions
  UI->>UI: toast count created or reopened, router refresh
```

The rule run always completes first and is never affected by the AI step: AI detection returns a status (`ok`, `partial`, `rejected`, `failed`, `skipped`) instead of throwing, and the auto-suggestion step is wrapped in a catch. Both detectors check for an existing open opportunity of the same type citing the same records before recording, so the same opening found by different detectors becomes one row. The page then reloads server data, which expires stale opportunities before listing.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> DETECTED: recordOpportunity creates it
  DETECTED --> REVIEWED: mark reviewed
  DETECTED --> RECOMMENDED: recommend
  DETECTED --> ACCEPTED: accept
  DETECTED --> REJECTED: reject
  DETECTED --> EXPIRED: relevance window passed
  REVIEWED --> RECOMMENDED: recommend
  REVIEWED --> ACCEPTED: accept
  REVIEWED --> REJECTED: reject
  REVIEWED --> EXPIRED: relevance window passed
  RECOMMENDED --> ACCEPTED: accept
  RECOMMENDED --> REJECTED: reject
  RECOMMENDED --> EXPIRED: relevance window passed
  REJECTED --> REVIEWED: reopen
  EXPIRED --> DETECTED: detected again with fresh evidence
  ACCEPTED --> [*]
```

`DETECTED`, `REVIEWED` and `RECOMMENDED` are the open (`ACTIVE_STATUSES`) states; only these can expire, and only `expireOpportunities` moves anything to `EXPIRED` (people are never offered it). `ACCEPTED` is final, and re-detecting an accepted or rejected opportunity is skipped so a person's decision stands. `EXPIRED -> DETECTED` is not a manual transition: it happens only inside `recordOpportunity` when a detector sees the same `dedupeKey` again. Moves to `ACCEPTED`, `REJECTED` and `EXPIRED` are mirrored onto the opportunity's recommendations that are still `GENERATED` or `PRESENTED`.

## Data model

```mermaid
erDiagram
  Company ||--o{ Signal : "has"
  Company ||--o{ Opportunity : "has"
  Company ||--o{ AdvisorReport : "has"
  Opportunity ||--o{ OpportunitySignal : "evidenced by"
  Opportunity ||--o{ OpportunityEvent : "history"
  Signal |o--o{ OpportunitySignal : "cited as"
  Opportunity ||--o{ Recommendation : "answered by"

  Signal {
    string id PK
    string companyId FK
    enum source
    enum kind
    string title
    string refId
    int occurrences
    datetime observedAt
    datetime expiresAt
    enum reliability
    json metadata
    string dedupeKey
  }
  Opportunity {
    string id PK
    string companyId FK
    enum type
    enum status
    string title
    enum source
    string detectedBy
    enum priority
    int priorityScore
    enum confidence
    string dedupeKey
    datetime relevantUntil
    json details
  }
  OpportunitySignal {
    string id PK
    string opportunityId FK
    string signalId FK
    enum kind
    string refId
    string fingerprint
  }
  OpportunityEvent {
    string id PK
    string opportunityId FK
    enum fromStatus
    enum toStatus
    string actorId
    datetime createdAt
  }
  AdvisorReport {
    string id PK
    string companyId FK
    datetime date
    json payload
    string model
  }
  Recommendation {
    string id PK
    string opportunityId FK
  }
```

`Signal` and `Opportunity` are each unique per `(companyId, dedupeKey)`, which is what makes collection and re-detection idempotent. `OpportunitySignal` is the evidence: it always carries `kind` + `refId` back to the original record and, when it came through the signal store, `signalId` (set to null if the signal is ever deleted, so evidence survives). `OpportunityEvent` holds every status change, and `AdvisorReport` is one JSON payload per company per UTC day. `Recommendation` is owned by feature 09 and shown here only for the link.

## Design decisions

- **One normalised signal store.** Every source is converted to the same shape with a source, record id, observation date, expiry, reliability and reason, so detection rules do not need to know each module's storage format. Normalisers are pure and defensive: malformed rows produce fewer signals, never exceptions.
- **Deterministic first, AI only where interpretation is needed.** Five plain-logic rules cover what can be checked mechanically. AI detection is limited to `CONTENT_GAP`, `COMPETITIVE_GAP` and `AUDIENCE_SEGMENT`, and rule categories proposed by the model are rejected.
- **The model interprets, never asserts.** AI output must cite signals by reference, name the business facts it relies on, declare no assumptions, and contain no number absent from its sources; every check is deterministic and failures are audited rather than silently dropped.
- **Confidence comes from evidence, not claims.** Stored confidence is the lowest of the detector's claim, what the evidence count and kinds allow, and a MEDIUM cap when the opportunity relies on unconfirmed or stale business facts. A LOW-confidence opportunity can never be HIGH or URGENT priority.
- **One write path, idempotent by key.** `recordOpportunity` is the only way detectors save results; same key means more evidence on one row, not a duplicate. Cross-detector duplicates are caught by matching open opportunities of the same type that cite the same records.
- **Human decisions are sticky.** Re-detection never overrides `ACCEPTED` or `REJECTED`; evidence from rejected opportunities is not reused; a rule that keeps being rejected is muted for 30 days.
- **Compare-and-swap transitions.** Status changes update only if the status is still what was read, so concurrent decisions produce a 409 instead of a lost update.
- **Lazy expiry.** Opportunities are expired before every list and each advisor run instead of by a dedicated job, so a view never shows an open opportunity whose window has passed.
- **Best-effort orchestration.** In an advisor run, signal collection, both detectors and opportunity storage are each wrapped so a failure is logged and never stops the advisor report from being returned.
