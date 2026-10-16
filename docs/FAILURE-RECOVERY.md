# Failure & recovery

What happens when generation, review, images, saving or approval fails:
- Work is never lost.
- Failures can be retried where retrying makes sense.
- Retries never duplicate anything.
- Every failure is visible, explained and logged.

| Scenario | What happens now | Work preserved | Retry | Duplicates prevented |
| --- | --- | --- | --- | --- |
| **Text generation fails** | The draft row is written only after writing succeeds. A provider outage or quota becomes one plain message ("Aura's writer is at its limit right now… Nothing was changed"), 503, logged, and never raw provider text | The brief stays in the form and in sessionStorage, which survives a lost session or reload | Yes | **Idempotency key per open form:** a retry after a timeout returns the draft already written. `maxDuration` 60 |
| **Refine / regenerate fails** | 503 with the plain message. The draft is unchanged | Yes, with the previous body in history | Yes | A rewrite only applies to the version it started from. A concurrent rewrite or edit gets 409, never silently dropped |
| **Image generation fails** | The job stores the error. It is requeued up to 3 times unless permanent. Retry or switch model in the studio | Prompt, job inputs and partial images are kept | Yes | Lock plus per-draft dedupe, atomic claim, resume pays only for the shortfall. **A dead run is replaced after 3 minutes of no activity**, not 10, while a long run that is still progressing is reused |
| **Reviewer fails** | The review is marked unavailable and needs a person's acknowledgement to approve. **At approval the AI is tried again** before falling back | The review never touches the body | Yes | — |
| **Quality / fact check fails** | Deterministic checks; the exact blocking issue or claim is returned (409 with a code). Infrastructure errors are logged | Yes | Yes | — |
| **Context unavailable** | A missing business context degrades gracefully; an incomplete brief is a 409 with a fix link | Yes | Yes | — |
| **Recommendation outdated or gone** | Closed: 409 with its reason and fix. **Gone or not this workspace's: 409 "no longer available", never an unlinked generic draft** | Brief kept | Yes, without it | — |
| **User loses session** | APIs answer 401 JSON: "Not signed in. Sign in again — your work on this page is kept." The toast has a **Sign in** button that returns to the page. Graphic Studio stops polling and says the run continues | Review edits in localStorage, generate briefs in sessionStorage | After signing in | — |
| **Save fails** | **No last-write-wins:** a save on an older version gets 409 "Your edits are kept here — reload… then apply them again". Writes are conditional on the version read | Unsaved review edits are kept **per item** and restored after reload, with a note when they were made on an earlier version | Yes | — |
| **Approval fails** | Specific 409 codes (`review_failed`, `facts_need_review`, `concurrent_change`, `duplicate`). **Approval only applies to the version that was reviewed:** an edit during the review makes it a conflict. The review screen refreshes to the true state after a refusal | Yes | Yes | Duplicate approvals are blocked by the status-and-version-conditional write. Bulk approval stops in time and returns the rest as `notProcessed`, safe to rerun |

## Messages and logging

- **Plain messages:** errors are shared by `lib/client-failure.ts`.
  - A 401 shows a Sign in button.
  - A server-provided `fix` is shown as a button.
  - Network errors say "nothing was changed".
- **No raw provider text:** `lib/api.ts` maps any AI provider failure to the plain message.
- **What's logged:**
  - provider failures and 5xx responses (`captureException`)
  - refusals with a reason code (`route: refused`)
  - bulk transitions that left items unchanged
- **Bulk approval in the UI** shows each failed item's real reason and keeps the failed ones selected for a one-click retry.

## Verified

- **Automated:** `tests/failure-recovery.test.ts` (idempotent generation, a vanished suggestion, provider outage and quota, history-recording failure), `tests/job-dedupe.test.ts` (dead vs progressing image runs), `tests/review-item.test.ts` (per-item edit storage).
- **End to end:** `pnpm verify:failure-recovery`, against the running app and database.
  - Stale saves are refused with edits kept; the duplicate approval is refused.
  - A vanished suggestion gets 409 and no draft.
  - A live retry with the same key returns the same draft.
  - Bulk refusal reasons are returned; a lost session gets 401 JSON.
