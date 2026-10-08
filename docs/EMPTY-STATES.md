# Empty & Insufficient-Data States

What Aura does when it doesn't have enough information to recommend
anything: it says so plainly, gives one next step for each gap, and **never
fills the page with a generic suggestion**.

| Piece | Where |
| --- | --- |
| Scenarios, severity, messages, next steps (pure) | [`lib/data-readiness.ts`](../lib/data-readiness.ts) |
| Loading | [`server/recommendations/readiness.service.ts`](../server/recommendations/readiness.service.ts) |
| Fallback UI | [`components/dashboard/suggestions/readiness-panel.tsx`](../components/dashboard/suggestions/readiness-panel.tsx), on Aura Suggests and Home |
| API | `GET /api/recommendations/readiness` → `{ readiness }` |
| Business Context link | `/dashboard/business?ask=<field>#aura-questions` opens Aura's questions on that field first |
| Tests | [`tests/data-readiness.test.ts`](../tests/data-readiness.test.ts); `pnpm verify:readiness` (a workspace walked from bare to ready) |

---

## The scenarios

Each scenario is either **blocking** (no recommendation is made or shown) or
**limiting** (Aura recommends, and says what it's missing).

| Scenario | Severity | What Aura says | Next step |
| --- | --- | --- | --- |
| **Insufficient business context:** doesn't know what the business does | blocking | "Without knowing what you do or sell, anything Aura suggested would be generic — so it suggests nothing." | Describe your business → Business Context question |
| Insufficient business context: no audience / no goals | limiting | Suggests for customers in general, or can't tell which opportunities matter most | Describe your audience / Add your goals → Business Context question |
| **No channels** (none said) | blocking | "Aura won't guess your channels" | Add where you publish → Business Context question |
| **Insufficient signals:** nothing watched | blocking | Nothing to base a suggestion on | Choose topics to follow |
| Insufficient signals: watched, nothing seen | blocking | No current signals; it may not have checked recently | **Check for new opportunities** (button) |
| **No opportunities detected** | blocking | "It would rather say so than suggest something generic." | **Check for new opportunities** (button) |
| **Low-confidence opportunity** (all of them) | limiting | Only early signs; anything suggested is marked "needs your review" | Look at the opportunities |
| **No connected channel** | limiting | Can suggest posts, but not publish or measure them | Connect a channel |
| **No historical performance data** | limiting | Can't tell what works until something is published and measured, "so it won't claim to know" | See results |

Blocking items come first, in the order to fix them; the first one is the
**primary** next step.

## The fallback experience

| Situation | Aura Suggests | Home |
| --- | --- | --- |
| Anything blocks | "What Aura needs before it can suggest anything": every gap in order, each with its button | The first thing to fix, in one line, with its link |
| Can recommend; opportunities waiting | "No suggestions yet", **Get Aura's suggestions**, and what still limits it | — |
| Suggestions shown, something limiting | One line above the list on what would make them better | — |
| Ready | Nothing extra | — |

## No generic recommendations

- **The automatic pass writes nothing** when Aura doesn't know what the
  business does or where it publishes, and says why ("Aura didn't write
  anything: …"). That runs after detection and from "Get Aura's suggestions".
- **The engine's guardrails** refuse opportunities without enough evidence
  ([RECOMMENDATION-RULES.md](RECOMMENDATION-RULES.md)).
- **The quality check** holds back anything unsupported before it is shown
  ([RECOMMENDATION-QUALITY.md](RECOMMENDATION-QUALITY.md)).
- **An empty list stays empty,** with the reason, rather than being padded.

## Linking to the Business Context workflow

Missing business information doesn't send people to a generic settings
page: it links to Aura's own question for that field
(`/dashboard/business?ask=channels.preferred#aura-questions`). The About my
business page asks that question first and scrolls to it. Answering it
updates the Business Context straight away, and the gap closes.

## Acceptance criteria

| Criterion | How |
| --- | --- |
| Aura clearly communicates when it doesn't have enough information | Each of the six scenarios is named and explained in plain words, blocking ones first |
| User receives a useful next step where possible | Every gap has one next step: the exact Business Context question, the page that fixes it, or a button that runs the check now |
| No unsupported recommendation is presented merely to populate the UI | The automatic pass writes nothing when the business is unknown or has no channels. Empty lists stay empty with the reason. The engine's guardrails and the quality check stop the rest. Proven at every step of `verify:readiness` |
