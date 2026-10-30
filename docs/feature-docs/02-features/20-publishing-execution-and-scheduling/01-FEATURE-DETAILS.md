# Publishing, Execution Engine & Scheduling

> After a person approves a post, Aura publishes it to Facebook, Instagram or LinkedIn, either now or at a scheduled time in the workspace's timezone. Every approved post gets one **execution** per network: a record that moves through a strict state machine (Approved → Ready → Scheduled/Queued → Executing → Completed, or Failed / Action required / Cancelled) and is linked back to the business context, opportunity, recommendation and approval that led to it. Aura only says "published" when an official API accepted the post. Anything it can't publish becomes a "copy for manual posting" with the reason, and a publish attempt can never post the same thing twice.

## 1. Overview

The feature is built from five parts:

| Part | Responsibility | Main files |
| --- | --- | --- |
| **Publisher** | Takes an `APPROVED`, unchanged draft and posts it through the network's official API. Returns `published`, `processing` (Instagram still processing a Reel or video), `manual` (copy for manual posting, with a reason) or `reconnect`. | `server/content/publish.service.ts`, `server/media/publishers/{facebook,instagram,linkedin-image}.ts` |
| **Publication claim** | One `ContentPublication` per (draft, network). A unique key plus compare-and-swap, so overlapping runs and clicks can never publish twice. | `server/content/publication-store.ts`, `server/content/processing.service.ts` |
| **Approval → Execution handoff** | A versioned, validated package per approved post and network (asset, ids, channel, provider, account/page, schedule, approval record, readiness issues). | `lib/execution-handoff.ts`, `server/execution/execution-handoff.service.ts` |
| **Execution engine** | One `Execution` per (draft, platform), moved through `lib/execution-state.ts` by what actually happens, with each change recorded as an `ExecutionEvent`. Provider routing chooses the connection and target page before any network call. | `lib/execution-state.ts`, `lib/execution-routing.ts`, `server/execution/engine.service.ts`, `server/execution/routing.service.ts`, `server/execution/execution-actions.service.ts` |
| **Scheduling** | Wall-time input in the workspace timezone, DST handling, validation, best-time suggestions, and the cron that publishes due posts. | `lib/timezone.ts`, `server/scheduling/schedule-input.ts`, `server/publishing/schedule.service.ts`, `app/api/cron/publish/route.ts` |

Platforms with an API publisher: `FACEBOOK`, `INSTAGRAM` and `LINKEDIN`. `X` has no publishing integration; it always returns `manual`. Email and ad copy types (`isCopyOnlyType`) are always copied out and never posted to a network.

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
| --- | --- | --- | --- |
| Publishing | `/dashboard/executions` | List executions with filters: **Needs you** (`ACTION_REQUIRED`, `FAILED`), **Scheduled** (`SCHEDULED`, `QUEUED`), **Ready** (`READY_FOR_EXECUTION`, `APPROVED`), **Publishing** (`EXECUTING`), **Published** (`COMPLETED`), **Cancelled**, **All** (up to 200). Each row shows the network, state, time in the workspace timezone and the error. **Cancel** and **Retry now**. | Any member can view. OWNER/ADMIN (`content:publish`) can cancel and retry. |
| Post page — Publishing status | `/dashboard/content/[id]` (uses `/api/content/drafts/:id/execution` and `/api/executions?draftId=`) | See the handoff readiness with each issue and where to fix it, the execution state, history and trace. Publish, schedule, cancel, retry. | Publish/schedule: `content:publish`. |
| Multi-publish (on the post page) | `/api/content/drafts/:id/publications` | "Approve & Publish to Selected Platforms": preview per network, then publish to several networks. | The role is checked by `multi-publish.service.ts`. The preview reports `canPublish` / `canApprove`. |
| Settings → Workspace timezone | `/api/company/timezone` | Set the IANA timezone used for scheduling and display. Changing it never moves a scheduled post. | GET any member; PATCH `company:update` |

Times are shown in the workspace timezone with the offset, for example "Mon 2 Nov 2026, 09:00 GMT-5" (`formatInZone`, `scheduleLine`).

## 3. How it works

### 3.1 Publishing a draft (`publishDraft`)

1. Load the draft (`DraftNotFoundError` if missing). `assertPublishable` is the hard gate: the draft must be `APPROVED`. The exception is a second network for a piece already `PUBLISHED` on its own network.
2. `assertContentIntact` (approval service): the text, network and images must be exactly what was approved, compared by content hash.
3. Copy-only types return `manual` straight away.
4. `claimPublication` (`publication-store.ts`) decides what happens next:

   | Existing record | Result |
   | --- | --- |
   | none | create it as `PUBLISHING` (the unique key lets only one of two simultaneous creates win) |
   | `PUBLISHED` | never again ("already published") |
   | `PUBLISHING`, newer than 3 min (`PUBLISH_LEASE_MS`) | refused: someone is publishing it now |
   | `PUBLISHING`, stale | becomes `FAILED`, for a person to check the account. It is never re-posted automatically. |
   | `FAILED` / `MANUAL` | a person's retry claims it. The scheduler (`automatic`) never does, except a rate-limited execution retry (`retry: true`). |
   | `PROCESSING` | only the processing sweep moves it on |

5. `publishTo`:
   - checks every attached image or video against the destination first (`validateForPlatform`, `validateMediaSet`). A problem returns `manual` with an explanation.
   - for FACEBOOK, INSTAGRAM and LINKEDIN, runs **provider routing** (`routeExecution`, capability `scheduling` if the draft has `scheduledFor`, else `organic_publishing`) and records the route on the execution (`recordRoute`). A refusal returns `reconnect`, except `not_connected` and `unsupported_content_type`, which the publisher explains with a manual fallback.
   - calls the network publisher. Instagram images are passed as signed asset URLs valid for 15 minutes (`INSTAGRAM_ASSET_URL_TTL_MS`). LinkedIn images go through the Images API, and the text is escaped for LinkedIn's "little" format.
   - records the outcome on the connection (`recordExecutionResult`). An HTTP 401 marks the credential rejected.
6. `finishPublication` saves the outcome (`PUBLISHED` with URL and external id, `PROCESSING`, or `MANUAL`), and `syncFromPublication` moves the execution.

LinkedIn posts go to the member's profile with `w_member_social`, or to the Company Page with `w_organization_social` and `LINKEDIN_ORG_URN`. The REST version header comes from `linkedInApiVersion()`.

### 3.2 Instagram processing

Reels and video carousels are accepted by Instagram but not ready yet. They are stored as `PROCESSING` and finished by `advanceProcessing()` (`processing.service.ts`), which runs from `/api/cron/publish`, from `/api/cron/whatsapp`, and from the draft page (`PATCH /api/content/drafts/:id/publications`). Each row is leased for 2 minutes (`PROCESSING_LEASE_MS`). Before publishing, the piece must still be exactly what was approved. Instagram's own 24-hour container expiry ends anything that never finishes.

### 3.3 Approval → Execution handoff

`prepareExecutionHandoff` runs from the content service on approval, scheduling and viewing. It gathers facts and builds the package with `buildExecutionHandoff` (`EXECUTION_HANDOFF_VERSION = 1`).

- Readiness: `ready`, `blocked`, `superseded` or `executed`. Stored as `ExecutionHandoffStatus` `READY` / `BLOCKED` / `SUPERSEDED` / `EXECUTED`.
- Issue codes: `not_approved`, `content_changed`, `unsupported_channel`, `missing_connection`, `connection_expired`, `missing_permission`, `connection_unhealthy`, `missing_account`, `missing_media`, `invalid_media`, `missing_field`. Each comes with a message and a fix link (`/dashboard/connections`, or `/dashboard/settings/connections` for LinkedIn).
- If the draft is no longer approved, waiting executions are cancelled through `syncFromHandoff`.
- `GET /api/content/drafts/:id/execution` re-validates the handoff on every read, so a connection that expired after approval shows up.
- `server/execution/execution.service.ts` is an outbox seam (`setExecutionService`, `listReadyHandoffs`) where the ExecutionHandoff row is the queue.

### 3.4 Execution state machine (`lib/execution-state.ts`)

States: `APPROVED`, `READY_FOR_EXECUTION`, `SCHEDULED`, `QUEUED`, `EXECUTING`, `COMPLETED`, `FAILED`, `ACTION_REQUIRED`, `CANCELLED`.

| From | Allowed to |
| --- | --- |
| (none) | `APPROVED` |
| `APPROVED` | `READY_FOR_EXECUTION`, `ACTION_REQUIRED`, `CANCELLED` |
| `READY_FOR_EXECUTION` | `SCHEDULED`, `QUEUED`, `ACTION_REQUIRED`, `CANCELLED`, `APPROVED` |
| `SCHEDULED` | `SCHEDULED` (reschedule), `QUEUED`, `READY_FOR_EXECUTION`, `ACTION_REQUIRED`, `CANCELLED`, `APPROVED` |
| `QUEUED` | `EXECUTING`, `SCHEDULED`, `ACTION_REQUIRED`, `CANCELLED`, `COMPLETED` |
| `EXECUTING` | `EXECUTING` (still processing), `COMPLETED`, `FAILED`, `ACTION_REQUIRED` |
| `COMPLETED` | none (final) |
| `FAILED` | `QUEUED`, `ACTION_REQUIRED`, `CANCELLED`, `SCHEDULED` |
| `ACTION_REQUIRED` | `READY_FOR_EXECUTION`, `QUEUED`, `SCHEDULED`, `CANCELLED`, `APPROVED` |
| `CANCELLED` | `APPROVED` (only by approving again) |

- `moveExecution` is a compare-and-swap (`updateMany` on the current status). It writes an `ExecutionEvent` (from, to, actor `person`/`scheduler`/`system`/`provider`, `actorUserId`, reason, detail) and audits `EXECUTION_STATE_CHANGED`.
- `pathTo` walks the shortest allowed path, so "publish now" from `APPROVED` records Approved → Ready → Queued → Executing step by step.
- An invalid move throws `InvalidTransitionError` (409, `code: invalid_transition`).
- `CANCELLABLE`: `APPROVED`, `READY_FOR_EXECUTION`, `SCHEDULED`, `QUEUED`, `FAILED`, `ACTION_REQUIRED`. `RETRYABLE`: `FAILED`, `ACTION_REQUIRED`.

Failure handling (`classifyFailure` → `failureTarget`):

| Failure kind | State | Automatic retry |
| --- | --- | --- |
| `rate_limited` (rate limit, "too many", "25 posts per 24 hours", HTTP 429) | `FAILED` | Yes, after 5 min, 30 min, then 2 h (`RETRY_BACKOFF_MS`), up to `maxAttempts` (default 3) |
| `provider` (other refusal) | `FAILED` | No. **Retry now** is a person's action. |
| `connection` (token refused, missing permission) | `ACTION_REQUIRED` | No |
| `content` (media or text not accepted) | `ACTION_REQUIRED` | No |
| `routing` | `ACTION_REQUIRED` | No |
| `unknown_outcome` (timeout, interrupted) | `ACTION_REQUIRED` | Never: it could post twice |

### 3.5 Provider routing (`decideRoute`)

Checks run in order, and the first failure is the answer:

| # | Check | Refusal code |
| --- | --- | --- |
| 1 | A provider executes this channel (`executorFor`) | `unsupported_channel` |
| 2 | The API can post this content type there (`apiSupportsFormat`) | `unsupported_content_type` |
| 3 | The provider is connected | `not_connected` |
| 4 | Required scopes granted and the connection healthy | `missing_permission`, `connection_unhealthy` |
| 5 | Valid target: the chosen Page; the Instagram account linked to that Page; the LinkedIn member or organisation | `invalid_account` |

Refusals are logged and audited as `EXECUTION_ROUTING_FAILED` when `record` is set. Retry re-routes first.

### 3.6 Cancel, retry and the automatic sweep

- `cancelExecution`: needs `content:publish`. It refuses `COMPLETED` ("already published") and `EXECUTING`, moves the execution to `CANCELLED`, and clears the draft's `scheduledFor` if no other execution of that draft is `SCHEDULED`. The scheduler also skips cancelled executions (`cancelledFor`).
- `retryExecution`: needs `content:publish` and a `RETRYABLE` state. It re-routes (a refusal other than `not_connected` returns 409 `route:<code>`), calls `publishDraft` for that platform, and audits `CONTENT_PUBLISH_REQUESTED` with `retry: true`.
- `runExecutionSweep`: picks `FAILED` executions whose `nextAttemptAt` has passed, oldest first, up to 50, skipping any at `maxAttempts`, and stops starting work at the deadline. It retries with `automatic: true, retry: true`.

### 3.7 Scheduling and timezones

- Storage: `scheduledFor` is a UTC instant on the draft. The execution also keeps `scheduledTimeZone` and `scheduledLocal` (`noteSchedule`). The workspace zone is `Company.timezone` (IANA, default `UTC`).
- Input (`scheduleInputSchema`), exactly one of:
  - `{ localTime }` (`YYYY-MM-DDTHH:mm[:ss]`), interpreted in the workspace zone
  - `{ localTime, timeZone }`, in a named zone
  - `{ scheduledFor }`, an ISO instant with offset
- The browser's own timezone is never used.
- DST (`zonedToUtc`): a time that doesn't exist moves forward by the gap. A time that happens twice takes the first occurrence. Either way the response explains it in `note`.
- Validation (`validateScheduleTime`): at least 1 minute ahead (`MIN_LEAD_MS`), at most 366 days ahead (`MAX_AHEAD_MS`). An unknown zone or an impossible date is refused. All refusals are `ScheduleError`, 422.
- Changing the workspace timezone keeps each scheduled instant and only changes how it is shown. The audit metadata records `scheduledPostsKept`.
- **Best-time suggestions** (`server/publishing/schedule.service.ts`, used by the autopilot):
  - `learnTiming` buckets the workspace's own published posts by weekday and hour. It is used only with at least 3 posts per weekday, 8 posts in total, and a 1.2× lift; these are reported as `learned`.
  - Otherwise a per-platform default window is used, reported as `default`: LinkedIn Tue 09:00, Instagram Thu 18:00, X Wed 12:00, Facebook Thu 19:00, fallback Tue 10:00. These hours are UTC.
  - `recommendSlots` spreads several posts across days so they are not stacked on the same slot.

### 3.8 The scheduled-publish job (`/api/cron/publish`)

`isCronAuthorized` checks `Authorization: Bearer $CRON_SECRET` in constant time. The job then runs four steps, with a 45 s budget (`BUDGET_MS`) inside `maxDuration = 60`:

1. `runScheduledPublishes(now, { deadline })`: drafts that are `APPROVED`, have `scheduledFor <= now` and `publishedAt` null, and have no publication in `FAILED`/`MANUAL`/`PROCESSING`/`PUBLISHED`. Oldest first, up to 100. Cancelled executions are skipped. Each draft runs `publishDraft({ automatic: true, userId: null })`. No new publish starts after the deadline; the rest are counted as `deferred`.
2. `advanceProcessing()`: finishes Instagram processing.
3. `runExecutionSweep(now, { deadline })`: rate-limit retries.
4. `collectMetaInsights()`, only if there is time before the deadline.

It returns `{ attempted, published, skipped, deferred, processing, retries, insights, ms }`. GET and POST share one handler (Vercel Cron sends GET).

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/executions/page.tsx` | Publishing page, filters, server-side `listExecutions` |
| Component | `components/dashboard/execution/execution-list.tsx` | Rows, cancel/retry buttons, times in the workspace zone |
| API | `app/api/executions/route.ts` | List (`?status=A,B&draftId=&limit=`) |
| API | `app/api/executions/[id]/route.ts` | Detail, events, trace chain |
| API | `app/api/executions/[id]/cancel/route.ts` | Cancel |
| API | `app/api/executions/[id]/retry/route.ts` | Retry now (`maxDuration = 60`) |
| API | `app/api/cron/publish/route.ts` | Scheduled publish + processing + retries + insights |
| API (related) | `app/api/content/drafts/[id]/{publish,schedule,execution,publications}/route.ts`, `app/api/company/timezone/route.ts` | Publish now, schedule, handoff view, multi-publish, workspace timezone |
| Service | `server/content/publish.service.ts` | `publishDraft`, `publishTo`, `outcomeOf`, `runScheduledPublishes`, `canAutoPublish(To)` |
| Service | `server/execution/engine.service.ts` | `ensureExecution`, `moveExecution`, `syncFromHandoff`, `syncFromPublication`, `noteSchedule`, `recordRoute` |
| Service | `server/execution/execution-actions.service.ts` | `listExecutions`, `getExecutionDetail`, `cancelExecution`, `retryExecution`, `runExecutionSweep`, `cancelledFor`, `scheduleLine` |
| Service | `server/execution/execution-handoff.service.ts` | `prepareExecutionHandoff`, `refreshExecutionHandoff`, `getExecutionHandoff`, `markHandoffExecuted` |
| Service | `server/execution/routing.service.ts` | `routeExecution`: gathers facts, calls `decideRoute`, audits refusals |
| Service | `server/execution/execution.service.ts` | Execution service seam / outbox |
| Service | `server/scheduling/schedule-input.ts` | `scheduleInputSchema`, `resolveSchedule`, `workspaceTimeZone`, `ScheduleError` |
| Service | `server/publishing/schedule.service.ts` | `learnTiming`, `recommendSlot(s)` |
| Lib | `lib/execution-state.ts` | States, transitions, labels, failure classification, backoff |
| Lib | `lib/execution-routing.ts` | `decideRoute`, `apiSupportsFormat` |
| Lib | `lib/execution-handoff.ts` | Handoff schema, issue codes, `buildExecutionHandoff` |
| Lib | `lib/execution-gate.ts` | `CONTEXTUAL_EXECUTION_ENABLED = false`: campaign/outreach work created from recommendations does not execute |
| Lib | `lib/timezone.ts` | Zone validation, conversion, DST, formatting, limits |
| Tests | `tests/execution-engine.test.ts`, `tests/execution-handoff.test.ts`, `tests/scheduler.test.ts`, `tests/publishing.test.ts`, `tests/multi-publish.test.ts`, `tests/publish-media.test.ts`, `tests/instagram-processing.test.ts`, `tests/planner-schedule.test.ts`, `tests/failure-recovery.test.ts` | Unit coverage |

## 5. Data model

| Model / enum | Key fields | Notes |
| --- | --- | --- |
| `Execution` | `companyId`, `contentDraftId`, `platform` (`SocialPlatform`), `status` (`ExecutionStatus`), `provider`, `connectorId`, `connectionId`, `connectedAccountId`, `targetKind`, `targetExternalId`, `targetName`, `traceId`, `businessContextRevision`, `opportunityId`, `recommendationId`, `approvalId`, `approvedVersion`, `contentHash`, `assetIds[]`, `handoffId`, `scheduledFor`, `scheduledTimeZone`, `scheduledLocal`, `attemptCount`, `maxAttempts` (3), `nextAttemptAt`, `startedAt`, `completedAt`, `cancelledAt`, `providerResponse`, `externalId`, `url`, `errorCode`, `errorMessage`, `lastErrorAt`, `createdById` | Unique (`contentDraftId`, `platform`). Indexed on (`companyId`, `status`), (`status`, `scheduledFor`), (`status`, `nextAttemptAt`). |
| `ExecutionEvent` | `executionId`, `companyId`, `from`, `to`, `actor`, `actorUserId`, `reason`, `detail`, `at` | One row per state change. |
| `ExecutionHandoff` | `companyId`, `contentDraftId`, `platform`, `status` (`ExecutionHandoffStatus`), `payload`, `issues`, `contentVersion`, `contentHash`, `scheduledFor`, `preparedAt` | Unique (`contentDraftId`, `platform`). |
| `ContentPublication` | `companyId`, `contentDraftId`, `platform`, `status` (`PublicationStatus`), `contentHash`, `attempts`, `startedAt`, `publishedAt`, `url`, `externalId`, `message`, `requestedById` | The no-duplicate claim. Unique (`contentDraftId`, `platform`). |
| `ContentDraft` (used) | `status` (`ContentStatus`: `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `PUBLISHED`), `scheduledFor`, `publishedAt`, `platform`, `type`, `aiMetadata` (approval record) | Owned by Content Studio. |
| `Company.timezone` | IANA zone, default `"UTC"` | |
| `ExecutionStatus` | `APPROVED`, `READY_FOR_EXECUTION`, `SCHEDULED`, `QUEUED`, `EXECUTING`, `COMPLETED`, `FAILED`, `ACTION_REQUIRED`, `CANCELLED` | |
| `PublicationStatus` | `PUBLISHING`, `PROCESSING`, `PUBLISHED`, `FAILED`, `MANUAL` | |
| `ExecutionHandoffStatus` | `READY`, `BLOCKED`, `SUPERSEDED`, `EXECUTED` | |

## 6. API endpoints

Full list: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| GET | `/api/executions?status=&draftId=&limit=` | List executions (default limit 100) | Any member |
| GET | `/api/executions/:id` | Detail, events, trace chain. 404 for another workspace's execution. | Any member |
| POST | `/api/executions/:id/cancel` `{ reason? }` (max 300 chars) | → `CANCELLED` | Same origin + `content:publish` (OWNER/ADMIN) |
| POST | `/api/executions/:id/retry` | Re-route and publish now | Same origin + `content:publish` |
| POST | `/api/content/drafts/:id/publish` | Publish an approved draft now | `content:publish` |
| POST | `/api/content/drafts/:id/schedule` `{ localTime \| scheduledFor, timeZone? }` | Schedule in the workspace timezone | `content:publish` |
| GET | `/api/content/drafts/:id/execution` | Current handoff, re-validated | Any member |
| GET / POST / PATCH | `/api/content/drafts/:id/publications` | Multi-publish preview / publish / finish processing | GET any member. POST is same-origin, and the role is checked inside `server/content/multi-publish.service.ts`. PATCH is same-origin + `content:publish`. |
| GET / PATCH | `/api/company/timezone` | Workspace timezone | GET any member; PATCH same origin + `company:update` |
| GET / POST | `/api/cron/publish` | Scheduled publish job | `Authorization: Bearer $CRON_SECRET` (constant time) |

## 7. External services

| Service | Used for | Env vars |
| --- | --- | --- |
| Meta Graph API (Facebook Pages, Instagram) | Feed and photo posts; Instagram container → status poll → `media_publish`; post insights | `META_CLIENT_ID`, `META_CLIENT_SECRET`, `META_GRAPH_VERSION`, `META_GRAPH_BASE_URL` (loopback sandbox only) |
| LinkedIn REST API | Posts and Images API | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ORG_URN`, `LINKEDIN_API_VERSION` |
| Object storage | Public, signed media URLs for Instagram (video needs S3-compatible storage) | `ASSET_S3_*` |

Outbound HTTP to LinkedIn goes through `lib/http.ts` (`httpRequest`). Credentials come from the Connections feature. See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

| Route | Schedule in `vercel.json` | Work |
| --- | --- | --- |
| `/api/cron/publish` | `0 9 * * *` (daily, 09:00 UTC) | Due scheduled posts, Instagram processing, rate-limit retries, Meta insights |
| `/api/cron/whatsapp` | not in `vercel.json` | Also calls `advanceProcessing` |

How close to the minute a scheduled post goes out depends on how often `/api/cron/publish` runs. Once a day means a post scheduled for 14:00 goes out the next morning. [SCHEDULER.md](../../../SCHEDULER.md) recommends calling it every 5 minutes from an external scheduler (for example cron-job.org) with the same header, or a Vercel Pro cron. The job is safe to run as often as every minute and from several schedulers at once.

## 9. Security & permissions

- **Human approval is the gate.** The scheduler publishes only `APPROVED` drafts, and `assertContentIntact` refuses anything changed since approval. Rejected, reopened or edited content cancels its executions.
- **RBAC**: publish, schedule, cancel and retry need `content:publish` (OWNER/ADMIN). Changing the timezone needs `company:update`. Viewing is open to any member.
- **Same-origin check** (`isSameOrigin`) on cancel, retry and the timezone PATCH.
- **Workspace scoping**: every route uses `requireActiveCompany()`. Executions are loaded by (`companyId`, `id`); another workspace's id returns 404.
- **No double posting**: a unique (`contentDraftId`, `platform`) claim, compare-and-swap, a 3-minute lease, and unknown outcomes are never retried automatically.
- **Cron**: `CRON_SECRET` bearer token, compared in constant time, refused when unset.
- **No secrets in handoffs or executions**: accounts are identified by ids and labels only.

## 10. Testing

| Test | Covers |
| --- | --- |
| `tests/execution-engine.test.ts` | State machine (allowed/invalid moves, final state, paths), failure classification and backoff, routing refusal codes, timezones (including +14, +5:30 and both DST directions), insights parsing |
| `tests/execution-handoff.test.ts` | The handoff object, provider/channel validation, the approval states it follows |
| `tests/scheduler.test.ts` | `CRON_SECRET` authentication, which posts the scheduler picks |
| `tests/publishing.test.ts` | `learnTiming`, autopilot publishing authority |
| `tests/multi-publish.test.ts`, `tests/publish-media.test.ts`, `tests/instagram-processing.test.ts`, `tests/planner-schedule.test.ts`, `tests/failure-recovery.test.ts` | Multi-network publishing, media checks, Instagram processing, planner scheduling, recovery |

End-to-end scripts: `pnpm verify:execution`, `pnpm verify:scheduler`, `pnpm verify:publishing`, `pnpm verify:multi-publish`, `pnpm verify:failure-recovery`, `pnpm verify:sandbox` (Facebook and Instagram through the local Meta stand-in).

## 11. Configuration & limits

| Setting | Value | Where |
| --- | --- | --- |
| Cron budget | 45 s inside `maxDuration` 60 s | `app/api/cron/publish/route.ts` |
| Scheduled batch | 100 drafts per run | `runScheduledPublishes` |
| Retry sweep batch | 50 executions | `runExecutionSweep` |
| Automatic retry backoff | 5 min, 30 min, 2 h | `RETRY_BACKOFF_MS` |
| Max attempts | 3 | `Execution.maxAttempts` default |
| Publish lease | 3 min | `PUBLISH_LEASE_MS` |
| Processing lease | 2 min | `PROCESSING_LEASE_MS` |
| Instagram asset URL TTL | 15 min | `INSTAGRAM_ASSET_URL_TTL_MS` |
| Schedule lead / horizon | at least 1 min / at most 366 days | `MIN_LEAD_MS`, `MAX_AHEAD_MS` |
| Default timezone | `UTC` | `DEFAULT_TIMEZONE`, `Company.timezone` |
| Best-time learning thresholds | 3 per weekday, 8 total, 1.2× lift | `schedule.service.ts` |
| Required env | `CRON_SECRET` (scheduled jobs are refused without it) | |

## 12. Known limitations & future work

- With the shipped `vercel.json`, scheduled posts go out once a day at 09:00 UTC. On-time publishing needs a 5–15 minute scheduler.
- X has no API publisher, so it is always copied out for manual posting (or sent through the Chrome extension).
- The Instagram and LinkedIn APIs have no native scheduling. Aura holds the post and publishes it at the time, so publishing depends on the cron running.
- None of the V1 providers report an account timezone, so the workspace timezone is always used.
- Default best-time windows are in UTC, not the workspace zone.
- `CONTEXTUAL_EXECUTION_ENABLED` is `false`: campaigns and outreach created from recommendations are saved and approved but not executed.
- An attempt with an unknown outcome always needs a person to check the account before retrying.

## 13. Related documents

- [EXECUTION-ENGINE.md](../../../EXECUTION-ENGINE.md), [EXECUTION-HANDOFF.md](../../../EXECUTION-HANDOFF.md), [SCHEDULER.md](../../../SCHEDULER.md), [FAILURE-RECOVERY.md](../../../FAILURE-RECOVERY.md)
- [META-INTEGRATION.md](../../../META-INTEGRATION.md), [APPROVAL-MODEL.md](../../../APPROVAL-MODEL.md), [TRACEABILITY.md](../../../TRACEABILITY.md), [MEDIA-STORAGE.md](../../../MEDIA-STORAGE.md)
- Sibling features: [19-connections-and-connectors](../19-connections-and-connectors/01-FEATURE-DETAILS.md), [13-review-approval-versions-and-trace](../13-review-approval-versions-and-trace/01-FEATURE-DETAILS.md), [11-content-studio](../11-content-studio/01-FEATURE-DETAILS.md), [24-platform-jobs-and-deployment](../24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md)
