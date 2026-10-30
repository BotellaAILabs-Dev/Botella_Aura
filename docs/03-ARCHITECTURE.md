# Application Architecture — Botella Aura

How Botella Aura is built: one master view of the whole application, then the same system at C4 levels
(context → containers → components), the core intelligence pipeline, the request lifecycle, security, data and
deployment. Each feature's own architecture is in [`feature-docs/02-features/`](feature-docs/README.md#features).

| | |
| --- | --- |
| **Architecture style** | Modular monolith — one Next.js 14 deployable with strict layering (route → service → data) |
| **Clients** | Responsive web app · Chrome MV3 extension · WhatsApp (Meta Cloud API) |
| **Runtime** | Vercel serverless functions (`sin1`, 60 s limit) + Vercel Cron + a Postgres-backed job queue |
| **Data** | Neon PostgreSQL via Prisma 5 (61 models, 49 migrations); optional S3-compatible media bucket |
| **AI** | One AI client: Anthropic Claude primary, Google Gemini fallback, 3 model tiers; 6 image providers |
| **Size** | 181 API route files (250 operations) · 39 service areas · 104 shared modules · 47 dashboard pages |

---

## 1. Master architecture diagram

The whole application in one picture: who uses it, the layers every request passes, the domain modules, and
everything they depend on.

```mermaid
block-beta
  columns 1

  block:L1
    columns 5
    h1["1 · CLIENTS"]
    c1["Web app<br/>React 18 · responsive"]
    c2["Chrome extension<br/>MV3 · user's own LinkedIn"]
    c3["WhatsApp<br/>one central number"]
    space
  end

  block:L2
    columns 5
    h2["2 · EDGE"]
    e1["middleware.ts<br/>session gate"]
    e2["Signed webhooks<br/>Stripe · WhatsApp · Meta"]
    e3["Vercel Cron<br/>Bearer CRON_SECRET"]
    e4["Extension API<br/>Bearer token"]
  end

  block:L3
    columns 5
    h3["3 · PRESENTATION"]
    p1["Six navigation groups<br/>Home · Market · Create<br/>Customers · Results · Setup"]
    p2["47 dashboard pages<br/>onboarding · sign-in · legal"]
    p3["Design system<br/>Tailwind · Radix · shadcn/ui"]
    space
  end

  block:L4
    columns 5
    h4["4 · API LAYER<br/>181 routes · 250 ops"]
    a1["Zod validation"]
    a2["requireActiveCompany<br/>workspace from memberships"]
    a3["RBAC · plan<br/>entitlements"]
    a4["jsonOk / jsonError<br/>401 403 404 409 422"]
  end

  block:L5
    columns 5
    h5["5 · DOMAIN SERVICES<br/>server/ · 39 areas"]
    d1["Understand<br/>business context · knowledge<br/>brand · onboarding"]
    d2["Watch<br/>trends · competitors<br/>intelligence · signals"]
    d3["Decide<br/>opportunities · recommendations<br/>home · briefing"]
    d4["Create<br/>content · media<br/>planner · campaigns"]
    space
    d5["Trust<br/>review · approval<br/>versions · trace"]
    d6["Deliver<br/>connections · execution<br/>publishing · scheduling"]
    d7["Grow and learn<br/>leads · outreach · engagement<br/>memory · analytics"]
    d8["Channels and platform<br/>WhatsApp · extension<br/>billing · jobs · audit"]
  end

  block:L6
    columns 5
    h6["6 · SHARED CORE<br/>lib/ · 104 modules"]
    s1["Rules and contracts<br/>recommendation rules · brief<br/>approval · execution state"]
    s2["AI client<br/>tiers · retries · Zod output"]
    s3["HTTP client<br/>timeouts · robots · SSRF-safe"]
    s4["Security<br/>AES-256-GCM · hashing<br/>rate limit · audit"]
  end

  block:L7
    columns 5
    h7["7 · DATA"]
    db1[("Neon PostgreSQL<br/>Prisma 5 · 61 models")]
    db2[("Job queues<br/>GenerationJob · WhatsAppJob")]
    db3[("S3-compatible bucket<br/>images and video")]
    space
  end

  block:L8
    columns 6
    h8["8 · EXTERNAL"]
    x1{{"Claude · Gemini"}}
    x2{{"6 image<br/>providers"}}
    x3{{"Meta Graph<br/>LinkedIn"}}
    x4{{"News · RSS · Reddit<br/>HN · GitHub"}}
    x5{{"Stripe · Email<br/>Google OAuth"}}
  end

  classDef layer fill:#1F3864,stroke:#1F3864,color:#FFFFFF,font-weight:bold
  classDef core fill:#E8F0FB,stroke:#4A6FA5,color:#0B2545
  classDef dom fill:#EAF6EE,stroke:#3C8D5A,color:#123B22
  classDef data fill:#FFF4E0,stroke:#C8892B,color:#4A3000
  classDef ext fill:#F3ECFA,stroke:#7B5AA6,color:#2E1A47
  class h1,h2,h3,h4,h5,h6,h7,h8 layer
  class c1,c2,c3,e1,e2,e3,e4,p1,p2,p3,a1,a2,a3,a4,s1,s2,s3,s4 core
  class d1,d2,d3,d4,d5,d6,d7,d8 dom
  class db1,db2,db3 data
  class x1,x2,x3,x4,x5 ext
```

**How to read it.** Each row is a layer; a request travels down the rows, and each layer talks only to the one below it. Clients reach the app through the edge
(session middleware, signed webhooks, authenticated cron, the extension's bearer token). Every API route applies the same guards (input validation, workspace
resolution, role and plan checks) before delegating to a domain service. Services hold all business logic and
writes; they share pure rules and contracts from `lib/`, and reach the outside world only through two clients —
the AI client and the HTTP client. All data is in PostgreSQL, with an optional bucket for media.

---

## 2. System context (C4 level 1)

```mermaid
flowchart LR
  Team["Marketing team<br/>Owner · Admin · Member · Viewer"]
  Phone["WhatsApp user<br/>linked team member"]
  Aura["Botella Aura<br/>AI marketing co-pilot"]
  AI{{"AI providers"}}
  Social{{"Facebook · Instagram<br/>LinkedIn"}}
  Market{{"Public market data<br/>news · feeds · GitHub · websites"}}
  Biz{{"Stripe · Email · Google"}}
  Team -->|"plans, reviews, approves"| Aura
  Phone -->|"asks, drafts, approves"| Aura
  Aura -->|"prompts"| AI
  Aura -->|"publishes approved posts,<br/>reads insights"| Social
  Aura -->|"reads"| Market
  Aura -->|"billing, mail, sign-in"| Biz
```

Aura sits between a marketing team and the platforms it publishes to. It reads public market data, uses AI to
think and write, and publishes only what a person has approved.

---

## 3. Containers (C4 level 2)

```mermaid
flowchart TB
  subgraph Browser["User's browser"]
    SPA["Next.js React UI"]
    CE["Chrome extension<br/>popup · content script · queue"]
  end
  subgraph Vercel["Vercel - region sin1"]
    APP["Next.js server<br/>pages + 181 API routes"]
    JOBS["Background work<br/>job runners · waitUntil drains"]
    CR["Vercel Cron<br/>publish · connections · briefing"]
  end
  NEON[("Neon PostgreSQL<br/>ap-southeast-1")]
  BUCKET[("S3-compatible storage")]
  META{{"Meta Cloud API<br/>WhatsApp webhooks"}}
  SPA -->|"HTTPS JSON + session cookie"| APP
  CE -->|"HTTPS + Bearer token"| APP
  META -->|"signed webhook"| APP
  CR -->|"Bearer CRON_SECRET"| APP
  APP --> JOBS
  APP -->|"Prisma - pooled"| NEON
  JOBS --> NEON
  APP -->|"presigned URLs"| BUCKET
```

| Container | Technology | Responsibility |
| --- | --- | --- |
| Web UI | Next.js 14 App Router, React 18, Tailwind, Radix | Server-rendered pages and client components for all modules |
| API | Next.js route handlers | 250 operations; validation, auth, delegation |
| Background work | Postgres job queue + `waitUntil` + cron sweeps | Long AI generation, WhatsApp replies, publishing, health checks |
| Chrome extension | Manifest V3, plain JS | Paired by token; inserts approved text into LinkedIn's own composer; syncs visible metrics |
| Database | PostgreSQL (Neon), Prisma 5 | All tenant data, queues, audit log |
| Media storage | Postgres (default) or S3-compatible bucket | Generated images, creatives, video for Reels |

---

## 4. Components — domain modules (C4 level 3)

```mermaid
flowchart TB
  subgraph U["1 · Understand"]
    direction LR
    ONB["Onboarding"] --> BC["Business Context<br/>snapshot · questions"]
    KB["Knowledge base"] --> BC
    BV["Brand voice"] --> BC
  end
  subgraph W["2 · Watch"]
    direction LR
    TR["Trends"] --> SIG["Signals<br/>normalised · de-duplicated"]
    CO["Competitors"] --> SIG
    MEM["Marketing Memory"] --> SIG
  end
  subgraph D["3 · Decide"]
    direction LR
    OPP["Opportunities<br/>5 rules + validated AI"] --> REC["Recommendation engine<br/>guardrails · ranking"] --> SUG["Aura Suggests<br/>Aura Home"]
  end
  subgraph C["4 · Create"]
    direction LR
    BRF["Content Brief<br/>16 fields"] --> GEN["Content generation<br/>9 formats"]
    BRF --> MED["Media and creatives"]
    PLN["Planner · Campaigns"] --> GEN
  end
  subgraph T["5 · Trust"]
    direction LR
    CHK["Checks<br/>quality · fact check · AI reviewer<br/>compliance · brand safety"] --> APR["Review and approval<br/>versions · trace"]
  end
  subgraph X["6 · Deliver"]
    direction LR
    CON["Connections<br/>health · tokens"] --> EXE["Execution engine<br/>schedule · route · retry"] --> PUB["Publishers<br/>Facebook · Instagram · LinkedIn"]
  end
  U -->|"trusted facts"| W
  W -->|"evidence"| D
  D -->|"accepted suggestion"| C
  C -->|"draft + images"| T
  T -->|"approved version"| X
  X -->|"published results"| LOOP(["Results feed Marketing Memory<br/>and become new signals in 2 · Watch"])
```

---

## 5. The core intelligence pipeline

Every published post can be traced back through this chain; the trace is stored on the draft
(`aiMetadata.trace`) and shown in the "Why this exists" panel.

```mermaid
flowchart LR
  A["Business Context<br/>revision + fields"] --> B["Signal<br/>normalised evidence"]
  B --> C["Opportunity<br/>DETECTED → ACCEPTED"]
  C --> D["Recommendation<br/>GENERATED → COMPLETED"]
  D --> E["Content Brief<br/>16 sourced fields"]
  E --> F["Generated asset<br/>v1 kept forever"]
  F --> G["Reviewed version<br/>AI review + fact check"]
  G --> H["Approved version<br/>approver + fingerprint"]
  H --> I["Execution<br/>one per post and network"]
```

| Stage | Guarantee |
| --- | --- |
| Business Context | Every fact has a source, confidence and freshness; AI-derived facts are labelled as assumptions |
| Signals | De-duplicated per workspace; repeat sightings corroborate, re-reads do not |
| Opportunities | Need minimum evidence; confidence capped by evidence and by unconfirmed context |
| Recommendations | Guardrails: eligibility, minimum evidence, frequency limits, duplicates, supported channels only |
| Content | Writer held to the brief; facts not in a source are blocked; independent reviewer; compliance policy |
| Approval | Covers text + network + images; any change reopens it |
| Execution | Compare-and-swap state machine; refuses content that no longer matches its approval |

---

## 6. Request lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant M as middleware.ts
  participant R as Route handler
  participant G as Guards
  participant S as Service
  participant DB as PostgreSQL
  participant X as AI or external API

  B->>M: Request with session cookie
  M->>R: Signed in - continue
  R->>G: Parse body with Zod
  G->>G: requireActiveCompany - user and workspace
  G->>G: can role permission - entitlement
  alt not allowed
    G-->>B: 401 or 403 or 422 JSON error
  else allowed
    R->>S: Delegate with companyId
    S->>DB: Scoped read
    S->>X: Optional call through AI or HTTP client
    X-->>S: Result - validated
    S->>DB: Write + AuditLog in one transaction
    S-->>R: Domain result
    R-->>B: jsonOk
  end
```

---

## 7. Security architecture

```mermaid
block-beta
  columns 5
  h1["IDENTITY"]
  i1["NextAuth JWT session<br/>credentials · Google · LinkedIn"]
  i2["Extension token<br/>SHA-256 hashed · revocable"]
  i3["CRON_SECRET<br/>bearer"]
  i4["Webhook signatures<br/>Stripe · X-Hub-Signature-256<br/>Meta signed_request"]
  h2["ACCESS CONTROL"]
  a1["Workspace from the<br/>user's own memberships"]
  a2["Role permissions<br/>lib/rbac.ts"]
  a3["Every query scoped<br/>by companyId"]
  a4["Foreign ids answer 404<br/>nothing revealed"]
  h3["DATA PROTECTION"]
  p1["AES-256-GCM<br/>OAuth tokens · API keys"]
  p2["Hashed reset, invite<br/>and link tokens"]
  p3["Secrets removed<br/>before AI calls"]
  p4["Append-only<br/>AuditLog"]
  h4["PLATFORM"]
  f1["Rate limiting<br/>auth endpoints"]
  f2["Security headers<br/>DENY · nosniff · referrer"]
  f3["SSRF-safe outbound<br/>http(s) links only"]
  f4["Sandbox overrides<br/>loopback only"]
  classDef layer fill:#1F3864,stroke:#1F3864,color:#FFFFFF,font-weight:bold
  classDef item fill:#E8F0FB,stroke:#4A6FA5,color:#0B2545
  class h1,h2,h3,h4 layer
  class i1,i2,i3,i4,a1,a2,a3,a4,p1,p2,p3,p4,f1,f2,f3,f4 item
```

Defences are layered: identity is established once per request, the workspace is derived only from the user's own
memberships, every service call carries the `companyId`, and sensitive values are encrypted or hashed at rest.
Details and the open gaps: [feature-docs/02-features/24-platform-jobs-and-deployment](feature-docs/02-features/24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md)
and [SRS §7](02-SRS.md).

---

## 8. Data architecture

```mermaid
erDiagram
  Company ||--o{ CompanyMember : "members"
  User ||--o{ CompanyMember : "memberships"
  Company ||--o| BusinessContextSnapshot : "snapshot"
  Company ||--o{ KnowledgeSource : "materials"
  Company ||--o{ Signal : "signals"
  Company ||--o{ Opportunity : "opportunities"
  Opportunity ||--o{ Recommendation : "recommendations"
  Company ||--o{ ContentDraft : "content"
  Campaign ||--o{ ContentDraft : "campaign content"
  ContentDraft ||--o{ GeneratedAsset : "images"
  ContentDraft ||--o{ Execution : "executions"
  Company ||--o{ Connection : "connections"
  Connection ||--o{ ConnectedAccount : "pages"
  Company ||--o{ Lead : "leads"
  Lead ||--o{ OutreachMessage : "messages"
  Company ||--o{ AuditLog : "audit"
```

| Concern | Approach |
| --- | --- |
| Tenancy | `companyId` on every business table; cascade delete with the workspace |
| Concurrency | Optimistic revisions (409 on stale writes), compare-and-swap status transitions, advisory locks |
| Flexible structures | JSON columns for approval records, versions, trace, compliance policy and fact metadata |
| Migrations | 49 Prisma migrations, additive or with backfill; applied on deploy with connection retries |
| Retention | WhatsApp message text 90 days by default; Meta data-deletion callback supported |

---

## 9. Deployment architecture

```mermaid
flowchart LR
  DEV["Developer"] -->|"git push main"| GH["GitHub<br/>origin + botella"]
  GH --> BUILD["Vercel build<br/>extension · prisma generate<br/>migrate-deploy · next build"]
  BUILD --> FN["Serverless functions<br/>sin1 · 60 s"]
  FN -->|"pooled"| DB[("Neon<br/>ap-southeast-1")]
  BUILD -->|"direct"| DB
  CRON["Vercel Cron"] --> FN
  FN --> ST[("S3-compatible bucket")]
  FN --> EXT{{"AI · Meta · LinkedIn<br/>Stripe · email"}}
```

| Environment | How |
| --- | --- |
| Local | `docker compose up -d` (Postgres 16) → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`; Meta and WhatsApp through `npm run sandbox` |
| Production | Vercel + Neon; migrations on every deploy; three scheduled crons |
| Alternatives | Netlify (`netlify.toml`) and Railway (`railway.json`) configurations kept |

---

## 10. Architecture decisions

| Decision | Why |
| --- | --- |
| Modular monolith on Next.js | One deployable, types and Zod schemas shared by client and server, fast iteration |
| All logic in services, thin routes | Every entry point (web, WhatsApp, cron, extension) reuses the same rules and gates |
| One AI client, one HTTP client | Retries, timeouts, tiers, robots.txt and safety enforced in one place |
| Deterministic rules before AI | Detection, guardrails, fact check and brand safety must hold even when a model is wrong |
| Human approval as a hard gate | Trust and platform safety; enforced in the service layer, not the UI |
| JSON for evolving structures | Approval, versions and trace shipped without migrations |
| Postgres as the queue | No extra infrastructure; leases, retries and dead letters in SQL |
| Extension for LinkedIn actions | The server never holds LinkedIn cookies or automates clicks |
