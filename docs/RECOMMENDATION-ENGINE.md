# Recommendation Generation Engine

Turns a validated opportunity into a structured, actionable recommendation
([RECOMMENDATION-MODEL.md](RECOMMENDATION-MODEL.md)) that fits the business as
it is **now**, and is backed by the data. Anything the data doesn't support is
rejected or flagged.

| Piece | Where |
| --- | --- |
| Actions, selection, writing, assessment, validation, support gate (pure) | [`lib/recommendation-engine.ts`](../lib/recommendation-engine.ts) |
| The engine: inputs, model call, storing, audit | [`server/recommendations/engine.service.ts`](../server/recommendations/engine.service.ts) |
| Trigger | `POST /api/opportunities/:id/recommendations` (the **Recommend** button on the Opportunities page) |
| Tests | [`tests/recommendation-engine.test.ts`](../tests/recommendation-engine.test.ts); `pnpm verify:engine` against a real database |

---

## Inputs

| Input | Used for |
| --- | --- |
| **The opportunity's hand-off** (Sprint 7) | What it is, its reasoning and angle, its evidence (marked current or not), its confidence, priority, impact and relevance window |
| **The current Business Context Snapshot** (`recommendation` view) | Where the business publishes and what is connected, its confirmed audience (or an assumed one), its goal and campaign themes, and the content formats it learned work. It is read at generation time, not detection time. |
| **Relevant signals** | The opportunity's own signals (e.g. a results drop with its before and after numbers, the competitor's name), plus the business's current learned patterns, which can be fresher than the snapshot |

## 1. Possible actions

Each opportunity type has a catalogue of actions. Each action states what it
needs:

| Opportunity | Possible actions |
| --- | --- |
| Trending topic, seasonal moment | One post · a short series (needs at least 7 days left and medium or high impact) |
| Content gap | An in-depth article (needs a Blog or Newsletter the business uses) · one post · a short series |
| Competitor move | A response post · a comparison article (needs a Blog or Newsletter) |
| Competitive gap | A series on the theme · a response post |
| Audience segment | A post for that audience (needs a known audience) · add the audience to the profile |
| Channel | Connect the channel (it must be one the business uses and hasn't connected) |
| What is working | A recovery post (needs a drop in results among the evidence) · build the pattern into next month's plan (needs a learned pattern or a rise) |

Actions needing a channel use only channels the business says it publishes on.

## 2. Selecting the action

Every action is checked against the snapshot and the signals.
- **Unsupported actions** are set aside, with the reason. For example: "the
  business has not said where it publishes", "only 4 day(s) left — not enough
  for a short series", or "no drop in results among the evidence".
- **Supported actions** are scored on how well they fit, with each point
  explained:
  - a connected channel, so the result can be published and measured (+)
  - a format the business learned works, on a channel that carries it (+)
  - relating to the business's current goal or campaign (+)
  - low effort (+); high effort (−)
  - closing within a week favours quick actions
  - a high-impact opening favours a series

The best fit is chosen. The others are stored on the recommendation as ranked
**alternatives**, with their reasons.

## 3. Writing it

**Templates** produce a complete recommendation in which every statement
comes from the opportunity, its evidence or the business's context:
- **Action:** one clear sentence (e.g. "Publish a carousel on LinkedIn about
  this, this week.")
- **Steps:** the opportunity's content ideas, or the action's own steps
- **Why:** the opportunity's reasoning, the evidence it rests on, and why this
  action fits
- **Expected outcome:** e.g. "Total engagement recovers toward 500 (it went
  from 500 to 300)."

**A model**, when one is configured, rewrites the words of that draft.
- **Fixed:** the type, channel, format and audience are the engine's choice,
  and the model can't change them.
- **Validation:** its output is rejected if it cites evidence it wasn't given
  (or none), relies on a business fact the context doesn't have, declares an
  assumption, or states a figure none of its sources contain.
- **Fallback:** a rejected model version is replaced by the template, and the
  recommendation is flagged with why.

## 4. Assessment

- **Confidence** starts at the opportunity's. It is capped at medium when the
  recommendation rests on anything unconfirmed (an assumed audience, shaky
  business information, a context change since detection). The reason is
  stored.
- **Priority** comes from the opportunity's impact, **the chosen action's
  effort**, the confidence, and the time left. So a quick action on a closing
  opening rises, and a low-confidence one is never high priority. The reason
  is stored (e.g. "high impact, low effort (one post), high confidence, 12
  day(s) left").

## 5. The support gate

The last check, applied to every recommendation however it was written,
including a person's edits:

| | Condition |
| --- | --- |
| **Rejected** (nothing stored) | No current evidence · content with nowhere to publish · an audience post with no audience · no action this business can take at all |
| **Flagged** (stored, flag shown, confidence capped) | A channel the business doesn't use (e.g. a person's edit) · figures no source contains · business information it relies on that is unconfirmed or out of date · business context changed since the opportunity was detected · an audience Aura only assumed · the model's version not used |

Flags and everything the engine considered (chosen action, alternatives,
unsupported actions with reasons, who wrote it, the snapshot fingerprint,
the priority reason) are stored in `details.engine`.

**Every run** (created, flagged or rejected) is written to the audit log as
`RECOMMENDATION_GENERATED`.

## Rules and guardrails

On top of the steps above, the engine enforces
[RECOMMENDATION-RULES.md](RECOMMENDATION-RULES.md):
- minimum evidence per type
- frequency limits
- duplicate and repetition control
- integration availability
- a 30-day maximum life
- conflict flags
- low confidence makes a recommendation advisory, not executable

## API

`POST /api/opportunities/:id/recommendations` `{ title?, action?, channel?, … }`

| Response | Meaning |
| --- | --- |
| **201** | `{ recommendation, generation }`. `generation.status` is `created` or `flagged`, with the chosen action, alternatives, unsupported actions and flags. |
| **422** | The data supports no recommendation; `generation.reasons` says why. Nothing is stored. |
| **409** | The opportunity isn't eligible, or already has a recommendation in play. This is refused before any work is done. |

Any fields sent replace the engine's own. They are still checked by the
support gate, and recorded as edited by a person.

## Fallback without AI

With no AI provider configured, the engine uses templates only. Every
acceptance criterion holds either way. The local environment has no AI key, so
the model path was tested with a scripted stand-in (`pnpm verify:engine`).
