/**
 * Proves the recommendation generation engine against a real database.
 *
 * Seeds a business with channels, an audience, a goal, trend stories, a
 * competitor move, a drop in results and a learned format; detects its
 * opportunities with the real rules; then generates recommendations and
 * checks every acceptance criterion: a structured recommendation from a valid
 * opportunity, built on the CURRENT business context, with a clear action,
 * an explanation, evidence, priority, confidence and expected outcome — and
 * that unsupported recommendations are rejected or flagged. The model is a
 * scripted stand-in.
 *
 * Run: pnpm verify:engine
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { recordOpportunity } from '@/server/opportunities/opportunity.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import { getRecommendation } from '@/server/recommendations/recommendation.service';
import { collectSignals } from '@/server/signals/signal.service';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
async function expectError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

async function main() {
  const company = await db.company.create({
    data: {
      name: 'zzverify engine',
      slug: `zzverify-engine-${Date.now()}`,
      industry: 'Coffee',
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers who buy beans online',
          channels: ['LinkedIn', 'Instagram'],
          goals: 'Grow coffee subscriptions',
        },
      },
    },
  });
  const companyId = company.id;

  try {
    const item = (id: string, title: string, url: string) => ({
      id,
      title,
      url,
      source: 'news',
      sourceLabel: 'News',
      score: 10,
      publishedAt: ago(2).toISOString(),
      aiSummary: title,
      suggestedAngle: '',
    });
    await db.companyTrendConfig.create({
      data: { companyId, keywords: ['specialty coffee'] },
    });
    await db.trendDigest.create({
      data: {
        companyId,
        date: ago(1),
        payload: {
          items: [
            item(
              'n1',
              'Specialty coffee prices climb as harvests shrink',
              'https://a.example/1',
            ),
            item(
              'n2',
              'Why specialty coffee shops win on transparency',
              'https://a.example/2',
            ),
          ],
          summary: '',
          recommendations: [],
          hashtags: [],
          seasonal: [],
          competitorMentions: [],
        } as Prisma.InputJsonObject,
      },
    });
    const acme = await db.competitorProfile.create({
      data: { companyId, name: 'Acme Coffee' },
    });
    await db.competitorSnapshot.create({
      data: {
        competitorId: acme.id,
        capturedAt: ago(3),
        changesSummary: {
          hasChanges: true,
          pricing: 'Cut subscriptions by 20%',
          news: [],
          skipped: [],
          model: 'x',
          capturedAt: ago(3).toISOString(),
        } as Prisma.InputJsonObject,
      },
    });
    for (const [s, e, v] of [
      [14, 7, 500],
      [7, 0, 300],
    ] as const) {
      await db.analyticsReport.create({
        data: {
          companyId,
          periodStart: ago(s),
          periodEnd: ago(e),
          summary: 'p',
          metrics: { totalEngagement: v },
        },
      });
    }
    await db.marketingMemory.create({
      data: {
        companyId,
        insightType: 'CONTENT_FORMAT',
        insight: 'Carousels beat text posts',
        confidence: 'MEDIUM',
        sampleSize: 24,
      },
    });
    await collectSignals(companyId);
    await runDetection(companyId);
    const opps = await db.opportunity.findMany({ where: { companyId } });
    const byRule = (rule: string) =>
      opps.find((o) => o.detectedBy === `rule:${rule}`)!;

    console.log('\nA valid opportunity produces a structured recommendation');
    const trend = byRule('trending-topic');
    const g1 = await generateRecommendation({
      companyId,
      opportunityId: trend.id,
      actorId: null,
      templatesOnly: true,
    });
    const r1 = g1.recommendationId
      ? await getRecommendation(companyId, g1.recommendationId)
      : null;
    check(
      'created',
      g1.status === 'created' && Boolean(r1),
      JSON.stringify(g1.reasons.concat(g1.flags)),
    );
    check(
      'structured: type, what, action, why, expected outcome, channel, audience',
      Boolean(
        r1 &&
        r1.type &&
        r1.title &&
        r1.action &&
        r1.rationale &&
        r1.expectedOutcome &&
        r1.channel &&
        r1.audience,
      ),
    );
    check(
      'contains a clear action on a channel the business uses, in a format it learned works',
      Boolean(
        r1?.action.startsWith('Publish') &&
        ['LinkedIn', 'Instagram'].includes(r1.channel!) &&
        r1.contentType === 'CAROUSEL',
      ),
      `${r1?.action} [${r1?.contentType}]`,
    );
    check(
      'explains why the action is relevant',
      Boolean(
        r1?.rationale.includes('Based on') &&
        r1.rationale.includes('fits because'),
      ),
      r1?.rationale,
    );
    check(
      'includes supporting evidence, linked to signals',
      Boolean(
        r1 && r1.evidence.length >= 2 && r1.evidence.every((e) => e.signalId),
      ),
    );
    check(
      'priority and confidence assigned, with reasons',
      Boolean(
        r1?.priority &&
        r1.confidence &&
        r1.confidenceReason &&
        (r1.details as { engine?: { priorityReason?: string } }).engine
          ?.priorityReason,
      ),
    );
    check(
      'records the chosen action and the alternatives it weighed',
      g1.selected !== null &&
        (g1.alternatives.length > 0 || g1.unsupported.length > 0),
    );
    check(
      'the run is in the audit log',
      (await db.auditLog.count({
        where: { companyId, action: 'RECOMMENDATION_GENERATED' },
      })) === 1,
    );

    console.log('\nUses relevant signals');
    const shift = byRule('results-shift');
    const g2 = await generateRecommendation({
      companyId,
      opportunityId: shift.id,
      actorId: null,
      templatesOnly: true,
    });
    const r2 = g2.recommendationId
      ? await getRecommendation(companyId, g2.recommendationId)
      : null;
    check(
      'a drop in results → a recovery post, with an outcome from the evidence',
      g2.selected?.id === 'recovery-post' &&
        Boolean(
          r2?.expectedOutcome.endsWith(
            'recovers toward 500 (it went from 500 to 300).',
          ),
        ),
      r2?.expectedOutcome,
    );

    console.log('\nUses the current Business Context');
    await updateBusinessContext({
      companyId,
      userId: null,
      patch: { channels: { preferred: ['Instagram'] } },
      origin: 'settings',
    });
    const current = await getContextSnapshot(companyId, {
      view: 'recommendation',
    });
    const move = byRule('competitor-move');
    const g3 = await generateRecommendation({
      companyId,
      opportunityId: move.id,
      actorId: null,
      templatesOnly: true,
    });
    const r3 = g3.recommendationId
      ? await getRecommendation(companyId, g3.recommendationId)
      : null;
    check(
      'built on the snapshot as it is now',
      g3.snapshotFingerprint === current?.snapshot.fingerprint,
    );
    check(
      'follows a channel change made after detection',
      r3?.channel === 'Instagram',
      r3?.channel ?? g3.reasons.join('; '),
    );
    check(
      '…and flags that the context changed since the opportunity was found',
      g3.status === 'flagged' && g3.flags.some((f) => /changed since/.test(f)),
      g3.flags.join('; '),
    );

    console.log('\nModel-written, validated');
    const extra = (title: string) =>
      recordOpportunity(companyId, {
        type: 'TRENDING_TOPIC',
        title,
        summary: 'Cold brew searches rise as the weather warms.',
        rationale: 'Two stories on a topic you follow.',
        source: 'TRENDS',
        detectedBy: 'rule:trending-topic',
        impact: 'medium',
        effort: 'low',
        signals: [
          {
            kind: 'EXTERNAL',
            label: 'News',
            detail: 'Cold brew searches rise as the weather warms',
            url: 'https://a.example/3',
          },
        ],
      });
    const { opportunity: o4 } = await extra('Cold brew season starts');
    const g4 = await generateRecommendation({
      companyId,
      opportunityId: o4.id,
      actorId: null,
      model: 'scripted',
      write: async () => ({
        title: 'Share your cold brew method',
        summary: 'Cold brew interest is rising with the weather.',
        action:
          'Publish an Instagram carousel showing your cold brew method this week.',
        steps: ['Show the grind', 'Show the steep', 'Show the result'],
        rationale:
          'Cold brew searches rise as the weather warms, and your buyers brew at home.',
        expectedOutcome: 'Home brewers save and share the method.',
        outcomeMetric: 'saves',
        evidence: ['E1'],
        businessFacts: ['identity.description'],
        assumptions: [],
      }),
    });
    const r4 = g4.recommendationId
      ? await getRecommendation(companyId, g4.recommendationId)
      : null;
    check(
      'supported model output is used, the engine’s channel kept',
      g4.writtenBy === 'ai:scripted' &&
        r4?.title === 'Share your cold brew method' &&
        r4.channel === 'Instagram',
      `${g4.writtenBy} ${g4.aiRejected?.join('; ') ?? ''}`,
    );
    const { opportunity: o5 } = await extra('Iced coffee gifting');
    const g5 = await generateRecommendation({
      companyId,
      opportunityId: o5.id,
      actorId: null,
      model: 'scripted',
      write: async () => ({
        title: 'Iced coffee gift boxes',
        summary: 'Sell gift boxes.',
        action: 'Launch an iced coffee gift box this week.',
        steps: [],
        rationale: 'Gift boxes grew 45% last year for roasters like you.',
        expectedOutcome: 'Sales up 30%.',
        outcomeMetric: 'sales',
        evidence: ['E1'],
        businessFacts: ['products.giftBoxes'],
        assumptions: ['They sell gift boxes'],
      }),
    });
    check(
      'unsupported model output is rejected; the template is used and the run flagged',
      g5.writtenBy === 'template' &&
        g5.status === 'flagged' &&
        (g5.aiRejected ?? []).some((r) => /45%|30%/.test(r)) &&
        (g5.aiRejected ?? []).some((r) => /products\.giftBoxes/.test(r)),
      (g5.aiRejected ?? []).join(' | '),
    );

    console.log('\nUnsupported recommendations are rejected or flagged');
    const { opportunity: o6 } = await extra('Decaf demand grows');
    const g6 = await generateRecommendation({
      companyId,
      opportunityId: o6.id,
      actorId: null,
      templatesOnly: true,
      overrides: { channel: 'YouTube' },
    });
    check(
      'a person’s edit to a channel the business does not use is flagged',
      g6.status === 'flagged' &&
        g6.flags.some((f) => /YouTube is not a channel/.test(f)),
      g6.flags.join('; '),
    );
    await updateBusinessContext({
      companyId,
      userId: null,
      patch: { channels: { preferred: [] } },
      origin: 'settings',
    });
    const { opportunity: o7 } = await extra('Single-origin storytelling');
    const before = await db.recommendation.count({ where: { companyId } });
    const g7 = await generateRecommendation({
      companyId,
      opportunityId: o7.id,
      actorId: null,
      templatesOnly: true,
    });
    check(
      'nowhere to publish → rejected with the reason, nothing stored',
      g7.status === 'rejected' &&
        g7.recommendationId === null &&
        g7.reasons.some((r) => /where it publishes/.test(r)) &&
        (await db.recommendation.count({ where: { companyId } })) === before,
      g7.reasons.join('; '),
    );
    const audit = await db.auditLog.findFirst({
      where: { companyId, action: 'RECOMMENDATION_GENERATED' },
      orderBy: { createdAt: 'desc' },
    });
    check(
      'the rejection is in the audit log',
      (audit?.metadata as { status?: string } | null)?.status === 'rejected',
    );
    const twice = await expectError(() =>
      generateRecommendation({
        companyId,
        opportunityId: trend.id,
        actorId: null,
        templatesOnly: true,
      }),
    );
    check(
      'an opportunity with a recommendation in play is not recommended twice',
      /already has a recommendation/.test(twice),
      twice,
    );
  } finally {
    await db.company.delete({ where: { id: companyId } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.company.count({ where: { id: companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll engine checks passed.'
      : `\n${failures} check(s) BROKEN.`,
  );
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
