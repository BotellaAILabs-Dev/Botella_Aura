/**
 * Proves "Aura Suggests" end to end against a real database:
 *
 *   signals → opportunities → recommendations (the engine) → Aura Suggests
 *
 * Checks the acceptance criteria on what the engine really produces: each
 * suggestion is understandable without technical context, says why Aura
 * suggested it, keeps its evidence accessible, and has a clear next action —
 * and taking that action (Create content, Edit, Skip) does what it says.
 *
 * Run: pnpm verify:suggestions
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { TECHNICAL_TOKENS, readableText } from '@/lib/aura-suggests';
import { runDetection } from '@/server/opportunities/detection.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import {
  decideRecommendation,
  editRecommendation,
  presentRecommendations,
} from '@/server/recommendations/recommendation.service';
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
  const stamp = Date.now();
  const company = await db.company.create({
    data: {
      name: 'zzverify suggestions',
      slug: `zzverify-suggestions-${stamp}`,
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
    data: { email: `zzverify-suggestions-${stamp}@example.com`, name: 'Sam' },
  });

  try {
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
    await collectSignals(companyId);
    await runDetection(companyId);

    console.log('\nNothing to suggest yet');
    const empty = await getSuggestions(companyId);
    check(
      'before any recommendation, the list is empty (the page explains why)',
      empty.suggestions.length === 0 && empty.accepted.length === 0,
    );

    for (const o of await db.opportunity.findMany({ where: { companyId } })) {
      await generateRecommendation({
        companyId,
        opportunityId: o.id,
        actorId: null,
        templatesOnly: true,
      });
    }

    // ---- What Aura suggests -------------------------------------------------
    console.log('\nWhat Aura suggests, from what the engine really produced');
    const { suggestions } = await getSuggestions(companyId);
    check(
      'the engine’s recommendations are suggested, best first',
      suggestions.length >= 3 &&
        suggestions.every(
          (s, i) => i === 0 || s.rank > suggestions[i - 1]!.rank,
        ),
      `${suggestions.length} suggestions`,
    );
    check(
      'each says what to do, why, and what it should achieve',
      suggestions.every(
        (s) =>
          s.what.length > 5 &&
          s.action.length > 5 &&
          s.why.length > 10 &&
          s.expectedOutcome.length > 5,
      ),
    );
    check(
      'why is the reasoning, not the engine’s bookkeeping',
      suggestions.every((s) => !/pieces? of evidence:/.test(s.why)),
      suggestions.map((s) => s.why).join(' | '),
    );
    const technical = suggestions.flatMap((s) =>
      readableText(s).filter((t) => TECHNICAL_TOKENS.some((re) => re.test(t))),
    );
    check(
      'understandable without technical context: no codes, scores or ids',
      technical.length === 0,
      technical.join(' | '),
    );
    const sources = new Set(suggestions.flatMap((s) => s.basedOn));
    check(
      'based on says where it came from, in plain words',
      [
        'Trend signal',
        'Competitor activity',
        'Recent content performance',
      ].some((x) => sources.has(x)) &&
        suggestions.every((s) => s.basedOn.length > 0),
      [...sources].join(', '),
    );
    const dbEvidence = await db.recommendationEvidence.groupBy({
      by: ['recommendationId'],
      where: { recommendation: { companyId } },
      _count: true,
    });
    const countOf = new Map(
      dbEvidence.map((e) => [e.recommendationId, e._count]),
    );
    check(
      'every piece of evidence is accessible from the suggestion',
      suggestions.every(
        (s) =>
          s.evidence.length === countOf.get(s.id) &&
          s.evidence.every((e) => e.label && e.source),
      ),
    );
    check(
      'evidence with a source links to it',
      suggestions.some((s) =>
        s.evidence.some((e) => e.url?.startsWith('https://a.example/')),
      ),
    );
    check(
      'each has one clear next action that leads somewhere in Aura',
      suggestions.every(
        (s) =>
          s.next.label.length > 3 &&
          s.next.href.startsWith('/dashboard/') &&
          (s.next.accepts || s.next.blocked !== null),
      ),
      suggestions
        .map((s) => `${s.next.label} → ${s.next.href.slice(0, 30)}`)
        .join(' | '),
    );

    // ---- Shown --------------------------------------------------------------
    console.log('\nShown');
    const ids = suggestions.map((s) => s.id);
    const shown = await presentRecommendations({
      companyId,
      recommendationIds: ids,
      actorId: user.id,
      surface: 'suggestions',
      positions: Object.fromEntries(
        suggestions.map((s) => [s.id, { rank: s.rank }]),
      ),
    });
    const afterShow = await getSuggestions(companyId);
    const presentEvent = await db.recommendationEvent.findFirst({
      where: { recommendationId: ids[0], action: 'present' },
    });
    check(
      'showing them records that they were presented, where and at what rank',
      shown.presented.length === ids.length &&
        afterShow.suggestions.every((s) => s.status === 'PRESENTED') &&
        (presentEvent?.metadata as { surface?: string })?.surface ===
          'suggestions',
    );
    check(
      'and they are still waiting for an answer',
      afterShow.suggestions.length === suggestions.length,
    );

    // ---- Create content / Edit / Skip ---------------------------------------
    console.log('\nCreate content · Edit · Skip');
    const first = afterShow.suggestions[0]!;
    const actable = afterShow.suggestions.filter((s) => s.next.accepts);
    const go = actable[0] ?? first;
    await decideRecommendation({
      companyId,
      recommendationId: go.id,
      decision: 'ACCEPTED',
      actorId: user.id,
      expectedStatus: go.status,
    });
    const afterGo = await getSuggestions(companyId);
    const goAccepted = afterGo.accepted.find((s) => s.id === go.id);
    check(
      'taking the next step says yes: it moves to "You said yes to"',
      !afterGo.suggestions.some((s) => s.id === go.id) && Boolean(goAccepted),
    );
    check(
      'and its next step is still there, without accepting again',
      goAccepted?.next.label === go.next.label &&
        goAccepted.next.accepts === false,
    );

    const toEdit = afterGo.suggestions.find((s) => s.id !== go.id)!;
    await editRecommendation({
      companyId,
      recommendationId: toEdit.id,
      changes: { title: 'Tell subscribers why our prices hold' },
      actorId: user.id,
      expectedStatus: toEdit.status,
    });
    const afterEdit = await getSuggestions(companyId);
    const edited = afterEdit.accepted.find((s) => s.id === toEdit.id);
    check(
      'Edit saves the change and counts as a yes, with changes',
      edited?.what === 'Tell subscribers why our prices hold' &&
        edited.status === 'EDITED',
    );

    const toSkip = afterEdit.suggestions[0]!;
    const skipOpp = await db.recommendation.findUniqueOrThrow({
      where: { id: toSkip.id },
      select: { opportunityId: true },
    });
    await decideRecommendation({
      companyId,
      recommendationId: toSkip.id,
      decision: 'SKIPPED',
      actorId: user.id,
      expectedStatus: toSkip.status,
    });
    const afterSkip = await getSuggestions(companyId);
    check(
      'Skip takes it off the list (and out of "You said yes to")',
      !afterSkip.suggestions.some((s) => s.id === toSkip.id) &&
        !afterSkip.accepted.some((s) => s.id === toSkip.id),
    );
    check(
      'a skip is not a "no": its opportunity stays open',
      (
        await db.opportunity.findUniqueOrThrow({
          where: { id: skipOpp.opportunityId },
        })
      ).status === 'RECOMMENDED',
    );
    const stale = await decideRecommendation({
      companyId,
      recommendationId: toSkip.id,
      decision: 'SKIPPED',
      actorId: user.id,
    });
    check(
      'pressing Skip twice records it once',
      stale.changed === false &&
        (await db.recommendationEvent.count({
          where: { recommendationId: toSkip.id, action: 'skip' },
        })) === 1,
    );

    console.log('\nNot shared across businesses');
    check(
      'another business sees none of these',
      (await getSuggestions('not-this-company')).suggestions.length === 0,
    );
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
      ? '\nAll Aura Suggests checks passed.'
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
