import type { InsightType } from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import { extractedInsightsSchema } from '@/lib/validations/memory';
import {
  confidenceFromSample,
  hasEnoughData,
  MIN_SAMPLE_FOR_INSIGHTS,
} from '@/server/memory/metrics';
import { getContentPerformance, type ContentPerf } from '@/server/memory/performance.service';

/**
 * Pattern-extraction engine (Sprint 5, Module 2). A weekly per-company job that
 * turns REAL PerformanceSnapshot data into structured MarketingMemory insights.
 *
 * NON-NEGOTIABLE #2/#3: below MIN_SAMPLE_FOR_INSIGHTS published-with-metrics
 * posts we emit an honest "not enough data" note — never fabricated insights —
 * and every real insight records the data basis that supports it.
 */
interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ExtractionResult {
  status: 'insufficient' | 'ok';
  sampleSize: number;
  created: number;
}

export async function generateMemories(args: {
  companyId: string;
  userId?: string | null;
  requestMeta?: Meta;
}): Promise<ExtractionResult> {
  const { companyId, userId, requestMeta } = args;
  const perf = await getContentPerformance(companyId);
  const sampleSize = perf.length;

  // Regenerate replaces: deactivate the prior generation.
  await db.marketingMemory.updateMany({
    where: { companyId, isActive: true },
    data: { isActive: false },
  });

  if (!hasEnoughData(sampleSize)) {
    await db.marketingMemory.create({
      data: {
        companyId,
        insightType: 'OTHER',
        insight: `Not enough data yet — publish and sync metrics for at least ${MIN_SAMPLE_FOR_INSIGHTS} posts, then check back. (${sampleSize} so far.)`,
        confidence: 'LOW',
        sampleSize,
        supportingDataSummary: { status: 'insufficient', have: sampleSize, need: MIN_SAMPLE_FOR_INSIGHTS },
      },
    });
    await recordAudit({
      action: 'MARKETING_MEMORY_GENERATED',
      userId: userId ?? null,
      companyId,
      metadata: { status: 'insufficient', sampleSize },
      ...requestMeta,
    });
    return { status: 'insufficient', sampleSize, created: 1 };
  }

  const confidence = confidenceFromSample(sampleSize);
  const insights = isClaudeConfigured()
    ? await extractWithClaude(perf).catch((err) => {
        logger.warn('memory: AI extraction failed, using deterministic', {
          error: err instanceof Error ? err.message : String(err),
        });
        return analyzeDeterministic(perf);
      })
    : analyzeDeterministic(perf);

  let created = 0;
  for (const ins of insights) {
    await db.marketingMemory.create({
      data: {
        companyId,
        insightType: ins.insightType,
        insight: ins.insight,
        confidence,
        sampleSize,
        supportingDataSummary: {
          basis: ins.basis,
          metric: 'engagement',
          sampleSize,
          model: isClaudeConfigured() ? DEFAULT_MODEL : 'deterministic',
        },
      },
    });
    created++;
  }

  await recordAudit({
    action: 'MARKETING_MEMORY_GENERATED',
    userId: userId ?? null,
    companyId,
    metadata: { status: 'ok', sampleSize, created },
    ...requestMeta,
  });
  return { status: 'ok', sampleSize, created };
}

// ---- extraction strategies --------------------------------------------------

type RawInsight = { insightType: InsightType; insight: string; basis: string };

async function extractWithClaude(perf: ContentPerf[]): Promise<RawInsight[]> {
  const rows = perf.map((p) => ({
    type: p.type,
    words: p.wordCount,
    weekday: p.publishedAt ? new Date(p.publishedAt).toLocaleDateString('en-US', { weekday: 'short' }) : 'n/a',
    engagement: p.engagement,
  }));
  const result = await completeStructured({
    schema: extractedInsightsSchema,
    system:
      'You are a marketing data analyst. Given a table of this account\'s past ' +
      'posts with their real engagement, extract up to 5 SPECIFIC, data-grounded ' +
      'patterns (format, length, timing, topic, hashtags). Base every insight ' +
      'ONLY on the numbers provided — do NOT invent trends. If the data does not ' +
      'clearly support a pattern, return fewer insights. Each needs a one-line ' +
      '`basis` citing the actual comparison. Respond with ONLY JSON.',
    prompt: `Posts (engagement is a weighted score):\n${JSON.stringify(rows)}`,
    maxTokens: 1200,
    effort: 'medium',
  });
  return result.insights;
}

const avg = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);

/**
 * Deterministic, data-grounded extraction used when Claude isn't configured.
 * Pure + exported for tests. Emits an insight ONLY when the data shows a clear
 * difference — never a generic guess.
 */
export function analyzeDeterministic(perf: ContentPerf[]): RawInsight[] {
  const insights: RawInsight[] = [];

  // 1) Content format: best vs worst average engagement by type.
  const byType = new Map<string, number[]>();
  for (const p of perf) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type)!.push(p.engagement);
  }
  const typeAverages = [...byType.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([type, v]) => ({ type, avg: avg(v), n: v.length }))
    .sort((a, b) => b.avg - a.avg);
  if (typeAverages.length >= 2) {
    const top = typeAverages[0]!;
    const bottom = typeAverages[typeAverages.length - 1]!;
    if (top.avg > bottom.avg * 1.25) {
      insights.push({
        insightType: 'CONTENT_FORMAT',
        insight: `${top.type} posts outperformed ${bottom.type} (avg engagement ${top.avg.toFixed(0)} vs ${bottom.avg.toFixed(0)}). Favor ${top.type} where it fits.`,
        basis: `${top.n} ${top.type} vs ${bottom.n} ${bottom.type} posts`,
      });
    }
  }

  // 2) Length: short (<150 words) vs longer.
  const short = perf.filter((p) => p.wordCount > 0 && p.wordCount < 150).map((p) => p.engagement);
  const long = perf.filter((p) => p.wordCount >= 150).map((p) => p.engagement);
  if (short.length >= 2 && long.length >= 2) {
    const sAvg = avg(short);
    const lAvg = avg(long);
    if (Math.abs(sAvg - lAvg) > Math.max(sAvg, lAvg) * 0.2) {
      const shorterWins = sAvg > lAvg;
      insights.push({
        insightType: 'CONTENT_LENGTH',
        insight: shorterWins
          ? `Shorter posts (<150 words) outperformed longer ones (avg ${sAvg.toFixed(0)} vs ${lAvg.toFixed(0)}).`
          : `Longer posts outperformed short ones (avg ${lAvg.toFixed(0)} vs ${sAvg.toFixed(0)}).`,
        basis: `${short.length} short vs ${long.length} long posts`,
      });
    }
  }

  // 3) Timing: best weekday.
  const byDay = new Map<string, number[]>();
  for (const p of perf) {
    if (!p.publishedAt) continue;
    const day = new Date(p.publishedAt).toLocaleDateString('en-US', { weekday: 'long' });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(p.engagement);
  }
  const dayAverages = [...byDay.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([day, v]) => ({ day, avg: avg(v), n: v.length }))
    .sort((a, b) => b.avg - a.avg);
  if (dayAverages.length >= 2 && dayAverages[0]!.avg > dayAverages[dayAverages.length - 1]!.avg * 1.25) {
    const best = dayAverages[0]!;
    insights.push({
      insightType: 'TIMING',
      insight: `${best.day} posts got the most engagement (avg ${best.avg.toFixed(0)}).`,
      basis: `${best.n} posts on ${best.day}`,
    });
  }

  return insights;
}
