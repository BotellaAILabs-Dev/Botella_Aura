# Campaign & Outreach creation from recommendations

The contextual creation model (Content Studio's, see RECOMMENDATION-CREATION.md)
extended to the two other workflows that create from a recommendation.

| Part | Where |
| --- | --- |
| Handoff contracts and mapping (pure) | `lib/creation-handoff.ts` |
| Execution gate (pure) | `lib/execution-gate.ts` |
| Eligibility | `creationPlan` in `lib/recommendation-creation.ts` |
| Campaign: create, plan, hold | `app/api/campaigns/orchestrate`, `server/campaigns/campaign.service.ts`, `planner.ts`, `executor.service.ts` |
| Outreach: draft for chosen leads | `app/api/outreach/from-recommendation`, `server/outreach/drafting.service.ts` |
| Pages | `/dashboard/campaigns/new?rec=`, `/dashboard/outreach/new?rec=`, campaign detail |
| Tests | `tests/creation-handoff.test.ts`, `tests/creation-handoff-server.test.ts` |

## Which recommendations are eligible

| Workflow | Eligible | Not eligible |
| --- | --- | --- |
| **Campaign** | A series (`series`, type `CAMPAIGN`) opens it directly. Any other suggestion that creates something can also be planned as a campaign. | Action suggestions (connect a channel, add an audience) and closed ones. |
| **Outreach** | Suggestions aimed at people, where Outreach is the primary or a related module: `targeted-post`, type `AUDIENCE`. | Everything else. The person is told *"This suggestion isn't aimed at particular people…"* with a button to where it **is** done. |

The usual states apply to both:
- `ready`
- `accept_first`: creating also says yes, which owners and admins only can do
- `needs_info`
- `closed`

## What is mapped

Both handoffs are built from the recommendation's Context Handoff, so each field is mapped the same way and carries where its value came from.

| Field | Campaign | Outreach |
| --- | --- | --- |
| **Recommendation context** | Provenance: id, opportunity, why, confidence, evidence, expected outcome | Same |
| **Audience** | Campaign target audience | Shown; each message is still personal to its lead |
| **Goal** | Campaign goal = business goal — expected outcome | Shown, and given to the drafter |
| **CTA** | The format's rule. Destination = the business's own site, or none | Always soft. **No link in a connection note**; the follow-up may point to the business's own site |
| **Channel** | Network, format, Aura or by hand | Always LinkedIn (connection note, then follow-up) |
| **Content requirements** | Formats named, key message, angle, steps, modules (audience-led adds outreach and discovery), evidence-only claims, brand voice | ≤ 300-character note, follow-up after acceptance, key message, angle, open with the lead's own signal, evidence-only claims |

**Nothing is invented.** A value Aura doesn't have stays empty. It's listed under *gaps* with what the planner or drafter does without it, for example: no website, so no URL.

## What is kept

- **Campaign:** `Campaign.recommendationId` and `Campaign.creationContext`, added by migration `20261016090000_campaign_creation_context`. The planner receives the context (`creationContextPrompt`).
- **Outreach messages:** `aiMetadata.recommendation` (as drafts keep it) and `aiMetadata.creationContext`. Regenerating a message keeps following the context.
- **The recommendation's history** records what was made, and the recommendation moves to **in progress**, as for content.

## Approval stays the same

- Outreach drafted from a suggestion lands as **DRAFT**. It's reviewed, edited, approved or rejected in the normal flow and checks: content:approve, LinkedIn limits, compliance, version history.
- A campaign's work is approved through the content it produces, as before.
- Approved items wait at **Ready for execution** (`lib/approval.ts`).

## Execution stays blocked until Sprint 10

`CONTEXTUAL_EXECUTION_ENABLED = false` in `lib/execution-gate.ts`. Sprint 10 turns it on in one place, and every guard follows.

| Guard | Behaviour while blocked |
| --- | --- |
| Campaign status at creation | Saved as **DRAFT** ("Planned"), never ACTIVE |
| Daily executor | Never runs a gated campaign's tasks, even if one were set ACTIVE |
| Start, resume or pause | Refused with 409 `execution_not_available` and the plain reason |
| Extension send queue | Gated outreach never appears in it |
| Marking a message sent | Refused with 409 |
| Outreach page | Held messages are counted separately, not as an overdue "backlog" |

Work created any other way, such as a campaign planned from scratch or outreach drafted for a lead, behaves exactly as before.
