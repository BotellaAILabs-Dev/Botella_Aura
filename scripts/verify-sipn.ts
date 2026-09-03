/**
 * SIPN as a real-world test case: does Aura actually adapt to the profile?
 *
 * This is the check that matters. It takes the two seeded SIPN workspaces —
 * same company, same product, opposite readers — asks each for the material
 * that would go into a generation prompt, and asserts the two differ in the
 * ways that decide whether the writing works.
 *
 * It deliberately does NOT call a model. What is being tested is the
 * instruction Aura assembles, which is deterministic, free, and the thing that
 * actually causes the difference. A model call would cost money and prove less.
 *
 * Run: pnpm seed:sipn && pnpm verify:sipn
 */
import { db } from '@/lib/db';
import { getAudienceProfile, audienceToPrompt, contentRulesFor } from '@/server/content/audience';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import { readMarketingProfile, readBrandAssets } from '@/server/company/profile.service';
import { getMaterialCoverage } from '@/server/knowledge/coverage';

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** The full instruction block a draft would be generated from. */
async function promptFor(companyId: string, brief: string) {
  const audience = await getAudienceProfile(companyId);
  const chunks = await retrieve(companyId, brief, { limit: 6 });
  const text = [
    audienceToPrompt(audience),
    contentRulesFor(audience?.mode),
    chunksToContext(chunks),
  ].join('\n\n');
  return {
    audience,
    text,
    // Rules are wrapped for readability in source, so a phrase can straddle a
    // line break. Matching against the flattened text is what makes these
    // assertions test the instruction rather than its formatting — and stops a
    // NEGATIVE assertion passing simply because its regex could never match.
    flat: text.replace(/\s+/g, ' '),
  };
}

async function main() {
  const bourbon = await db.company.findUnique({ where: { slug: 'sipn-bourbon' } });
  const enterprises = await db.company.findUnique({ where: { slug: 'sipn-enterprises' } });

  if (!bourbon || !enterprises) {
    console.log('SIPN workspaces not found. Run `pnpm seed:sipn` first.');
    process.exit(1);
  }

  console.log('\nSIPN — two workspaces, one company, opposite readers\n');

  // ---- Each workspace knows which market it is in -------------------------
  const bourbonProfile = readMarketingProfile(bourbon);
  const enterprisesProfile = readMarketingProfile(enterprises);
  check('SIPN Bourbon is set up for consumers', bourbonProfile?.marketMode === 'B2C');
  check('SIPN Enterprises is set up for businesses', enterprisesProfile?.marketMode === 'B2B');
  check(
    'each carries its own brand palette',
    readBrandAssets(bourbon)?.primaryColor !== readBrandAssets(enterprises)?.primaryColor,
  );
  check(
    'each publishes to its own channels',
    Boolean(bourbonProfile?.channels?.includes('Instagram')) &&
      !enterprisesProfile?.channels?.includes('Instagram'),
  );

  // ---- The same brief produces two different instructions ------------------
  // Same subject on purpose: the difference has to come from the profile, not
  // from asking two different questions.
  const brief = 'the barrel number on every bottle and what it unlocks';
  const b2c = await promptFor(bourbon.id, brief);
  const b2b = await promptFor(enterprises.id, brief);

  check('both workspaces produce a grounded prompt', b2c.text.length > 500 && b2b.text.length > 500);
  check('the two prompts are genuinely different', b2c.text !== b2b.text);

  // ---- The consumer prompt does not read like a procurement memo -----------
  check(
    'the consumer prompt does not demand a business case',
    !b2c.flat.includes('measured on — revenue, cost, risk'),
  );
  check(
    'the consumer prompt asks for the experience',
    /taste, look, sound or feel/i.test(b2c.flat),
  );
  check(
    'the consumer prompt forbids talking about "consumers"',
    /never use the words[\s\S]*consumers/i.test(b2c.text),
  );
  check(
    'the consumer prompt bans the category clichés',
    /smooth/.test(b2c.text) && /artisanal/.test(b2c.text),
  );
  check(
    'the consumer prompt forbids inventing an age statement or award',
    /regulated category/i.test(b2c.text),
  );
  check('the consumer prompt asks for one human ask', /ONE clear thing to do/.test(b2c.flat));

  // ---- The business prompt still does its job -----------------------------
  check(
    'the business prompt ties claims to what a buyer is measured on',
    b2b.flat.includes('measured on — revenue, cost, risk'),
  );
  check(
    'the business prompt leads with the business consequence',
    /Lead with the business consequence/.test(b2b.flat),
  );
  check(
    'the business prompt does not carry consumer rules',
    !/taste, look, sound or feel/i.test(b2b.flat),
  );

  // ---- Each reader is described as themselves ------------------------------
  check(
    'the consumer reader is a bourbon drinker, not a decision-maker',
    b2c.text.includes('already drink bourbon') && !b2c.text.includes('business decision-maker'),
  );
  check(
    'the business reader is a category manager',
    b2b.text.includes('category managers') || b2b.text.includes('Beverage buyers'),
  );

  // ---- Each is grounded in its OWN materials -------------------------------
  check(
    'the consumer prompt draws on the bourbon brand guidelines',
    b2c.text.includes('BRAND RULES'),
  );
  check(
    'the business prompt draws on the partner deck or differentiators',
    /38%|2\.4x|shelf slot/.test(b2b.text),
  );
  check(
    'neither workspace can see the other’s material',
    !b2c.text.includes('shelf slot') && !b2b.text.includes('rickhouse'),
  );

  // ---- Competitor material is marked, not adopted --------------------------
  const competitorPrompt = await promptFor(
    enterprises.id,
    'how we compare to other craft bourbon brands on supply and sell-through',
  );
  check(
    'competitor notes are labelled as not ours',
    !competitorPrompt.text.includes('COMPETITOR MATERIAL') ||
      /never adopt their voice/i.test(competitorPrompt.flat),
  );

  // ---- Goals steer without being quoted ------------------------------------
  check(
    'each workspace aims at its own goal',
    b2c.text.includes('app downloads') && b2b.text.includes('distribution partners'),
  );
  check(
    'both are told never to state the goal in the post',
    b2c.flat.includes('Never state the goal in the post itself') &&
      b2b.flat.includes('Never state the goal in the post itself'),
  );

  // ---- Coverage ------------------------------------------------------------
  for (const [name, company] of [
    ['SIPN Bourbon', bourbon],
    ['SIPN Enterprises', enterprises],
  ] as const) {
    const coverage = await getMaterialCoverage(company.id);
    console.log(
      `\n  ${name}: ${coverage.covered}/${coverage.total} kinds of material` +
        (coverage.missing.length ? ` · next gap: ${coverage.missing[0]?.label}` : ''),
    );
  }

  console.log(
    failures === 0
      ? '\nSIPN adapts correctly to both profiles.\n'
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
