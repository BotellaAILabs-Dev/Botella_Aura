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
import { scoreAndRank } from '@/server/trends/scoring';
import {
  ensureTrendConfig,
  getEnabledFlags,
  seedSmartDefaults,
  toFetchContext,
} from '@/server/services/trend-config.service';
import type {
  DigestItem,
  DigestPayload,
  ScoredTrendItem,
  TrendItem,
  TrendSourceId,
} from '@/server/trends/types';

const TOP_N = 8;

/** Start of the current UTC day — the idempotency key for a company's digest. */
function todayUtc(now: number = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

interface GenerateArgs {
  companyId: string;
  /** Who triggered it (manual refresh). Null for the scheduled job. */
  userId?: string | null;
  trigger: 'scheduled' | 'manual';
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
}: GenerateArgs) {
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
  const items = await enrichItems(company, ranked);

  const payload: DigestPayload = {
    items,
    generatedAt: new Date().toISOString(),
    model: isClaudeConfigured() ? getModel() : 'fallback',
    sourceCounts,
    skippedSources,
  };

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
  company: Pick<Company, 'name' | 'industry' | 'brandVoiceNotes'>,
  ranked: ScoredTrendItem[],
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
        `You help ${company.name} decide what to post about. Their brand voice: ` +
        `${company.brandVoiceNotes || 'professional, practical, no hype'}. ` +
        'For each trend item, write (1) a one-sentence "why this matters to ' +
        `${company.name}" and (2) a concrete suggested post angle/hook in their ` +
        'voice. Respond with ONLY a JSON array, no prose.',
      prompt: buildEnrichmentPrompt(company, ranked),
      maxTokens: 2048,
      effort: 'medium',
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
