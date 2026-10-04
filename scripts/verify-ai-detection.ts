/**
 * Proves AI-assisted opportunity detection against a real database.
 *
 * The model is replaced by scripted responses (valid, partly invalid, broken
 * and failing), so every validation and fallback path runs end to end:
 * snapshot + signals in → validation → stored opportunity / flagged rejection.
 *
 * Run: pnpm verify:ai-detection
 *
 * The throwaway workspace is deleted at the end, including on failure.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { runAiDetection } from '@/server/opportunities/ai-detection.service';
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

/** The reference the prompt gave the signal whose title contains `text`. */
function refFor(prompt: string, text: string): string {
  const line = prompt
    .split('\n')
    .find((l) => /^\[S\d+\]/.test(l) && l.includes(text));
  return line ? line.slice(1, line.indexOf(']')) : 'S999';
}

async function main() {
  const company = await db.company.create({
    data: {
      name: 'zzverify ai detection',
      slug: `zzverify-ai-${Date.now()}`,
      industry: 'Coffee',
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
      },
    },
  });

  try {
    const competitor = await db.competitorProfile.create({
      data: { companyId: company.id, name: 'Acme Coffee' },
    });
    for (const [days, pricing] of [
      [3, 'Cut subscriptions by 20% and launched a brewing-guide series'],
      [10, 'Bundled a free pour-over guide with every subscription'],
    ] as const) {
      await db.competitorSnapshot.create({
        data: {
          competitorId: competitor.id,
          capturedAt: ago(days),
          changesSummary: {
            hasChanges: true,
            pricing,
            news: [],
            skipped: [],
            model: 'x',
            capturedAt: ago(days).toISOString(),
          } as Prisma.InputJsonObject,
        },
      });
    }
    await collectSignals(company.id);
    const signalsBefore = await db.signal.findMany({
      where: { companyId: company.id },
      orderBy: { id: 'asc' },
    });

    const valid = (prompt: string) => ({
      type: 'CONTENT_GAP',
      title: 'Own the brewing-guide conversation',
      summary:
        'Acme keeps pairing its subscription with brewing guides; brewing is a topic you have not covered.',
      reasoning:
        'Two separate Acme changes push brewing education, a sustained theme rather than a one-off.',
      evidence: [
        {
          signal: refFor(prompt, 'brewing-guide series'),
          supports: 'Acme launched a brewing-guide series.',
        },
        {
          signal: refFor(prompt, 'pour-over guide'),
          supports: 'Acme bundles a pour-over guide.',
        },
      ],
      businessFacts: ['identity.description'],
      assumptions: [],
      confidence: 'HIGH',
      confidenceReason: 'Two direct observations of the same competitor.',
      impact: 'medium',
      effort: 'low',
    });

    console.log(
      '\nValid output is stored; invalid output is rejected and flagged',
    );
    const first = await runAiDetection(company.id, {
      model: 'scripted',
      complete: async ({ prompt }) => ({
        opportunities: [
          valid(prompt),
          // Invents a figure and a business fact the context does not hold.
          {
            ...valid(prompt),
            type: 'AUDIENCE_SEGMENT',
            title: 'Target office managers',
            summary: 'Office managers are 40% of your buyers.',
            businessFacts: ['audience.officeManagers'],
          },
          // Cites a signal it was never given.
          {
            ...valid(prompt),
            type: 'COMPETITIVE_GAP',
            title: 'Answer the latte-art trend',
            evidence: [{ signal: 'S77', supports: 'Latte art is everywhere.' }],
          },
          // Not structured: no confidence.
          { title: 'Something vague', summary: 'Do more marketing.' },
        ],
      }),
    });
    check(
      'run reported as partial',
      first?.status === 'partial',
      first?.status,
    );
    check('one opportunity stored', first?.outcomes.length === 1);
    check('three rejected', first?.rejected.length === 3);
    const codes =
      first?.rejected.flatMap((r) => r.reasons.map((x) => x.code)) ?? [];
    check(
      '…for an invented figure and an unknown business fact',
      codes.includes('unsupported-number') &&
        codes.includes('unknown-business-fact'),
      codes.join(', '),
    );
    check(
      '…for citing a signal it was not given',
      codes.includes('unknown-signal'),
    );
    check(
      '…for unstructured output without confidence',
      codes.includes('invalid-shape'),
    );

    const stored = await db.opportunity.findMany({
      where: { companyId: company.id },
      include: { signals: true },
    });
    const opp = stored[0];
    check('only the valid opportunity exists', stored.length === 1);
    check('stored as AI_DETECTION', opp?.source === 'AI_DETECTION');
    check(
      'references its supporting signals',
      opp?.signals.length === 2 &&
        opp.signals.every((s) =>
          signalsBefore.some((b) => b.id === s.signalId),
        ),
    );
    const ai = (opp?.details as { ai?: Record<string, unknown> } | null)?.ai;
    check(
      'confidence captured: the model’s claim and the stored value',
      Boolean(ai?.confidence) &&
        Boolean(opp?.confidence && opp.confidenceReason),
      JSON.stringify(ai?.confidence),
    );
    check(
      'snapshot fingerprint recorded',
      Boolean(opp?.contextFingerprint) &&
        ai?.snapshotFingerprint === opp?.contextFingerprint,
    );
    const audit = await db.auditLog.findFirst({
      where: { companyId: company.id, action: 'OPPORTUNITY_AI_DETECTION_RUN' },
      orderBy: { createdAt: 'desc' },
    });
    const meta = audit?.metadata as { status?: string; rejected?: unknown[] };
    check(
      'rejections flagged in the audit log',
      meta?.status === 'partial' && meta.rejected?.length === 3,
    );
    const signalsAfter = await db.signal.findMany({
      where: { companyId: company.id },
      orderBy: { id: 'asc' },
    });
    check(
      'source signals untouched (stored separately)',
      JSON.stringify(signalsAfter) === JSON.stringify(signalsBefore),
    );

    console.log('\nRunning again does not duplicate');
    const again = await runAiDetection(company.id, {
      model: 'scripted',
      complete: async ({ prompt }) => ({
        opportunities: [{ ...valid(prompt), title: 'Lead on brewing guides' }],
      }),
    });
    check(
      'same evidence, reworded title → merged into the existing one',
      again?.outcomes[0]?.opportunityId === opp?.id,
      JSON.stringify(again?.outcomes),
    );
    check(
      'still one opportunity',
      (await db.opportunity.count({ where: { companyId: company.id } })) === 1,
    );

    console.log('\nFallback when AI output is unusable');
    const before = await db.opportunity.count({
      where: { companyId: company.id },
    });
    const broken = await runAiDetection(company.id, {
      model: 'scripted',
      complete: async () => ({ ideas: 'write more posts' }),
    });
    check('wrong shape → failed', broken?.status === 'failed', broken?.reason);
    const thrown = await runAiDetection(company.id, {
      model: 'scripted',
      complete: async () => {
        throw new Error('provider timeout');
      },
    });
    check(
      'provider error → failed, with the reason',
      thrown?.status === 'failed' &&
        /provider timeout/.test(thrown.reason ?? ''),
    );
    const allBad = await runAiDetection(company.id, {
      model: 'scripted',
      complete: async ({ prompt }) => ({
        opportunities: [{ ...valid(prompt), type: 'TRENDING_TOPIC' }],
      }),
    });
    check(
      'every opportunity invalid → rejected',
      allBad?.status === 'rejected',
    );
    check(
      'nothing stored by any failed run',
      (await db.opportunity.count({ where: { companyId: company.id } })) ===
        before,
    );

    console.log('\nToo little to interpret');
    const empty = await db.company.create({
      data: { name: 'zzverify ai empty', slug: `zzverify-ai-e-${Date.now()}` },
    });
    try {
      let called = false;
      const skipped = await runAiDetection(empty.id, {
        model: 'scripted',
        complete: async () => {
          called = true;
          return { opportunities: [] };
        },
      });
      check(
        'no signals → skipped without calling the model',
        skipped?.status === 'skipped' && !called,
      );
    } finally {
      await db.company.delete({ where: { id: empty.id } });
    }
  } finally {
    await db.company.delete({ where: { id: company.id } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.opportunity.count({ where: { companyId: company.id } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll AI detection checks passed.'
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
