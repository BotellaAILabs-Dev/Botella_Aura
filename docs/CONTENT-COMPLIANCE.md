# Content compliance & policy checks

Every draft is checked against configurable rules for its content and channel
before it can be submitted or approved. Content that needs extra review is
flagged, and a failed check stops it from being marked ready.

| Part                                       | Where                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Rules, packs, the check (pure)             | `lib/compliance-policy.ts`                                                                                 |
| The workspace's policy (load, save, reset) | `server/content/compliance.service.ts`                                                                     |
| Settings → Compliance                      | `app/dashboard/settings/compliance`, `components/dashboard/settings/compliance-form.tsx`                   |
| API                                        | `GET` / `PUT` / `POST /api/company/compliance`                                                             |
| Run and enforced                           | inside the AI Reviewer (`server/content/review.service.ts`), enforced on submit and approve (`transition`) |

## 1. Where the rules live

The rules are **data, not prompt text**.

- **The workspace's policy** is stored in `Company.preferences.compliancePolicy`
  and edited in Settings → Compliance. Only owners and admins can change it.
  Every save is validated and audited (`COMPANY_UPDATED`, section
  `compliancePolicy`). Until the workspace saves its own, these defaults apply:
  - the general advertising pack is on;
  - alcohol rules follow the business (automatic);
  - **"Terms apply."** is required on any promotion;
  - for an alcohol business, **"Please enjoy responsibly."** is required on
    everything;
  - competitor mentions and giveaways go to a person.
- **Built-in rule packs** (`PACKS`) are switched on and off per workspace:
  general advertising, alcohol, health & wellness, financial.
- **Channel restrictions** (`CHANNEL_RULES`) apply to every workspace.
- **The existing checks** are folded in under the same categories: the
  alcohol code, never-mention topics, length and CTA rules
  (`lib/content-quality.ts`), and the fact check (`lib/fact-check.ts`).

**The writer is given the same rules.** `policyToPrompt` turns the policy into
the writer's instructions in `loadWritingContext`, so drafts are written to the
rules as well as checked against them.

## 2. What is checked

| Category                     | Checks                                                                                                                                                                                                                                                                                                                                                                  | Outcome   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **Prohibited claims**        | Built-in: "risk-free", "miracle", "get rich", "instant results" (fail); a guarantee (review). Health pack: cure/treat/prevent claims (fail); "clinically proven" or "FDA-approved" (review). Financial pack: guaranteed returns (fail). Alcohol pack: free drinks (review). The workspace's own words (block or review, whole words only). The alcohol code (fail).     | as set    |
| **Required disclaimers**     | Each disclaimer applies always, on a promotion (discount, sale, coupon, giveaway…), or when chosen words appear. It can be limited to some formats. If missing it either blocks or needs review. The usual variants count ("T&Cs apply", "drink responsibly"). Financial pack: a risk warning whenever returns or investing are mentioned.                              | as set    |
| **Channel restrictions**     | Instagram/Facebook giveaway without the "not sponsored, endorsed or administered by…" wording (fail). Engagement bait on Facebook, Instagram or LinkedIn (review). Links in Instagram captions (advice). Ads that assert personal attributes (fail). Alcohol ads: age targeting (review). Shouting email subjects (advice). Length and hashtag limits (from the rules). | as listed |
| **Business rules**           | The brand's never-mention topics.                                                                                                                                                                                                                                                                                                                                       | fail      |
| **Call to action**           | CTA phrases the business never uses (fail). Formats that must carry a CTA (fail). Links to domains other than the business's website, its subdomains or allowed domains (review). The format's own CTA rule.                                                                                                                                                            | as listed |
| **Factual & product claims** | Each fact-check claim: a must-fix claim (contradicted, or an unsupported figure or absolute) fails; an unverified, outdated or unsupported statement needs review.                                                                                                                                                                                                      | as listed |
| **Manual review**            | Formats or channels that always need a person; chosen words; a named competitor; a stated price; a giveaway or contest.                                                                                                                                                                                                                                                 | review    |

Every finding records:

- the **rule** that raised it (a stable `ruleId`);
- its **category**;
- its **outcome**: `fail`, `review` or `warn` (advice);
- the **sentence** it is about;
- **how to fix** it;
- its **source**: built-in, workspace, rules or fact check.

The report also counts how many checks ran in each category.

## 3. Before approval

The checks run as part of the AI Reviewer
([CONTENT-REVIEW.md](CONTENT-REVIEW.md)): when a draft is generated or
rewritten, when **Review again** is clicked, and on submit and approval if the
stored review is out of date.

Policy findings feed the review's dimensions:

| Category                                                      | Review dimension |
| ------------------------------------------------------------- | ---------------- |
| Prohibited claims, disclaimers, business rules, manual review | Compliance       |
| Channel restrictions                                          | Channel fit      |
| Call to action                                                | Call to action   |
| Factual & product claims                                      | Accuracy         |

What each outcome does:

| Outcome | Effect                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| fail    | The review **fails** — submitting and approving are refused (409) until it is fixed or regenerated, whatever the AI reviewer scored. |
| review  | The review **needs human review** — marked on the page and in the queue; the approver must confirm before approving.                 |
| warn    | Shown as advice; changes nothing.                                                                                                    |

**A review is tied to the rules it ran under.** It is stored with a
fingerprint of the policy (`policyHash`). When the rules change, every review
becomes out of date: the page says so, and the next submit or approval
re-checks the piece under the rules now in force.

## 4. Settings → Compliance

The page has six sections:

- **Rule packs**: general advertising, alcohol (automatic / always / off),
  health, financial.
- **Words and claims you never use**: each with block or review, and a reason
  shown to the writer and the approver.
- **Required disclaimers**: the text, when it applies, which formats, and
  whether a missing one blocks or needs review.
- **Always send to a person**: competitors, giveaways, prices, formats,
  channels, words.
- **Calls to action and links**: CTAs never to use, other allowed domains,
  formats that must have a CTA.
- **Try the rules**: checks a piece of copy against the rules on screen, saved
  or not, without storing anything.

Members see the page read-only. **Reset to defaults** restores the starting
policy.

## Checking it

```bash
pnpm test tests/compliance-policy.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:compliance
```
