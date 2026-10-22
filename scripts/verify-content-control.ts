/**
 * Content Studio control — multiple recommendations, per-version editing,
 * CTA controls, image refinement and per-image logo settings — against the
 * real database, with the AI stubbed at the network edge (no provider is
 * called, nothing is published).
 *
 *   Text   each version keeps its own copy, CTA and details; edits, rewrites
 *          and reverts change one version only; details are never written by
 *          the AI, "from the profile" cannot be faked, unconfirmed details
 *          block approval; CTA suggestions drop invented facts.
 *   Images "Include logo" places the EXACT logo file (pixels checked) on a
 *          corner left clean; refinement edits the logo-free copy and makes a
 *          new version (the original's bytes never change); other variants
 *          are untouched; logo none / include / missing logo; creatives
 *          refine the photo and keep their design; ownership is enforced.
 *
 * Run: pnpm verify:content-control   (database only — the app need not be running)
 */
import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import type { ContentDraft, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { detailsOf } from '@/lib/post-details';
import { variantOf, logoOf } from '@/lib/image-variants';
import { storeCompanyLogo } from '@/server/company/logo.service';
import {
  addRecommendations,
  ctaOptions,
  editVersion,
  revertVersion,
  rewriteVersion,
  setVersionCta,
  versionsOf,
} from '@/server/content/version-workspace.service';
import { renderForManual, renderLinkedInCommentary } from '@/server/content/render';
import { assetsThisMonth, readAssetBytes } from '@/server/media/asset.service';
import { generateGraphics } from '@/server/media/generation.service';
import { generateCreative } from '@/server/media/creative/creative.service';
import { refineVariant, regenerateVariant, setVariantLogo, VariantError } from '@/server/media/variant.service';
import { firstVersion } from '@/server/versions/version.service';

const STAMP = Date.now();
let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const sha = (b: Buffer | null) => (b ? crypto.createHash('sha256').update(b).digest('hex') : 'none');

const PROFILE_PHONE = '+44 131 496 0000';
const POST = (hook: string, cta: string) => ({
  hook,
  paragraphs: [
    'Our cellar team picks every bottle by hand.',
    'Each one is opened, tasted and talked through with you.',
    'Bring a friend and find the one you would buy again.',
  ],
  cta,
  hashtags: ['wine', 'tasting'],
});

// ---------------------------------------------------------------------------
// The AI stub: Gemini text and images, routed by what is asked.
// ---------------------------------------------------------------------------

interface Captured {
  text: string[];
  imageRequests: { prompt: string; inputImage: Buffer | null }[];
}
const captured: Captured = { text: [], imageRequests: [] };
let scene: Buffer;
let edited: Buffer;

function textAnswer(prompt: string): unknown {
  if (prompt.includes('Suggest 4 different calls to action')) {
    return {
      options: [
        'Book your tasting seat',
        'Call +44 999 111 222 to book',
        'Visit https://fake-offers.example now',
        `Call ${PROFILE_PHONE} to reserve`,
        'Reply to save a place',
      ],
    };
  }
  if (/Write \d NEW version/.test(prompt)) {
    const n = Number(prompt.match(/Write (\d) NEW/)![1]);
    return {
      variations: Array.from({ length: n }, (_, i) => ({
        angle: `Fresh angle ${i + 1}`,
        // The AI tries to add details — they must never be stored.
        body: { ...POST(`A new opening, take ${i + 1}`, 'Come and taste with us'), details: { website: { value: 'https://evil.example' } } },
      })),
    };
  }
  if (prompt.includes('TASK: Revise this') || prompt.includes('TASK: Write a fresh take')) {
    if (prompt.includes('YOUR LAST VERSION CHANGED OR INVENTED')) return POST('A warmer welcome to our tasting room', 'Join us for a tasting');
    // First pass invents a link: the facts guard must catch it.
    return { ...POST('A warmer welcome to our tasting room', 'Join us at https://invented.example/offer'), details: { phone: { value: '+1 555 0100' } } };
  }
  if (prompt.includes('TASK: Fix this')) return POST('A clean opening line', 'Come and taste with us');
  // Reviewer / anything else: a neutral, valid answer is not needed by these checks.
  return {};
}

function installStub() {
  const realFetch = globalThis.fetch;
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_IMAGE_MODEL: process.env.GOOGLE_IMAGE_MODEL,
  };
  process.env.GEMINI_API_KEY = 'stub';
  process.env.GOOGLE_AI_API_KEY = 'stub';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_IMAGE_MODEL;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes('generativelanguage.googleapis.com')) return realFetch(url, init);
    const raw = String(init?.body ?? '');
    const body = JSON.parse(raw || '{}') as { contents?: { parts?: { text?: string; inlineData?: { data?: string } }[] }[] };
    const parts = body.contents?.flatMap((c) => c.parts ?? []) ?? [];
    const prompt = parts.map((p) => p.text ?? '').join('\n');
    const isImage = raw.includes('"IMAGE"');
    let reply;
    if (isImage) {
      const input = parts.find((p) => p.inlineData?.data)?.inlineData?.data;
      captured.imageRequests.push({ prompt, inputImage: input ? Buffer.from(input, 'base64') : null });
      reply = [{ inlineData: { mimeType: 'image/png', data: (input ? edited : scene).toString('base64') } }];
    } else {
      captured.text.push(prompt);
      reply = [{ text: JSON.stringify(textAnswer(prompt)) }];
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: reply }, finishReason: 'STOP' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const fresh = (id: string) => db.contentDraft.findUniqueOrThrow({ where: { id } });

/** The colour of one pixel. */
async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}
const isRed = ([r, g, b]: [number, number, number]) => r > 200 && g < 40 && b < 40;

async function main() {
  scene = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#3a5a7a' } }).png().toBuffer();
  edited = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#9a6a3a' } }).png().toBuffer();
  // A logo: solid red mark on a transparent canvas (2.5:1).
  const logoPng = await sharp({ create: { width: 250, height: 100, channels: 4, background: { r: 230, g: 10, b: 10, alpha: 1 } } }).png().toBuffer();

  const owner = await db.user.create({
    data: {
      email: `zzverify-control-${STAMP}@example.test`,
      name: 'Rowan Control',
      passwordHash: await bcrypt.hash(`Zz-${STAMP}!`, 10),
      emailVerified: new Date(),
    },
  });
  const company = await db.company.create({
    data: {
      name: 'zzverify Leith Cellar',
      slug: `zzverify-control-${STAMP}`,
      industry: 'Wine shop',
      website: 'https://leithcellar.example',
      preferences: {
        business: {
          description: 'An independent wine shop with weekly tastings.',
          address: '12 Harbour Street, Leith',
          phone: PROFILE_PHONE,
        },
      } as Prisma.InputJsonObject,
    },
  });
  const nologo = await db.company.create({ data: { name: 'zzverify No Logo', slug: `zzverify-control-nl-${STAMP}` } });
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId: company.id, role: 'OWNER' },
      { userId: owner.id, companyId: nologo.id, role: 'OWNER' },
    ],
  });
  const makeDraft = async (companyId: string) => {
    const b0 = POST('Our Friday tasting is back', 'Book a seat');
    const b1 = POST('Three wines to try before winter', 'Ask us for a pick');
    return db.contentDraft.create({
      data: {
        companyId,
        createdById: owner.id,
        type: 'LINKEDIN_POST',
        status: 'DRAFT',
        title: 'Tasting night',
        platform: 'LINKEDIN',
        body: b0,
        aiMetadata: {
          variations: [
            { angle: 'Story', body: b0 },
            { angle: 'Tip', body: b1 },
          ],
          activeVariation: 0,
          history: [],
          versions: firstVersion(b0),
        } as unknown as Prisma.InputJsonObject,
      },
    });
  };
  const draft = await makeDraft(company.id);
  const restore = installStub();

  try {
    // -------------------------------------------------------------------
    console.log('\nText — each version on its own');
    let d: ContentDraft = draft;
    const v0Before = JSON.stringify(versionsOf(d).versions[0]!.body);

    // A typed phone, falsely claimed to be "from the profile".
    await editVersion({
      draft: d,
      userId: owner.id,
      index: 1,
      body: { ...POST('Three wines to try before winter', 'Ask us for a pick'), details: { phone: { value: '+44 7700 900123', source: 'profile', confirmed: false } } },
    });
    d = await fresh(draft.id);
    let ws = versionsOf(d);
    const v1 = ws.versions[1]!;
    const phone = detailsOf(v1.body).phone;
    check('a version is edited on its own: the draft body is unchanged', JSON.stringify(d.body) === JSON.stringify(draft.body));
    check('…and the other version is unchanged', JSON.stringify(ws.versions[0]!.body) === v0Before);
    check('a client cannot mark a typed value "from the profile"', phone?.source === 'user' && phone.confirmed === false, JSON.stringify(phone));
    const q1 = v1.quality as { approvable?: boolean; issues?: { code: string }[] };
    check('an unconfirmed typed detail blocks approval', q1.approvable === false && Boolean(q1.issues?.some((i) => i.code === 'details-unconfirmed')));
    check('the version keeps its earlier text to revert to', (v1.previous?.length ?? 0) === 1);

    // The business's own phone: pre-approved.
    await editVersion({
      draft: d,
      userId: owner.id,
      index: 1,
      body: { ...(v1.body as object), details: { phone: { value: PROFILE_PHONE, source: 'user', confirmed: false } } },
    });
    d = await fresh(draft.id);
    ws = versionsOf(d);
    const q1b = ws.versions[1]!.quality as { issues?: { code: string }[] };
    check('the business’s saved phone counts as approved', detailsOf(ws.versions[1]!.body).phone?.source === 'profile' && !q1b.issues?.some((i) => i.code === 'details-unconfirmed'));

    // The version in use: the draft's own edit path, approval reopened.
    await db.contentDraft.update({ where: { id: d.id }, data: { status: 'APPROVED' } });
    d = await fresh(draft.id);
    await editVersion({
      draft: d,
      userId: owner.id,
      index: 0,
      body: { ...(d.body as object), details: { website: { value: 'https://leithcellar.example', source: 'user', confirmed: false } } },
    });
    d = await fresh(draft.id);
    ws = versionsOf(d);
    check('editing the version in use edits the post', detailsOf(d.body).website?.value === 'https://leithcellar.example');
    check('…and an approved post goes back to draft', d.status === 'DRAFT', d.status);
    check('…without touching the other version’s details', !detailsOf(ws.versions[1]!.body).website && detailsOf(ws.versions[1]!.body).phone?.value === PROFILE_PHONE);
    const posted = renderLinkedInCommentary(d) ?? '';
    check('the post’s details are published with it', posted.includes('https://leithcellar.example'));
    check('…but are left out of what is fact-checked / given to the AI', !renderForManual(d, { details: false }).includes('leithcellar.example'));

    // CTA on one version, then revert it.
    const v1CtaBefore = (ws.versions[1]!.body as { cta: string }).cta;
    await setVersionCta({ draft: d, userId: owner.id, index: 1, cta: 'Book your tasting seat' });
    d = await fresh(draft.id);
    ws = versionsOf(d);
    check('a CTA is changed on one version only', (ws.versions[1]!.body as { cta: string }).cta === 'Book your tasting seat' && (d.body as { cta: string }).cta === 'Book a seat');
    await revertVersion({ draft: d, userId: owner.id, index: 1 });
    d = await fresh(draft.id);
    ws = versionsOf(d);
    check('revert brings back that version’s previous text', (ws.versions[1]!.body as { cta: string }).cta === v1CtaBefore);

    // Rewrite one version with an instruction; the first pass invents a link.
    const bodyBefore = JSON.stringify(d.body);
    const r = await rewriteVersion({ draft: d, userId: owner.id, index: 1, instruction: 'Make the hook warmer' });
    d = await fresh(draft.id);
    ws = versionsOf(d);
    const rewritten = ws.versions[1]!;
    check('refining one version leaves the post untouched', JSON.stringify(d.body) === bodyBefore);
    check('an invented link is caught and corrected', !renderForManual({ ...d, body: rewritten.body } as ContentDraft).includes('invented.example') && rewritten.facts?.corrected === true && r.factsKept);
    check('the AI cannot change a version’s details', detailsOf(rewritten.body).phone?.value === PROFILE_PHONE);
    check('the refined version keeps its previous text', (rewritten.previous?.[0]?.note ?? '').startsWith('refined'));

    // More recommendations.
    const countBefore = ws.versions.length;
    const more = await addRecommendations({ draft: d, userId: owner.id, count: 2 });
    d = await fresh(draft.id);
    ws = versionsOf(d);
    check('more recommendations are added next to the others', ws.versions.length === countBefore + 2 && more.added.length === 2);
    check('…existing versions are unchanged', JSON.stringify(ws.versions[1]!.body) === JSON.stringify(rewritten.body));
    const added = ws.versions[more.added[0]!]!;
    check('…they start with the details of the version in use, never the AI’s', detailsOf(added.body).website?.value === 'https://leithcellar.example' && !JSON.stringify(added.body).includes('evil.example'));
    check('…each with its own angle', added.angle.length > 0);

    // CTA suggestions.
    const options = await ctaOptions({ draft: d, index: 0 });
    check('CTA suggestions are offered', options.includes('Book your tasting seat') && options.includes('Reply to save a place'));
    check('…a suggestion with an invented phone or link is dropped', !options.some((o) => o.includes('999 111') || o.includes('fake-offers')));
    check('…the business’s own phone is allowed', options.some((o) => o.includes(PROFILE_PHONE)));

    // -------------------------------------------------------------------
    console.log('\nImages — logo, refinement, versions');
    await storeCompanyLogo({ companyId: company.id, userId: owner.id, data: logoPng, filename: 'logo.png' });
    captured.imageRequests.length = 0;
    const usedBefore = await assetsThisMonth(company.id);
    const gen = await generateGraphics({
      draft: d,
      userId: owner.id,
      prompt: 'A candle-lit wine tasting table with three glasses, warm and inviting, real photograph.',
      style: 'photo',
      variations: 2,
      aspectRatio: '1:1',
      logo: { mode: 'include', position: 'bottom-right' },
    });
    const [a, b] = gen.assets;
    check('two images with the logo use two from the allowance (placing the logo is free)', (await assetsThisMonth(company.id)) - usedBefore === 2, `${(await assetsThisMonth(company.id)) - usedBefore}`);
    check('two images are made, each a separate variant', gen.assets.length === 2 && a!.variant.rootId !== b!.variant.rootId);
    check('the image model is asked for clean space, never to draw a logo', captured.imageRequests.every((x) => x.prompt.includes('keep the bottom right corner') && x.prompt.includes('Do not draw any logo')));
    check('the logo is placed on each image', Boolean(a?.logo?.applied && b?.logo?.applied));
    const aRow = await db.generatedAsset.findUniqueOrThrow({ where: { id: a!.id } });
    const aBytes = await readAssetBytes(aRow);
    const box = (aRow.metadata as { logo?: { box?: { left: number; top: number; width: number; height: number } } }).logo?.box;
    check('the exact logo pixels are on the image (bottom-right)', Boolean(box && aBytes && isRed(await pixel(aBytes, box.left + box.width / 2, box.top + box.height / 2))));
    check('…in its own proportions (2.5:1)', Boolean(box && Math.abs(box.width / box.height - 2.5) < 0.05), JSON.stringify(box));
    const cleanId = (aRow.metadata as { cleanId?: string }).cleanId!;
    const cleanRow = await db.generatedAsset.findUniqueOrThrow({ where: { id: cleanId } });
    check('the logo-free copy is kept, hidden from the gallery', (cleanRow.metadata as { hidden?: boolean }).hidden === true);
    check('…and is not red where the logo goes', !isRed(await pixel((await readAssetBytes(cleanRow))!, box!.left + box!.width / 2, box!.top + box!.height / 2)));

    // Refine A.
    captured.imageRequests.length = 0;
    const aHashBefore = sha(aBytes);
    const refined = await refineVariant({ draft: d, userId: owner.id, assetId: a!.id, instruction: 'Make the lighting warmer and more realistic' });
    const editReq = captured.imageRequests[0];
    check('refinement sends the logo-free image to the model', Boolean(editReq?.inputImage) && sha(editReq!.inputImage) === sha(await readAssetBytes(cleanRow)));
    check('…with the instruction and the keep-what-works rules', Boolean(editReq?.prompt.includes('Make the lighting warmer') && editReq.prompt.includes('Keep everything the instruction does not ask to change')));
    check('…as a new version of the same variant', refined.variant.rootId === a!.variant.rootId && refined.variant.version > a!.variant.version && refined.id !== a!.id);
    check('…with the logo placed again', refined.logo?.applied === true);
    check('the original image is unchanged', sha(await readAssetBytes(await db.generatedAsset.findUniqueOrThrow({ where: { id: a!.id } }))) === aHashBefore);
    const bVersions = await db.generatedAsset.count({ where: { contentDraftId: d.id, metadata: { path: ['variant', 'rootId'], equals: b!.variant.rootId } } });
    check('the other variant is untouched', bVersions === 1, `${bVersions} versions`);
    check('the post’s text is untouched by image work', JSON.stringify((await fresh(d.id)).body) === JSON.stringify(d.body));

    // Logo off, then on in another corner.
    const off = await setVariantLogo({ draft: d, userId: owner.id, assetId: refined.id, mode: 'none', position: 'bottom-right' });
    const offRow = await db.generatedAsset.findUniqueOrThrow({ where: { id: off.asset.id } });
    const refinedRow = await db.generatedAsset.findUniqueOrThrow({ where: { id: refined.id } });
    const refinedClean = await db.generatedAsset.findUniqueOrThrow({
      where: { id: (refinedRow.metadata as { cleanId: string }).cleanId },
    });
    check('“No logo” makes a version without it (the logo-free image)', off.changed && sha(await readAssetBytes(offRow)) === sha(await readAssetBytes(refinedClean)) && logoOf(offRow.metadata)?.mode === 'none');
    const on = await setVariantLogo({ draft: d, userId: owner.id, assetId: off.asset.id, mode: 'include', position: 'top-left' });
    const onRow = await db.generatedAsset.findUniqueOrThrow({ where: { id: on.asset.id } });
    const onBox = (onRow.metadata as { logo?: { box?: { left: number; top: number; width: number; height: number } } }).logo?.box;
    check('the logo can be placed in another corner, per image', Boolean(onBox && onBox.left < 100 && onBox.top < 100 && isRed(await pixel((await readAssetBytes(onRow))!, onBox.left + onBox.width / 2, onBox.top + onBox.height / 2))));
    const versionsA = await db.generatedAsset.findMany({ where: { contentDraftId: d.id, metadata: { path: ['variant', 'rootId'], equals: a!.variant.rootId } }, select: { id: true, metadata: true } });
    check('every version is kept (compare / revert)', versionsA.filter((x) => !(x.metadata as { hidden?: boolean }).hidden).length >= 4);

    // Regenerate B only.
    const aCount = versionsA.length;
    const regen = await regenerateVariant({ draft: d, userId: owner.id, assetId: b!.id });
    check('regenerating one variant adds a version to it alone', variantOf(regen.id, { variant: regen.variant }).rootId === b!.variant.rootId &&
      (await db.generatedAsset.count({ where: { contentDraftId: d.id, metadata: { path: ['variant', 'rootId'], equals: a!.variant.rootId } } })) === aCount);

    // Ownership.
    const other = await makeDraft(company.id);
    let refused = false;
    try {
      await refineVariant({ draft: other, userId: owner.id, assetId: a!.id, instruction: 'warmer' });
    } catch (err) {
      refused = err instanceof VariantError;
    }
    check('an image can only be changed from its own post', refused);

    // No logo uploaded: told, never drawn.
    const nlDraft = await makeDraft(nologo.id);
    const nl = await generateGraphics({ draft: nlDraft, userId: owner.id, prompt: 'A bright shop window display of wine bottles, real photograph.', style: 'photo', variations: 1, aspectRatio: '1:1', logo: { mode: 'include', position: 'bottom-right' } });
    check('without a logo on file the image is kept, with the reason', nl.assets.length === 1 && nl.assets[0]!.logo?.applied === false && /No logo uploaded/.test(nl.assets[0]!.logo?.reason ?? ''));

    // Creatives: "Add logo later", and refining the photo keeps the design.
    const creative = await generateCreative({
      draft: d,
      userId: owner.id,
      input: { aspectRatio: '1:1', headline: 'Friday tasting night', showLogo: true, logoMode: 'space', colors: {}, photo: 'new' } as never,
    });
    check('a creative can leave space for the logo instead of drawing anything', creative.spec.brand.logoMode === 'space' && creative.spec.brand.showLogo === false);
    const refinedCreative = await refineVariant({ draft: d, userId: owner.id, assetId: creative.asset.id, instruction: 'Warmer light' });
    const rcRow = await db.generatedAsset.findUniqueOrThrow({ where: { id: refinedCreative.id } });
    const rcSpec = (rcRow.metadata as { spec?: { text?: { headline?: string }; photo?: { assetId?: string } } }).spec;
    check('refining a creative changes the photo and keeps its words', rcSpec?.text?.headline === creative.spec.text.headline && rcSpec?.photo?.assetId !== creative.spec.photo.assetId && refinedCreative.variant.rootId === creative.asset.id);
  } finally {
    restore();
    await db.company.delete({ where: { id: company.id } }).catch(() => undefined);
    await db.company.delete({ where: { id: nologo.id } }).catch(() => undefined);
    await db.auditLog.deleteMany({ where: { userId: owner.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    console.log('\n  ok      cleanup: throwaway workspaces removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll content control checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
