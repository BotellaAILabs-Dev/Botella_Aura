import { db } from '@/lib/db';
import {
  validateRecommendation,
  type QualityInput,
  type QualityReport,
} from '@/lib/recommendation-quality';
import { getBusinessContext } from '@/server/business-context/business-context.service';

/**
 * Recommendation quality checks (lib/recommendation-quality.ts), loaded for a
 * list of recommendations at once — their evidence (with each signal's source,
 * reliability and expiry), their opportunity, and the business profile —
 * scoped to the workspace.
 */

async function businessFor(
  companyId: string,
): Promise<QualityInput['business']> {
  const ctx = await getBusinessContext(companyId, { sections: ['market'] });
  return {
    name: ctx?.identity.name ?? '',
    description: ctx?.identity.description ?? null,
    offerings: ctx?.identity.offerings ?? null,
    goals: ctx?.objectives.goals ?? null,
    audience: ctx?.audience.stated ?? null,
    channels: ctx?.channels.preferred ?? [],
    avoid: ctx?.voice.profile?.topicsToAvoid ?? [],
    competitors: (ctx?.market.competitors ?? []).map((c) => c.name),
  };
}

export async function qualityFor(
  companyId: string,
  recommendationIds: string[],
  now: Date = new Date(),
): Promise<Map<string, QualityReport>> {
  if (!recommendationIds.length) return new Map();
  const [rows, business] = await Promise.all([
    db.recommendation.findMany({
      where: { companyId, id: { in: recommendationIds } },
      include: {
        evidence: {
          include: {
            signal: {
              select: { source: true, reliability: true, expiresAt: true },
            },
          },
        },
        opportunity: {
          select: {
            id: true,
            companyId: true,
            status: true,
            title: true,
            summary: true,
            rationale: true,
            signals: { select: { id: true, signalId: true } },
          },
        },
      },
    }),
    businessFor(companyId),
  ]);
  const out = new Map<string, QualityReport>();
  for (const r of rows) {
    const o = r.opportunity.companyId === companyId ? r.opportunity : null;
    out.set(
      r.id,
      validateRecommendation({
        rec: r,
        evidence: r.evidence.map((e) => ({
          label: e.label,
          detail: e.detail,
          url: e.url,
          refId: e.refId,
          signalId: e.signalId,
          opportunitySignalId: e.opportunitySignalId,
          source: e.signal?.source ?? null,
          reliability: e.reliability ?? e.signal?.reliability ?? null,
          // Current while its signal is; copies with no signal link count as
          // current, as everywhere else.
          current:
            !e.signalId ||
            Boolean(
              e.signal &&
              (e.signal.expiresAt === null || e.signal.expiresAt > now),
            ),
        })),
        opportunity: o
          ? {
              id: o.id,
              status: o.status,
              title: o.title,
              summary: o.summary,
              rationale: o.rationale,
              signalIds: o.signals
                .map((s) => s.signalId)
                .filter((x): x is string => !!x),
              evidenceIds: o.signals.map((s) => s.id),
            }
          : null,
        business,
        now,
      }),
    );
  }
  return out;
}

export async function getRecommendationQuality(
  companyId: string,
  recommendationId: string,
  now: Date = new Date(),
): Promise<QualityReport | null> {
  return (
    (await qualityFor(companyId, [recommendationId], now)).get(
      recommendationId,
    ) ?? null
  );
}
