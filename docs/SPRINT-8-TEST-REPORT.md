# Sprint 8 — End-to-End Test Report

Covers the full Sprint 8 flow:

Business Context → Signals → Opportunity → Recommendation Engine → Recommendation
Validation → Prioritization → Aura Suggests → Aura Home → User Accepts / Edits / Skips /
Rejects → Recommendation History → Ready for Sprint 9 Creation.

Run against the local app (`next dev -p 3001`) and the local Postgres database. Every
script creates its own throwaway user and workspace and deletes them afterwards; no
existing data is changed.

## How to re-run

```bash
pnpm typecheck && pnpm lint && pnpm test          # unit + static checks
npx tsx scripts/verify-<name>.ts                  # one DB-level suite
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:sprint8   # the whole flow, on the running app
```

`verify:sprint8` needs the app running. For the AI-quality stage to use the live model,
run it with the environment loaded (`node --env-file=.env node_modules/tsx/dist/cli.mjs
scripts/verify-sprint8.ts`); without a key that stage checks the template fallback instead.

## Results

| Area (ticket task)                           | How it is tested                                                       | Result            |
| -------------------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| Unit testing                                 | vitest — 87 files                                                      | 1260 / 1260 pass  |
| Type safety / lint                           | `tsc --noEmit`, eslint                                                 | clean, 0 errors   |
| Full flow, end to end                        | `verify:sprint8` — 12 stages on the running app, one real user         | 29 / 29 pass      |
| Recommendation generation                    | `verify:engine`, `verify:recommendations`, `verify:guardrails`         | pass              |
| Opportunity → Recommendation integration     | `verify:recommendation-handoff`, `verify:autosuggest`, `verify:flow`   | pass              |
| Lifecycle (accept / edit / skip / reject)    | `verify:lifecycle`, sprint8 stage 9 (via the API, incl. idempotency)   | pass              |
| Prioritization                               | `verify:prioritization`, sprint8 stage 6                               | pass              |
| Aura Suggests / Aura Home / What matters now | `verify:suggestions`, `verify:home`, `verify:what-matters`             | pass              |
| History & repeat prevention                  | `verify:history`, sprint8 stage 10                                     | pass              |
| Context handoff (Sprint 9 readiness)         | `verify:context-handoff`, `verify:modules`, sprint8 stage 11           | pass              |
| Empty / insufficient data states             | `verify:readiness`, sprint8 stage 0                                    | pass              |
| AI quality                                   | `verify:quality`, `verify:ai-detection`, sprint8 stage 12 (live model) | pass — see note 1 |
| Security / RLS                               | `verify:recommendation-security` (22), `verify:access`, static tests   | pass              |
| Regression — earlier sprints                 | onboarding, signals, opportunities, detection, context-sources         | pass              |
| Existing Dashboard regression                | `verify:pages` — every dashboard page renders                          | 39 / 39 ok        |
| Responsive UI                                | Chrome at 375 / 768 / 1280 px, 7 key pages (see below)                 | 21 / 21 clean     |

### Responsive UI

Pages: Aura Home, Aura Suggests, Suggestion history, Opportunities, Content Studio opened
from a suggestion (`?rec=`), About my business (`?ask=`), Plan a campaign (`?rec=`).

At phone (375×812), tablet (768×1024) and desktop (1280×800), each page was checked for:
an HTTP 200, no error boundary, no sideways scrolling (page wider than the screen), no
JavaScript errors and no failed requests. A full-page screenshot was reviewed for each.
All 21 combinations were clean: cards stack on phone, action buttons wrap, and the side
navigation collapses into the menu.

## Notes

1. **Live AI quota.** On the final run the Gemini key returned `429 — You exceeded your
current quota`. Aura behaved as designed: it retried, fell back to its template
   suggestion, and the quality check marked it `needs_review`. An earlier run on the same
   day completed with the live model (`written by ai:gemini-flash-latest`, passed
   validation). If the deployed site uses the same key, AI-written text will fall back to
   templates until the quota resets or the plan is raised.
2. **No favicon.** Browsers request `/favicon.ico` on first load and get a 404. Cosmetic,
   pre-existing, and unrelated to Sprint 8; worth adding an `app/icon.png` later.

## Ready for Sprint 9

Accepted and edited suggestions produce a valid, versioned context handoff that Content
Studio opens with the brief prefilled and the recommendation panel shown; skipped and
rejected suggestions are not handed over. Sprint 9 creation work can build on
`buildContextHandoff` / `handoffToContentRequest` (see `RECOMMENDATION-CONTEXT-HANDOFF.md`).
