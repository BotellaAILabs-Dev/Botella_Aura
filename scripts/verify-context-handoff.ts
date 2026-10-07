/**
 * Proves the Recommendation Context Handoff against a real database, on a
 * recommendation the real engine made:
 *
 *   · before it is accepted, the handoff is blocked and says why
 *   · once accepted, every part is there, each value traced to its source
 *     (the recommendation, its opportunity, the Business Context)
 *   · what the business has not recorded (website, brand voice) is listed as
 *     missing — never filled in — and adding it closes the gap
 *   · the payload validates; the Content Studio request it produces is
 *     Content Studio's own schema and carries the recommendation id
 *   · another workspace gets nothing
 *
 * Run: pnpm verify:context-handoff
 *
 * Everything lives in throwaway workspaces, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  CONTENT_BRIEF_LIMIT,
  handoffToContentRequest,
  validateContextHandoff,
} from '@/lib/recommendation-context-handoff';
import { generateContentSchema } from '@/lib/validations/content';
import { runDetection } from '@/server/opportunities/detection.service';
import { getContextHandoff } from '@/server/recommendations/context-handoff.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';
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
      name: 'zzverify handoff',
      slug: `zzverify-handoff-${stamp}`,
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
  const other = await db.company.create({
    data: {
      name: 'zzverify handoff other',
      slug: `zzverify-handoff-o-${stamp}`,
    },
  });
  const companyId = company.id;

  try {
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
    await db.marketingMemory.create({
      data: {
        companyId,
        insightType: 'CONTENT_FORMAT',
        insight:
          'LinkedIn posts with a question in the first line get more comments',
        confidence: 'HIGH',
        sampleSize: 30,
      },
    });
    await collectSignals(companyId);
    await runDetection(companyId);
    const opp = await db.opportunity.findFirstOrThrow({
      where: { companyId, detectedBy: 'rule:competitor-move' },
    });
    const g = await generateRecommendation({
      companyId,
      opportunityId: opp.id,
      actorId: null,
      templatesOnly: true,
    });
    const recId = g.recommendationId!;

    console.log('\nBefore it is accepted');
    const before = await getContextHandoff(companyId, recId);
    check(
      'the handoff is blocked, saying to accept it first',
      before?.readiness === 'blocked' &&
        before.blockedBy.includes(
          'It has not been accepted yet. Accept or edit it first.',
        ) &&
        handoffToContentRequest(before) === null,
      JSON.stringify(before?.blockedBy),
    );

    await decideRecommendation({
      companyId,
      recommendationId: recId,
      decision: 'ACCEPTED',
      actorId: null,
    });

    console.log('\nOnce accepted');
    const h = (await getContextHandoff(companyId, recId))!;
    const rec = await db.recommendation.findUniqueOrThrow({
      where: { id: recId },
      include: { evidence: true },
    });
    check(
      'it carries the recommendation and opportunity ids',
      h.recommendationId === recId && h.opportunityId === opp.id && h.accepted,
    );
    check(
      'business context comes from the Business Context',
      h.business.name === 'zzverify handoff' &&
        h.business.description ===
          'We roast single-origin coffee in small batches.',
      JSON.stringify(h.business),
    );
    check(
      'goal and audience, each traced to where it came from',
      h.goal?.value === 'Grow coffee subscriptions' &&
        h.goal.source === 'business_profile' &&
        h.audience?.value === rec.audience &&
        h.audience.source === 'recommendation',
      JSON.stringify([h.goal, h.audience]),
    );
    check(
      'channel, action, reason, evidence and expected outcome are the recommendation’s own',
      h.channel?.channel === rec.channel &&
        h.action.title === rec.title &&
        h.action.action === rec.action &&
        h.reason.why.length > 10 &&
        !/pieces? of evidence:/.test(h.reason.why) &&
        h.evidence.length === rec.evidence.length &&
        h.expectedOutcome.outcome === rec.expectedOutcome,
    );
    check(
      'relevant learned patterns are passed, with why they are relevant',
      h.memory.length === 1 &&
        h.memory[0]!.relevance === 'about LinkedIn, where this runs',
      JSON.stringify(h.memory),
    );
    check(
      'the CTA requirement comes from the content playbook',
      h.cta.expected && Boolean(h.cta.guidance),
      JSON.stringify(h.cta),
    );
    check(
      'what is not recorded is listed, not invented: no website, no brand voice',
      h.cta.destination === null &&
        h.brandVoice === null &&
        h.missing
          .map((m) => m.field)
          .sort()
          .join(',') === 'brandVoice,cta' &&
        h.readiness === 'ready_with_gaps',
      JSON.stringify(h.missing.map((m) => m.field)),
    );
    check(
      'the payload validates',
      validateContextHandoff(JSON.parse(JSON.stringify(h))).ok,
    );
    const req = handoffToContentRequest(h);
    check(
      'the Content Studio request is Content Studio’s own schema, carrying the recommendation id',
      req !== null &&
        generateContentSchema.safeParse(req).success &&
        req.recommendationId === recId &&
        req.source.brief!.length <= CONTENT_BRIEF_LIMIT &&
        req.source.brief!.includes('Not provided — do not invent') === false &&
        req.source.brief!.includes('CTA: name the next step, with no URL.'),
      req?.source.brief,
    );

    console.log('\nAdding what was missing closes the gap');
    await db.company.update({
      where: { id: companyId },
      data: {
        website: 'https://roastery.example',
        brandVoiceProfile: {
          toneDescriptors: ['warm', 'curious'],
          sentenceLength: 'short',
          vocabulary: [],
          commonPhrases: ['freshly roasted'],
          topicsToAvoid: ['price wars'],
          formatting: {
            emojiUsage: 'none',
            hashtagStyle: 'two at most',
            notes: '',
          },
          summary: 'Warm and curious, never salesy.',
        } as Prisma.InputJsonObject,
      },
    });
    const filled = (await getContextHandoff(companyId, recId))!;
    check(
      'with a website and a brand voice: nothing missing, ready',
      filled.readiness === 'ready' &&
        filled.missing.length === 0 &&
        filled.cta.destination?.value === 'https://roastery.example' &&
        filled.brandVoice?.avoid.includes('price wars') === true,
      JSON.stringify([filled.readiness, filled.missing, filled.brandVoice]),
    );
    check(
      'and the brief now sends people to the business’s own site',
      handoffToContentRequest(filled)!.source.brief!.includes(
        'CTA: send people to https://roastery.example.',
      ),
    );

    console.log('\nNot shared across businesses');
    check(
      'another workspace gets nothing',
      (await getContextHandoff(other.id, recId)) === null,
    );
  } finally {
    await db.company.delete({ where: { id: companyId } });
    await db.company.delete({ where: { id: other.id } });
    check(
      'cleanup: throwaway workspaces removed',
      (await db.recommendation.count({ where: { companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll context handoff checks passed.'
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
