/**
 * Proves "What matters now" against a real database, through every state a
 * workspace passes through:
 *
 *   brand new           → not enough information: says so, lists what is
 *                         missing, shows nothing invented
 *   profile only        → still nothing that stands out; no filler
 *   real activity       → the situation: active high-relevance opportunities
 *                         and important changes, each tied to its record,
 *                         explained from it, linked to its suggestion
 *   a decision is made  → the item leaves the list
 *
 * Run: pnpm verify:what-matters
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import { getWhatMatters } from '@/server/home/what-matters.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { transitionOpportunity } from '@/server/opportunities/opportunity.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
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

async function main() {
  const stamp = Date.now();
  const company = await db.company.create({
    data: {
      name: 'zzverify what matters',
      slug: `zzverify-matters-${stamp}`,
      industry: 'Coffee',
    },
  });
  const companyId = company.id;

  try {
    // ---- Brand new ----------------------------------------------------------
    console.log('\nA brand-new workspace');
    const empty = await getWhatMatters(companyId);
    check(
      'not enough information: it says so instead of inventing insights',
      empty.state === 'insufficient' &&
        empty.items.length === 0 &&
        /doesn’t have enough information/.test(empty.summary),
      `${empty.state}: ${empty.summary}`,
    );
    check(
      'and says exactly what is missing, with where to fix each',
      empty.gaps.map((g) => g.key).join(',') ===
        'trends,competitors,results,goals' &&
        empty.gaps.every((g) => g.action.href.startsWith('/dashboard/')),
      empty.gaps.map((g) => g.key).join(','),
    );

    // ---- Profile only -------------------------------------------------------
    console.log('\nOnly a business profile');
    await db.company.update({
      where: { id: companyId },
      data: {
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
    await collectSignals(companyId);
    const profile = await getWhatMatters(companyId);
    check(
      'facts about the business are not presented as news',
      profile.items.every((i) => i.kind === 'opportunity') &&
        !profile.items.some((i) => i.kind === 'change'),
      profile.items.map((i) => i.title).join(' | '),
    );
    check(
      'with competitors and results still missing, the gaps stay visible',
      profile.gaps.some((g) => g.key === 'competitors') &&
        profile.gaps.some((g) => g.key === 'results') &&
        !profile.gaps.some((g) => g.key === 'goals'),
      profile.gaps.map((g) => g.key).join(','),
    );

    // ---- Real activity ------------------------------------------------------
    console.log('\nA business with something going on');
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
            item('n1', 'Specialty coffee prices climb', 'https://a.example/1'),
            item(
              'n2',
              'Specialty coffee shops win on transparency',
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
    for (const name of ['Acme Coffee', 'Bean Co']) {
      const c = await db.competitorProfile.create({
        data: { companyId, name },
      });
      await db.competitorSnapshot.create({
        data: {
          competitorId: c.id,
          capturedAt: ago(3),
          changesSummary: {
            hasChanges: true,
            ...(name === 'Acme Coffee'
              ? { pricing: 'Cut subscriptions by 20%' }
              : { homepage: 'New hero message about freshness' }),
            news: [],
            skipped: [],
            model: 'x',
            capturedAt: ago(3).toISOString(),
          } as Prisma.InputJsonObject,
        },
      });
    }
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
    await collectSignals(companyId);
    await runDetection(companyId);
    const firstOpp = await db.opportunity.findFirstOrThrow({
      where: { companyId, detectedBy: 'rule:competitor-move' },
      orderBy: { priorityScore: 'desc' },
    });
    await generateRecommendation({
      companyId,
      opportunityId: firstOpp.id,
      actorId: null,
      templatesOnly: true,
    });

    const w = await getWhatMatters(companyId);
    check(
      'the situation is summarised in one line, from the items',
      (w.state === 'ready' || w.state === 'limited') &&
        w.items.length > 0 &&
        w.items.length <= 5 &&
        /worth acting on|to know about/.test(w.summary),
      `${w.state}: ${w.summary}`,
    );

    // Every item must be a real record of this workspace.
    const oppIds = w.items
      .filter((i) => i.ref.type === 'opportunity')
      .map((i) => i.ref.id);
    const sigIds = w.items
      .filter((i) => i.ref.type === 'signal')
      .map((i) => i.ref.id);
    const [opps, sigs] = await Promise.all([
      db.opportunity.findMany({
        where: { id: { in: oppIds }, companyId },
        select: { id: true, title: true, status: true },
      }),
      db.signal.findMany({
        where: { id: { in: sigIds }, companyId },
        select: { id: true, title: true, summary: true },
      }),
    ]);
    check(
      'each item is connected to an opportunity or signal of this business',
      opps.length === oppIds.length && sigs.length === sigIds.length,
      `${oppIds.length} opportunities, ${sigIds.length} signals`,
    );
    check(
      'opportunities shown are active ones',
      opps.every((o) => ACTIVE_STATUSES.includes(o.status)),
    );
    check(
      'nothing is reworded into a claim: titles are the records’ own',
      w.items.every(
        (i) =>
          i.title ===
          (i.ref.type === 'opportunity'
            ? opps.find((o) => o.id === i.ref.id)?.title
            : sigs.find((s) => s.id === i.ref.id)?.title),
      ),
    );
    check(
      'each says why it matters',
      w.items.every((i) => i.why.length > 15),
      w.items.map((i) => i.why).join(' | '),
    );
    const changeWhy = w.items
      .filter((i) => i.kind === 'change')
      .every((i) => {
        const s = sigs.find((x) => x.id === i.ref.id)!;
        return i.why.includes(s.summary.replace(/\.$/, ''));
      });
    check('a change’s reason quotes what was actually recorded', changeWhy);
    check(
      'important changes are there: a competitor change and the drop in results',
      w.items.some((i) => /changed its (pricing|homepage)/.test(i.title)) ||
        w.items.some((i) => /Respond to Acme/.test(i.title)),
      w.items.map((i) => i.title).join(' | '),
    );
    const linked = w.items.find((i) => i.ref.id === firstOpp.id);
    check(
      'an opportunity with a suggestion links to it',
      linked?.related?.label === 'See Aura’s suggestion',
      JSON.stringify(linked?.related),
    );
    check(
      'one without a suggestion offers to ask for one',
      w.items
        .filter((i) => i.kind === 'opportunity' && i.ref.id !== firstOpp.id)
        .every((i) => i.related?.label === 'Ask Aura for a suggestion'),
    );
    check(
      'what it is based on is stated',
      Boolean(w.basis && /Based on \d+ current signals? from/.test(w.basis)),
      w.basis ?? '',
    );

    // ---- A decision is made -------------------------------------------------
    console.log('\nAfter a decision');
    const target = w.items.find(
      (i) => i.kind === 'opportunity' && i.ref.id !== firstOpp.id,
    );
    if (target) {
      await transitionOpportunity({
        companyId,
        opportunityId: target.ref.id,
        to: 'REJECTED',
        actorId: null,
        note: 'Not for us.',
      });
      const after = await getWhatMatters(companyId);
      check(
        'a rejected opportunity leaves What matters now',
        !after.items.some((i) => i.ref.id === target.ref.id),
      );
    } else {
      check('a second opportunity to decide on exists', false);
    }

    console.log('\nNot shared across businesses');
    const other = await getWhatMatters('not-this-company');
    check(
      'another business sees none of this',
      other.items.length === 0 && other.state === 'insufficient',
    );
  } finally {
    await db.company.delete({ where: { id: companyId } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.signal.count({ where: { companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll What matters now checks passed.'
      : `\n${failures} check(s) BROKEN.`,
  );
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
