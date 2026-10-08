/**
 * Proves recommendation quality validation against a real database:
 *
 *   · Aura's own suggestions (the real engine) pass and are presented
 *   · a hallucinated figure written into a suggestion gets it held back from
 *     Aura Suggests, with the reason — never shown as trusted
 *   · a suggestion whose opportunity the business turned down is held back
 *   · a newly written suggestion that breaks the business's rules (a topic it
 *     avoids) is withdrawn at once by the automatic pass, the reason kept in
 *     its history
 *   · every presented suggestion carries its verdict; the checks run before
 *     presentation
 *
 * Run: pnpm verify:quality
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { runDetection } from '@/server/opportunities/detection.service';
import { transitionOpportunity } from '@/server/opportunities/opportunity.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import {
  getRecommendationQuality,
  qualityFor,
} from '@/server/recommendations/quality.service';
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

async function seed(name: string, voice?: Prisma.InputJsonObject) {
  const company = await db.company.create({
    data: {
      name,
      slug: `zzverify-quality-${name.replace(/\W/g, '')}-${Date.now()}`,
      industry: 'Coffee',
      ...(voice ? { brandVoiceProfile: voice } : {}),
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
  await collectSignals(companyId);
  await runDetection(companyId);
  return companyId;
}

async function main() {
  const ids: string[] = [];
  try {
    const companyId = await seed('Quality');
    ids.push(companyId);
    await suggestFromOpportunities(companyId, { templatesOnly: true });
    const recs = await db.recommendation.findMany({ where: { companyId } });

    console.log('\nAura’s own suggestions');
    const q = await qualityFor(
      companyId,
      recs.map((r) => r.id),
    );
    const verdicts = recs.map((r) => q.get(r.id)!.verdict);
    check(
      'the engine’s suggestions are checked, and none is blocked',
      recs.length >= 2 && verdicts.every((v) => v !== 'blocked'),
      verdicts.join(', '),
    );
    const before = await getSuggestions(companyId);
    check(
      'every presented suggestion carries its verdict, and follows the schema',
      before.suggestions.length === recs.length &&
        before.suggestions.every((s) => Boolean(s.quality)) &&
        recs.every(
          (r) =>
            q.get(r.id)!.checks.find((c) => c.check === 'schema')!.status ===
            'pass',
        ),
    );
    check(
      'every suggestion has traceable evidence',
      recs.every(
        (r) =>
          q.get(r.id)!.checks.find((c) => c.check === 'evidence')!.status !==
          'fail',
      ),
    );

    console.log('\nA hallucinated figure');
    const [a, b] = recs as [(typeof recs)[number], (typeof recs)[number]];
    await db.recommendation.update({
      where: { id: a.id },
      data: {
        expectedOutcome: 'Guaranteed 340% more subscriptions within a week.',
      },
    });
    const afterA = await getSuggestions(companyId);
    const heldA = afterA.heldBack.find((h) => h.id === a.id);
    check(
      'it is held back — not shown in Aura Suggests',
      !afterA.suggestions.some((s) => s.id === a.id) && Boolean(heldA),
    );
    check(
      'and the reason is said plainly',
      Boolean(heldA && /340%|promises a result/.test(heldA.problems.join(' '))),
      heldA?.problems.join(' | '),
    );
    const qa = await getRecommendationQuality(companyId, a.id);
    check(
      'its quality report says blocked, with the failing checks',
      qa?.verdict === 'blocked' &&
        qa.checks.find((c) => c.check === 'business_context')!.status ===
          'fail' &&
        qa.checks.find((c) => c.check === 'expected_outcome')!.status ===
          'fail',
    );

    console.log('\nAn opportunity already turned down');
    await transitionOpportunity({
      companyId,
      opportunityId: b.opportunityId,
      to: 'REJECTED',
      actorId: null,
      note: 'Not for us.',
    });
    // Rejecting the opportunity also rejects its waiting suggestion — check a
    // suggestion that still waits while its opportunity is closed:
    await db.recommendation.update({
      where: { id: b.id },
      data: { status: 'PRESENTED' },
    });
    const afterB = await getSuggestions(companyId);
    check(
      'its suggestion is held back',
      !afterB.suggestions.some((s) => s.id === b.id) &&
        afterB.heldBack.some(
          (h) => h.id === b.id && /already answered/.test(h.reason),
        ),
      JSON.stringify(afterB.heldBack.map((h) => h.reason)),
    );

    console.log('\nWritten against the business’s rules');
    const strict = await seed('Strict', {
      toneDescriptors: ['warm'],
      sentenceLength: 'short',
      vocabulary: [],
      commonPhrases: [],
      topicsToAvoid: ['specialty coffee'],
      formatting: { emojiUsage: 'none', hashtagStyle: 'none', notes: '' },
      summary: 'Warm.',
    } as Prisma.InputJsonObject);
    ids.push(strict);
    const run = await suggestFromOpportunities(strict, { templatesOnly: true });
    const withdrawn = await db.recommendation.findMany({
      where: { companyId: strict, status: 'WITHDRAWN' },
      include: { events: { where: { action: 'withdraw' } } },
    });
    check(
      'a new suggestion that breaks them is withdrawn at once by the automatic pass',
      withdrawn.length > 0 &&
        run.skipped.some((s) =>
          s.reasons.some((r) => /quality check: .*specialty coffee/.test(r)),
        ),
      JSON.stringify(run.skipped.map((s) => s.reasons[0])),
    );
    check(
      'with the reason kept in its history',
      withdrawn.every((w) =>
        w.events.some(
          (e) =>
            e.source === 'system' &&
            /Failed Aura’s quality checks/.test(e.note ?? ''),
        ),
      ),
    );
    check(
      'and it is never presented',
      !(await getSuggestions(strict)).suggestions.some((s) =>
        withdrawn.some((w) => w.id === s.id),
      ),
    );
  } finally {
    for (const id of ids)
      await db.company.delete({ where: { id } }).catch(() => undefined);
    check(
      'cleanup: throwaway workspaces removed',
      (await db.recommendation.count({ where: { companyId: { in: ids } } })) ===
        0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll quality checks passed.'
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
