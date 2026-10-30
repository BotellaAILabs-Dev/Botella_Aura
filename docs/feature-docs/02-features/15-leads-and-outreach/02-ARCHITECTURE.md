# Lead Discovery & Outreach Intelligence — Architecture

Leads enter through signal detection, discovery profiles or manual entry, and all land in one `Lead` table read by both the Leads page and the Outreach board. Drafting turns a lead into two `OutreachMessage` rows. Those move through a content-style approval state machine and leave Aura only through a human click in the Chrome extension. Every external call is to a public source or the AI layer; LinkedIn is never read or written by the server.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Dashboard"]
    UILeads["/dashboard/leads<br/>leads-table.tsx"]
    UIDisc["/dashboard/leads/discover<br/>discovery-manager.tsx"]
    UIBoard["/dashboard/outreach<br/>outreach-board.tsx + queue bar"]
  end
  subgraph API["API routes"]
    RDisc["/api/leads/discovery/profiles/*"]
    RLeads["/api/outreach/leads/*"]
    RMsg["/api/outreach/messages/*"]
    RDetect["/api/outreach/detect"]
    RCron["/api/cron/discovery<br/>/api/cron/outreach"]
  end
  subgraph SVC["Server services"]
    SDisc["discovery.service.ts<br/>runDiscovery"]
    SScore["scoring.ts + dedup.ts"]
    SDetect["detect.service.ts<br/>matching.ts"]
    SDraft["drafting.service.ts"]
    SFlow["outreach.service.ts<br/>checks + confidence"]
  end
  DB[("PostgreSQL<br/>Lead, LeadSignal, OutreachMessage,<br/>DiscoveryProfile, DiscoveryRun")]
  Ext{{"GitHub, Crunchbase,<br/>Google CSE, Google News,<br/>company sites"}}
  AI{{"AI layer<br/>server/ai/claude.ts"}}
  ExtQ["Chrome extension queue<br/>server/extension/*"]

  UIDisc --> RDisc
  UILeads --> RLeads
  UIBoard --> RLeads
  UIBoard --> RMsg
  UIBoard --> RDetect
  RDisc --> SDisc
  RCron --> SDisc
  RCron --> SDetect
  RDetect --> SDetect
  RLeads --> SDraft
  RMsg --> SFlow
  SDisc --> SScore
  SDisc --> Ext
  SDetect --> Ext
  SScore --> AI
  SDraft --> AI
  SDisc --> DB
  SDetect --> DB
  SDraft --> DB
  SFlow --> DB
  DB -->|"APPROVED messages"| ExtQ
```

Read top to bottom: the three dashboard screens call workspace-scoped API routes, and those routes delegate to services. Discovery and detection are the only parts that reach out to public sources. Scoring and drafting are the only parts that call the AI layer, and both have deterministic fallbacks. Approved messages leave the feature by being read from the database by the extension queue, never by a push from these services.

## Main flow

```mermaid
sequenceDiagram
  participant U as Owner or admin
  participant UI as Dashboard
  participant D as POST profiles/id/run
  participant S as runDiscovery
  participant Src as Public sources
  participant AI as AI layer
  participant DR as POST leads/id/draft
  participant ST as POST messages/id/status
  participant X as Chrome extension

  U->>UI: Run now on a profile
  UI->>D: POST
  D->>D: content:approve + discovery entitlement
  D->>S: runDiscovery
  S->>Src: GitHub, Crunchbase, CSE in parallel
  S->>Src: team pages for up to 8 companies
  S->>S: dedupe within batch and against existing leads
  S->>AI: fit score per new lead, up to 25
  S-->>UI: leadsFound, leadsCreated, skipped
  U->>UI: Draft outreach on a lead
  UI->>DR: POST
  DR->>AI: connection note + follow-up
  DR-->>UI: two DRAFT messages, lead DRAFTED
  U->>UI: Approve
  UI->>ST: POST action approve
  ST->>ST: blocking checks, compare-and-set
  ST-->>UI: APPROVED
  X->>X: human inserts text and clicks LinkedIn Send
  X->>X: Mark as sent - message SENT, lead CONTACTED
```

The diagram follows one lead from discovery to send. The route checks permission and the plan's monthly run limit before any network call. Approval is refused if a blocking check fails or someone else changed the message first. The final step happens in the extension ([17](../17-chrome-extension/)), which records `SENT` only after the human acts on LinkedIn.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> DRAFT: draftForLead
  DRAFT --> PENDING_APPROVAL: submit
  DRAFT --> APPROVED: approve
  DRAFT --> REJECTED: reject
  PENDING_APPROVAL --> APPROVED: approve
  PENDING_APPROVAL --> REJECTED: reject
  PENDING_APPROVAL --> DRAFT: request changes or edit
  APPROVED --> DRAFT: edit or request changes
  APPROVED --> REJECTED: reject
  REJECTED --> DRAFT: edit or regenerate
  APPROVED --> SENT: human send in extension
  SENT --> [*]
```

These are the `OutreachMessage.status` transitions from `OUTREACH_TRANSITIONS` plus the extension's sync-back. Editing or regenerating always returns a message to `DRAFT`, so changed text must be approved again. `SENT` is final and cannot be edited or regenerated.

```mermaid
stateDiagram-v2
  [*] --> NEW: detected or discovered
  [*] --> QUALIFIED: added manually
  NEW --> QUALIFIED: send to outreach
  NEW --> DRAFTED: draft
  QUALIFIED --> DRAFTED: draft
  DRAFTED --> CONTACTED: message sent
  NEW --> ARCHIVED: not relevant
  ARCHIVED --> QUALIFIED: send to outreach
  CONTACTED --> [*]
```

`Lead.status` is a coarse pipeline view. Status can also be set directly through `PATCH /api/outreach/leads/:id`, so this diagram shows the automatic moves, not every possible edit.

## Data model

```mermaid
erDiagram
  Company ||--o| OutreachConfig : "targets with"
  Company ||--o{ DiscoveryProfile : "owns"
  Company ||--o{ Lead : "owns"
  DiscoveryProfile ||--o{ DiscoveryRun : "runs"
  DiscoveryProfile |o--o{ Lead : "discovered"
  Lead ||--o{ LeadSignal : "evidenced by"
  Lead ||--o{ OutreachMessage : "addressed by"
  Lead {
    string id PK
    string companyId FK
    string companyName
    string name
    string linkedInProfileUrl
    enum status
    enum source
    string discoveryProfileId FK
    int fitScore
    string category
  }
  LeadSignal {
    string id PK
    string leadId FK
    enum signalType
    string description
    datetime detectedAt
  }
  OutreachMessage {
    string id PK
    string leadId FK
    string companyId FK
    enum type
    enum status
    string draftText
    json aiMetadata
    boolean connectionAccepted
    boolean replyReceived
  }
  DiscoveryProfile {
    string id PK
    string companyId FK
    string name
    string category
    json criteria
    boolean autoRun
  }
  DiscoveryRun {
    string id PK
    string discoveryProfileId FK
    enum status
    int leadsFound
    int leadsCreated
    json summary
  }
  OutreachConfig {
    string id PK
    string companyId FK
    json enabledSources
  }
```

`Lead` is the hub. A lead optionally points at the profile that discovered it (set to null if the profile is deleted), and `category` is copied onto the lead so grouping survives. Signals and messages cascade-delete with their lead. `OutreachConfig` is one row per company and drives signal detection only. Discovery uses each profile's own `criteria`.

## Design decisions

- **One lead table for both screens.** `listLeads` and `listLeadSummaries` share `leadWhere`, so a lead on the Leads page is always on the Outreach board with the same filters. This fixed the earlier "leads don't show up in Outreach" report.
- **Company granularity from public sources; people only from public team pages or the user.** No LinkedIn scraping. Person names are extracted only when an AI provider is configured, never guessed.
- **Honest degradation.** Every source reports `skipped` with a reason, and runs store per-source counts. Scoring and drafting fall back to deterministic output tagged `model: 'none'`, which also lowers the bulk-approval confidence.
- **Scores you can argue with.** Fit scores carry `fitMatched` / `fitMissed`. The deterministic scorer weights criteria groups instead of a flat floor that made every lead score 35.
- **Caps, not deductions, for bulk approval.** A missing essential (signal, brand voice, strong fit, named contact, URL) holds a draft below 70 however strong the rest is, because bulk approval means sending unread.
- **Same approval semantics as content.** The transition table, the compare-and-set update, the blocking compliance checks and version history mirror Content Studio, so the unified review can treat both alike.
- **Sending is a human act in the browser.** The server only hands approved text to the extension and records the human's confirmation. Integrity (`outreachIntact`) and the execution gate are checked again at send time.
- **Denormalized `category`.** Leads keep their requirement label even if the profile is renamed or deleted, so different requirements never mix.
