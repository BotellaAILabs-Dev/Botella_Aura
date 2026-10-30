# Review, Approval, Versions & Traceability

> The human-in-the-loop gate. Every piece of work Aura generates (Content Studio drafts, including the ones made by campaigns, the content plan, Autopilot and Aura Suggests, plus LinkedIn outreach messages) goes through one review screen and one set of actions, and is approved under one approval model. Every change is kept as a numbered version. Every approval covers an exact fingerprint of what was approved: text, network and images. Each asset also carries the chain back to why it exists (business context, signals, opportunity, recommendation, brief). The point is that nothing is published or sent unless a person (or Autopilot, under its explicit policy) approved exactly that content, and that this can be shown afterwards.

## 1. Overview

The feature has four parts. They are pure, client-safe models in `lib/`, with server services in `server/` that apply them to stored rows:

| Part | Pure model | Server service | Stored in |
| --- | --- | --- | --- |
| Unified review (one item shape, one screen, one action set) | `lib/review-item.ts` | `server/review/review-item.service.ts`, `server/review/review-actions.service.ts` | nothing of its own; a view over drafts and messages |
| Unified approval model (states, transitions, approval record, fingerprints) | `lib/approval.ts` | `server/approval/approval.service.ts` | `aiMetadata.approval` |
| Versions (every state of the content, numbered) | `lib/versions.ts` | `server/versions/version.service.ts`, `server/versions/version-api.service.ts` | `aiMetadata.versions` |
| Traceability (Business Context → … → Approved Version) | `lib/trace.ts` | `server/trace/trace.service.ts` | `aiMetadata.trace` |

None of these parts added database tables or columns. Everything lives in the existing `aiMetadata` JSON column of `ContentDraft` and `OutreachMessage`. The unified approval state is derived from each module's existing status column, so no data was migrated. Records are created lazily, so items made before a part existed get one the first time they are read or touched.

There are two review kinds: `content` (a `ContentDraft`) and `outreach` (an `OutreachMessage`). They are listed in `REVIEW_KINDS` in `lib/review-item.ts`.

## 2. User-facing behaviour

### Screens

| Route | File | What the user sees |
| --- | --- | --- |
| `/dashboard/review` | `app/dashboard/review/page.tsx` | **Review & approve** queue (sidebar entry in `lib/nav.ts`). Filter chips: **Everything / Content / Outreach** (`?show=content` or `?show=outreach`), each with a count, and "N awaiting approval". Each row shows the module badge, type label, state badge, the reviewer verdict when it is not a pass ("Needs human review", "Review failed"), the title and a 140-character snippet. Empty state: "Nothing waiting for review". |
| `/dashboard/review/[kind]/[id]` | `app/dashboard/review/[kind]/[id]/page.tsx` → `components/dashboard/review/review-screen.tsx` | The unified review screen for one item. Any `kind` other than `content` or `outreach`, or an item outside the active workspace, gives a 404. |

Entry points into the screen: the queue, the **Review & approve** link on the Content Studio draft page, the **Review** button on each outreach message, and links from WhatsApp (`server/whatsapp/tools/read.ts` reads the same `listReviewQueue`).

### The review screen

**Main column**
- **The content, field by field.** `bodyToFields()` walks any content body and returns labelled, editable fields (Hook, Paragraph 1, Slide 2 · headline, Subject line, Hashtags, and so on). Fields follow a fixed reading order (`ORDER`), because Postgres returns JSON keys shortest-first. Hashtag, keyword and tag lists are edited as one line and split back on save. The `details` block (post details such as website and address) is skipped, because it has its own editor with a confirmation step (`lib/post-details.ts`). Outreach shows one field, `draftText`, with `maxLength` 300 for a connection note and 3000 for a follow-up.
- **The image or asset.** The attached images, whether the format needs one (`required`, `recommended` or `none`, from the brief's `assetRequirements.visual.need` or `visualFor()`), and a link to manage images.
- **Quality flags**, sorted block → review → info and shown as **Must fix**, **Check** and **Note**. Their sources are: the AI reviewer's issues (blocker → block, major → review, minor → info), the compliance rules, the fact check, Aura's rules (`aiMetadata.quality`), a missing required image, an approval the content no longer matches ("This changed after it was approved…", which blocks), and a previous rejection reason.
- **Reviewer feedback.** Status (`pass`, `review_required` or `fail`), score, summary, issues with suggestions, and whether the review is current. If the reviewer did not run, a review-severity flag says that relevance, voice and audience fit were not assessed.

**Side panel**
- **What it's for.** Recommendation (title, why, link), goal, audience, channel, key message, source, evidence (label, detail, url, observedAt), and extra facts (campaign; for outreach, lead category, fit score `N/100` and "Why this lead").
- **Why this exists** (`trace-panel.tsx`, content only). The resolved trace chain.
- **Approval** (`ApprovalCard`). State, approver (or "Autopilot", or "Unknown (approved before records were kept)"), approved version, whether it is still intact, the rejection, edit and regeneration counts, and the last 25 history events.
- **Versions** (`versions-panel.tsx`). Every version, newest first, with **Original**, **Current** and **Approved** badges, the full text on request, and **Make this current**.

**Action bar.** Back · Edit · Save · Regenerate · Submit for approval · Reject · Schedule · Approve. Every action is always present (`REVIEW_ACTIONS`). When one cannot be used, it is disabled with a reason the person can act on (`ActionState.reason`).

**Client behaviour** (`review-screen.tsx`)
- Unsaved edits are kept in `localStorage` under `aura-review-edits:<kind>:<id>`, as `{ base: updatedAt, edits }`. They are restored after a reload. If they were made on an earlier version, the screen says so. Leaving with unsaved edits triggers a `beforeunload` warning.
- Approve, Regenerate, Submit and Schedule are disabled while there are unsaved edits ("Save or discard your edits first.").
- A content item in draft or in review whose review is missing or stale is reviewed automatically on open (`POST /api/content/drafts/:id/review`), then the page refreshes.
- Any 409 response refreshes the page, because a refused step may still have moved the item (for example, submitted and then refused at approval).
- Approve shows a confirmation checkbox (`approval.confirmLabel`) when `approval.needsConfirmation` is true. Approve stays disabled until the box is ticked.

### Roles (from `lib/rbac.ts`)

| Action | Content | Outreach |
| --- | --- | --- |
| View queue and screen | any member, including VIEWER | any member |
| Edit / Save / Regenerate / Submit / Restore a version | `content:create` (OWNER, ADMIN, MEMBER) | `content:approve` (OWNER, ADMIN) |
| Approve / Reject | `content:approve` (OWNER, ADMIN) | `content:approve` |
| Schedule | `content:publish` (OWNER, ADMIN), approved posts only | never (sent from the extension) |

## 3. How it works

### 3.1 Building a ReviewItem (`contentReviewItem`, `outreachReviewItem`)

For a content draft, `contentReviewItem(companyId, draftId, role)`:
1. Loads the draft, scoped by `companyId`, with its campaign.
2. In parallel, loads the attached media (`getAttachedMedia`), runs `factCheckDraft(draft)`, loads the compliance policy (`getPolicyContext`) and loads the workspace profile.
3. Reads the stored AI review (`storedReview`) and decides whether it is current with `isReviewCurrent(review, body, policy.hash)`. A review is stale if the body or the compliance rules changed.
4. Computes the content fingerprint (`contentHash`), the approval record (`contentRecord`) and the unified state (`contentState`).
5. Builds the flags (see section 2) and works out what approval needs:
   - `blockedBy`: the current review failed; or a fact-check claim is `mustFix`; or a rule issue has severity `block` and there is no current review.
   - `needsConfirmation`: the current review is `review_required`; or the fact check is `needs_review`; or a required image is missing.
6. Works out each action's availability from the role, the review state (`draft`, `in_review`, `approved`, `rejected` or `done`), `blockedBy`, and whether the type is copy-only. Copy-only types are email and ad copy, which are "copied into your email tool / ad manager or site, not scheduled by Aura".

For outreach, `outreachReviewItem` loads the message with its lead and the lead signal (from `aiMetadata.signalId`, or else the most recent one), and takes its flags from `checkOutreachMessage`. Any `block` flag disables Approve ("Fix first: …"). Any `review` flag requires confirmation. Schedule is always off.

`getReviewItem(kind, companyId, id, role)` dispatches to one of these and adds the workspace `timeZone`.

**Review state mapping** (`CONTENT_STATE`, `OUTREACH_STATE`): `DRAFT` → `draft`, `PENDING_APPROVAL` → `in_review`, `APPROVED` → `approved`, `REJECTED` → `rejected`, `PUBLISHED` or `SENT` → `done`. The labels are Draft, Awaiting approval, Approved, Rejected, Published (or Sent).

### 3.2 The queue (`listReviewQueue`)

- By default, it returns `ContentDraft` and `OutreachMessage` rows whose status is `DRAFT` or `PENDING_APPROVAL`. With `includeDecided`, it returns all statuses.
- It takes the 100 most recent of each (`take: 100`, ordered by `updatedAt desc`).
- The content verdict is shown only when the stored review is current.
- Sort order: `in_review` first, then most recently updated.

### 3.3 Actions (`runReviewAction`)

Every action delegates to the module's own service, so the same gates apply on every screen.

| Action | Content | Outreach |
| --- | --- | --- |
| `save` | Refused with 409 `stale` if `baseUpdatedAt` ≠ the draft's `updatedAt` ("Your edits are kept — reload…"). Otherwise `applyFields()` writes only the edited fields back into the body, then `updateDraftBody()`. Saving an approved piece sends it back for approval. | The same stale check. Refused if already `SENT` (409) or if the text is empty (422). Then `updateMessageText()`. |
| `regenerate` | `mode` is `fresh`, `fix_review` or `instructions` (up to 1000 characters), mapped to `refineDraft` actions `regenerate`, `fix_review` or `custom`. Refused if `PUBLISHED`. | `regenerateMessage()` |
| `submit` | `transition(... to: 'PENDING_APPROVAL')` | `transitionMessage(action: 'submit')` |
| `approve` | If the draft is `DRAFT`, it is first transitioned to `PENDING_APPROVAL` (submit and approve in one step). Then `transition(... to: 'APPROVED', factsReviewed: confirmed, reviewAcknowledged: confirmed)`. | Re-runs `checkOutreachMessage`. A `review` flag without `confirmed` gives 409 `needs_confirmation`. Then `transitionMessage(action: 'approve')`. |
| `reject` | `transition(... to: 'REJECTED', reason)`, with a reason of up to 500 characters | `transitionMessage(action: 'reject', reason)` |
| `schedule` | Needs `localTime` (a wall time in the workspace or chosen zone) or `scheduledFor` (an ISO instant). Resolved by `resolveSchedule()`, then `scheduleDraft()`. Returns "Scheduled for <formatted in zone>". | Always 409: outreach is sent from the browser extension. |

**Approval gates inside `transition()`** (`server/content/content.service.ts`, owned by Content Studio but enforced here):
- `isValidTransition` against `TRANSITIONS`: `DRAFT → PENDING_APPROVAL | REJECTED`, `PENDING_APPROVAL → APPROVED | REJECTED | DRAFT`, `APPROVED → PUBLISHED | DRAFT | REJECTED`, `REJECTED → DRAFT`, and `PUBLISHED` is terminal. `PUBLISHED` is reachable only from `APPROVED`.
- AI review (`ensureReview`). A failed review blocks submitting and approving (409 `review_failed`). A `review_required` review needs `reviewAcknowledged` (409 `review_needs_human`).
- Compliance. Any `aiMetadata.quality` issue with severity `block` refuses approval (409).
- Fact check. A `contradicted` claim gives 409 `facts_contradicted`. A `mustFix` claim gives 409 `facts_must_fix`. `needs_review` without `factsReviewed` gives 409 `facts_need_review`.
- Concurrency. The write is `updateMany where { id, status: <read status>, updatedAt: <read updatedAt> }`. If no row matches, the result is 409 `concurrent_change`. A double click or two approvers cannot both succeed, and an edit that lands while the review runs makes the approval fail.
- On approval, the service also records `review.acknowledgedBy`, a `factCheck` summary (including `reviewedBy` and the unverified claims), the approval event, the approved version and the approval trace. It then syncs the campaign task and writes an audit entry carrying the approval action, version, hash and (for approve and publish) `traceAudit()`.

**Outreach state machine** (`server/outreach/outreach.service.ts`): `DRAFT → PENDING_APPROVAL | APPROVED | REJECTED`, `PENDING_APPROVAL → APPROVED | REJECTED | DRAFT`, `APPROVED → REJECTED | DRAFT`, `REJECTED → DRAFT`, and `SENT` is terminal. Approving or rejecting twice gives "already approved" or "already rejected" (409).

### 3.4 The unified approval model (`lib/approval.ts`)

**States** (`APPROVAL_STATES`): `draft`, `generated`, `review_required`, `approved`, `rejected`, `scheduled`, `ready_for_execution`, `executed`.

The state is derived, not stored:

| Unified state | Content (`contentState`) | Outreach (`outreachState`) | Campaign task (`campaignTaskState`) |
| --- | --- | --- | --- |
| `generated` | `DRAFT`, and the last non-submit event is not a person's action | `DRAFT`, untouched | its draft's state |
| `draft` | `DRAFT`, after an `edited`, `reopened`, `changes_requested`, `media_changed` or `retargeted` event | `DRAFT`, after an edit | no draft yet, and not `SKIPPED` |
| `review_required` | `PENDING_APPROVAL` | `PENDING_APPROVAL` | its draft's state |
| `approved` | `APPROVED`, no `scheduledFor` | — | its draft's state |
| `scheduled` | `APPROVED`, `scheduledFor` in the future | — | its draft's state |
| `ready_for_execution` | `APPROVED`, `scheduledFor` has passed | `APPROVED` (in the extension queue) | its draft's state |
| `rejected` | `REJECTED` | `REJECTED` | `SKIPPED` |
| `executed` | `PUBLISHED` | `SENT` | its draft's state |

**Transitions** (`APPROVAL_TRANSITIONS`, checked with `canMove`). The only way out of approved work is `approved → draft`, which is an explicit, recorded reopen. `executed` has no exits.

**Actions** recorded on events: `generated`, `edited`, `regenerated`, `submitted`, `approved`, `rejected`, `changes_requested`, `reopened`, `scheduled`, `unscheduled`, `media_changed`, `retargeted`, `executed`.

**Approval record** (`ApprovalRecord`, `model: 1`):
- `version` is incremented on every content change. `hash` is the current fingerprint.
- `approved`: `{ id?, by, via: 'person' | 'autopilot', at, version, hash, snapshot }`. The snapshot is the approved content itself (for content: body, platform and media), and it is kept after later edits.
- `rejected`: `{ by, at, reason, version }`.
- `events`: newest first, capped at `MAX_EVENTS = 60`. Only the 15 most recent events (`SNAPSHOT_EVENTS`) keep their `previous` content.

**Fingerprints.** FNV-1a run in both directions over canonical JSON (keys sorted), giving a 16-hex-character hash.
- `contentFingerprint({ body, platform, media })`: the media list is `[assetId, altText]` in position order. A content approval therefore covers the words, the network and the images in order.
- `textFingerprint(text)` is used for outreach.

**Integrity.** `approvalIntact(record, hash)` is true only if `approved.hash === hash`. `assertContentIntact(draft)` throws `ApprovalIntegrityError` (409, `changed_after_approval`). It is called on every execution path:
- publishing (`server/content/publish.service.ts`, `multi-publish.service.ts`);
- scheduling and mark-posted (`server/content/content.service.ts`);
- the extension (`server/extension/action.service.ts`).

`outreachIntact()` guards the extension queue (`server/extension/queue.service.ts`, where items that are not intact are skipped) and the send action.

**Reopen on change.** These changes all move the version on and record the previous content: `contentChangeMeta()` (edits and regenerations, with the note "Changed after approval — it needs approving again."), and `recordContentChange()` (image swaps and network changes from `server/media/asset.service.ts` and `content.service.ts`, run in one transaction). If the item was `APPROVED` or `PENDING_APPROVAL` and the fingerprint changed, it goes back to `DRAFT`. If the fingerprint did not change, nothing is recorded.

**Legacy items.** `contentRecord()` and `outreachRecord()` create a record lazily. An item already `APPROVED` or `PUBLISHED` (`SENT` for outreach) is recorded as approved by `null`, as it stands.

**Campaign tasks** (`syncCampaignTask`). When the draft becomes `APPROVED` or `PUBLISHED`, `CampaignTask` rows with `relatedContentDraftId` = the draft and status `GENERATED` become `APPROVED`. When the draft leaves those statuses, tasks go back from `APPROVED` to `GENERATED`.

**Autopilot.** `server/briefing/autopilot.service.ts` approves under the workspace's auto-approve policy with `via: 'autopilot'` and `by: null`. The screen shows "Autopilot" as the approver.

### 3.5 Versions (`lib/versions.ts`)

- **Sources** (`VERSION_SOURCES`): `generated`, `edited`, `regenerated`, `variation`, `undo`, `restored`.
- **Version fields**: `n`, `source`, `by` (null = Aura), `at`, `body` (draft JSON or message text), `hash`, and optionally `basedOn` and `note`.
- **The log** (`VersionLog`, `model: 1`): `current`, `approved: { n, by, at } | null`, and `versions` (oldest first).
- `newLog()` makes v1 (`generated`). The generator writes it via `firstVersion()`. Outreach drafting does the same for the connection note and the follow-up.
- `addVersion()` appends the next number (max `n` + 1) and makes it current. Content identical to the current version adds nothing. Identity is checked with `bodyFingerprint`: FNV-1a over canonical JSON, plus the string length in hex.
- `restoreVersion()` never overwrites. It calls `updateDraftBody` or `updateMessageText` with `versionSource: 'restored', basedOn: n`, which adds a new version. Restoring the current version gives 409 "That is already the current version." A version that does not exist gives 404 "There is no version N."
- `markApproved()` marks the current version at approval (`withApprovedContentVersion` / `withApprovedMessageVersion`).
- **Cap.** `MAX_VERSIONS = 50`. `trim()` drops the oldest versions, but never v1, the current version or the approved version.
- **Legacy items.** `legacyLog()` rebuilds the log from the old `aiMetadata.history` undo list, oldest first. Each entry gets the note "Recovered from the edit history". If the item is already approved, its current content is marked approved.
- `versionMatching()` finds which earlier version a body equals; it is used to link an undo to its `basedOn`.
- `listVersions()` returns the versions newest first, with a `byName` ("Aura" for null, "A former member" for a missing user) and a readable `text` (hashtags re-prefixed with `#`).

### 3.6 Traceability (`lib/trace.ts`)

The chain is: Business Context → Signal → Opportunity → Recommendation → Content Brief → Generated Asset → Reviewed Version → Approved Version (`TRACE_LINKS`).

**Ids stored on the asset** (`TraceIds`, `model: 1`):
- `traceId` (`trc_<time36><random>`);
- `businessContext.revision` and `businessContext.fields`;
- `signalIds`, `opportunityId`, `recommendationId`;
- `briefId` (`brf_<bodyFingerprint(brief)>`, stable for the same brief);
- `generatedVersion` (1);
- `reviewedVersion` and `reviewId` (`rvw_<fp(bodyHash, at)>`);
- `approvedVersion` and `approvalId` (`apv_<fp(itemId, version, at)>`);
- `mediaAssetIds`.

**When the ids are written:**
- **Generation.** `initialTrace()` (called from `server/content/generator.ts`) resolves the opportunity: from the provenance, then the brief, then the recommendation row. It collects signal ids from `RecommendationEvidence.signalId` and `OpportunitySignal.signalId`, both scoped to the workspace through the parent record.
- **Each review.** `withReviewTrace()` (`server/content/review.service.ts`) finds the reviewed version by matching the review's `bodyHash`.
- **Each approval.** `withApprovalTrace()` (by a person in `transition()`, and by Autopilot) sets `approvedVersion` (the version log's approved `n`, or the current one), generates the `approvalId`, also writes it to `aiMetadata.approval.approved.id`, and records the media asset ids at approval time.
- **Assets made before traces existed.** `traceFor()` derives the ids from `aiMetadata.recommendation` and `aiMetadata.brief`, with `traceId = trc_<draftId>`.

**Resolving.** `resolveTrace(companyId, draftId)` returns live records where they still exist:
- recommendation, with who decided it;
- opportunity, with `href` `/dashboard/opportunities?focus=<id>`;
- signals;
- company name;
- otherwise, the snapshot.

It also reports `gaps`: `recommendation` if the recommendation was deleted, `opportunity` if the opportunity is missing, and `signal` if a recommendation-originated asset has no signal ids. `origin` is `recommendation` or `brief`. `why` is taken from the first available of: recommendation rationale, provenance `why`, `brief.reason.why`, "Requested: <brief>".

**Analytics.** `traceRows(companyId, { since, limit })` returns one flat row per `APPROVED` or `PUBLISHED` draft (default 200, max 500). Each row has the chain ids plus `approvedAt`, `publishedAt`, `publishedUrl` and `performanceSnapshotIds`. Approval and publish audit entries carry `traceAudit()`: `traceId`, `recommendationId`, `opportunityId`, `briefId`, `approvalId` and `approvedVersion`. The execution feature also resolves the trace (`server/execution/execution-actions.service.ts`).

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/review/page.tsx` | Review queue with filters and counts |
| Page | `app/dashboard/review/[kind]/[id]/page.tsx` | Loads the ReviewItem, versions and trace on the server, and renders `ReviewScreen` |
| Component | `components/dashboard/review/review-screen.tsx` | The unified screen: fields, flags, reviewer, context, action bar, local edit persistence, auto-review |
| Component | `components/dashboard/review/versions-panel.tsx` | Version list, text view, **Make this current** (asks first when approved) |
| Component | `components/dashboard/review/trace-panel.tsx` | **Why this exists**: the resolved chain |
| API | `app/api/review/[kind]/[id]/route.ts` | GET the item, POST an action (zod discriminated union), `maxDuration = 60` |
| API | `app/api/review/[kind]/[id]/versions/route.ts` | GET versions, POST restore |
| API | `app/api/analytics/traces/route.ts` | Flat trace rows for analytics |
| API (used here) | `app/api/content/drafts/[id]/trace/route.ts` | The resolved trace for one draft |
| Service | `server/review/review-item.service.ts` | `contentReviewItem`, `outreachReviewItem`, `getReviewItem`, `listReviewQueue`, `approvalInfo` |
| Service | `server/review/review-actions.service.ts` | `runReviewAction`: role checks and delegation to module services |
| Service | `server/approval/approval.service.ts` | `contentHash`, `contentRecord`, `contentMetaAfter`, `contentChangeMeta`, `recordContentChange`, `assertContentIntact`, `ApprovalIntegrityError`, `syncCampaignTask`, `outreachRecord`, `outreachMetaAfter`, `outreachIntact`, `generatedRecord` |
| Service | `server/versions/version.service.ts` | `contentLog`, `withContentVersion`, `withApprovedContentVersion`, `firstVersion`, `contentVersion`, `versionMatching`, and the outreach equivalents |
| Service | `server/versions/version-api.service.ts` | `listVersions`, `restoreVersion` |
| Service | `server/trace/trace.service.ts` | `initialTrace`, `traceFor`, `withReviewTrace`, `withApprovalTrace`, `traceAudit`, `resolveTrace`, `traceRows` |
| Lib | `lib/review-item.ts` | `ReviewItem` and its types, `bodyToFields`, `applyFields`, `changedEdits`, `editsStorageKey`, `parseStoredEdits`, `reviewHref` |
| Lib | `lib/approval.ts` | States, transitions, record, fingerprints, state derivation, `summarize`, labels |
| Lib | `lib/versions.ts` | Version log model, `addVersion`, `trim`, `markApproved`, `legacyLog`, `summarizeVersions` |
| Lib | `lib/trace.ts` | `TraceIds`, `ContentTrace`, id generators, `TRACE_LINKS` |
| Callers | `server/content/content.service.ts`, `generator.ts`, `review.service.ts`, `publish.service.ts`, `multi-publish.service.ts`, `server/media/asset.service.ts`, `server/outreach/outreach.service.ts`, `drafting.service.ts`, `server/extension/action.service.ts`, `queue.service.ts`, `server/briefing/autopilot.service.ts` | Write the records and versions, and enforce integrity |
| Tests | `tests/review-item.test.ts`, `tests/approval.test.ts`, `tests/approval-state-machine.test.ts`, `tests/versions.test.ts`, `tests/trace.test.ts`, `tests/content-review.test.ts` | Unit tests (see section 10) |
| Verify | `scripts/verify-unified-review.ts`, `verify-approval.ts`, `verify-versions.ts`, `verify-trace.ts`, `verify-review.ts` | End-to-end checks against the DB and the running app |

## 5. Data model

No owned tables. The feature uses:

| Model / enum | Fields used | Role here |
| --- | --- | --- |
| `ContentDraft` | `status` (`ContentStatus`), `body` (JSON), `aiMetadata` (JSON), `platform`, `scheduledFor`, `publishedAt`, `publishedUrl`, `rejectionReason`, `updatedAt` (optimistic concurrency) | Content review item |
| `OutreachMessage` | `status` (`OutreachStatus`), `draftText`, `aiMetadata`, `rejectionReason`, `type` (`CONNECTION_NOTE` / `FOLLOWUP`), `leadId` | Outreach review item |
| `ContentMedia` | `contentDraftId`, `assetId`, `position`, `altText` | Part of the content fingerprint |
| `CampaignTask` | `relatedContentDraftId`, `status` (`CampaignTaskStatus`: `PENDING`, `GENERATED`, `APPROVED`, `SKIPPED`, `FAILED`) | Follows its draft's approval |
| `AuditLog` | `action`, `metadata` (approval event, version, hash, trace ids) | Audit of each status change |
| `PerformanceSnapshot` | ids only | Joined in the analytics trace rows |
| `Recommendation`, `RecommendationEvidence`, `Opportunity`, `OpportunitySignal`, `Signal`, `Lead`, `LeadSignal`, `User`, `Company` | read only | Context and trace resolution, names |
| `ContentStatus` | `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `PUBLISHED` | |
| `OutreachStatus` | `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `SENT`, `REJECTED` | |

**JSON sub-documents in `aiMetadata`** (on both models unless noted):

| Key | Shape | Owner |
| --- | --- | --- |
| `approval` | `ApprovalRecord` (`model`, `version`, `hash`, `approved`, `rejected`, `events[]`) | `lib/approval.ts` |
| `versions` | `VersionLog` (`model`, `current`, `approved`, `versions[]`) | `lib/versions.ts` |
| `trace` (content only) | `TraceIds` | `lib/trace.ts` |
| `review`, `reviewHistory`, `factCheck`, `quality`, `brief`, `recommendation`, `source`, `contextRevision`, `history` (legacy undo) | read here, written by Content Studio | [../11-content-studio/](../11-content-studio/) |

## 6. API endpoints

The full reference is in [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md). All of these endpoints use session auth through `requireActiveCompany()` and are scoped to the active workspace.

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| GET | `/api/review/:kind/:id` | The ReviewItem: content fields, asset, context, flags, reviewer, approval info, and the actions with reasons. `kind` is `content` or `outreach`. Any other kind gives 404. | any member |
| POST | `/api/review/:kind/:id` | `{ action: 'save', edits: Record<string, string ≤ 20000>, baseUpdatedAt? }` · `{ action: 'regenerate', mode: 'fresh' \| 'fix_review' \| 'instructions', instructions? ≤ 1000 }` · `{ action: 'submit' }` · `{ action: 'approve', confirmed? }` · `{ action: 'reject', reason? ≤ 500 }` · `{ action: 'schedule', scheduledFor? (ISO with offset), localTime? ≤ 32, timeZone? ≤ 64 }`. Returns `{ status, message }`. | per action (section 2). An unconfigured AI writer gives 503. |
| GET | `/api/review/:kind/:id/versions` | Every version, newest first, plus `current` and `approved` | any member |
| POST | `/api/review/:kind/:id/versions` | `{ version: int ≥ 1 }`. Makes that version current as a new version. Returns `{ status, current }`. | content: `content:create`; outreach: `content:approve` |
| GET | `/api/content/drafts/:id/trace` | The resolved `ContentTrace` | any member |
| GET | `/api/analytics/traces?since=ISO&limit=1..500` | One flat trace row per approved or published asset | any member |

Common errors:
- 404 Not found.
- 403 role.
- 409 `stale`, `needs_confirmation`, `review_failed`, `review_needs_human`, `facts_contradicted`, `facts_must_fix`, `facts_need_review`, `concurrent_change`, `changed_after_approval`, "already approved".
- 422 validation.

## 7. External services

This feature calls no third-party API directly. Regenerate (and the automatic re-review it triggers) goes through Content Studio's generator and the outreach drafting service, which call the configured AI provider (`ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY`, in `server/ai/claude.ts`). If no writer is configured, the review POST returns 503 "No AI writer is configured on this server." See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

There is no job of its own. The derived state `scheduled` becomes `ready_for_execution` purely by time (`scheduledFor <= now`). Execution itself is picked up by the scheduler and execution engine, which call `assertContentIntact()` before publishing. Autopilot (`server/briefing/autopilot.service.ts`) can approve drafts under the workspace's auto-approve policy. It records `via: 'autopilot'` and the approval trace.

## 9. Security & permissions

- **RBAC.** Every action re-checks `can(role, …)` in `runReviewAction` and `restoreVersion`, whatever the UI shows. Approval needs `content:approve` (OWNER and ADMIN only). Scheduling needs `content:publish`. VIEWER can only read.
- **Workspace scoping.** Every query filters on `companyId` from `requireActiveCompany()`. Signal lookups for traces are scoped through the parent (`recommendation: { companyId }`, `opportunity: { companyId }`).
- **Validation.** zod schemas on every route: kind enum, discriminated action union, string length caps, ISO datetime with offset, `limit` 1–500.
- **Integrity.** Approvals are bound to a fingerprint. Every execution path refuses content whose fingerprint differs from the approved one (409 `changed_after_approval`), and the screen flags it as a blocker.
- **No double approval.** A conditional `updateMany` on `status` and `updatedAt`, plus "already approved" checks.
- **No silent overwrite.** Saves carry `baseUpdatedAt`, and a stale save gives 409 with the edits kept in the browser.
- **Audit.** Each status change writes an `AuditLog` entry with the approval event and, for approve and publish, the trace ids. The request IP and user agent are passed via `getRequestMeta`.

## 10. Testing

Unit tests (Vitest, `pnpm test`):

| File | Covers |
| --- | --- |
| `tests/review-item.test.ts` | `bodyToFields` per format (LinkedIn post, carousel, email); `applyFields` only touching edited keys; `changedEdits`; the same action set for every item; per-item edit storage with `base`; field order with Postgres key order |
| `tests/approval.test.ts` | Derived states for content, outreach and campaign tasks; transitions (no double approval, executed is final, reopen only); fingerprint order-independence; the 60-event cap and snapshot drop; approval and rejection records; edit after approval; Autopilot attribution; legacy items; outreach |
| `tests/approval-state-machine.test.ts` | `isValidTransition`: the happy path, PUBLISHED only from APPROVED, PUBLISHED terminal |
| `tests/versions.test.ts` | v1 original, numbering, no-op on identical content, restore as a new version, approved marker, the 50 cap keeping original, approved and current, legacy rebuild, undo `basedOn`, outreach |
| `tests/trace.test.ts` | Id stability and uniqueness, the chain, legacy derivation, reviewed version, approval trace |
| `tests/content-review.test.ts` | The AI reviewer model whose verdict the screen shows (owned by Content Studio) |

End-to-end checks (the app must be running; `VERIFY_BASE_URL=http://localhost:3001`):
- `pnpm verify:unified-review`: one shape, edit and stale protection, decide by role, regenerate, outreach limits, queue.
- `pnpm verify:approval`: who can approve, the record, integrity on edit, image and network changes, history, outreach.
- `pnpm verify:versions`: original, kept, approved, restore, outreach.
- `pnpm verify:trace`: recorded, approved, resolved, versions, surviving a deleted recommendation.
- `pnpm verify:review`: AI reviewer states and stale re-review.

## 11. Configuration & limits

| Limit | Value | Where |
| --- | --- | --- |
| Approval events kept per item | 60 (`MAX_EVENTS`), with content snapshots on the newest 15 | `lib/approval.ts` |
| Versions kept per item | 50 (`MAX_VERSIONS`); original, current and approved are never dropped | `lib/versions.ts` |
| History shown on the screen | 25 events | `server/review/review-item.service.ts` |
| Queue size | 100 drafts + 100 messages | `listReviewQueue` |
| Queue snippet | 140 characters | `listReviewQueue` |
| Edit field value | ≤ 20,000 characters | review route |
| Regenerate instructions | ≤ 1,000 characters | review route |
| Reject reason | ≤ 500 characters | review route |
| Outreach field max length | 300 (connection note) / 3,000 (follow-up) | `outreachReviewItem` |
| Trace rows | default 200, max 500 | `traceRows`, analytics route |
| Review POST duration | `maxDuration = 60` s | review route |

There are no feature-specific environment variables.

## 12. Known limitations & future work

- Only two review kinds exist (`content`, `outreach`). Campaign tasks have no item of their own; they follow their draft.
- The trace is kept for content only. Outreach messages have approval records and versions, but no `aiMetadata.trace`, and the **Why this exists** panel appears only for content.
- Fingerprints are fast, non-cryptographic FNV hashes. They detect accidental or bypassing changes, but they are not a tamper-proof signature.
- The approval record and version log live in JSON on the row. History beyond the caps (60 events, 50 versions) is dropped, with the exceptions listed above. The audit log keeps every status change.
- The queue shows at most 100 items per kind and has no pagination.
- Copy-only types (email, ad copy) cannot be scheduled from the screen.
- Outreach editing, submitting and restoring need `content:approve`, so MEMBERs cannot work on outreach.

## 13. Related documents

- [UNIFIED-REVIEW.md](../../../UNIFIED-REVIEW.md)
- [APPROVAL-MODEL.md](../../../APPROVAL-MODEL.md)
- [VERSIONS.md](../../../VERSIONS.md)
- [TRACEABILITY.md](../../../TRACEABILITY.md)
- [CONTENT-REVIEW.md](../../../CONTENT-REVIEW.md), [CONTENT-QUALITY-REVIEW.md](../../../CONTENT-QUALITY-REVIEW.md), [FACT-CHECK.md](../../../FACT-CHECK.md), [CONTENT-COMPLIANCE.md](../../../CONTENT-COMPLIANCE.md)
- [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md), [EXECUTION-ENGINE.md](../../../EXECUTION-ENGINE.md), [EXECUTION-HANDOFF.md](../../../EXECUTION-HANDOFF.md)
- [PRODUCT-DOCUMENTATION.md](../../../PRODUCT-DOCUMENTATION.md)
- Sibling features: [Content Studio](../11-content-studio/), [Media, Graphics & Creatives](../12-media-graphics-and-creatives/)
- Architecture: [02-ARCHITECTURE.md](./02-ARCHITECTURE.md)
