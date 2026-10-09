# Content Brief — Recommendation → Content Studio

The structured brief between the Recommendation Engine and Content Studio. It
is the **source of truth for what Aura is expected to create**: built from an
accepted recommendation, validated before anything is generated, used to hold
the writer to it, and kept on the draft as the record of what was asked for.

- Schema and mapping: `lib/content-brief.ts` (pure, client-safe, versioned —
  `CONTENT_BRIEF_VERSION = 1`)
- Service: `server/content/content-brief.service.ts`
- API: `GET /api/recommendations/:id/brief[?type=&platform=]` →
  `{ brief, validation, contentRequest }`

## Fields

| #   | Field              | Required?   | From                                                                                                                                                                                  |
| --- | ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Recommendation     | required    | the recommendation (id, title, type, status, accepted)                                                                                                                                |
| 2   | Opportunity        | required    | the opportunity behind it (title, type, summary, angle, link)                                                                                                                         |
| 3   | Business Context   | required    | business profile — what the business does or sells, industry, website                                                                                                                 |
| 4   | Marketing Goal     | recommended | business goals, else a related campaign's goal                                                                                                                                        |
| 5   | Target Audience    | recommended | the recommendation's audience, else the business's stated buyer                                                                                                                       |
| 6   | Channel            | recommended | the recommendation's channel, the network, publishing (Aura or by hand), and the network's copy rules (content playbook)                                                              |
| 7   | Recommended Action | required    | the recommendation's action and steps                                                                                                                                                 |
| 8   | Key Message        | required    | the recommendation's angle → the opportunity's angle → a concrete step → the action (never invented)                                                                                  |
| 9   | Reason             | required    | the recommendation's rationale, confidence and why                                                                                                                                    |
| 10  | Evidence           | recommended | the opportunity's evidence (label, detail, link, when seen)                                                                                                                           |
| 11  | Expected Outcome   | required    | the recommendation's outcome and metric                                                                                                                                               |
| 12  | CTA                | recommended | whether the format expects one, how it is written, and the business's own site as destination                                                                                         |
| 13  | Brand Voice        | recommended | the brand voice profile                                                                                                                                                               |
| 14  | Relevant Memory    | optional    | learned patterns relevant to this piece (Marketing Memory)                                                                                                                            |
| 15  | Content Type       | required    | the person's choice, else the recommendation's — only if the workspace has it turned on                                                                                               |
| 16  | Asset Requirements | required    | from the format and network: copy length (ideal and hard limit), hashtags, CTA, and images (needed / recommended / none, how many, aspect ratio, size and file limits, art direction) |

Values that can come from more than one place carry their `source`
(`recommendation`, `opportunity`, `business_profile`, `campaign`,
`brand_voice`, `marketing_memory`, `content_playbook`, `person`, `platform`).

## Required vs optional

- **required** — the brief cannot go to Content Studio without it.
- **recommended** — it can; the gap is listed and the writer is told not to
  invent it.
- **optional** — nice to have; its absence does not change readiness.

`BRIEF_FIELD_POLICY` holds, for each field, its requirement, what the writer
does without it, and where to add it (e.g. _Describe your business_ →
`/dashboard/business?ask=identity.description`).

## Missing information

Every field Aura does not have is `null`/empty **and** listed in `missing` with
its requirement, what that means, and the fix link. Nothing is filled in.
`fields` lists all 16 with `requirement` and `provided`.

`readiness`:

- `ready` — every required field present, nothing recommended missing
- `ready_with_gaps` — every required field present; recommended gaps stated
- `blocked` — cannot go ahead; `blockedBy` says why (not yet accepted, a
  required field missing, a blocker such as a channel the business does not use)

## Validated before generation

`validateContentBrief()` runs in `POST /api/content/generate` whenever a draft
is written from a recommendation — on the brief rebuilt for **exactly** the
person's chosen format and network. It checks the schema, that every required
field is present, that the brief is not blocked, and that its parts agree (the
format can run on the network; asset requirements are the format's). A brief
that fails is refused with the reasons (409) before anything is written.
Content Studio runs the same check live and holds the Generate button with the
reason.

## Into Content Studio, without re-entry

- Content Studio (`?rec=<id>`) shows the brief — key message, what to make,
  opportunity, goal, audience, expected outcome, evidence, CTA, requirements,
  and what is missing — and **rebuilds it as the person picks a format or
  network**, so requirements always match what will be made.
- The editable brief text, format and network are prefilled from it
  (`briefText`).
- `briefToContentRequest()` turns a valid brief into Content Studio's own
  generation request (also returned by the API as `contentRequest`).
- The writer is held to the brief (`briefPrompt`): key message, why now, goal,
  audience, outcome, evidence to cite (and only that), CTA, what has worked,
  length, and the gaps it must not invent. The person's edited text still
  decides angle and wording.
- The draft keeps the brief in `aiMetadata.brief`; the draft page shows its key
  message and what it asked for.

## Checking it

```bash
pnpm test tests/content-brief.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:content-brief
```
