# Marketing Memory & Analytics — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`4db020e` — feat(dashboard): persistent app shell + settings) |
| Last changed | 13 Oct 2026 (`c39a554`) |
| Commits | 12 |
| Days with changes | 11 |
| Lines in this feature's files | +1,981 / −82 |
| By status | Fresh addition 8, Fix 4 |
| Committed by | dspraneeth07 (7), srbaggari (4), SRBaggari (1) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Sprint 5 – Lead Discovery & Marketing Memory | 1 | 26 Jul |
| Sprint 6 – Campaigns, Analytics, Billing | 1 | 27 Jul |
| Client feedback & UX review | 3 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 3 | 02 Sep – 03 Sep |
| Client requests, image providers & performance | 1 | 07 Sep |
| Sprint 7 – Business Context & Opportunities | 1 | 01 Oct |
| Sprint 9 – Recommendation to Content | 1 | 13 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `4db020e` | Fresh addition | **feat(dashboard): persistent app shell + settings**<br/>Responsive sidebar (mobile drawer), topbar with multi-tenant company switcher and account menu, a premium empty-state overview, and roadmap-driven "Coming in Sprint N" placeholders. Settings edits the company profile (RBAC-guarded, audited) and lists team members. | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `8755674` | Fresh addition | **feat(memory): Module 2 — Marketing Memory / Learning Loop (Sprint 5)**<br/>The retention/moat feature: the product remembers what works and feeds it back into every future generation. | dspraneeth07 | 26-Jul-2026 | 8 |
| 3 | `584923e` | Fresh addition | **feat(analytics): Module 2 — Analytics Dashboard (Sprint 6)**<br/>The client-presentable RESULTS view (distinct from Marketing Memory's learnings). | dspraneeth07 | 27-Jul-2026 | 6 |
| 4 | `cbb746b` | Fix | **fix(extension,metrics): reliable composer injection + honest metrics matching**<br/>extension: inject into LinkedIn's Quill composer/comment box via execCommand('insertText') (goes through the editor's real input pipeline — raw DOM writes get reverted by Quill) with broader selectors + a clearer clipboard fallback ("copied — press Ctrl+V").; | dspraneeth07 | 31-Jul-2026 | 1 |
| 5 | `8e2daed` | Fresh addition | **feat(P1): outreach sequence+stepper, marketing-memory correction, content hashtag separation**<br/>Outreach: messages now render in send order (connection note first, then numbered follow-ups) with a visible progression stepper Draft -&gt; Pending -&gt; Approved -&gt; Queued -&gt; Sent (approve = queued in the extension). Sequence explainer + rejected state.; | dspraneeth07 | 17-Aug-2026 | 4 |
| 6 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 4 |
| 7 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 2 |
| 8 | `b1b1e29` | Fresh addition | **feat(ux): name features after what the user gets, not how they work**<br/>The sidebar read as a menu of product names. "Marketing Memory" tells a marketer nothing. "AI Trend Insights" leads with the implementation. And "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner" were three different features whose names a user could not tell apart. | srbaggari | 02-Sep-2026 | 4 |
| 9 | `36ebc5c` | Fix | **fix(vercel): make the deployment succeed on any plan**<br/>The previous config only deployed on Pro, and the plan was unknown. Both limits that differ between plans are now set to values valid everywhere. | dspraneeth07 | 03-Sep-2026 | 1 |
| 10 | `6689fca` | Fix | **fix(ssr): stop dates breaking hydration in every non-server locale**<br/>Found by driving a real browser against the app and reading the console, which is the only way this shows up — it is silent in the terminal, in tsc, in eslint and in all 438 tests. | SRBaggari | 07-Sep-2026 | 2 |
| 11 | `b6e4763` | Fresh addition | **feat(context): add Business Context Snapshot for AI workflows**<br/>A compact, current, trusted snapshot of the business that AI workflows receive in one call, instead of each querying the sources itself. | srbaggari | 01-Oct-2026 | 1 |
| 12 | `c39a554` | Fresh addition | **feat(trace): recommendation -&gt; content traceability**<br/>Every generated asset keeps the chain from the business opportunity to its approved version (lib/trace.ts, server/trace) in aiMetadata.trace — no migration: | srbaggari | 13-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
