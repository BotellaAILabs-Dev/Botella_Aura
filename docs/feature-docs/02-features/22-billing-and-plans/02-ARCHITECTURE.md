# Billing, Plans & Entitlements — Architecture

Billing has three moving parts: hosted Stripe flows started from the billing page, a signature-verified webhook that mirrors Stripe's subscription state into `Subscription`, and an entitlement check that creation routes call before doing paid or limited work. Plan limits are one table in `server/billing/entitlements.ts`.

## Component architecture

```mermaid
flowchart TD
  subgraph UI["Browser"]
    Panel["billing-panel.tsx"]
  end
  subgraph Pages["Server pages"]
    BillPage["settings/billing/page.tsx"]
    Home["app/page.tsx pricing"]
  end
  subgraph API["API routes"]
    Checkout["/api/billing/checkout"]
    Portal["/api/billing/portal"]
    Hook["/api/webhooks/stripe"]
    Creators["creation routes<br/>campaigns, discovery, graphics"]
  end
  subgraph SVC["Services and lib"]
    CheckoutSvc["checkout.service.ts"]
    SubSvc["subscription.service.ts"]
    Ent["entitlements.ts<br/>PLAN_LIMITS, requireEntitlement"]
    StripeLib["lib/stripe.ts"]
    RBAC["lib/rbac.ts<br/>company:manageBilling"]
  end
  DB[("PostgreSQL<br/>Subscription, AuditLog")]
  Stripe{{"Stripe"}}

  BillPage --> SubSvc
  BillPage --> Ent
  BillPage --> Panel
  Home --> Ent
  Panel --> Checkout
  Panel --> Portal
  Checkout --> RBAC
  Portal --> RBAC
  Checkout --> CheckoutSvc
  Portal --> CheckoutSvc
  CheckoutSvc --> SubSvc
  CheckoutSvc --> StripeLib
  StripeLib --> Stripe
  Stripe -->|"signed events"| Hook
  Hook --> StripeLib
  Hook --> SubSvc
  SubSvc --> DB
  Creators --> Ent
  Ent --> DB
```

Outbound, the panel asks the API for a Checkout or Portal URL and sends the browser to Stripe. Inbound, Stripe calls the webhook, which verifies the signature through `lib/stripe.ts` and lets `subscription.service.ts` update the mirror. Independently, every creation route asks `entitlements.ts` whether the workspace may proceed.

## Main flow

```mermaid
sequenceDiagram
  participant O as Owner browser
  participant C as /api/billing/checkout
  participant CS as checkout.service
  participant S as Stripe
  participant W as /api/webhooks/stripe
  participant SS as subscription.service
  participant DB as PostgreSQL
  O->>C: POST plan
  C->>C: requireActiveCompany and can company:manageBilling
  C->>CS: createCheckoutSession
  CS->>SS: ensureSubscription, creates TRIAL if missing
  CS->>S: checkout.sessions.create with companyId and plan metadata
  CS->>DB: audit CHECKOUT_STARTED
  C-->>O: url
  O->>S: pay on hosted Checkout
  S-->>O: redirect to billing page with checkout success
  S->>W: checkout.session.completed with stripe-signature
  W->>W: constructEvent on raw body with STRIPE_WEBHOOK_SECRET
  alt signature invalid
    W-->>S: 400
  else verified
    W->>SS: handleStripeEvent
    SS->>DB: upsert Subscription ACTIVE, plan, customer and subscription ids
    SS->>DB: audit SUBSCRIPTION_CREATED
    W-->>S: 200 received
  end
```

The browser redirect and the webhook are independent; the plan is only considered active once the verified webhook has updated `Subscription`. If the handler throws, the route answers 500 so Stripe retries the event.

## Lifecycle / state machine

```mermaid
stateDiagram-v2
  [*] --> TRIALING: ensureSubscription, 14 days
  TRIALING --> ACTIVE: checkout.session.completed
  TRIALING --> TRIAL_EXPIRED: trialEndsAt passes
  TRIAL_EXPIRED --> ACTIVE: checkout.session.completed
  ACTIVE --> PAST_DUE: invoice.payment_failed
  PAST_DUE --> ACTIVE: subscription.updated to active
  ACTIVE --> CANCELED: subscription.deleted
  PAST_DUE --> CANCELED: subscription.deleted
  ACTIVE --> INCOMPLETE: subscription.updated with other status
  INCOMPLETE --> ACTIVE: subscription.updated to active
  CANCELED --> ACTIVE: new checkout
```

States are `SubscriptionStatus` values, plus `TRIAL_EXPIRED`, which is not stored: it is `TRIALING` with `trialEndsAt` in the past, computed by `getEffectivePlan`. Only `ACTIVE` and an unexpired `TRIALING` count as active; every other state blocks creation with 402 while leaving reads untouched.

## Data model

```mermaid
erDiagram
  Company ||--o| Subscription : "has"
  Company ||--o{ AuditLog : "records"
  Company {
    string id PK
    string name
    datetime createdAt
  }
  Subscription {
    string id PK
    string companyId FK
    string stripeCustomerId
    string stripeSubscriptionId
    enum plan
    enum status
    datetime trialEndsAt
    datetime currentPeriodEnd
  }
  AuditLog {
    string id PK
    string companyId FK
    enum action
    json metadata
  }
```

Each company has at most one `Subscription` (unique `companyId`), and the Stripe ids are unique so webhook events can find the row. The trial end is dated from `Company.createdAt`. Billing events are recorded in `AuditLog`.

## Design decisions

- **Prices in Stripe, limits in code.** Price ids come from env vars so pricing changes need no deploy; limits are one typed table so they are not scattered literals.
- **Hosted Checkout and Portal only**, so Aura never handles card data.
- **Signature before anything.** The webhook reads the raw body and verifies it before parsing or touching the database; handler logic is a separate function so it is unit-tested with mocked events.
- **Graceful lapse.** An ended trial or subscription makes the workspace read-only for creation (402 with an upgrade message) but never hides data.
- **Implicit trial.** A company with no `Subscription` row is an active trial, so new workspaces are never blocked by a missing row.
- **Image generation is a spend control.** The monthly graphics limit exists because each image is a paid provider call.
- **Owner-only billing.** `company:manageBilling` is held only by `OWNER`.
