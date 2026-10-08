/**
 * Proves Aura suggests on its own (server/recommendations/autosuggest.service.ts):
 *
 *   · with opportunities but no channels, nothing is suggested — and the
 *     reason is the missing channel, never a guessed one
 *   · once the business says where it publishes, suggestions are made
 *     without anyone pressing "Recommend"
 *   · running it again adds nothing: one suggestion per opportunity
 *
 * Run: pnpm verify:autosuggest
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { runDetection } from '@/server/opportunities/detection.service';
import {
  openOpportunitiesWithoutSuggestion,
  suggestFromOpportunities,
} from '@/server/recommendations/autosuggest.service';
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
const profile = (channels: string[]) =>
  ({
    business: {
      description: 'We roast single-origin coffee in small batches.',
    },
    marketingProfile: {
      marketMode: 'B2C',
      audience: 'Home brewers who buy beans online',
      channels,
      goals: 'Grow coffee subscriptions',
    },
  }) as Prisma.InputJsonObject;

async function main() {
  const stamp = Date.now();
  const company = await db.company.create({
    data: {
      name: 'zzverify autosuggest',
      slug: `zzverify-autosuggest-${stamp}`,
      industry: 'Coffee',
      preferences: profile([]),
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
    const open = await openOpportunitiesWithoutSuggestion(companyId);

    console.log('\nNo channels: nothing is guessed');
    const none = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    check(
      'opportunities exist, but no suggestion is made',
      open.length > 0 && none.created.length === 0,
      `${open.length} open`,
    );
    check(
      // Aura does not even start writing without channels
      // (lib/data-readiness.ts): one clear reason, not one per opportunity.
      'and the reason is the missing channel',
      none.notReady === 'The business has not said where it publishes.' &&
        none.skipped.length === 0,
      JSON.stringify({ notReady: none.notReady, skipped: none.skipped }),
    );

    console.log('\nOnce the business says where it publishes');
    await db.company.update({
      where: { id: companyId },
      data: { preferences: profile(['LinkedIn']) },
    });
    const made = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    const { suggestions } = await getSuggestions(companyId);
    check(
      'Aura makes suggestions on its own, and they show in Aura Suggests',
      made.created.length > 0 &&
        made.created.every((c) =>
          suggestions.some((s) => s.id === c.recommendationId),
        ),
      `${made.created.length} made`,
    );

    console.log('\nRunning again');
    const again = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    const count = await db.recommendation.count({ where: { companyId } });
    check(
      'adds nothing new: one suggestion per opportunity',
      again.created.length === 0 && count === made.created.length,
      `${again.created.length} new, ${count} total`,
    );
    check(
      'every remaining opportunity is accounted for (made or skipped with a reason)',
      made.created.length + made.skipped.length + made.remaining ===
        open.length && made.skipped.every((s) => s.reasons.length > 0),
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
      ? '\nAll autosuggest checks passed.'
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
