/**
 * Content Studio, end to end with the REAL AI writer.
 *
 * Creates a throwaway alcohol brand with a full business profile, then
 * generates and rewrites real copy through the production code path
 * (server/content/generator.ts) and checks what came back: written for the
 * platform, within its limits, multiple distinct versions, hook/copy/CTA
 * present, quality and alcohol-compliance checks applied, one-click rewrites
 * and undo working, and approval refused while a compliance problem remains.
 * Prints the copy so a person can judge whether it reads like a human wrote it.
 *
 * Run: pnpm verify:content-studio   (needs GEMINI_API_KEY or ANTHROPIC_API_KEY)
 *
 * The throwaway workspace is deleted at the end, including on failure.
 */
import type { ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import { copyParts, type QualityReport } from '@/lib/content-quality';
import { playbookFor } from '@/lib/content-playbook';
import { aiFailureMessage, isClaudeConfigured, isQuotaExhausted, getModel } from '@/server/ai/claude';
import { transition, updateDraftBody } from '@/server/content/content.service';
import {
  generateDraft,
  refineDraft,
  switchVariation,
  undoDraft,
} from '@/server/content/generator';
import { renderForManual } from '@/server/content/render';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const meta = (d: ContentDraft) =>
  (d.aiMetadata ?? {}) as {
    quality?: QualityReport;
    variations?: { angle: string; body: unknown; quality: QualityReport }[];
    history?: unknown[];
    writtenFor?: string;
  };
const show = (label: string, d: ContentDraft) => {
  console.log(`\n  ┌─ ${label}`);
  for (const line of renderForManual(d).split('\n')) console.log(`  │ ${line}`);
  const q = meta(d).quality;
  if (q) {
    console.log(
      `  └─ quality: ${q.approvable ? 'approvable' : 'BLOCKED'}; ${q.issues.map((i) => `[${i.severity}] ${i.message}`).join(' | ') || 'no issues'}${q.fixes.length ? `; fixes: ${q.fixes.join(' ')}` : ''}`,
    );
  }
};

async function main() {
  if (!isClaudeConfigured()) {
    console.log(
      'No AI provider configured (GEMINI_API_KEY / ANTHROPIC_API_KEY). Nothing to verify.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`AI writer: ${getModel('premium')}`);

  const user = await db.user.findFirstOrThrow({
    where: { email: 'demo@botella.ai' },
  });
  const company = await db.company.create({
    data: {
      name: 'Hollow Creek Distilling',
      slug: `zzverify-studio-${Date.now()}`,
      industry: 'Bourbon distillery',
      website: '',
      brandVoiceNotes:
        'Warm, unpretentious, proud of the craft. Talk like the people who make it — no hype, no luxury clichés.',
      preferences: {
        business: {
          description:
            'A small family-run Kentucky distillery making small-batch bourbon aged 6 years in charred oak. Tasting room in Bardstown, open Thursday to Sunday.',
          offerings:
            'Hollow Creek Small Batch Bourbon (90 proof), distillery tours, tasting flights',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience:
            'Adults 25-55 who enjoy whiskey and weekend trips to Kentucky bourbon country',
          channels: ['Instagram', 'LinkedIn'],
          goals: 'Book more tasting-room visits this autumn',
        },
      },
    },
  });
  await db.companyMember.create({
    data: { userId: user.id, companyId: company.id, role: 'OWNER' },
  });
  const companyId = company.id;

  try {
    console.log('\nInstagram post, 3 versions');
    const ig = await generateDraft({
      companyId,
      userId: user.id,
      type: 'IMAGE_POST',
      source: {
        kind: 'BRIEF',
        brief:
          'Autumn tasting-room weekends: invite people to visit the distillery.',
      },
      platform: 'INSTAGRAM',
      variations: 3,
    });
    const igMeta = meta(ig);
    check(
      'written for Instagram, stored as its platform',
      ig.platform === 'INSTAGRAM' && igMeta.writtenFor === 'INSTAGRAM',
    );
    check(
      'three versions',
      igMeta.variations?.length === 3,
      String(igMeta.variations?.length),
    );
    const firsts = (igMeta.variations ?? []).map(
      (v) => copyParts('IMAGE_POST', v.body).text.split(/\n|[.!?]/)[0],
    );
    check(
      'the versions open differently',
      new Set(firsts).size === firsts.length,
      firsts.join(' | '),
    );
    const parts = copyParts('IMAGE_POST', ig.body);
    check(
      'has a caption, a CTA and hashtags',
      parts.text.length > 40 &&
        parts.cta.length > 3 &&
        parts.hashtags.length > 0,
    );
    check(
      'within Instagram’s limits',
      parts.longestUnit <= 2200 &&
        parts.hashtags.length <=
          playbookFor('IMAGE_POST', 'INSTAGRAM').limits.hashtagMax,
    );
    check(
      'alcohol rules applied, with a responsible-drinking line',
      Boolean(igMeta.quality?.alcohol) && /responsibl/i.test(parts.text),
    );
    for (const [i, v] of (igMeta.variations ?? []).entries()) {
      show(`Version ${i + 1} — ${v.angle}`, {
        ...ig,
        body: v.body as object,
        aiMetadata: { quality: v.quality },
      } as unknown as ContentDraft);
    }

    console.log('\nSwitching version, rewriting, undo');
    const switched = await switchVariation({
      draft: ig,
      userId: user.id,
      index: 2,
    });
    check(
      'switch to version 3',
      JSON.stringify(switched.body) ===
        JSON.stringify(igMeta.variations?.[2]?.body),
    );
    const short = await refineDraft({
      draft: switched,
      userId: user.id,
      action: 'shorten',
    });
    check(
      'Shorten makes it shorter',
      copyParts('IMAGE_POST', short.body).text.length <
        copyParts('IMAGE_POST', switched.body).text.length,
    );
    show('Shortened', short);
    const toned = await refineDraft({
      draft: short,
      userId: user.id,
      action: 'tone',
      tone: 'playful',
    });
    show('Tone: playful', toned);
    check(
      'history keeps every step for undo',
      (meta(toned).history?.length ?? 0) === 3,
    );
    const undone = await undoDraft({ draft: toned, userId: user.id });
    check(
      'Undo restores the previous version',
      JSON.stringify(undone.body) === JSON.stringify(short.body),
    );

    console.log('\nFacebook ad');
    const ad = await generateDraft({
      companyId,
      userId: user.id,
      type: 'AD',
      source: {
        kind: 'BRIEF',
        brief: 'Promote distillery tours this October.',
      },
      platform: 'FACEBOOK',
    });
    const adBody = ad.body as {
      headline: string;
      primaryText: string;
      cta: string;
    };
    check(
      'ad fields within ad-manager limits',
      adBody.headline.length <= 80 &&
        adBody.primaryText.length <= 1000 &&
        adBody.cta.length <= 40,
    );
    show('Facebook ad', ad);

    console.log('\nEmail');
    const email = await generateDraft({
      companyId,
      userId: user.id,
      type: 'EMAIL',
      source: {
        kind: 'BRIEF',
        brief:
          'Newsletter: the new autumn bottling is ready, reserve a bottle.',
      },
    });
    const emailBody = email.body as { subjectLine: string; cta: string };
    check(
      'email has a subject and a CTA, no platform',
      emailBody.subjectLine.length > 0 &&
        emailBody.cta.length > 0 &&
        email.platform === null,
    );
    show('Email', email);

    console.log('\nX thread');
    const thread = await generateDraft({
      companyId,
      userId: user.id,
      type: 'TWEET_THREAD',
      source: {
        kind: 'BRIEF',
        brief: 'What six years in a charred oak barrel does to bourbon.',
      },
      platform: 'X',
    });
    const tweets = (thread.body as { tweets: string[] }).tweets;
    check(
      'every post within 280 characters',
      tweets.every((t) => t.length <= 280),
      tweets.map((t) => t.length).join(','),
    );
    show('X thread', thread);

    console.log('\nCompliance gate');
    const bad = await updateDraftBody({
      companyId,
      userId: user.id,
      draftId: ig.id,
      body: {
        caption: 'Grab a bottle and get wasted this weekend!',
        cta: 'Visit us.',
        hashtags: ['bourbon'],
        altText: '',
      },
    });
    const badQ = meta(bad).quality;
    check(
      'a non-compliant edit is caught',
      badQ?.approvable === false &&
        Boolean(badQ.issues.some((i) => i.code === 'alcohol-excess')),
    );
    /**
     * Non-compliant copy must not reach a human approver, and must not be
     * approved. There are two gates in front of it — submission runs a fresh
     * review (content.service.ts), and approval runs the compliance check —
     * and which one speaks first depends on what the reviewer makes of the
     * copy. This asserted that the second gate held while assuming the first
     * would let the draft past, so a reviewer doing its job failed the script.
     * Refusal at either gate is the behaviour being checked.
     */
    let refused = '';
    let refusedAt = '';
    try {
      await transition({
        companyId,
        userId: user.id,
        draftId: ig.id,
        to: 'PENDING_APPROVAL',
      });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
      refusedAt = 'submission';
    }
    if (!refused) {
      try {
        await transition({
          companyId,
          userId: user.id,
          draftId: ig.id,
          to: 'APPROVED',
        });
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
        refusedAt = 'approval';
      }
    }
    check(
      'non-compliant copy cannot move on, and is told why',
      /Fix (?:it|before)/.test(refused),
      `refused at ${refusedAt || 'neither gate'}: ${refused.slice(0, 160)}`,
    );
    const fixed = await refineDraft({
      draft: await db.contentDraft.findUniqueOrThrow({ where: { id: ig.id } }),
      userId: user.id,
      action: 'improve',
    });
    check(
      '“Improve” fixes it',
      meta(fixed).quality?.approvable === true,
      JSON.stringify(meta(fixed).quality?.issues),
    );
    show('After Improve', fixed);
  } finally {
    await db.company.delete({ where: { id: companyId } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.company.count({ where: { id: companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll Content Studio checks passed.'
      : `\n${failures} check(s) BROKEN.`,
  );
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    // The AI provider refused (quota, key, outage): the checks did not run.
    // Said plainly — and still a failure exit, never a pass.
    if (aiFailureMessage(err)) {
      const e = err as { status?: number; quotaId?: string | null; retryAfterMs?: number | null; message?: string };
      console.log(
        `
BLOCKED (external): the AI provider refused — ${e.message ?? 'no answer'}.` +
          (isQuotaExhausted(err) && e.retryAfterMs ? ` Re-run in about ${Math.ceil(e.retryAfterMs / 60_000)} min.` : '') +
          `
${failures} check(s) BROKEN; the remaining live-generation checks were not run.`,
      );
      process.exitCode = 2;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
