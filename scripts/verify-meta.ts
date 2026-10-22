/**
 * Facebook & Instagram connection (Phase 5), against the running app and the
 * real database. Without a real Meta app the Graph API cannot be called with
 * a working token, so this checks everything around it — and that Aura asks
 * Meta rather than trusting what it stored.
 *
 *   Start      connecting builds Meta's authorize URL: the Graph version, the
 *              exact permissions, a signed state
 *   Status     the Page list and expiry warning, from the stored connection
 *   Choose     choosing a Page is checked with Meta live (here: refused, as
 *              the token is not real) — never accepted from storage alone
 *   Callbacks  deauthorize and data deletion accept only Meta's signature;
 *              the status page answers for a processed code
 *   Pages      the connectors page renders
 *
 * Run (app running with the same META_CLIENT_ID / META_CLIENT_SECRET):
 *   VERIFY_BASE_URL=http://localhost:3001 pnpm verify:meta
 */
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { META_SCOPES, signRequest } from '@/lib/meta';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const SECRET = process.env.META_CLIENT_SECRET ?? '';
const STAMP = Date.now();
const PASSWORD = `Zz-meta-${STAMP}!`;
const FB_USER = `FBTEST${STAMP}`;

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
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* page */
    }
    return { status: res.status, json, text };
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

const callback = (path: string, signed: string) => {
  const fd = new FormData();
  fd.set('signed_request', signed);
  return fetch(`${BASE}${path}`, { method: 'POST', body: fd });
};

async function main() {
  if (!SECRET) {
    console.error('Set META_CLIENT_SECRET (and META_CLIENT_ID) to the values the app runs with.');
    process.exit(2);
  }
  const user = await db.user.create({ data: { email: `zzverify-meta-${STAMP}@example.test`, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
  const company = await db.company.create({ data: { name: `zzverify Meta ${STAMP}`, slug: `zzverify-meta-${STAMP}` } });
  await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'OWNER' } });
  const pages = [
    { id: '111', name: 'Cafe Page', ig: null },
    { id: '222', name: 'Bakery Page', ig: { id: '17841', username: 'bakery' } },
  ];
  const conn = await db.connection.create({
    data: {
      companyId: company.id,
      connectorId: 'meta',
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt('NOT_A_REAL_TOKEN'),
      expiresAt: new Date(Date.now() + 5 * 86_400_000),
      accountLabel: '@bakery (Bakery Page)',
      metadata: { pageId: '222', pageName: 'Bakery Page', igUserId: '17841', igUsername: 'bakery', pages, fbUserId: FB_USER },
      connectedById: user.id,
    },
  });
  const web = new Web();

  try {
    await web.signIn(user.email);

    console.log('Start');
    const start = await web.req('POST', '/api/connectors/meta');
    let url = start.json.authorizeUrl ? new URL(start.json.authorizeUrl as string) : null;
    if (!url && start.status === 409 && /localhost/.test(String(start.json.error))) {
      // The existing preflight refuses to send Meta a localhost redirect (it
      // would be rejected). Expected locally: check the URL it would build.
      check('on localhost, the preflight refuses (Meta would reject the redirect)', true);
      const { buildAuthorizeUrl } = await import('@/server/connectors/oauth');
      url = new URL(buildAuthorizeUrl({ connectorId: 'meta', companyId: company.id, userId: user.id }).url);
    } else {
      check('connecting returns Meta’s authorize URL', start.status === 200 && Boolean(url), `${start.status} ${JSON.stringify(start.json).slice(0, 160)}`);
    }
    if (url) {
      check('on the current Graph version', url.pathname === '/v23.0/dialog/oauth', url.pathname);
      if (process.env.META_LOGIN_CONFIG_ID) {
        check('Facebook Login for Business: the configuration id, no scope', url.searchParams.get('config_id') === process.env.META_LOGIN_CONFIG_ID && !url.searchParams.has('scope'), url.search);
      } else {
        check('asking exactly the documented permissions', (url.searchParams.get('scope') ?? '').split(' ').sort().join() === [...META_SCOPES].sort().join(), url.searchParams.get('scope') ?? '');
      }
      check('with a signed state', /\./.test(url.searchParams.get('state') ?? ''));
      check('returning to the Meta callback', url.searchParams.get('redirect_uri') === `${BASE}/api/connectors/meta/callback`, url.searchParams.get('redirect_uri') ?? '');
      const pkceOn = ['1', 'true', 'yes'].includes((process.env.META_OAUTH_PKCE ?? '').toLowerCase());
      check(
        pkceOn ? 'PKCE on: an S256 code challenge is sent' : 'PKCE off for Meta (META_OAUTH_PKCE): no challenge sent',
        pkceOn ? url.searchParams.get('code_challenge_method') === 'S256' && (url.searchParams.get('code_challenge') ?? '').length === 43 : !url.searchParams.has('code_challenge'),
      );
    }

    console.log('Browser binding');
    {
      // A genuine, signed state — but from a browser that never started the flow.
      const { encodeState } = await import('@/server/connectors/oauth');
      const state = encodeState({ companyId: company.id, connectorId: 'meta', userId: user.id });
      const cb = await fetch(`${BASE}/api/connectors/meta/callback?code=STOLEN_CODE&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
        headers: { cookie: web.cookie() },
      });
      const location = decodeURIComponent((cb.headers.get('location') ?? '').replace(/\+/g, ' '));
      const after = await db.connection.findUnique({ where: { id: conn.id } });
      check(
        'a valid state without this browser’s binding cookie is refused, nothing changes',
        /code=state_mismatch/.test(location) && /different browser|same browser/.test(location) && after?.updatedAt.getTime() === conn.updatedAt.getTime(),
        `${cb.status} ${location.slice(0, 160)}`,
      );
    }

    console.log('Status');
    const status = await web.req('GET', '/api/meta/page');
    check('the Pages and the chosen one', status.json.pages?.length === 2 && status.json.selectedPageId === '222', JSON.stringify(status.json).slice(0, 160));
    check('expiry in 5 days → a reconnect warning', status.json.health === 'expiring', status.json.health);

    console.log('Choose');
    const choose = await web.req('POST', '/api/meta/page', { pageId: '111' });
    const after = await db.connection.findUnique({ where: { id: conn.id } });
    check(
      'choosing is checked with Meta live — a token Meta rejects changes nothing',
      choose.status >= 400 && (after?.metadata as { pageId?: string }).pageId === '222',
      `${choose.status} ${choose.json.error}`,
    );

    console.log('Pages');
    const page = await web.req('GET', '/dashboard/connectors');
    check('the connectors page renders', page.status === 200, `HTTP ${page.status}`);

    console.log('Callbacks');
    const forged = await callback('/api/meta/deauthorize', signRequest({ user_id: FB_USER, algorithm: 'HMAC-SHA256' }, 'not-the-secret'));
    check('a forged deauthorize is refused', forged.status === 400, `HTTP ${forged.status}`);
    check('and changes nothing', (await db.connection.findUnique({ where: { id: conn.id } }))?.status === 'CONNECTED');
    const deauth = await callback('/api/meta/deauthorize', signRequest({ user_id: FB_USER, algorithm: 'HMAC-SHA256' }, SECRET));
    const dead = await db.connection.findUnique({ where: { id: conn.id } });
    // Marked REVOKED (kept visible, tokens forgotten) since the Connection Manager.
    check('Meta’s deauthorize marks it revoked and forgets the token', deauth.status === 200 && dead?.status === 'REVOKED' && dead.accessTokenEnc === null && dead.health === 'DISCONNECTED', `${deauth.status} ${dead?.status}`);
    const del = await callback('/api/meta/data-deletion', signRequest({ user_id: FB_USER, algorithm: 'HMAC-SHA256' }, SECRET));
    const body = (await del.json()) as { url?: string; confirmation_code?: string };
    check('data deletion answers with a status URL and a code', del.status === 200 && /^[0-9a-f]{16}$/.test(body.confirmation_code ?? '') && Boolean(body.url?.includes(body.confirmation_code ?? '-')), JSON.stringify(body));
    check('and the connection data is gone', !(await db.connection.findUnique({ where: { id: conn.id } })));
    const statusPage = await fetch(body.url!.replace(/^https?:\/\/[^/]+/, BASE)).then((r) => r.text());
    check('the status page says it was processed', statusPage.includes('This request has been processed'));
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ companyId: company.id }, { userId: user.id }, { metadata: { path: ['connectorId'], equals: 'meta' }, companyId: null }] } });
    await db.company.delete({ where: { id: company.id } });
    await db.user.delete({ where: { id: user.id } });
    console.log('  ok      cleanup: throwaway user, workspace, connection and audit entries removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll Meta checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
