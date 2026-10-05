/**
 * Proves the Opportunity → Recommendation foundation against a real database.
 *
 * Seeds a throwaway workspace with an opportunity backed by normalised
 * signals, then checks: the hand-off and its eligibility, that a
 * recommendation references its opportunity and carries its evidence forward,
 * that the opportunity moves to RECOMMENDED in the same transaction, that
 * decisions stay in step in both directions, and that an opportunity with
 * recommendations cannot be deleted out from under them.
 *
 * Run: pnpm verify:recommendation-handoff
 *
 * The throwaway workspace is deleted at the end, including on failure.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { opportunityHandoffSchema } from '@/lib/recommendation-handoff';
import {
  recordOpportunity,
  transitionOpportunity,
} from '@/server/opportunities/opportunity.service';
import {
  createRecommendationFromOpportunity,
  decideRecommendation,
  getOpportunityHandoff,
} from '@/server/recommendations/recommendation.service';
import { collectSignals } from '@/server/signals/signal.service';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

async function expectError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function main() {
  const company = await db.company.create({
    data: {
      name: 'zzverify handoff',
      slug: `zzverify-handoff-${Date.now()}`,
      industry: 'Coffee',
    },
  });

  try {
    const competitor = await db.competitorProfile.create({
      data: { companyId: company.id, name: 'Acme Coffee' },
    });
    for (const [d, pricing] of [
      [3, 'Cut subscriptions by 20%'],
      [6, 'Bundled a free brewing guide'],
    ] as const) {
      await db.competitorSnapshot.create({
        data: {
          competitorId: competitor.id,
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
    await collectSignals(company.id);
    const signals = await db.signal.findMany({
      where: { companyId: company.id, source: 'COMPETITORS' },
    });
    const evidence = signals.map((s) => ({
      kind: s.kind,
      refId: s.refId,
      label: s.title,
      detail: s.summary,
      observedAt: s.observedAt,
      signalId: s.id,
    }));
    const record = (key: string, title: string) =>
      recordOpportunity(company.id, {
        type: 'COMPETITOR_MOVE',
        title,
        summary: 'Acme changed its subscription offer.',
        rationale: 'Two direct pricing observations.',
        source: 'COMPETITORS',
        detectedBy: 'rule:competitor-move',
        signals: evidence,
        impact: 'high',
        effort: 'low',
        dedupeKey: key,
        contextFields: ['identity.description'],
      });

    console.log('\nThe hand-off');
    const { opportunity } = await record('zz:a', 'Answer Acme’s discount');
    check(
      'impact and effort are stored on the opportunity',
      opportunity.impact === 'high' && opportunity.effort === 'low',
    );
    const found = await getOpportunityHandoff(company.id, opportunity.id);
    check('is returned, and eligible', Boolean(found?.eligibility.eligible));
    check(
      'matches the versioned schema',
      opportunityHandoffSchema.safeParse(
        JSON.parse(JSON.stringify(found?.handoff)),
      ).success,
    );
    check(
      'carries every piece of evidence with its signal',
      found?.handoff.evidence.length === signals.length &&
        found.handoff.evidence.every((e) => e.signalId && e.current),
    );
    check(
      'names the context it relies on',
      found?.handoff.context.snapshotView === 'recommendation' &&
        found.handoff.context.fields.includes('identity.description'),
    );

    console.log('\nCreating a recommendation');
    const rec = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: opportunity.id,
      createdBy: 'verify',
      actorId: null,
    });
    check(
      'references its originating opportunity',
      rec.opportunityId === opportunity.id,
    );
    check(
      'evidence flowed forward, linked to the opportunity’s evidence and the signal',
      rec.evidence.length === signals.length &&
        rec.evidence.every(
          (e) =>
            e.signalId && e.opportunitySignalId && e.reliability === 'HIGH',
        ),
    );
    check(
      'confidence and priority handed over',
      rec.confidence === opportunity.confidence &&
        rec.priority === opportunity.priority,
    );
    const afterCreate = await db.opportunity.findUnique({
      where: { id: opportunity.id },
    });
    check(
      'the opportunity moved to RECOMMENDED',
      afterCreate?.status === 'RECOMMENDED' &&
        Boolean(afterCreate.recommendedAt),
    );
    const dup = await expectError(() =>
      createRecommendationFromOpportunity({
        companyId: company.id,
        opportunityId: opportunity.id,
        createdBy: 'verify',
        actorId: null,
      }),
    );
    check(
      'a second open recommendation is refused',
      /already has a recommendation/.test(dup),
      dup,
    );

    console.log('\nDecisions stay in step');
    await decideRecommendation({
      companyId: company.id,
      recommendationId: rec.id,
      decision: 'ACCEPTED',
      actorId: null,
      note: 'Running it.',
    });
    check(
      'accepting the recommendation accepts the opportunity',
      (await db.opportunity.findUnique({ where: { id: opportunity.id } }))
        ?.status === 'ACCEPTED',
    );
    const again = await expectError(() =>
      decideRecommendation({
        companyId: company.id,
        recommendationId: rec.id,
        decision: 'REJECTED',
        actorId: null,
      }),
    );
    check(
      'a recommendation is decided only once',
      /cannot be marked rejected/.test(again),
      again,
    );
    const closed = await expectError(() =>
      createRecommendationFromOpportunity({
        companyId: company.id,
        opportunityId: opportunity.id,
        createdBy: 'verify',
        actorId: null,
      }),
    );
    check(
      'a decided opportunity cannot be recommended',
      /cannot be recommended/.test(closed),
      closed,
    );

    const { opportunity: b } = await record('zz:b', 'Second opening');
    const recB = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: b.id,
      createdBy: 'verify',
      actorId: null,
    });
    await transitionOpportunity({
      companyId: company.id,
      opportunityId: b.id,
      to: 'REJECTED',
      actorId: null,
      note: 'Not for us.',
    });
    check(
      'rejecting the opportunity directly rejects its open recommendation',
      (await db.recommendation.findUnique({ where: { id: recB.id } }))
        ?.status === 'REJECTED',
    );

    const { opportunity: c } = await record('zz:c', 'Third opening');
    const recC = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: c.id,
      createdBy: 'verify',
      actorId: null,
      content: { title: 'Launch a guide series' },
    });
    check(
      'a recommendation can have its own title',
      recC.title === 'Launch a guide series',
    );
    await decideRecommendation({
      companyId: company.id,
      recommendationId: recC.id,
      decision: 'WITHDRAWN',
      actorId: null,
    });
    const cAfter = await db.opportunity.findUnique({ where: { id: c.id } });
    check(
      'withdrawing leaves the opportunity open',
      cAfter?.status === 'RECOMMENDED',
    );
    const recC2 = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: c.id,
      createdBy: 'verify',
      actorId: null,
    }).catch(() => null);
    check('…and it can be recommended again', Boolean(recC2));

    console.log('\nEvery recommendation keeps its opportunity');
    const blocked = await expectError(() =>
      db.opportunity.delete({ where: { id: c.id } }),
    );
    const kept = await db.recommendation.findUnique({
      where: { id: recC.id },
      include: { evidence: true },
    });
    check(
      'an opportunity with recommendations cannot be deleted on its own',
      blocked !== '' &&
        kept?.opportunityId === c.id &&
        kept.evidence.length === signals.length,
      blocked.slice(0, 80),
    );
  } finally {
    await db.company.delete({ where: { id: company.id } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.recommendation.count({ where: { companyId: company.id } })) ===
        0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll hand-off checks passed.'
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
