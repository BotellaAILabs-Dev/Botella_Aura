# Recommendation → content traceability

Every generated asset keeps the full chain from the business opportunity to
its approved version. Anyone, person or system, can trace an approved asset
back to:

- why it was created;
- the recommendation that triggered it;
- the opportunity that triggered the recommendation;
- the signals and business context behind them.

```
Business Context → Signal → Opportunity → Recommendation → Content Brief
  → Generated Asset → Reviewed Version → Approved Version
```

| Part                                 | Where                                                            |
| ------------------------------------ | ---------------------------------------------------------------- |
| The chain's ids and types (pure)     | `lib/trace.ts`                                                   |
| Recording, resolving, analytics rows | `server/trace/trace.service.ts`                                  |
| API                                  | `GET /api/content/drafts/:id/trace`, `GET /api/analytics/traces` |
| Shown                                | the review screen's **Why this exists** panel                    |

## What is stored on the asset (`aiMetadata.trace`)

The IDs are written when the asset is generated. They are a snapshot, so the
chain survives even if an upstream record is deleted later.

| Field                                  | Holds                                                                                                    | Set when                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `traceId`                              | One id for the whole chain: what analytics joins on                                                      | generated                                  |
| `businessContext.revision` / `.fields` | The Business Context revision it was generated from, and the context fields the recommendation relied on | generated                                  |
| `signalIds`                            | The signals behind the recommendation: its evidence, plus its opportunity's signals                      | generated                                  |
| `opportunityId`                        | The opportunity                                                                                          | generated                                  |
| `recommendationId`                     | The recommendation                                                                                       | generated                                  |
| `briefId`                              | The Content Brief (`brf_…`, stable for the same brief); the brief itself is kept on the asset            | generated                                  |
| `generatedVersion`                     | 1, the original AI version ([VERSIONS.md](VERSIONS.md))                                                  | generated                                  |
| `reviewedVersion` / `reviewId`         | Which version the last review was of, and that review (`rvw_…`)                                          | each review                                |
| `approvedVersion` / `approvalId`       | Which version was approved, and the approval (`apv_…`, also stored on the approval record)               | each approval, by a person or by Autopilot |
| `mediaAssetIds`                        | The images attached when it was approved                                                                 | each approval                              |

The asset ID is the draft's own ID.

**Across versions.** Edits, regenerations, variations and restores keep the
chain. After an edit, the trace still names the version that _was_ approved
until it is approved again. A new approval moves it to the new version with
a new approval ID.

**Assets created before traces existed** are traced from the provenance and
brief they already carry.

**Assets made from a person's own brief** (not a recommendation) trace to
that request and the business context.

## Resolving the chain

`resolveTrace` and `GET /api/content/drafts/:id/trace` return the story with
live records:

- **why**: the recommendation's rationale, or the person's request;
- the business context: name, description, the fields relied on, revision;
- the signals: title, source and link;
- the opportunity and the recommendation, including who accepted it;
- the brief: key message, goal, audience, channel;
- the generated, reviewed and approved versions, with who approved and when;
- where it was published.

If a live record is gone, the stored snapshot still names it and the gap is
reported.

## For analytics and measurement

- `GET /api/analytics/traces?since=&limit=` returns one flat row per approved
  or published asset: every ID above, plus `approvedAt`, `publishedAt`,
  `publishedUrl` and the asset's `performanceSnapshotIds`. Join on `assetId`
  or `traceId`.
- Every **approval** and **publish** audit entry carries the chain's IDs:
  `traceId`, recommendation, opportunity, brief, approval, approved version.

## Checking it

```bash
pnpm test tests/trace.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:trace
```
