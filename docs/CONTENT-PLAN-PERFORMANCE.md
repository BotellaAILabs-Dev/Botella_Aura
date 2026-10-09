# Content Plan — monthly calendar generation

How the monthly calendar is generated, why it used to hang, and the guarantees
it now makes. Code: `server/planner/calendar-draft.ts` (drafting),
`server/planner/plan.service.ts` (context and saving), `server/jobs/` (the
background job), `components/dashboard/jobs/` (progress in the browser).

## Why it hung at "Monthly calendar – 35%"

| Cause                                                                                              | Effect                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The whole month was **one** high-effort model call writing every slot (up to 8,000 output tokens). | The month waited on the longest answer the model could give. Progress sat at 35% for the whole call.   |
| Thinking shares the output budget (Gemini especially).                                             | A long answer could be cut off mid-JSON, fail validation, and the **whole month** was asked for again. |
| Retries stacked: 3 attempts × 2 minutes inside the client, ×2 for a schema retry.                  | One bad month could take ~12 minutes before falling back.                                              |
| The job runner is killed at **60 s** (`maxDuration`).                                              | A slow call never finished: the job stayed RUNNING at 35% …                                            |
| … and a stuck job was only noticed after **10 minutes**.                                           | … and pressing Generate again reattached to the same dead run.                                         |
| Context (company, brand profile, trends, knowledge) was read one query after another.              | Extra seconds before the model was even asked — more on a far-away database.                           |

## How it works now

1. **Read the brief** — company, brand profile, latest trends and company
   knowledge are fetched **in parallel**.
2. **Strategy** — one small call (≤15 s) for the month's summary and one theme
   per week, so the weeks still build a single narrative arc.
3. **Weeks, all at once** — each week is its own small call that knows the
   whole month's arc but writes only its own slots. Progress moves as each week
   lands: "Drafted week 2 — 8 of 17 posts ready…".
4. **Hold to the schedule** — dates come from the computed schedule, never the
   model; channels rotate through every channel the user picked.
5. **Save** — one upsert per company/month (regenerating replaces, never
   duplicates).

Everything runs against a **45-second drafting budget**, inside the 60-second
runner. A call that cannot finish in the time left is not started; one that
overruns is abandoned. A schema slip is corrected once, a rate limit or outage
is retried once if there is time, and a rejected key is not retried at all.

## Guarantees

- **Always complete.** Any week (or slot) the model does not deliver is filled
  from the brief with a dated, briefed outline. The plan records which
  (`payload.outline`), and the page says so: "Week 3 is a simple outline from
  your brief … Regenerate to have Aura write it in full."
- **Bounded time.** A run finishes in well under a minute whatever the
  provider does — measured: ~11–12 s for a full month with a model at
  realistic latency (4 or 14 posts/week, 1 or 6 channels), ~3 s when the
  provider refuses outright, never past the budget when it hangs.
- **Never frozen.** The progress bar shows the current step, the time so far
  against the usual time, and says plainly when a run is taking longer than
  usual.
- **Clear failure.** A plan run is considered dead after 2 minutes (it was 10).
  The page then shows "That run didn't finish … Your brief is saved — try
  again." Try again starts a **fresh** run and closes the dead one so the
  stuck-job sweep cannot revive it later.
- **No duplicates.** The button is disabled while a run is going, a
  double-click cannot send two requests, and the server checks for a run in
  flight under a per-workspace lock (a Postgres transaction lock), so even
  simultaneous requests from two tabs start exactly one run — verified with five
  at once.

## Checking it

```bash
pnpm test tests/planner-draft.test.ts tests/planner-schedule.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:planner
# include one live-model run:
VERIFY_BASE_URL=http://localhost:3001 node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/verify-planner.ts
```

## Notes

- Drafting the weeks in parallel sends ~6 model requests at once. On a
  provider's free tier with a low requests-per-minute limit, some weeks may be
  rate-limited and come back as outlines; on a paid tier this does not arise.
- Plans saved before this change have no `outline` field and display as before.
