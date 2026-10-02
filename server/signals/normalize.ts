import type { BusinessContext } from '@/lib/business-context';
import {
  canonicalUrl,
  SIGNAL_SOURCE_INFO,
  textKey,
  type NormalizedSignal,
  type SignalReliability,
  type SignalSource,
} from '@/lib/signals';
import { readChangesSummary } from '@/server/competitors/types';
import { normalizeDigestPayload } from '@/server/trends/digest.service';
import type { TrendSourceId } from '@/server/trends/types';

/**
 * Source rows → normalised signals. One function per source, all pure, all
 * defensive: a digest written by an older build, a snapshot with half its
 * fields, or a memory row in an unexpected shape must produce fewer signals,
 * never an exception.
 */

const DAY = 86_400_000;

function expiry(source: SignalSource, from: Date): Date | null {
  const days = SIGNAL_SOURCE_INFO[source].expiresAfterDays;
  return days === null ? null : new Date(from.getTime() + days * DAY);
}

const date = (v: unknown, fallback: Date): Date => {
  if (typeof v !== 'string' && !(v instanceof Date)) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
};

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/** How much one sighting from each trend source can be relied on. */
const TREND_SOURCE_RELIABILITY: Record<
  TrendSourceId,
  { r: SignalReliability; why: string }
> = {
  news: { r: 'MEDIUM', why: 'Reported by a news outlet' },
  hackernews: { r: 'MEDIUM', why: 'Ranked on Hacker News' },
  reddit: { r: 'LOW', why: 'A Reddit discussion' },
  twitter: { r: 'LOW', why: 'A post on X' },
};

export function normalizeTrends(
  digests: { id: string; date: Date; payload: unknown }[],
): NormalizedSignal[] {
  const out: NormalizedSignal[] = [];
  for (const d of digests) {
    for (const item of normalizeDigestPayload(d.payload).items) {
      if (!item?.title) continue;
      const observedAt = date(item.publishedAt, d.date);
      const base = TREND_SOURCE_RELIABILITY[item.source] ?? {
        r: 'LOW' as const,
        why: 'A trend source',
      };
      // The same story is one signal however many digests carry it.
      const key = canonicalUrl(item.url) ?? `title:${textKey(item.title)}`;
      out.push({
        source: 'TRENDS',
        kind: 'TREND_ITEM',
        title: item.title,
        summary: item.aiSummary || item.title,
        ...(item.url ? { url: item.url } : {}),
        refId: `${d.id}:${item.id}`,
        observedAt,
        expiresAt: expiry('TRENDS', observedAt),
        reliability: base.r,
        reliabilityReason: base.why,
        ...(typeof item.score === 'number' ? { strength: item.score } : {}),
        contextMatches: [],
        metadata: {
          trendSource: item.source,
          sourceLabel: item.sourceLabel ?? item.source,
          ...(item.suggestedAngle
            ? { suggestedAngle: item.suggestedAngle }
            : {}),
        },
        dedupeKey: `trend:${key}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------

export function normalizeCompetitors(
  competitors: {
    id: string;
    name: string;
    snapshots: { id: string; capturedAt: Date; changesSummary: unknown }[];
  }[],
): NormalizedSignal[] {
  const out: NormalizedSignal[] = [];
  for (const c of competitors) {
    for (const snap of c.snapshots) {
      const s = readChangesSummary(snap.changesSummary);
      const at = snap.capturedAt;
      const base = {
        source: 'COMPETITORS' as const,
        kind: 'COMPETITOR_SNAPSHOT' as const,
        refId: snap.id,
        expiresAt: expiry('COMPETITORS', at),
        contextMatches: [`competitor:${c.name}`],
      };
      const change = (
        type: string,
        title: string,
        text: string,
        r: SignalReliability,
        why: string,
      ) =>
        out.push({
          ...base,
          title,
          summary: text,
          observedAt: at,
          reliability: r,
          reliabilityReason: why,
          metadata: { competitor: c.name, competitorId: c.id, change: type },
          // The same text seen in a later snapshot is the same observation.
          dedupeKey: `competitor:${c.id}:${type}:${textKey(text, 24)}`,
        });

      if (s.homepage)
        change(
          'homepage',
          `${c.name} changed its homepage`,
          s.homepage,
          'HIGH',
          'Observed directly on their website',
        );
      if (s.pricing)
        change(
          'pricing',
          `${c.name} changed its pricing`,
          s.pricing,
          'HIGH',
          'Observed directly on their pricing page',
        );
      if (s.baseline?.homepage) {
        change(
          'positioning',
          `How ${c.name} positions itself`,
          s.baseline.homepage,
          'MEDIUM',
          'Their current website, with no earlier version to compare',
        );
      }
      if (s.github?.latestRelease) {
        const rel = s.github.latestRelease;
        out.push({
          ...base,
          title: `${c.name} shipped ${rel.name}`,
          summary: `Released ${rel.name} (${rel.tagName}) in ${rel.repo}.`,
          url: rel.url,
          observedAt: at,
          reliability: 'HIGH',
          reliabilityReason: 'A public release on GitHub',
          metadata: {
            competitor: c.name,
            competitorId: c.id,
            change: 'release',
          },
          dedupeKey: `competitor:${c.id}:release:${rel.repo}:${rel.tagName}`,
        });
      }
      for (const n of s.news) {
        if (!n?.title) continue;
        const observedAt = date(n.publishedAt, at);
        out.push({
          ...base,
          title: `${c.name} in the news: ${n.title}`,
          summary: n.title,
          ...(n.url ? { url: n.url } : {}),
          observedAt,
          expiresAt: expiry('COMPETITORS', observedAt),
          reliability: 'MEDIUM',
          reliabilityReason: n.source
            ? `Reported by ${n.source}`
            : 'Reported in the news',
          metadata: { competitor: c.name, competitorId: c.id, change: 'news' },
          dedupeKey: `competitor-news:${canonicalUrl(n.url) ?? textKey(n.title)}`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

const METRIC_LABEL: Record<string, string> = {
  totalEngagement: 'Total engagement',
  postsPublished: 'Posts published',
  outreachSent: 'Outreach sent',
  connectionsMade: 'Connections made',
  repliesReceived: 'Replies received',
  leadsDiscovered: 'Leads discovered',
  campaignsRun: 'Campaigns run',
};

/** A change worth a signal: at least 25% and at least 3 in absolute terms. */
export const ANALYTICS_THRESHOLD = { relative: 0.25, absolute: 3 };

const numbers = (raw: unknown): Record<string, number> =>
  raw && typeof raw === 'object'
    ? Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          (e): e is [string, number] =>
            typeof e[1] === 'number' && Number.isFinite(e[1]),
        ),
      )
    : {};

/**
 * Movement between the two latest analytics periods. Without an earlier period
 * there is nothing to compare, so the latest summary becomes one signal of
 * medium reliability rather than inventing a trend from a single point.
 */
export function normalizeAnalytics(
  reports: {
    id: string;
    periodStart: Date;
    periodEnd: Date;
    summary: string;
    metrics: unknown;
  }[],
): NormalizedSignal[] {
  const [latest, previous] = [...reports].sort(
    (a, b) => b.periodStart.getTime() - a.periodStart.getTime(),
  );
  if (!latest) return [];
  const at = latest.periodEnd;
  const base = {
    source: 'ANALYTICS' as const,
    kind: 'ANALYTICS_REPORT' as const,
    refId: latest.id,
    observedAt: at,
    expiresAt: expiry('ANALYTICS', at),
    contextMatches: [],
  };
  const now = numbers(latest.metrics);

  if (!previous) {
    return [
      {
        ...base,
        title: 'Your latest results',
        summary: latest.summary,
        reliability: 'MEDIUM',
        reliabilityReason:
          'Recorded activity for one period, with no earlier period to compare',
        metadata: { metrics: now },
        dedupeKey: `analytics:${latest.id}:summary`,
      },
    ];
  }

  const before = numbers(previous.metrics);
  const out: NormalizedSignal[] = [];
  for (const [metric, value] of Object.entries(now)) {
    const prior = before[metric];
    if (prior === undefined) continue;
    const delta = value - prior;
    const relative = prior === 0 ? (value > 0 ? Infinity : 0) : delta / prior;
    if (
      Math.abs(delta) < ANALYTICS_THRESHOLD.absolute ||
      Math.abs(relative) < ANALYTICS_THRESHOLD.relative
    )
      continue;
    const label = METRIC_LABEL[metric] ?? metric;
    const pct = Number.isFinite(relative)
      ? `${Math.round(Math.abs(relative) * 100)}%`
      : 'from zero';
    out.push({
      ...base,
      title: `${label} ${delta > 0 ? 'up' : 'down'} ${pct}`,
      summary: `${label} went from ${prior} to ${value} between the last two periods.`,
      reliability: 'HIGH',
      reliabilityReason: 'Recorded activity, compared across two periods',
      strength: Number.isFinite(relative) ? Math.round(relative * 100) : 100,
      metadata: {
        metric,
        from: prior,
        to: value,
        previousReportId: previous.id,
      },
      dedupeKey: `analytics:${latest.id}:${metric}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Marketing memory
// ---------------------------------------------------------------------------

const MEMORY_RELIABILITY: Record<string, SignalReliability> = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

export function normalizeMemory(
  rows: {
    id: string;
    insightType: string;
    insight: string;
    confidence: string;
    sampleSize: number;
    supportingDataSummary: unknown;
    generatedAt: Date;
  }[],
): NormalizedSignal[] {
  return rows.flatMap((m) => {
    const summary = (m.supportingDataSummary ?? {}) as Record<string, unknown>;
    if (summary.status === 'insufficient' || !m.insight?.trim()) return [];
    const edited = summary.editedByUser === true;
    return [
      {
        source: 'MEMORY' as const,
        kind: 'MEMORY_INSIGHT' as const,
        title: `What works: ${m.insightType.toLowerCase().replace(/_/g, ' ')}`,
        summary: m.insight.trim(),
        refId: m.id,
        observedAt: m.generatedAt,
        expiresAt: expiry('MEMORY', m.generatedAt),
        reliability: edited
          ? 'HIGH'
          : (MEMORY_RELIABILITY[m.confidence] ?? 'LOW'),
        reliabilityReason: edited
          ? 'Learned from your results and confirmed by you'
          : `Learned from ${m.sampleSize} of your results`,
        strength: m.sampleSize,
        contextMatches: [],
        metadata: {
          insightType: m.insightType,
          confidence: m.confidence,
          editedByUser: edited,
        },
        dedupeKey: `memory:${m.id}`,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Business context
// ---------------------------------------------------------------------------

/**
 * What the business itself is doing that detection should know about: the
 * campaigns it is running, the goal it is working towards, and channels it
 * publishes on but has not connected. Reliability follows the trust of the
 * underlying fact — an unconfirmed goal is a weak signal.
 */
export function normalizeBusinessContext(
  ctx: BusinessContext,
  now: Date,
): NormalizedSignal[] {
  const out: NormalizedSignal[] = [];
  const trust = (path: string): { r: SignalReliability; why: string } => {
    const f = ctx.meta.facts[path];
    if (!f) return { r: 'LOW', why: 'Not recorded' };
    if (f.trusted && f.freshness !== 'stale')
      return { r: 'HIGH', why: 'Stated by the business' };
    return {
      r: 'LOW',
      why:
        f.freshness === 'stale'
          ? 'Stated, but out of date'
          : 'Not confirmed by the business',
    };
  };
  const base = {
    source: 'BUSINESS_CONTEXT' as const,
    kind: 'BUSINESS_CONTEXT' as const,
    refId: null,
  };

  for (const c of ctx.objectives.campaigns) {
    const t = trust('objectives.campaigns');
    const ends = c.endDate ? new Date(c.endDate) : null;
    out.push({
      ...base,
      title: `Campaign ${c.status === 'PAUSED' ? 'paused' : 'running'}: ${c.name}`,
      summary:
        [
          c.goal,
          c.audience && `for ${c.audience}`,
          c.themes.length && `themes: ${c.themes.join(', ')}`,
        ]
          .filter(Boolean)
          .join(' — ') || c.name,
      observedAt: now,
      expiresAt: ends,
      reliability: t.r,
      reliabilityReason: t.why,
      contextMatches: ['context:campaign'],
      metadata: { campaign: c.name, status: c.status, themes: c.themes },
      dedupeKey: `context:campaign:${textKey(c.name)}`,
    });
  }

  if (ctx.objectives.goals) {
    const t = trust('objectives.goals');
    out.push({
      ...base,
      title: 'Current goal',
      summary: ctx.objectives.goals,
      observedAt: now,
      expiresAt: null,
      reliability: t.r,
      reliabilityReason: t.why,
      contextMatches: ['context:goal'],
      metadata: {},
      // A new goal is a new signal; the old one stops being refreshed.
      dedupeKey: `context:goal:${textKey(ctx.objectives.goals, 24)}`,
    });
  }

  for (const ch of ctx.channels.preferred.filter(
    (c) => !ctx.channels.connected.includes(c),
  )) {
    if (!ctx.meta.sections.includes('connections')) break;
    out.push({
      ...base,
      title: `${ch} is not connected`,
      summary: `The business publishes on ${ch} but has not connected it, so Aura cannot publish or measure there.`,
      observedAt: now,
      expiresAt: null,
      reliability: 'HIGH',
      reliabilityReason: 'From your connected accounts',
      contextMatches: ['context:channel'],
      metadata: { channel: ch },
      dedupeKey: `context:channel-unconnected:${ch}`,
    });
  }
  return out;
}
