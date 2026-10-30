# Review, Approval, Versions & Traceability — Architecture

Pure models in `lib/` define how review items look, the approval states and fingerprints, the version log and the trace ids. Server services in `server/` apply those models to `ContentDraft` and `OutreachMessage` rows, storing everything inside each row's `aiMetadata` JSON. One review screen and one review API sit on top. Every review action delegates to the owning module's service, so Content Studio's and Outreach's gates apply whichever screen a person uses.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Browser"]
    Queue["/dashboard/review<br/>page.tsx"]
    Screen["review-screen.tsx"]
    VPanel["versions-panel.tsx"]
    TPanel["trace-panel.tsx"]
  end
  subgraph API["API routes"]
    RouteItem["/api/review/:kind/:id"]
    RouteVer["/api/review/:kind/:id/versions"]
    RouteTrace["/api/content/drafts/:id/trace<br/>/api/analytics/traces"]
  end
  subgraph SVC["Server services"]
    SvcItem["review-item.service.ts"]
    SvcAct["review-actions.service.ts"]
    SvcAppr["approval.service.ts"]
    SvcVer["version.service.ts<br/>version-api.service.ts"]
    SvcTrace["trace.service.ts"]
    SvcMod["content.service.ts / generator.ts<br/>outreach.service.ts"]
  end
  subgraph LIB["Pure lib"]
    LibRI["lib/review-item.ts"]
    LibAp["lib/approval.ts"]
    LibVer["lib/versions.ts"]
    LibTr["lib/trace.ts"]
  end
  DB[("PostgreSQL<br/>ContentDraft / OutreachMessage aiMetadata")]
  Queue --> SvcItem
  Screen --> RouteItem
  VPanel --> RouteVer
  TPanel -.->|"server-rendered"| SvcTrace
  RouteItem --> SvcItem
  RouteItem --> SvcAct
  RouteVer --> SvcVer
  RouteTrace --> SvcTrace
  SvcAct --> SvcMod
  SvcMod --> SvcAppr
  SvcMod --> SvcVer
  SvcMod --> SvcTrace
  SvcItem --> SvcAppr
  SvcItem --> LibRI
  SvcAppr --> LibAp
  SvcVer --> LibVer
  SvcTrace --> LibTr
  SvcAppr --> DB
  SvcMod --> DB
  SvcItem --> DB
```

Read the diagram from top to bottom. The queue and item pages are server components, so they call the services directly. The client screen and versions panel use the API routes. The action service never writes rows itself. It calls the module services (`transition`, `updateDraftBody`, `refineDraft`, `scheduleDraft`, `transitionMessage`, `updateMessageText`, `regenerateMessage`), which in turn use the approval, version and trace services to compute the next `aiMetadata`. The four `lib/` files have no database dependency and are shared with the client.

## Main flow

Approving a Content Studio draft from the review screen:

```mermaid
sequenceDiagram
  participant UI as review-screen.tsx
  participant API as /api/review/content/:id
  participant ACT as review-actions.service
  participant CS as content.service transition
  participant AP as approval / versions / trace services
  participant DB as PostgreSQL
  UI->>API: POST action approve, confirmed
  API->>API: requireActiveCompany, zod parse
  API->>ACT: runReviewAction
  ACT->>ACT: can role content approve
  opt draft is DRAFT
    ACT->>CS: transition to PENDING_APPROVAL
  end
  ACT->>CS: transition to APPROVED, factsReviewed, reviewAcknowledged
  CS->>CS: isValidTransition, ensureReview, compliance block check, factCheckDraft
  alt a gate refuses
    CS-->>UI: 409 with code, screen refreshes
  else all gates pass
    CS->>AP: contentMetaAfter with approve snapshot and fingerprint
    CS->>AP: withApprovedContentVersion then withApprovalTrace
    CS->>DB: updateMany where id, status, updatedAt as read
    alt no row matched
      CS-->>UI: 409 concurrent_change
    else updated
      CS->>DB: syncCampaignTask, recordAudit with trace ids
      CS-->>API: status APPROVED
      API-->>UI: 200 Approved
    end
  end
```

The approver's single click may run two transitions: submit, then approve. Each transition re-runs the AI review, the compliance check and the fact check, so the screen cannot skip them. The approval record, the approved version marker and the approval trace are all computed into one `aiMetadata` value and written in a single conditional update, which is why a concurrent edit or a second approver gets a 409 instead of a half-applied approval.

## Lifecycle / state machine

The unified approval state (`lib/approval.ts`). It is derived from `ContentDraft.status` and `scheduledFor`, or from `OutreachMessage.status`.

```mermaid
stateDiagram-v2
  [*] --> GENERATED: Aura generates
  GENERATED --> DRAFT: person edits
  DRAFT --> GENERATED: regenerated
  GENERATED --> REVIEW_REQUIRED: submit
  DRAFT --> REVIEW_REQUIRED: submit
  GENERATED --> APPROVED: approver approves
  DRAFT --> APPROVED: approver approves
  REVIEW_REQUIRED --> APPROVED: approve
  REVIEW_REQUIRED --> DRAFT: changes requested
  REVIEW_REQUIRED --> REJECTED: reject
  GENERATED --> REJECTED: reject
  DRAFT --> REJECTED: reject
  REJECTED --> DRAFT: edit
  REJECTED --> GENERATED: regenerate
  APPROVED --> SCHEDULED: schedule in future
  APPROVED --> READY_FOR_EXECUTION: due or outreach queued
  SCHEDULED --> READY_FOR_EXECUTION: time reached
  SCHEDULED --> APPROVED: unscheduled
  APPROVED --> DRAFT: reopen on any change
  SCHEDULED --> DRAFT: reopen on any change
  READY_FOR_EXECUTION --> DRAFT: reopen on any change
  APPROVED --> EXECUTED: published
  SCHEDULED --> EXECUTED: published
  READY_FOR_EXECUTION --> EXECUTED: published or sent
  EXECUTED --> [*]
```

`GENERATED` and `DRAFT` are both stored as `DRAFT`. They differ only by whether the last non-submit event was a person's change. Every exit from the approved family (`APPROVED`, `SCHEDULED`, `READY_FOR_EXECUTION`) back to `DRAFT` is a recorded reopen, caused by an edit, regeneration, variation, undo, restore, image swap or network change. No path changes approved content while it stays approved. `EXECUTED` (`PUBLISHED` or `SENT`) is terminal. Rejection is also allowed from the approved family; it is omitted here to keep the diagram readable.

## Data model

The feature owns no tables. These are the rows it reads and writes, with its JSON sub-documents shown as attributes.

```mermaid
erDiagram
  Company ||--o{ ContentDraft : "owns"
  Company ||--o{ OutreachMessage : "owns"
  ContentDraft ||--o{ ContentMedia : "attached images, in fingerprint"
  ContentDraft ||--o{ CampaignTask : "task follows approval"
  ContentDraft ||--o{ PerformanceSnapshot : "joined in trace rows"
  Lead ||--o{ OutreachMessage : "addressed to"
  Recommendation ||--o{ ContentDraft : "traced via aiMetadata trace"
  ContentDraft {
    string id PK
    string companyId FK
    enum status
    json body
    json aiMetadata
    string platform
    datetime scheduledFor
    datetime publishedAt
    string rejectionReason
    datetime updatedAt
  }
  OutreachMessage {
    string id PK
    string companyId FK
    string leadId FK
    enum status
    string draftText
    json aiMetadata
    string rejectionReason
    datetime updatedAt
  }
  ContentMedia {
    string id PK
    string contentDraftId FK
    string assetId FK
    int position
    string altText
  }
  CampaignTask {
    string id PK
    string relatedContentDraftId FK
    enum status
  }
  Recommendation {
    string id PK
    string companyId FK
    string opportunityId FK
  }
```

`aiMetadata` carries three sub-documents. `approval` holds the version, fingerprint, the approved and rejected records, and up to 60 events. `versions` holds the current version, the approved version and up to 50 versions. `trace` (content only) holds the traceId and the business-context revision, signal, opportunity, recommendation, brief, reviewed, approved and media ids. The link from `Recommendation` to `ContentDraft` is not a foreign key. It is a snapshot id kept in `aiMetadata.trace`, so the chain survives a deleted recommendation, and `resolveTrace` reports the gap.

## Design decisions

- **Derive the unified state; don't store it.** Each module keeps its own status column and meaning. The unified state is computed from status plus schedule, so no migration was needed, and the execution engine can take over from `ready_for_execution` without renames.
- **Everything in `aiMetadata` JSON.** The approval record, the version log and the trace sit next to the content they describe, need no schema change, and outlive the upstream records they point at. Caps (60 events, 50 versions, snapshots on the newest 15 events) keep the rows bounded.
- **An approval covers a fingerprint, not a status.** Content is fingerprinted over text, network and ordered images (with alt text). Every execution path calls `assertContentIntact`, or `outreachIntact` for outreach, so even a change that bypassed the services (such as a direct DB write) is refused with `changed_after_approval`.
- **Change reopens; it never edits in place.** Edits, regenerations, variations, undos, restores, image swaps and network changes all move the version on, keep the previous content and send approved work back to draft. The audit shows the reopen.
- **Restore appends.** Making an old version current creates a new `restored` version with `basedOn`, so history is never rewritten. The original, current and approved versions are never trimmed.
- **One screen, module rules.** `runReviewAction` only checks roles and delegates. The AI review, compliance, fact check and state machine live in the module services, so the gates are identical in Content Studio, on the Outreach board, in the unified review and on WhatsApp.
- **Optimistic concurrency everywhere.** Saves carry `baseUpdatedAt` (409 `stale`). Transitions write with `where { status, updatedAt }` (409 `concurrent_change`). Unsaved edits live in `localStorage` per item, with the version they were made on, so a conflict never loses work.
- **Lazy records for legacy items.** Items made before each model get a record, log or trace the first time they are read. Items that were already approved are recorded as approved as they stand, by an unknown approver, rather than being silently unapproved.
- **Autopilot is never a person.** Machine approvals are stored with `via: 'autopilot'` and `by: null`, and shown as "Autopilot".
