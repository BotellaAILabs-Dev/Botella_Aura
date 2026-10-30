# Business Context & About My Business — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 29 Sep 2026 (`b3c4f0f` — feat(context): add unified Business Context data model) |
| Last changed | 17 Oct 2026 (`73b0ad3`) |
| Commits | 11 |
| Days with changes | 6 |
| Lines in this feature's files | +8,953 / −138 |
| By status | Fresh addition 9, Fix 2 |
| Committed by | srbaggari (11) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 7 – Business Context & Opportunities | 9 | 29 Sep – 02 Oct |
| Sprint 8 – Recommendations | 1 | 08 Oct |
| Sprint 10 – Connections & Execution | 1 | 17 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `b3c4f0f` | Fresh addition | **feat(context): add unified Business Context data model**<br/>One structure for everything Aura knows about a workspace's business, so onboarding, AI workflows, recommendations, content, analytics and memory read the same facts through the same rules. | srbaggari | 29-Sep-2026 | 4 |
| 2 | `c8bbf70` | Fresh addition | **feat(context): add Business Context service with validated updates**<br/>Aura features now read and write business information through one service instead of each keeping its own copy. | srbaggari | 30-Sep-2026 | 8 |
| 3 | `ea0f2af` | Fresh addition | **feat(context): add source, confidence and freshness to business facts**<br/>Every business fact Aura uses is now traceable to where it came from and how reliable and current it is, and AI workflows never receive an unconfirmed assumption as a verified fact. | srbaggari | 30-Sep-2026 | 8 |
| 4 | `b6e4763` | Fresh addition | **feat(context): add Business Context Snapshot for AI workflows**<br/>A compact, current, trusted snapshot of the business that AI workflows receive in one call, instead of each querying the sources itself. | srbaggari | 01-Oct-2026 | 4 |
| 5 | `720c22e` | Fresh addition | **feat(context): connect existing Aura sources to the Business Context layer**<br/>Audit every existing store of business information, map it into the unified context, connect the remaining AI workflows to the context service, and prove no business information is lost. | srbaggari | 01-Oct-2026 | 8 |
| 6 | `4015d13` | Fresh addition | **feat(business): turn About My Business into the view of the Business Context**<br/>A new About my business page (/dashboard/business) is the user-facing representation of the trusted Business Context: what Aura knows about the business, where each detail came from, how current it is, and what is missing — editable in place. | srbaggari | 01-Oct-2026 | 4 |
| 7 | `8a1e822` | Fix | **fix(business): stale-revision conflicts, no-op saves, rejected company names**<br/>About My Business: a second edit saved before router.refresh() had delivered new props sent the old revision and was refused with 409, showing "someone else changed this page" for the user's own edit. The page now takes the new revision from the save response.; | srbaggari | 01-Oct-2026 | 2 |
| 8 | `a3e3568` | Fix | **fix(context): stop concurrent writes erasing each other; ignore whitespace-only "changes"**<br/>Lost updates: Company.preferences is one JSON bag written by read-merge-write from both the Business Context write service and the autopilot settings route. Overlapping writes let the later one erase the earlier (e.g. a goal edit vanishing while AI voice generation saved). | srbaggari | 01-Oct-2026 | 2 |
| 9 | `00470c4` | Fresh addition | **feat(context): ask for missing business information instead of assuming**<br/>Aura detects important missing or doubtful business context and asks targeted questions; answers update the Business Context. | srbaggari | 02-Oct-2026 | 6 |
| 10 | `bb6ad7e` | Fresh addition | **feat(recommendations): empty and insufficient-data states**<br/>Aura says clearly when it does not have enough information to recommend, gives one next step for each gap, and never fills the page with a generic suggestion (lib/data-readiness.ts). | srbaggari | 08-Oct-2026 | 3 |
| 11 | `73b0ad3` | Fresh addition | **feat(connections): Connection Manager, connection flow, capabilities, token lifecycle, health**<br/>Connection Manager data model: provider, channels, provider account id, granted scopes, credential reference, setup stage, health, execution history, capabilities; ConnectedAccount table for provider -&gt; account -&gt; page relationships; LinkedIn mirrored without its token; REVOKED status. | srbaggari | 17-Oct-2026 | 3 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
