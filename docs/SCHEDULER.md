# Publishing scheduler

Scheduled posts are published by **`/api/cron/publish`** (GET or POST). This document explains:

- how that job works
- how it was made safe to call frequently
- the recommended way to call it every 5 minutes at no extra cost

**Nothing here has been enabled.** `vercel.json` still runs the job once a day at 09:00 UTC. The external schedule in §3 is a manual step, for when you approve it.

## 1. How it works

| Concern | How |
| --- | --- |
| **Authentication** | `Authorization: Bearer $CRON_SECRET`, compared in constant time (`lib/cron-auth.ts`). Refused if `CRON_SECRET` is unset. Vercel Cron sends the header itself; an external scheduler sends the same one. |
| **What is picked** | Posts that are **APPROVED**, with `scheduledFor ≤ now`, not yet published. Oldest first, 100 per run (`runScheduledPublishes`). |
| **Approval** | Only APPROVED posts are picked, and `publishDraft` re-checks that the content is exactly what was approved. |
| **Timezone** | `scheduledFor` is a UTC instant, converted from the business's local time when scheduled (`lib/timezone.ts`, daylight saving included). Selection compares instants, so it doesn't depend on any timezone. |
| **Duplicates** | Each publish first **claims** its (post, network) record (`server/content/publication-store.ts`): a database unique key plus compare-and-swap. Overlapping runs, a person clicking Publish, and Vercel's cron plus an external one can't post the same thing twice. Proven with three simultaneous runs against the real database. |
| **Execution status** | Every claim and outcome moves the post's execution: Scheduled → Queued → Executing → Completed / Failed / Action required (`server/execution/engine.service.ts`). Lateness is recorded. |
| **Retries** | **Rate limits:** retried automatically after 5 min, then 30 min, then 2 h, up to 3 attempts (`runExecutionSweep`, same job). **Other failures:** wait for a person (**Retry now**); the outcome may be unknown, and retrying could post twice. **Failed or manual posts:** never re-picked by the scheduler. |
| **Time limit** | The function may run 60 s. New publishes stop being started after 45 s, so the function is never stopped mid-publish; the rest go in the next run (`deferred`). |
| **Also in the same job** | Instagram posts still processing are finished; Meta organic analytics are read if time remains. |

### Changes made for frequent runs

These are needed to call the job every few minutes.

- **Stuck posts.** Before, failed or manual posts were re-picked on every run. With the batch limit, enough of them could stop new due posts from ever being reached. They're now excluded at selection.
- **Order.** Posts are processed oldest first.
- **Time budget.** Added, so a backlog can't cause an interrupted publish.
- **Accurate counts.** A run that finds another run already published a post no longer counts it as its own publish.
- **LinkedIn rate limits.** A LinkedIn 429 is now recognised as a rate limit, so it is retried automatically like Meta's.
- **Constant-time check.** `CRON_SECRET` is now compared in constant time.

The publishing workflow itself (approval, claim, publishers) is unchanged.

## 2. Options

| | Option A: Vercel Pro cron | **Option B: external scheduler (recommended)** |
| --- | --- | --- |
| How | Change `vercel.json` to `*/5 * * * *` | A free scheduler calls `GET https://<domain>/api/cron/publish` every 5 minutes with the `Authorization` header |
| Cost | Vercel Pro subscription, per member. Hobby only allows daily crons. | Free (cron-job.org), within Vercel's included invocations: 288 a day |
| Reliability | Vercel-managed; at-most-once per scheduled time | cron-job.org: 1-minute granularity, run history, failure e-mails. If it misses a run, the next one catches up: nothing is lost, only later. |
| Secret | Stays in Vercel | `CRON_SECRET` is stored at the scheduler. Use a dedicated, long, random value. |

**Recommendation: Option B, with the existing Vercel daily cron kept as a backstop.**

- **Overlap is safe.** If both call the job at once, the claim makes it safe.
- **Missed runs.** If the external scheduler stops, posts still go out once a day.

### Not recommended

- **GitHub Actions `schedule`:**
  - The repository is private, so every run uses paid minutes: 288 runs a day goes beyond the free allowance.
  - Scheduled workflows are often delayed by 5–30 minutes.
- **Upstash QStash** works too: free tier, signed requests, retries. But it needs an account and a token, for no benefit over cron-job.org here.

### Before choosing Hobby + Option B

**Vercel's Hobby plan is meant for non-commercial projects.** If Botella Aura is a commercial product, the plan may need to be Pro regardless of scheduling. In that case Option A comes at no extra cost. Check this against Vercel's current terms; it isn't a technical constraint.

## 3. Setting up Option B

Do this only after approval. It changes production behaviour.

1. **Prerequisites:**
   - The deployment is live, with `CRON_SECRET` set in Vercel (Production).
   - A dedicated value is recommended: `openssl rand -hex 32`.
   - Redeploy after changing it.
2. **Create the job:** <https://cron-job.org> → sign up → **Create cronjob**.
   - **Title:** Botella Aura: publish
   - **URL:** `https://<your production domain>/api/cron/publish`
   - **Execution schedule:** every **5 minutes**
   - **Advanced → Request method:** `GET`
   - **Advanced → Headers:** `Authorization` = `Bearer <CRON_SECRET>`. Paste the value there only; never in chat or a commit.
   - **Advanced → Timeout:** 60 s, the maximum the free plan allows; the job answers within about 45 s
   - **Notifications:** on failure, to your e-mail
3. **Test run:** **Save**, then **Test run**. Expect HTTP 200 with a JSON summary: `attempted`, `published`, `skipped`, `deferred`, `ms`.
4. **Check the job's History** after a few runs: all 200.
5. **Keep `vercel.json`'s daily `/api/cron/publish`** as the backstop.

## 4. Expected timing

| Event | When it happens (Option B, every 5 min) | Today (daily at 09:00 UTC) |
| --- | --- | --- |
| A post scheduled for T is published | Between T and about T + 5 min (+ the run's own seconds) | Up to ~24 h after T |
| Instagram video (Reel) finishes processing | Next run(s) after Instagram is done, typically within 5–10 min | Next day |
| Automatic rate-limit retry | Backoff (5 min / 30 min / 2 h) + up to 5 min | Next day |
| Backlog over 45 s of work (100+ posts due at once) | The rest go in the next run, 5 min later | Next day |
| External scheduler down | The daily Vercel backstop at 09:00 UTC | — |

**Limitations:**

- **Never early, a few minutes late.** A post is never published before its time. It goes out up to one interval later.
- **Shorter intervals.** For posts within about a minute of their time, use a 1-minute interval. It's free on cron-job.org; the cost is 1,440 invocations a day.

## 5. Tests

| Test | Covers |
| --- | --- |
| `tests/scheduler.test.ts` | Cron authentication; selection rules (approved, due, oldest first, stuck posts excluded); automatic-only publishing; cancelled skipped; time budget; accurate counts; errors don't stop a run |
| `pnpm verify:scheduler` (real database, LinkedIn API replaced by a counter) | Timezone: 09:00 Kolkata = 03:30 UTC, not published at 08:59, published at 09:00. Approval respected. **Three overlapping runs → each of 5 posts sent once.** Rate-limit → automatic retry after backoff. Other failure → waits for a person, then Retry now works. Time budget defers, and the next run catches up. Cancelled never published. |
| `tests/execution-engine.test.ts` | DST, state machine, retry policy |
