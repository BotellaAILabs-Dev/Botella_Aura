# Unified approval model

Content Studio drafts, campaign tasks and outreach messages are all approved
in the same way: one set of states and rules, and one approval record. The
record is persisted on each item and audited.

| Part                                             | Where                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| States, transitions, record, fingerprints (pure) | `lib/approval.ts`                                                                                          |
| Applying it to stored items                      | `server/approval/approval.service.ts`                                                                      |
| Content                                          | `server/content/content.service.ts`, `generator.ts`, `publish.service.ts`, `server/media/asset.service.ts` |
| Outreach                                         | `server/outreach/outreach.service.ts`, `drafting.service.ts`                                               |
| Execution guards                                 | publishing, scheduling, the extension queue and "mark posted / sent"                                       |
| Shown                                            | the review screen's **Approval** panel; approval badges on campaign tasks                                  |

## States

```
Draft ─┐
       ├─► Review required ─► Approved ─► Scheduled ─► Ready for execution ─► Executed
Generated ┘        │              │
                   └─► Rejected ◄─┘
```

| State                   | Content draft                         | Outreach message                   | Campaign task                  |
| ----------------------- | ------------------------------------- | ---------------------------------- | ------------------------------ |
| **Generated**           | `DRAFT`, untouched since Aura made it | `DRAFT`, untouched                 | its content's state            |
| **Draft**               | `DRAFT`, after a person changed it    | `DRAFT`, after an edit             | planned, nothing made yet      |
| **Review required**     | `PENDING_APPROVAL`                    | `PENDING_APPROVAL`                 | its content's state            |
| **Approved**            | `APPROVED`, not scheduled             | —                                  | its content's state            |
| **Scheduled**           | `APPROVED`, scheduled in the future   | —                                  | its content's state            |
| **Ready for execution** | `APPROVED`, its time has come         | `APPROVED`: in the extension queue | its content's state            |
| **Rejected**            | `REJECTED`                            | `REJECTED`                         | `SKIPPED`, or rejected content |
| **Executed**            | `PUBLISHED`                           | `SENT`                             | its content's state            |

The unified state is **derived** from each module's existing status plus the
schedule, so no data was migrated. **Ready for execution** is the hand-off to
Sprint 10's execution state machine: it can take over from there without
renaming anything here.

## Transitions

- **Generated / Draft → Review required** (submit), **→ Approved** (an
  approver approves directly), **→ Rejected**.
- **Review required → Approved / Rejected / Draft** (changes requested).
- **Approved → Scheduled → Ready for execution → Executed.**
- **Approved, Scheduled or Ready for execution → Draft** only as a visible
  **reopen**, when the content changes. It is recorded and needs approving
  again.
- **Rejected → Draft** (edited or regenerated).
- **Executed** is final.

There is no transition that changes approved work while it stays approved.

## The approval record (`aiMetadata.approval`)

| Field      | Holds                                                                                                                                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`  | Increments on every change to the content                                                                                                                                                                                                                                                          |
| `hash`     | Fingerprint of the content now                                                                                                                                                                                                                                                                     |
| `approved` | `by` (user id; null for Autopilot), `via` (`person` or `autopilot`), `at`, `version`, `hash`, and `snapshot`: the approved content itself, kept even after later edits                                                                                                                             |
| `rejected` | `by`, `at`, `reason`, `version`                                                                                                                                                                                                                                                                    |
| `events`   | Every step, newest first: generated, edited, regenerated, submitted, approved, rejected, changes requested, reopened, scheduled, image changed, network changed, executed. Each has who, when, from and to states, version and fingerprint. Edits and regenerations keep the **previous content**. |

The record keeps 60 events. The 15 most recent keep their content snapshots;
older events keep everything except the snapshot.

**Items created before this model.** They get a record the first time they
are touched. If one was already approved, it is recorded as approved as it
stands, by an unknown approver.

Every status change is also an audit entry, carrying the event and the
version and fingerprint.

## What an approval covers

| Item     | Approval covers                                              |
| -------- | ------------------------------------------------------------ |
| Content  | The **text, the network and the attached images (in order)** |
| Outreach | The **message text**                                         |

Approved content therefore cannot silently change:

- **Editing approved work reopens it.** This applies to a manual edit, a
  regeneration, a variation switch, an undo, swapping an image, or a new
  network. The item goes back to draft (or into review when queued), the
  change is recorded with the previous version, and it needs approving again.
  The campaign task follows.
- **Execution checks the fingerprint.** Before scheduling, publishing,
  queueing to the extension, or marking posted or sent, the content's
  fingerprint must equal the approved one. A change that bypassed every path
  above (for example, a direct database write) is refused (`409
changed_after_approval`) and flagged on the review screen. It is never
  published.

## Preventing unauthorized and duplicate approval

- **Only owners and admins** (`content:approve`) can approve or reject. This
  is enforced in the services and passed from every route: content status,
  content bulk, outreach status, outreach bulk, and the unified review.
  Before this change the content status and bulk routes did not check the
  role.
- **Nothing is approved twice.** Approving something already approved gets
  "already approved" (409).
- **Two approvals at the same moment cannot both succeed.** The write only
  applies from the state that was read, so the second one is refused.
- **Outreach now has a real state machine.** Sent is final, and rejected
  must be edited before it can move on.
- **Autopilot's auto-approvals** (under the workspace's auto-publish setting)
  are recorded as approved via Autopilot, not attributed to a person.

## Campaigns

A campaign task's approval follows the content made for it. Its status
becomes `APPROVED` when that content is approved, and goes back to
`GENERATED` when the content is reopened or rejected. Before this change,
tasks never reached `APPROVED`, so the campaign check-in always counted zero.
The campaign page shows each task's approval state.

## Checking it

```bash
pnpm test tests/approval.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:approval
```
