# Engagement Copilot — Architecture

The Engagement Copilot is split across the browser and the server on purpose. The extension reads the post the user is already looking at and does all the LinkedIn interaction. The server only turns the text it is given into a comment and records what the human did. The web app manages the target list and shows a read-only history.

## Component architecture

```mermaid
flowchart LR
  subgraph Browser["User's browser on linkedin.com"]
    CS["content/linkedin.js<br/>readVisiblePost + panel"]
    BG["background.js<br/>bearer token, rate caps"]
  end
  subgraph Web["Web app"]
    UIHist["/dashboard/engagement"]
    UISet["/dashboard/settings/engagement<br/>target-manager.tsx"]
  end
  RDraft["/api/extension/engagement/draft"]
  RDone["/api/extension/actions/complete"]
  RTgt["/api/engagement/targets"]
  SCom["comment.service.ts<br/>draftComment"]
  STgt["target.service.ts"]
  SAct["action.service.ts<br/>completeEngagementComment"]
  BC["Business Context +<br/>brand voice"]
  AI{{"AI layer"}}
  DB[("PostgreSQL<br/>EngagementComment<br/>EngagementTarget")]

  CS -->|"post text"| BG
  BG --> RDraft
  BG --> RDone
  RDraft --> SCom
  SCom --> BC
  SCom --> AI
  SCom --> DB
  RDone --> SAct
  SAct --> DB
  UISet --> RTgt
  RTgt --> STgt
  STgt --> DB
  UIHist -->|"listComments, listTargets"| DB
```

The left side runs in the user's browser. Only the background worker talks to Aura, and it always uses the extension bearer token. The server pieces in the middle never reach LinkedIn: `draftComment` reads Business Context and calls the AI layer, and `completeEngagementComment` only updates a row. The web pages on the right read the same tables, and the settings page writes the target list.

## Main flow

```mermaid
sequenceDiagram
  participant U as User
  participant P as linkedin.js panel
  participant B as background.js
  participant D as /api/extension/engagement/draft
  participant S as draftComment
  participant AI as AI layer
  participant C as /api/extension/actions/complete

  U->>P: Draft a comment for this post
  P->>P: readVisiblePost from the rendered DOM
  P->>B: AURA_ENGAGE_DRAFT postUrl, postText, author
  B->>D: POST with Bearer aura_ext token
  D->>D: verify token, re-read membership, content:create
  D->>S: draftComment
  S->>AI: brand-voice comment request
  AI-->>S: comment text
  S-->>D: EngagementComment DRAFT saved
  D-->>P: commentId, text, actionsToday
  U->>P: edit, Insert into comment box
  U->>U: clicks LinkedIn Post button
  U->>P: Mark as posted
  P->>B: AURA_COMPLETE engagement_comment
  B->>B: client cap 8 per hour, 25 per day
  B->>C: POST itemType, itemId, postedUrl
  C->>C: server cap 25 per day, content:approve
  C-->>P: POSTED
```

The flow has two server round-trips: one to draft and one to record the post. The actual posting happens between them, on LinkedIn, by the human. If no AI provider is configured or the call fails, `draftComment` returns the deterministic fallback, so the draft step does not fail on AI problems.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> DRAFT: draftComment
  DRAFT --> POSTED: Mark as posted
  DRAFT --> DISCARDED: not implemented
  POSTED --> [*]
```

`EngagementComment.status` has three values. Only `DRAFT → POSTED` is reachable in code, and marking posted again is a no-op. `DISCARDED` exists in the enum and the history badge, but nothing sets it yet.

## Data model

```mermaid
erDiagram
  Company ||--o{ EngagementTarget : "monitors"
  Company ||--o{ EngagementComment : "drafted"
  EngagementComment ||--o{ PerformanceSnapshot : "measured by"
  EngagementTarget {
    string id PK
    string companyId FK
    string label
    string profileUrl
    datetime createdAt
  }
  EngagementComment {
    string id PK
    string companyId FK
    string createdById
    string targetPostUrl
    string targetAuthor
    string postExcerpt
    string draftText
    enum status
    json aiMetadata
    datetime postedAt
  }
```

The two models are independent: a comment does not reference a target. Targets are unique per `(companyId, profileUrl)`. Comments store the post excerpt they answered, so the history stays readable without going back to LinkedIn.

## Design decisions

- **The client captures, the server drafts.** LinkedIn offers no API for arbitrary third-party feeds, and scraping is ruled out, so the only post text Aura ever sees is what is already rendered in the user's own browser.
- **One human click per action, never automated.** The extension fills LinkedIn's editor but never clicks LinkedIn's submit. "Mark as posted" is a separate confirmation that syncs the status back.
- **Identity and voice only in the prompt.** The `engagement` Business Context preset leaves out the workspace audience, because the reader of a comment is someone else's audience. Knowing the company's actual field is what lets the model add a real perspective instead of filler.
- **Rate caps on both sides.** The client blocks before any API call (8/hour, 25/day). The server enforces the daily cap again as defence-in-depth (429).
- **The web app is the system of record but read-only for comments.** History lives in Aura for Marketing Memory, while all LinkedIn interaction stays in the extension.
- **Drafting is open to members, recording posts is not.** `content:create` lets MEMBERs draft, while marking a post as posted needs `content:approve`, matching the other extension sync-backs.
