import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Facebook & Instagram connection (Phase 5): the login model and permissions,
 * the long-lived token exchange, Page selection (only Pages the account still
 * manages; publishing never falls back to another Page), token expiry, and
 * Meta's deauthorize and data-deletion callbacks. Meta's Graph API is a fake
 * that records each call; the database is in memory.
 */

const { st } = vi.hoisted(() => ({ st: { connections: [] as any[], audits: [] as any[], seq: 0 } }));

const metaPath = (row: any, where: any) =>
  !where?.metadata || row.metadata?.[where.metadata.path[0]] === where.metadata.equals;

vi.mock('@/lib/db', () => {
  const findConn = (where: any) =>
    st.connections.find((c) =>
      where.companyId_connectorId
        ? c.companyId === where.companyId_connectorId.companyId && c.connectorId === where.companyId_connectorId.connectorId
        : c.id === where.id,
    );
  return {
    db: {
      connection: {
        findUnique: async ({ where }: any) => {
          const c = findConn(where);
          return c ? { ...c } : null;
        },
        findMany: async ({ where }: any) =>
          st.connections.filter((c) => c.connectorId === where.connectorId && metaPath(c, where)).map((c) => ({ id: c.id, companyId: c.companyId })),
        upsert: async ({ where, create, update }: any) => {
          const c = findConn(where);
          if (c) Object.assign(c, update);
          else st.connections.push({ id: `conn_${++st.seq}`, createdAt: new Date(), updatedAt: new Date(), ...create });
          return { ...(c ?? st.connections.at(-1)) };
        },
        update: async ({ where, data }: any) => Object.assign(findConn(where), data),
        updateMany: async ({ where, data }: any) => {
          const c = findConn(where);
          if (c) Object.assign(c, data);
          return { count: c ? 1 : 0 };
        },
        deleteMany: async ({ where }: any) => {
          const ids = new Set(where.id.in);
          const before = st.connections.length;
          st.connections = st.connections.filter((c) => !ids.has(c.id));
          return { count: before - st.connections.length };
        },
      },
      connectedAccount: {
        findMany: async () => [],
        upsert: async () => ({ id: `acc_${++st.seq}` }),
        updateMany: async () => ({ count: 0 }),
        deleteMany: async () => ({ count: 0 }),
      },
      auditLog: {
        create: async ({ data }: any) => {
          st.audits.push(data);
          return data;
        },
        findFirst: async ({ where }: any) => st.audits.find((a) => a.action === where.action && metaPath(a, where)) ?? null,
      },
    },
  };
});

const auth = vi.hoisted(() => ({ role: 'OWNER' }));
vi.mock('@/lib/auth-helpers', () => ({
  requireActiveCompany: async () => ({ user: { id: 'u1' }, company: { id: 'co1' }, membership: { role: auth.role } }),
}));

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.META_CLIENT_ID = 'meta-app-id';
process.env.META_CLIENT_SECRET = 'meta-app-secret';
process.env.APP_URL = 'https://aura.example';

import { choosePage, META_GRAPH_VERSION, META_SCOPES, pagesFrom, parseSignedRequest, signRequest, tokenHealth } from '@/lib/meta';
import { decrypt } from '@/lib/crypto';
import { getProvider } from '@/server/connectors/providers';
import { completeOAuth } from '@/server/connectors/connection.service';
import { deletionProcessed, selectMetaPage } from '@/server/connectors/meta.service';
import { getFacebookContext } from '@/server/media/publishers/facebook';
import { POST as choosePageRoute } from '@/app/api/meta/page/route';
import { POST as deauthorizeRoute } from '@/app/api/meta/deauthorize/route';
import { POST as deletionRoute } from '@/app/api/meta/data-deletion/route';

const PAGES = {
  data: [
    { id: '111', name: 'Cafe Page', access_token: 'PAGE_TOKEN_1' },
    { id: '222', name: 'Bakery Page', access_token: 'PAGE_TOKEN_2', instagram_business_account: { id: '17841', username: 'bakery' } },
  ],
};

/** A fake Graph API. */
function graph(overrides: { pages?: unknown; tokenExpiresIn?: number; failExchange?: boolean } = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    calls.push(url + (init?.body ? ` ${init.body}` : ''));
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes('/oauth/access_token') && init?.method === 'POST') return json({ access_token: 'SHORT_TOKEN', expires_in: 5400 });
    if (url.includes('grant_type=fb_exchange_token')) {
      return overrides.failExchange ? json({ error: { message: 'nope' } }, 400) : json({ access_token: 'LONG_TOKEN', expires_in: overrides.tokenExpiresIn ?? 5_184_000 });
    }
    if (url.includes('/me/accounts')) return json(overrides.pages ?? PAGES);
    if (url.includes('/me?fields=id')) return json({ id: 'FB_USER_1' });
    return json({ error: 'unexpected' }, 404);
  });
  return { impl, calls };
}

beforeEach(() => {
  st.connections = [];
  st.audits = [];
  auth.role = 'OWNER';
  vi.unstubAllGlobals();
});

describe('login model and permissions', () => {
  it('one Facebook Login, the minimum permissions for Pages + Instagram publishing', () => {
    expect([...META_SCOPES].sort()).toEqual(
      ['business_management', 'instagram_basic', 'instagram_content_publish', 'pages_manage_posts', 'pages_read_engagement', 'pages_show_list'].sort(),
    );
    const cfg = getProvider('meta')!.oauth!;
    expect(cfg.scopes).toEqual([...META_SCOPES]);
    // No Instagram-Login scopes mixed in.
    expect(cfg.scopes.some((s) => s.startsWith('instagram_business_'))).toBe(false);
    expect(cfg.authorizeUrl).toBe(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    expect(META_GRAPH_VERSION).toBe('v23.0');
  });
});

describe('Pages', () => {
  it('stores ids and names only — never a Page token', () => {
    const pages = pagesFrom(PAGES);
    expect(pages).toEqual([
      { id: '111', name: 'Cafe Page', ig: null },
      { id: '222', name: 'Bakery Page', ig: { id: '17841', username: 'bakery' } },
    ]);
    expect(JSON.stringify(pages)).not.toContain('PAGE_TOKEN');
  });

  it('keeps the Page chosen before; else prefers one with Instagram; else the first', () => {
    const pages = pagesFrom(PAGES);
    expect(choosePage(pages, '111')?.id).toBe('111');
    expect(choosePage(pages, 'gone')?.id).toBe('222');
    expect(choosePage(pagesFrom({ data: [{ id: '9', name: 'Only' }] }))?.id).toBe('9');
    expect(choosePage([])).toBeNull();
  });

  it('token health: warns ten days ahead', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    expect(tokenHealth(null, now)).toBe('ok');
    expect(tokenHealth(new Date('2026-12-01T00:00:00Z'), now)).toBe('ok');
    expect(tokenHealth(new Date('2026-10-20T00:00:00Z'), now)).toBe('expiring');
    expect(tokenHealth(new Date('2026-10-13T00:00:00Z'), now)).toBe('expired');
  });
});

describe('connecting', () => {
  it('the short-lived token is exchanged for the long-lived one before it is stored', async () => {
    const g = graph();
    vi.stubGlobal('fetch', g.impl);
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE' });
    const row = st.connections[0];
    expect(decrypt(row.accessTokenEnc)).toBe('LONG_TOKEN');
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(g.calls.some((c) => c.includes('grant_type=fb_exchange_token') && c.includes('fb_exchange_token=SHORT_TOKEN'))).toBe(true);
    expect(row.metadata).toMatchObject({ pageId: '222', igUserId: '17841', igUsername: 'bakery', fbUserId: 'FB_USER_1' });
    expect(row.metadata.pages).toHaveLength(2);
    expect(JSON.stringify(row.metadata)).not.toMatch(/TOKEN/);
    expect(row.accountLabel).toBe('@bakery (Bakery Page)');
    expect(row.errorMessage).toBeNull();
  });

  it('reconnecting keeps the Page chosen before', async () => {
    vi.stubGlobal('fetch', graph().impl);
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE' });
    st.connections[0].metadata.pageId = '111';
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE2' });
    expect(st.connections[0].metadata.pageId).toBe('111');
    expect(st.connections[0].metadata.igUserId).toBeUndefined();
  });

  it('if the exchange fails, it still connects — and says it is short-lived', async () => {
    vi.stubGlobal('fetch', graph({ failExchange: true }).impl);
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE' });
    expect(decrypt(st.connections[0].accessTokenEnc)).toBe('SHORT_TOKEN');
    expect(st.connections[0].errorMessage).toMatch(/short time/);
  });
});

describe('choosing the Page', () => {
  async function connected() {
    vi.stubGlobal('fetch', graph().impl);
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE' });
  }

  it('only a Page the account still manages — asked of Meta, not read from storage', async () => {
    await connected();
    st.connections[0].metadata.pages.push({ id: '999', name: 'Stale Page', ig: null });
    await expect(selectMetaPage({ companyId: 'co1', userId: 'u1', pageId: '999' })).rejects.toMatchObject({ status: 404 });
    const r = await selectMetaPage({ companyId: 'co1', userId: 'u1', pageId: '111' });
    expect(r.accountLabel).toBe('Cafe Page');
    expect(st.connections[0].metadata).toMatchObject({ pageId: '111', pageName: 'Cafe Page' });
    expect(st.connections[0].metadata.igUserId).toBeUndefined();
    expect(st.audits.some((a) => a.action === 'CONNECTOR_SYNCED' && a.metadata.pageId === '111')).toBe(true);
  });

  it('the route: owners and admins only, same-site only', async () => {
    await connected();
    const req = (headers: Record<string, string> = {}) =>
      new Request('https://aura.example/api/meta/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'aura.example', ...headers },
        body: JSON.stringify({ pageId: '111' }),
      });
    auth.role = 'MEMBER';
    expect((await choosePageRoute(req())).status).toBe(403);
    auth.role = 'OWNER';
    expect((await choosePageRoute(req({ origin: 'https://evil.example' }))).status).toBe(403);
    expect((await choosePageRoute(req({ origin: 'https://aura.example' }))).status).toBe(200);
  });
});

describe('publishing goes to the chosen Page only', () => {
  it('if the chosen Page is no longer available, nothing is published (no fallback to another Page)', async () => {
    vi.stubGlobal('fetch', graph().impl);
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE' });
    st.connections[0].metadata.pageId = '111';
    const ok = await getFacebookContext('co1');
    expect(ok?.pageId).toBe('111');

    vi.stubGlobal('fetch', graph({ pages: { data: [PAGES.data[1]] } }).impl); // lost access to 111
    expect(await getFacebookContext('co1')).toBeNull();
  });
});

describe('Meta callbacks', () => {
  const form = (signed: string) => {
    const fd = new FormData();
    fd.set('signed_request', signed);
    return new Request('https://aura.example/api/meta/x', { method: 'POST', body: fd });
  };

  it('signed requests: only ours verify', () => {
    const s = signRequest({ user_id: 'FB_USER_1', algorithm: 'HMAC-SHA256' }, 'meta-app-secret');
    expect(parseSignedRequest(s, 'meta-app-secret')).toMatchObject({ user_id: 'FB_USER_1' });
    expect(parseSignedRequest(s, 'other-secret')).toBeNull();
    const [sig, body] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ user_id: 'SOMEONE_ELSE', algorithm: 'HMAC-SHA256' })).toString('base64url');
    expect(parseSignedRequest(`${sig}.${forged}`, 'meta-app-secret')).toBeNull();
    expect(parseSignedRequest(`${sig}`, 'meta-app-secret')).toBeNull();
    expect(parseSignedRequest(signRequest({ user_id: 'x', algorithm: 'NONE' }, 'meta-app-secret'), 'meta-app-secret')).toBeNull();
    void body;
  });

  it('signed requests: one without issued_at is refused', () => {
    const body = Buffer.from(JSON.stringify({ user_id: 'U', algorithm: 'HMAC-SHA256' })).toString('base64url');
    const sig = crypto.createHmac('sha256', 'meta-app-secret').update(body).digest('base64url');
    expect(parseSignedRequest(`${sig}.${body}`, 'meta-app-secret')).toBeNull();
  });

  it('signed requests: an old one replayed is refused', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    const at = (mins: number) => signRequest({ user_id: 'U', algorithm: 'HMAC-SHA256', issued_at: now.getTime() / 1000 - mins * 60 }, 'meta-app-secret');
    expect(parseSignedRequest(at(1), 'meta-app-secret', now)).toMatchObject({ user_id: 'U' });
    expect(parseSignedRequest(at(60 * 24), 'meta-app-secret', now)).toBeNull();
  });

  it('deauthorize: that user’s connections stop at once, tokens forgotten; forged requests do nothing', async () => {
    vi.stubGlobal('fetch', graph().impl);
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE' });
    expect((await deauthorizeRoute(form('bad.request'))).status).toBe(400);
    expect(st.connections[0].status).toBe('CONNECTED');
    const res = await deauthorizeRoute(form(signRequest({ user_id: 'FB_USER_1', algorithm: 'HMAC-SHA256' }, 'meta-app-secret')));
    expect(res.status).toBe(200);
    // Marked REVOKED (Token & Credential Lifecycle): kept visible, tokens forgotten, health DISCONNECTED.
    expect(st.connections[0]).toMatchObject({ status: 'REVOKED', accessTokenEnc: null, refreshTokenEnc: null, health: 'DISCONNECTED' });
    expect(st.connections[0].revokedAt).toBeInstanceOf(Date);
    expect(st.audits.map((a: any) => a.action)).toContain('CONNECTION_REVOKED');
    expect(st.connections[0].errorMessage).toMatch(/removed in Facebook settings/);
  });

  it('data deletion: deletes that user’s Meta connections, answers with a status URL and code', async () => {
    vi.stubGlobal('fetch', graph().impl);
    await completeOAuth({ companyId: 'co1', userId: 'u1', connectorId: 'meta', code: 'CODE' });
    const res = await deletionRoute(form(signRequest({ user_id: 'FB_USER_1', algorithm: 'HMAC-SHA256' }, 'meta-app-secret')));
    const body = await res.json();
    expect(body.confirmation_code).toMatch(/^[0-9a-f]{16}$/);
    expect(body.url).toBe(`https://aura.example/meta/data-deletion?code=${body.confirmation_code}`);
    expect(st.connections).toHaveLength(0);
    expect(await deletionProcessed(body.confirmation_code)).toBe(true);
    expect(await deletionProcessed('0000000000000000')).toBe(false);
    expect(await deletionProcessed("' or 1=1")).toBe(false);
  });
});
