/**
 * One-click publishing to Facebook, Instagram and LinkedIn (Phase 6), against
 * the running app and the real database. There is no live Meta or LinkedIn
 * account here, so no network accepts a post: this checks everything Aura
 * decides — and that it never claims a publish that did not happen.
 *
 *   Preview    each network's exact text, and why it cannot go
 *   Refusals   members, cross-site requests, unchosen networks
 *   Honesty    a network that refuses → "post by hand", recorded as such; the
 *              piece is NOT marked published
 *   Once       two clicks at once → one attempt per network
 *   Retry      only a person's retry tries again (attempts counted)
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:multi-publish
 */
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-multi-${STAMP}!`;

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

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const owner = await db.user.create({ data: { email: `zzverify-multi-o-${STAMP}@example.test`, passwordHash: hash } });
  const member = await db.user.create({ data: { email: `zzverify-multi-m-${STAMP}@example.test`, passwordHash: hash } });
  const company = await db.company.create({ data: { name: `zzverify Multi ${STAMP}`, slug: `zzverify-multi-${STAMP}` } });
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId: company.id, role: 'OWNER' },
      { userId: member.id, companyId: company.id, role: 'MEMBER' },
    ],
  });
  const draft = await db.contentDraft.create({
    data: {
      companyId: company.id,
      type: 'LINKEDIN_POST',
      platform: 'LINKEDIN',
      status: 'APPROVED',
      title: 'Brunch',
      body: {
        hook: 'Our weekend brunch is back.',
        paragraphs: ['Fresh pastries from our own oven.', 'Slow coffee, brewed to order.', 'A table by the window if you come early.'],
        cta: 'Book a table for this weekend.',
        hashtags: ['brunch'],
      },
    },
  });
  // A Facebook connection whose token Meta will refuse — no real account here.
  await db.connection.create({
    data: {
      companyId: company.id,
      connectorId: 'meta',
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt('NOT_A_REAL_TOKEN'),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      accountLabel: 'Test Page',
      metadata: { pageId: '111', pageName: 'Test Page', pages: [{ id: '111', name: 'Test Page', ig: null }] },
    },
  });
  const ownerWeb = new Web();
  const memberWeb = new Web();
  const path = `/api/content/drafts/${draft.id}/publications`;

  try {
    await ownerWeb.signIn(owner.email);
    await memberWeb.signIn(member.email);

    console.log('Preview');
    const pv = await ownerWeb.req('GET', path);
    const by = Object.fromEntries(((pv.json.preview ?? []) as any[]).map((p) => [p.platform, p]));
    check('each network, with its exact text', by.FACEBOOK?.text?.startsWith('Our weekend brunch is back.') && Boolean(by.LINKEDIN?.text), JSON.stringify(pv.json).slice(0, 160));
    check('Facebook can go (connected)', by.FACEBOOK?.ready === true, JSON.stringify(by.FACEBOOK?.blockers));
    check('Instagram cannot: no Instagram linked, no image', by.INSTAGRAM?.ready === false && /Instagram/.test(by.INSTAGRAM?.blockers?.join(' ')), by.INSTAGRAM?.blockers?.join(' '));
    check('LinkedIn cannot: not connected', by.LINKEDIN?.ready === false && /LinkedIn isn’t connected/.test(by.LINKEDIN?.blockers?.join(' ')), by.LINKEDIN?.blockers?.join(' '));

    console.log('Refusals');
    const asMember = await memberWeb.req('POST', path, { platforms: ['FACEBOOK'] });
    check('a member cannot publish', asMember.status === 403, `HTTP ${asMember.status}`);
    const crossSite = await ownerWeb.req('POST', path, { platforms: ['FACEBOOK'] }, 'https://evil.example');
    check('a cross-site request is refused', crossSite.status === 403, `HTTP ${crossSite.status}`);
    check('nothing was attempted', (await db.contentPublication.count({ where: { contentDraftId: draft.id } })) === 0);

    console.log('Honesty and once');
    const [a, b] = await Promise.all([
      ownerWeb.req('POST', path, { platforms: ['FACEBOOK', 'LINKEDIN'] }),
      ownerWeb.req('POST', path, { platforms: ['FACEBOOK', 'LINKEDIN'] }),
    ]);
    const all = [...(a.json.results ?? []), ...(b.json.results ?? [])];
    const fb = await db.contentPublication.findUnique({ where: { contentDraftId_platform: { contentDraftId: draft.id, platform: 'FACEBOOK' } } });
    check('two clicks at once: one attempt at Facebook', fb?.attempts === 1 || (fb?.attempts === 2 && all.some((r) => r.platform === 'FACEBOOK' && r.status === 'skipped')), `attempts ${fb?.attempts}`);
    console.log(`          (Facebook attempts: ${fb?.attempts}; results: ${all.filter((r) => r.platform === 'FACEBOOK').map((r) => r.status).join(', ')})`);
    check('Meta refused the token → “post by hand”, recorded, with the reason', fb?.status === 'MANUAL' && Boolean(fb.message), `${fb?.status} ${fb?.message}`);
    check('LinkedIn skipped, with its reason', all.some((r) => r.platform === 'LINKEDIN' && r.status === 'skipped' && /LinkedIn isn’t connected/.test(r.message)));
    check('no network claimed success', !all.some((r) => r.status === 'published'));
    check('the piece is NOT marked published', (await db.contentDraft.findUnique({ where: { id: draft.id } }))?.status === 'APPROVED');
    const audit = await db.auditLog.findFirst({ where: { companyId: company.id, action: 'CONTENT_PUBLISH_REQUESTED' } });
    check('the request is audited with its networks', JSON.stringify(audit?.metadata).includes('FACEBOOK'));

    console.log('Retry');
    const before = fb?.attempts ?? 0;
    const retry = await ownerWeb.req('POST', path, { platforms: ['FACEBOOK'] });
    const after = await db.contentPublication.findUnique({ where: { contentDraftId_platform: { contentDraftId: draft.id, platform: 'FACEBOOK' } } });
    check('a person’s retry tries again, counted', retry.status === 200 && after?.attempts === before + 1, `${retry.status} ${after?.attempts}`);
    const history = await ownerWeb.req('GET', path);
    check('the history shows it', (history.json.history ?? []).some((h: any) => h.platform === 'FACEBOOK' && h.status === 'MANUAL'));

    console.log('Page');
    const page = await fetch(`${BASE}/dashboard/content/${draft.id}`, { headers: { cookie: ownerWeb.cookie() } });
    check('the draft page renders with the publish card', page.status === 200, `HTTP ${page.status}`);
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ companyId: company.id }, { userId: { in: [owner.id, member.id] } }] } });
    await db.company.delete({ where: { id: company.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
    console.log('  ok      cleanup: throwaway users, workspace, draft, publications and audit entries removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll multi-publish checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
