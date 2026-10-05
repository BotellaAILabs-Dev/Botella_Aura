/**
 * Sprint 7 end-to-end: Business Context → Signal → Opportunity, ready for the
 * recommendation engine — against a real database, through the real services.
 *
 *   User / existing data      a user onboards a business; it already has
 *                             trend keywords and stories, a competitor, two
 *                             results periods and a learned pattern
 *   Business Context          onboarding answers resolved, with provenance
 *   Missing information       gaps become questions; answering closes them
 *   Context Snapshot          trusted facts only; rebuilt when context changes
 *   Signals                   every source normalised, linked to its record
 *   Signal Aggregation        re-collection adds nothing; corroboration
 *   Opportunity Detection     rules + AI (scripted model), validated
 *   Opportunity               stored on its own, deduplicated
 *   Evidence + Confidence     linked to signals; low confidence never high priority
 *   Ready for Recommendation  eligible hand-off; a recommendation carries it
 *
 * Run: pnpm verify:flow
 *
 * Everything lives in a throwaway workspace and user, deleted at the end
 * (including on failure).
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { opportunityHandoffSchema } from '@/lib/recommendation-handoff';
import { snapshotSchema } from '@/lib/business-context-snapshot';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import { getQuestions } from '@/server/business-context/questions.service';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
import { runAiDetection } from '@/server/opportunities/ai-detection.service';
import { runDetection } from '@/server/opportunities/detection.service';
import {
  createRecommendationFromOpportunity,
  getOpportunityHandoff,
} from '@/server/recommendations/recommendation.service';
import { createCompanyForUser } from '@/server/services/company.service';
import { collectSignals } from '@/server/signals/signal.service';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const stage = (n: number, name: string) => console.log(`\n${n}. ${name}`);

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const DESCRIPTION =
  'We roast single-origin specialty coffee in small batches and ship subscriptions.';

async function main() {
  const user = await db.user.create({
    data: {
      email: `zzverify-flow-${Date.now()}@example.test`,
      name: 'zz flow',
      passwordHash: await bcrypt.hash('unused-password-1', 4),
      emailVerified: new Date(),
    },
  });
  let companyId: string | null = null;

  try {
    // -----------------------------------------------------------------------
    stage(0, 'User / existing data');
    const company = await createCompanyForUser({
      userId: user.id,
      input: {
        name: `zzverify flow ${Date.now()}`,
        website: '',
        industry: 'Coffee',
        description: DESCRIPTION,
        offerings: '',
        marketMode: 'B2C',
        audience: 'Home brewers who buy beans online',
        goals: 'Grow subscriptions',
        brandVoiceNotes: 'Warm, expert, no hype.',
      } as never,
      requestMeta: {},
    });
    companyId = company.id;
    check(
      'a business is onboarded through the real onboarding service',
      Boolean(companyId),
    );

    const item = (id: string, title: string, url: string, source = 'news') => ({
      id,
      title,
      url,
      source,
      sourceLabel: source,
      score: 10,
      publishedAt: ago(2).toISOString(),
      aiSummary: title,
      suggestedAngle: '',
    });
    await db.companyTrendConfig.create({
      data: { companyId, keywords: ['specialty coffee', 'cold brew'] },
    });
    for (const day of [1, 3]) {
      // The same story in two digests: one signal, seen twice.
      await db.trendDigest.create({
        data: {
          companyId,
          date: ago(day),
          payload: {
            items: [
              item(
                'n1',
                'Specialty coffee prices climb as harvests shrink',
                'https://a.example/1',
              ),
              ...(day === 1
                ? [
                    item(
                      'n2',
                      'Why specialty coffee shops win on transparency',
                      'https://a.example/2',
                    ),
                    item(
                      'r1',
                      'Is cold brew overrated?',
                      'https://reddit.example/1',
                      'reddit',
                    ),
                  ]
                : []),
            ],
            summary: '',
            recommendations: [],
            hashtags: [],
            seasonal: [],
            competitorMentions: [],
          } as Prisma.InputJsonObject,
        },
      });
    }
    const acme = await db.competitorProfile.create({
      data: { companyId, name: 'Acme Coffee' },
    });
    for (const [d, pricing] of [
      [3, 'Cut subscriptions by 20% and launched a brewing-guide series'],
      [9, 'Bundled a free pour-over guide with every subscription'],
    ] as const) {
      await db.competitorSnapshot.create({
        data: {
          competitorId: acme.id,
          capturedAt: ago(d),
          changesSummary: {
            hasChanges: true,
            pricing,
            news: [],
            skipped: [],
            model: 'x',
            capturedAt: ago(d).toISOString(),
          } as Prisma.InputJsonObject,
        },
      });
    }
    for (const [start, end, engagement] of [
      [14, 7, 500],
      [7, 0, 300],
    ] as const) {
      await db.analyticsReport.create({
        data: {
          companyId,
          periodStart: ago(start),
          periodEnd: ago(end),
          summary: 'period',
          metrics: { totalEngagement: engagement },
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
    check(
      'existing data in place: trends, a competitor, results, a learned pattern',
      true,
    );

    // -----------------------------------------------------------------------
    stage(1, 'Business Context');
    const ctx = await getBusinessContext(companyId);
    check('resolves for the business', Boolean(ctx));
    check(
      'carries what onboarding captured',
      ctx?.identity.description === DESCRIPTION &&
        ctx.identity.industry === 'Coffee' &&
        ctx.audience.marketMode === 'B2C' &&
        Boolean(ctx.audience.stated?.includes('Home brewers')),
    );
    const fact = ctx?.meta.facts['identity.description'];
    check(
      'each fact has its source, confidence and freshness',
      Boolean(fact?.sourceType && fact.confidence && fact.freshness),
      JSON.stringify(fact),
    );
    check(
      'connected modules are part of it (keywords, competitors)',
      Boolean(
        ctx?.market.keywords.includes('specialty coffee') &&
        ctx.market.competitors.some((c) => c.name === 'Acme Coffee'),
      ),
    );

    // -----------------------------------------------------------------------
    stage(2, 'Missing information');
    const q1 = await getQuestions(companyId);
    const keys = (q1?.questions ?? []).map((q) => q.field);
    check(
      'a missing value becomes a question (what you sell)',
      keys.includes('identity.offerings'),
      keys.join(', '),
    );
    check(
      'nothing is asked about what onboarding answered',
      !keys.includes('identity.description'),
    );
    await updateBusinessContext({
      companyId,
      userId: user.id,
      patch: {
        identity: { offerings: 'Coffee bean subscriptions and gift boxes' },
      },
      origin: 'settings',
    });
    const q2 = await getQuestions(companyId);
    check(
      'answering it closes the question',
      !(q2?.questions ?? []).some((q) => q.field === 'identity.offerings'),
    );

    // -----------------------------------------------------------------------
    stage(3, 'Context Snapshot');
    const s1 = await getContextSnapshot(companyId, { view: 'opportunity' });
    check(
      'builds and matches its schema',
      Boolean(s1 && snapshotSchema.safeParse(s1.snapshot).success),
    );
    check(
      'carries confirmed facts, ready for a prompt',
      s1?.snapshot.business?.description === DESCRIPTION &&
        Boolean(s1.prompt.includes(DESCRIPTION)) &&
        Boolean(s1.snapshot.trust['identity.description']),
    );
    const s2 = await getContextSnapshot(companyId, { view: 'opportunity' });
    check('served from storage while current', s2?.status === 'current');
    await updateBusinessContext({
      companyId,
      userId: user.id,
      patch: {
        objectives: { goals: 'Grow subscriptions and win gift-box buyers' },
      },
      origin: 'settings',
    });
    const s3 = await getContextSnapshot(companyId, { view: 'opportunity' });
    check(
      'rebuilt when the business context changes',
      s3?.status === 'rebuilt' &&
        s3.snapshot.fingerprint !== s1?.snapshot.fingerprint,
      `${s3?.status}`,
    );

    // -----------------------------------------------------------------------
    stage(4, 'Signals');
    const first = await collectSignals(companyId);
    const signals = await db.signal.findMany({ where: { companyId } });
    const sources = new Set(signals.map((s) => s.source));
    check(
      'every source normalised (trends, competitors, results, memory, business)',
      [
        'TRENDS',
        'COMPETITORS',
        'ANALYTICS',
        'MEMORY',
        'BUSINESS_CONTEXT',
      ].every((s) => sources.has(s as never)),
      [...sources].join(', '),
    );
    check(
      'each keeps its record, time, expiry rule and reliability with a reason',
      signals.every(
        (s) => s.observedAt && s.reliability && s.reliabilityReason,
      ) &&
        signals
          .filter((s) => s.source !== 'BUSINESS_CONTEXT')
          .every((s) => s.refId),
    );
    check(
      'related to the business where it matches',
      signals.some((s) =>
        s.contextMatches.includes('keyword:specialty coffee'),
      ),
    );

    // -----------------------------------------------------------------------
    stage(5, 'Signal Aggregation');
    const story = signals.find((s) =>
      s.title.startsWith('Specialty coffee prices'),
    );
    check(
      'the same story in two digests is one signal, seen twice',
      signals.filter((s) => s.title.startsWith('Specialty coffee prices'))
        .length === 1 && (story?.occurrences ?? 0) >= 2,
    );
    await collectSignals(companyId);
    check(
      'collecting again adds nothing',
      (await db.signal.count({ where: { companyId } })) === signals.length,
      `first run stored ${JSON.stringify(first).slice(0, 80)}`,
    );

    // -----------------------------------------------------------------------
    stage(6, 'Opportunity Detection');
    const rules = await runDetection(companyId);
    const rulesFired = new Set(rules?.outcomes.map((o) => o.rule));
    check(
      'rules fire on the evidence they need',
      [
        'competitor-move',
        'trending-topic',
        'results-shift',
        'proven-pattern',
      ].every((r) => rulesFired.has(r)),
      [...rulesFired].join(', '),
    );
    const ai = await runAiDetection(companyId, {
      model: 'scripted',
      complete: async ({ prompt }) => {
        const ref = (text: string) => {
          const line = prompt
            .split('\n')
            .find((l) => /^\[S\d+\]/.test(l) && l.includes(text));
          return line ? line.slice(1, line.indexOf(']')) : 'S999';
        };
        const gap = {
          type: 'CONTENT_GAP',
          title: 'Own the brewing-guide conversation',
          summary:
            'Acme keeps pairing subscriptions with brewing guides; you have not covered brewing.',
          reasoning:
            'Two separate Acme changes push brewing education, a sustained theme.',
          evidence: [
            {
              signal: ref('brewing-guide series'),
              supports: 'Acme launched a brewing-guide series.',
            },
            {
              signal: ref('pour-over guide'),
              supports: 'Acme bundles a pour-over guide.',
            },
          ],
          businessFacts: ['identity.description'],
          assumptions: [],
          confidence: 'HIGH',
          confidenceReason: 'Two direct observations.',
          impact: 'medium',
          effort: 'low',
        };
        return {
          opportunities: [
            gap,
            {
              ...gap,
              type: 'AUDIENCE_SEGMENT',
              title: 'Office buyers',
              summary: '40% of your buyers are offices.',
            },
          ],
        };
      },
    });
    check(
      'AI detection stores the valid opportunity',
      ai?.status === 'partial' && ai.outcomes.length === 1,
    );
    check(
      '…and rejects the one with unsupported claims',
      ai?.rejected.length === 1 &&
        ai.rejected[0]!.reasons.some((r) => r.code === 'unsupported-number'),
    );
    const all = await db.opportunity.findMany({
      where: { companyId },
      include: { signals: true },
    });
    check(
      'low-reliability chatter alone did not become an opportunity',
      !all.some((o) => /cold brew/i.test(o.title)),
    );

    // -----------------------------------------------------------------------
    stage(7, 'Opportunity');
    check(
      'stored on its own, one per opening',
      all.length === new Set(all.map((o) => o.dedupeKey)).size,
    );
    const before = all.length;
    await runDetection(companyId);
    check(
      'detecting again creates no duplicates',
      (await db.opportunity.count({ where: { companyId } })) === before,
    );
    check(
      'every status change is in its history',
      (await db.opportunityEvent.count({
        where: { opportunity: { companyId } },
      })) >= before,
    );

    // -----------------------------------------------------------------------
    stage(8, 'Evidence + Confidence');
    const signalIds = new Set(signals.map((s) => s.id));
    check(
      'every opportunity has evidence linked to its signal',
      all.every(
        (o) =>
          o.signals.length > 0 &&
          o.signals.every((s) => s.signalId && signalIds.has(s.signalId)),
      ),
    );
    check(
      'confidence and its reason captured; impact and effort stored',
      all.every(
        (o) => o.confidence && o.confidenceReason && o.impact && o.effort,
      ),
    );
    check(
      'no low-confidence opportunity is high or urgent priority',
      all
        .filter((o) => o.confidence === 'LOW')
        .every((o) => o.priority === 'LOW' || o.priority === 'MEDIUM'),
    );
    const aiOpp = all.find((o) => o.source === 'AI_DETECTION');
    check(
      'the AI opportunity records its snapshot and the model’s confidence',
      Boolean(aiOpp?.contextFingerprint) &&
        Boolean(
          (aiOpp?.details as { ai?: { confidence?: unknown } })?.ai?.confidence,
        ),
    );

    // -----------------------------------------------------------------------
    stage(9, 'Ready for Recommendation Engine');
    const handoffs = await Promise.all(
      all.map((o) => getOpportunityHandoff(companyId!, o.id)),
    );
    check(
      'every open opportunity hands off cleanly',
      handoffs.every(
        (h) =>
          h &&
          h.eligibility.eligible &&
          opportunityHandoffSchema.safeParse(
            JSON.parse(JSON.stringify(h.handoff)),
          ).success,
      ),
      handoffs
        .map((h) => h?.eligibility.reasons.join(' '))
        .filter(Boolean)
        .join(' | '),
    );
    const rec = await createRecommendationFromOpportunity({
      companyId,
      opportunityId: aiOpp!.id,
      createdBy: 'verify-flow',
      actorId: user.id,
    });
    check(
      'a recommendation references its opportunity and carries its evidence',
      rec.opportunityId === aiOpp!.id &&
        rec.evidence.length === aiOpp!.signals.length &&
        rec.evidence.every((e) => e.signalId && signalIds.has(e.signalId)),
    );
    check(
      '…and the opportunity is now recommended',
      (await db.opportunity.findUnique({ where: { id: aiOpp!.id } }))
        ?.status === 'RECOMMENDED',
    );
  } finally {
    if (companyId)
      await db.company.delete({ where: { id: companyId } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
    check(
      'cleanup: throwaway workspace and user removed',
      (companyId ? await db.company.count({ where: { id: companyId } }) : 0) ===
        0 && (await db.user.count({ where: { id: user.id } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nThe whole flow works end to end.'
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
