# Recommendation Quality Validation

Every recommendation is checked **right before it is shown**, however it was
written (engine template, AI model, or a person's edits) and however things
have changed since: its opportunity turned down, its evidence expired, the
business profile edited. Unsupported, invented or contradicted
recommendations are never presented as trusted.

| Piece | Where |
| --- | --- |
| The checks and the verdict (pure) | [`lib/recommendation-quality.ts`](../lib/recommendation-quality.ts) |
| Loading (evidence, opportunity, business profile) | [`server/recommendations/quality.service.ts`](../server/recommendations/quality.service.ts) |
| Before presentation | `getSuggestions` ([`suggestions.service.ts`](../server/recommendations/suggestions.service.ts)), which feeds Aura Suggests and Home |
| On creation | the automatic suggestion pass ([`autosuggest.service.ts`](../server/recommendations/autosuggest.service.ts)) |
| API | `GET /api/recommendations/:id/quality` → `{ quality }` |
| Tests | [`tests/recommendation-quality.test.ts`](../tests/recommendation-quality.test.ts) (hallucinated and unsupported cases); `pnpm verify:quality` (real engine output, real presentation path) |

This is in addition to the engine's own checks when it writes a
recommendation (`checkSupport`, `validateAiRecommendation`,
[RECOMMENDATION-RULES.md](RECOMMENDATION-RULES.md)). Those only run once. This
gate runs every time a recommendation is shown.

---

## The checks

Each check is **pass**, **warn** or **fail**, always with its reasons in
plain words.

| Check | Fails (blocked) | Warns (needs review) |
| --- | --- | --- |
| **schema** | Breaks the defined Recommendation schema (empty headline, too many steps, unknown channel or format). Said in words, never as validator output | — |
| **business_context** | Aura doesn't know what the business does. Mentions a topic the business avoids (brand voice "topics to avoid"). States a **figure no evidence or profile contains** (hallucinated stat). Names a **competitor the business doesn't track** and no evidence mentions | — |
| **evidence** | No evidence. Evidence that **can't be traced** to a signal, an opportunity's evidence, a record or a source URL | Some evidence untraceable. Nothing current any more. Not enough of the right kind (`MIN_EVIDENCE`, e.g. a competitive response needs a competitor signal) |
| **opportunity** | Not linked to an opportunity of this business. Still waiting for an answer while its opportunity was already **turned down or expired** | None of its evidence comes from its opportunity |
| **actionability** | No real action. Content with nowhere to publish | A vague action ("Consider…", "Leverage synergies…"). Something blocks execution (a channel that can't be connected) |
| **expected_outcome** | Missing. **Promises a result** ("guaranteed", "will double", "go viral", "skyrocket") | Generic ("Progress on this opportunity."). Can't be measured |
| **channel** | A channel Aura doesn't support (e.g. TikTok) | One the business hasn't said it uses. One Aura can't connect yet |
| **confidence** | — | Low confidence. High confidence claimed on evidence that is all low-reliability |

## The verdict, and what happens

| Verdict | When | Effect |
| --- | --- | --- |
| **Trusted** | Every check passes | Shown, with a small "Checked" mark |
| **Needs review** | Warnings only | Shown, marked **"Needs your review"**, with "Check before you act on it:" and the warnings. Never shown as trusted |
| **Blocked** | Any failure | **Not shown.** Owners and admins see it under "Held back by Aura's quality checks", with a plain reason |

## Invalid recommendation handling

- **Before presentation:** a waiting suggestion that fails is held back from
  Aura Suggests and Home. It stays stored, so if it was blocked by something
  fixable (the profile, the opportunity), it can pass again later.
- **On creation:** when the automatic pass writes a suggestion that fails, it
  is withdrawn at once. Its history records "Failed Aura's quality checks: …"
  (source `system`, with the problems in the metadata). The repeat hold
  ([RECOMMENDATION-HISTORY.md](RECOMMENDATION-HISTORY.md)) stops the same
  suggestion being written again the next day.
- **Already answered:** a recommendation the business already accepted is
  never hidden, but it still carries its verdict.

## Tests for hallucinated and unsupported recommendations

`tests/recommendation-quality.test.ts` starts from a well-supported
recommendation (trusted) and breaks one thing at a time.

**Blocked:**
- an invented statistic (300%), or an invented figure in the reasoning
  (4,500)
- an untracked competitor, or an avoided topic
- no evidence, or untraceable evidence
- no opportunity, or a rejected or expired one
- an unsupported channel, or no channel for content
- promised results ("guaranteed", "go viral", "skyrocket")
- no action or outcome, or broken schema
- an unknown business

**Needs review:**
- low confidence, or high confidence on low-reliability evidence
- stale or wrong-kind evidence, or evidence not from its opportunity
- a vague action, or a generic or unmeasurable outcome
- an unused channel, or something blocking execution

**Not wrongly flagged:** figures that do appear in the evidence, and accepted
recommendations whose opportunity was accepted with them.

`pnpm verify:quality` proves the same on the real engine's output, through the
real presentation path:
- the engine's suggestions aren't blocked
- a hallucinated figure edited in gets the suggestion held back, with the
  reason
- a turned-down opportunity's suggestion is held back
- a new suggestion breaking the business's topics to avoid is withdrawn on
  creation, with the reason in its history

## Acceptance criteria

| Criterion | How |
| --- | --- |
| Unsupported recommendations are not surfaced as trusted | Blocked ones are not shown. Ones with warnings are shown only as "Needs your review" |
| Recommendations have traceable evidence | The evidence check fails any recommendation with no evidence, or none traceable to a signal, opportunity evidence, record or source; partial gaps are flagged |
| Recommendation output follows the defined schema | The schema check validates every recommendation against `recommendationContentSchema` before it is shown |
| Quality checks run before presentation | In `getSuggestions`, the single path to Aura Suggests and Home, and again right after the automatic pass writes a suggestion |
