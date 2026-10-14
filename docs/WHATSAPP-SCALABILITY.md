# WhatsApp assistant — scalability and load test

What was measured, how, and what it does and does not show. Measured on
14 October 2026.

## How it scales

| Concern | How |
| --- | --- |
| Fast webhook | Signature check, then the message and a queue job are stored in one transaction; Meta gets 200 at once. Nothing slow runs before the response. |
| Durable queue | Postgres (`WhatsAppJob`). No paid queue service. |
| Workers | After the response, `waitUntil` (Vercel) drains the conversation; the cron sweep (`/api/cron/whatsapp`) picks up anything left. |
| Ordering | A worker leases the conversation (compare-and-swap); one person's messages are handled one at a time, oldest first. Different people run in parallel. |
| Idempotency | Meta's message id is unique (a redelivery is stored and answered once); a retried job does not reply again; slow work (writing a post) is not started twice. |
| Retries / dead letter | Failed jobs back off and keep order; after 4 attempts DEAD, kept with the error, the person gets an apology. Failed sends retry with back-off; a throttled send (Meta 130429 etc.) gets one quick retry first. |
| Concurrency control | One process handles at most `WHATSAPP_WORKER_CONCURRENCY` conversations at once (default 48, chosen by measurement below); the rest wait in memory. |
| Rate limiting | 20 answered messages per conversation per minute (stops floods and bot loops). In-memory per instance. |
| Tenant isolation | Every request resolves the workspace and role from the session, fresh; checked under load below. |

## The load test

`scripts/load/whatsapp-load.ts` against a **production build** (`next build && next start`),
local PostgreSQL, and `scripts/load/meta-stub.ts` standing in for Meta's Cloud API
(80–200 ms per call; 2% of sends answered with Meta's throughput error 130429).

- **1,000 people at once**: 800 linked users across 50 workspaces, all four roles,
  plus 200 numbers never seen before.
- **2,800 messages**: linked users ask "show my active campaigns", "What content is
  awaiting approval?" and "menu"; new numbers say "Hi" twice (the sign-in path).
- **3,080 webhooks**: 10% delivered twice, as Meta does.
- **200 requests in flight**; each person sends a message only after the previous one
  was acknowledged, as a phone does. All 2,800 messages arrive within 10–26 seconds —
  a far sharper burst than real traffic.
- Machine: 16 cores, Windows, one Node process doing both the webhooks and all the
  work (locally `waitUntil` runs in the same process), Prisma's default connection pool.

Every run checks, from the database and from what the Meta stub received:
every webhook answered 200 · each message stored once · every message answered
exactly once · each person answered in order · every campaign reply names only that
person's own workspace · nothing dead-lettered · no reply left unsent.

### Results — 1,000 people, 2,800 messages

| Per-process cap | Webhook ack p50 / p95 / p99 | Webhooks/s | Message → answered p50 / p95 / p99 | All answered **and sent** | Checks |
| --- | --- | --- | --- | --- | --- |
| none | 1.8 s / 2.1 s / 2.3 s | 120 | 6.9 s / 8.1 s / 8.2 s | 384 s | all pass |
| 16 | 0.6 s / 1.2 s / 1.6 s | 305 | 35 s / 64 s / 67 s | 142 s | all pass |
| 32 | 0.8 s / 1.7 s / 2.0 s | 239 | 20 s / 35 s / 37 s | 46 s | all pass |
| **48 (default)** | 0.8 s / 1.5 s / 2.0 s | 236 | 15 s / 26 s / 27 s | **36 s** | all pass |

The uncapped run's 384 s was mostly replies throttled twice waiting 1 then 5 minutes;
the quick retry for throttling (added after it) brought that down with the cap.

## What this shows — and what it does not

**Shown:** under 1,000 people sending 2,800 messages in a burst, one process on
one machine stored every message once, answered every one exactly once, kept each
person's order, never crossed workspaces, and had every reply out within 36 s, with
every webhook acknowledged in about 2 s (Meta allows roughly 20 s).

**Not shown:**

- **Vercel + Neon.** Production runs each webhook in a serverless invocation with
  `waitUntil`, against Neon's pooled connections. Not measured. Expect faster webhook
  acknowledgement (parallel instances) and a database-connection limit instead of a
  CPU one: keep `DATABASE_URL` on Neon's pooler with `pgbouncer=true&connection_limit=1`.
- **Real Meta throughput.** A WhatsApp number starts at about **80 messages per
  second**. The burst above sent ~80–220 replies per second; Meta would throttle the
  excess. Aura recovers (quick retry, then back-off) but replies would be slower.
  Meta raises the limit (up to 1,000/s) for numbers with good quality ratings, on request.
- **AI.** The load mix used Aura's database-backed tools only. Writing posts,
  images and AI routing are limited by the AI provider's quota, not by Aura — the
  development Gemini key returned 429 (quota) for a *single* user during testing.
  A paid tier with enough requests per minute is needed for many people writing posts.
- **Sustained load** (hours) and **failure injection** (database restarts, killed
  workers) beyond what the unit tests cover.

## Running it

```bash
pnpm load:meta-stub                      # terminal 1 — the Meta stand-in on :4010
# terminal 2 — a production build pointed at the stub (never at Meta):
next build && WHATSAPP_GRAPH_BASE_URL=http://localhost:4010 APP_URL=http://localhost:3002 next start -p 3002
# terminal 3 — same WHATSAPP_* and CRON_SECRET values as the app:
LOAD_BASE_URL=http://localhost:3002 pnpm load:whatsapp
```

Tunable: `LOAD_LINKED`, `LOAD_NEW`, `LOAD_COMPANIES`, `LOAD_CONCURRENCY`,
`LOAD_DUPES`, `STUB_ERROR_RATE`. It cleans up everything it creates.
