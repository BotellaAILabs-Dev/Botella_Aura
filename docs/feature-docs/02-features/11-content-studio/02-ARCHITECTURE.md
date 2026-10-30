# Content Studio (Generation, Brief, Formats, Quality) — Architecture

Content Studio turns a request into a checked draft: a brief, trend, campaign or accepted recommendation. The work is split between pure, client-safe rule modules in `lib/` (brief, context, formats, quality, fact check, compliance, brand safety, review) and server services in `server/content/` that load data, call the model and persist `ContentDraft`. Every decision the model cannot be trusted with is made deterministically: whether a source can be marketed, whether a fact changed, whether a rule failed. The model writes, and the code decides what can reach approval.

## Component architecture

```mermaid
flowchart TD
  UI1["/dashboard/content/new<br/>NewContentForm + ContentBriefPanel"]
  UI2["/dashboard/content/[id]<br/>VersionWorkspace, ReviewPanel, FactCheckPanel"]
  UI3["Settings - Compliance<br/>compliance-form.tsx"]
  RGen["POST /api/content/generate"]
  RDraft["/api/content/drafts/:id<br/>refine, variations, review, status"]
  RComp["/api/company/compliance"]
  subgraph S1["Server services - server/content"]
    SvcBrief["content-brief.service.ts"]
    SvcGen["generator.ts"]
    SvcCtx["generation-context.service.ts"]
    SvcQual["quality.service.ts"]
    SvcRev["review.service.ts"]
    SvcVar["variations + version-workspace"]
    SvcFlow["content.service.ts<br/>state machine"]
    SvcPol["compliance.service.ts"]
  end
  subgraph S2["Pure rules - lib"]
    LibRules["content-brief, generation-context,<br/>content-formats, content-playbook"]
    LibChecks["content-quality, fact-check,<br/>compliance-policy, brand-safety, content-review"]
  end
  AI{{"Anthropic or Gemini<br/>server/ai/claude.ts"}}
  DB[("PostgreSQL<br/>ContentDraft, Company.preferences")]
  UI1 --> RGen
  UI2 --> RDraft
  UI3 --> RComp
  RGen --> SvcBrief
  RGen --> SvcGen
  RDraft --> SvcGen
  RDraft --> SvcVar
  RDraft --> SvcRev
  RDraft --> SvcFlow
  RComp --> SvcPol
  SvcGen --> SvcCtx
  SvcGen --> SvcQual
  SvcGen --> SvcRev
  SvcFlow --> SvcRev
  SvcBrief --> LibRules
  SvcCtx --> LibRules
  SvcQual --> LibChecks
  SvcRev --> LibChecks
  SvcGen -->|"write, repair"| AI
  SvcRev -->|"independent review"| AI
  SvcGen --> DB
  SvcFlow --> DB
  SvcPol --> DB
```

Read the diagram top to bottom: pages call API routes, routes call services in `server/content/`, and services apply the pure rules in `lib/` before touching the model or the database. Two separate model calls exist: the writer (and its repair pass) in `generator.ts`, and the reviewer in `review.service.ts`, which never sees the writer's prompt. `content.service.ts` is the only place that changes `status`. It calls the reviewer again whenever the stored review is out of date.

## Main flow

```mermaid
sequenceDiagram
  participant UI as NewContentForm
  participant API as /api/content/generate
  participant BR as content-brief.service
  participant GEN as generator.ts
  participant CTX as generation-context.service
  participant AI as AI provider
  participant QC as content-quality + brand-safety
  participant REV as review.service
  participant DB as PostgreSQL
  UI->>API: POST type, platform, source, recommendationId, idempotencyKey
  API->>DB: find draft with same idempotencyKey
  alt already written
    API-->>UI: 200 existing draft, reused true
  end
  API->>API: content:create, enabled format, creation plan
  API->>BR: getContentBrief for this type and platform
  BR-->>API: brief
  API->>API: validateContentBrief
  alt brief invalid or plan blocked
    API-->>UI: 409 with errors and fix link
  end
  API->>GEN: generateDraft
  GEN->>GEN: resolveBrief, fetch up to 2 reference pages
  GEN->>QC: classifySource on source material
  alt unsuitable source and promotional format
    GEN-->>UI: 422 source_not_marketable
  end
  GEN->>CTX: assembleDraftContext within 3200 tokens
  CTX-->>GEN: sections, dropped, redactions, trace
  GEN->>AI: completeStructured with format schema
  AI-->>GEN: 1 to 3 bodies
  GEN->>QC: checkQuality per version
  opt blocking issues
    GEN->>AI: one repair pass with issues and safety rules
  end
  GEN->>DB: create ContentDraft status DRAFT with aiMetadata
  GEN->>REV: reviewAfterWrite trigger generated
  REV->>AI: reviewer, standard tier, 25s timeout
  REV->>DB: store aiMetadata.review
  API-->>UI: 201 id, type, status
```

The sequence covers the primary path, writing a draft from an accepted recommendation. The `alt` blocks are the early exits, each with its HTTP status: an idempotent replay returns the existing draft, an invalid brief or blocked plan returns 409, and a grave source with a promotional format returns 422. The repair pass is optional and runs at most once. The review runs after the draft is saved, so a reviewer failure never loses the draft.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> DRAFT: generateDraft
  DRAFT --> PENDING_APPROVAL: submit, review not fail
  DRAFT --> REJECTED: reject
  PENDING_APPROVAL --> APPROVED: approve, all gates pass
  PENDING_APPROVAL --> REJECTED: reject
  PENDING_APPROVAL --> DRAFT: request changes
  APPROVED --> PUBLISHED: publish
  APPROVED --> DRAFT: edit, refine or version change
  APPROVED --> REJECTED: reject
  REJECTED --> DRAFT: rework
  PUBLISHED --> [*]
```

These are the `TRANSITIONS` in `server/content/content.service.ts`. `PUBLISHED` is reachable only from `APPROVED` and is terminal. Before `PENDING_APPROVAL` and `APPROVED`, `ensureReview()` re-reviews a stale review. On approval, the gates are checked in this order: blocking quality issues, then fact-check contradictions and must-fix claims, then unconfirmed claims (`factsReviewed`), then a failed review, then `review_required` (`reviewAcknowledged`). Any content change on an approved draft sends it back to `DRAFT`. The approval layer that wraps this machine is described in [13](../13-review-approval-versions-and-trace/02-ARCHITECTURE.md).

A second, smaller state machine governs the AI Reviewer's verdict on the current body.

```mermaid
stateDiagram-v2
  [*] --> UNREVIEWED
  UNREVIEWED --> PASS: reviewDraft
  UNREVIEWED --> REVIEW_REQUIRED: reviewDraft
  UNREVIEWED --> FAIL: reviewDraft
  PASS --> STALE: body or policy changed
  REVIEW_REQUIRED --> STALE: body or policy changed
  FAIL --> STALE: body or policy changed
  STALE --> PASS: ensureReview on submit or approve
  STALE --> REVIEW_REQUIRED: ensureReview on submit or approve
  STALE --> FAIL: ensureReview on submit or approve
  REVIEW_REQUIRED --> ACKNOWLEDGED: approver confirms
```

A review is current only while its `bodyHash` matches the body and its `policyHash` matches the rules in force (`isReviewCurrent`). Manual edits, version switches, undo and compliance-policy changes all make it stale. `FAIL` blocks both submit and approve. `REVIEW_REQUIRED` blocks only approval, until the approver acknowledges it; that is recorded as `acknowledgedBy`.

## Data model

```mermaid
erDiagram
  Company ||--o{ ContentDraft : "owns"
  User ||--o{ ContentDraft : "created"
  Campaign ||--o{ ContentDraft : "groups"
  ContentDraft ||--o{ ContentMedia : "attached media"
  ContentDraft ||--o{ GeneratedAsset : "graphic history"
  ContentDraft ||--o{ ContentPublication : "one per network"
  ContentDraft ||--o{ ExecutionHandoff : "handed to execution"
  Company {
    string id PK
    string website
    json preferences
  }
  ContentDraft {
    string id PK
    string companyId FK
    string createdById FK
    string campaignId FK
    enum type
    enum status
    string title
    json body
    json aiMetadata
    enum platform
    datetime scheduledFor
    datetime publishedAt
    datetime updatedAt
  }
  Campaign {
    string id PK
    string companyId FK
  }
  User {
    string id PK
  }
  ContentMedia {
    string id PK
    string draftId FK
  }
  GeneratedAsset {
    string id PK
  }
  ContentPublication {
    string id PK
  }
  ExecutionHandoff {
    string id PK
  }
```

Content Studio owns one table, `ContentDraft`; the rest of the feature's state lives in JSON. `body` holds the per-format structure and its post `details`. `aiMetadata` holds the brief, context trace, source safety verdict and source material, quality report, versions, undo history and review. `Company.preferences.compliancePolicy` holds the workspace's rules. Media, generated assets, publications and execution hand-offs hang off the draft; they are owned by features 12 and 20 and shown here only for orientation.

## Design decisions

- **Each format is defined once.** `FORMAT_SPECS` drives the writer's instructions, the brief's required fields, the quality limits and the zod output schema. Adding Campaign copy and Promo meant adding one spec, not editing four places.
- **The brief is validated server-side, for exactly what is being made.** The brief is rebuilt for the chosen format and network in the generate route, so a client cannot submit a brief whose requirements do not match the output.
- **Context is budgeted and recorded as a trace, not as text.** A fixed 3,200-token budget with per-section caps keeps prompts bounded. Storing only the trace (ids, revision, sections, drops, redactions) in `aiMetadata.context` avoids copying sensitive material into the draft while still answering "why did it say that".
- **Brand safety is deterministic and runs before the writer.** Its notes explain why: a model asked whether something is sensitive agrees with its framing. The same verdict is stored on the draft, so rewrites, variations and the reviewer all read the source the same way. Promotional formats are refused outright on grave sources.
- **The reviewer is independent and cannot write copy.** It has a separate system prompt, a schema with no copy field, a cheaper standard tier and a 25-second timeout. When it fails, the piece goes to a person instead of passing.
- **The model never fails a piece on legal or factual grounds alone.** For the critical dimensions (accuracy, compliance, brand safety), a low model score only sends the piece to review; only rules, the fact check and the policy can fail it. A rule breach always fails, whatever the model scored.
- **Variations are added, never replacing.** The facts guardrail and the topic-drift guard check the result in code. CTA and headline variations change a single field in code, so nothing else can move. Up to 8 versions are kept, and the active one is never dropped.
- **Post details are never AI-written.** The writer's schema excludes `details`, so contact information comes only from the business profile or a person. Typed values block approval until a person confirms them.
- **Writes are idempotent and use optimistic concurrency.** An idempotency key per open form avoids paying for duplicate drafts after a retry. The `updatedAt` / `baseUpdatedAt` guards turn concurrent edits into 409s instead of silent overwrites.
- **The publish guarantee lives in the service.** `PUBLISHED` is reachable only from `APPROVED`, enforced in `TRANSITIONS`, so no UI or caller can publish an unapproved draft.
