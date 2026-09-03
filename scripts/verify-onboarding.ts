/**
 * Proves the onboarding sequence works against a real database.
 *
 * The unit tests cover the rules in isolation; this checks the thing that
 * actually matters end to end — that saving something on a settings page flips
 * the right checklist step, that the step order produces exactly one "do this
 * next", and that what the user typed genuinely reaches the content and image
 * prompts rather than sitting in a JSON column nobody reads.
 *
 * Run: pnpm verify:onboarding
 *
 * It writes to the first company it finds and RESTORES the original
 * preferences bag at the end, including on failure.
 */
import { db } from '@/lib/db';
import { getOnboardingState } from '@/server/onboarding/checklist.service';
import {
  readBrandAssets,
  readMarketingProfile,
  saveBrandAssets,
  saveMarketingProfile,
} from '@/server/company/profile.service';
import { getAudienceProfile, audienceToPrompt } from '@/server/content/audience';
import { brandAssetsSchema, marketingProfileSchema } from '@/lib/validations/profile';
import { storeCompanyLogo } from '@/server/company/logo.service';

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok      ${label}`);
  } else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const company = await db.company.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!company) {
    console.log('No company in the database — seed one first (pnpm db:seed).');
    process.exit(1);
  }
  console.log(`\nWorkspace: ${company.name} (${company.id})\n`);

  const originalPreferences = company.preferences;

  try {
    // ---- The checklist reflects reality, not a stored flag -----------------
    const before = await getOnboardingState(company.id);
    console.log('Initial state:');
    for (const step of before.steps) {
      const mark = step.done ? '✓' : step.current ? '→' : ' ';
      console.log(
        `  ${mark} ${step.title}${step.detail ? ` (${step.detail})` : ''}`,
      );
    }
    console.log('');

    check(
      'exactly one step is marked as the next action',
      before.steps.filter((s) => s.current).length === (before.finished ? 0 : 1),
      `${before.steps.filter((s) => s.current).length} steps marked current`,
    );
    check(
      'the next action is the FIRST incomplete step',
      before.finished ||
        before.steps.findIndex((s) => s.current) ===
          before.steps.findIndex((s) => !s.done),
    );
    check(
      'no step is both done and current',
      before.steps.every((s) => !(s.done && s.current)),
    );
    check(
      'completed count matches the steps marked done',
      before.completed === before.steps.filter((s) => s.done).length,
    );

    // ---- Saving on a settings page flips the step -------------------------
    const audienceText =
      'Operations leads at 50-200 person logistics firms who still run scheduling in spreadsheets.';
    const goalsText = 'Book 15 demos a month from inbound.';

    await saveMarketingProfile(
      company.id,
      marketingProfileSchema.parse({
        audience: audienceText,
        goals: goalsText,
        channels: ['LinkedIn', 'Newsletter'],
      }),
    );
    await saveBrandAssets(
      company.id,
      brandAssetsSchema.parse({ primaryColor: '1d4ed8', secondaryColor: '#0F172A' }),
    );

    const after = await getOnboardingState(company.id);
    const audienceStep = after.steps.find((s) => s.id === 'audience');
    const brandStep = after.steps.find((s) => s.id === 'brand');

    check('saving audience & goals completes that step', audienceStep?.done === true);
    check('saving brand colours completes that step', brandStep?.done === true);
    check(
      'the next action moves on once a step is completed',
      after.completed > before.completed,
      `${before.completed} -> ${after.completed}`,
    );

    // ---- The two sections do not overwrite each other ---------------------
    const fresh = await db.company.findUniqueOrThrow({
      where: { id: company.id },
      select: { preferences: true },
    });
    const brand = readBrandAssets(fresh);
    const marketing = readMarketingProfile(fresh);
    check('brand and audience survive each other’s writes', Boolean(brand?.primaryColor && marketing?.audience));
    check('a hex colour is normalised on the way in', brand?.primaryColor === '#1d4ed8');
    check('mixed-case hex is lowercased', brand?.secondaryColor === '#0f172a');

    // An unrelated section in the same bag must be untouched by our writes.
    const bag = (fresh.preferences ?? {}) as Record<string, unknown>;
    const originalBag = (originalPreferences ?? {}) as Record<string, unknown>;
    const foreignKeys = Object.keys(originalBag).filter(
      (k) => k !== 'brand' && k !== 'marketingProfile',
    );
    check(
      'other preferences (e.g. autopilot) are preserved',
      foreignKeys.every((k) => JSON.stringify(bag[k]) === JSON.stringify(originalBag[k])),
      `lost: ${foreignKeys.filter((k) => JSON.stringify(bag[k]) !== JSON.stringify(originalBag[k])).join(', ')}`,
    );

    // ---- What the user typed reaches the prompts --------------------------
    const profile = await getAudienceProfile(company.id);
    check('the content generator sees the stated audience', profile?.stated === audienceText);
    check('the content generator sees the goal', profile?.goals === goalsText);
    check(
      'the audience is attributed to the settings page',
      (profile?.sources ?? []).includes('audience settings'),
    );

    const prompt = audienceToPrompt(profile);
    check('the prompt carries the audience verbatim', prompt.includes(audienceText));
    check('the prompt carries the goal', prompt.includes(goalsText));
    check(
      'the prompt forbids repeating the goal in the post',
      prompt.includes('Never state the goal in the post itself'),
    );

    // ---- A real logo goes through the real storage pipeline ---------------
    // A 1x1 PNG, byte for byte. This exercises the actual path an upload
    // takes: magic-number sniff, IHDR dimension read, storage, asset row,
    // and the brand-assets write that points at it.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const logo = await storeCompanyLogo({
      companyId: company.id,
      userId: (await db.user.findFirstOrThrow()).id,
      data: png,
      filename: 'verify-logo.png',
    });
    check('an uploaded logo is stored and measured', logo.width === 1 && logo.height === 1);

    const logoAsset = await db.generatedAsset.findUnique({ where: { id: logo.assetId } });
    check('the logo is a company asset, not attached to a post', logoAsset?.contentDraftId === null);
    check('the logo belongs to this workspace', logoAsset?.companyId === company.id);
    check('the logo is recorded as an upload, not a generation', logoAsset?.provider === 'UPLOAD');
    check('the logo mime type is sniffed from the bytes', logoAsset?.mimeType === 'image/png');

    const withLogo = await db.company.findUniqueOrThrow({
      where: { id: company.id },
      select: { preferences: true },
    });
    check('the brand profile points at the uploaded logo', readBrandAssets(withLogo)?.logoAssetId === logo.assetId);
    check(
      'uploading a logo completes the brand step',
      (await getOnboardingState(company.id)).steps.find((s) => s.id === 'brand')?.done === true,
    );

    // Not left behind in the workspace's asset library.
    await db.generatedAsset.delete({ where: { id: logo.assetId } });

    // ---- Clearing a field genuinely clears it -----------------------------
    await saveBrandAssets(company.id, brandAssetsSchema.parse({ primaryColor: '' }));
    const cleared = await db.company.findUniqueOrThrow({
      where: { id: company.id },
      select: { preferences: true },
    });
    check(
      'clearing a colour removes it rather than storing an empty string',
      readBrandAssets(cleared)?.primaryColor === undefined,
    );
    check(
      'clearing one colour leaves the others alone',
      readBrandAssets(cleared)?.secondaryColor === '#0f172a',
    );
  } finally {
    await db.company.update({
      where: { id: company.id },
      data: { preferences: originalPreferences as never },
    });
    console.log('\nRestored original preferences.');
  }

  console.log(
    failures === 0
      ? '\nAll onboarding checks passed.\n'
      : `\n${failures} check(s) BROKEN.\n`,
  );
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
