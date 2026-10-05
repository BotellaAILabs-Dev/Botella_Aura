# Sprint 7 Test Report: Business Context → Signal → Opportunity

Validation of the complete Business Context → Signal → Opportunity flow before
Sprint 8 (Recommendations). Run on 5 October 2026 against the local database
and a running app.

**Result: everything passes.**

| Suite | Result |
| --- | --- |
| Unit and component tests (`pnpm test`) | **867 / 867 pass**, 71 files |
| Typecheck (`tsc --noEmit`) | Clean |
| End-to-end flow (`pnpm verify:flow`, new) | **33 / 33** |
| Database checks (onboarding, signals, opportunities, detection, AI detection, hand-off) | **122 / 122** |
| Security, end to end over HTTP (`pnpm verify:access`) | **38 / 38** |
| Every dashboard page renders (`pnpm verify:pages`) | **37 / 37** routes |
| No business information lost (`pnpm verify:context-sources`) | Pass |

---

## End-to-end test

`scripts/verify-flow.ts` walks the whole flow in one throwaway workspace,
through the real services. It starts from a business created by the real
onboarding service, not hand-written rows.

| Stage | What is checked | Checks |
| --- | --- | --- |
| **User / existing data** | A user onboards a business that already has trend keywords and stories, a competitor with two captured changes, two results periods and a learned pattern | 2 |
| **Business Context** | Resolves with what onboarding captured. Each fact has its source, confidence and freshness. Keywords and competitors are included. | 4 |
| **Missing information** | A missing value (what the business sells) becomes a question. Nothing is asked about what onboarding answered. Answering closes the question. | 3 |
| **Context Snapshot** | Matches its schema and carries confirmed facts ready for a prompt. It is served from storage while current, and rebuilt (new fingerprint) when the context changes. | 4 |
| **Signals** | All five sources are normalised. Each keeps its record, time and reliability with a reason, and matches to the business where relevant. | 3 |
| **Signal Aggregation** | The same story in two digests is one signal seen twice. Collecting again adds nothing. | 2 |
| **Opportunity Detection** | Competitor, trend, results and pattern rules fire. AI detection (scripted model) stores the valid opportunity and rejects one with an invented figure. Low-reliability chatter is ignored. | 4 |
| **Opportunity** | One record per opening, no duplicates when detected again, and full status history | 3 |
| **Evidence + Confidence** | All evidence links to a real signal. Confidence (with reason), impact and effort are stored. No low-confidence opportunity is high priority. The AI opportunity records its snapshot and the model's confidence. | 4 |
| **Ready for Recommendation Engine** | Every open opportunity hands off cleanly. A recommendation references its opportunity and carries its evidence, and the opportunity becomes Recommended. | 3 |
| Cleanup | The throwaway workspace and user are removed | 1 |

## Coverage by task

| Task | Unit tests | Database / end-to-end checks |
| --- | --- | --- |
| **Business Context** | `business-context` 31, `business-context-service` 30, `business-facts` 30, `context-sources` 15 | `verify:context-sources` (no information lost); flow stage 1 |
| **Opportunity model** | `opportunities` 17, `opportunity-ui` 17, `recommendation-handoff` 11 | `verify:opportunities` 20, `verify:recommendation-handoff` 19; flow stages 7 and 9 |
| **Signal normalisation** | `signals` 17 | `verify:signals` 21; flow stages 4–5 |
| **Context snapshot** | `context-snapshot` 25 | Flow stage 3 |
| **Missing information** | `context-questions` 28 | Flow stage 2 |
| **Opportunity detection** | `opportunity-detection` 25 | `verify:detection` 15; flow stage 6 |
| **AI output validation** | `ai-opportunity-detection` 21 | `verify:ai-detection` 21; flow stage 6 |
| **RLS / security** | `data-access-security` 42, `safe-links-render` 2, `tenant-isolation` 5 | `verify:access` 38 (two businesses, owner and viewer, over HTTP) |
| **Integration** | — | `verify:flow` 33: the whole flow, plus each stage's own suite |
| **Regression: onboarding and context** | `onboarding` 29, `about-my-business` 14, `audience-save` 7, `brand-context` 15, `content-audience` 8, `materials` 27, `marketing-memory` 10, `company-service` 3 | `verify:onboarding` 26; `verify:pages` 37 routes; `verify:context-sources` |

## Notes

- **AI detection** was tested with a scripted stand-in for the model. The local
  `ANTHROPIC_API_KEY` is empty, so no live model call was made. One live run is
  recommended once a key is configured.
- **`verify:onboarding`** temporarily edits the oldest workspace (the demo) and
  restores its settings afterwards, as designed. All other checks use
  throwaway workspaces that are deleted afterwards.
- **Lint:** clean for everything changed in Sprint 7. The project-wide run
  still reports 41 errors in three files this sprint did not touch:
  `scripts/verify-briefing.ts`, `scripts/verify-graphics.ts` and
  `tailwind.config.ts`.
- **Known follow-up** (from the security review): apply safe-link handling on
  the leads, outreach and engagement pages
  ([DATA-ACCESS-SECURITY.md](DATA-ACCESS-SECURITY.md)).
- **Demo data:** the demo workspace's trend data is from mid-September, so the
  Market trends page shows no current digest for it. That is the data, not a
  defect.

## How to rerun

```bash
pnpm test                         # unit and component tests
pnpm verify:flow                  # the end-to-end flow
pnpm verify:context-sources
pnpm verify:signals
pnpm verify:opportunities
pnpm verify:detection
pnpm verify:ai-detection
pnpm verify:recommendation-handoff
pnpm verify:onboarding
# With the app running (pnpm dev):
AURA_URL=http://localhost:3000 pnpm verify:access
VERIFY_BASE_URL=http://localhost:3000 pnpm verify:pages
```
