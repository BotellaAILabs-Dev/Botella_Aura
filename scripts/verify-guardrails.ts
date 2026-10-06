/**
 * Proves the recommendation rules and guardrails against a real database,
 * through the real engine (lib/recommendation-rules.ts,
 * server/recommendations/engine.service.ts).
 *
 * Each rule gets its own throwaway workspace so they cannot mask each other:
 * requirements met, low confidence, unsupported channels, unavailable
 * integrations, duplicates, muting, conflicts, expiry, and frequency limits.
 *
 * Run: pnpm verify:guardrails
 *
 * Every workspace is deleted at the end, including on failure.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  FREQUENCY_LIMITS,
  LOW_CONFIDENCE_BLOCKER,
} from '@/lib/recommendation-rules';
import type { SignalInput } from '@/lib/opportunities';
import { runDetection } from '@/server/opportunities/detection.service';
import { recordOpportunity } from '@/server/opportunities/opportunity.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import {
  createRecommendationFromOpportunity,
  getRecommendation,
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
const created: string[] = [];

async function workspace(tag: string, channels: string[]) {
  const c = await db.company.create({
    data: {
      name: `zzverify guardrails ${tag}`,
      slug: `zzverify-guard-${tag}-${Date.now()}`,
      industry: 'Coffee',
      preferences: {
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers',
          channels,
        },
      },
    },
  });
  created.push(c.id);
  return c.id;
}

const ext = (n: number): SignalInput[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'EXTERNAL' as const,
    label: `Source ${i + 1}`,
    detail: `Independent report ${i + 1} on the topic`,
    url: `https://news.example/${i + 1}-${Math.random()}`,
  }));

let seq = 0;
function opportunity(
  companyId: string,
  title: string,
  o: {
    evidence?: number;
    signals?: SignalInput[];
    type?: 'TRENDING_TOPIC' | 'CONTENT_GAP' | 'COMPETITOR_MOVE';
    relevantUntil?: Date;
    impact?: 'low' | 'medium' | 'high';
  } = {},
) {
  seq += 1;
  return recordOpportunity(companyId, {
    type: o.type ?? 'TRENDING_TOPIC',
    title,
    summary: `${title}.`,
    rationale: 'Seen in independent sources.',
    source: 'TRENDS',
    detectedBy: 'rule:trending-topic',
    impact: o.impact ?? 'medium',
    effort: 'low',
    signals: o.signals ?? ext(o.evidence ?? 2),
    dedupeKey: `zz:${seq}`,
    ...(o.relevantUntil ? { relevantUntil: o.relevantUntil } : {}),
  }).then((r) => r.opportunity);
}
const gen = (companyId: string, opportunityId: string, extra: object = {}) =>
  generateRecommendation({
    companyId,
    opportunityId,
    actorId: null,
    templatesOnly: true,
    ...extra,
  });

async function main() {
  try {
    console.log('\nOnly recommendations that meet the requirements');
    const w1 = await workspace('a', ['LinkedIn']);
    const okOpp = await opportunity(w1, 'Specialty coffee prices climb');
    const g1 = await gen(w1, okOpp.id);
    const r1 = g1.recommendationId
      ? await getRecommendation(w1, g1.recommendationId)
      : null;
    check(
      'enough evidence, medium confidence, a channel the business uses → executable',
      g1.status === 'created' &&
        r1?.executable === true &&
        r1.blockers.length === 0,
      `${g1.status} ${g1.flags.join('; ')}`,
    );
    check(
      'its execution brief leads to the work',
      Boolean(r1?.execution.href.startsWith('/dashboard/content/new')),
    );
    check(
      'relevance capped at 30 days',
      Boolean(
        r1?.relevantUntil &&
        r1.relevantUntil.getTime() - Date.now() <= 30 * DAY + 60_000,
      ),
    );

    console.log('\nLow-confidence recommendations are flagged, not executable');
    const lowOpp = await opportunity(w1, 'Cold brew interest rises', {
      evidence: 1,
    });
    const g2 = await gen(w1, lowOpp.id);
    const r2 = g2.recommendationId
      ? await getRecommendation(w1, g2.recommendationId)
      : null;
    check(
      'stored as advice: flagged, blocked, priority not high',
      r2?.confidence === 'LOW' &&
        r2.executable === false &&
        r2.blockers.includes(LOW_CONFIDENCE_BLOCKER) &&
        r2.flags.some((f) => /low confidence/.test(f)) &&
        ['LOW', 'MEDIUM'].includes(r2.priority),
      JSON.stringify({ c: r2?.confidence, e: r2?.executable, p: r2?.priority }),
    );
    check(
      'its execution brief leads to review, not the work',
      r2?.execution.href === `/dashboard/opportunities?focus=${lowOpp.id}`,
    );
    const start = await expectError(() =>
      transitionRecommendation({
        companyId: w1,
        recommendationId: r2!.id,
        to: 'IN_PROGRESS',
        actorId: null,
      }),
    );
    check(
      'it cannot be started (or even reach start) before review',
      /cannot/.test(start),
      start,
    );
    const accepted = await transitionRecommendation({
      companyId: w1,
      recommendationId: r2!.id,
      to: 'ACCEPTED',
      actorId: null,
    });
    check(
      'accepting it is the review: it becomes executable',
      accepted.executable && accepted.blockers.length === 0,
    );
    const started = await transitionRecommendation({
      companyId: w1,
      recommendationId: r2!.id,
      to: 'IN_PROGRESS',
      actorId: null,
    });
    check('…and can then be started', started.status === 'IN_PROGRESS');

    console.log('\nUnsupported actions are not executable');
    const xOpp = await opportunity(w1, 'Roasting myths debunked');
    const g3 = await gen(w1, xOpp.id, { overrides: { channel: 'X' } });
    const r3 = g3.recommendationId
      ? await getRecommendation(w1, g3.recommendationId)
      : null;
    check(
      'a channel the business does not use → stored as advice, blocked',
      r3?.executable === false &&
        r3.blockers.some((b) => /X is not a channel/.test(b)),
      r3?.blockers.join('; '),
    );
    const w2 = await workspace('b', ['Instagram', 'YouTube']);
    await collectSignals(w2);
    await runDetection(w2);
    const channelOpps = await db.opportunity.findMany({
      where: { companyId: w2, type: 'CHANNEL' },
    });
    const yt = channelOpps.find((o) => /YouTube/.test(o.title));
    const ig = channelOpps.find((o) => /Instagram/.test(o.title));
    check(
      '(setup) unconnected-channel opportunities found for both',
      Boolean(yt && ig),
    );
    const gYt = yt ? await gen(w2, yt.id) : null;
    check(
      'connecting a channel Aura cannot connect (YouTube) is not recommended',
      gYt?.status === 'rejected' &&
        gYt.reasons.some((r) => /cannot connect YouTube/.test(r)),
      gYt?.reasons.join('; '),
    );
    const gIg = ig ? await gen(w2, ig.id) : null;
    const rIg = gIg?.recommendationId
      ? await getRecommendation(w2, gIg.recommendationId)
      : null;
    check(
      'connecting one it can (Instagram) is recommended, with no integration blocker',
      rIg?.type === 'CHANNEL' &&
        rIg.channel === 'Instagram' &&
        !rIg.blockers.some((b) => /cannot connect/.test(b)),
      JSON.stringify({
        s: gIg?.status,
        r: gIg?.reasons,
        u: gIg?.unsupported,
        b: rIg?.blockers,
        t: rIg?.type,
        c: rIg?.channel,
      }),
    );

    console.log('\nDuplicates and repetition are controlled');
    const dupOpp = await opportunity(
      w1,
      'Specialty coffee prices are climbing',
    );
    const gDup = await gen(w1, dupOpp.id);
    check(
      'a near-identical recommendation from another opportunity is refused',
      gDup.status === 'rejected' &&
        gDup.reasons.some((r) => /Duplicate/.test(r)),
      gDup.reasons.join('; '),
    );
    const w3 = await workspace('c', ['LinkedIn']);
    for (const t of [
      'Bean storage tips',
      'Grinder buying guide',
      'Water hardness explained',
    ]) {
      const o = await opportunity(w3, t);
      const g = await gen(w3, o.id);
      await transitionRecommendation({
        companyId: w3,
        recommendationId: g.recommendationId!,
        to: 'REJECTED',
        actorId: null,
      });
    }
    const gMuted = await gen(
      w3,
      (await opportunity(w3, 'Decaf process compared')).id,
    );
    check(
      'an action rejected 3 times in 30 days is not proposed again (the next viable one is)',
      gMuted.selected?.id !== 'post' &&
        gMuted.unsupported.some(
          (u) =>
            u.id === 'post' &&
            u.reasons.some((r) => /rejected this 3\+ times/.test(r)),
        ),
      JSON.stringify({
        s: gMuted.status,
        r: gMuted.reasons,
        u: gMuted.unsupported,
        sel: gMuted.selected?.id,
      }),
    );

    console.log('\nConflicting recommendations are flagged both ways');
    const w4 = await workspace('d', ['LinkedIn']);
    const acme = await db.competitorProfile.create({
      data: { companyId: w4, name: 'Acme Coffee' },
    });
    await db.competitorSnapshot.create({
      data: {
        competitorId: acme.id,
        capturedAt: ago(2),
        changesSummary: {
          hasChanges: true,
          pricing: 'Cut subscriptions by 20%',
          news: [],
          skipped: [],
          model: 'x',
          capturedAt: ago(2).toISOString(),
        } as Prisma.InputJsonObject,
      },
    });
    await collectSignals(w4);
    const comp = await db.signal.findFirstOrThrow({
      where: { companyId: w4, source: 'COMPETITORS' },
    });
    const compEvidence: SignalInput = {
      kind: comp.kind,
      refId: comp.refId,
      label: comp.title,
      detail: comp.summary,
      signalId: comp.id,
    };
    const a = await opportunity(w4, 'Answer Acme’s discount', {
      type: 'COMPETITOR_MOVE',
      signals: [compEvidence, ...ext(1)],
    });
    const ga = await gen(w4, a.id);
    const b = await opportunity(w4, 'Subscription pricing is shifting', {
      signals: [compEvidence, ...ext(1)],
    });
    const gb = await gen(w4, b.id);
    const ra = await getRecommendation(w4, ga.recommendationId!);
    check(
      'the new one is flagged with the conflict and which goes first',
      gb.flags.some((f) =>
        /conflicts with “.*” \((both rest on the same evidence|both answer Acme Coffee).*: (do that one first|this one goes first)/.test(
          f,
        ),
      ),
      gb.flags.join('; '),
    );
    check(
      'the existing one is flagged too',
      Boolean(ra?.flags.some((f) => /conflicts with/.test(f))),
      ra?.flags.join('; '),
    );

    console.log('\nFrequency limits');
    const w5 = await workspace('e', ['LinkedIn', 'Instagram']);
    for (let i = 0; i < FREQUENCY_LIMITS.perChannelPerWeek; i++) {
      const o = await opportunity(
        w5,
        `LinkedIn topic number ${i} ${'x'.repeat(i)}`,
      );
      await createRecommendationFromOpportunity({
        companyId: w5,
        opportunityId: o.id,
        createdBy: 'verify',
        actorId: null,
        content: {
          channel: 'LinkedIn',
          title: `Distinct LinkedIn idea ${i} ${'q'.repeat(i + 3)}`,
        },
      });
    }
    const gCh = await gen(
      w5,
      (await opportunity(w5, 'One more LinkedIn idea')).id,
    );
    check(
      `no more than ${FREQUENCY_LIMITS.perChannelPerWeek} for one channel in a week`,
      gCh.status === 'rejected' &&
        gCh.reasons.some((r) => /for LinkedIn in the last 7 days/.test(r)),
      gCh.reasons.join('; '),
    );
    const already = await db.recommendation.count({ where: { companyId: w5 } });
    for (let i = already; i < FREQUENCY_LIMITS.perDay; i++) {
      const o = await opportunity(w5, `Instagram topic ${i} ${'y'.repeat(i)}`);
      await createRecommendationFromOpportunity({
        companyId: w5,
        opportunityId: o.id,
        createdBy: 'verify',
        actorId: null,
        content: {
          channel: 'Instagram',
          title: `Distinct Instagram idea ${i} ${'z'.repeat(i + 3)}`,
        },
      });
    }
    const gDay = await gen(w5, (await opportunity(w5, 'Yet another idea')).id);
    check(
      `no more than ${FREQUENCY_LIMITS.perDay} in a day`,
      gDay.status === 'rejected' &&
        gDay.reasons.some((r) => /last 24 hours/.test(r)),
      gDay.reasons.join('; '),
    );
    const audits = await db.auditLog.count({
      where: { companyId: w5, action: 'RECOMMENDATION_GENERATED' },
    });
    check('every refusal is in the audit log', audits === 2, String(audits));
  } finally {
    await db.company.deleteMany({ where: { id: { in: created } } });
    check(
      'cleanup: throwaway workspaces removed',
      (await db.company.count({ where: { id: { in: created } } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll guardrail checks passed.'
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
