# Recommendation acceptance → creation

When a person says yes to a recommendation, Aura already knows what is to be
made and why. Creating from it opens the right workflow already filled in, and
whatever is made keeps the recommendation's context.

Rules: `lib/recommendation-creation.ts` (pure, client-safe). Server:
`server/recommendations/creation.service.ts`. API:
`/api/recommendations/:id/creation`.

## What each recommendation creates

Decided by the module that carries it out (`CREATION_KIND` in
`lib/aura-modules.ts`), which is routed by the engine's action and falls back to
the recommendation's type.

| Kind         | Engine actions (type fallback)                                                                                           | Opens                           | Creates                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------- |
| **content**  | post, article, response-post, comparison-article, targeted-post, recovery-post (CONTENT, COMPETITIVE_RESPONSE, AUDIENCE) | Content Studio                  | a content draft             |
| **workflow** | series (CAMPAIGN)                                                                                                        | Campaigns                       | a campaign plan             |
| **workflow** | apply-pattern, plan-it (OPTIMIZATION, OTHER)                                                                             | Content plan                    | a month's content plan      |
| **workflow** | targeted-post, AUDIENCE — outreach as a related module                                                                   | Outreach                        | outreach drafts for chosen leads (see CAMPAIGN-OUTREACH-CREATION.md) |
| **action**   | connect-channel (CHANNEL), update-audience                                                                               | Connections / About my business | nothing — no content needed |

A workflow that creates can also be used from a related link (writing one piece
of a planned series in Content Studio). An **action** suggestion has nothing to
write, whichever page it is opened in.

## Whether it can be created from now

| State           | When                                                                                                            | What the person sees                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ready`         | accepted, edited or in progress; nothing in the way                                                             | The workflow, filled in                                                                                             |
| `accept_first`  | still open (generated / presented)                                                                              | "Say yes and generate" — creating also says yes. Owners and admins only, like any decision.                         |
| `needs_info`    | required information missing (what the business does), or a blocker such as a channel the business does not use | Generate held, the reason, and a link to fix it (the exact question on _About my business_, or Edit the suggestion) |
| `not_creatable` | an action suggestion                                                                                            | "Nothing to write for this suggestion", the reason, and the button to where it **is** done — no writing form        |
| `closed`        | skipped, turned down, withdrawn, expired or completed                                                           | "This suggestion is closed", plainly, with a way back to Aura Suggests                                              |

Recommended (not required) gaps — goal, audience, evidence, brand voice — never
stop creation; they are listed and left out, not made up (see
`MISSING_FIELD_POLICY` in `lib/recommendation-context-handoff.ts`).

The server enforces all of this: `POST /api/content/generate` and
`POST /api/campaigns/orchestrate` refuse, with the reason and the fix, anything
that cannot be created from. A recommendation from another workspace is never
found (404) and never filled in.

## What is carried, and what is kept

Opening a workflow from a recommendation carries `?rec=<id>`:

- **Content Studio** — the brief, format and channel from its Context Handoff,
  with a panel showing what was passed to the writer and what was not.
- **Content plan** — goal, objective, topic, audience and channel prefilled
  (`planBriefFrom`).
- **Campaigns** — name, goal, audience, themes, duration and modules prefilled; the campaign keeps the full creation context and is held as a plan until execution (CAMPAIGN-OUTREACH-CREATION.md).
- **Outreach** — drafts for chosen leads from the suggestion's context; sending waits for execution.

Whatever is created keeps the recommendation's **provenance**
(`creationProvenance`), taken from the server's record rather than the editable
brief: recommendation id and title, **opportunity id**, type, **reason** and
confidence, **evidence** (labels and links), expected outcome, goal, audience,
channel, **business** name and description, and the handoff's version,
readiness and gaps.

- Drafts store it in `aiMetadata.recommendation`; the writer is also given the
  reason, evidence and expected outcome (`provenancePrompt`), so they reach it
  even if the brief was cut down. The brief still decides angle and wording.
- The draft page shows **Created from Aura's suggestion** — why, what it is
  based on, the goal and audience, and a link to the opportunity.
- The recommendation's history records what was made, where (a link event),
  and it moves to **in progress**. More pieces can be created from it while in
  progress.

## Where Create appears

- **Aura Suggests** — the card's main button, with a line saying what it makes
  ("Creates a content draft in Content Studio, written from this suggestion."
  or "Nothing to write — this one is done in Connections.").
- **History** — suggestions already said yes to that make something offer the
  same Create action.
- **API** — `GET /api/recommendations/:id/creation` returns the plan, the
  provenance and, for content, the Content Studio request ready to post;
  `POST` gets ready to create (saying yes if it is still open).

## Checking it

```bash
pnpm test tests/recommendation-creation.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:creation
```
