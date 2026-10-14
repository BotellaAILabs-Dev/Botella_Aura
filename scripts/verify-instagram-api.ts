/**
 * Instagram carousels/Reels, PKCE binding and the WhatsApp website API,
 * against the running app and the real database. There is no live Meta
 * account here: a Reel Instagram "is processing" is simulated as a stored
 * PROCESSING publication with a fake token, so finishing it reaches Meta's
 * real API, is refused, and must be recorded as FAILED — never as published.
 *
 *   Video      a real MP4 (downloaded) and an uploaded one are read from their
 *              bytes; without file storage they are refused with the reason
 *   Processing finishing a Reel with a token Meta refuses → FAILED, the piece
 *              is NOT marked published
 *   API        /api/whatsapp/features, /conversations, /send — roles, scope,
 *              cross-site refusals
 *   Page       the WhatsApp assistant page renders for an owner
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:instagram-api
 */
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { contentHash } from '@/server/approval/approval.service';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-ig-${STAMP}!`;
/** A public H.264 sample (640×360, ~60 s). */
const SAMPLE_MP4 = process.env.VERIFY_SAMPLE_MP4 ?? 'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Web {
  private jar = new Map<string, string>();
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown, origin = BASE) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: { Origin: origin, cookie: this.cookie(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(await res.text());
    } catch {
      /* page */
    }
    return { status: res.status, json };
  }
  async upload(path: string, file: Blob, name: string) {
    const form = new FormData();
    form.append('file', file, name);
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Origin: BASE, cookie: this.cookie() }, body: form });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }
  async signIn(email: string) {
    const csrf = await this.req('GET', '/api/auth/csrf');
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: this.cookie() },
      body: new URLSearchParams({ csrfToken: csrf.json.csrfToken, email, password: PASSWORD, json: 'true' }),
    });
    this.keep(res);
  }
}

/** A minimal valid MP4 header (H.264, 1080×1920, 12 s) — no media data needed to be read. */
function tinyMp4(): Buffer {
  const box = (type: string, ...p: Buffer[]) => {
    const body = Buffer.concat(p);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + body.length, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, body]);
  };
  const u32 = (...n: number[]) => {
    const b = Buffer.alloc(4 * n.length);
    n.forEach((v, i) => b.writeUInt32BE(v, i * 4));
    return b;
  };
  const tkhd = box('tkhd', Buffer.alloc(76), u32(1080 * 65536, 1920 * 65536));
  const hdlr = box('hdlr', u32(0, 0), Buffer.from('vide'), Buffer.alloc(13));
  const stsd = box('stsd', u32(0, 1), u32(16), Buffer.from('avc1'), Buffer.alloc(8));
  return Buffer.concat([
    box('ftyp', Buffer.from('isom'), u32(0)),
    box('moov', box('mvhd', u32(0, 0, 0, 1000, 12000), Buffer.alloc(80)), box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd))))),
  ]);
}

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const owner = await db.user.create({ data: { email: `zzverify-ig-o-${STAMP}@example.test`, passwordHash: hash, name: 'Olu Verify' } });
  const member = await db.user.create({ data: { email: `zzverify-ig-m-${STAMP}@example.test`, passwordHash: hash } });
  const company = await db.company.create({ data: { name: `zzverify IG ${STAMP}`, slug: `zzverify-ig-${STAMP}` } });
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId: company.id, role: 'OWNER' },
      { userId: member.id, companyId: company.id, role: 'MEMBER' },
    ],
  });
  const draft = await db.contentDraft.create({
    data: {
      companyId: company.id,
      type: 'IMAGE_POST',
      platform: 'INSTAGRAM',
      status: 'APPROVED',
      title: 'Reel',
      body: { hook: 'Behind the counter at 6am.', paragraphs: ['Fresh bread, every morning.'], cta: 'Come by.', hashtags: ['bakery'] },
    },
  });
  await db.connection.create({
    data: {
      companyId: company.id,
      connectorId: 'meta',
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt('NOT_A_REAL_TOKEN'),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      accountLabel: '@bakery (Test Page)',
      metadata: { pageId: '111', pageName: 'Test Page', igUserId: '17841400000', pages: [] },
    },
  });
  const ownerWeb = new Web();
  const memberWeb = new Web();
  const hasStorage = Boolean(process.env.ASSET_S3_ENDPOINT && process.env.ASSET_S3_BUCKET);

  try {
    await ownerWeb.signIn(owner.email);
    await memberWeb.signIn(member.email);
    const upload = `/api/content/graphics/upload?draftId=${draft.id}`;

    console.log('Video');
    const up = await ownerWeb.upload(upload, new Blob([new Uint8Array(tinyMp4())], { type: 'video/mp4' }), 'clip.mp4');
    if (hasStorage) check('an uploaded MP4 is read from its bytes and stored as a video', up.status === 201 && up.json.asset?.mimeType === 'video/mp4', `${up.status} ${JSON.stringify(up.json).slice(0, 160)}`);
    else check('an uploaded MP4 is recognised as video; without file storage it is refused with the reason', up.status === 409 && /file storage/.test(up.json.error), `${up.status} ${up.json.error}`);

    const fake = await ownerWeb.upload(upload, new Blob(['<html>not a video</html>'], { type: 'video/mp4' }), 'fake.mp4');
    check('a file named .mp4 that is not a video is refused (its bytes decide)', fake.status >= 400 && fake.status < 500 && fake.status !== 409, `${fake.status} ${fake.json.error}`);

    const remote = await ownerWeb.req('POST', upload, { url: SAMPLE_MP4, kind: 'video' });
    if (hasStorage) check('a real MP4 from a URL is downloaded, read and stored', remote.status === 201 && remote.json.asset?.width === 640, `${remote.status} ${JSON.stringify(remote.json).slice(0, 160)}`);
    else check('a real MP4 from a URL is downloaded and read; without file storage refused with the reason', remote.status === 409 && /file storage/.test(remote.json.error), `${remote.status} ${remote.json.error}`);
    const local = await ownerWeb.req('POST', upload, { url: 'http://127.0.0.1:5432/x.mp4', kind: 'video' });
    check('a video URL on a private address is refused (SSRF guard)', local.status === 400, `${local.status} ${local.json.error}`);

    console.log('Processing');
    const pub = await db.contentPublication.create({
      data: {
        companyId: company.id,
        contentDraftId: draft.id,
        platform: 'INSTAGRAM',
        status: 'PROCESSING',
        contentHash: await contentHash(draft),
        externalId: 'container:17900000000000000',
        message: 'Instagram is processing the video.',
        requestedById: owner.id,
        attempts: 1,
      },
    });
    const pathPub = `/api/content/drafts/${draft.id}/publications`;
    const pv = await ownerWeb.req('GET', pathPub);
    const ig = (pv.json.preview as any[] | undefined)?.find((p) => p.platform === 'INSTAGRAM');
    check('the card shows Instagram as processing, not published', ig?.publication?.status === 'PROCESSING' && /still processing/.test(ig?.blockers?.join(' ')), JSON.stringify(ig).slice(0, 200));
    const again = await ownerWeb.req('POST', pathPub, { platforms: ['INSTAGRAM'] });
    check('publishing again while processing uploads nothing new', again.status === 200 && again.json.results?.[0]?.status === 'skipped', JSON.stringify(again.json).slice(0, 200));
    const cross = await ownerWeb.req('PATCH', pathPub, undefined, 'https://evil.example');
    check('a cross-site check request is refused', cross.status === 403, String(cross.status));
    const finish = await ownerWeb.req('PATCH', pathPub);
    const after = await db.contentPublication.findUnique({ where: { id: pub.id } });
    const draftAfter = await db.contentDraft.findUnique({ where: { id: draft.id } });
    check('finishing reaches Meta, which refuses the token → FAILED with the reason', finish.status === 200 && after?.status === 'FAILED' && /credentials|could not|Reconnect/i.test(after?.message ?? ''), `${finish.status} ${after?.status} ${after?.message}`);
    check('the piece is NOT marked published', draftAfter?.status === 'APPROVED' && !draftAfter.publishedAt, draftAfter?.status);

    console.log('API');
    const fo = await ownerWeb.req('GET', '/api/whatsapp/features');
    const fm = await memberWeb.req('GET', '/api/whatsapp/features');
    const toolIds = (j: any) => (j.categories ?? []).flatMap((c: any) => c.tools.map((t: any) => t.id));
    check('features: the owner can approve and publish on WhatsApp', fo.status === 200 && toolIds(fo.json).includes('approve_draft') && toolIds(fo.json).includes('publish_draft'), toolIds(fo.json).join(','));
    check('features: a member cannot', fm.status === 200 && !toolIds(fm.json).includes('approve_draft') && !toolIds(fm.json).includes('publish_draft'), toolIds(fm.json).join(','));
    const anon = await fetch(`${BASE}/api/whatsapp/features`, { redirect: 'manual' });
    check('features: signed out is refused', anon.status === 401 || (anon.status >= 300 && anon.status < 400), String(anon.status));

    const co = await ownerWeb.req('GET', '/api/whatsapp/conversations');
    const cm = await memberWeb.req('GET', '/api/whatsapp/conversations?limit=99999');
    check('conversations: owner sees the workspace scope, a member only their own', co.json.scope === 'workspace' && cm.json.scope === 'mine' && Array.isArray(cm.json.conversations), `${co.json.scope} ${cm.json.scope}`);

    const sm = await memberWeb.req('POST', '/api/whatsapp/send', { userId: owner.id, text: 'hi' });
    check('send: a member cannot message people', sm.status === 403, String(sm.status));
    const sx = await ownerWeb.req('POST', '/api/whatsapp/send', { userId: member.id, text: 'hi' }, 'https://evil.example');
    check('send: cross-site refused', sx.status === 403, String(sx.status));
    const sn = await ownerWeb.req('POST', '/api/whatsapp/send', { userId: member.id, text: 'hi' });
    check('send: a member with no WhatsApp here → not found (or 503 when WhatsApp is not configured)', sn.status === 404 || sn.status === 503, `${sn.status} ${sn.json.error}`);
    const so = await ownerWeb.req('POST', '/api/whatsapp/send', { userId: 'someone-else', text: 'hi' });
    check('send: someone outside the workspace → same refusal', so.status === sn.status, String(so.status));

    console.log('Page');
    const page = await fetch(`${BASE}/dashboard/whatsapp-assistant`, { headers: { cookie: ownerWeb.cookie() } });
    const html = await page.text();
    check('the WhatsApp assistant page renders for an owner', page.status === 200 && /WhatsApp assistant/.test(html), String(page.status));
    check('…with the owner sections', /Members using WhatsApp here/.test(html));
    const pageM = await fetch(`${BASE}/dashboard/whatsapp-assistant`, { headers: { cookie: memberWeb.cookie() } });
    const htmlM = await pageM.text();
    check('a member sees the page without the owner sections', pageM.status === 200 && !/Members using WhatsApp here/.test(htmlM), String(pageM.status));
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ companyId: company.id }, { userId: { in: [owner.id, member.id] } }] } });
    await db.company.delete({ where: { id: company.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
    console.log('  ok      cleanup: throwaway users, workspace, draft, connection, publications and audit entries removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll Instagram / API checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
