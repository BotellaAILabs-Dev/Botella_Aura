# Data Access Security: Business Context & Opportunities

How Business Context, signals, opportunities and recommendations are isolated
between users, businesses and workspaces; how that was reviewed; and how it is
tested.

| Piece | Where |
| --- | --- |
| Static guards (run with the unit tests) | [`tests/data-access-security.test.ts`](../tests/data-access-security.test.ts) |
| End-to-end check against a running app | [`scripts/verify-access.ts`](../scripts/verify-access.ts): `AURA_URL=http://localhost:3000 pnpm verify:access` |
| Safe third-party links | [`lib/safe-url.ts`](../lib/safe-url.ts) |

---

## 1. RLS review

**Postgres row-level security (RLS) is not used, and isn't required for
isolation today.**
- The app reaches the database only through Prisma, as a single database role
  that owns the tables.
- No client (browser, extension, third party) ever connects to the database
  directly.
- Every read and write goes through a server route or server component, and
  isolation is enforced there (section 2).

**Adding RLS as defence in depth** is possible, but it is a separate,
cross-cutting change:
- **A non-owner role:** the app would need a database role that doesn't own
  the tables. Owners bypass RLS unless it is forced.
- **Per-transaction workspace:** every query would have to run inside a
  transaction that first sets the workspace (`SET LOCAL app.company_id`).
  Session variables don't survive the pooled (PgBouncer transaction-mode)
  connections used in production.
- **Bypass paths:** cron jobs, webhooks and migrations would need a separate
  role that bypasses RLS.

If policy requires RLS, it should be its own ticket. The tests below would
stay valid as the application-level layer.

## 2. How isolation works

1. **Who you are:** the NextAuth session. API routes return **401** without
   one, and pages redirect to the login page.
2. **Which workspace:** `requireActiveCompany()` picks the active workspace
   **only from the user's own memberships**. The workspace-switcher cookie is
   a preference, not a credential: a cookie naming a business the user doesn't
   belong to is ignored, and their own workspace is used instead.
   `requireCompanyRole(id, roles)` checks membership of an explicit workspace
   id.
3. **What you may do:** every write checks the role (`can(role, …)`).
   - **Viewers** can read their workspace but change nothing.
   - **Owners and admins** can change business context and opportunities.
   - **Members** can create content, including running the advisor.
4. **Which rows:** every query is scoped to the resolved workspace
   (`companyId`).
   - Records looked up by an id from the URL also match `companyId`, so another
     business's opportunity or recommendation id behaves exactly like a
     non-existent one: **404, with no detail**.
   - Writes then target the row that was verified, using compare-and-swap.

## 3. Route review

| Route | Workspace | Role for writes | Lookups by id |
| --- | --- | --- | --- |
| `GET/PATCH /api/business-context` | own (active) | `company:update` | n/a |
| `GET/POST /api/business-context/questions` | own | `company:update` | by (workspace, question key) |
| `GET/POST /api/business-context/snapshot` | own | `company:update` | n/a |
| `PATCH /api/company/{audience,brand,formats}`, `POST …/logo` | own | `company:update` | n/a |
| `PATCH /api/company/autopilot` | own | `content:approve` | n/a |
| `PATCH /api/companies/:id` | explicit id, membership checked | OWNER / ADMIN | n/a |
| `GET /api/opportunities`, `GET /api/signals`, `GET /api/advisor` | own | — | n/a |
| `GET /api/opportunities/:id`, `…/handoff` | own | — | id **and** workspace |
| `POST /api/opportunities/:id/status` | own | `company:update` | id **and** workspace |
| `GET/POST /api/opportunities/:id/recommendations` | own | `company:update` | id **and** workspace |
| `POST /api/recommendations/:id/decision`, `POST …/:id/status` | own | `company:update` | id **and** workspace |
| `GET /api/recommendations`, `GET /api/recommendations/:id` | own | — | id **and** workspace |
| `POST /api/opportunities/detect`, `POST /api/signals/refresh` | own | `company:update` | n/a |
| `POST /api/advisor` | own | `content:create` | n/a |
| Pages: Opportunities, About my business, Campaign ideas | own (active) | actions as above | n/a |

**Background detection is scoped too.** Rule detection, AI detection, the
advisor and signal collection only read and write the workspace they were run
for. Cross-detector merging searches only within that workspace.

## 4. Sensitive information

- **Business Context** carries no credentials. Connected accounts appear only
  as connector ids and sync times; tokens are never selected.
- **API responses** for context, opportunities, signals and recommendations
  contain no password hashes, tokens or API keys, and no member email
  addresses. People appear only as internal user ids (who decided), within
  their own workspace.
- **Viewers** can read their workspace's business context and opportunities.
  That is by design for a read-only member.
- **AI providers** receive the business context snapshot and signals as part of
  AI prompts (advisor, AI detection, content). That is inherent to the
  features. The snapshot contains only what the business told Aura or what
  Aura collected about its market.

## 5. Findings

| # | Finding | Status |
| --- | --- | --- |
| 1 | **Links from third-party feeds could carry script.** Trend stories, competitor news and advisor evidence were rendered straight into links. React 18 only warns about `javascript:` URLs, it doesn't block them, so a hostile feed item could run script in Aura when clicked. | **Fixed:** these links go through `safeExternalUrl`, and anything that isn't http(s) isn't rendered as a link. |
| 2 | Opportunity evidence accepted any URL scheme (Zod's `.url()` accepts `javascript:`). | **Fixed:** evidence URLs must be http(s). Every detector already passed only web links, so nothing valid is rejected. |
| 3 | When creating a recommendation, the "already has an open one?" lookup was not scoped to the workspace. Not exploitable, because the opportunity was verified a few lines earlier, but caught by the new static guard. | **Fixed:** scoped. |
| 4 | The same raw-link pattern exists outside this area: lead source URLs, LinkedIn profile URLs, engagement target posts, and competitor website links entered by the business. | **Follow-up:** apply `safeExternalUrl` there too (leads, outreach and engagement pages). |
| 5 | No database-level RLS. | **Reviewed** (section 1): isolation is enforced in the application and tested. RLS is a separate ticket if policy requires it. |

## 6. Tests

**`tests/data-access-security.test.ts`** runs with every test run:
- Every business-context, opportunity, recommendation, signal, advisor and
  company-profile API route resolves the caller's own workspace, and never
  takes a workspace id from the request body or parameters.
- Every write route checks the caller's role. This automatically covers routes
  added later in these folders.
- Every opportunity and recommendation lookup by id is also scoped by
  `companyId`.
- Only http(s) links pass `safeExternalUrl` (it rejects `javascript:`,
  `data:`, `vbscript:`, `file:` and protocol-relative links), and evidence
  can't store a non-web link.

**`tests/safe-links-render.test.tsx`** renders a trend story twice: a real
link keeps its href, and a `javascript:` link from a feed is shown with no
link at all.

**`pnpm verify:access`** runs end to end over HTTP against a running app. It
creates two throwaway businesses with real users (A: owner and viewer; B:
owner), signs them in, and checks:
- **Users can't access another business's context.** Owner A sees only A's
  context, snapshot and questions, even with a forged workspace cookie naming
  B. Editing B's profile is refused (403) and B is unchanged.
- **Opportunities are isolated.**
  - A's lists (opportunities, signals, advisor) contain nothing of B.
  - Opening, handing off, changing status, recommending, or deciding on B's
    opportunity or recommendation gives 404 with no detail, and B's data is
    unchanged.
  - The Opportunities and About my business pages show nothing of B, even with
    the forged cookie.
- **APIs enforce user permissions.** Viewer A can read, but every write (8
  routes) is refused with 403, and nothing changes.
- **Not signed in:** every route returns 401.
- **Sensitive information:** no credentials, password hashes or member emails
  in any response.
- Everything it creates is deleted afterwards.
