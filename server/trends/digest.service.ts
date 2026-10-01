import type { Company } from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeJson,
  isClaudeConfigured,
  getModel,
} from '@/server/ai/claude';
import { ALL_SOURCES, getEnabledSources } from '@/server/trends/sources';
import {
  businessContextToPrompt,
  getBusinessContext,
} from '@/server/business-context/business-context.service';

/** What the digest's prompts say about the business, read once per run. */
interface DigestBrand {
  /** "What this company does" block; '' when the business is undescribed. */
  about: string;
  voice: string;
}
import { scoreAndRank } from '@/server/trends/scoring';
import { upcomingSeasonalEvents } from '@/server/trends/seasonal';
import {
  ensureTrendConfig,
  getEnabledFlags,
  seedSmartDefaults,
  toFetchContext,
} from '@/server/services/trend-config.service';
import type {
  CompetitorMention,
  DigestItem,
  DigestPayload,
  ScoredTrendItem,
  TrendItem,
  TrendSourceId,
} from '@/server/trends/types';

const TOP_N = 20;

/** Start of the current UTC day — the idempotency key for a company's digest. */
function todayUtc(now: number = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Reports what the digest is doing right now. Generation fans out to many
 * sources and makes two model calls; without this the UI can only show an
 * undifferentiated spinner, which reads as a hang. Optional so the cron path
 * stays unchanged.
 */
export type ProgressReporter = (
  message: string,
  percent: number,
) => void | Promise<void>;

interface GenerateArgs {
  companyId: string;
  /** Who triggered it (manual refresh). Null for the scheduled job. */
  userId?: string | null;
  trigger: 'scheduled' | 'manual';
  onProgress?: ProgressReporter;
}

/**
 * Generate (or regenerate) today's trend digest for one company:
 * fetch → dedupe/score/rank → AI-enrich → upsert. Idempotent per company/day
 * (NON-NEGOTIABLE #6): running twice the same day overwrites, never duplicates.
 */
export async function generateDigestForCompany({
  companyId,
  userId,
  trigger,
  onProgress,
}: GenerateArgs) {
  const report = async (message: string, percent: number) => {
    try {
      await onProgress?.(message, percent);
    } catch {
      // Progress is cosmetic — never fail a digest because reporting failed.
    }
  };

  await report('Loading your trend settings…', 8);
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company ${companyId} not found`);

  // Ensure config exists and has starter defaults (best-effort).
  await ensureTrendConfig(companyId);
  await seedSmartDefaults(company).catch((err) =>
    logger.warn('digest: seedSmartDefaults failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  const config = await ensureTrendConfig(companyId);
  const ctx = toFetchContext(config);
  const flags = getEnabledFlags(config);

  // Determine which sources run vs. are skipped (enabled but not configured).
  const enabled = getEnabledSources(flags);
  const runnable = enabled.filter((s) => s.isConfigured(ctx));
  const skippedSources = enabled
    .filter((s) => !s.isConfigured(ctx))
    .map((s) => s.id);

  // Fetch from every runnable source in parallel; a failing source is skipped,
  // never fatal, and never faked.
  await report(
    runnable.length
      ? `Scanning ${runnable.map((s) => s.label ?? s.id).join(', ')}…`
      : 'Checking your sources…',
    20,
  );
  const settled = await Promise.allSettled(
    runnable.map((s) => s.fetchTrendItems(ctx)),
  );
  const all: TrendItem[] = [];
  const sourceCounts: Partial<Record<TrendSourceId, number>> = {};
  settled.forEach((res, i) => {
    const src = runnable[i]!;
    if (res.status === 'fulfilled') {
      sourceCounts[src.id] = res.value.length;
      all.push(...res.value);
    } else {
      sourceCounts[src.id] = 0;
      logger.warn('digest: source failed', {
        source: src.id,
        error: String(res.reason),
      });
    }
  });

  const ranked = scoreAndRank(all, ctx, { limit: TOP_N });
  await report(
    `Ranking ${all.length} item${all.length === 1 ? '' : 's'} — writing why each matters…`,
    55,
  );
  // What the business is and how it sounds, from the Business Context layer —
  // the resolved voice (reviewed profile, then the owner's notes) rather than
  // the raw onboarding notes this used to read.
  const businessContext = await getBusinessContext(companyId, { sections: [] });
  const brand: DigestBrand = {
    about: businessContextToPrompt(businessContext, { identity: true }),
    voice: businessContext?.voice.summary || 'professional, practical, no hype',
  };
  const items = await enrichItems(company, ranked, brand);

  // Top-level synthesis + trending hashtags (one Claude call, graceful fallback).
  await report('Summarising the week and pulling hashtags…', 80);
  const synthesis = await synthesizeDigest(company, items, brand);
  // Seasonal moments (curated, no API) + competitor mentions (from config).
  const seasonal = upcomingSeasonalEvents(new Date(), [
    ...config.keywords,
    ...(company.industry ? [company.industry] : []),
  ]);
  const competitorMentions = findCompetitorMentions(items, config.competitorNames);

  const payload: DigestPayload = {
    items,
    generatedAt: new Date().toISOString(),
    model: isClaudeConfigured() ? getModel() : 'fallback',
    sourceCounts,
    skippedSources,
    summary: synthesis.summary,
    recommendations: synthesis.recommendations,
    hashtags: synthesis.hashtags,
    seasonal,
    competitorMentions,
  };

  await report('Saving your digest…', 95);
  const date = todayUtc();
  const digest = await db.trendDigest.upsert({
    where: { companyId_date: { companyId, date } },
    create: { companyId, date, payload: payload as object },
    update: { payload: payload as object },
  });

  await recordAudit({
    action: 'TREND_DIGEST_GENERATED',
    userId: userId ?? null,
    companyId,
    metadata: {
      trigger,
      itemCount: items.length,
      model: payload.model,
      sourceCounts,
    },
  });

  return digest;
}

/**
 * Enrich the top ranked items with a "why this matters" note and a suggested
 * post angle. One Claude call for the whole batch (cost-efficient), keyed by
 * item id. Falls back to a deterministic summary when Claude is unavailable or
 * errors — the digest still ships, clearly labeled as a fallback via payload.model.
 */
async function enrichItems(
  company: Pick<Company, 'name' | 'industry'>,
  ranked: ScoredTrendItem[],
  brand: DigestBrand,
): Promise<DigestItem[]> {
  const base = (item: ScoredTrendItem): DigestItem => ({
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    sourceLabel: item.sourceLabel,
    score: item.score,
    publishedAt: item.publishedAt,
    aiSummary: fallbackSummary(item, company),
    suggestedAngle: fallbackAngle(item),
  });

  if (ranked.length === 0) return [];
  if (!isClaudeConfigured()) return ranked.map(base);

  try {
    const enriched = await completeJson<
      Array<{ id: string; aiSummary: string; suggestedAngle: string }>
    >({
      system:
        `You help ${company.name} decide what to post about. ` +
        (brand.about ? `${brand.about}\n` : '') +
        `Their brand voice: ${brand.voice}. ` +
        'For each trend item, write (1) a one-sentence "why this matters to ' +
        `${company.name}" and (2) a concrete suggested post angle/hook in their ` +
        'voice. Respond with ONLY a JSON array, no prose.',
      prompt: buildEnrichmentPrompt(company, ranked),
      maxTokens: 2048,
      effort: 'medium',
      tier: 'standard',
    });

    const byId = new Map(enriched.map((e) => [e.id, e]));
    return ranked.map((item) => {
      const e = byId.get(item.id);
      const out = base(item);
      if (e?.aiSummary) out.aiSummary = e.aiSummary.trim();
      if (e?.suggestedAngle) out.suggestedAngle = e.suggestedAngle.trim();
      return out;
    });
  } catch (err) {
    logger.warn('digest: AI enrichment failed, using fallback summaries', {
      error: err instanceof Error ? err.message : String(err),
    });
    return ranked.map(base);
  }
}

function buildEnrichmentPrompt(
  company: Pick<Company, 'industry'>,
  items: ScoredTrendItem[],
): string {
  const lines = items.map((it, i) =>
    [
      `#${i + 1} id=${it.id}`,
      `title: ${it.title}`,
      `source: ${it.sourceLabel}`,
      it.summary ? `excerpt: ${it.summary.slice(0, 200)}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    `Industry context: ${company.industry ?? 'general B2B'}`,
    '',
    'Trend items:',
    lines.join('\n\n'),
    '',
    'Return: [{ "id": "<id>", "aiSummary": "...", "suggestedAngle": "..." }]',
  ].join('\n');
}

/**
 * A digest-level synthesis: one paragraph on today's themes, a few prioritized
 * recommendations, and trending hashtags distilled from the items. One Claude
 * call; falls back to deterministic output so the digest always has a summary.
 */
async function synthesizeDigest(
  company: Pick<Company, 'name' | 'industry'>,
  items: DigestItem[],
  brand: DigestBrand,
): Promise<{ summary: string; recommendations: string[]; hashtags: string[] }> {
  if (items.length === 0) {
    return {
      summary: 'No trends crossed the relevance bar today. Try adding keywords or sources.',
      recommendations: [],
      hashtags: [],
    };
  }

  const fallback = () => ({
    summary: `${items.length} topics are active in ${company.industry ?? 'your market'} today. The top theme: “${items[0]?.title ?? ''}”.`,
    recommendations: items
      .slice(0, 3)
      .map((it) => `Post your take on “${it.title.slice(0, 70)}”.`),
    hashtags: deriveFallbackHashtags(items),
  });

  if (!isClaudeConfigured()) return fallback();

  try {
    const out = await completeJson<{
      summary: string;
      recommendations: string[];
      hashtags: string[];
    }>({
      system:
        `You are the trend analyst for ${company.name} (${company.industry ?? 'B2B'}). ` +
        (brand.about ? `${brand.about}\n` : '') +
        `Brand voice: ${brand.voice}. ` +
        'From the trend items, produce: (1) "summary" — one tight paragraph on the ' +
        'themes worth paying attention to this week; (2) "recommendations" — 3 concrete, ' +
        'prioritized actions (each one sentence); (3) "hashtags" — 5-8 relevant hashtags ' +
        'WITHOUT the leading # . Respond with ONLY a JSON object.',
      prompt: items
        .slice(0, 12)
        .map((it, i) => `#${i + 1} ${it.title} (${it.sourceLabel})`)
        .join('\n'),
      maxTokens: 1024,
      effort: 'medium',
      tier: 'standard',
    });
    return {
      summary: out.summary?.trim() || fallback().summary,
      recommendations: Array.isArray(out.recommendations)
        ? out.recommendations.slice(0, 4).map((r) => String(r).trim()).filter(Boolean)
        : [],
      hashtags: Array.isArray(out.hashtags)
        ? out.hashtags
            .slice(0, 8)
            .map((h) => String(h).replace(/^#/, '').trim())
            .filter(Boolean)
        : deriveFallbackHashtags(items),
    };
  } catch (err) {
    logger.warn('digest: synthesis failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback();
  }
}

/** Deterministic hashtags: CamelCase the most common meaningful title words. */
function deriveFallbackHashtags(items: DigestItem[]): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
    'how', 'why', 'what', 'new', 'now', 'has', 'have', 'will', 'can', 'about',
    'into', 'out', 'its', 'their', 'a', 'an', 'to', 'of', 'in', 'on', 'is',
  ]);
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const raw of it.title.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 4 || stop.has(raw)) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));
}

/** Which trend items mention a tracked competitor (lightweight comparison). */
function findCompetitorMentions(
  items: DigestItem[],
  competitorNames: string[],
): CompetitorMention[] {
  const names = competitorNames.map((n) => n.trim()).filter((n) => n.length >= 2);
  if (names.length === 0) return [];
  const mentions: CompetitorMention[] = [];
  for (const it of items) {
    const hay = it.title.toLowerCase();
    for (const name of names) {
      if (hay.includes(name.toLowerCase())) {
        mentions.push({
          competitor: name,
          itemId: it.id,
          title: it.title,
          url: it.url,
          sourceLabel: it.sourceLabel,
        });
      }
    }
  }
  return mentions;
}

function fallbackSummary(
  item: ScoredTrendItem,
  company: Pick<Company, 'name'>,
): string {
  const eng = item.engagement.points
    ? ` It's gaining traction (${item.engagement.points} points).`
    : '';
  return `Relevant on ${item.sourceLabel} to ${company.name}.${eng}`;
}
function fallbackAngle(item: ScoredTrendItem): string {
  return `Share your team's take on "${item.title.slice(0, 80)}" and what it means for your customers.`;
}

/**
 * Coerce a stored digest payload into a shape the UI can always render.
 *
 * Digests are persisted as JSON, so rows written by older builds are missing
 * fields the current page reads. Reading `payload.skippedSources.length` on one
 * of those threw during render and took the whole AI Trend Insights page down
 * with a bare error screen. Normalizing here means an old digest degrades to
 * "fewer sections", never to a crash.
 */
export function normalizeDigestPayload(raw: unknown): DigestPayload {
  const p = (raw ?? {}) as Partial<DigestPayload>;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    items: arr<DigestItem>(p.items),
    generatedAt:
      typeof p.generatedAt === 'string' ? p.generatedAt : new Date(0).toISOString(),
    model: typeof p.model === 'string' ? p.model : 'fallback',
    sourceCounts:
      p.sourceCounts && typeof p.sourceCounts === 'object' ? p.sourceCounts : {},
    skippedSources: arr<TrendSourceId>(p.skippedSources),
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    recommendations: arr<string>(p.recommendations),
    hashtags: arr<string>(p.hashtags),
    seasonal: arr(p.seasonal),
    competitorMentions: arr(p.competitorMentions),
  };
}

/** Fetch stored digests for a company, newest first (dashboard history). */
export async function getRecentDigests(companyId: string, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return db.trendDigest.findMany({
    where: { companyId, date: { gte: since } },
    orderBy: { date: 'desc' },
  });
}

export async function getLatestDigest(companyId: string) {
  return db.trendDigest.findFirst({
    where: { companyId },
    orderBy: { date: 'desc' },
  });
}

/** Whether ANY source is currently runnable for a company (for UI guidance). */
export function describeSourceReadiness(
  config: { keywords: string[]; subreddits: string[]; rssFeeds: string[]; competitorNames: string[] },
  flags: EnabledFlags,
) {
  const ctx = {
    keywords: config.keywords,
    subreddits: config.subreddits,
    rssFeeds: config.rssFeeds,
    competitorNames: config.competitorNames,
  };
  return (Object.keys(ALL_SOURCES) as TrendSourceId[]).map((id) => ({
    id,
    label: ALL_SOURCES[id].label,
    enabled: flags[id] ?? false,
    configured: ALL_SOURCES[id].isConfigured(ctx),
  }));
}
type EnabledFlags = Partial<Record<TrendSourceId, boolean>>;
