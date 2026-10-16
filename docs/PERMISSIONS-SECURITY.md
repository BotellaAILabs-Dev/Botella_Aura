# Permission & security validation

Who may create, edit, approve or change marketing assets, and how workspaces
are kept apart. Roles come from `lib/rbac.ts` and are always enforced on the
server.

| Role | Can |
| --- | --- |
| **VIEWER** | Read its workspace. Nothing else |
| **MEMBER** | Draft, edit, generate, attach graphics, submit content for approval |
| **ADMIN / OWNER** | Everything a member can, plus approve, reject, publish and schedule; outreach; deciding suggestions; settings |

## Isolation

- Every route resolves the active workspace from the caller's **own** memberships (`requireActiveCompany`).
- Every asset lookup is scoped by `companyId`: drafts, versions, graphics, recommendations, opportunities, outreach, campaigns, jobs and execution handoffs.
- **An id from another workspace is a 404**, never a 403, so its existence never leaks. This holds for ids in the URL and in the body (`draftId`, `assetId`, `leadIds`, `messageIds`).
- The graphics file route checks membership against the asset's own workspace.

## Fixed in this review

| Severity | Gap | Fix |
| --- | --- | --- |
| High | A VIEWER could edit any draft or change its network, which also un-approved approved work | `PATCH /api/content/drafts/:id` requires `content:create` |
| Medium | A VIEWER could submit drafts, or send approved work back to draft | `transition()` requires `content:create` for any role-bearing move |
| Medium | A MEMBER could schedule, and so effectively publish, an approved post through the queue | Giving an approved post a time needs `content:publish`, as `/schedule` does |
| Medium | VIEWERs and MEMBERs could submit outreach or send it back, un-approving it (single and bulk) | Every outreach status change needs `content:approve`, enforced in `transitionMessage` and both routes |
| Medium | Image generation had no workspace, role or plan check | `generate-image` needs membership, `content:create` and the `imageGeneration` entitlement |
| Medium | Extension tokens held by VIEWERs or MEMBERs could mark outreach sent, mark comments posted, draft comments or overwrite metrics | Marking sent or posted needs `content:approve`; drafting comments and recording metrics need `content:create` |
| Low | A VIEWER could write outreach outcomes, feeding Marketing Memory | Needs `content:approve` |
| Low | A VIEWER could trigger queued generation jobs | Needs `content:create` |

## Verified

- **Automated:** `tests/extension-permissions.test.ts`, `tests/creation-handoff-server.test.ts`, `tests/execution-handoff.test.ts`, plus the existing approval, version and security tests.
- **End to end against the running app and database:** `pnpm verify:permissions`. Two workspaces, every role, real assets.
  - **Isolation:** 18 cross-workspace probes return 404, and B's data is unchanged afterwards.
  - **Roles:** each forbidden action returns 403 and changes nothing.
  - **Approvals:** unauthorised approval fails on every path (status, review, bulk, outreach); admins and owners can approve.
