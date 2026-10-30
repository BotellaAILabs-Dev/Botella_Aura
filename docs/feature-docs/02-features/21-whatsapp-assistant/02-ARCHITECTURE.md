# WhatsApp AI Assistant — Architecture

The assistant is a webhook-driven pipeline with a Postgres work queue. Meta's webhook is acknowledged at once. A worker then decides the answer, re-checking the person's session, membership and role on every message, and runs one tool from a fixed registry over existing Aura services. Replies go back through the Cloud API, subject to the 24-hour window, opt-out and retry rules.

## Component architecture

```mermaid
flowchart TD
  Meta{{"Meta WhatsApp Cloud API"}}
  subgraph Edge["Routes"]
    WH["/api/webhooks/whatsapp<br/>signature check"]
    Cron["/api/cron/whatsapp<br/>sweepQueue"]
    Web["/api/whatsapp/*<br/>link, links, settings, send"]
    LinkPage["/whatsapp/link/token page"]
  end
  subgraph Pipeline["server/whatsapp"]
    WS["whatsapp.service.ts<br/>record, send, statuses"]
    Q["queue.ts<br/>lease, jobs, retention"]
    H["handler.ts<br/>idempotency, flood limit"]
    AG["agent.ts<br/>decide"]
    LS["link.service.ts<br/>challenges, sessions"]
    RT["router.ts<br/>ids, intents, AI router"]
    TL["tools/*<br/>registry + RBAC"]
    CL["client.ts<br/>Graph API"]
  end
  Svc["Aura services<br/>home, content, review,<br/>multi-publish, analytics"]
  AI{{"AI layer"}}
  DB[("PostgreSQL<br/>WhatsApp tables")]

  Meta -->|"signed POST"| WH
  WH --> WS
  WS --> DB
  WH -->|"waitUntil"| Q
  Cron --> Q
  Q --> H
  H --> AG
  AG --> LS
  AG --> RT
  RT --> AI
  RT --> TL
  TL --> Svc
  H --> WS
  WS --> CL
  CL --> Meta
  LinkPage --> Web
  Web --> LS
  LS --> DB
  Q --> DB
```

Inbound traffic enters only through the signed webhook, and outbound traffic leaves only through `client.ts`. Between them, the queue serializes each conversation, the agent resolves who is speaking and in which workspace, and the router picks exactly one tool. Tools are thin wrappers over services the web app already uses, so WhatsApp gets the same rules. The website routes are the other half of sign-in and the workspace controls.

## Main flow

```mermaid
sequenceDiagram
  participant M as Meta
  participant W as Webhook route
  participant Q as Queue worker
  participant A as agent decide
  participant L as link.service
  participant R as router
  participant T as Tool
  participant C as Cloud API client

  M->>W: POST messages with X-Hub-Signature-256
  W->>W: verify HMAC over raw body
  W->>W: store message once by wamid, create QUEUED job
  W-->>M: 200 at once
  W->>Q: waitUntil drainConversations
  Q->>Q: lease conversation, claim oldest job
  Q->>A: handleInbound then decide
  A->>L: resolveSession, re-read membership and role
  alt not linked or expired
    A-->>Q: sign-in CTA with single-use link
  else linked with active workspace
    A->>R: route with ToolContext from session
    R->>R: reply id, awaited answer, intent match, else AI router
    R->>T: runTool after RBAC and schema checks
    T-->>R: contents
    R-->>A: reply
  end
  Q->>C: sendContent within 24h window, not opted out
  C->>M: Graph API messages
  M-->>W: later status webhooks sent, delivered, read
```

The webhook does only cheap work before answering Meta, and the rest runs after the response. If the worker dies, the lease expires and the cron sweep resumes. If sending is throttled, the message is retried later. The `ToolContext` is built from the resolved session, never from the message text or the model's output.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> ISSUED: Hi from unknown number
  ISSUED --> CONFIRMED: signed-in user confirms on website
  ISSUED --> CANCELLED: newer link or This is not me
  CONFIRMED --> COMPLETED: correct code from same number
  CONFIRMED --> CANCELLED: 5 wrong codes or newer link
  COMPLETED --> [*]
  CANCELLED --> [*]
```

`WhatsAppLinkChallenge.status`: each step is a compare-and-swap, so a link or a code works only once. Expiry is checked by time (10 minutes for the link and again for the code) rather than stored as a separate status. `COMPLETED` creates or refreshes the `WhatsAppAccountLink` session for 30 days.

```mermaid
stateDiagram-v2
  [*] --> QUEUED: webhook stores message
  QUEUED --> RUNNING: worker claims head job
  RUNNING --> DONE: handled
  RUNNING --> QUEUED: failure, back off
  RUNNING --> DEAD: 4th failure
  DONE --> [*]
  DEAD --> [*]
```

`WhatsAppJob.status`: a failed job returns to `QUEUED` with `runAfter` pushed back (15 s, 60 s, 5 min) and blocks the jobs behind it, so order is kept. A job stuck in `RUNNING` for more than 2 minutes is picked up again. `DEAD` is the dead-letter state shown on the dashboard.

```mermaid
stateDiagram-v2
  [*] --> RECEIVED: inbound
  [*] --> PENDING: outbound queued
  PENDING --> SENT: Meta accepted
  PENDING --> FAILED: non-retryable or out of attempts
  SENT --> DELIVERED: status webhook
  DELIVERED --> READ: status webhook
  SENT --> FAILED: status webhook
  RECEIVED --> [*]
  READ --> [*]
  FAILED --> [*]
```

`WhatsAppMessage.status`: statuses from webhooks only move forward (`shouldApplyStatus`), so out-of-order deliveries cannot move a message back. Retryable send errors keep the message `PENDING` with `nextAttemptAt` set, for up to 6 attempts.

## Data model

```mermaid
erDiagram
  WhatsAppConversation ||--o{ WhatsAppMessage : "contains"
  WhatsAppConversation ||--o{ WhatsAppJob : "queues"
  WhatsAppConversation ||--o{ WhatsAppLinkChallenge : "signs in with"
  WhatsAppConversation ||--o| WhatsAppAccountLink : "linked as"
  WhatsAppMessage ||--o| WhatsAppJob : "handled by"
  User ||--o{ WhatsAppAccountLink : "owns"
  Company |o--o{ WhatsAppAccountLink : "active workspace"
  Company |o--o{ WhatsAppMessage : "handled in"
  WhatsAppConversation {
    string id PK
    string waIdHash
    string waIdEncrypted
    string waIdLast4
    datetime lastInboundAt
    boolean optedOut
    datetime leaseUntil
  }
  WhatsAppAccountLink {
    string id PK
    string conversationId FK
    string userId FK
    string activeCompanyId FK
    datetime expiresAt
    datetime revokedAt
    json state
  }
  WhatsAppLinkChallenge {
    string id PK
    string conversationId FK
    string tokenHash
    enum status
    string userId FK
    string codeHash
    int codeAttempts
    datetime expiresAt
  }
  WhatsAppJob {
    string id PK
    string conversationId FK
    string messageId FK
    enum status
    int attempts
    datetime runAfter
  }
  WhatsAppMessage {
    string id PK
    string conversationId FK
    enum direction
    string wamid
    enum status
    string companyId FK
    string replyToId
    int attempts
  }
```

The conversation is one phone number, stored only as a keyed hash, an encrypted copy and the last 4 digits. It is not tied to a workspace. The link ties it to a user and an active workspace, and every message is stamped with the workspace it was handled in. That stamp is what keeps dashboards and AI history per workspace. Jobs are one-to-one with inbound messages.

## Design decisions

- **Acknowledge first, work later.** Meta gets its 200 before any AI or service call. The answer runs via `waitUntil`, with a cron sweep as a safety net. Redeliveries are harmless because `wamid` is unique.
- **A Postgres queue, no paid queue service.** Conversation leases give per-person ordering and parallelism across people, and a dead-letter state keeps failures visible.
- **Two-way linking.** The website confirmation proves Aura account ownership, and the code from the phone proves the same person holds the number. A forwarded link cannot attach the wrong number.
- **Authorization is re-derived on every message.** Membership, role and the workspace's WhatsApp switch are read fresh, so removal or demotion takes effect on the next message, not when the session expires.
- **The AI only chooses; the server decides.** The router model sees only the tools the role allows, with user text fenced as data. Its choice still passes the RBAC check, schema validation and, for changes, a single-use confirmation the model cannot produce.
- **Reuse existing services.** Approve runs `runReviewAction` and publish runs `publishToPlatforms`, the same paths as the web UI, so compliance, fact checks and double-publish protection apply unchanged.
- **Privacy by default.** Numbers are hashed and encrypted, the dashboard shows only last-4 digits, and message text expires after `WHATSAPP_RETENTION_DAYS`.
- **Meta rules in code.** Free-form replies only inside the 24-hour window, STOP honoured before anything else, and no marketing or template sends.
