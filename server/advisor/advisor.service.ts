import { z } from 'zod';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  expireOpportunities,
  recordOpportunity,
} from '@/server/opportunities/opportunity.service';
import { advisorToOpportunityInput } from '@/server/opportunities/from-advisor';
import { collectSignals } from '@/server/signals/signal.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { runAiDetection } from '@/server/opportunities/ai-detection.service';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  getModel,
  isClaudeConfigured,
} from '@/server/ai/claude';
import {
  businessContextToPrompt,
  getBusinessContext,
} from '@/server/business-context/business-context.service';
import { normalizeDigestPayload } from '@/server/trends/digest.service';
import type { ChangesSummary } from '@/server/competitors/types';
import type {
  AdvisorCoverage,
  AdvisorPayload,
  CampaignOpportunity,
  CompetitiveGap,
  OpportunityEvidence,
} from '@/server/advisor/types';

/**
 * AI Marketing Advisor.
 *
 * Reads what competitors actually did (snapshots from the last 30 days), what
 * the market is talking about (recent trend digests), and what this company has
 * already published + learned, then proposes campaign opportunities.
 *
 * Two rules make this trustworthy rather than generic:
 *   1. Every opportunity must cite evidence rows we collected — the model is
 *      given the evidence and told to reference it, and anything it returns
 *      without a recognisable source is dropped.
 *   2. With no signal at all we return an honest empty result explaining what
 *      to connect, instead of inventing plausible-sounding campaigns.
 */
const LOOKBACK_DAYS = 30;
const MAX_OPPORTUNITIES = 6;

const ratingEnum = z.enum(['low', 'medium', 'high']);

const aiSchema = z.object({
  summary: z.string(),
  opportunities: z
    .array(
      z.object({
        title: z.string(),
        inspiredBy: z.string().optional(),
        rationale: z.string(),
        angle: z.string(),
        channels: z.array(z.string()).max(5),
        contentIdeas: z.array(z.string()).max(5),
        effort: ratingEnum,
        impact: ratingEnum,
        timing: z.string(),
        /** Indices into the evidence list we supplied. */
        evidenceRefs: z.array(z.number().int()).max(6),
      }),
    )
    .max(MAX_OPPORTUNITIES),
  gaps: z
    .array(
      z.object({
        theme: z.string(),
        observation: z.string(),
        suggestion: z.string(),
        competitors: z.array(z.string()).max(6),
      }),
    )
    .max(4),
});

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

interface Signal {
  evidence: OpportunityEvidence[];
  coverage: AdvisorCoverage;
  competitorNames: string[];
  ownTopics: string[];
}

/** Gather every real observation the advisor is allowed to reason from. */
async function collectSignal(companyId: string): Promise<Signal> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const skipped: string[] = [];
  const evidence: OpportunityEvidence[] = [];

  const [competitors, digests, drafts, memories] = await Promise.all([
    db.competitorProfile.findMany({
      where: { companyId },
      select: {
        name: true,
        snapshots: {
          where: { capturedAt: { gte: since } },
          orderBy: { capturedAt: 'desc' },
          take: 4,
          select: { id: true, capturedAt: true, changesSummary: true },
        },
      },
    }),
    db.trendDigest.findMany({
      where: { companyId, date: { gte: since } },
      orderBy: { date: 'desc' },
      take: 5,
      select: { id: true, date: true, payload: true },
    }),
    db.contentDraft.findMany({
      where: { companyId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { title: true, type: true, status: true },
    }),
    db.marketingMemory.findMany({
      where: { companyId, isActive: true },
      orderBy: { generatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        generatedAt: true,
        insight: true,
        insightType: true,
        confidence: true,
      },
    }),
  ]);

  // --- Competitor moves ---------------------------------------------------
  let competitorSignals = 0;
  for (const c of competitors) {
    for (const snap of c.snapshots) {
      const s = snap.changesSummary as ChangesSummary | null;
      if (!s) continue;
      // Every observation below came from this snapshot.
      const signal = {
        kind: 'COMPETITOR_SNAPSHOT' as const,
        refId: snap.id,
        observedAt: snap.capturedAt.toISOString(),
      };
      if (s.homepage) {
        evidence.push({
          kind: 'competitor',
          signal,
          label: c.name,
          detail: `Homepage change: ${s.homepage}`,
        });
        competitorSignals++;
      }
      if (s.pricing) {
        evidence.push({
          kind: 'competitor',
          signal,
          label: c.name,
          detail: `Pricing change: ${s.pricing}`,
        });
        competitorSignals++;
      }
      if (s.baseline?.homepage) {
        evidence.push({
          kind: 'competitor',
          signal,
          label: c.name,
          detail: `Current positioning: ${s.baseline.homepage}`,
        });
        competitorSignals++;
      }
      for (const n of (s.news ?? []).slice(0, 3)) {
        evidence.push({
          kind: 'competitor',
          signal,
          label: c.name,
          detail: `In the news: ${n.title}`,
          ...(n.url ? { url: n.url } : {}),
        });
        competitorSignals++;
      }
      if (s.github?.latestRelease) {
        evidence.push({
          kind: 'competitor',
          signal,
          label: c.name,
          detail: `Shipped ${s.github.latestRelease.name} in ${s.github.latestRelease.repo}`,
          url: s.github.latestRelease.url,
        });
        competitorSignals++;
      }
    }
  }
  if (competitors.length === 0) {
    skipped.push(
      'No competitors are being tracked — add competitors to get competitor-inspired opportunities.',
    );
  } else if (competitorSignals === 0) {
    skipped.push(
      `Tracking ${competitors.length} competitor(s) but no captures in the last ${LOOKBACK_DAYS} days — run a competitor report to capture a snapshot.`,
    );
  }

  // --- Market trends ------------------------------------------------------
  let trendItems = 0;
  const seenTrends = new Set<string>();
  for (const d of digests) {
    const payload = normalizeDigestPayload(d.payload);
    for (const item of payload.items.slice(0, 6)) {
      if (seenTrends.has(item.title)) continue;
      seenTrends.add(item.title);
      evidence.push({
        kind: 'trend',
        signal: {
          kind: 'TREND_ITEM',
          refId: `${d.id}:${item.id}`,
          observedAt: d.date.toISOString(),
        },
        label: item.sourceLabel,
        detail: `${item.title} — ${item.aiSummary}`,
        url: item.url,
      });
      trendItems++;
      if (trendItems >= 15) break;
    }
    if (trendItems >= 15) break;
  }
  if (trendItems === 0) {
    skipped.push(
      'No trend digest in the last 30 days — refresh AI Trend Insights so opportunities can reference what the market is discussing.',
    );
  }

  // --- What we already learned -------------------------------------------
  for (const m of memories) {
    evidence.push({
      kind: 'memory',
      signal: {
        kind: 'MEMORY_INSIGHT',
        refId: m.id,
        observedAt: m.generatedAt.toISOString(),
      },
      label: m.insightType,
      detail: `${m.insight} (confidence: ${m.confidence.toLowerCase()})`,
    });
  }

  // --- What we already publish (so suggestions are not duplicates) --------
  const ownTopics = drafts
    .map((d) => d.title)
    .filter((t): t is string => Boolean(t))
    .slice(0, 15);
  if (ownTopics.length > 0) {
    evidence.push({
      kind: 'gap',
      // A summary of several drafts, so no single record id.
      signal: { kind: 'CONTENT_DRAFT', refId: null },
      label: 'Your recent content',
      detail: `Already covered: ${ownTopics.slice(0, 10).join('; ')}`,
    });
  }

  return {
    evidence,
    coverage: {
      competitorsTracked: competitors.length,
      competitorSignals,
      trendItems,
      recentDrafts: drafts.length,
      memoryInsights: memories.length,
      skipped,
    },
    competitorNames: competitors.map((c) => c.name),
    ownTopics,
  };
}

/** Deterministic opportunities used when no AI provider is configured. */
function deterministicOpportunities(
  signal: Signal,
): { opportunities: CampaignOpportunity[]; gaps: CompetitiveGap[]; summary: string } {
  const competitorEvidence = signal.evidence.filter((e) => e.kind === 'competitor');
  const trendEvidence = signal.evidence.filter((e) => e.kind === 'trend');

  const opportunities: CampaignOpportunity[] = [];

  // One opportunity per distinct competitor move, capped.
  const byCompetitor = new Map<string, OpportunityEvidence[]>();
  for (const e of competitorEvidence) {
    if (!byCompetitor.has(e.label)) byCompetitor.set(e.label, []);
    byCompetitor.get(e.label)!.push(e);
  }
  for (const [name, items] of [...byCompetitor.entries()].slice(0, 3)) {
    const lead = items[0]!;
    opportunities.push({
      id: `competitor-${name.toLowerCase().replace(/\W+/g, '-')}`,
      title: `Respond to ${name}'s recent move`,
      inspiredBy: name,
      rationale: `${name} made a public change your buyers can see: ${lead.detail}`,
      angle: `Address the same buyer question ${name} is answering, but from your own point of view — do not mirror their wording.`,
      channels: ['LinkedIn'],
      contentIdeas: [
        `A post on what ${name}'s change means for buyers evaluating this category`,
        'A comparison piece grounded in your own customers’ experience',
        'A short customer story that makes your difference concrete',
      ],
      effort: 'low',
      impact: 'medium',
      timing: 'This week, while the change is still fresh',
      evidence: items.slice(0, 4),
    });
  }

  for (const t of trendEvidence.slice(0, 2)) {
    opportunities.push({
      id: `trend-${t.detail.slice(0, 24).toLowerCase().replace(/\W+/g, '-')}`,
      title: `Take a position on: ${t.detail.split('—')[0]!.trim()}`,
      rationale: `This is active in your market right now (${t.label}).`,
      angle: 'Lead with a specific opinion and one piece of first-hand evidence.',
      channels: ['LinkedIn'],
      contentIdeas: [
        'A short opinion post with one concrete example',
        'A carousel breaking the topic into what changes for buyers',
        'A follow-up post answering the objections the first one attracts',
      ],
      effort: 'low',
      impact: 'medium',
      timing: 'Within the next few days',
      evidence: [t],
    });
  }

  const gaps: CompetitiveGap[] =
    byCompetitor.size > 0
      ? [
          {
            theme: 'Competitor messaging changes',
            observation: `${byCompetitor.size} tracked competitor(s) changed public messaging in the last ${LOOKBACK_DAYS} days.`,
            suggestion:
              'Review their positioning against yours and decide where to sharpen your difference.',
            competitors: [...byCompetitor.keys()],
          },
        ]
      : [];

  return {
    opportunities,
    gaps,
    summary: opportunities.length
      ? `${opportunities.length} opportunity/opportunities built from ${competitorEvidence.length} competitor observation(s) and ${trendEvidence.length} trend item(s). Connect an AI provider for a richer, prioritized plan.`
      : 'Not enough signal yet to suggest campaigns.',
  };
}

/** Generate (or regenerate) today's advisor report. Idempotent per day. */
export async function generateAdvisorReport(args: {
  companyId: string;
  userId?: string | null;
}): Promise<AdvisorPayload> {
  const { companyId, userId } = args;

  const company = await db.company.findUnique({ where: { id: companyId } });
  /**
   * The advisor recommends what to MARKET, and used to do it knowing only a
   * company name, an industry label and a tone.
   *
   * Everything the workspace said about its buyers — who they are, whether
   * they are spending a budget or their own money, what the business is aiming
   * at — reached content drafts and stopped there. So a consumer brand got
   * campaign opportunities argued in terms of pipeline and procurement cycles,
   * and a recommendation could target a reader the company had explicitly said
   * it does not sell to. Both blocks degrade to '' for a workspace that has
   * said nothing, leaving the old prompt untouched.
   */
  const context = await getBusinessContext(companyId, {
    sections: ['targeting', 'connections'],
  });
  if (!company) throw new Error('Company not found.');

  const signal = await collectSignal(companyId);
  const hasSignal = signal.evidence.some(
    (e) => e.kind === 'competitor' || e.kind === 'trend',
  );

  let payload: AdvisorPayload;

  if (!hasSignal) {
    // Honest empty state — never fabricate campaigns from nothing.
    payload = {
      generatedAt: new Date().toISOString(),
      model: 'none',
      summary:
        'There is no competitor or market signal to reason from yet. Track a competitor and refresh AI Trend Insights, then generate again — every opportunity here is tied to a real observation, so we will not invent them.',
      opportunities: [],
      gaps: [],
      coverage: signal.coverage,
    };
  } else if (!isClaudeConfigured()) {
    const fallback = deterministicOpportunities(signal);
    payload = {
      generatedAt: new Date().toISOString(),
      model: 'none',
      ...fallback,
      coverage: signal.coverage,
    };
  } else {
    try {
      const evidenceList = signal.evidence
        .map((e, i) => `[${i}] (${e.kind}) ${e.label}: ${e.detail}`)
        .join('\n');

      const ai = await completeStructured({
        schema: aiSchema,
        system:
          `You are the marketing strategist for ${company.name}` +
          `${company.industry ? ` (${company.industry})` : ''}.\n` +
          // Identity, reader and channels, with unconfirmed or stale facts
          // labelled, so an opportunity is never argued from an assumption.
          `${businessContextToPrompt(context, { identity: true, audience: true, channels: true })}\n` +
          'Every opportunity must be aimed at THAT reader — an opportunity a ' +
          'different audience would care about is the wrong opportunity, ' +
          'however good the evidence behind it.\n' +
          // Resolved by the context layer: reviewed profile, then the owner's
          // notes, then plan guidelines — the order this used to inline.
          `Brand voice: ${context?.voice.summary || 'professional, practical, no hype'}. ` +
          'You are given numbered EVIDENCE about competitor activity, market ' +
          'trends, what this company already published, and what it has learned. ' +
          'Propose campaign opportunities that are DIRECTLY traceable to that ' +
          'evidence. Rules: (1) every opportunity must cite the evidence indices ' +
          'it came from in evidenceRefs; (2) never propose copying a competitor — ' +
          'propose a differentiated angle; (3) do not repeat topics the company ' +
          'already covered; (4) invent no facts that are not in the evidence; ' +
          '(5) prefer fewer, sharper opportunities over a long generic list. ' +
          'Also list `gaps`: themes competitors are consistently active on where ' +
          'this company is absent. Respond with ONLY JSON matching the schema.',
        prompt: [
          `Company: ${company.name}`,
          `Industry: ${company.industry ?? 'unspecified'}`,
          context?.objectives.goals
            ? `What the business is working towards: ${context.objectives.goals}`
            : '',
          `Tracked competitors: ${signal.competitorNames.join(', ') || 'none'}`,
          '',
          'EVIDENCE:',
          evidenceList,
          '',
          `Return at most ${MAX_OPPORTUNITIES} opportunities.`,
        ].join('\n'),
        maxTokens: 3000,
        effort: 'high',
      });

      const opportunities: CampaignOpportunity[] = ai.opportunities
        .map((o, i) => {
          const cited = o.evidenceRefs
            .map((idx) => signal.evidence[idx])
            .filter((e): e is OpportunityEvidence => Boolean(e));
          return {
            id: `opp-${i + 1}`,
            title: o.title,
            ...(o.inspiredBy ? { inspiredBy: o.inspiredBy } : {}),
            rationale: o.rationale,
            angle: o.angle,
            channels: o.channels.length ? o.channels : ['LinkedIn'],
            contentIdeas: o.contentIdeas,
            effort: o.effort,
            impact: o.impact,
            timing: o.timing,
            evidence: cited,
          };
        })
        // An opportunity that cites nothing we collected is not grounded.
        .filter((o) => o.evidence.length > 0);

      payload = {
        generatedAt: new Date().toISOString(),
        model: getModel(),
        summary: ai.summary,
        opportunities,
        gaps: ai.gaps,
        coverage: signal.coverage,
      };

      if (opportunities.length === 0) {
        const fallback = deterministicOpportunities(signal);
        payload = { ...payload, ...fallback, model: 'none' };
      }
    } catch (err) {
      logger.warn('advisor: AI generation failed, using deterministic advisor', {
        error: err instanceof Error ? err.message : String(err),
      });
      const fallback = deterministicOpportunities(signal);
      payload = {
        generatedAt: new Date().toISOString(),
        model: 'none',
        ...fallback,
        coverage: signal.coverage,
      };
    }
  }

  // Store each opportunity on its own, with its evidence linked to the
  // records it came from, so it can be tracked through its lifecycle rather
  // than living only inside today's report. Best-effort: a storage failure is
  // logged and never stops the advisor from returning its report.
  await expireOpportunities(companyId).catch(() => 0);
  // Keep the signal store current for opportunity detection. Best-effort, like
  // storing opportunities: it never stops the advisor's report.
  await collectSignals(companyId, { context }).catch((err) =>
    logger.warn('advisor: signal collection failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  // Rule-based detection over the fresh signals — deterministic opportunities
  // alongside the advisor's AI-interpreted ones, under the same evidence,
  // confidence, priority and duplicate rules. Best-effort as well.
  await runDetection(companyId, { context }).catch((err) =>
    logger.warn('advisor: rule-based detection failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  // AI-assisted detection for what the rules cannot judge (content gaps,
  // competitive gaps, audience segments): validated against the snapshot and
  // the signals it cites before anything is stored. Best-effort as well.
  await runAiDetection(companyId, { userId: userId ?? null }).catch((err) =>
    logger.warn('advisor: AI opportunity detection failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  for (const opp of payload.opportunities) {
    try {
      const { opportunity } = await recordOpportunity(
        companyId,
        advisorToOpportunityInput(opp, payload.model),
        { context },
      );
      opp.opportunityId = opportunity.id;
    } catch (err) {
      logger.warn('advisor: could not store opportunity', {
        companyId,
        title: opp.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const date = startOfUtcDay();
  await db.advisorReport.upsert({
    where: { companyId_date: { companyId, date } },
    create: {
      companyId,
      date,
      payload: payload as unknown as object,
      model: payload.model,
    },
    update: {
      payload: payload as unknown as object,
      model: payload.model,
      generatedAt: new Date(),
    },
  });

  await recordAudit({
    action: 'ADVISOR_REPORT_GENERATED',
    userId: userId ?? null,
    companyId,
    metadata: {
      opportunities: payload.opportunities.length,
      model: payload.model,
      competitorSignals: payload.coverage.competitorSignals,
    },
  });

  return payload;
}

/** The most recent advisor report, or null. */
export async function getLatestAdvisorReport(
  companyId: string,
): Promise<AdvisorPayload | null> {
  const row = await db.advisorReport.findFirst({
    where: { companyId },
    orderBy: { date: 'desc' },
  });
  return row ? (row.payload as unknown as AdvisorPayload) : null;
}
