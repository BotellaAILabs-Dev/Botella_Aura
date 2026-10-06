/**
 * Proves recommendation prioritisation against a real database.
 *
 * Builds a workspace with a goal and channels, generates recommendations
 * through the real engine (closing soon, on-goal, low-confidence, plain,
 * signal-backed), then checks: a consistent, explained order; that what is
 * surfaced first has current evidence; that stale evidence holds one back;
 * that the business's decisions (a rejection, a deferral) change what is
 * surfaced; and that ranking never changes a recommendation's stored priority.
 *
 * Run: pnpm verify:prioritization
 *
 * The throwaway workspace is deleted at the end, including on failure.
 */
import { db } from '@/lib/db';
import type { SignalInput } from '@/lib/opportunities';
import { recordOpportunity } from '@/server/opportunities/opportunity.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import {
  snoozeRecommendation,
  surfaceRecommendations,
} from '@/server/recommendations/ranking.service';
import { transitionRecommendation } from '@/server/recommendations/recommendation.service';

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
const at = (d: number) => new Date(Date.now() + d * DAY);

async function main() {
  const company = await db.company.create({
    data: {
      name: 'zzverify prioritization',
      slug: `zzverify-prio-${Date.now()}`,
      industry: 'Coffee',
      preferences: {
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers',
          channels: ['LinkedIn', 'Instagram'],
          goals: 'Grow coffee subscriptions',
        },
      },
    },
  });
  const companyId = company.id;
  const ext = (k: number): SignalInput[] =>
    Array.from({ length: k }, (_, i) => ({
      kind: 'EXTERNAL' as const,
      label: `Source ${i + 1}`,
      detail: `Independent report ${i + 1}`,
      url: `https://news.example/${i}-${Math.random()}`,
    }));
  let seq = 0;
  const make = async (
    title: string,
    o: {
      signals?: SignalInput[];
      until?: Date;
      impact?: 'low' | 'medium' | 'high';
      channel?: string;
    } = {},
  ) => {
    seq += 1;
    const { opportunity } = await recordOpportunity(companyId, {
      type: 'TRENDING_TOPIC',
      title,
      summary: `${title}.`,
      rationale: 'Seen in independent sources.',
      source: 'TRENDS',
      detectedBy: 'rule:trending-topic',
      impact: o.impact ?? 'medium',
      effort: 'low',
      signals: o.signals ?? ext(2),
      dedupeKey: `zz:${seq}`,
      relevantUntil: o.until ?? at(20),
    });
    const g = await generateRecommendation({
      companyId,
      opportunityId: opportunity.id,
      actorId: null,
      templatesOnly: true,
      ...(o.channel
        ? { overrides: { channel: o.channel as 'Instagram' } }
        : {}),
    });
    if (!g.recommendationId)
      throw new Error(`setup: ${title}: ${g.reasons.join('; ')}`);
    return g.recommendationId;
  };

  try {
    // A signal-backed recommendation whose evidence can go stale.
    const signal = await db.signal.create({
      data: {
        companyId,
        source: 'TRENDS',
        kind: 'TREND_ITEM',
        title: 'Espresso machines sell out',
        summary: 'Home espresso machine sales jump',
        refId: 'zz:digest:item',
        observedAt: new Date(),
        expiresAt: at(10),
        reliability: 'HIGH',
        reliabilityReason: 'test',
        contextMatches: [],
        dedupeKey: `zz-signal-${Date.now()}`,
      },
    });
    const ids = {
      closing: await make('Holiday gift guide deadline', {
        until: at(2),
        impact: 'high',
      }),
      goal: await make('Subscriptions explained for first-time buyers'),
      plain: await make('Water temperature basics'),
      low: await make('Latte art trend', { signals: ext(1) }),
      backed: await make('Home espresso boom', {
        channel: 'Instagram',
        impact: 'high',
        signals: [
          {
            kind: 'TREND_ITEM',
            refId: 'zz:digest:item',
            label: signal.title,
            detail: signal.summary,
            signalId: signal.id,
          },
          ...ext(1),
        ],
      }),
    };
    const storedBefore = await db.recommendation.findMany({
      where: { companyId },
      select: { id: true, priority: true, priorityScore: true },
    });

    console.log('\nConsistent, explained priority');
    const first = await surfaceRecommendations(companyId);
    const second = await surfaceRecommendations(companyId);
    check(
      'every recommendation is ranked',
      first.length === 5,
      String(first.length),
    );
    check(
      'the same data gives the same order and scores',
      JSON.stringify(first.map((r) => [r.id, r.score])) ===
        JSON.stringify(second.map((r) => [r.id, r.score])),
    );
    check(
      'each score is explained by its factors',
      first.every(
        (r) =>
          r.factors.length > 0 &&
          r.score ===
            Math.max(
              0,
              Math.min(
                100,
                r.factors.reduce((s, f) => s + f.points, 0),
              ),
            ) &&
          r.explanation.startsWith(
            `${{ now: 'Surface now', next: 'Next', later: 'Later', hidden: 'Deferred' }[r.band]} (score ${r.score})`,
          ),
      ),
    );
    const byId = (id: string) => first.find((r) => r.id === id)!;
    check(
      'closing soon is surfaced first',
      first[0]!.id === ids.closing,
      first.map((r) => r.recommendation.title).join(' | '),
    );
    check(
      'fitting the business goal is explained as such',
      byId(ids.goal).factors.some((f) => f.factor === 'goals'),
    );
    check(
      'low confidence ranks below otherwise similar ones, and says why',
      byId(ids.low).rank > byId(ids.plain).rank &&
        /low confidence/.test(byId(ids.low).explanation),
    );

    console.log('\nHigh priority has supporting evidence');
    check(
      'everything surfaced “now” has current evidence',
      first
        .filter((r) => r.band === 'now')
        .every((r) => r.recommendation.evidence.some((e) => e.current)),
    );
    await db.signal.update({
      where: { id: signal.id },
      data: { expiresAt: at(-1) },
    });
    await db.recommendation.update({
      where: { id: ids.backed },
      data: { evidence: { deleteMany: { signalId: null } } },
    });
    const stale = (await surfaceRecommendations(companyId)).find(
      (r) => r.id === ids.backed,
    )!;
    check(
      'when its evidence goes stale, it is held back from the top, with the reason',
      stale.band !== 'now' &&
        stale.factors.some((f) => f.factor === 'evidence' && f.points < 0),
      stale.explanation,
    );

    console.log('\nPrevious decisions change what is resurfaced');
    const plainBefore = byId(ids.plain);
    await transitionRecommendation({
      companyId,
      recommendationId: ids.goal,
      to: 'REJECTED',
      actorId: null,
      note: 'Not now.',
    });
    const afterReject = await surfaceRecommendations(companyId);
    const plainAfter = afterReject.find((r) => r.id === ids.plain)!;
    check(
      'a rejected recommendation is no longer surfaced',
      !afterReject.some((r) => r.id === ids.goal),
    );
    check(
      'a similar one (same action and channel) sinks, saying why',
      plainAfter.score < plainBefore.score &&
        /you turned down 1 similar/.test(
          plainAfter.explanation + plainAfter.factors.map((f) => f.why).join(),
        ),
      `${plainBefore.score} → ${plainAfter.score}`,
    );
    await snoozeRecommendation({
      companyId,
      recommendationId: ids.plain,
      days: 3,
      actorId: null,
    });
    const snoozed = await surfaceRecommendations(companyId);
    check('“Not now” hides it', !snoozed.some((r) => r.id === ids.plain));
    check(
      '…still listed when hidden ones are asked for',
      (await surfaceRecommendations(companyId, { includeHidden: true })).find(
        (r) => r.id === ids.plain,
      )?.band === 'hidden',
    );
    const tooLong = await expectError(() =>
      snoozeRecommendation({
        companyId,
        recommendationId: ids.closing,
        days: 7,
        actorId: null,
      }),
    );
    check(
      'deferring past its relevance is refused (that is a “no”, not a “not now”)',
      /stops being relevant/.test(tooLong),
      tooLong,
    );
    // (Reading the list with a future date also expires what has lapsed by then.)
    const later = await surfaceRecommendations(companyId, { now: at(4) });
    const back = later.find((r) => r.id === ids.plain);
    check(
      'after the date it is resurfaced, and says so',
      Boolean(
        back?.resurfaced && /Back after you deferred it/.test(back.explanation),
      ),
    );
    const history = await db.recommendationEvent.findFirst({
      where: {
        recommendationId: ids.plain,
        note: { startsWith: 'Deferred until' },
      },
    });
    check('the deferral is in its history', Boolean(history));

    console.log('\nA prioritisation, not a permanent ranking');
    const storedAfter = await db.recommendation.findMany({
      where: { companyId, id: { in: storedBefore.map((s) => s.id) } },
      select: { id: true, priority: true, priorityScore: true },
    });
    check(
      'ranking never rewrites a recommendation’s stored priority',
      storedBefore.every((b) => {
        const a = storedAfter.find((x) => x.id === b.id)!;
        return a.priority === b.priority && a.priorityScore === b.priorityScore;
      }),
    );
  } finally {
    await db.company.delete({ where: { id: companyId } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.company.count({ where: { id: companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll prioritisation checks passed.'
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
