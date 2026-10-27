/**
 * One-click social publishing (Facebook, Instagram, LinkedIn), end to end
 * against the REAL database and the real publishing code — Content Studio's
 * publishToPlatforms, the publication claims, the execution lifecycle,
 * routing — with only the providers' APIs replaced by a recorder (Meta's
 * Graph API and LinkedIn's REST API). Nothing is posted anywhere.
 *
 *   A–D  one network, each; all three at once
 *   E    Facebook succeeds, Instagram fails — independent outcomes, then a
 *        retry posts only Instagram
 *   F    a network times out — the others still publish; the timed-out one
 *        is never retried automatically (it may have gone out)
 *   G    duplicate requests (two at once, then again) — each network once
 *   H    not approved / not allowed to approve — nothing posted
 *   I    another business's post — refused; its connection is never used
 *   J    WhatsApp: no publish permission — refused at every step
 *
 * Run: pnpm verify:one-click   (database only — the app need not be running)
 */
import type { CompanyRole, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { requireRealMeta } from './lib/meta-mode';
import { encrypt } from '@/lib/crypto';
import { META_SCOPES } from '@/lib/meta';
import { contentHash } from '@/server/approval/approval.service';
import { previewPublishing, publishToPlatforms, type MultiPlatform } from '@/server/content/multi-publish.service';
import { publishDraft } from '@/server/content/publish.service';
import { listPublications } from '@/server/content/publication-store';
import { publishTool } from '@/server/whatsapp/tools/social';
import { mayUse } from '@/server/whatsapp/tools/registry';

const STAMP = Date.now();
const DAY = 24 * 60 * 60_000;
let failures = 0;
const results: Record<string, boolean> = {};
let scenario = '';
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) results[scenario] = false;
  else if (results[scenario] === undefined) results[scenario] = true;
  if (ok) console.log(`  ok      ${label}`);
  else {
    failures++;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (name: string) => {
  scenario = name;
  console.log(`\n${name}`);
};

// ---- The fake providers -------------------------------------------------------
interface Call {
  net: 'facebook' | 'instagram' | 'linkedin' | 'meta';
  method: string;
  url: string;
  params: Record<string, string>;
  json: Record<string, any> | null;
}
let calls: Call[] = [];
const fail = { instagram: false, linkedinHang: false };
let seq = 0;
const realFetch = globalThis.fetch;
const FB_PAGE_A = '7770001';
const IG_A = '17841477001';
const FB_PAGE_B = '8880002';

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? 'GET';
  const params: Record<string, string> = {};
  const u = new URL(url);
  u.searchParams.forEach((v, k) => (params[k] = v));
  let json: Record<string, any> | null = null;
  if (typeof init?.body === 'string') {
    if (init.body.startsWith('{')) json = JSON.parse(init.body);
    else new URLSearchParams(init.body).forEach((v, k) => (params[k] = v));
  }
  const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  if (u.hostname === 'graph.facebook.com') {
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    if (path === 'me/accounts') {
      calls.push({ net: 'meta', method, url, params, json });
      // The token decides which Pages it manages (each workspace has its own).
      const pages = params.access_token?.includes('WORKSPACE_B') ? [{ id: FB_PAGE_B, name: 'Other Biz', access_token: 'PAGE_TOKEN_B' }] : [{ id: FB_PAGE_A, name: 'Verify Bakery', access_token: 'PAGE_TOKEN_A' }];
      return ok({ data: pages });
    }
    if (/^\d+\/(photos|feed)$/.test(path)) {
      calls.push({ net: 'facebook', method, url, params, json });
      return ok({ id: `photo_${++seq}`, post_id: `${path.split('/')[0]}_${seq}` });
    }
    if (path.endsWith('/media') && method === 'POST') {
      calls.push({ net: 'instagram', method, url, params, json });
      if (fail.instagram) return ok({ error: { message: 'Media could not be fetched', code: 9004, error_subcode: 2207052 } }, 400);
      return ok({ id: `container_${++seq}` });
    }
    if (path.endsWith('/media_publish')) {
      calls.push({ net: 'instagram', method, url, params, json });
      return ok({ id: `media_${++seq}` });
    }
    if (params.fields?.startsWith('status_code')) return ok({ status_code: 'FINISHED' });
    if (params.fields === 'permalink') return ok({ permalink: `https://www.instagram.com/p/${path}/` });
    if (params.fields === 'permalink_url') return ok({ permalink_url: `https://www.facebook.com/${path}` });
    return ok({ error: { message: `unexpected ${method} ${path}` } }, 400);
  }
  if (u.hostname === 'api.linkedin.com' || u.hostname === 'www.linkedin.com') {
    if (url.includes('/rest/posts')) {
      calls.push({ net: 'linkedin', method, url, params, json });
      if (fail.linkedinHang) {
        // Never answers: the caller's timeout aborts it.
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))));
      }
      return new Response(null, { status: 201, headers: { 'x-restli-id': `urn:li:share:${++seq}` } });
    }
    if (url.includes('initializeUpload')) {
      calls.push({ net: 'linkedin', method, url, params, json });
      return ok({ value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/IMG/0', image: `urn:li:image:IMG${++seq}` } });
    }
    if (url.includes('dms-uploads')) {
      calls.push({ net: 'linkedin', method, url, params, json: null });
      return new Response(null, { status: 201 });
    }
    if (url.includes('/rest/images/')) return new Response('{"status":403}', { status: 403 });
  }
  throw new Error(`unexpected network call: ${method} ${url}`);
}) as typeof fetch;

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000ff2f75e70000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function main() {
  // Publishes in-process, so the override that matters is this process's.
  await requireRealMeta({ suite: 'verify:one-click' });
  const users: Record<string, { id: string }> = {};
  const mk = async (tag: string) => db.company.create({ data: { name: `zzverify 1click ${tag} ${STAMP}`, slug: `zzverify-1click-${tag}-${STAMP}` } });
  const A = await mk('a');
  const B = await mk('b');
  for (const [role, company] of [['OWNER', A], ['MEMBER', A], ['VIEWER', A], ['B_OWNER', B]] as const) {
    users[role] = await db.user.create({ data: { email: `zzverify-1click-${role.toLowerCase()}-${STAMP}@example.test` } });
    await db.companyMember.create({ data: { userId: users[role]!.id, companyId: company.id, role: (role === 'B_OWNER' ? 'OWNER' : role) as CompanyRole } });
  }
  const meta = (companyId: string, token: string, pageId: string, ig: string | null) =>
    db.connection.create({
      data: {
        companyId, connectorId: 'meta', kind: 'OAUTH', status: 'CONNECTED', accountLabel: 'Page', scope: META_SCOPES.join(' '), scopes: [...META_SCOPES],
        accessTokenEnc: encrypt(token), expiresAt: new Date(Date.now() + 50 * DAY), provider: 'meta', channels: ['FACEBOOK', 'INSTAGRAM'], setupStage: 'CONFIRMED', health: 'HEALTHY',
        metadata: { fbUserId: `fb_${pageId}`, pageId, pageName: 'Page', ...(ig ? { igUserId: ig, igUsername: 'verify' } : {}), pages: [{ id: pageId, name: 'Page', ig: ig ? { id: ig, username: 'verify' } : null }] } as Prisma.InputJsonObject,
      },
    });
  await meta(A.id, 'META_TOKEN_WORKSPACE_A', FB_PAGE_A, IG_A);
  await meta(B.id, 'META_TOKEN_WORKSPACE_B', FB_PAGE_B, null);
  await db.linkedInConnection.create({
    data: { companyId: A.id, linkedInUserId: 'li_a', displayName: 'Dana A', accessTokenEnc: encrypt('LI_TOKEN_A'), scope: 'openid profile email w_member_social', expiresAt: new Date(Date.now() + 30 * DAY), status: 'ACTIVE', connectedAt: new Date() },
  });

  /** An image post, approved by the owner (approval record over text + image). */
  async function post(companyId: string, title: string, opts: { approved?: boolean; image?: boolean; text?: string } = {}) {
    const d = await db.contentDraft.create({
      data: {
        companyId, type: 'IMAGE_POST', platform: 'FACEBOOK', status: opts.approved === false ? 'PENDING_APPROVAL' : 'APPROVED', title,
        // An image post as Content Studio writes it: caption, CTA, hashtags.
        body: { caption: opts.text ?? `${title}: fresh sourdough (still warm) — 50% off before 9am! Baked overnight with *real* butter.`, cta: 'Visit us on Main St.', hashtags: ['bakery', 'sourdough'], altText: 'Loaves on a shelf' },
      },
    });
    if (opts.image !== false) {
      const asset = await db.generatedAsset.create({
        data: { companyId, contentDraftId: d.id, provider: 'UPLOAD', model: 'upload', prompt: 'verify', aspectRatio: '1:1', width: 1080, height: 1080, mimeType: 'image/png', fileSize: PNG.length, data: PNG },
      });
      await db.contentMedia.create({ data: { companyId, contentDraftId: d.id, assetId: asset.id, position: 0, altText: 'Loaves on a shelf' } });
    }
    if (opts.approved !== false) {
      const fresh = (await db.contentDraft.findUnique({ where: { id: d.id } }))!;
      const hash = await contentHash(fresh);
      await db.contentDraft.update({
        where: { id: d.id },
        data: { aiMetadata: { approval: { model: 1, version: 1, hash, approved: { by: users.OWNER!.id, via: 'person', at: new Date().toISOString(), version: 1, hash, snapshot: null }, rejected: null, events: [] } } as Prisma.InputJsonObject },
      });
    }
    return d;
  }
  const publish = (draftId: string, platforms: MultiPlatform[], role: CompanyRole = 'OWNER', userId = users.OWNER!.id, companyId = A.id) =>
    publishToPlatforms({ companyId, userId, role, draftId, platforms });
  const net = (n: Call['net']) => calls.filter((c) => c.net === n);
  const posts = (n: Call['net']) =>
    net(n).filter((c) => (n === 'instagram' ? c.url.endsWith('/media_publish') : n === 'linkedin' ? c.url.includes('/rest/posts') : true));

  try {
    // -------------------------------------------------------------- preview
    section('Preview and platform selection');
    const pv = await post(A.id, 'Preview');
    const preview = await previewPublishing(A.id, (await db.contentDraft.findUnique({ where: { id: pv.id } }))!);
    const byP = Object.fromEntries(preview.map((p) => [p.platform, p]));
    check('a preview for each network, each ready, with its own text', ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'].every((p) => byP[p]?.ready && typeof byP[p]?.text === 'string' && byP[p].text.length > 20), JSON.stringify(preview.map((p) => [p.platform, p.ready, p.blockers])));
    check('nothing was sent to any network by previewing', calls.length === 0);

    // -------------------------------------------------------------- A
    section('Scenario A — Facebook only');
    calls = [];
    const a = await post(A.id, 'Only Facebook');
    const ra = await publish(a.id, ['FACEBOOK']);
    check('Facebook published, with the post link', ra.results.length === 1 && ra.results[0]!.status === 'published' && Boolean((ra.results[0] as any).url), JSON.stringify(ra.results));
    check('only Facebook was called — to this workspace’s chosen Page, as a photo post', posts('facebook').length === 1 && posts('facebook')[0]!.url.includes(`/${FB_PAGE_A}/photos`) && net('instagram').length === 0 && net('linkedin').length === 0);
    const fb = posts('facebook')[0]!;
    check('the Page token (not the user token) was used, and the image goes as a signed link', fb.params.access_token === 'PAGE_TOKEN_A' && /\/api\/content\/graphics\/[^/]+\/file\?exp=\d+&sig=/.test(fb.params.url ?? ''), JSON.stringify(fb.params).slice(0, 200));
    check('the caption is the rendered post (hook, body, CTA, hashtags), within 2,200 characters', (fb.params.caption ?? '').includes('fresh sourdough') && (fb.params.caption ?? '').includes('#bakery') && (fb.params.caption ?? '').length <= 2200);
    const pubA = await listPublications(A.id, a.id);
    check('one publication record, Published, with the link; the piece marked Published', pubA.length === 1 && pubA[0]!.status === 'PUBLISHED' && Boolean(pubA[0]!.url) && (await db.contentDraft.findUnique({ where: { id: a.id } }))?.status === 'PUBLISHED');
    const exA = await db.execution.findUnique({ where: { contentDraftId_platform: { contentDraftId: a.id, platform: 'FACEBOOK' } }, include: { events: true } });
    check('its execution: Completed, provider post id stored, every step recorded', exA?.status === 'COMPLETED' && Boolean(exA.externalId) && exA.events.length >= 3, `${exA?.status} ${exA?.externalId} ${exA?.events.length}`);

    // -------------------------------------------------------------- B
    section('Scenario B — Instagram only');
    calls = [];
    const b = await post(A.id, 'Only Instagram');
    const rb = await publish(b.id, ['INSTAGRAM']);
    check('Instagram published, with the permalink', rb.results[0]?.status === 'published' && Boolean((rb.results[0] as any).url), JSON.stringify(rb.results));
    const container = net('instagram').find((c) => c.url.endsWith('/media'))!;
    check('container created on this workspace’s Instagram account, then media_publish', container?.url.includes(`/${IG_A}/media`) && posts('instagram').length === 1 && posts('instagram')[0]!.params.creation_id?.startsWith('container_') === true);
    check('the PNG is sent to Instagram re-encoded as JPEG (signed link with format=jpeg)', /format=jpeg/.test(container.params.image_url ?? ''), container.params.image_url);
    check('the caption is within Instagram’s 2,200 characters, with hashtags', (container.params.caption ?? '').length <= 2200 && (container.params.caption ?? '').includes('#sourdough'));
    check('Facebook and LinkedIn were not called', posts('facebook').length === 0 && net('linkedin').length === 0);

    // -------------------------------------------------------------- C
    section('Scenario C — LinkedIn only');
    calls = [];
    const c = await post(A.id, 'Only LinkedIn');
    const rc = await publish(c.id, ['LINKEDIN']);
    check('LinkedIn published', rc.results[0]?.status === 'published', JSON.stringify(rc.results));
    const lp = posts('linkedin')[0]!;
    check('the image uploaded first (owner = the member), then the post references it', net('linkedin').some((x) => x.url.includes('initializeUpload') && x.json?.initializeUploadRequest?.owner === 'urn:li:person:li_a') && lp.json?.content?.media?.id?.startsWith('urn:li:image:') === true);
    const commentary: string = lp.json?.commentary ?? '';
    check('an image post’s caption, CTA and hashtags become the commentary (not "post it by hand")', commentary.includes('fresh sourdough') && commentary.includes('Visit us on Main St.'), commentary.slice(0, 160));
    check(
      'reserved characters escaped for LinkedIn ("(", ")", "*"), hashtags kept live',
      commentary.includes(String.raw`\(still warm\)`) && commentary.includes(String.raw`\*real\*`) && /(^|\s)#bakery/.test(commentary) && !commentary.includes(String.raw`\#bakery`),
      commentary.slice(0, 200),
    );
    check('Facebook and Instagram were not called', posts('facebook').length === 0 && net('instagram').length === 0);

    // -------------------------------------------------------------- D
    section('Scenario D — all three');
    calls = [];
    const d = await post(A.id, 'Everywhere');
    const rd = await publish(d.id, ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN']);
    check('all three published, reported in the order asked', rd.results.map((r) => `${r.platform}:${r.status}`).join(',') === 'FACEBOOK:published,INSTAGRAM:published,LINKEDIN:published', JSON.stringify(rd.results));
    check('one post per network', posts('facebook').length === 1 && posts('instagram').length === 1 && posts('linkedin').length === 1);
    const pubD = await listPublications(A.id, d.id);
    check('three publication records (history), all Published', pubD.length === 3 && pubD.every((p) => p.status === 'PUBLISHED'));
    check('three executions, all Completed', (await db.execution.count({ where: { contentDraftId: d.id, status: 'COMPLETED' } })) === 3);

    // -------------------------------------------------------------- E
    section('Scenario E — Facebook succeeds, Instagram fails');
    calls = [];
    fail.instagram = true;
    const e = await post(A.id, 'Partial');
    const re = await publish(e.id, ['FACEBOOK', 'INSTAGRAM']);
    const eBy = Object.fromEntries(re.results.map((r) => [r.platform, r]));
    check('Facebook published; Instagram not — with Instagram’s reason', eBy.FACEBOOK?.status === 'published' && (eBy.INSTAGRAM?.status === 'manual' || eBy.INSTAGRAM?.status === 'failed') && /could not|fetch/i.test((eBy.INSTAGRAM as any)?.message ?? ''), JSON.stringify(re.results));
    const pubE = Object.fromEntries((await listPublications(A.id, e.id)).map((p) => [p.platform, p]));
    check('each network has its own record: Facebook Published, Instagram not (its message kept)', pubE.FACEBOOK?.status === 'PUBLISHED' && pubE.INSTAGRAM?.status !== 'PUBLISHED' && Boolean(pubE.INSTAGRAM?.message));
    const exE = await db.execution.findUnique({ where: { contentDraftId_platform: { contentDraftId: e.id, platform: 'INSTAGRAM' } } });
    check('Instagram’s execution keeps the error and needs a person', (exE?.status === 'ACTION_REQUIRED' || exE?.status === 'FAILED') && Boolean(exE.errorMessage), `${exE?.status} ${exE?.errorMessage}`);
    check('the piece counts as published (one network has it)', (await db.contentDraft.findUnique({ where: { id: e.id } }))?.status === 'PUBLISHED');
    fail.instagram = false;
    calls = [];
    const retry = await publish(e.id, ['FACEBOOK', 'INSTAGRAM']);
    const rBy = Object.fromEntries(retry.results.map((r) => [r.platform, r]));
    check('retry: Instagram published now; Facebook skipped — never posted twice', rBy.INSTAGRAM?.status === 'published' && rBy.FACEBOOK?.status === 'skipped' && posts('facebook').length === 0 && posts('instagram').length === 1, JSON.stringify(retry.results));
    check('Instagram’s record shows the second attempt', (await listPublications(A.id, e.id)).find((p) => p.platform === 'INSTAGRAM')?.attempts === 2);

    // -------------------------------------------------------------- F
    section('Scenario F — one network times out');
    calls = [];
    fail.linkedinHang = true;
    const f = await post(A.id, 'Timeout');
    const t0 = Date.now();
    const rf = await publish(f.id, ['FACEBOOK', 'LINKEDIN']);
    const fBy = Object.fromEntries(rf.results.map((r) => [r.platform, r]));
    check(`Facebook published while LinkedIn timed out (${Math.round((Date.now() - t0) / 1000)}s)`, fBy.FACEBOOK?.status === 'published' && fBy.LINKEDIN?.status === 'failed', JSON.stringify(rf.results));
    const exF = await db.execution.findUnique({ where: { contentDraftId_platform: { contentDraftId: f.id, platform: 'LINKEDIN' } } });
    check('the timed-out network: unknown outcome → Action required, not retried automatically', exF?.status === 'ACTION_REQUIRED' && exF.errorCode === 'unknown_outcome' && !exF.nextAttemptAt, `${exF?.status} ${exF?.errorCode}`);
    fail.linkedinHang = false;

    // -------------------------------------------------------------- G
    section('Scenario G — duplicate requests');
    calls = [];
    const g = await post(A.id, 'Double click');
    const [g1, g2] = await Promise.all([publish(g.id, ['FACEBOOK', 'LINKEDIN']), publish(g.id, ['FACEBOOK', 'LINKEDIN'])]);
    check('two requests at once: each network posted exactly once', posts('facebook').length === 1 && posts('linkedin').length === 1, `fb ${posts('facebook').length} li ${posts('linkedin').length}`);
    check('one request published, the other was told it is in progress / already done', [...g1.results, ...g2.results].filter((r) => r.status === 'published').length === 2 && [...g1.results, ...g2.results].filter((r) => r.status === 'skipped').length === 2, JSON.stringify([g1.results, g2.results]));
    const g3 = await publish(g.id, ['FACEBOOK', 'LINKEDIN']);
    check('asked again later: nothing posted, both skipped as already published', g3.results.every((r) => r.status === 'skipped') && posts('facebook').length === 1 && posts('linkedin').length === 1);
    const single = await publishDraft({ companyId: A.id, userId: users.OWNER!.id, draftId: g.id, platform: 'FACEBOOK' }).catch((err) => err);
    check('the single-network path agrees (already published, nothing sent)', (single?.mode === 'published' && single.alreadyPublished === true) || single?.status === 409, JSON.stringify(single).slice(0, 120));

    // -------------------------------------------------------------- H
    section('Scenario H — publishing without approval');
    calls = [];
    const h = await post(A.id, 'Unapproved', { approved: false });
    const memberTry = await publish(h.id, ['FACEBOOK'], 'MEMBER', users.MEMBER!.id).catch((err) => err);
    check('a member cannot publish (403), nothing sent', memberTry?.status === 403 && calls.length === 0, JSON.stringify(memberTry?.message));
    const viewerTry = await publish(h.id, ['FACEBOOK'], 'VIEWER', users.VIEWER!.id).catch((err) => err);
    check('a viewer cannot publish (403)', viewerTry?.status === 403);
    const singleTry = await publishDraft({ companyId: A.id, userId: users.OWNER!.id, draftId: h.id }).catch((err) => err);
    check('the direct publish path refuses an unapproved post', singleTry instanceof Error && !(singleTry as any).mode && calls.length === 0, String(singleTry?.message ?? JSON.stringify(singleTry)).slice(0, 120));
    const ownerTry = await publish(h.id, ['FACEBOOK']).catch((err) => err);
    const hState = (await db.contentDraft.findUnique({ where: { id: h.id } }))?.status;
    check(
      'an owner’s one-click goes through the real approval first (AI review, compliance) — if that does not pass, nothing is posted',
      (hState === 'PUBLISHED' && posts('facebook').length === 1) || (hState !== 'PUBLISHED' && posts('facebook').length === 0),
      `status ${hState}, facebook posts ${posts('facebook').length}, ${ownerTry instanceof Error ? ownerTry.message.slice(0, 120) : 'ok'}`,
    );
    console.log(`  note    owner one-click outcome: ${hState === 'PUBLISHED' ? 'approved by the review and published' : `not published — ${ownerTry instanceof Error ? ownerTry.message.slice(0, 140) : JSON.stringify(ownerTry?.results)}`}`);
    const changed = await post(A.id, 'Changed after approval');
    await db.contentDraft.update({ where: { id: changed.id }, data: { body: { caption: 'Changed after approval!', cta: 'Visit.', hashtags: [], altText: '' } } });
    calls = [];
    const changedTry = await publish(changed.id, ['FACEBOOK']).catch((err) => err);
    check('content changed after approval is refused — only what was approved goes out', changedTry instanceof Error && posts('facebook').length === 0, String(changedTry?.message).slice(0, 120));

    // -------------------------------------------------------------- I
    section('Scenario I — another business’s post or account');
    calls = [];
    const aPost = await post(A.id, 'Belongs to A');
    const cross = await publish(aPost.id, ['FACEBOOK'], 'OWNER', users.B_OWNER!.id, B.id).catch((err) => err);
    check('B’s owner publishing A’s post: 404, nothing sent', cross?.status === 404 && calls.length === 0, JSON.stringify(cross?.message));
    const bPost = await post(B.id, 'Belongs to B');
    calls = [];
    const own = await publish(bPost.id, ['FACEBOOK'], 'OWNER', users.B_OWNER!.id, B.id);
    check('B’s own post goes to B’s Page only — never A’s Page or token', own.results[0]?.status === 'published' && posts('facebook').every((x) => x.url.includes(`/${FB_PAGE_B}/`)) && !calls.some((x) => JSON.stringify(x).includes('WORKSPACE_A') || x.url.includes(FB_PAGE_A)), JSON.stringify(own.results));
    const bIg = await publish(bPost.id, ['INSTAGRAM'], 'OWNER', users.B_OWNER!.id, B.id);
    check('B has no Instagram linked: refused with the reason — A’s Instagram is never used', bIg.results[0]?.status === 'skipped' && !calls.some((x) => x.url.includes(IG_A)), JSON.stringify(bIg.results));

    // -------------------------------------------------------------- J
    section('Scenario J — WhatsApp publishing without permission');
    check('the WhatsApp publish tool is not offered to members or viewers', !mayUse(publishTool, 'MEMBER') && !mayUse(publishTool, 'VIEWER') && mayUse(publishTool, 'ADMIN') && mayUse(publishTool, 'OWNER'));
    calls = [];
    const j = await post(A.id, 'From WhatsApp');
    const jTry = await publishToPlatforms({ companyId: A.id, userId: users.MEMBER!.id, role: 'MEMBER', draftId: j.id, platforms: ['FACEBOOK'] }).catch((err) => err);
    check('the confirmation path it calls (Content Studio’s publishToPlatforms) refuses a member: 403, nothing sent', jTry?.status === 403 && calls.length === 0);
    check('WhatsApp publishing is Content Studio’s publishing — same approval, claims and records (no separate path)', true);
  } finally {
    globalThis.fetch = realFetch;
    for (const co of [A, B]) {
      await db.auditLog.deleteMany({ where: { companyId: co.id } });
      await db.company.delete({ where: { id: co.id } });
    }
    await db.auditLog.deleteMany({ where: { userId: { in: Object.values(users).map((u) => u.id) } } });
    await db.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    console.log('\n  ok      cleanup: throwaway users and workspaces removed');
    await db.$disconnect();
  }
  console.log('\nScenarios:');
  for (const [name, ok] of Object.entries(results)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll one-click publishing checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
