# Factual validation

Before content is presented as ready for approval, every claim it makes is
checked against what Aura trusts about the business — and anything it cannot
verify is shown as needing review, never as checked.

- Rules (pure): `lib/fact-check.ts`
- Run for a draft: `server/content/fact-check.service.ts` (`factCheckDraft`)
- Shown: the draft page's **Fact check** panel and a **Needs fact review** /
  **Contradiction** badge
- Enforced: approval (`transition` in `server/content/content.service.ts`)

The check is computed from the current context whenever the draft page loads
and at approval — so it is never stale after an edit, a rewrite, a version
switch or a change to the business details.

## 1. Claims are extracted

Each sentence that asserts something checkable is a claim:

| Kind     | Example                                                         |
| -------- | --------------------------------------------------------------- |
| number   | "a 250g bag costs $18.50", "prices rose 15%"                    |
| date     | "this year", "since 2014", "in 2023"                            |
| absolute | "the only", "award-winning", "guaranteed", "#1", "certified"    |
| business | "we roast…", "we ship…", "our subscriptions are…"               |
| market   | "prices rose", "demand grew", a competitor named in Competitors |
| contact  | links, email addresses, handles                                 |

Questions and calls to action assert nothing and are not checked.

## 2. Compared against what Aura trusts

| Source                                                                         | Trusted? | Dated?           |
| ------------------------------------------------------------------------------ | -------- | ---------------- |
| The business profile — the current Business Context Snapshot's confirmed facts | yes      | current          |
| The recommendation's evidence                                                  | yes      | when it was seen |
| The business's own documents the draft was written from                        | yes      | —                |
| The person's brief                                                             | yes      | —                |
| The snapshot's assumptions (present, not confirmed)                            | **no**   | —                |

A claim with figures is backed only when a source states every figure, about
the same thing. A claim without figures is backed only when the source covers
most of what it says — sharing "coffee subscriptions" with the profile does not
back "we ship them to Europe". An absolute must appear in the source itself.

## 3. Each claim gets a status

| Status                               | Meaning                                                                                                                  | Approval          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **Supported**                        | a trusted source carries it                                                                                              | —                 |
| **Contradicted**                     | a trusted source about the same thing states a different percentage, price or year ("Says 15%, but evidence … says 30%") | **must fix**      |
| **Unsupported** — figure or absolute | nothing backs a number, price, date or "the only / award-winning"                                                        | **must fix**      |
| **Unsupported** — statement          | nothing backs a statement about the business                                                                             | approver confirms |
| **Unconfirmed**                      | only an unconfirmed detail backs it                                                                                      | approver confirms |
| **Possibly outdated**                | backed only by evidence seen more than 180 days ago, or marked stale — for market, date and number claims                | approver confirms |

The piece is **Fact-checked** only when every claim is supported;
**Needs review** when any is not; **Contradiction** when one conflicts.

## 4. Never approved as verified

- A must-fix claim blocks approval with the claim and the reason — even if the
  approver ticks the box.
- Otherwise, a piece that needs review can be approved only when the approver
  ticks "I've checked the N claims Aura could not verify … and they are true".
- The approval records the fact check (status, counts, the claims vouched for,
  and who vouched); the audit entry records how many claims the approver
  reviewed.
- A piece whose claims all check out approves directly.

The older quality check now counts the recommendation's evidence as material
too, so a figure the evidence states is not flagged by one check and accepted
by the other.

## Checking it

```bash
pnpm test tests/fact-check.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:fact-check
```
