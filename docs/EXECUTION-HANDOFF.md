# Approval → Execution handoff

Once content is approved, Aura prepares the structured package the Execution
Engine (Sprint 10) will consume. The approval model is unchanged: the handoff
is built **from** the approval record and the approved snapshot.

| Part | Where |
| --- | --- |
| Payload contract, validation rules (pure) | `lib/execution-handoff.ts` |
| Prepare, keep, re-validate | `server/execution/execution-handoff.service.ts` |
| The seam Sprint 10 implements | `server/execution/execution.service.ts` |
| Record | `ExecutionHandoff` (migration `20261016100000_execution_handoff`) |
| API | `GET /api/content/drafts/:id/execution` |
| Shown | the **Execution** card on an approved draft |
| Tests | `tests/execution-handoff.test.ts` |

## The payload (`executionHandoffSchema`, version 1)

| Field | Holds |
| --- | --- |
| `asset` | Type, title, the text the network receives, the **approved snapshot**, and the media in order |
| `recommendationId`, `opportunityId` | From the draft's provenance (null for hand-written work) |
| `channel` | The network |
| `provider` | LinkedIn, Meta, or "posted by hand"; `api` or `manual` mode |
| `account` | LinkedIn member or company Page, Facebook Page, or Instagram account. **Ids and labels only, never a token** |
| `audience` | From the recommendation |
| `cta` | The draft's CTA text. Its destination is the business's own website, and only when there is CTA text |
| `scheduledFor` | The scheduled time, or null |
| `contentVersion` | The approval record's version and fingerprint, plus the numbered version in the history |
| `approval` | Approval id, by, via (person or Autopilot), at, version, hash |
| `requirements` | Media required, max media, accepted types, caption limit, the provider permissions needed |
| `readiness` | `ready`, `blocked`, `superseded` or `executed`, and the issues |

## Validation: nothing fails silently

Every problem is an issue with a code, a plain message and, where possible, a link to fix it. All issues are listed at once.

| Code | When |
| --- | --- |
| `missing_connection` | The provider isn't connected |
| `connection_expired` | The connection has expired |
| `missing_permission` | LinkedIn is connected without posting permission |
| `missing_account` | No Facebook Page chosen, or no Instagram account linked to it |
| `unsupported_channel` | X; a format the network's API doesn't take; emails and ads |
| `missing_media` / `invalid_media` | Instagram without media; media the network will refuse |
| `missing_field` | Nothing to publish |
| `not_approved` / `content_changed` | No longer approved, or changed since approval (→ `superseded`) |

## Ready for Execution

| Status | Meaning |
| --- | --- |
| **READY** | Approved, current and valid. Handed to the execution service |
| **BLOCKED** | Approved, but something must be fixed. The issues say what |
| **SUPERSEDED** | Edited, reopened or rejected since approval |
| **EXECUTED** | Published by any path |

**When it's prepared**
- **On approval:** one record per draft and target network.
- **On scheduling:** it carries the scheduled time.
- **On every read:** the API and the draft page re-validate it, so a connection that expires after approval shows up straight away.
- **On publishing:** it's marked EXECUTED.

**What gets recorded**
- Changes to READY or BLOCKED are audited as `EXECUTION_HANDOFF_READY` / `EXECUTION_HANDOFF_BLOCKED`.
- A problem preparing the handoff never fails the approval that triggered it.

## For Sprint 10

- Register the engine with `setExecutionService({ accept })`. Until then, the `ExecutionHandoff` row is the outbox and nothing is executed.
- Consume handoffs with `listReadyHandoffs({ dueBefore })`.
- Re-check each one with `getExecutionHandoff` right before acting. Connections expire, and content can be reopened.
- The approval states (`lib/approval.ts`) and this payload stay as they are.
