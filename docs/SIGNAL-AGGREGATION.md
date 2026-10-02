# Signal Aggregation Layer

Brings the signals Aura already has (trends, competitors, results, learned
patterns, and what the business itself is doing) into **one normalised,
de-duplicated store**. Opportunity detection reads from it.

| Piece | Where |
| --- | --- |
| Table | `Signal`, plus `OpportunitySignal.signalId` (migration `20261002150000_signals`) |
| Shape, reliability, dedupe keys, business matching, evidence conversion | [`lib/signals.ts`](../lib/signals.ts) (pure, client-safe) |
| One normaliser per source | [`server/signals/normalize.ts`](../server/signals/normalize.ts) (pure) |
| Collect, store, query | [`server/signals/signal.service.ts`](../server/signals/signal.service.ts) |
| HTTP | `GET /api/signals`, `POST /api/signals/refresh` |
| Tests | [`tests/signals.test.ts`](../tests/signals.test.ts); `pnpm verify:signals` against a real database |

```ts
await collectSignals(companyId);           // refresh the store (idempotent)
const signals = await listSignals(companyId, {
  relevantOnly: true,                      // associated with the business
  minReliability: 'MEDIUM',
  sources: ['TRENDS', 'COMPETITORS'],
});
const evidence = signals.map((s) => signalToEvidence(asStoredSignal(s)));
await recordOpportunity(companyId, { /* … */ signals: evidence });
```

---

## Sources

| Source | Read from | Becomes | Reliability | Current for |
| --- | --- | --- | --- | --- |
| **Trends** | `TrendDigest.payload.items` | One signal per story | News / Hacker News **medium**, Reddit / X **low**; one step higher per extra digest that carries the same story | 14 days |
| **Competitors** | `CompetitorSnapshot.changesSummary` | One signal per change: homepage, pricing, release, current positioning, news | Seen on their site or GitHub **high**; positioning with nothing to compare **medium**; news **medium** | 30 days |
| **Analytics** | Latest two `AnalyticsReport`s | One per metric that moved ≥ 25% *and* ≥ 3 | **High** (recorded and compared). With only one period, a single summary at **medium**, with no trend invented | 45 days |
| **Marketing memory** | Active `MarketingMemory` | One per insight | The insight's own confidence; **high** if the user confirmed it. "Not enough data" notes are excluded | 60 days |
| **Business context** | The resolved context | Running campaigns, the current goal, channels used but not connected | **High** if the fact is stated and current, **low** if unconfirmed or out of date | Campaign end date / no expiry |

**Identified but not connected** (see the audit in
[BUSINESS-CONTEXT-SOURCES-AUDIT.md](BUSINESS-CONTEXT-SOURCES-AUDIT.md)):
- **Per-post performance snapshots.** Summarised by memory and analytics.
- **Lead signals** (funding, hiring). These are about prospects rather than the
  market; a natural next source.
- **Knowledge-base material.** Reference, not events.

## The normalised shape

Every signal records:
- `source` and `kind` (the same record kinds as opportunity evidence)
- `title` and `summary`, plus an optional `url`
- **the record behind it** (`refId`) and every record it has been seen in
  (`sightings`, `occurrences`)
- **when:** `observedAt` (when it happened), `firstSeenAt`, `lastSeenAt` and
  `expiresAt`
- `reliability` and `reliabilityReason`, plus `strength` where the source has a
  magnitude (trend score, sample size, % change)
- **the business association:** `contextRevision` and `contextMatches`
- source-specific `metadata`

Each normaliser is defensive. An older digest without `publishedAt` or
`sourceLabel`, or a half-empty snapshot, produces fewer signals, never an
error. A source that fails to load is reported in `failed` and skipped; it
doesn't stop the others.

## Association with the business

Every signal belongs to a workspace and records the Business Context revision
it was collected against. `contextMatches` lists what it relates to:
`keyword:` (the business's market keywords), `competitor:`,
`audience-industry:`, `industry:`, and `context:` for the business's own
signals. `listSignals({ relevantOnly: true })` returns only signals that match
something, so detection can tell a relevant story from market noise.

## No duplicates

`dedupeKey` is unique per workspace:

| Source | Key |
| --- | --- |
| Trends | The story's canonical URL (no `www`, tracking parameters or trailing slash), else its normalised title |
| Competitor change | Competitor, change type and normalised text |
| Competitor news | Canonical URL or title |
| Analytics | Report and metric |
| Memory | Insight id |
| Business context | Campaign name / goal text / channel |

- **Repeat collection** updates `lastSeenAt` and stores nothing new.
- **Corroboration:** a new *record* carrying the same observation (the same
  story in another digest) adds a sighting and raises reliability one step per
  extra sighting. Re-reading the *same* record never counts as corroboration.
- **Concurrency:** two collections running at once can't create a duplicate
  (unique key, skip-duplicates insert).

## Refresh

- Collection runs on every advisor run, so it's refreshed daily with the
  advisor cron.
- It also runs on demand via `POST /api/signals/refresh`.
- Signals past `expiresAt` are kept, but left out of `listSignals` unless
  `includeExpired` is set.

## Consumption by opportunity detection

`signalToEvidence` turns a stored signal into opportunity evidence with the same
`kind` and `refId`, plus `signalId`. A recorded opportunity is therefore
traceable both to the normalised signal and to the original record.
