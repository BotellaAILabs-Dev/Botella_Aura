# Billing, Plans & Entitlements

> Gives every workspace a 14-day trial, lets the workspace owner buy a Starter, Growth or Agency plan through Stripe's hosted Checkout, manage payment in Stripe's Customer Portal, and keeps a local mirror of the subscription through signature-verified webhooks. A single limits table decides what each plan may create (campaigns, discovery runs, connected LinkedIn accounts, generated graphics). When a trial or subscription ends, creating is blocked with a 402 but all data stays readable, so lapsed billing never locks a business out of its own work.

## 1. Overview

- **Plans** (enum `Plan`): `TRIAL`, `STARTER`, `GROWTH`, `AGENCY`.
- **Prices live in Stripe**, referenced by env price ids (`STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY`). Changing a price is a Stripe change, not a deploy.
- **Hosted flows only**: Stripe Checkout (`mode: 'subscription'`) and the Customer Portal. No card forms in Aura.
- **Stripe is the source of truth**; `Subscription` is a mirror updated by `POST /api/webhooks/stripe` after `constructEvent` verifies the signature.
- **Entitlements** (`server/billing/entitlements.ts`) are the one place plan limits are defined and checked; creation routes call `requireEntitlement(companyId, feature)`.
- Billing boots without Stripe configured: the Stripe client is a lazy singleton and the billing page explains that checkout is disabled.

## 2. User-facing behaviour

| Route | File | What the user sees / can do | Roles |
| --- | --- | --- | --- |
| `/dashboard/settings/billing` | `app/dashboard/settings/billing/page.tsx` + `components/dashboard/billing/billing-panel.tsx` | "Current plan" card: plan badge (green when active, red when not), Stripe status, "N days left in trial"; an "ended" warning ("Your data is safe and read-only — upgrade to keep creating"); **Manage billing** (portal) when a Stripe customer exists. A "Billing isn't configured" note when `STRIPE_SECRET_KEY` is missing. Three plan cards (Starter, Growth, Agency) listing the limits; a "Choose <plan>" button on non-current plans (disabled and labelled "Not configured" when that plan has no Stripe price id). | Page visible to any member; Manage billing and checkout buttons only when `company:manageBilling` (OWNER) |
| Stripe Checkout | external | Pay for a plan; returns to `/dashboard/settings/billing?checkout=success` or `?checkout=cancelled` | OWNER |
| Stripe Customer Portal | external | Change card, plan, cancel; returns to `/dashboard/settings/billing` | OWNER |
| `/` (marketing home) | `app/page.tsx` | Pricing preview built from `PLAN_LIMITS` labels and limits (Growth featured) | Public (signed-in users are redirected to `/dashboard`) |
| Any creation flow | various | A 402 with an upgrade message when the plan limit is reached or access has lapsed | Members who can create |

Plan card features are generated from `PLAN_LIMITS`: "N active campaign(s)", "N discovery runs / month", "N connected account(s)", "N generated graphics / month", and "All AI features + Chrome extension".

## 3. How it works

### Trial
- `ensureSubscription(companyId)` creates a `Subscription` lazily (called when the billing page loads and before checkout): `plan: TRIAL`, `status: TRIALING`, `trialEndsAt = company.createdAt + 14 days`, and writes `TRIAL_STARTED`.
- With no `Subscription` row at all, `getEffectivePlan` treats the company as an **active trial** with TRIAL limits and no end date, so new companies are never blocked.

### Effective plan (`getEffectivePlan`)
- `trialExpired` = status `TRIALING` and `trialEndsAt` in the past.
- `active` = status `ACTIVE` or `TRIALING`, and not `trialExpired`. `PAST_DUE`, `CANCELED` and `INCOMPLETE` are inactive.
- Returns `{ plan, active, limits: PLAN_LIMITS[plan], trialEndsAt, status }`.

### Entitlement checks (`requireEntitlement`)
1. If not active: `EntitlementError` (status **402**, `upgrade: true`) "Your trial or subscription has ended. Upgrade to keep creating — your data is safe and stays read-only until then."
2. Per feature:

| Feature | Counted | Limit |
| --- | --- | --- |
| `campaigns` | `Campaign` rows with status `ACTIVE`, `PAUSED` or `DRAFT` | `maxActiveCampaigns` |
| `discovery` | `DiscoveryRun` rows with `startedAt` since the 1st of the current UTC month | `maxDiscoveryRunsPerMonth` |
| `imageGeneration` | `assetsThisMonth(companyId)` from `server/media/asset.service` (creatives and logo versions excluded) | `maxImagesPerMonth` |
| `linkedinAccounts` | `LinkedInConnection` rows with status `ACTIVE` | `maxLinkedInAccounts` |

Reads are never gated.

Call sites: `app/api/campaigns/orchestrate/route.ts` (campaigns), `app/api/leads/discovery/profiles/[id]/run/route.ts` (discovery), and for image generation `app/api/generate-image/route.ts`, `app/api/content/drafts/[id]/graphics/route.ts`, `app/api/content/drafts/[id]/creative/route.ts`, `app/api/content/graphics/[assetId]/_variant.ts` and the WhatsApp content tool (`server/whatsapp/tools/content.ts`). The graphics routes also cap variations per click at `maxImagesPerRequest`.

### Checkout (`createCheckoutSession`)
1. Route checks `can(role, 'company:manageBilling')` (403 "Only an owner can manage billing.") and parses `{ plan: 'STARTER' | 'GROWTH' | 'AGENCY' }`.
2. No configured price for the plan: `BillingConfigError` (503).
3. `ensureSubscription`, then `stripe.checkout.sessions.create` with one line item, success/cancel URLs on `getAppUrl()`, the existing `customer` if known (else `customer_email`), `client_reference_id = companyId`, `metadata: { companyId, plan }`, `subscription_data.metadata.companyId`, `allow_promotion_codes: true`.
4. Writes `CHECKOUT_STARTED` (plan, session id) and returns `{ url }`; the panel redirects the browser.

### Portal (`createPortalSession`)
- Requires a stored `stripeCustomerId` (else 503 "No Stripe customer yet — start a plan first."), returns a portal session URL with `return_url` to the billing page.

### Webhook (`POST /api/webhooks/stripe` -> `handleStripeEvent`)
1. `STRIPE_WEBHOOK_SECRET` missing: 503. `stripe-signature` header missing: 400. Signature invalid: 400. The raw body (`req.text()`) is verified before anything else.
2. Events handled:

| Event | Effect | Audit |
| --- | --- | --- |
| `checkout.session.completed` | Needs `metadata.companyId` (else ignored). Upserts `Subscription`: `plan` from `metadata.plan` (default `STARTER`), `status: ACTIVE`, `stripeCustomerId`, `stripeSubscriptionId` | `SUBSCRIPTION_CREATED` |
| `customer.subscription.updated` | Finds by subscription id or customer id; sets `plan = planFromPriceId(first item price)`, mapped `status`, `currentPeriodEnd` | `SUBSCRIPTION_UPDATED` |
| `customer.subscription.deleted` | Finds by subscription id; `status: CANCELED`, `plan: TRIAL` | `SUBSCRIPTION_CANCELED` |
| `invoice.payment_failed` | Finds by customer id; `status: PAST_DUE` | `PAYMENT_FAILED` |
| anything else | Logged and ignored | — |

3. A handler exception returns 500 so Stripe retries; success returns `{ received: true }`.

Stripe status mapping (`mapStripeStatus`): `trialing` -> `TRIALING`; `active` -> `ACTIVE`; `past_due`, `unpaid` -> `PAST_DUE`; `canceled`, `incomplete_expired` -> `CANCELED`; anything else -> `INCOMPLETE`.

`planFromPriceId`: null -> `TRIAL`; a price id matching one of the three env vars -> that plan; an unknown price id -> `STARTER`.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/settings/billing/page.tsx` | Ensures a trial, reads effective plan, builds plan cards, passes `canManage` |
| Page | `app/page.tsx` | Public pricing preview from `PLAN_LIMITS` |
| Component | `components/dashboard/billing/billing-panel.tsx` | Current plan, trial days, warnings, plan cards, checkout and portal buttons |
| API | `app/api/billing/checkout/route.ts` | Start a hosted Checkout session |
| API | `app/api/billing/portal/route.ts` | Open the Customer Portal |
| API | `app/api/webhooks/stripe/route.ts` | Signature-verified webhook receiver |
| Lib | `lib/stripe.ts` | `isStripeConfigured`, lazy `getStripe`, `priceIdForPlan`, `planFromPriceId`, `availablePlans` |
| Service | `server/billing/checkout.service.ts` | `createCheckoutSession`, `createPortalSession`, `BillingConfigError` |
| Service | `server/billing/subscription.service.ts` | `ensureSubscription`, `getSubscription`, `handleStripeEvent` |
| Service | `server/billing/entitlements.ts` | `PLAN_LIMITS`, `getEffectivePlan`, `requireEntitlement`, `EntitlementError` |
| Tests | `tests/billing.test.ts`, `tests/tenant-isolation.test.ts` | See section 10 |

## 5. Data model

| Model / enum | Key fields | Notes |
| --- | --- | --- |
| `Subscription` | `id`, `companyId` (unique), `stripeCustomerId?` (unique), `stripeSubscriptionId?` (unique), `plan: Plan` (default `TRIAL`), `status: SubscriptionStatus` (default `TRIALING`), `trialEndsAt?`, `currentPeriodEnd?` | One per company; cascade on company delete; index on `stripeCustomerId` |
| `Plan` | `TRIAL`, `STARTER`, `GROWTH`, `AGENCY` | |
| `SubscriptionStatus` | `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELED`, `INCOMPLETE` | |
| `AuditLog` actions | `CHECKOUT_STARTED`, `TRIAL_STARTED`, `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_UPDATED`, `SUBSCRIPTION_CANCELED`, `PAYMENT_FAILED` | |

Read for limits: `Campaign`, `DiscoveryRun`, `LinkedInConnection`, `GeneratedAsset` (via `assetsThisMonth`).

## 6. API endpoints

Full catalogue: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| POST | `/api/billing/checkout` | Body `{ plan }`; returns `{ url }` for Stripe Checkout | Active-company member with `company:manageBilling` (OWNER) |
| POST | `/api/billing/portal` | Returns `{ url }` for the Customer Portal | `company:manageBilling` (OWNER) |
| POST | `/api/webhooks/stripe` | Stripe events | No session; Stripe signature verified with `STRIPE_WEBHOOK_SECRET` |

Errors: 402 from `EntitlementError` in creation routes; 503 when Stripe or a price is not configured.

## 7. External services

| Service | Used for | Env vars |
| --- | --- | --- |
| Stripe API (`stripe` Node SDK) | Checkout sessions, Customer Portal sessions, webhook signature verification | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY` |
| App base URL | Checkout success/cancel and portal return URLs | `APP_URL` / `NEXTAUTH_URL` / Vercel URL via `getAppUrl()` |

The webhook endpoint to register in Stripe is `<base>/api/webhooks/stripe`. See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

Not applicable. State changes arrive by Stripe webhook; trial expiry is computed at read time from `trialEndsAt`.

## 9. Security & permissions

- Only `OWNER` holds `company:manageBilling`; checkout and portal routes check it, and the panel hides the buttons for others.
- Workspace scoping: both billing routes act on the caller's active company (`requireActiveCompany`); the subscription is keyed by `companyId`.
- The webhook is intentionally unauthenticated and trusts nothing until `stripe.webhooks.constructEvent` verifies the signature against the raw body.
- Checkout attaches `companyId` in session and subscription metadata so the webhook can attribute the subscription without trusting the browser.
- Entitlements fail closed for creation (402) and open for reads, so no data lockout.

## 10. Testing

| File | Covers |
| --- | --- |
| `tests/billing.test.ts` | Webhook handler: activate on `checkout.session.completed`, ignore missing `companyId`, `PAST_DUE` on `invoice.payment_failed`, cancel + downgrade on `customer.subscription.deleted`, ignore unknown events. Entitlements: no-subscription active trial, expired trial inactive, creation blocked when ended, campaign limit, monthly discovery limit. |
| `tests/tenant-isolation.test.ts` | "billing: each company only sees its own subscription" |

There is no `pnpm verify:*` script dedicated to billing.

## 11. Configuration & limits

| Plan | Active campaigns | Discovery runs / month | LinkedIn accounts | Graphics / month | Graphics per request |
| --- | --- | --- | --- | --- | --- |
| `TRIAL` | 1 | 10 | 1 | 20 | 2 |
| `STARTER` | 2 | 25 | 1 | 100 | 2 |
| `GROWTH` | 10 | 150 | 3 | 500 | 4 |
| `AGENCY` | 100 | 2000 | 25 | 4000 | 4 |

| Setting | Value | Source |
| --- | --- | --- |
| Trial length | 14 days from company creation | `server/billing/subscription.service.ts` |
| Discovery month boundary | 1st of the month, 00:00 UTC | `server/billing/entitlements.ts` |
| Promotion codes | allowed in Checkout | `checkout.service.ts` |

## 12. Known limitations & future work

- `checkout.session.completed` stores `metadata.plan` as sent by Aura's own checkout rather than re-deriving it from the Stripe price; later `customer.subscription.updated` events correct it from the price id.
- An unknown Stripe price id maps to `STARTER`.
- `customer.subscription.deleted` sets `plan: TRIAL` with status `CANCELED`, so the workspace becomes inactive (read-only) rather than returning to a usable trial.
- `ensureSubscription` is only called from the billing page and checkout. A workspace whose owner never opens the billing page has no `Subscription` row and is treated as an active trial with no end date.
- `linkedinAccounts` counts the legacy `LinkedInConnection` table only.
- No in-app invoices or usage history; those live in the Stripe portal.

## 13. Related documents

- [SPRINT-6-TECHNICAL.md](../../../SPRINT-6-TECHNICAL.md) — billing design (Module 3)
- [DEPLOYMENT-ENV.md](../../../DEPLOYMENT-ENV.md), [VERCEL-DEPLOYMENT.md](../../../VERCEL-DEPLOYMENT.md)
- [GRAPHIC-GENERATION-TECHNICAL.md](../../../GRAPHIC-GENERATION-TECHNICAL.md) — image quota usage
- [02-workspaces-team-and-roles](../02-workspaces-team-and-roles/01-FEATURE-DETAILS.md) — `company:manageBilling` and the role matrix
- [25-navigation-and-design-system](../25-navigation-and-design-system/01-FEATURE-DETAILS.md) — public home page pricing preview
