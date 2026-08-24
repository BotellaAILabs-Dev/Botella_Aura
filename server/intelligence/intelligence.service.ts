import { z } from 'zod';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  getModel,
  isClaudeConfigured,
} from '@/server/ai/claude';
import { getBrandVoiceProfile } from '@/server/content/brand-voice.service';
import type { PerfMetrics } from '@/server/memory/metrics';
import {
  analyseContent,
  prepareDrafts,
} from '@/server/intelligence/content-intelligence';
import { analyseBrand } from '@/server/intelligence/brand-intelligence';
import { analysePerformance } from '@/server/intelligence/performance-intelligence';
import type {
  ImprovementSuggestion,
  IntelligenceCoverage,
  IntelligencePayload,
  ScoreBlock,
} from '@/server/intelligence/types';

/**
 * AI Marketing Intelligence — one computation that produces the whole
 * dashboard: marketing performance, content intelligence, brand intelligence,
 * and prioritized improvement suggestions.
 *
 * The deterministic scorers run first and always. The model is used only to
 * turn those numbers into advice — it never invents a score, so the dashboard
 * is fully functional with no AI provider configured.
 */
const DRAFT_SAMPLE = 40;

const suggestionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        area: z.enum([
          'content',
          'brand',
          'leads',
          'competitors',
          'campaigns',
          'outreach',
        ]),
        priority: z.enum(['high', 'medium', 'low']),
        title: z.string().max(120),
        rationale: z.string().max(400),
        action: z.string().max(400),
      }),
    )
    .max(8),
});

const AREA_HREF: Record<ImprovementSuggestion['area'], string> = {
  content: '/dashboard/content',
  brand: '/dashboard/settings/knowledge-base',
  leads: '/dashboard/leads',
  competitors: '/dashboard/competitors',
  campaigns: '/dashboard/campaigns',
  outreach: '/dashboard/outreach',
};

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Weighted overall score across everything we could actually measure. */
function computeOverall(
  blocks: { block: ScoreBlock; weight: number; label: string }[],
): { score: number | null; basis: string } {
  const scored = blocks.filter((b) => b.block.hasData && b.block.score !== null);
  if (scored.length === 0) {
    return {
      score: null,
      basis:
        'Nothing measurable yet. The score appears once you have content, leads, or campaigns to measure.',
    };
  }
  const totalWeight = scored.reduce((sum, b) => sum + b.weight, 0);
  const score = Math.round(
    scored.reduce((sum, b) => sum + b.block.score! * b.weight, 0) / totalWeight,
  );
  return {
    score,
    // Naming which parts contributed stops the headline number being a black box.
    basis: `Weighted across ${scored.length} measurable area${scored.length === 1 ? '' : 's'}: ${scored
      .map((b) => `${b.label} ${b.block.score}`)
      .join(', ')}.${
      scored.length < blocks.length
        ? ` ${blocks.length - scored.length} area(s) had no data and were excluded rather than counted as zero.`
        : ''
    }`,
  };
}

/** Deterministic suggestions derived straight from the computed numbers. */
function ruleBasedSuggestions(
  payload: Omit<IntelligencePayload, 'suggestions' | 'model' | 'generatedAt'>,
): ImprovementSuggestion[] {
  const out: ImprovementSuggestion[] = [];
  const { performance, content, brand } = payload;

  const push = (
    area: ImprovementSuggestion['area'],
    priority: ImprovementSuggestion['priority'],
    title: string,
    rationale: string,
    action: string,
  ) => out.push({ area, priority, title, rationale, action, href: AREA_HREF[area] });

  // Anything with a concrete recommendation already knows what is wrong.
  const blocks: [ImprovementSuggestion['area'], string, ScoreBlock][] = [
    ['campaigns', 'Campaign performance', performance.campaign],
    ['leads', 'Lead generation health', performance.leadGeneration],
    ['competitors', 'Competitor visibility', performance.competitorVisibility],
    ['content', 'Content output', performance.contentOutput],
    ['outreach', 'Outreach conversion', performance.outreach],
    ['content', 'Content quality', content.quality],
    ['content', 'Hook strength', content.hookStrength],
    ['content', 'Readability', content.readability],
    ['content', 'CTA effectiveness', content.ctaEffectiveness],
    ['content', 'Measured performance', content.performance],
    ['brand', 'Brand consistency', brand.consistency],
  ];

  for (const [area, label, block] of blocks) {
    if (!block.recommendation) continue;
    const priority: ImprovementSuggestion['priority'] = !block.hasData
      ? 'medium'
      : (block.score ?? 100) < 45
        ? 'high'
        : 'medium';
    push(
      area,
      priority,
      label,
      block.hasData ? `${label} is ${block.score}/100. ${block.basis}` : block.basis,
      block.recommendation,
    );
  }

  for (const rec of brand.vocabulary.recommendations) {
    if (rec.startsWith('Vocabulary is aligned')) continue;
    push('brand', 'medium', 'Brand vocabulary', 'From your brand voice profile.', rec);
  }

  // The single worst piece is a concrete, immediately actionable fix.
  const worst = payload.content.pieces[0];
  if (worst && worst.qualityScore < 55) {
    push(
      'content',
      'high',
      `Rewrite: “${worst.title.slice(0, 60)}”`,
      `This draft scores ${worst.qualityScore}/100 — the lowest you have. ${
        worst.hook.weaknesses[0] ?? worst.cta.notes[0] ?? ''
      }`,
      worst.hook.score < 50
        ? 'Rewrite the opening line first: one short sentence with a concrete number or a claim worth arguing with.'
        : 'Add a specific question at the end and break the body into short paragraphs.',
    );
  }

  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.priority] - order[b.priority]).slice(0, 10);
}

export async function generateIntelligenceSnapshot(args: {
  companyId: string;
  userId?: string | null;
}): Promise<IntelligencePayload> {
  const { companyId, userId } = args;

  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found.');

  const [drafts, snapshots, perf] = await Promise.all([
    db.contentDraft.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: DRAFT_SAMPLE,
    }),
    db.performanceSnapshot.findMany({
      where: { companyId, contentDraftId: { not: null } },
      select: { contentDraftId: true, metrics: true },
    }),
    analysePerformance(companyId),
  ]);

  const performanceByDraft = new Map<string, PerfMetrics[]>();
  for (const s of snapshots) {
    if (!s.contentDraftId) continue;
    const list = performanceByDraft.get(s.contentDraftId) ?? [];
    list.push((s.metrics ?? {}) as PerfMetrics);
    performanceByDraft.set(s.contentDraftId, list);
  }

  const prepared = prepareDrafts(drafts);
  const content = analyseContent(prepared, performanceByDraft);
  const brandProfile = getBrandVoiceProfile(company);
  const brand = analyseBrand(prepared, brandProfile);

  const gaps = [...perf.gaps];
  if (!brandProfile) {
    gaps.push(
      'No brand voice profile — brand consistency and tone validation are unavailable.',
    );
  }
  if (prepared.length === 0) {
    gaps.push('No analysable drafts — content and brand intelligence are unavailable.');
  }
  if (snapshots.length === 0) {
    gaps.push(
      'No performance snapshots — engagement predictions cannot be checked against real results.',
    );
  }

  const coverage: IntelligenceCoverage = {
    draftsAnalysed: prepared.length,
    publishedAnalysed: prepared.filter((p) => p.draft.status === 'PUBLISHED').length,
    performanceSnapshots: snapshots.length,
    campaigns: Number(perf.performance.campaign.detail?.campaigns ?? 0),
    leads: Number(perf.performance.leadGeneration.detail?.totalLeads ?? 0),
    competitors: Number(perf.performance.competitorVisibility.detail?.competitors ?? 0),
    hasBrandProfile: Boolean(brandProfile),
    gaps,
  };

  const overall = computeOverall([
    { block: content.quality, weight: 3, label: 'content quality' },
    { block: perf.performance.contentOutput, weight: 2, label: 'content output' },
    { block: perf.performance.leadGeneration, weight: 2, label: 'lead health' },
    { block: perf.performance.outreach, weight: 2, label: 'outreach' },
    { block: brand.consistency, weight: 2, label: 'brand consistency' },
    { block: perf.performance.campaign, weight: 1, label: 'campaigns' },
    {
      block: perf.performance.competitorVisibility,
      weight: 1,
      label: 'competitor visibility',
    },
    { block: content.performance, weight: 2, label: 'measured performance' },
  ]);

  const base = {
    overallScore: overall.score,
    overallBasis: overall.basis,
    performance: perf.performance,
    content,
    brand,
    coverage,
  };

  let suggestions = ruleBasedSuggestions(base);
  let model = 'none';

  // The model reprioritizes and sharpens; it never produces the scores.
  if (isClaudeConfigured() && (content.quality.hasData || perf.performance.leadGeneration.hasData)) {
    try {
      const facts = [
        `Overall marketing score: ${overall.score ?? 'not measurable'}`,
        ...Object.entries(perf.performance).map(
          ([k, v]) =>
            `${k}: ${v.hasData ? `${v.score}/100` : 'no data'} — ${v.basis}`,
        ),
        `content quality: ${content.quality.hasData ? `${content.quality.score}/100` : 'no data'} — ${content.quality.basis}`,
        `hook strength: ${content.hookStrength.hasData ? `${content.hookStrength.score}/100` : 'no data'}`,
        `readability: ${content.readability.hasData ? `${content.readability.score}/100` : 'no data'}`,
        `cta effectiveness: ${content.ctaEffectiveness.hasData ? `${content.ctaEffectiveness.score}/100` : 'no data'} — ${content.ctaEffectiveness.basis}`,
        `brand consistency: ${brand.consistency.hasData ? `${brand.consistency.score}/100` : 'no data'} — ${brand.consistency.basis}`,
        ...brand.toneValidation.findings.map(
          (f) => `tone "${f.descriptor}": ${f.verdict} (${f.note})`,
        ),
        ...brand.vocabulary.recommendations.map((r) => `vocabulary: ${r}`),
        ...content.pieces
          .slice(0, 5)
          .map(
            (p) =>
              `weak draft "${p.title.slice(0, 50)}" quality ${p.qualityScore}: ${
                p.hook.weaknesses[0] ?? p.cta.notes[0] ?? 'no specific weakness'
              }`,
          ),
        ...gaps.map((g) => `gap: ${g}`),
      ].join('\n');

      const ai = await completeStructured({
        schema: suggestionSchema,
        system:
          `You advise ${company.name}${company.industry ? ` (${company.industry})` : ''} on marketing execution. ` +
          'You are given MEASURED numbers from their workspace. Turn them into at ' +
          'most 8 prioritized improvement suggestions. Rules: (1) every suggestion ' +
          'must reference a specific number or finding from the input — quote it in ' +
          '`rationale`; (2) `action` must be a concrete next step someone can do ' +
          'today, not a principle; (3) never invent a metric that is not listed; ' +
          '(4) if an area says "no data", the suggestion is about starting to ' +
          'collect it, not about it being bad; (5) order by what will move results ' +
          'most. Respond with ONLY JSON matching the schema.',
        prompt: facts,
        maxTokens: 2500,
        effort: 'high',
      });

      if (ai.suggestions.length > 0) {
        suggestions = ai.suggestions.map((s) => ({
          ...s,
          href: AREA_HREF[s.area],
        }));
        model = getModel();
      }
    } catch (err) {
      logger.warn('intelligence: AI suggestions failed, using rule-based', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const payload: IntelligencePayload = {
    generatedAt: new Date().toISOString(),
    model,
    ...base,
    suggestions,
  };

  const date = startOfUtcDay();
  await db.intelligenceSnapshot.upsert({
    where: { companyId_date: { companyId, date } },
    create: {
      companyId,
      date,
      payload: payload as unknown as object,
      overallScore: payload.overallScore ?? 0,
      model,
    },
    update: {
      payload: payload as unknown as object,
      overallScore: payload.overallScore ?? 0,
      model,
      generatedAt: new Date(),
    },
  });

  await recordAudit({
    action: 'INTELLIGENCE_SNAPSHOT_GENERATED',
    userId: userId ?? null,
    companyId,
    metadata: {
      overallScore: payload.overallScore,
      draftsAnalysed: coverage.draftsAnalysed,
      model,
    },
  });

  return payload;
}

/** The most recent snapshot, or null if one has never been computed. */
export async function getLatestIntelligence(
  companyId: string,
): Promise<IntelligencePayload | null> {
  const row = await db.intelligenceSnapshot.findFirst({
    where: { companyId },
    orderBy: { date: 'desc' },
  });
  return row ? (row.payload as unknown as IntelligencePayload) : null;
}

/** Overall-score history for the movement sparkline. */
export async function getScoreHistory(
  companyId: string,
  days = 30,
): Promise<{ date: string; score: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.intelligenceSnapshot.findMany({
    where: { companyId, date: { gte: since } },
    orderBy: { date: 'asc' },
    select: { date: true, overallScore: true },
  });
  return rows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    score: r.overallScore,
  }));
}
