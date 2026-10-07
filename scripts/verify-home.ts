/**
 * Proves Aura Home against a real database, on a workspace with something
 * going on: market trends, a competitor move, a drop in results, posts
 * written and published, suggestions made and answered.
 *
 * Checks the acceptance criteria: Home opens with actionable context (what
 * matters now: the situation, and the work waiting on a person) rather than
 * disconnected metrics;
 * recommendations are prominent; opportunities can be reached; results are
 * compared, not just listed; recent activity says what happened; and one
 * failing source never takes Home down.
 *
 * Run: pnpm verify:home
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import { runDetection } from '@/server/opportunities/detection.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';
import { getAuraHome } from '@/server/home/home.service';
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
      name: 'zzverify home',
      slug: `zzverify-home-${stamp}`,
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
  const user = await db.user.create({
    data: { email: `zzverify-home-${stamp}@example.com`, name: 'Dana Ruiz' },
  });

  try {
    console.log('\nA brand-new workspace');
    const fresh = await getAuraHome(companyId);
    check(
      'nothing to show yet: Home still renders every section, calmly',
      fresh.whatMatters?.state === 'insufficient' &&
        fresh.whatMatters.items.length === 0 &&
        fresh.waiting.length === 0 &&
        fresh.suggestions.length === 0 &&
        fresh.opportunities.length === 0 &&
        fresh.activity.length === 0 &&
        fresh.results !== null,
    );

    // ---- A business with something going on --------------------------------
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
    // Posts: two waiting for approval, published this week and last.
    for (const [status, publishedAt, createdById] of [
      ['PENDING_APPROVAL', null, null],
      ['PENDING_APPROVAL', null, user.id],
      ['PUBLISHED', ago(2), null],
      ['PUBLISHED', ago(3), null],
      ['PUBLISHED', ago(9), null],
    ] as const) {
      await db.contentDraft.create({
        data: {
          companyId,
          type: 'LINKEDIN_POST',
          status,
          title: `Post ${status.toLowerCase()} ${publishedAt ? 'out' : 'in'}`,
          publishedAt,
          createdById,
        },
      });
    }
    await collectSignals(companyId);
    await runDetection(companyId);
    for (const o of await db.opportunity.findMany({ where: { companyId } })) {
      await generateRecommendation({
        companyId,
        opportunityId: o.id,
        actorId: null,
        templatesOnly: true,
      });
    }
    const firstRec = await db.recommendation.findFirstOrThrow({
      where: { companyId },
      orderBy: { priorityScore: 'desc' },
    });
    await decideRecommendation({
      companyId,
      recommendationId: firstRec.id,
      decision: 'ACCEPTED',
      actorId: user.id,
    });

    const home = await getAuraHome(companyId);

    // ---- What matters now ---------------------------------------------------
    console.log('\nWhat matters now');
    check(
      'Home opens with the business situation: a summary and items from real opportunities and changes',
      home.whatMatters !== null &&
        (home.whatMatters.state === 'ready' ||
          home.whatMatters.state === 'limited') &&
        home.whatMatters.items.length > 0 &&
        home.whatMatters.summary.length > 10,
      `${home.whatMatters?.state}: ${home.whatMatters?.summary}`,
    );
    check(
      'and the work waiting on a person, each with an action',
      home.waiting.some((w) => w.title === '2 posts to approve') &&
        home.waiting.some(
          (w) =>
            w.key === 'suggestions:accepted' &&
            w.title.includes(firstRec.title),
        ) &&
        home.waiting.every((w) => w.href.startsWith('/dashboard')),
      home.waiting.map((w) => w.title).join(' | '),
    );

    // ---- Aura Suggests ------------------------------------------------------
    console.log('\nAura Suggests');
    check(
      'recommendations are prominent: the top suggestions are on Home, with what, why and a next step',
      home.suggestions.length > 0 &&
        home.suggestions.length <= 3 &&
        home.suggestions.every(
          (s) => s.what && s.why && s.expectedOutcome && s.next.label,
        ),
      `${home.suggestions.length} of ${home.suggestionCount}`,
    );
    check(
      'and the rest are counted, one click away',
      home.suggestionCount >= home.suggestions.length &&
        !home.suggestions.some((s) => s.id === firstRec.id),
    );

    // ---- Opportunities ------------------------------------------------------
    console.log('\nActive opportunities');
    const activeCount = await db.opportunity.count({
      where: {
        companyId,
        status: { in: ACTIVE_STATUSES },
      },
    });
    check(
      'open opportunities are listed, each linking to it',
      home.opportunities.length > 0 &&
        home.opportunities.length <= 4 &&
        home.opportunityCount === activeCount &&
        home.opportunities.every((o) => o.id && o.title && o.typeLabel),
      `${home.opportunities.length} shown of ${home.opportunityCount} (db ${activeCount})`,
    );
    check(
      'an accepted opportunity is no longer "active"',
      !home.opportunities.some((o) => o.id === firstRec.opportunityId),
    );

    // ---- Results ------------------------------------------------------------
    console.log('\nResults');
    const posts = home.results?.find((t) => t.key === 'posts');
    check(
      'results are compared with last week, not just listed',
      posts?.value === '2' && posts.change?.text === 'Up 100% on last week',
      JSON.stringify(posts),
    );
    const acted = home.results?.find((t) => t.key === 'suggestions');
    check(
      'what the business did with Aura’s suggestions is part of the results',
      acted?.value === '1 of 1',
      JSON.stringify(acted),
    );

    // ---- Recent activity ----------------------------------------------------
    console.log('\nRecent activity');
    const lines = home.activity.map((a) => `${a.by} ${a.text}`);
    check(
      'says what Aura and the team did, newest first',
      home.activity.length > 0 &&
        home.activity.every(
          (a, i) => i === 0 || a.at <= home.activity[i - 1]!.at,
        ),
      lines.join(' | '),
    );
    check(
      'a person’s decision is shown by name',
      lines.some((l) => l === `Dana said yes to “${firstRec.title}”`),
      lines.join(' | '),
    );
    check(
      'what Aura did is shown as Aura',
      lines.some((l) =>
        /^Aura (spotted an opportunity|suggested|wrote|published|noticed a change)/.test(
          l,
        ),
      ),
    );

    // ---- Isolation and resilience ------------------------------------------
    console.log('\nSafe');
    const other = await getAuraHome('not-this-company');
    check(
      'another business sees none of this',
      other.suggestions.length === 0 &&
        other.opportunities.length === 0 &&
        other.activity.length === 0 &&
        other.whatMatters?.items.length === 0 &&
        other.waiting.length === 0,
    );
    const original = db.lead.count.bind(db.lead);
    (db.lead as unknown as { count: () => Promise<number> }).count = () =>
      Promise.reject(new Error('simulated outage'));
    let survived = false;
    try {
      const h = await getAuraHome(companyId);
      survived = h.suggestions.length > 0 && h.opportunities.length > 0;
    } finally {
      (db.lead as unknown as { count: typeof original }).count = original;
    }
    check('one failing source leaves the rest of Home working', survived);
  } finally {
    await db.company.delete({ where: { id: companyId } });
    await db.user.delete({ where: { id: user.id } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.recommendation.count({ where: { companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll Aura Home checks passed.'
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
