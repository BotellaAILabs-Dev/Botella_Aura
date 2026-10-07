# Recommendations → Aura Modules

Recommendations know which of Aura's existing modules carries them out, take
their context there, and hand each module typed data. The full execution
workflow (Sprint 10) can consume this without any change to how
recommendations are made.

| Piece | Where |
| --- | --- |
| Module capabilities, routing, hand-offs (pure) | [`lib/aura-modules.ts`](../lib/aura-modules.ts) |
| A recommendation's context across modules (pure) | [`lib/recommendation-context.ts`](../lib/recommendation-context.ts) |
| Context, hand-off, linking (server) | [`server/recommendations/context.service.ts`](../server/recommendations/context.service.ts) |
| Context API | `GET /api/recommendations/:id/context` |
| Context bar (every module page) | [`components/dashboard/recommendations/recommendation-context-bar.tsx`](../components/dashboard/recommendations/recommendation-context-bar.tsx), in the dashboard shell |
| Tests | [`tests/aura-modules.test.ts`](../tests/aura-modules.test.ts); `pnpm verify:modules` (the real engine's output) |

---

## 1. Module capability metadata — `AURA_MODULES`

Each module records:
- its label and description, in user terms
- its home route, and its **entry route** (where a recommendation lands: the
  creation form when there is one)
- its **capabilities**
- the context it **accepts**
- how far the **hand-off** goes today
- what it **creates**

| Module | Entry | Hand-off today | Accepts |
| --- | --- | --- | --- |
| **Content Studio** | `/dashboard/content/new` | **Prefill**: brief, format; the draft remembers the suggestion | brief, channel, format, audience |
| **Campaigns** | `/dashboard/campaigns/new` | **Prefill**: name, goal, audience, themes; the campaign is linked | goal, audience, themes |
| **Outreach** | `/dashboard/outreach` | Context | audience, angle |
| **Results** (Analytics) | `/dashboard/analytics` | Context | metric |
| **What works for you** (Marketing Memory) | `/dashboard/memory` | Context | pattern |
| **Competitors** | `/dashboard/competitors` | Context | competitor |
| **Lead discovery** | `/dashboard/leads/discover` | Context | audience |
| Content plan | `/dashboard/planner` | Context | brief, themes |
| Connections | `/dashboard/connectors` | Context | channel |
| About my business | `/dashboard/business` | Context | audience, goal |

"Prefill" means the module's creation form opens filled in from the
recommendation, and what it creates is linked to it. "Context" means the
module opens with the recommendation in view (the context bar), and the
person carries it out there. The tests check that every route is a real
page.

## 2. Which module carries a recommendation out

By the **action the engine chose** (`details.action`), falling back to the
recommendation's **type**:

| Engine action | Module | Button | Related |
| --- | --- | --- | --- |
| post | Content Studio | Create content | — |
| article | Content Studio | Write the article | — |
| series | Campaigns | Plan the series | Content Studio |
| response-post | Content Studio | Create content | Competitors |
| comparison-article | Content Studio | Write the comparison | Competitors |
| targeted-post | Content Studio | Create content | Lead discovery, Outreach |
| recovery-post | Content Studio | Create content | Results, What works for you |
| apply-pattern | Content plan | Add to your plan | What works for you, Campaigns |
| update-audience | About my business | Add the audience | Lead discovery |
| connect-channel | Connections | Connect *channel* | — |
| plan-it | Content plan | Add to your plan | — |

| Type (fallback) | Module | Related |
| --- | --- | --- |
| Content | Content Studio | — |
| Campaign | Campaigns | Content Studio |
| Competitive response | Content Studio | Competitors |
| Audience | Content Studio | Lead discovery, Outreach |
| Channel | Connections | — |
| Optimization | Content plan | Results, What works for you |
| Other | Content plan | — |

The tests check that every action the engine can choose has a route, and
that every module the ticket names is a destination of some recommendation.
This replaces the earlier type-only routing: a post meant to win back a drop
now goes to Content Studio, not the planner.

The execution brief carries the result as `module`, `verb` (the button)
and `related`. Aura Suggests uses it: the main button is named for the
module, and "Also useful:" lists the related modules.

## 3. Passing the recommendation — `?rec=<id>`

Every destination link carries `?rec=<id>`. Content Studio also gets
`&brief=…&type=…`. When the recommendation is blocked, its link to the
opportunity review carries it too.

## 4. Keeping the context between modules

- **Context bar.** Any module page opened with `?rec=` shows the
  recommendation: what it is, its goal, and what to do in this module ("Look
  at what Acme Coffee changed before you respond"). It links to the main
  module, the related modules, and back to the suggestion.
- **It follows the person.** The context is remembered for the browser tab
  (12 hours), so moving on to Competitors or Lead discovery, with or
  without `?rec=`, keeps it in view until they dismiss it or open another
  recommendation. It is hidden on Home and on Aura Suggests, where the
  suggestion is already in front of them.
- **When it is already answered.** If the recommendation is skipped,
  rejected, expired or finished, the bar says so, with nothing left to do.
- **Scoped to the workspace.** The context API is scoped to the workspace.
  An id from another workspace returns 404 and the bar forgets it.
  Signed-out requests get 401.
- **Linked both ways.** When a module makes something from it, both sides
  record the link:
  - **Content Studio:** the draft stores `aiMetadata.recommendation` and its
    page shows "Written for: *suggestion*" with a link back.
  - **Campaigns:** the campaign is created from the prefilled form.
  - **The recommendation:** gets a `link` history entry with the module and
    what was made. Recent activity on Home reads "Dana started on “…” in
    Content Studio".
  - **Status:** the recommendation's status does not change; carrying it
    out is the execution sprint's job.
  - **Ids:** a recommendation id sent by a client is only used if it
    belongs to the workspace (`ownRecommendation`).

## 5. Ready for creation and execution workflows

`moduleHandoff(module, recommendation)` returns typed data for every module
(`ModuleHandoffs`):

| Module | Receives |
| --- | --- |
| Content Studio | `brief` (title, action, steps, angle, audience, why, goal), `contentType`, `channel`, `audience` |
| Campaigns | `name`, `goal`, `targetAudience`, `themes` |
| Outreach | `audience`, `angle` |
| Results | `metric` |
| What works for you | `pattern` |
| Competitors | `competitor` |
| Lead discovery | `audience` |
| Content plan | `brief`, `themes` |
| Connections | `channel` |
| About my business | `audience` |

Only recorded values are passed; anything not recorded is `null`, never
guessed. The engine now records `competitor`, `metric` and `topic` on the
recommendation so these have real values.
`getRecommendationHandoff(companyId, id, module)` is the server entry point
a workflow calls.

## Acceptance criteria

| Criterion | How |
| --- | --- |
| Recommendation can identify the appropriate Aura workflow | Routing by engine action, then type, to a module, a button and related modules. Every engine action and type is covered (tests), and verified on the real engine's output (`verify:modules`) |
| User does not lose recommendation context when moving into another module | `?rec=` on every destination. The context bar shows it on every module page and remembers it across modules. Drafts and the recommendation's history link both ways |
| Recommendation can later be converted into a creation/execution workflow | Typed hand-off per module (`moduleHandoff`, `getRecommendationHandoff`), already used by the Content Studio and Campaigns prefill. The `link` history action records what each module made |
