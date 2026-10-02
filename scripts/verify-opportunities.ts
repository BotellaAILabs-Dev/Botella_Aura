/**
 * Proves the opportunity model against a real database.
 *
 * The unit tests cover the rules; this covers what they cannot reach — that an
 * opportunity is stored on its own with its evidence linked to real signal
 * records, that re-detection merges instead of duplicating, that a person's
 * decision is not overridden, that expiry and reopening work, that every
 * status change is in the history, and that two concurrent decisions cannot
 * both win.
 *
 * Run: pnpm verify:opportunities
 *
 * Everything it writes lives in a throwaway workspace that is deleted at the
 * end, including on failure.
 */
import { db } from '@/lib/db';
import {
  expireOpportunities,
  getOpportunity,
  opportunitiesForSignal,
  recordOpportunity,
  transitionOpportunity,
} from '@/server/opportunities/opportunity.service';
import type { OpportunityInput } from '@/lib/opportunities';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const DAY = 86_400_000;

async function main() {
  const company = await db.company.create({
    data: {
      name: 'zzverify opportunities',
      slug: `zzverify-opps-${Date.now()}`,
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People who already own a grinder.',
        },
      },
    },
  });
  const user = await db.user.findFirst({ select: { id: true } });

  try {
    // A real signal record for the evidence to point at.
    const competitor = await db.competitorProfile.create({
      data: { companyId: company.id, name: 'Acme Coffee' },
    });
    const snapshot = await db.competitorSnapshot.create({
      data: { competitorId: competitor.id, capturedAt: new Date() },
    });

    const input = (detail: string): OpportunityInput => ({
      type: 'COMPETITOR_MOVE',
      title: 'Answer Acme’s price cut',
      summary: 'Acme cut its prices; buyers are comparing.',
      source: 'ADVISOR',
      detectedBy: 'verify-script',
      impact: 'high',
      effort: 'low',
      contextFields: ['identity.description', 'audience.stated'],
      signals: [
        {
          kind: 'COMPETITOR_SNAPSHOT',
          refId: snapshot.id,
          label: 'Acme Coffee',
          detail,
        },
      ],
    });

    console.log('\nStored independently, with linked evidence');
    const first = await recordOpportunity(
      company.id,
      input('Pricing change: -20%'),
    );
    check(
      'created as its own row, status DETECTED',
      first.outcome === 'created' && first.opportunity.status === 'DETECTED',
    );
    check('carries its evidence', first.opportunity.signals.length === 1);
    check(
      'evidence links to the real signal record',
      first.opportunity.signals[0]?.kind === 'COMPETITOR_SNAPSHOT' &&
        first.opportunity.signals[0]?.refId === snapshot.id,
    );
    check(
      'linked to the Business Context revision',
      Boolean(first.opportunity.contextRevision),
    );
    check(
      'has a detected date and a relevance date',
      Boolean(first.opportunity.detectedAt && first.opportunity.relevantUntil),
    );
    const fromSignal = await opportunitiesForSignal(
      company.id,
      'COMPETITOR_SNAPSHOT',
      snapshot.id,
    );
    check(
      'found again from its underlying signal',
      fromSignal.some((o) => o.id === first.opportunity.id),
    );

    console.log('\nRe-detection merges instead of duplicating');
    const again = await recordOpportunity(
      company.id,
      input('Pricing change: -20%'),
    );
    const more = await recordOpportunity(
      company.id,
      input('Homepage now leads with "cheapest beans in town"'),
    );
    const count = await db.opportunity.count({
      where: { companyId: company.id },
    });
    check('still one opportunity', count === 1, `${count} rows`);
    check(
      'the same evidence is not stored twice',
      again.opportunity.signals.length === 1,
    );
    check(
      'new evidence is added',
      more.outcome === 'updated' && more.opportunity.signals.length === 2,
    );
    check(
      'confidence rises with more evidence (LOW → MEDIUM)',
      first.opportunity.confidence === 'LOW' &&
        more.opportunity.confidence === 'MEDIUM',
      `${first.opportunity.confidence} → ${more.opportunity.confidence}`,
    );

    console.log('\nLifecycle is tracked');
    const id = first.opportunity.id;
    await transitionOpportunity({
      companyId: company.id,
      opportunityId: id,
      to: 'REVIEWED',
      actorId: user?.id ?? null,
    });
    await transitionOpportunity({
      companyId: company.id,
      opportunityId: id,
      to: 'RECOMMENDED',
      actorId: user?.id ?? null,
    });
    await transitionOpportunity({
      companyId: company.id,
      opportunityId: id,
      to: 'REJECTED',
      actorId: user?.id ?? null,
      note: 'Not competing on price.',
    });
    let full = await getOpportunity(company.id, id);
    check(
      'every change is in the history',
      JSON.stringify(full?.events.map((e) => e.toStatus)) ===
        JSON.stringify(['DETECTED', 'REVIEWED', 'RECOMMENDED', 'REJECTED']),
      JSON.stringify(full?.events.map((e) => e.toStatus)),
    );
    check(
      'the decision and its reason are recorded',
      full?.decisionNote === 'Not competing on price.' &&
        Boolean(full?.decidedAt),
    );
    let blocked = false;
    try {
      await transitionOpportunity({
        companyId: company.id,
        opportunityId: id,
        to: 'ACCEPTED',
        actorId: null,
      });
    } catch (e) {
      blocked = (e as { status?: number }).status === 409;
    }
    check('a disallowed transition is refused', blocked);
    const redetected = await recordOpportunity(
      company.id,
      input('Pricing change: -25%'),
    );
    check(
      'a rejected opportunity is not resurrected by re-detection',
      redetected.outcome === 'skipped' &&
        redetected.opportunity.status === 'REJECTED',
    );

    console.log('\nExpiry, and coming back');
    await transitionOpportunity({
      companyId: company.id,
      opportunityId: id,
      to: 'REVIEWED',
      actorId: null,
      note: 'Reconsidering.',
    });
    await db.opportunity.update({
      where: { id },
      data: { relevantUntil: new Date(Date.now() - DAY) },
    });
    const expired = await expireOpportunities(company.id);
    full = await getOpportunity(company.id, id);
    check(
      'expires once its relevance window passes',
      expired === 1 && full?.status === 'EXPIRED' && Boolean(full?.expiredAt),
    );
    const back = await recordOpportunity(
      company.id,
      input('Acme extends the price cut to subscriptions'),
    );
    check(
      're-detected with fresh evidence, it reopens',
      back.outcome === 'reopened' && back.opportunity.status === 'DETECTED',
    );
    full = await getOpportunity(company.id, id);
    check(
      '…and the history shows why',
      full?.events.at(-1)?.note === 'Detected again with fresh evidence.',
    );

    console.log('\nConcurrent decisions');
    const results = await Promise.allSettled([
      transitionOpportunity({
        companyId: company.id,
        opportunityId: id,
        to: 'ACCEPTED',
        actorId: null,
      }),
      transitionOpportunity({
        companyId: company.id,
        opportunityId: id,
        to: 'REJECTED',
        actorId: null,
      }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled').length;
    full = await getOpportunity(company.id, id);
    const decisions = full?.events.filter(
      (e) =>
        e.toStatus === 'ACCEPTED' ||
        (e.toStatus === 'REJECTED' && e.fromStatus === 'DETECTED'),
    ).length;
    check(
      'exactly one of two simultaneous decisions wins',
      won === 1 && decisions === 1,
      `${won} won`,
    );

    console.log('\nEvidence is required');
    let refused = false;
    try {
      await recordOpportunity(company.id, {
        ...input('x'),
        title: 'No evidence at all',
        signals: [],
      });
    } catch {
      refused = true;
    }
    check('an opportunity with no evidence is refused', refused);
  } finally {
    await db.company.delete({ where: { id: company.id } });
    const left = await db.opportunity.count({
      where: { companyId: company.id },
    });
    check(
      'cleanup: throwaway workspace and its opportunities removed',
      left === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll opportunity checks passed.'
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
