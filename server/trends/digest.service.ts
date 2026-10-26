import type { Company } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  anglePolicyFor,
  classifySource,
  TOPIC_LABEL,
  type SourceSafety,
} from '@/lib/brand-safety';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
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

/** The shape the enrichment call must return — validated, not hoped for. */
const enrichmentSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().max(80),
        aiSummary: z.string().max(600).default(''),
        suggestedAngle: z.string().max(600).default(''),
        /**
         * The model's own judgment, on top of the deterministic verdict.
         * Either saying no is enough — this catches what the patterns cannot
         * (a story that is bleak without using any of the words), and the
         * patterns catch what a cooperative model talks itself past.
         */
        suitableForPromotion: z.boolean().default(true),
        notSuitableReason: z.string().max(300).default(''),
      }),
    )
    .max(60),
});

/**
 * Enrich the top ranked items with a "why this matters" note and a suggested
 * post angle. One Claude call for the whole batch (cost-efficient), keyed by
 * item id. Falls back to a deterministic summary when Claude is unavailable or
 * errors — the digest still ships, clearly labeled as a fallback via payload.model.
 *
 * Every item is classified for brand safety FIRST, without a model
 * (lib/brand-safety.ts). That order is the point. This function used to ask
 * for "a concrete suggested post angle/hook" for every item it was handed,
 * including a news story about people dying — and that angle then became the
 * brief a post promoting whiskey was written from. The classification decides
 * what may be asked for; the model never gets to decide that an angle exists.
 *
 * It was also the last generation path on the unvalidated `completeJson`: a
 * reply with the wrong shape silently became "no enrichment", so a prompt that
 * had quietly stopped working looked exactly like a quiet fallback. It is now
 * schema-validated like the rest of the pipeline.
 */
async function enrichItems(
  company: Pick<Company, 'name' | 'industry'>,
  ranked: ScoredTrendItem[],
  brand: DigestBrand,
): Promise<DigestItem[]> {
  // Title, excerpt and source — everything known about the item before a
  // model sees it.
  const safetyOf = (item: ScoredTrendItem) =>
    classifySource([item.title, item.summary ?? ''].join('\n'));

  const base = (item: ScoredTrendItem): DigestItem => {
    const safety = safetyOf(item);
    const concerns = [...new Set(safety.hits.map((h) => TOPIC_LABEL[h.topic]))];
    return {
      id: item.id,
      title: item.title,
      url: item.url,
      source: item.source,
      sourceLabel: item.sourceLabel,
      score: item.score,
      publishedAt: item.publishedAt,
      aiSummary: fallbackSummary(item, company),
      suggestedAngle: fallbackAngle(item, safety),
      safety: {
        posture: safety.posture,
        concerns,
        suitableForPromotion: safety.posture !== 'unsuitable',
        reason: safety.reason,
      },
    };
  };

  if (ranked.length === 0) return [];
  if (!isClaudeConfigured()) return ranked.map(base);

  const sensitive = ranked.filter((i) => safetyOf(i).posture !== 'clear');

  try {
    const { items: enriched } = await completeStructured({
      schema: enrichmentSchema,
      system: [
        `You help ${company.name} decide what to post about.`,
        brand.about,
        `Their brand voice: ${brand.voice}.`,
        'For each trend item, write (1) a one-sentence "why this matters to ' +
          `${company.name}" and (2) a concrete suggested post angle or hook in their voice.`,
        '',
        'BRAND SAFETY — this overrides everything else:',
        'Some news is not marketing material. If an item involves death, injury, violence, a disaster, crime, serious illness, war or real hardship, a brand must not use it as an occasion to promote, celebrate or sell anything — however indirect the link and however tasteful the wording.',
        'For any such item set `suitableForPromotion` to false, give one plain sentence in `notSuitableReason`, and do NOT write a marketing hook in `suggestedAngle`: write instead what the business should understand from it, or say plainly that there is nothing to post.',
        'Never suggest that the product comforts people, brings them together, or helps them through such an event.',
        'This is not a judgment call to balance against engagement. When in doubt, say it is not suitable.',
        '',
        'Respond with ONLY valid JSON, no prose.',
      ]
        .filter(Boolean)
        .join('\n'),
      prompt: buildEnrichmentPrompt(company, ranked),
      maxTokens: 3000,
      effort: 'medium',
      tier: 'standard',
    });

    const byId = new Map(enriched.map((e) => [e.id, e]));
    return ranked.map((item) => {
      const e = byId.get(item.id);
      const out = base(item);
      if (e?.aiSummary.trim()) out.aiSummary = e.aiSummary.trim();

      // The two verdicts are combined by taking the stricter: the patterns
      // cannot read a story that is grim without grim words, and a helpful
      // model will talk itself past one that has them.
      const deterministic = out.safety!;
      const suitable =
        deterministic.suitableForPromotion && (e?.suitableForPromotion ?? true);
      out.safety = {
        ...deterministic,
        suitableForPromotion: suitable,
        reason:
          deterministic.reason ??
          (e?.notSuitableReason.trim() ? e.notSuitableReason.trim() : null),
        // A model-only objection still means the item needs careful handling.
        posture:
          deterministic.posture === 'clear' && !suitable
            ? 'caution'
            : deterministic.posture,
      };

      // The angle is taken only when the item may carry one. On an unsuitable
      // item the deterministic line stands, whatever came back — this is the
      // exact field that caused the failure, so it is not left to the model.
      if (e?.suggestedAngle.trim() && suitable) {
        out.suggestedAngle = e.suggestedAngle.trim();
      }
      return out;
    });
  } catch (err) {
    logger.warn('digest: AI enrichment failed, using fallback summaries', {
      error: err instanceof Error ? err.message : String(err),
      sensitiveItems: sensitive.length,
    });
    return ranked.map(base);
  }
}

function buildEnrichmentPrompt(
  company: Pick<Company, 'industry'>,
  items: ScoredTrendItem[],
): string {
  const lines = items.map((it, i) => {
    // The verdict is stated on the item itself rather than as a general
    // caution at the top. A policy in a preamble gets averaged across a list
    // of twenty; attached to the item it applies to, it is unmissable.
    const safety = classifySource([it.title, it.summary ?? ''].join('\n'));
    return [
      `#${i + 1} id=${it.id}`,
      `title: ${it.title}`,
      `source: ${it.sourceLabel}`,
      it.summary ? `excerpt: ${it.summary.slice(0, 200)}` : undefined,
      safety.posture !== 'clear'
        ? `!! BRAND SAFETY: ${anglePolicyFor(safety)}`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    `Industry context: ${company.industry ?? 'general B2B'}`,
    '',
    'Trend items:',
    lines.join('\n\n'),
    '',
    'Return JSON of this exact shape, one entry per item:',
    '{ "items": [{ "id": "<id>", "aiSummary": "...", "suggestedAngle": "...",',
    '  "suitableForPromotion": true|false, "notSuitableReason": "" }] }',
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

  // The recommendations are "post about this" instructions, so an unsuitable
  // item must not become one — in the fallback either, which is what runs
  // whenever there is no API key or the call fails.
  const postable = items.filter(
    (it) => it.safety?.suitableForPromotion !== false,
  );

  const fallback = () => ({
    summary: `${items.length} topics are active in ${company.industry ?? 'your market'} today. The top theme: “${items[0]?.title ?? ''}”.`,
    recommendations: postable
      .slice(0, 3)
      .map((it) => `Post your take on “${it.title.slice(0, 70)}”.`),
    hashtags: deriveFallbackHashtags(items),
  });

  if (!isClaudeConfigured()) return fallback();

  const excluded = items.filter(
    (it) => it.safety?.suitableForPromotion === false,
  );

  try {
    const out = await completeStructured({
      schema: z.object({
        summary: z.string().max(1500).default(''),
        recommendations: z.array(z.string().max(300)).max(6).default([]),
        hashtags: z.array(z.string().max(60)).max(12).default([]),
      }),
      system:
        `You are the trend analyst for ${company.name} (${company.industry ?? 'B2B'}). ` +
        (brand.about ? `${brand.about}\n` : '') +
        `Brand voice: ${brand.voice}. ` +
        'From the trend items, produce: (1) "summary" — one tight paragraph on the ' +
        'themes worth paying attention to this week; (2) "recommendations" — 3 concrete, ' +
        'prioritized actions (each one sentence); (3) "hashtags" — 5-8 relevant hashtags ' +
        'WITHOUT the leading # . ' +
        'Items marked NOT FOR PROMOTION may inform the summary, but must never ' +
        'become a recommendation to post, and must not supply a hashtag. Never ' +
        'recommend marketing off death, injury, disaster, crime or hardship. ' +
        'Respond with ONLY a JSON object.',
      prompt: [
        ...items
          .slice(0, 12)
          .map(
            (it, i) =>
              `#${i + 1} ${it.title} (${it.sourceLabel})${
                it.safety?.suitableForPromotion === false
                  ? ' — NOT FOR PROMOTION'
                  : ''
              }`,
          ),
        '',
        'Return JSON: { "summary": "...", "recommendations": ["..."], "hashtags": ["..."] }',
      ].join('\n'),
      maxTokens: 1024,
      effort: 'medium',
      tier: 'standard',
    });
    return {
      summary: out.summary.trim() || fallback().summary,
      // Belt and braces: a recommendation that names an excluded item's
      // headline is dropped, whatever the instruction said.
      recommendations: out.recommendations
        .map((r) => r.trim())
        .filter(Boolean)
        .filter((r) => !namesExcluded(r, excluded))
        .slice(0, 4),
      hashtags: out.hashtags.length
        ? out.hashtags.map((h) => h.replace(/^#/, '').trim()).filter(Boolean)
        : deriveFallbackHashtags(items),
    };
  } catch (err) {
    logger.warn('digest: synthesis failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback();
  }
}

/**
 * Does this recommendation point at an item that must not be posted about?
 *
 * Matched on the distinctive words of the excluded headline rather than the
 * whole string, because a recommendation paraphrases ("Share your view on the
 * crash outside the distillery") instead of quoting. Four or more shared
 * distinctive words is a reference; fewer is a coincidence of vocabulary.
 */
function namesExcluded(recommendation: string, excluded: DigestItem[]): boolean {
  if (!excluded.length) return false;
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 4),
    );
  const rec = words(recommendation);
  if (rec.size === 0) return false;
  return excluded.some((it) => {
    const title = words(it.title);
    if (title.size === 0) return false;
    let shared = 0;
    for (const w of title) if (rec.has(w)) shared++;
    return shared >= Math.min(4, title.size);
  });
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
/**
 * The angle when no model wrote one.
 *
 * The fallback has to respect brand safety too: "Share your team's take on
 * <story about a fatal crash>" is the same failure with no model involved,
 * and this path runs on every deployment without an API key and every time
 * the enrichment call fails.
 */
function fallbackAngle(item: ScoredTrendItem, safety: SourceSafety): string {
  if (safety.posture === 'unsuitable') {
    return `Not something to post about commercially — this item involves ${[
      ...new Set(safety.hits.map((h) => TOPIC_LABEL[h.topic])),
    ]
      .slice(0, 2)
      .join(' and ')}. Read it for context, not for content.`;
  }
  if (safety.posture === 'caution') {
    return `If you post about this, keep it factual and useful — no promotion, no urgency, and nothing that reads as benefiting from it.`;
  }
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
