/**
 * WhatsApp ↔ Aura account linking (Phase 3), against the running app and the
 * real database: a throwaway user with two workspaces signs in through the
 * real NextAuth login; WhatsApp messages are signed webhooks exactly as Meta
 * sends them.
 *
 *   Sign-in link   "Hi" from an unknown number → a single-use link to Aura
 *   Page           signed out → Aura's login (and back); signed in → which
 *                  number is being linked; viewing does not use the link up
 *   Confirm        a real session confirms → a code; a replay is refused;
 *                  a cross-site confirm is refused
 *   Code           a code from another number links nothing; from the right
 *                  number it links
 *   Workspaces     a forged id for someone else's workspace is refused; their
 *                  own works; the role shown is their current one
 *   Log out        unlinks; the next message starts over
 *
 * Run (app running with the same WHATSAPP_* values):
 *   VERIFY_BASE_URL=http://localhost:3001 pnpm verify:whatsapp-link
 */
import { resolveSentUrl } from './lib/wa-stub';
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import { keyedHash } from '@/lib/crypto';
import { signPayload } from '@/lib/whatsapp';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const STAMP = Date.now();
const PASSWORD = `Zz-walink-${STAMP}!`;
// 555-01xx numbers are reserved for fiction.
const FROM = `1555011${String(STAMP).slice(-4)}`;
const OTHER = `1555012${String(STAMP).slice(-4)}`;

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  private jar = new Map<string, string>();
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  private cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        Origin: BASE,
        cookie: this.cookie(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* a page */
    }
    return { status: res.status, json, text, location: res.headers.get('location') };
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

async function say(from: string, text: string, replyId?: string) {
  const id = `wamid.WALINK${STAMP}.${Math.random().toString(36).slice(2)}`;
  const message = replyId
    ? { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: replyId, title: text } } }
    : { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } };
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: from, profile: { name: 'Verify' } }], messages: [message] } }] }],
  });
  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signPayload(raw, SECRET) },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
  // Wait for the queue to answer it.
  for (let i = 0; i < 120; i++) {
    const job = await db.whatsAppJob.findFirst({ where: { message: { wamid: id } } });
    if (job?.status === 'DONE' || job?.status === 'DEAD') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const reply = await db.whatsAppMessage.findFirst({
    where: { direction: 'OUTBOUND', conversation: { waIdHash: keyedHash(from, 'whatsapp-wa-id') } },
    orderBy: { createdAt: 'desc' },
  });
  return reply;
}

const bodyOf = (m: { payload: unknown; body: string | null } | null) => {
  const p = m?.payload as { body?: string; text?: string } | null;
  return p?.body ?? p?.text ?? m?.body ?? '';
};

async function main() {
  if (!SECRET || !PHONE_ID) {
    console.error('Set WHATSAPP_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID (the values the app runs with).');
    process.exit(2);
  }
  const email = `zzverify-walink-${STAMP}@example.test`;
  const user = await db.user.create({ data: { email, name: 'WA Link', passwordHash: await bcrypt.hash(PASSWORD, 10) } });
  const acme = await db.company.create({ data: { name: `zzverify walink Acme ${STAMP}`, slug: `zzverify-walink-a-${STAMP}` } });
  const beta = await db.company.create({ data: { name: `zzverify walink Beta ${STAMP}`, slug: `zzverify-walink-b-${STAMP}` } });
  const secret = await db.company.create({ data: { name: `zzverify walink Secret ${STAMP}`, slug: `zzverify-walink-s-${STAMP}` } });
  await db.companyMember.createMany({
    data: [
      { userId: user.id, companyId: acme.id, role: 'OWNER' },
      { userId: user.id, companyId: beta.id, role: 'VIEWER' },
    ],
  });
  const web = new Client();

  try {
    console.log('Sign-in link');
    const hi = await say(FROM, 'Hi');
    const payload = hi?.payload as { kind?: string; url?: string } | null;
    // Sent links are kept as "[sent]" (not stored); with the local stub the link is read from what it received.
    const linkUrl = await resolveSentUrl(FROM, payload?.url);
    check('“Hi” from an unknown number gets a sign-in button', payload?.kind === 'cta', JSON.stringify(payload));
    check('it opens Aura’s own site', Boolean(linkUrl?.startsWith(`${BASE}/whatsapp/link/`)), linkUrl);
    check('the welcome text is the one asked for', bodyOf(hi).startsWith('Welcome to Botella Aura!'));
    check('the stored history does not keep the link', !hi?.body?.includes('/whatsapp/link/'));
    const path = new URL(linkUrl!).pathname;

    console.log('Page');
    const signedOut = await web.req('GET', path);
    check(
      'signed out → Aura’s login, coming back here afterwards',
      signedOut.status === 307 && Boolean(signedOut.location?.includes(`/login?callbackUrl=${encodeURIComponent(path)}`)),
      `${signedOut.status} ${signedOut.location}`,
    );
    await web.signIn(email);
    const page = await web.req('GET', path);
    // The text as a person sees it: React separates adjacent text with comments.
    const visible = page.text.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ');
    check(
      'signed in → the page shows which number, and which account',
      page.status === 200 && visible.includes(`•••• ${FROM.slice(-4)}`) && visible.includes(email),
      `HTTP ${page.status}`,
    );
    const again = await web.req('GET', path);
    check('viewing twice does not use the link up', again.text.includes('Yes, link this number'));

    console.log('Confirm');
    const token = path.split('/').pop()!;
    const crossSite = await web.req('POST', '/api/whatsapp/link/confirm', { token }, { Origin: 'https://evil.example' });
    check('a cross-site confirm is refused', crossSite.status === 403, `HTTP ${crossSite.status}`);
    const confirm = await web.req('POST', '/api/whatsapp/link/confirm', { token });
    const code = confirm.json.code as string;
    check('a real session confirms and gets a 6-digit code', confirm.status === 200 && /^\d{6}$/.test(code ?? ''), JSON.stringify(confirm.json));
    const replay = await web.req('POST', '/api/whatsapp/link/confirm', { token });
    check('the same link cannot be confirmed twice', replay.status === 409, `HTTP ${replay.status}`);

    console.log('Code');
    await say(OTHER, code);
    const wrongNumberLink = await db.whatsAppAccountLink.findFirst({ where: { userId: user.id } });
    check('the right code from a different number links nothing', !wrongNumberLink);
    const linked = await say(FROM, `LINK ${code}`);
    const link = await db.whatsAppAccountLink.findFirst({ where: { userId: user.id } });
    check('the code from the right number links it', Boolean(link) && !link!.revokedAt);
    check('and says which account', bodyOf(linked).includes(email), bodyOf(linked));
    check('with two workspaces, it asks which', (linked?.payload as { kind?: string })?.kind === 'list');

    console.log('Workspaces');
    const forged = await say(FROM, 'Secret', `ws:${secret.id}`);
    const afterForged = await db.whatsAppAccountLink.findFirst({ where: { userId: user.id } });
    check('a forged id for someone else’s workspace is refused', afterForged?.activeCompanyId === null && bodyOf(forged).includes('isn’t available'));
    check('and the reply does not name it', !bodyOf(forged).includes('Secret'));
    const chose = await say(FROM, 'Beta', `ws:${beta.id}`);
    const afterChose = await db.whatsAppAccountLink.findFirst({ where: { userId: user.id } });
    check('their own workspace is selected', afterChose?.activeCompanyId === beta.id);
    check('with their current role', bodyOf(chose).includes('(Viewer)'), bodyOf(chose));
    await db.companyMember.update({ where: { userId_companyId: { userId: user.id, companyId: beta.id } }, data: { role: 'ADMIN' } });
    const promoted = await say(FROM, 'Hi');
    check('a role change applies on the next message', bodyOf(promoted).includes('(Admin)'), bodyOf(promoted));

    console.log('Log out');
    const out = await say(FROM, 'Log out');
    const afterOut = await db.whatsAppAccountLink.findFirst({ where: { userId: user.id } });
    check('“Log out” unlinks', Boolean(afterOut?.revokedAt) && bodyOf(out).includes('logged out'));
    const restart = await say(FROM, 'Hi');
    check('the next message starts over with a sign-in link', (restart?.payload as { kind?: string })?.kind === 'cta');
    const audits = await db.auditLog.findMany({ where: { userId: user.id, action: { in: ['WHATSAPP_LINK_CONFIRMED', 'WHATSAPP_LINKED', 'WHATSAPP_WORKSPACE_SELECTED', 'WHATSAPP_UNLINKED'] } } });
    check('confirm, link, workspace choice and unlink are all audited', new Set(audits.map((a) => a.action)).size === 4, audits.map((a) => a.action).join(','));
  } finally {
    for (const n of [FROM, OTHER]) {
      const conv = await db.whatsAppConversation.findUnique({ where: { waIdHash: keyedHash(n, 'whatsapp-wa-id') } });
      if (conv) {
        await db.auditLog.deleteMany({ where: { metadata: { path: ['conversationId'], equals: conv.id } } });
        await db.whatsAppConversation.delete({ where: { id: conv.id } });
      }
    }
    await db.auditLog.deleteMany({ where: { userId: user.id } });
    await db.company.deleteMany({ where: { id: { in: [acme.id, beta.id, secret.id] } } });
    await db.user.delete({ where: { id: user.id } });
    console.log('  ok      cleanup: throwaway user, workspaces, conversations and audit entries removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll WhatsApp linking checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
