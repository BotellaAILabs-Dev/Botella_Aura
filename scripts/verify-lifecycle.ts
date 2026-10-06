/**
 * Proves the Recommendation Lifecycle against a real database.
 *
 *   Generated → Presented → Accepted / Edited / Skipped / Rejected → Completed
 *
 * Checks the acceptance criteria directly: every user action is persisted with
 * its timestamp, who did it and its detail; history is retained (never
 * rewritten); accepted, edited, skipped and rejected recommendations are told
 * apart; and transitions are predictable and auditable — repeats and stale or
 * simultaneous actions never create a second transition.
 *
 * Run: pnpm verify:lifecycle
 *
 * Everything lives in a throwaway workspace, deleted at the end.
 */
import { db } from '@/lib/db';
import {
  recordOpportunity,
  transitionOpportunity,
} from '@/server/opportunities/opportunity.service';
import {
  createRecommendationFromOpportunity,
  decideRecommendation,
  editRecommendation,
  expireRecommendations,
  getRecommendationHistory,
  presentRecommendations,
  transitionRecommendation,
} from '@/server/recommendations/recommendation.service';

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

async function main() {
  const stamp = Date.now();
  const company = await db.company.create({
    data: {
      name: 'zzverify lifecycle',
      slug: `zzverify-lifecycle-${stamp}`,
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
  const user = await db.user.create({
    data: { email: `zzverify-lifecycle-${stamp}@example.com`, name: 'Dana' },
  });

  try {
    let n = 0;
    /** A fresh opportunity with its (generated) recommendation. */
    const fresh = async () => {
      n += 1;
      const { opportunity } = await recordOpportunity(company.id, {
        type: 'COMPETITOR_MOVE',
        title: `Answer Acme’s discount (${n})`,
        summary: 'Acme cut its subscription price.',
        rationale: 'A pricing change buyers comparing options will notice.',
        angle: 'Lead with freshness, not price.',
        source: 'COMPETITORS',
        detectedBy: 'rule:competitor-move',
        signals: [
          {
            kind: 'EXTERNAL',
            refId: `zz-${stamp}-${n}`,
            label: 'Acme cut subscriptions by 20%',
            detail: 'Seen on their pricing page.',
          },
        ],
        impact: 'high',
        effort: 'low',
        dedupeKey: `zz:lifecycle:${n}`,
        contextFields: ['audience.stated'],
      });
      const rec = await createRecommendationFromOpportunity({
        companyId: company.id,
        opportunityId: opportunity.id,
        createdBy: 'engine',
        actorId: null,
      });
      return { opp: opportunity, rec };
    };
    const events = (id: string) =>
      db.recommendationEvent.findMany({
        where: { recommendationId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    const oppStatus = async (id: string) =>
      (await db.opportunity.findUniqueOrThrow({ where: { id } })).status;
    const opts = { companyId: company.id, actorId: user.id };

    // ------------------------------------------------------------------ Generated
    console.log('\nGenerated');
    const a = await fresh();
    const [gen] = await events(a.rec.id);
    check(
      'a new recommendation starts GENERATED',
      a.rec.status === 'GENERATED',
    );
    check(
      'its creation is the first history entry: generate, by the engine',
      gen?.action === 'generate' &&
        gen.source === 'engine' &&
        gen.fromStatus === null &&
        gen.toStatus === 'GENERATED',
      JSON.stringify(gen),
    );

    // ------------------------------------------------------------------ Presented
    console.log('\nPresented');
    const shown = await presentRecommendations({
      ...opts,
      recommendationIds: [a.rec.id],
      surface: 'dashboard',
      positions: { [a.rec.id]: { rank: 1, score: 72.5, band: 'now' } },
    });
    const aShown = await db.recommendation.findUniqueOrThrow({
      where: { id: a.rec.id },
    });
    const present = (await events(a.rec.id)).at(-1);
    check(
      'showing it marks it PRESENTED with the time',
      shown.presented.includes(a.rec.id) &&
        aShown.status === 'PRESENTED' &&
        aShown.presentedAt instanceof Date,
    );
    check(
      'the presentation records who saw it, where, and at what rank',
      present?.action === 'present' &&
        present.source === 'user' &&
        present.actorId === user.id &&
        (present.metadata as { surface?: string; rank?: number }).surface ===
          'dashboard' &&
        (present.metadata as { rank?: number }).rank === 1,
      JSON.stringify(present?.metadata),
    );
    const again = await presentRecommendations({
      ...opts,
      recommendationIds: [a.rec.id, a.rec.id],
    });
    check(
      'showing it again records nothing new (idempotent)',
      again.presented.length === 0 &&
        again.alreadyPresented.includes(a.rec.id) &&
        (await events(a.rec.id)).length === 2,
    );
    check(
      'presenting leaves the opportunity open',
      (await oppStatus(a.opp.id)) === 'RECOMMENDED',
    );

    // ------------------------------------------------------------------ Accepted
    console.log('\nAccepted');
    const accepted = await decideRecommendation({
      ...opts,
      recommendationId: a.rec.id,
      decision: 'ACCEPTED',
      note: 'Good timing.',
      expectedStatus: 'PRESENTED',
    });
    const acc = (await events(a.rec.id)).at(-1);
    check(
      'accepting persists who, when and why',
      accepted.changed &&
        accepted.status === 'ACCEPTED' &&
        accepted.decidedById === user.id &&
        accepted.decidedAt instanceof Date &&
        accepted.decisionNote === 'Good timing.',
    );
    check(
      'and is recorded: accept, presented → accepted, by the person',
      acc?.action === 'accept' &&
        acc.fromStatus === 'PRESENTED' &&
        acc.toStatus === 'ACCEPTED' &&
        acc.actorId === user.id &&
        acc.note === 'Good timing.',
    );
    check(
      'its opportunity is accepted with it',
      (await oppStatus(a.opp.id)) === 'ACCEPTED',
    );

    console.log('\nDuplicate transitions are prevented');
    const repeat = await decideRecommendation({
      ...opts,
      recommendationId: a.rec.id,
      decision: 'ACCEPTED',
    });
    check(
      'accepting twice (a double click) is a no-op — no second history entry',
      repeat.changed === false && (await events(a.rec.id)).length === 3,
    );
    const reversed = await expectError(() =>
      decideRecommendation({
        ...opts,
        recommendationId: a.rec.id,
        decision: 'REJECTED',
      }),
    );
    check(
      'a decision is not silently reversed (accepted → rejected refused)',
      /cannot be marked rejected/.test(reversed),
      reversed,
    );
    const b = await fresh();
    const stale = await expectError(() =>
      decideRecommendation({
        ...opts,
        recommendationId: b.rec.id,
        decision: 'REJECTED',
        expectedStatus: 'PRESENTED',
      }),
    );
    check(
      'an action taken on a stale screen is refused, not applied',
      /changed since you opened it/.test(stale) &&
        (await db.recommendation.findUniqueOrThrow({ where: { id: b.rec.id } }))
          .status === 'GENERATED',
      stale,
    );
    const race = await Promise.allSettled([
      decideRecommendation({
        ...opts,
        recommendationId: b.rec.id,
        decision: 'ACCEPTED',
      }),
      decideRecommendation({
        ...opts,
        recommendationId: b.rec.id,
        decision: 'ACCEPTED',
      }),
      decideRecommendation({
        ...opts,
        recommendationId: b.rec.id,
        decision: 'REJECTED',
      }),
    ]);
    const bEvents = await events(b.rec.id);
    const decisions = bEvents.filter((e) =>
      ['accept', 'reject'].includes(e.action),
    );
    const bOpp = await oppStatus(b.opp.id);
    check(
      'simultaneous decisions: exactly one wins and is recorded once',
      decisions.length === 1 &&
        race.some((r) => r.status === 'fulfilled') &&
        bOpp ===
          (decisions[0]!.toStatus === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED'),
      `${decisions.map((e) => e.action).join(',')} / opportunity ${bOpp}`,
    );

    // ------------------------------------------------------------------ Edited
    console.log('\nEdited');
    const c = await fresh();
    await presentRecommendations({ ...opts, recommendationIds: [c.rec.id] });
    const original = await db.recommendation.findUniqueOrThrow({
      where: { id: c.rec.id },
    });
    const edited = await editRecommendation({
      ...opts,
      recommendationId: c.rec.id,
      changes: {
        title: 'Answer Acme on freshness, not price',
        steps: ['Draft the post', 'Add a roast-date photo', 'Publish Friday'],
      },
      note: 'Sharper angle.',
      expectedStatus: 'PRESENTED',
    });
    const edit = (await events(c.rec.id)).at(-1);
    const changes = (
      edit?.metadata as {
        changes?: Record<string, { from: unknown; to: unknown }>;
      }
    )?.changes;
    check(
      'editing saves the changes and marks it EDITED, with the time and who',
      edited.changed &&
        edited.status === 'EDITED' &&
        edited.title === 'Answer Acme on freshness, not price' &&
        edited.editedAt instanceof Date &&
        edited.decidedById === user.id,
    );
    check(
      'the history keeps every changed field from → to (the original is not lost)',
      edit?.action === 'edit' &&
        changes?.title?.from === original.title &&
        changes?.title?.to === 'Answer Acme on freshness, not price' &&
        JSON.stringify(changes?.steps?.from) ===
          JSON.stringify(original.steps) &&
        Object.keys(changes ?? {}).length === 2,
      JSON.stringify(changes),
    );
    check(
      'an edit is a yes: its opportunity is accepted',
      (await oppStatus(c.opp.id)) === 'ACCEPTED',
    );
    const before = (await events(c.rec.id)).length;
    const noop = await editRecommendation({
      ...opts,
      recommendationId: c.rec.id,
      changes: { title: 'Answer Acme on freshness, not price' },
    });
    check(
      'an edit that changes nothing records nothing',
      noop.changed === false && (await events(c.rec.id)).length === before,
    );
    await editRecommendation({
      ...opts,
      recommendationId: c.rec.id,
      changes: { summary: 'Acme went cheap; we stay fresh.' },
    });
    const cEvents = await events(c.rec.id);
    check(
      'a second edit is a second entry — both kept',
      cEvents.filter((e) => e.action === 'edit').length === 2 &&
        cEvents.at(-1)!.fromStatus === 'EDITED',
    );
    const invalid = await expectError(() =>
      editRecommendation({
        ...opts,
        recommendationId: c.rec.id,
        changes: { title: '' },
      }),
    );
    check(
      'an edit that would make it invalid is refused',
      invalid !== '' && (await events(c.rec.id)).length === cEvents.length,
    );
    const offChannel = await editRecommendation({
      ...opts,
      recommendationId: c.rec.id,
      changes: { channel: 'LinkedIn' },
    });
    check(
      'guardrails still apply: moving it to a channel the business does not use blocks execution',
      !offChannel.executable && offChannel.blockers.length > 0,
      offChannel.blockers.join(' '),
    );

    // ------------------------------------------------------------------ Skipped
    console.log('\nSkipped');
    const d = await fresh();
    await presentRecommendations({ ...opts, recommendationIds: [d.rec.id] });
    const skipped = await decideRecommendation({
      ...opts,
      recommendationId: d.rec.id,
      decision: 'SKIPPED',
      note: 'Not this week.',
    });
    check(
      'skipping persists who and when',
      skipped.status === 'SKIPPED' &&
        skipped.decidedById === user.id &&
        skipped.decidedAt instanceof Date &&
        (await events(d.rec.id)).at(-1)?.action === 'skip',
    );
    check(
      'a skip is not a "no": its opportunity stays open',
      (await oppStatus(d.opp.id)) === 'RECOMMENDED',
    );
    const lateAccept = await expectError(() =>
      decideRecommendation({
        ...opts,
        recommendationId: d.rec.id,
        decision: 'ACCEPTED',
      }),
    );
    check('a skipped recommendation is final', lateAccept !== '');

    // ------------------------------------------------------------------ Rejected
    console.log('\nRejected');
    const e = await fresh();
    const rejected = await decideRecommendation({
      ...opts,
      recommendationId: e.rec.id,
      decision: 'REJECTED',
      note: 'Off brand.',
    });
    check(
      'rejecting persists who, when and why',
      rejected.status === 'REJECTED' &&
        rejected.decidedById === user.id &&
        rejected.decisionNote === 'Off brand.' &&
        (await events(e.rec.id)).at(-1)?.action === 'reject',
    );
    check(
      'its opportunity is rejected with it',
      (await oppStatus(e.opp.id)) === 'REJECTED',
    );

    // ------------------------------------------------------------------ Completed
    console.log('\nCompleted');
    const done = await transitionRecommendation({
      ...opts,
      recommendationId: a.rec.id,
      to: 'COMPLETED',
    });
    check(
      'an accepted recommendation can be completed, with the time',
      done.status === 'COMPLETED' && done.completedAt instanceof Date,
    );
    const cantFinish = await expectError(() =>
      transitionRecommendation({
        ...opts,
        recommendationId: c.rec.id,
        to: 'COMPLETED',
      }),
    );
    check(
      'a blocked one cannot be completed until the blocker is resolved',
      /cannot be acted on yet/.test(cantFinish),
      cantFinish,
    );

    // ------------------------------------------------------------------ Opportunity + system
    console.log('\nDecisions from elsewhere are recorded too');
    const f = await fresh();
    await presentRecommendations({ ...opts, recommendationIds: [f.rec.id] });
    await transitionOpportunity({
      companyId: company.id,
      opportunityId: f.opp.id,
      to: 'ACCEPTED',
      actorId: user.id,
    });
    const viaOpp = (await events(f.rec.id)).at(-1);
    check(
      'accepting the opportunity accepts its presented recommendation, marked as coming from the opportunity',
      viaOpp?.action === 'accept' &&
        viaOpp.source === 'opportunity' &&
        viaOpp.fromStatus === 'PRESENTED',
      JSON.stringify(viaOpp),
    );
    const g = await fresh();
    await presentRecommendations({ ...opts, recommendationIds: [g.rec.id] });
    await db.recommendation.update({
      where: { id: g.rec.id },
      data: { relevantUntil: new Date(Date.now() - DAY) },
    });
    await expireRecommendations(company.id);
    const exp = (await events(g.rec.id)).at(-1);
    check(
      'a presented one left undecided past its window expires, by the system',
      exp?.action === 'expire' &&
        exp.source === 'system' &&
        exp.actorId === null,
    );

    // ------------------------------------------------------------------ History
    console.log('\nHistory is retained, and outcomes told apart');
    const outcomes = await Promise.all(
      [a, c, d, e, g].map(
        async (x) =>
          (await getRecommendationHistory(company.id, x.rec.id))!.outcome,
      ),
    );
    check(
      'accepted, edited, skipped, rejected (and expired) are distinguished',
      outcomes.join(',') === 'accepted,edited,skipped,rejected,expired',
      outcomes.join(','),
    );
    const hist = (await getRecommendationHistory(company.id, a.rec.id))!;
    check(
      'the full path is kept in order: generate → present → accept → complete',
      hist.events.map((x) => x.action).join(' → ') ===
        'generate → present → accept → complete',
      hist.events.map((x) => x.action).join(' → '),
    );
    check(
      'each entry names who did it',
      hist.events.slice(1).every((x) => x.actorName === 'Dana') &&
        hist.events[0]!.actorName === null,
    );
    check(
      'every timestamp is stored',
      Boolean(
        hist.timestamps.createdAt &&
        hist.timestamps.presentedAt &&
        hist.timestamps.decidedAt &&
        hist.timestamps.completedAt,
      ),
    );
    check(
      'history is not shared across businesses',
      (await getRecommendationHistory('not-this-company', a.rec.id)) === null,
    );
    const total = await db.recommendationEvent.count({
      where: { recommendation: { companyId: company.id } },
    });
    // a 4 (generate present accept complete) · b 2 (generate + the one
    // winning decision) · c 5 (generate present edit edit edit) · d 3 · e 2 ·
    // f 3 · g 3. Repeats, no-op edits, stale and losing actions add nothing.
    check(
      'every action is its own entry, and no repeat added one: exactly 22',
      total === 22,
      `${total} entries`,
    );
  } finally {
    await db.company.delete({ where: { id: company.id } });
    await db.user.delete({ where: { id: user.id } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.recommendation.count({ where: { companyId: company.id } })) ===
        0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll lifecycle checks passed.'
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
