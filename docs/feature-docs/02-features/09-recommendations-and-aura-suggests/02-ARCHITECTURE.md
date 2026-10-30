# Recommendations & Aura Suggests — Architecture

Recommendations follow the pattern used across Aura: pure, client-safe rules in `lib/` (lifecycle, engine, guardrails, ranking, quality, presentation) and thin database services in `server/recommendations/` that apply them. API routes only authenticate, check the role, validate with Zod and delegate. The model is optional and only allowed to reword an action the deterministic engine already chose.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Dashboard UI"]
    PageSug["/dashboard/suggestions<br/>aura-suggests.tsx"]
    PageHist["/dashboard/suggestions/history"]
    Bar["recommendation-context-bar.tsx"]
  end
  subgraph API["API routes /api/recommendations"]
    RGen["POST generate"]
    RDec["POST :id/decision, :id/status,<br/>PATCH :id, POST :id/snooze"]
    RPres["POST presented"]
    RCre["GET/POST :id/creation<br/>GET :id/handoff, :id/context"]
  end
  subgraph SVC["server/recommendations"]
    Auto["autosuggest.service.ts"]
    Eng["engine.service.ts"]
    Rec["recommendation.service.ts"]
    Sugg["suggestions.service.ts"]
    Rank["ranking.service.ts"]
    Qual["quality.service.ts"]
    Crea["creation.service.ts"]
  end
  subgraph LIB["lib pure rules"]
    LEng["recommendation-engine.ts<br/>recommendation-rules.ts"]
    LRank["recommendation-ranking.ts<br/>recommendation-quality.ts"]
    LView["aura-suggests.ts<br/>aura-modules.ts"]
  end
  DB[("PostgreSQL<br/>Recommendation, Event, Evidence")]
  AI{{"server/ai/claude.ts<br/>Anthropic or Gemini"}}

  PageSug --> Sugg
  PageSug --> RDec
  PageSug --> RPres
  PageSug --> RGen
  Bar --> RCre
  RGen --> Auto
  Auto --> Eng
  Eng --> LEng
  Eng -->|"optional rewrite"| AI
  Eng --> Rec
  RDec --> Rec
  RDec --> Rank
  RPres --> Rec
  RCre --> Crea
  Crea --> Rec
  Sugg --> Rank
  Sugg --> Qual
  Rank --> LRank
  Qual --> LRank
  Sugg --> LView
  Rec --> DB
  PageHist --> DB
```

Read top to bottom: pages and the context bar call API routes (or, for server-rendered pages, the services directly), routes call services, services apply the pure rules in `lib/` and read or write the three recommendation tables. The only external dependency is the AI layer, used by the engine for an optional, validated rewrite. `suggestions.service.ts` is the single read path that combines ranking, quality gating and the plain-language view used by both Aura Suggests and Aura Home.

## Main flow

```mermaid
sequenceDiagram
  participant UI as Aura Suggests page
  participant API as POST /api/recommendations/generate
  participant Auto as autosuggest.service
  participant Eng as engine.service
  participant AI as AI layer
  participant DB as PostgreSQL
  participant Q as quality.service

  UI->>API: Get Aura's suggestions
  API->>API: requireActiveCompany and company:update
  API->>Auto: suggestFromOpportunities companyId
  Auto->>Auto: mayWriteRecommendations
  Auto->>DB: open opportunities without a live suggestion
  Auto->>Auto: drop those under a repeat hold
  loop up to 5 opportunities within 40 s
    Auto->>Eng: generateRecommendation opportunityId
    Eng->>DB: hand-off, snapshot, recent recommendations, signals
    Eng->>Eng: frequency limits, selectActions, applyGuardrails
    opt model configured
      Eng->>AI: completeStructured tier standard
      AI-->>Eng: words only
      Eng->>Eng: validateAiRecommendation or fall back to template
    end
    Eng->>Eng: checkSupport, findDuplicate, assess, findConflicts, executability
    Eng->>DB: create Recommendation, Evidence, Event generate
    Eng->>DB: audit RECOMMENDATION_GENERATED
    Eng-->>Auto: created, flagged or rejected with reasons
    Auto->>Q: getRecommendationQuality
    alt verdict blocked
      Auto->>DB: transition to WITHDRAWN by system
    end
  end
  Auto-->>API: created, skipped with reasons, remaining
  API-->>UI: report
  UI->>UI: router refresh then getSuggestions ranks and gates
  UI->>DB: POST presented marks shown cards PRESENTED
```

The primary flow is a person (or a detection run) asking Aura for suggestions. Each opportunity goes through the engine's deterministic steps; the model is consulted only to improve wording and is discarded if it cites anything unsupported. Right after writing, the quality gate can withdraw a suggestion before anyone sees it. When the page re-renders, ranking and quality are computed again on read, and the cards actually displayed are reported back as presented.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> GENERATED: engine or person creates
  GENERATED --> PRESENTED: shown to a person
  GENERATED --> ACCEPTED: accept
  GENERATED --> EDITED: edit
  GENERATED --> SKIPPED: skip
  GENERATED --> REJECTED: reject
  GENERATED --> WITHDRAWN: withdraw or quality block
  GENERATED --> EXPIRED: relevance passed
  PRESENTED --> ACCEPTED: accept
  PRESENTED --> EDITED: edit
  PRESENTED --> SKIPPED: skip
  PRESENTED --> REJECTED: reject
  PRESENTED --> WITHDRAWN: withdraw
  PRESENTED --> EXPIRED: relevance passed
  ACCEPTED --> EDITED: edit
  ACCEPTED --> IN_PROGRESS: something created
  ACCEPTED --> COMPLETED: complete
  ACCEPTED --> WITHDRAWN: withdraw
  EDITED --> EDITED: edit again
  EDITED --> IN_PROGRESS: something created
  EDITED --> COMPLETED: complete
  EDITED --> WITHDRAWN: withdraw
  IN_PROGRESS --> COMPLETED: complete
  IN_PROGRESS --> WITHDRAWN: withdraw
  SKIPPED --> [*]
  REJECTED --> [*]
  COMPLETED --> [*]
  WITHDRAWN --> [*]
  EXPIRED --> [*]
```

This is `RECOMMENDATION_TRANSITIONS` from `lib/recommendations.ts`. Only `GENERATED` and `PRESENTED` can expire; the five terminal states are final, so a new recommendation is made instead. Accepting or editing also moves the opportunity to `ACCEPTED`, rejecting moves it to `REJECTED`; "Not now" (snooze) does not change the status, it only hides the recommendation from the ranked list and writes a `defer` event.

## Data model

```mermaid
erDiagram
  Company ||--o{ Recommendation : "owns"
  Opportunity ||--o{ Recommendation : "answered by"
  Recommendation ||--o{ RecommendationEvent : "history"
  Recommendation ||--o{ RecommendationEvidence : "based on"
  Signal |o--o{ RecommendationEvidence : "source signal"
  OpportunitySignal |o--o{ RecommendationEvidence : "copied from"

  Recommendation {
    string id PK
    string companyId FK
    string opportunityId FK
    enum type
    enum status
    string title
    string action
    string channel
    json details
    boolean executable
    enum confidence
    int priorityScore
    datetime relevantUntil
    datetime snoozedUntil
    int snoozeCount
    json handoff
    string createdBy
    datetime decidedAt
  }
  RecommendationEvent {
    string id PK
    string recommendationId FK
    enum fromStatus
    enum toStatus
    string action
    string source
    string actorId
    json metadata
    datetime createdAt
  }
  RecommendationEvidence {
    string id PK
    string recommendationId FK
    string signalId FK
    string opportunitySignalId FK
    enum kind
    string label
    string detail
    enum reliability
  }
  Opportunity {
    string id PK
    string companyId FK
    enum status
  }
  Signal {
    string id PK
    string companyId FK
    string source
  }
  OpportunitySignal {
    string id PK
    string opportunityId FK
  }
```

A recommendation always belongs to one workspace and one opportunity. Its history (`RecommendationEvent`) is append-only and cascades with it. Evidence is copied from the opportunity rather than shared, keeping soft links (`SetNull`) back to the opportunity's evidence row and the normalised `Signal`, so a recommendation keeps what it was based on even after signals are pruned.

## Design decisions

- **Rules first, model second.** The engine picks the action deterministically from a catalogue per opportunity type; a model may only reword it, and `validateAiRecommendation` throws its output away if it cites unknown evidence or facts, declares assumptions, or invents figures. Without any model configured, the feature still works from templates.
- **Guardrails as data.** Limits, duplicate windows, minimum evidence, confidence rules and channel integrations are constants in `lib/recommendation-rules.ts`, unit-tested on their own and documented with the same numbers.
- **Never surer than the evidence.** Confidence and relevance are bounded by the opportunity's (`boundByOpportunity`, `assess`); low confidence is advisory and not executable until a person accepts it.
- **Ranking computed on read.** The surfaced order depends on today's goals, deadlines and past decisions, so it is never stored; every point comes with its reason so the order can be explained.
- **Quality gate right before presentation.** Things change after creation (evidence expires, an opportunity is rejected, the profile is edited), so the eight checks run in `getSuggestions` and again just after auto-suggest writes, and blocked suggestions are held back with a reason rather than shown.
- **One decision, both sides.** Recommendation and opportunity statuses are kept in step in the same transaction (`transitionRecommendation` -> `transitionOpportunity`).
- **Optimistic concurrency and idempotency.** Compare-and-swap updates and `expectedStatus` stop double clicks and stale screens from creating conflicting history; repeats return `changed: false`.
- **Honest emptiness.** When Aura lacks the basics (what the business does, where it publishes), it writes nothing and the page shows the readiness checklist instead of generic advice.
- **One answer to "Create".** `creationPlan` and the versioned Context Handoff are shared by Aura Suggests, Content Studio, Campaigns, Outreach and the API, so modules never disagree about what can be created or what context it carries; every destination carries `?rec=<id>`.
- **Workspace scoping enforced by a test.** A static test scans every database call on the recommendation tables to make sure it is scoped to one workspace.
