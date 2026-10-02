import type { Prisma, Signal } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { BusinessContext } from '@/lib/business-context';
import {
  corroborate,
  matchContext,
  SIGNAL_RELIABILITIES,
  SIGNAL_SOURCES,
  type NormalizedSignal,
  type SignalReliability,
  type SignalSource,
  type StoredSignal,
} from '@/lib/signals';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import {
  normalizeAnalytics,
  normalizeBusinessContext,
  normalizeCompetitors,
  normalizeMemory,
  normalizeTrends,
} from './normalize';

/**
 * The signal aggregation layer: gather, normalise, de-duplicate, store, serve.
 *
 *   await collectSignals(companyId);                      // refresh the store
 *   const signals = await listSignals(companyId, {        // what detection reads
 *     relevantOnly: true, minReliability: 'MEDIUM',
 *   });
 *
 * Collection is idempotent: running it twice stores nothing new. The same
 * observation seen in another record (a story in a second digest) is one
 * signal with one more sighting — and more sightings raise its reliability.
 */

const DAY = 86_400_000;
/** Distinct records remembered per signal (corroboration only needs a few). */
const MAX_SIGHTINGS = 20;

/** The record a sighting is counted by. Signals with no record are one sighting. */
const sightingOf = (s: NormalizedSignal) => s.refId ?? 'self';

export interface CollectResult {
  created: number;
  updated: number;
  /** Normalised signals per source before de-duplication. */
  bySource: Record<SignalSource, number>;
  /** Sources that could not be read this run, and why. */
  failed: { source: SignalSource; error: string }[];
}

/** Merge a batch so each dedupe key appears once, counting distinct sightings. */
export function mergeBatch(
  signals: NormalizedSignal[],
): (NormalizedSignal & { sightings: string[] })[] {
  const byKey = new Map<string, NormalizedSignal & { sightings: string[] }>();
  for (const s of signals) {
    const seen = byKey.get(s.dedupeKey);
    if (!seen) {
      byKey.set(s.dedupeKey, { ...s, sightings: [sightingOf(s)] });
      continue;
    }
    if (!seen.sightings.includes(sightingOf(s)))
      seen.sightings.push(sightingOf(s));
    // Keep the earliest observation as when it happened; the latest expiry.
    if (s.observedAt < seen.observedAt) seen.observedAt = s.observedAt;
    if (s.expiresAt && (!seen.expiresAt || s.expiresAt > seen.expiresAt))
      seen.expiresAt = s.expiresAt;
    seen.contextMatches = [
      ...new Set([...seen.contextMatches, ...s.contextMatches]),
    ];
    if ((s.strength ?? -Infinity) > (seen.strength ?? -Infinity))
      seen.strength = s.strength;
  }
  return [...byKey.values()];
}

/** Read every source and normalise it. A source that fails is skipped and reported. */
async function gather(
  companyId: string,
  ctx: BusinessContext,
  since: Date,
  now: Date,
): Promise<{
  signals: NormalizedSignal[];
  bySource: CollectResult['bySource'];
  failed: CollectResult['failed'];
}> {
  const bySource = Object.fromEntries(
    SIGNAL_SOURCES.map((s) => [s, 0]),
  ) as CollectResult['bySource'];
  const failed: CollectResult['failed'] = [];
  const run = async (
    source: SignalSource,
    load: () => Promise<NormalizedSignal[]>,
  ) => {
    try {
      const out = await load();
      bySource[source] = out.length;
      return out;
    } catch (err) {
      failed.push({
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  };

  const batches = await Promise.all([
    run('TRENDS', async () =>
      normalizeTrends(
        await db.trendDigest.findMany({
          where: { companyId, date: { gte: since } },
          orderBy: { date: 'desc' },
          take: 30,
          select: { id: true, date: true, payload: true },
        }),
      ),
    ),
    run('COMPETITORS', async () =>
      normalizeCompetitors(
        await db.competitorProfile.findMany({
          where: { companyId, trackingEnabled: true },
          select: {
            id: true,
            name: true,
            snapshots: {
              where: { capturedAt: { gte: since } },
              orderBy: { capturedAt: 'desc' },
              take: 10,
              select: { id: true, capturedAt: true, changesSummary: true },
            },
          },
        }),
      ),
    ),
    run('ANALYTICS', async () =>
      normalizeAnalytics(
        await db.analyticsReport.findMany({
          where: { companyId },
          orderBy: { periodStart: 'desc' },
          take: 2,
          select: {
            id: true,
            periodStart: true,
            periodEnd: true,
            summary: true,
            metrics: true,
          },
        }),
      ),
    ),
    run('MEMORY', async () =>
      normalizeMemory(
        await db.marketingMemory.findMany({
          where: { companyId, isActive: true },
          orderBy: { generatedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            insightType: true,
            insight: true,
            confidence: true,
            sampleSize: true,
            supportingDataSummary: true,
            generatedAt: true,
          },
        }),
      ),
    ),
    run('BUSINESS_CONTEXT', async () => normalizeBusinessContext(ctx, now)),
  ]);

  // Associate every signal with the parts of the business it relates to.
  const signals = batches.flat().map((s) => ({
    ...s,
    contextMatches: [
      ...new Set([...s.contextMatches, ...matchContext(s, ctx)]),
    ],
  }));
  return { signals, bySource, failed };
}

export async function collectSignals(
  companyId: string,
  options: {
    now?: Date;
    sinceDays?: number;
    context?: BusinessContext | null;
  } = {},
): Promise<CollectResult | null> {
  const now = options.now ?? new Date();
  const ctx = options.context ?? (await getBusinessContext(companyId));
  if (!ctx) return null;
  const since = new Date(now.getTime() - (options.sinceDays ?? 30) * DAY);

  const { signals, bySource, failed } = await gather(
    companyId,
    ctx,
    since,
    now,
  );
  for (const f of failed)
    logger.warn('signals: a source could not be read', { companyId, ...f });

  const merged = mergeBatch(signals);
  if (!merged.length) return { created: 0, updated: 0, bySource, failed };

  const existing = await db.signal.findMany({
    where: { companyId, dedupeKey: { in: merged.map((s) => s.dedupeKey) } },
    select: {
      id: true,
      dedupeKey: true,
      sightings: true,
      firstSeenAt: true,
      observedAt: true,
      expiresAt: true,
    },
  });
  const known = new Map(existing.map((e) => [e.dedupeKey, e]));

  const fields = (s: (typeof merged)[number], sightings: string[]) => {
    const base = corroborate(s.reliability, sightings.length);
    return {
      source: s.source,
      kind: s.kind,
      title: s.title.slice(0, 500),
      summary: s.summary,
      url: s.url ?? null,
      refId: s.refId,
      sightings,
      occurrences: sightings.length,
      reliability: base.reliability,
      reliabilityReason: base.note
        ? `${s.reliabilityReason}; ${base.note}`
        : s.reliabilityReason,
      strength: s.strength ?? null,
      contextRevision: ctx.meta.revision,
      contextMatches: s.contextMatches,
      metadata: s.metadata as Prisma.InputJsonObject,
      lastSeenAt: now,
    };
  };

  const toCreate = merged.filter((s) => !known.has(s.dedupeKey));
  const toUpdate = merged.filter((s) => known.has(s.dedupeKey));

  if (toCreate.length) {
    await db.signal.createMany({
      data: toCreate.map((s) => ({
        companyId,
        dedupeKey: s.dedupeKey,
        observedAt: s.observedAt,
        expiresAt: s.expiresAt,
        firstSeenAt: now,
        ...fields(s, s.sightings.slice(0, MAX_SIGHTINGS)),
      })),
      // Another collection running at the same moment may have created some.
      skipDuplicates: true,
    });
  }
  for (const s of toUpdate) {
    const prev = known.get(s.dedupeKey)!;
    const sightings = [...new Set([...prev.sightings, ...s.sightings])].slice(
      0,
      MAX_SIGHTINGS,
    );
    await db.signal.update({
      where: { id: prev.id },
      data: {
        ...fields(s, sightings),
        // When it happened stays the earliest; it stays current until the
        // latest sighting's expiry.
        observedAt:
          s.observedAt < prev.observedAt ? s.observedAt : prev.observedAt,
        expiresAt:
          s.expiresAt && prev.expiresAt
            ? new Date(
                Math.max(s.expiresAt.getTime(), prev.expiresAt.getTime()),
              )
            : (s.expiresAt ?? prev.expiresAt),
      },
    });
  }
  return {
    created: toCreate.length,
    updated: toUpdate.length,
    bySource,
    failed,
  };
}

export interface ListSignalsOptions {
  sources?: SignalSource[];
  /** Only signals observed after this. */
  since?: Date;
  minReliability?: SignalReliability;
  /** Only signals associated with something in the Business Context. */
  relevantOnly?: boolean;
  includeExpired?: boolean;
  limit?: number;
  now?: Date;
}

/** Normalised signals for a workspace — what opportunity detection consumes. */
export async function listSignals(
  companyId: string,
  o: ListSignalsOptions = {},
): Promise<Signal[]> {
  const now = o.now ?? new Date();
  const minRank = o.minReliability
    ? SIGNAL_RELIABILITIES.indexOf(o.minReliability)
    : 0;
  return db.signal.findMany({
    where: {
      companyId,
      ...(o.sources ? { source: { in: o.sources } } : {}),
      ...(o.since ? { observedAt: { gte: o.since } } : {}),
      ...(o.minReliability
        ? { reliability: { in: SIGNAL_RELIABILITIES.slice(minRank) } }
        : {}),
      ...(o.relevantOnly ? { NOT: { contextMatches: { isEmpty: true } } } : {}),
      ...(o.includeExpired
        ? {}
        : { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
    },
    orderBy: [{ lastSeenAt: 'desc' }, { observedAt: 'desc' }],
    take: o.limit ?? 100,
  });
}

/** The fields opportunity detection reads, from a stored row. */
export function asStoredSignal(s: Signal): StoredSignal {
  return {
    id: s.id,
    source: s.source,
    kind: s.kind,
    title: s.title,
    summary: s.summary,
    url: s.url,
    refId: s.refId,
    observedAt: s.observedAt,
    reliability: s.reliability,
  };
}
