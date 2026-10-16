# Sprint 9 — end-to-end test report (16 October 2026)

The whole Sprint 9 flow was tested on real workspaces against the running app
and the real database, through the same pages and APIs a person uses:

```
Business Context → Opportunity → Recommendation → User Accepts → Content Brief →
Context Assembly → Content Generation → Image Generation → Factual Validation →
AI Quality Review → User Review → Edit / Regenerate → Approve → Ready for Execution
```

Run it all with `VERIFY_BASE_URL=http://localhost:3001 pnpm verify:sprint9:all` (`SUITES=` runs a subset).

## Results

**Unit and integration tests:** all **1,893 pass** across 124 files. Typecheck and lint are clean, and the production build succeeds.

**End-to-end: 25 of 26 suites pass.** The remaining one can't run while the live AI quota is exhausted.

| Test area (from the ticket) | Suites | Result |
| --- | --- | --- |
| Full flow, Business Context → Ready for Execution | `verify:sprint9` | **pass**, 29 checks |
| Recommendation → Creation integration | `verify:creation` | pass, 27 |
| Context assembly | `verify:context-handoff`, `verify:content-brief`, `verify:generation-context` | pass, 51 |
| Content generation | `verify:contextual-generation`, `verify:variations` | pass, 29 |
| Image generation | `verify:graphics`, `verify:visual-context`, `verify:creative` | pass, 59 |
| Factual validation | `verify:fact-check` | pass, 17 |
| Reviewer model | `verify:review`, `verify:compliance` | pass, 36 |
| Approval lifecycle | `verify:approval`, `verify:unified-review` | pass, 32 |
| Versioning | `verify:versions`, `verify:trace` | pass, 22 |
| Permission / RLS (workspace isolation) | `verify:permissions`, `verify:recommendation-security`, `verify:access` | pass, 115 |
| Failure / retry | `verify:failure-recovery` | pass, 12 |
| Content Studio regression | `verify:publishing`, `verify:multi-publish` pass (38 checks). `verify:content-studio` **not run**: it calls the live model directly, and Gemini returned 429 (quota exceeded) | 2 of 3 |
| Campaign / Outreach / Execution | `verify:instagram-api`, plus the unit tests | pass, 24 |
| Responsive UI | `verify:responsive`: 10 pages at 375 / 768 / 1280 px in Chromium, signed in | pass, 30 (screenshots in `.responsive-shots/`) |

## Notes

- **Live AI.** The Gemini key hit its quota during the run. Where a step needs the live model, the suite reports it and continues through the same service calls, and the failure path itself is checked: a clean "Aura's writer is at its limit" message, nothing lost, nothing half-written.
  - Live generation **succeeded** in one run of `verify:failure-recovery`, and the idempotent retry was verified live: the same draft came back, with no duplicate.
  - Live **image generation succeeded** in the full-flow run: a graphic was generated, stored and attached.
  - The AI reviewer and regeneration hit the quota. The reviewer fell back to "needs a person's review" rather than passing.
- **Not tested here:** real social posting or WhatsApp delivery. Those need Meta and LinkedIn credentials.
- `verify:content-studio` should be re-run once the Gemini quota resets.

## Bugs found and fixed while testing

**Permissions** (PERMISSIONS-SECURITY.md)
- A VIEWER could edit drafts or change their network, and submit them for approval.
- A MEMBER could schedule an approved post through the queue.
- VIEWERs and MEMBERs could submit outreach or send it back, and write outreach outcomes.
- Image generation had no workspace, role or plan check.
- Extension tokens could write regardless of role.
- A VIEWER could trigger queued jobs.

**Failure and recovery** (FAILURE-RECOVERY.md)
- Generation could create duplicate drafts on retry.
- A vanished suggestion produced a silent, unlinked draft.
- Raw provider error text was shown to users.
- A dead image run blocked new ones for 10 minutes.
- Approval didn't notice an edit made during the review.
- Saves were last-write-wins.
- Unsaved edits were lost on reload after a conflict.
- Bulk approval hid its failures.
- A session loss gave no way back.
