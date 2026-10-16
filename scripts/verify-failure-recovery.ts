/**
 * Failure & recovery, end to end on the running app and the real database:
 *
 *   Stale save      an edit made on an older version is refused (409), the
 *                   draft is untouched, the message says the edits are kept
 *   Duplicate       approving approved work is refused, not repeated
 *   Outdated        generating for a suggestion that is gone: 409 + what to do,
 *                   no draft written
 *   Provider down   when the writer cannot answer, one plain message (never raw
 *                   provider text); when it can, a retry with the same key
 *                   returns the same draft (no duplicate)
 *   Bulk            a refused bulk approval says why for each item
 *   Session lost    API answers 401 JSON saying work on the page is kept
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:failure-recovery
 */
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-fail-${STAMP}!`;

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
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: { Origin: BASE, cookie: this.cookie(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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

const BODY = { hook: 'Our weekend brunch is back.', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Book a table.', hashtags: [] };

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const owner = await db.user.create({ data: { email: `zzverify-fail-o-${STAMP}@example.test`, passwordHash: hash } });
  const member = await db.user.create({ data: { email: `zzverify-fail-m-${STAMP}@example.test`, passwordHash: hash } });
  const company = await db.company.create({ data: { name: `zzverify Fail ${STAMP}`, slug: `zzverify-fail-${STAMP}`, website: 'https://brunch.example' } });
  await db.companyMember.createMany({ data: [{ userId: owner.id, companyId: company.id, role: 'OWNER' }, { userId: member.id, companyId: company.id, role: 'MEMBER' }] });
  const draft = await db.contentDraft.create({ data: { companyId: company.id, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'DRAFT', title: 'Brunch', body: BODY } });
  const approved = await db.contentDraft.create({ data: { companyId: company.id, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'APPROVED', title: 'Approved', body: BODY } });
  const me = new Web();
  const mem = new Web();
  try {
    await me.signIn(owner.email);
    await mem.signIn(member.email);

    console.log('Stale save — never last-write-wins');
    const stale = new Date(draft.updatedAt.getTime() - 60_000).toISOString();
    const patch = await me.req('PATCH', `/api/content/drafts/${draft.id}`, { body: { ...BODY, hook: 'Overwrite attempt' }, baseUpdatedAt: stale });
    const untouched = await db.contentDraft.findUnique({ where: { id: draft.id } });
    check('an edit made on an older version is refused (409), saying the edits are kept', patch.status === 409 && /edits are kept/.test(patch.json.error ?? ''), `${patch.status} ${patch.json.error}`);
    check('…and the draft is untouched', JSON.stringify(untouched?.body).includes('Our weekend brunch is back.'));
    const reviewSave = await me.req('POST', `/api/review/content/${draft.id}`, { action: 'save', edits: { hook: 'x' }, baseUpdatedAt: stale });
    check('the review screen’s stale save is refused the same way', reviewSave.status === 409, `${reviewSave.status} ${reviewSave.json.error}`);
    const fresh = await me.req('PATCH', `/api/content/drafts/${draft.id}`, { body: { ...BODY, hook: 'A current edit' }, baseUpdatedAt: untouched!.updatedAt.toISOString() });
    check('an edit on the current version saves', fresh.status === 200, `${fresh.status} ${JSON.stringify(fresh.json).slice(0, 120)}`);

    console.log('Duplicate approval');
    const again = await me.req('POST', `/api/content/drafts/${approved.id}/status`, { action: 'approve' });
    check('approving approved work is refused (409), not repeated', again.status === 409 && /already approved/.test(again.json.error ?? ''), `${again.status} ${again.json.error}`);

    console.log('Recommendation outdated');
    const before = await db.contentDraft.count({ where: { companyId: company.id } });
    const gone = await me.req('POST', '/api/content/generate', { type: 'LINKEDIN_POST', source: { kind: 'BRIEF', brief: 'Brunch is back' }, recommendationId: 'rec_does_not_exist', idempotencyKey: `k-gone-${STAMP}` });
    check('a suggestion that is gone: 409 with what to do', gone.status === 409 && /no longer available/.test(gone.json.error ?? '') && gone.json.fix?.href === '/dashboard/suggestions', `${gone.status} ${gone.json.error}`);
    check('…and no draft was written', (await db.contentDraft.count({ where: { companyId: company.id } })) === before);

    console.log('Writer down, or a retry');
    const key = `k-gen-${STAMP}`;
    const gen = await me.req('POST', '/api/content/generate', { type: 'LINKEDIN_POST', source: { kind: 'BRIEF', brief: 'Our weekend brunch menu is back, with local eggs.' }, idempotencyKey: key });
    if (gen.status === 201) {
      const retry = await me.req('POST', '/api/content/generate', { type: 'LINKEDIN_POST', source: { kind: 'BRIEF', brief: 'Our weekend brunch menu is back, with local eggs.' }, idempotencyKey: key });
      check('a retry with the same key returns the same draft — no duplicate', retry.status === 200 && retry.json.id === gen.json.id && retry.json.reused === true, `${retry.status}`);
    } else {
      check(
        'the writer could not answer: one plain message, never raw provider text',
        gen.status === 503 && /writer/i.test(gen.json.error ?? '') && !/Gemini API error|"code"|\{/.test(gen.json.error ?? ''),
        `${gen.status} ${String(gen.json.error).slice(0, 120)}`,
      );
      check('…and nothing was written', (await db.contentDraft.count({ where: { companyId: company.id } })) === before);
      console.log('  note    the live writer is unavailable here, so the idempotent retry is covered by tests/failure-recovery.test.ts');
    }

    console.log('Bulk approval says why');
    const bulk = await mem.req('POST', '/api/content/drafts/bulk', { ids: [draft.id], action: 'approve' });
    check('a refused bulk approval lists each item with its reason', bulk.status === 200 && bulk.json.failed?.[0]?.error?.length > 0 && Array.isArray(bulk.json.notProcessed), JSON.stringify(bulk.json).slice(0, 160));

    console.log('Session lost');
    const anon = await fetch(`${BASE}/api/content/drafts/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ ids: [draft.id], action: 'approve' }) });
    const anonBody = (await anon.json().catch(() => ({}))) as { error?: string };
    check('an API call without a session is 401 JSON saying the work on the page is kept', anon.status === 401 && /work on this page is kept/.test(anonBody.error ?? ''), `${anon.status} ${anonBody.error}`);
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ companyId: company.id }, { userId: { in: [owner.id, member.id] } }] } });
    await db.company.delete({ where: { id: company.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
    console.log('  ok      cleanup: throwaway users and workspace removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll failure & recovery checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
