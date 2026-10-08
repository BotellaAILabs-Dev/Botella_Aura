/**
 * Proves the empty and insufficient-data states against a real database, by
 * walking one workspace through what a new business actually meets:
 *
 *   bare            → "tell Aura what your business does"; nothing written
 *   described       → "tell Aura where you publish"; nothing written
 *   channels set    → "give Aura something to watch"
 *   watching        → "nothing new seen yet — check for new opportunities"
 *   signals + opps  → Aura can recommend, and says what still limits it
 *
 * At every blocked step the automatic pass writes nothing and Aura Suggests
 * stays empty — no generic suggestion fills the page — and the missing
 * information links to the exact Business Context question.
 *
 * Run: pnpm verify:readiness
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { getQuestions } from '@/server/business-context/questions.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { getReadiness } from '@/server/recommendations/readiness.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';
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
  const company = await db.company.create({
    data: {
      name: 'zzverify readiness',
      slug: `zzverify-readiness-${Date.now()}`,
    },
  });
  const companyId = company.id;
  const nothingWritten = async () => {
    const run = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    const shown = await getSuggestions(companyId);
    return {
      run,
      ok:
        run.created.length === 0 &&
        shown.suggestions.length === 0 &&
        (await db.recommendation.count({ where: { companyId } })) === 0,
    };
  };

  try {
    console.log('\nA bare workspace');
    let r = await getReadiness(companyId);
    check(
      'Aura says it does not know what the business does — first thing to fix',
      r.state === 'blocked' && r.primary?.scenario === 'business_context',
      JSON.stringify(r.primary),
    );
    let n = await nothingWritten();
    check(
      'nothing is written or shown, and the reason is given',
      n.ok &&
        n.run.notReady === 'Aura does not know what the business does yet.',
      n.run.notReady ?? '',
    );
    check(
      'the next step links to the Business Context question',
      r.primary?.next?.href ===
        '/dashboard/business?ask=identity.description#aura-questions',
    );

    console.log('\nDescribed, but no channels');
    await db.company.update({
      where: { id: companyId },
      data: {
        preferences: {
          business: {
            description: 'We roast single-origin coffee in small batches.',
          },
          marketingProfile: {
            marketMode: 'B2C',
            audience: 'Home brewers',
            goals: 'Grow subscriptions',
          },
        } as Prisma.InputJsonObject,
      },
    });
    r = await getReadiness(companyId);
    check(
      '"Tell Aura where you publish" — it won’t guess',
      r.primary?.scenario === 'no_channels',
      JSON.stringify(r.items.map((i) => i.scenario)),
    );
    n = await nothingWritten();
    check(
      'still nothing written',
      n.ok &&
        n.run.notReady === 'The business has not said where it publishes.',
    );
    const qs = await getQuestions(companyId, {
      focusField: 'channels.preferred',
      limit: 3,
    });
    check(
      'the link opens on that very question',
      qs?.questions[0]?.field === 'channels.preferred',
      qs?.questions.map((q) => q.field).join(', '),
    );
    // Asked so often it is resting: following the link still shows it.
    await db.businessContextQuestion.updateMany({
      where: { companyId, questionKey: 'missing:channels.preferred' },
      data: { timesAsked: 99, lastAskedAt: new Date() },
    });
    const rested = await getQuestions(companyId, { limit: 3 });
    const focused = await getQuestions(companyId, {
      focusField: 'channels.preferred',
      limit: 3,
    });
    check(
      'even when the question is resting, the link still brings it up',
      !rested?.questions.some((q) => q.field === 'channels.preferred') &&
        focused?.questions[0]?.field === 'channels.preferred',
    );

    console.log('\nChannels set, nothing to watch');
    await db.company.update({
      where: { id: companyId },
      data: {
        preferences: {
          business: {
            description: 'We roast single-origin coffee in small batches.',
          },
          marketingProfile: {
            marketMode: 'B2C',
            audience: 'Home brewers',
            goals: 'Grow subscriptions',
            channels: ['LinkedIn'],
          },
        } as Prisma.InputJsonObject,
      },
    });
    r = await getReadiness(companyId);
    check(
      '"Give Aura something to watch", pointing at topics to follow',
      r.primary?.scenario === 'insufficient_signals' &&
        r.primary.next?.href === '/dashboard/settings/trends',
      JSON.stringify(r.primary),
    );
    check('and Aura Suggests stays empty', (await nothingWritten()).ok);

    console.log('\nWatching, but nothing collected yet');
    await db.companyTrendConfig.create({
      data: { companyId, keywords: ['specialty coffee'] },
    });
    r = await getReadiness(companyId);
    check(
      '"Nothing new seen yet", with a button to check now',
      r.primary?.scenario === 'insufficient_signals' &&
        r.primary.next?.action === 'detect_opportunities',
      JSON.stringify(r.primary),
    );

    console.log('\nSignals and opportunities');
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
    await collectSignals(companyId);
    await runDetection(companyId);
    r = await getReadiness(companyId);
    check(
      'Aura can recommend now',
      r.canRecommend && r.state !== 'blocked',
      JSON.stringify(r.items.map((i) => `${i.scenario}:${i.severity}`)),
    );
    check(
      'and still says what limits it: no connected channel, no results yet',
      r.items.some((i) => i.scenario === 'no_connected_channel') &&
        r.items.some((i) => i.scenario === 'no_performance_data'),
    );
    const run = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    check(
      'suggestions are made — from real opportunities',
      !run.notReady && run.created.length > 0,
      JSON.stringify(run.skipped.map((s) => s.reasons[0])),
    );
  } finally {
    await db.company.delete({ where: { id: companyId } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.recommendation.count({ where: { companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll readiness checks passed.'
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
