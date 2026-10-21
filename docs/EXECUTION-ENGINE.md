# Execution engine

This document covers four Sprint 10 tickets:

- the Execution Job Model
- the Execution State Machine
- Provider Routing
- Scheduling & Timezone Handling

Meta is covered in [META-INTEGRATION.md](META-INTEGRATION.md).

Every approved post gets one **execution** per network. The execution is the record of what happens to the post: whether it is ready, scheduled, publishing, published or failed, and why. It is linked back to the business context, opportunity, recommendation and approval that led to it.

| Piece | File |
| --- | --- |
| Model | `prisma/schema.prisma`: `Execution`, `ExecutionEvent`, `Company.timezone` (migration `20261021090000_execution_engine`) |
| State machine (pure) | `lib/execution-state.ts` |
| Routing rules (pure) | `lib/execution-routing.ts`; server side `server/execution/routing.service.ts` |
| Lifecycle engine | `server/execution/engine.service.ts` |
| Cancel, retry, sweep, list, detail | `server/execution/execution-actions.service.ts` |
| Timezones (pure) | `lib/timezone.ts`; input handling `server/scheduling/schedule-input.ts` |
| Meta analytics | `server/connectors/meta-insights.service.ts` |
| UI | `/dashboard/executions` (Publishing), "Publishing status" on each post, Settings → Workspace timezone |

## 1. Execution job model

These are the fields the ticket asks for, and where each one is stored on `Execution`:

| Ticket field | Field |
| --- | --- |
| Execution ID | `id` |
| Workspace | `companyId` |
| Recommendation ID / Opportunity ID | `recommendationId`, `opportunityId` |
| Content/Asset ID | `contentDraftId`, `assetIds[]` |
| Approved version | `approvedVersion`, `contentHash`, `approvalId` |
| Channel / Provider | `platform`, `provider`, `connectorId` |
| Connected account | `connectionId`, `connectedAccountId` |
| Target page/profile | `targetKind`, `targetExternalId`, `targetName` |
| Scheduled time | `scheduledFor` (UTC), `scheduledTimeZone`, `scheduledLocal` |
| Execution status | `status` |
| Attempt count | `attemptCount`, `maxAttempts`, `nextAttemptAt` |
| Provider response | `providerResponse`, `externalId` (the network's post id), `url` |
| Error information | `errorCode`, `errorMessage`, `lastErrorAt` |
| Created/updated | `createdAt`, `updatedAt` |

**Traceability:** Business Context → Opportunity → Recommendation → Content → Approval → Execution.

- The execution stores the trace ids: `traceId`, `businessContextRevision`, `opportunityId`, `recommendationId`, `approvalId`.
- `GET /api/executions/:id` resolves the full chain, through `server/trace`.
- The chain is shown under **History & trace**.

**One execution per post and network.** It is created when the post is approved, or when it is first published, whichever comes first. Posts that were already approved or published before this release were backfilled by the migration.

**Duplicate posts.** The publication claim (`server/content/publication-store.ts`) still guarantees a post is never sent twice. The execution is the lifecycle around that claim.

## 2. Execution state machine

```
Approved → Ready for execution → Scheduled ─┐
                               └→ Queued ←──┘   (due, or "publish now")
Queued → Executing → Completed
Executing → Failed → Queued (retry) | Action required
Scheduled / Ready / Queued / Failed / Action required → Cancelled
Cancelled → Approved   (only by approving it again)
```

**Invalid transitions are prevented.**

- The `TRANSITIONS` table is the only source of allowed moves.
- Every change is a compare-and-swap on the current status, so a concurrent change wins and is never overwritten.
- A move across several states walks the allowed path (for example Approved → Ready → Queued → Executing), so each step is recorded.

**Every state change is recorded.** Each change creates an `ExecutionEvent` with: from, to, actor (person, scheduler, system or provider), the person's id, the reason, and detail such as how late the scheduler ran. A status change is also audited as `EXECUTION_STATE_CHANGED`.

**Failures keep their error.** The error code, message and time stay on the execution, and in the event that recorded them.

| Failure | Becomes | Automatic retry |
| --- | --- | --- |
| Rate limited (the provider said "slow down", so the post certainly did not go out) | Failed | Yes, after 5 min, 30 min, then 2 h, up to 3 attempts |
| Other provider refusal | Failed | No: **Retry now** is a person's action |
| Connection problem (refused token, missing permission) | Action required | No: reconnect first |
| Content or media not accepted | Action required | No |
| Unknown outcome (timeout, interrupted attempt) | Action required | **Never**: it could post twice, so a person checks the account first |
| Refused by routing | Action required | No |

**A completed execution never runs again.** Completed has no allowed next state. The claim also refuses an already-published post, and retry or cancel on a completed execution returns 409.

**The engine follows what actually happens, rather than being called separately:**

| Event | Engine call | Resulting state |
| --- | --- | --- |
| Approval, scheduling or viewing refreshes the Approval → Execution handoff | `syncFromHandoff` | Ready, Scheduled, Action required (the handoff's first issue), or Cancelled (approval withdrawn, or content edited) |
| A publication is claimed | `syncFromPublication` | Queued → Executing, with the attempt number |
| A publication is answered | `syncFromPublication` | Completed, Executing (Instagram still processing), Failed, or Action required |

**People and the scheduler:**

- **Cancel** and **Retry now** (OWNER/ADMIN), from the post or the Publishing page.
- Cancelling also clears the post's schedule, and the scheduler skips cancelled executions.
- The scheduled job runs the automatic rate-limit retries (`runExecutionSweep`).

**The UI shows the current state:**

- the **Publishing** page (`/dashboard/executions`), with filters: Needs you, Scheduled, Ready, Publishing, Published, Cancelled
- **Publishing status** on each post, with history and trace

## 3. Provider routing

Approved Instagram post → Instagram channel → Meta connection → the Instagram account linked to the chosen Page → Graph API.

The checks run in order, and the first failure is the answer:

| # | Check | Refusal code |
| --- | --- | --- |
| 1 | A provider executes this channel | `unsupported_channel` |
| 2 | The provider's API can post this content type there | `unsupported_content_type` |
| 3 | The provider is connected (not disconnected or revoked) | `not_connected` |
| 4 | The required permissions are granted, and the connection is healthy | `missing_permission`, `connection_unhealthy` |
| 5 | The account or page is valid: the chosen Page; the Instagram account linked to *that* Page; the LinkedIn member, or the organisation when allowed | `invalid_account` |

- **Where routing runs:** in `publishTo`, before any network call.
- **What it records:** the provider, connection, connected account and target page on the execution.
- **Refusals are logged and audited.** Each one is written to the log and to `EXECUTION_ROUTING_FAILED`, with the code and which check failed.
- **Two refusals are explained by the publisher instead.** For "not connected" and "this format can't go there", the post is copied so it can be published by hand, as before.
- **Retry re-routes first.**

## 4. Scheduling & timezones

**Storage**

- Every scheduled time is a UTC instant.
- The workspace timezone (`Company.timezone`, an IANA zone) and the wall time the person chose are kept on the execution.

**Entering a time**

The time is entered as a wall time ("09:00") in the **workspace's** timezone, and converted on the server. The person's browser timezone is never used, so a manager abroad still schedules in the business's local time.

The API accepts:

- `{ localTime }`, interpreted in the workspace timezone
- `{ localTime, timeZone }`, in a named zone
- `{ scheduledFor }`, an exact ISO instant

**Displaying a time**

Times are shown in the workspace timezone, with the offset, for example "Mon 2 Nov 2026, 09:00 GMT-5". This applies to the post page, the review screen, the Publishing page and toasts.

**Daylight saving** is handled per date, from the IANA database:

- **Clocks go forward:** a time that doesn't exist (for example 02:30) moves forward by the gap, and the response says so.
- **Clocks go back:** a time that happens twice takes the first occurrence, and the response says so.

**Validation:**

- **Past or too soon:** a time in the past, or less than a minute ahead, is refused.
- **Too far:** a time more than a year ahead is refused.
- **Unreadable:** a date that doesn't exist, or a zone Aura doesn't recognise, is refused. All refusals return 422 with the reason.

**Edits**

- **Rescheduling** is recorded as Scheduled → Scheduled, with the old and new time.
- **Changing the workspace timezone** never moves a scheduled post: its exact instant is kept, and it is shown in the new zone.
- **Connected account timezone:** none of the V1 providers report one, so the workspace timezone applies. `scheduledTimeZone` records which zone was used.

**When it runs**

- The scheduled job (`/api/cron/publish`) runs every due post, and records how late it ran.
- How close to the minute a post goes out depends on how often that job runs. **`vercel.json` currently runs it once a day (09:00 UTC)**, which suits the plan's cron limit but means a post scheduled for 14:00 goes out the next morning.
- For on-time execution, run it every 5–15 minutes: a Vercel Pro cron, or an external scheduler calling it with `CRON_SECRET`.

## API

| Route | Who | |
| --- | --- | --- |
| `GET /api/executions?status=&draftId=` | any member | list |
| `GET /api/executions/:id` | any member | detail, events, trace chain |
| `POST /api/executions/:id/cancel` `{ reason? }` | OWNER/ADMIN | → Cancelled |
| `POST /api/executions/:id/retry` | OWNER/ADMIN | run again now (re-routed) |
| `GET/PATCH /api/company/timezone` | member / OWNER/ADMIN | workspace timezone |
| `POST /api/content/drafts/:id/schedule` `{ localTime }` | OWNER/ADMIN | schedule in the workspace timezone |

## Tests

- **`tests/execution-engine.test.ts`** has 25 unit tests:
  - state machine: allowed and invalid moves, completed is final, paths
  - failure classification and retry policy
  - routing: every refusal code, the correct page and account
  - timezones: five zones including +14 and +5:30, both DST directions, validation
  - Meta insights parsing and optional permissions
- **`pnpm verify:execution`** runs end to end against the running app and database, with providers called using fake tokens.
