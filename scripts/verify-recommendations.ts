/**
 * Proves the Recommendation data model against a real database.
 *
 * Checks the acceptance criteria directly: a recommendation is stored on its
 * own with every part (what, why, action, expected outcome, evidence,
 * confidence, priority, channel, audience, status, relevance); it always has
 * an originating opportunity (the database refuses one without); its evidence
 * is retained even as the opportunity changes; its status is tracked with
 * history and kept in step with the opportunity; and it can be handed to an
 * execution workflow.
 *
 * Run: pnpm verify:recommendations
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  recordOpportunity,
  transitionOpportunity,
} from '@/server/opportunities/opportunity.service';
import {
  createRecommendationFromOpportunity,
  expireRecommendations,
  getRecommendation,
  listRecommendations,
  transitionRecommendation,
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
      name: 'zzverify recommendations',
      slug: `zzverify-recs-${Date.now()}`,
      industry: 'Coffee',
      preferences: {
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers who buy beans online',
          channels: ['Instagram'],
        },
      },
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
    const evidenceOf = (list: typeof signals) =>
      list.map((s) => ({
        kind: s.kind,
        refId: s.refId,
        label: s.title,
        detail: s.summary,
        signalId: s.id,
      }));
    const record = (key: string, extra: object = {}) =>
      recordOpportunity(company.id, {
        type: 'COMPETITOR_MOVE',
        title: `Answer Acme’s discount (${key})`,
        summary: 'Acme cut its subscription price.',
        rationale: 'A pricing change buyers comparing options will notice.',
        angle: 'Lead with freshness, not price.',
        source: 'COMPETITORS',
        detectedBy: 'rule:competitor-move',
        signals: evidenceOf(signals.slice(0, 1)),
        impact: 'high',
        effort: 'low',
        dedupeKey: `zz:${key}`,
        contextFields: ['audience.stated'],
        ...extra,
      });

    console.log('\nStored independently, with every part');
    const { opportunity: a } = await record('a');
    const rec = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: a.id,
      createdBy: 'verify',
      actorId: null,
    });
    check(
      'what, why, action and expected outcome are filled',
      Boolean(
        rec.title &&
        rec.summary &&
        rec.rationale &&
        rec.action &&
        rec.expectedOutcome,
      ),
    );
    check(
      'type, channel and audience come from the opportunity and the business',
      rec.type === 'COMPETITIVE_RESPONSE' &&
        rec.channel === 'Instagram' &&
        rec.contentType === 'IMAGE_POST' &&
        Boolean(rec.audience?.includes('Home brewers')),
      JSON.stringify({ t: rec.type, c: rec.channel, a: rec.audience }),
    );
    check(
      'confidence, priority and relevance are carried over',
      rec.confidence === a.confidence &&
        rec.priority === a.priority &&
        rec.relevantUntil?.getTime() === a.relevantUntil?.getTime(),
    );
    check(
      'linked to the Business Context it was built against',
      rec.contextRevision === a.contextRevision &&
        rec.contextFields.includes('audience.stated'),
    );
    const alone = await db.recommendation.findUnique({ where: { id: rec.id } });
    check(
      'readable on its own, without the opportunity',
      Boolean(alone?.action),
    );

    console.log('\nEvery recommendation has an originating opportunity');
    check(
      'references it',
      rec.opportunityId === a.id && rec.opportunity.id === a.id,
    );
    const noOrigin = await expectError(() =>
      db.$executeRawUnsafe(
        `INSERT INTO "Recommendation" ("id","companyId","opportunityId","type","title","summary","action","rationale","expectedOutcome","confidence","priority","priorityScore","handoff","handoffVersion","createdBy","updatedAt")
         VALUES ('zz-orphan',$1,NULL,'OTHER','t','s','a','r','e','LOW','LOW',0,'{}',1,'x',now())`,
        company.id,
      ),
    );
    check(
      'the database refuses one without',
      noOrigin !== '',
      noOrigin.slice(0, 60),
    );
    const delOpp = await expectError(() =>
      db.opportunity.delete({ where: { id: a.id } }),
    );
    check('its opportunity cannot be deleted from under it', delOpp !== '');

    console.log('\nSupporting evidence is retained');
    check(
      'evidence copied, linked to the signal',
      rec.evidence.length === 1 && rec.evidence[0]!.signalId === signals[0]!.id,
    );
    await record('a', { signals: evidenceOf(signals) });
    const after = await getRecommendation(company.id, rec.id);
    check(
      'unchanged when the opportunity later gains evidence',
      after?.evidence.length === 1 &&
        (await db.opportunitySignal.count({
          where: { opportunityId: a.id },
        })) === 2,
    );

    console.log('\nStatus is tracked');
    await transitionRecommendation({
      companyId: company.id,
      recommendationId: rec.id,
      to: 'ACCEPTED',
      actorId: null,
      note: 'Doing it.',
    });
    check(
      'accepting it accepts the opportunity',
      (await db.opportunity.findUnique({ where: { id: a.id } }))?.status ===
        'ACCEPTED',
    );
    await transitionRecommendation({
      companyId: company.id,
      recommendationId: rec.id,
      to: 'IN_PROGRESS',
      actorId: null,
    });
    const done = await transitionRecommendation({
      companyId: company.id,
      recommendationId: rec.id,
      to: 'COMPLETED',
      actorId: null,
    });
    check(
      'generated → accepted → in progress → completed, with timestamps',
      done.status === 'COMPLETED' &&
        Boolean(done.decidedAt && done.startedAt && done.completedAt),
    );
    check(
      'every change is in its history',
      done.events.map((e) => e.toStatus).join(',') ===
        'GENERATED,ACCEPTED,IN_PROGRESS,COMPLETED',
      done.events.map((e) => e.toStatus).join(','),
    );
    const illegal = await expectError(() =>
      transitionRecommendation({
        companyId: company.id,
        recommendationId: rec.id,
        to: 'REJECTED',
        actorId: null,
      }),
    );
    check(
      'a completed one cannot be reopened or rejected',
      /cannot be marked/.test(illegal),
      illegal,
    );

    const { opportunity: b } = await record('b');
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
      note: 'Not our fight.',
    });
    const recBAfter = await getRecommendation(company.id, recB.id);
    check(
      'rejecting the opportunity rejects its recommendation, with history',
      recBAfter?.status === 'REJECTED' &&
        recBAfter.events.at(-1)?.toStatus === 'REJECTED',
    );

    const { opportunity: c } = await record('c');
    const createdAt = ago(5);
    const recC = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: c.id,
      createdBy: 'verify',
      actorId: null,
      content: { relevantUntil: ago(1) },
      now: createdAt,
    });
    check(
      'relevance can be shorter than the opportunity’s',
      recC.relevantUntil! < c.relevantUntil!,
    );
    const expired = await expireRecommendations(company.id);
    const recCAfter = await getRecommendation(company.id, recC.id);
    check(
      'undecided past its relevance → expired, opportunity left open',
      expired === 1 &&
        recCAfter?.status === 'EXPIRED' &&
        Boolean(recCAfter.expiredAt) &&
        (await db.opportunity.findUnique({ where: { id: c.id } }))?.status ===
          'RECOMMENDED',
    );

    console.log('\nWritten by a person or the engine');
    const { opportunity: d } = await record('d');
    const custom = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: d.id,
      createdBy: 'engine-test',
      actorId: null,
      content: {
        type: 'CAMPAIGN',
        title: 'A three-post freshness series',
        action: 'Run three posts over two weeks on why fresh roasting matters.',
        expectedOutcome: 'Subscription sign-ups from comparison shoppers.',
        outcomeMetric: 'subscriptions',
        channel: 'LinkedIn',
        confidence: 'HIGH',
      },
    });
    check(
      'its own content is stored',
      custom.type === 'CAMPAIGN' &&
        custom.title === 'A three-post freshness series' &&
        custom.channel === 'LinkedIn' &&
        custom.outcomeMetric === 'subscriptions',
    );
    check(
      'it cannot claim more confidence than its opportunity',
      custom.confidence === d.confidence,
    );
    const { opportunity: e } = await record('e');
    const invalid = await expectError(() =>
      createRecommendationFromOpportunity({
        companyId: company.id,
        opportunityId: e.id,
        createdBy: 'engine-test',
        actorId: null,
        content: { channel: 'MySpace' as never },
      }),
    );
    check('invalid content is refused', invalid !== '');

    console.log('\nReady for Content / Execution workflows');
    const full = await getRecommendation(company.id, custom.id);
    check(
      'carries an execution brief for its workflow',
      full?.execution.workflow === 'PLANNER' &&
        full.execution.recommendationId === custom.id &&
        full.execution.opportunityId === d.id &&
        full.execution.brief.includes('Run three posts') &&
        full.execution.evidence.length === 1,
    );
    const content = await getRecommendation(company.id, recB.id);
    check(
      'a content recommendation opens Content Studio pre-filled',
      Boolean(
        content?.execution.href.startsWith('/dashboard/content/new?brief='),
      ),
    );
    const listed = await listRecommendations(company.id, {
      status: ['GENERATED'],
    });
    check(
      'listed by status',
      listed.length === 1 && listed[0]!.id === custom.id,
      listed.map((r) => r.status).join(','),
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
      ? '\nAll recommendation checks passed.'
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
