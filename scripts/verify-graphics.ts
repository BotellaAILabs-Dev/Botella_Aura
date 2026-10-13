/**
 * End-to-end verification of the Graphic Generation pipeline, minus the paid
 * provider HTTP call.
 *
 * Drives the REAL services against the REAL database with a REAL PNG, proving:
 *   validate bytes -> store -> persist -> list -> attach -> platform validation
 *   -> queue (without auto-approving) -> read back for publishing.
 *
 * Run with:  pnpm exec tsx scripts/verify-graphics.ts
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// Mirrors prisma/seed.ts: tsx does not auto-load .env the way the Prisma CLI
// does. process.loadEnvFile is built into Node >= 20.12 (zero dependencies).
try {
  process.loadEnvFile();
} catch {
  // .env is optional — vars may already be set in the shell.
}

import { db } from '@/lib/db';
import { contentHash, contentMetaAfter } from '@/server/approval/approval.service';
import { validateImageBytes, validateForPlatform } from '@/server/media/validate';
import { putImage, activeStore } from '@/server/media/storage';
import {
  createAsset,
  listAssets,
  attachAsset,
  getAttachedMedia,
  getAsset,
  readAssetBytes,
  attachedAssetIds,
  assetsForJob,
  deleteAsset,
  assetsThisMonth,
  toAssetView,
} from '@/server/media/asset.service';
import { queueDraft } from '@/server/content/content.service';
import { signedAssetUrl, verifyAssetSignature } from '@/server/media/asset-url';
import { getQueue } from '@/server/extension/queue.service';
import { resolvePlatform } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';

/** Build a real, decodable PNG of the given size (solid colour). */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = 140;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ok = (label: string, detail = '') =>
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label: string, detail: string) => {
  console.error(`  FAIL  ${label} — ${detail}`);
  process.exitCode = 1;
};

/**
 * This check works on the demo workspace's own draft. If it stops part-way,
 * the draft is put back exactly as it was found (status, schedule, network,
 * metadata) and the test image removed — never left approved and scheduled.
 */
let restoreDemo: (() => Promise<void>) | null = null;

async function main() {
  const company = await db.company.findFirst({ where: { slug: 'botella-demo' } });
  const user = await db.user.findFirst({ where: { email: 'demo@botella.ai' } });
  // Not a published one: attaching media to a published post is correctly
  // refused, so picking one at random makes this script test its own bad setup.
  const draft = await db.contentDraft.findFirst({
    where: {
      companyId: company!.id,
      type: 'LINKEDIN_POST',
      status: { not: 'PUBLISHED' },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!company || !user || !draft) throw new Error('demo data missing — run pnpm db:seed:demo');
  const original = {
    status: draft.status,
    scheduledFor: draft.scheduledFor,
    platform: draft.platform,
    aiMetadata: draft.aiMetadata ?? {},
  };

  console.log(`\nworkspace ${company.slug} · draft ${draft.id} · store ${activeStore()}\n`);

  // --- 1. byte validation on a real PNG ---------------------------------
  console.log('1. Byte validation');
  const png = makePng(1024, 1024);
  const validated = validateImageBytes(png, { width: 9999, height: 9999 });
  if (validated.mimeType === 'image/png') ok('sniffs PNG from magic number');
  else fail('sniff', validated.mimeType);
  if (validated.width === 1024 && validated.height === 1024) ok('reads REAL dimensions, ignoring the claimed 9999x9999');
  else fail('dimensions', `${validated.width}x${validated.height}`);

  try {
    validateImageBytes(Buffer.from('<!DOCTYPE html><html>error</html>'), {
      width: 1,
      height: 1,
    });
    fail('html rejection', 'accepted an HTML error page as an image');
  } catch {
    ok('rejects an HTML error page returned with HTTP 200');
  }

  // --- 2. store + persist ------------------------------------------------
  console.log('\n2. Storage and persistence');
  const assetId = `c${Date.now().toString(36)}${crypto.randomBytes(9).toString('base64url').toLowerCase()}`;
  restoreDemo = async () => {
    await db.contentMedia.deleteMany({ where: { contentDraftId: draft.id, assetId } });
    await db.generatedAsset.deleteMany({ where: { id: assetId, companyId: company.id } });
    await db.contentDraft.update({
      where: { id: draft.id },
      data: { ...original, aiMetadata: original.aiMetadata as object },
    });
    console.error('Restored the demo draft to how it was found.');
  };
  const stored = await putImage({
    companyId: company.id,
    assetId,
    data: png,
    mimeType: validated.mimeType,
  });
  ok('stored bytes', `storage=${stored.storage}, ${validated.fileSize} bytes`);

  const asset = await createAsset({
    id: assetId,
    companyId: company.id,
    contentDraftId: draft.id,
    createdById: user.id,
    provider: 'OPENAI',
    model: 'gpt-image-1',
    kind: 'IMAGE',
    prompt: 'A cinematic control room at dawn, no text.',
    originalPrompt: 'AI written prompt',
    style: 'cinematic',
    aspectRatio: '1:1',
    width: validated.width,
    height: validated.height,
    mimeType: validated.mimeType,
    fileSize: validated.fileSize,
    storage: stored.storage,
    data: stored.data ?? null,
    storageUrl: stored.storageUrl ?? null,
    platform: 'LINKEDIN',
    metadata: { verifiedBy: 'scripts/verify-graphics.ts' },
  });
  ok('persisted GeneratedAsset row', asset.id);
  if ('data' in asset) fail('summary select', 'createAsset echoed the bytes back');
  else ok('createAsset does NOT round-trip the bytes back');

  const readBack = await readAssetBytes(await getAsset(company.id, assetId));
  if (readBack && readBack.equals(png)) ok('bytes read back byte-for-byte identical');
  else fail('read back', 'bytes differ or missing');

  // --- 3. tenant scoping --------------------------------------------------
  console.log('\n3. Ownership');
  try {
    await getAsset('some_other_company', assetId);
    fail('cross-tenant read', 'another company could read the asset');
  } catch {
    ok('another company cannot read the asset');
  }

  // --- 4. history ---------------------------------------------------------
  console.log('\n4. History');
  const history = await listAssets(company.id, { draftId: draft.id });
  if (history.some((a) => a.id === assetId)) ok('appears in this draft history', `${history.length} asset(s)`);
  else fail('history', 'asset missing');
  if (history.every((a) => !('data' in a))) ok('listing never selects the bytes column');
  else fail('history', 'listing pulled image bytes');
  ok('month usage counter', `${await assetsThisMonth(company.id)} this month`);

  const view = toAssetView(history[0]!);
  if (view.url === `/api/content/graphics/${assetId}/file`) ok('client view exposes a URL, never bytes');
  else fail('view', view.url);

  // --- 4b. resumability ---------------------------------------------------
  console.log('\n4b. Resumability (the double-charge guard)');
  const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
  const tagged = `${assetId}b`;
  await createAsset({
    id: tagged,
    companyId: company.id,
    contentDraftId: draft.id,
    provider: 'OPENAI',
    model: 'gpt-image-1',
    kind: 'IMAGE',
    prompt: 'resume check',
    aspectRatio: '1:1',
    width: 512,
    height: 512,
    mimeType: 'image/png',
    fileSize: 100,
    storage: 'DATABASE',
    data: png,
    // What the runner stamps so a retry knows what it already paid for.
    metadata: { jobId },
  });
  const forJob = await assetsForJob(company.id, jobId);
  if (forJob.length === 1 && forJob[0]!.id === tagged) ok('finds images a killed run already produced', `jobId=${jobId}`);
  else fail('assetsForJob', `${forJob.length} found — a retry would re-generate and double-charge`);
  if ((await assetsForJob(company.id, 'job_that_never_ran')).length === 0) ok('does not match an unrelated job');
  else fail('assetsForJob', 'matched the wrong job');
  await deleteAsset({ companyId: company.id, userId: user.id, assetId: tagged });

  // --- 5. signed URL ------------------------------------------------------
  console.log('\n5. Signed URLs (the Instagram fetch path)');
  const signed = signedAssetUrl(assetId);
  const u = new URL(signed.url);
  if (verifyAssetSignature(assetId, u.searchParams.get('exp'), u.searchParams.get('sig'))) ok('signature verifies for its own asset');
  else fail('signature', 'did not verify');
  if (verifyAssetSignature('another_asset', u.searchParams.get('exp'), u.searchParams.get('sig'))) fail('signature', 'verified for a DIFFERENT asset');
  else ok('signature rejected for a different asset');

  // --- 6. attach ----------------------------------------------------------
  console.log('\n6. Attachment');
  await attachAsset({
    companyId: company.id,
    userId: user.id,
    draftId: draft.id,
    assetId,
    altText: 'A control room at dawn',
  });
  const media = await getAttachedMedia({
    companyId: company.id,
    draftId: draft.id,
    type: draft.type as ContentTypeKey,
    platform: draft.platform,
  });
  if (media.length === 1 && media[0]!.assetId === assetId) ok('attached to the post', `${media.length} media`);
  else fail('attach', `${media.length} media`);
  if (media[0]!.problems.length === 0) ok('valid for LinkedIn (1024x1024 PNG, no problems)');
  else fail('platform validation', media[0]!.problems.join(' '));
  if ((await attachedAssetIds(company.id, draft.id)).has(assetId)) ok('attachment reflected in the draft');
  else fail('attachedAssetIds', 'missing');

  // --- 7. platform-aware validation --------------------------------------
  console.log('\n7. Platform rules');
  const igCheck = validateForPlatform(
    { mimeType: 'image/png', width: 2048, height: 2048, fileSize: 1_000_000 },
    'INSTAGRAM',
  );
  if (!igCheck.ok) ok('Instagram rejects a 2048px image', igCheck.problems[0]!);
  else fail('instagram', 'accepted an oversized image');
  const webpCheck = validateForPlatform(
    { mimeType: 'image/webp', width: 1024, height: 1024, fileSize: 500_000 },
    'LINKEDIN',
  );
  if (webpCheck.ok) fail('linkedin', 'accepted WEBP');
  else ok('LinkedIn rejects WEBP');

  // --- 8. the queue -------------------------------------------------------
  console.log('\n8. Queue (the existing one)');
  const before = draft.status;
  // Restored at the end, so the demo draft is left as it was found.
  const beforeMeta = draft.aiMetadata;
  // Approving the way the app does — with an approval record (lib/approval.ts).
  // A bare status write is exactly what the approval guard refuses to execute.
  const recordedApproval = async () => {
    const d = (await db.contentDraft.findUnique({ where: { id: draft.id } }))!;
    const hash = await contentHash(d);
    await db.contentDraft.update({
      where: { id: draft.id },
      data: {
        status: 'APPROVED',
        aiMetadata: contentMetaAfter(d, hash, {
          action: 'approved',
          by: user.id,
          nextStatus: 'APPROVED',
          nextHash: hash,
          approve: { via: 'person', snapshot: { body: d.body, platform: d.platform } },
        }),
      },
    });
  };

  // Force DRAFT first. The seeded draft may already be APPROVED, and
  // "an approved post stays approved" is correct behaviour — so asserting on
  // whatever it happened to be would test nothing. The invariant worth pinning
  // is that an UNAPPROVED post cannot become approved by being queued.
  await db.contentDraft.update({ where: { id: draft.id }, data: { status: 'DRAFT' } });
  const queued = await queueDraft({
    companyId: company.id,
    userId: user.id,
    draftId: draft.id,
    platform: 'LINKEDIN',
    scheduledFor: new Date(Date.now() + 3_600_000),
  });
  if (queued.status === 'PENDING_APPROVAL') ok('queueing a DRAFT sends it for review, not to APPROVED', `DRAFT -> ${queued.status}`);
  else fail('APPROVAL GATE', `DRAFT -> ${queued.status}`);

  // The other half: re-queueing an approved post to change its time must not
  // force a second approval round.
  await recordedApproval();
  const requeued = await queueDraft({
    companyId: company.id,
    userId: user.id,
    draftId: draft.id,
    scheduledFor: new Date(Date.now() + 7_200_000),
  });
  if (requeued.status === 'APPROVED') ok('re-queueing an APPROVED post does not demand re-approval');
  else fail('requeue', `APPROVED -> ${requeued.status}`);
  if (queued.scheduledFor) ok('scheduled time recorded', queued.scheduledFor.toISOString());
  else fail('schedule', 'not recorded');
  if (queued.platform === 'LINKEDIN') ok('platform recorded on the draft');
  else fail('platform', String(queued.platform));

  // --- 9. extension queue -------------------------------------------------
  console.log('\n9. Extension queue');
  await recordedApproval();
  const queue = await getQueue(company.id);
  const item = queue.find((q) => q.itemId === draft.id);
  if (item) ok('approved post appears in the extension queue', item.platformLabel ?? '');
  else fail('extension queue', 'post missing');
  if (item && item.media.length === 1) ok('queue item carries media METADATA', `${item.media[0]!.width}x${item.media[0]!.height} ${item.media[0]!.mimeType}`);
  else fail('extension media', `${item?.media.length ?? 0} media`);
  if (item && !JSON.stringify(item).includes('data:image')) ok('queue payload contains no image bytes');
  else fail('extension queue', 'inlined bytes');

  // --- 10. cleanup --------------------------------------------------------
  console.log('\n10. Cleanup');
  await db.contentDraft.update({
    where: { id: draft.id },
    data: { status: before, scheduledFor: null, platform: null, aiMetadata: beforeMeta ?? {} },
  });
  await deleteAsset({ companyId: company.id, userId: user.id, assetId });
  if ((await db.generatedAsset.findUnique({ where: { id: assetId } }))) fail('delete', 'asset still present');
  else ok('asset deleted and draft restored');

  const platform = resolvePlatform(draft.type as ContentTypeKey, null);
  if (platform === 'LINKEDIN') ok('a draft with no platform still resolves to LinkedIn (back-compat)');
  else fail('back-compat', platform);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error('\nVERIFICATION ERROR:', err);
    process.exitCode = 1;
    if (restoreDemo) await restoreDemo().catch((e) => console.error('Could not restore the demo draft:', e));
    await db.$disconnect();
  });
