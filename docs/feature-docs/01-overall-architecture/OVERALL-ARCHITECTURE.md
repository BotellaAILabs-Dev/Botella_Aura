# Botella Aura — Overall Architecture & Application Workflow

Botella Aura is an AI marketing co-pilot. It learns a business, watches its market, decides what is worth doing,
drafts the work, and hands it to a person to approve before anything is published or sent. This document shows
how the whole application fits together. Each feature has its own folder under
[`../02-features/`](../02-features/) with details, architecture and change history.

| | |
| --- | --- |
| **Product** | Botella Aura — AI Marketing Co-Pilot (`botella-aura` v0.1.0) |
| **Type** | Multi-tenant SaaS web app + Chrome extension + WhatsApp assistant |
| **Stack** | Next.js 14 (App Router) · React 18 · TypeScript (strict) · Prisma 5 · PostgreSQL · NextAuth v4 · Zod · Tailwind |
| **Size** | 61 Prisma models · 49 migrations · 181 API route files (250 operations) · 47 dashboard pages · 147 test suites · 66 verification scripts |
| **Hosting** | Vercel (functions in `sin1`) + Neon PostgreSQL (`ap-southeast-1`); Netlify and Railway configs also present |
| **Development** | 23 Jul 2026 → present · 204 commits — see [`../03-changelog/CHANGELOG.md`](../03-changelog/CHANGELOG.md) |

---

## 1. System context

Who and what Aura talks to. Everything outside the app box is reached through one HTTP client
(`lib/http.ts`) or one AI client (`server/ai/claude.ts`).

```mermaid
flowchart LR
  subgraph People["People"]
    Owner["Owner / Admin"]
    Member["Member / Viewer"]
    WAUser["WhatsApp user"]
  end

  subgraph Clients["Clients"]
    Browser["Web app in browser"]
    Ext["Chrome extension<br/>MV3"]
    WA["WhatsApp"]
  end

  subgraph Aura["Botella Aura on Vercel"]
    App["Next.js app<br/>pages + API routes"]
    Cron["Vercel Cron<br/>+ job queue"]
  end

  DB[("Neon PostgreSQL")]
  S3[("S3-compatible bucket<br/>optional")]

  subgraph AI["AI providers"]
    Claude{{"Anthropic Claude"}}
    Gemini{{"Google Gemini"}}
    Img{{"Image models<br/>Gemini, OpenAI, Stability,<br/>Replicate, Hugging Face, Agnes"}}
  end

  subgraph Social["Social platforms"]
    Meta{{"Meta Graph API<br/>Facebook, Instagram, WhatsApp"}}
    LinkedIn{{"LinkedIn API"}}
  end

  subgraph Data["Public data sources"]
    News{{"Google News, Bing, RSS,<br/>Reddit, Hacker News"}}
    GitHub{{"GitHub API"}}
    Sites{{"Company and competitor<br/>websites"}}
  end

  subgraph Services["Business services"]
    Google{{"Google OAuth"}}
    Stripe{{"Stripe"}}
    Mail{{"Resend or SMTP"}}
  end

  Owner --> Browser
  Member --> Browser
  Owner --> Ext
  WAUser --> WA
  Browser -->|"HTTPS + session cookie"| App
  Ext -->|"Bearer extension token"| App
  WA -->|"Meta webhook"| App
  Cron --> App
  App --> DB
  App --> S3
  App --> Claude
  App --> Gemini
  App --> Img
  App --> Meta
  App --> LinkedIn
  App --> News
  App --> GitHub
  App --> Sites
  App --> Google
  App --> Stripe
  App --> Mail
  Ext -->|"inserts approved text<br/>into LinkedIn UI"| LinkedIn
```

People use the web app, the Chrome extension (which acts inside the user's own LinkedIn session) and WhatsApp.
The server never logs in to LinkedIn or scrapes it. Every external call is optional: a missing key turns a feature
into a labelled fallback instead of an error.

---

## 2. Layered architecture (defence in depth)

Every request passes the same four layers. Route handlers stay thin; all business logic and every write lives in a
service.

```mermaid
flowchart TD
  Req["Incoming request"] --> MW["middleware.ts - Edge<br/>redirects signed-out users away from /dashboard and /onboarding"]
  MW --> Route["app/api/**/route.ts<br/>Zod validation, session, workspace scope, RBAC, plan entitlement"]
  Route --> Svc["server/**/*.service.ts<br/>business rules, state machines, audit"]
  Svc --> Lib["lib/*<br/>pure rules, schemas, contracts"]
  Svc --> AIC["server/ai/claude.ts<br/>the only model client"]
  Svc --> HTTP["lib/http.ts<br/>the only outbound fetch"]
  Svc --> Prisma["Prisma client - lib/db.ts"]
  Prisma --> PG[("PostgreSQL")]
  AIC --> Prov{{"Claude or Gemini"}}
  HTTP --> Ext{{"Third-party APIs"}}
  Route -->|"jsonOk / jsonError"| Resp["JSON response"]
```

| Layer | Responsibility | Key files |
| --- | --- | --- |
| Edge middleware | Session gate for `/dashboard/*` and `/onboarding` | `middleware.ts` |
| Route handler | Parse → authorise → delegate → format. `requireActiveCompany()` resolves the user and the workspace from their own memberships; `can(role, permission)` checks RBAC | `app/api/**/route.ts`, `lib/auth-helpers.ts`, `lib/rbac.ts`, `lib/api.ts` |
| Service | All business logic and writes; action + `AuditLog` row in one transaction; compare-and-swap for concurrent edits | `server/**` (39 areas) |
| Shared rules | Pure, unit-tested logic and Zod contracts shared by client and server | `lib/**` (104 modules), `lib/validations/*` |
| Data | Prisma 5 over PostgreSQL; every query scoped by `companyId` | `prisma/schema.prisma`, `lib/db.ts` |
| Outbound | Timeouts, retries, user agent, robots.txt, SSRF-safe redirects | `lib/http.ts`, `lib/safe-url.ts` |
| AI | Claude primary, Gemini fallback, model tiers, structured (Zod-validated) output | `server/ai/claude.ts` |

---

## 3. Application workflow — from business to published post

This is the core loop built in Sprints 7–10. Each box is a feature folder.

```mermaid
flowchart TD
  Onb["Onboarding and guided setup<br/>03"] --> KB["Knowledge base and brand voice<br/>04"]
  Onb --> BC
  KB --> BC["Business Context<br/>trusted facts with source, confidence, freshness - 05"]
  Trends["Trend insights - 06"] --> Sig
  Comp["Competitor intelligence - 07"] --> Sig
  Mem["Marketing Memory and analytics - 18"] --> Sig
  BC --> Sig["Signals<br/>normalised and de-duplicated - 08"]
  Sig --> Opp["Opportunities<br/>rules + validated AI - 08"]
  Opp --> Rec["Recommendations<br/>engine, guardrails, ranking - 09"]
  Rec --> Sug["Aura Suggests and Aura Home - 09, 10"]
  Sug -->|"person accepts"| Brief["Content Brief - 11"]
  Brief --> Gen["Generation<br/>9 formats, variations - 11"]
  Brief --> Vis["Visual brief, images, creatives - 12"]
  Gen --> Chk["Checks<br/>quality, fact check, AI reviewer,<br/>compliance, brand safety - 11"]
  Vis --> Chk
  Chk --> Rev["Review and approval<br/>versions and trace - 13"]
  Rev -->|"approved"| Exe["Execution engine<br/>schedule, route, publish - 20"]
  Rev -->|"rejected or edited"| Gen
  Conn["Connections and OAuth - 19"] --> Exe
  Exe --> Meta{{"Facebook and Instagram"}}
  Exe --> LI{{"LinkedIn"}}
  Exe --> Res["Results"]
  Res --> Mem
  WA["WhatsApp assistant - 21"] -.->|"ask, draft, approve, publish"| Rev
  Plan["Campaigns and content plan - 14"] --> Gen
```

1. **Learn the business.** Onboarding, the knowledge base and brand voice feed the **Business Context**: one
   trusted model of the business where every fact records its source, confidence and freshness.
2. **Watch the market.** Trends, competitor changes, results and memory become **Signals**.
3. **Decide.** Deterministic rules plus validated AI turn signals into **Opportunities** with evidence; the
   **Recommendation engine** turns an opportunity into what, why, action and expected outcome, applying
   guardrails and ranking.
4. **Create.** Accepting a suggestion builds a **Content Brief**; Content Studio writes the piece and the media
   pipeline makes the visual. Every piece is checked for quality, facts, compliance and brand safety.
5. **Approve.** A person reviews and approves in one queue. An edit after approval reopens it.
6. **Execute.** The execution engine schedules and publishes through healthy connections, one job per network.
7. **Learn.** Results flow into Marketing Memory and back into the next round of signals.

### End-to-end sequence

```mermaid
sequenceDiagram
  autonumber
  participant U as Owner
  participant W as Web app
  participant R as Recommendation service
  participant C as Content service
  participant AI as AI client
  participant A as Approval service
  participant X as Execution engine
  participant P as Meta or LinkedIn

  U->>W: Open Aura Suggests
  W->>R: getSuggestions - ranked, quality-checked
  R-->>W: Suggestions with evidence
  U->>W: Say yes and create content
  W->>R: Accept recommendation
  W->>C: Generate from Content Brief
  C->>AI: Brief + generation context
  AI-->>C: Draft - Zod validated
  C->>AI: Independent AI review
  AI-->>C: Scores and issues
  C-->>W: Draft with fact check and review
  U->>W: Approve
  W->>A: Record approval - version + fingerprint
  A->>X: Execution handoff - READY
  X->>X: Route provider, check connection health, schedule
  X->>P: Publish
  P-->>X: Post id
  X-->>W: COMPLETED - trace stored
```

---

## 4. Navigation map (what the user sees)

The sidebar has six groups; a group's pages appear only while the user is inside it (`lib/nav.ts`).

```mermaid
flowchart LR
  Home["Home"] --- H1["Home<br/>/dashboard"]
  Home --- H2["Aura Suggests<br/>/dashboard/suggestions"]
  Home --- H3["Review and approve<br/>/dashboard/review"]
  Market["Your market"] --- M1["Marketing health<br/>/dashboard/intelligence"]
  Market --- M2["Market trends<br/>/dashboard/trends"]
  Market --- M3["Opportunities<br/>/dashboard/opportunities"]
  Market --- M4["Competitors<br/>/dashboard/competitors"]
  Create["Create"] --- C1["Content plan<br/>/dashboard/planner"]
  Create --- C2["Content Studio<br/>/dashboard/content"]
  Create --- C3["Publishing<br/>/dashboard/executions"]
  Create --- C4["Campaigns<br/>/dashboard/campaigns"]
  Customers["Customers"] --- U1["Leads<br/>/dashboard/leads"]
  Customers --- U2["Outreach<br/>/dashboard/outreach"]
  Customers --- U3["Comments and replies<br/>/dashboard/engagement"]
  Results["Results"] --- R1["Results<br/>/dashboard/analytics"]
  Results --- R2["What works for you<br/>/dashboard/memory"]
  Setup["Setup"] --- S1["About my business<br/>/dashboard/business"]
  Setup --- S2["Your tools<br/>/dashboard/connectors"]
  Setup --- S3["WhatsApp assistant<br/>/dashboard/whatsapp-assistant"]
  Setup --- S4["Settings<br/>/dashboard/settings"]
```

---

## 5. Background processing

Long AI work runs as resumable jobs so a request returns at once; Vercel Cron sweeps for stuck work.

```mermaid
flowchart LR
  UI["User action<br/>e.g. generate graphic, monthly plan"] -->|"enqueue + kick"| Q[("GenerationJob table")]
  Q --> Run["/api/jobs/:id/run<br/>atomic claim"]
  Run --> Done["SUCCEEDED or FAILED<br/>non-retryable errors fail at once"]
  Sweep["/api/cron/jobs<br/>restart stuck, pick up queued"] --> Q
  subgraph VercelCron["vercel.json crons"]
    CPub["/api/cron/publish<br/>daily 09:00"]
    CConn["/api/cron/connections<br/>daily 06:00 - health sweep"]
    CBrief["/api/cron/briefing<br/>Mondays 05:00 - weekly cycle"]
  end
  subgraph Other["Other cron routes - Bearer CRON_SECRET"]
    O1["trends, competitors, outreach,<br/>discovery, memory, analytics"]
    O2["intelligence, advisor, campaigns,<br/>whatsapp, jobs"]
  end
  CPub --> Exe["Execution engine"]
  CConn --> ConnSvc["Connection health"]
  CBrief --> Auto["Autopilot: write, illustrate,<br/>assemble briefing"]
```

All cron routes accept `Authorization: Bearer $CRON_SECRET` and are idempotent per workspace and period, so a
double fire never duplicates work. **Only the three routes in `vercel.json` are scheduled.** The others (trends,
competitors, outreach, discovery, memory, analytics, intelligence, advisor, campaigns, whatsapp, jobs) run only
when an external scheduler or a person calls them. Add them to `vercel.json` (or another scheduler) to automate
them. WhatsApp replies are drained by a Postgres work queue via `waitUntil`
and a cron sweep.

---

## 6. Deployment

```mermaid
flowchart LR
  Dev["Developer"] -->|"git push main"| GH["GitHub<br/>origin and botella remotes"]
  GH --> VB["Vercel build<br/>pnpm run vercel-build"]
  VB --> S1["package extension"]
  S1 --> S2["prisma generate"]
  S2 --> S3["migrate-deploy.mjs<br/>retries connection errors x5"]
  S3 --> S4["next build"]
  S4 --> Fn["Serverless functions<br/>region sin1, maxDuration 60s"]
  Fn --> Neon[("Neon Postgres<br/>ap-southeast-1<br/>pooled DATABASE_URL")]
  S3 --> NeonD[("Neon direct<br/>DIRECT_URL")]
  Cron["Vercel Cron"] --> Fn
```

Details: [`../02-features/24-platform-jobs-and-deployment/`](../02-features/24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md),
[`../../DEPLOYMENT-CHECKLIST.md`](../../DEPLOYMENT-CHECKLIST.md), [`../../VERCEL-DEPLOYMENT.md`](../../VERCEL-DEPLOYMENT.md).

---

## 7. Data model overview

The core entities and how they connect. Every business table carries `companyId` and is deleted with its
workspace. The full schema is `prisma/schema.prisma`.

```mermaid
erDiagram
  User ||--o{ CompanyMember : "belongs to"
  Company ||--o{ CompanyMember : "has members"
  Company ||--o{ KnowledgeSource : "learns from"
  Company ||--o| BusinessContextSnapshot : "summarised in"
  Company ||--o{ Signal : "observes"
  Company ||--o{ Opportunity : "detects"
  Opportunity ||--o{ OpportunitySignal : "evidenced by"
  Signal ||--o{ OpportunitySignal : "cited in"
  Opportunity ||--o{ Recommendation : "answered by"
  Recommendation ||--o{ RecommendationEvent : "history"
  Company ||--o{ Campaign : "runs"
  Campaign ||--o{ ContentDraft : "contains"
  Company ||--o{ ContentDraft : "creates"
  ContentDraft ||--o{ GeneratedAsset : "illustrated by"
  ContentDraft ||--o{ Execution : "published as"
  Execution ||--o{ ExecutionEvent : "history"
  Company ||--o{ Connection : "connects"
  Connection ||--o{ ConnectedAccount : "exposes pages"
  Company ||--o{ Lead : "discovers"
  Lead ||--o{ OutreachMessage : "contacted by"
  Company ||--o{ MarketingMemory : "remembers"
  Company ||--o{ AuditLog : "audited in"
  Company ||--o{ WhatsAppConversation : "talks on"
```

Approval records, versions and the trace chain are stored on the draft in `aiMetadata` (JSON), and the
compliance policy in `Company.preferences`, so those features needed no migration.

---

## 8. Cross-cutting principles (enforced in code)

| Principle | Enforcement |
| --- | --- |
| A person approves before anything goes out | Unified approval model; `PUBLISHED` reachable only from `APPROVED`; any change after approval reopens it (`changed_after_approval`) |
| Never invent facts or numbers | Business facts carry provenance; fact check, quality rules and AI reviewer block unsupported figures; empty states say what is missing |
| Workspace isolation | Every query scoped by `companyId`; foreign ids answer 404; static and HTTP isolation tests |
| Everything audited | Typed `AuditLog` rows for logins, edits, AI runs, approvals, publishes, sends |
| Fail visibly | Missing keys give labelled fallbacks or `skipped` sources, never silent success |
| Public sources only | robots.txt honoured, per-origin throttling, no LinkedIn scraping |
| Idempotent background work | Unique per period; advisory locks; compare-and-swap transitions |

---

## 9. Feature index

| # | Feature | Folder |
| --- | --- | --- |
| 01 | Authentication & Accounts | [01-authentication-and-accounts](../02-features/01-authentication-and-accounts/01-FEATURE-DETAILS.md) |
| 02 | Workspaces, Team & Roles (RBAC) | [02-workspaces-team-and-roles](../02-features/02-workspaces-team-and-roles/01-FEATURE-DETAILS.md) |
| 03 | Onboarding & Guided Setup | [03-onboarding-and-guided-setup](../02-features/03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md) |
| 04 | Knowledge Base & Brand Voice | [04-knowledge-base-and-brand-voice](../02-features/04-knowledge-base-and-brand-voice/01-FEATURE-DETAILS.md) |
| 05 | Business Context & About My Business | [05-business-context](../02-features/05-business-context/01-FEATURE-DETAILS.md) |
| 06 | Trend Insights | [06-trend-insights](../02-features/06-trend-insights/01-FEATURE-DETAILS.md) |
| 07 | Competitor Intelligence | [07-competitor-intelligence](../02-features/07-competitor-intelligence/01-FEATURE-DETAILS.md) |
| 08 | Signals & Opportunity Detection | [08-signals-and-opportunities](../02-features/08-signals-and-opportunities/01-FEATURE-DETAILS.md) |
| 09 | Recommendations & Aura Suggests | [09-recommendations-and-aura-suggests](../02-features/09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md) |
| 10 | Aura Home, What Matters Now & Weekly Briefing | [10-aura-home-and-briefing](../02-features/10-aura-home-and-briefing/01-FEATURE-DETAILS.md) |
| 11 | Content Studio | [11-content-studio](../02-features/11-content-studio/01-FEATURE-DETAILS.md) |
| 12 | Media, Graphics & Marketing Creatives | [12-media-graphics-and-creatives](../02-features/12-media-graphics-and-creatives/01-FEATURE-DETAILS.md) |
| 13 | Review, Approval, Versions & Traceability | [13-review-approval-versions-and-trace](../02-features/13-review-approval-versions-and-trace/01-FEATURE-DETAILS.md) |
| 14 | Campaigns & Content Planner | [14-campaigns-and-content-planner](../02-features/14-campaigns-and-content-planner/01-FEATURE-DETAILS.md) |
| 15 | Lead Discovery & Outreach Intelligence | [15-leads-and-outreach](../02-features/15-leads-and-outreach/01-FEATURE-DETAILS.md) |
| 16 | Engagement Copilot | [16-engagement-copilot](../02-features/16-engagement-copilot/01-FEATURE-DETAILS.md) |
| 17 | Chrome Extension | [17-chrome-extension](../02-features/17-chrome-extension/01-FEATURE-DETAILS.md) |
| 18 | Marketing Memory & Analytics | [18-marketing-memory-and-analytics](../02-features/18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md) |
| 19 | Connections, Connectors & OAuth | [19-connections-and-connectors](../02-features/19-connections-and-connectors/01-FEATURE-DETAILS.md) |
| 20 | Publishing, Execution Engine & Scheduling | [20-publishing-execution-and-scheduling](../02-features/20-publishing-execution-and-scheduling/01-FEATURE-DETAILS.md) |
| 21 | WhatsApp AI Assistant | [21-whatsapp-assistant](../02-features/21-whatsapp-assistant/01-FEATURE-DETAILS.md) |
| 22 | Billing, Plans & Entitlements | [22-billing-and-plans](../02-features/22-billing-and-plans/01-FEATURE-DETAILS.md) |
| 23 | AI Layer | [23-ai-layer](../02-features/23-ai-layer/01-FEATURE-DETAILS.md) |
| 24 | Platform: Jobs, Cron, Security & Deployment | [24-platform-jobs-and-deployment](../02-features/24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md) |
| 25 | Navigation, Dashboard Shell & Design System | [25-navigation-and-design-system](../02-features/25-navigation-and-design-system/01-FEATURE-DETAILS.md) |
