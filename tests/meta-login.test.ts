import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Facebook & Instagram login (one Meta app, "Instagram API with Facebook
 * Login"): the dialog URL in both modes — classic Facebook Login (scope) and
 * Facebook Login for Business (config_id, per Meta's docs) — the signed
 * state, the redirect URI, and the provider hooks used for permissions and
 * disconnecting. Meta's API is never called.
 */

process.env.NEXTAUTH_SECRET = 'test-secret-for-state-signing';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.META_CLIENT_ID = '1234567890';
process.env.META_CLIENT_SECRET = 'meta-secret';
process.env.APP_URL = 'https://app.botella.example';

import { buildAuthorizeUrl, decodeState, encodeState, redirectUri, InvalidOAuthStateError } from '@/server/connectors/oauth';
import { getProvider } from '@/server/connectors/providers';
import { META_GRAPH_VERSION, META_SCOPES } from '@/lib/meta';

const start = () => new URL(buildAuthorizeUrl({ connectorId: 'meta', companyId: 'co_1', userId: 'u_1' }).url);

describe('the login dialog URL', () => {
  afterEach(() => {
    delete process.env.META_LOGIN_CONFIG_ID;
  });

  it('classic Facebook Login: the documented permissions as scope, code flow, our callback', () => {
    const url = start();
    expect(`${url.origin}${url.pathname}`).toBe(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    expect(url.searchParams.get('client_id')).toBe('1234567890');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.botella.example/api/connectors/meta/callback');
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([...META_SCOPES].sort());
    expect([...META_SCOPES].sort()).toEqual(['business_management', 'instagram_basic', 'instagram_content_publish', 'pages_manage_posts', 'pages_read_engagement', 'pages_show_list']);
    expect(url.searchParams.has('config_id')).toBe(false);
  });

  it('Facebook Login for Business (META_LOGIN_CONFIG_ID): config_id and no scope, as Meta recommends', () => {
    process.env.META_LOGIN_CONFIG_ID = '987654321012345';
    const url = start();
    expect(url.searchParams.get('config_id')).toBe('987654321012345');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('response_type')).toBe('code'); // server-side code exchange, unchanged
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.botella.example/api/connectors/meta/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('an empty configuration id falls back to classic login', () => {
    process.env.META_LOGIN_CONFIG_ID = '   ';
    expect(start().searchParams.has('scope')).toBe(true);
  });

  it('the flow is bound to this browser (an encrypted cookie set with the redirect)', () => {
    const { cookie } = buildAuthorizeUrl({ connectorId: 'meta', companyId: 'co_1', userId: 'u_1' });
    expect(cookie.name).toBe('aura_oauth_meta');
    expect(cookie.value.length).toBeGreaterThan(20);
  });

  it('one redirect URI, on the app’s public URL', () => {
    expect(redirectUri('meta')).toBe('https://app.botella.example/api/connectors/meta/callback');
  });
});

describe('the signed state', () => {
  beforeEach(() => vi.useRealTimers());

  it('carries the workspace, the user and the connector, and verifies', () => {
    const state = new URL(buildAuthorizeUrl({ connectorId: 'meta', companyId: 'co_1', userId: 'u_1' }).url).searchParams.get('state')!;
    expect(decodeState(state)).toMatchObject({ companyId: 'co_1', userId: 'u_1', connectorId: 'meta' });
  });

  it('a tampered state is refused (another workspace swapped in)', () => {
    const state = encodeState({ companyId: 'co_1', connectorId: 'meta', userId: 'u_1' }, 'nonce');
    const [body, sig] = state.split('.');
    const forged = Buffer.from(Buffer.from(body!, 'base64url').toString().replace('co_1', 'co_2')).toString('base64url');
    expect(() => decodeState(`${forged}.${sig}`)).toThrow(InvalidOAuthStateError);
    expect(() => decodeState('garbage')).toThrow(InvalidOAuthStateError);
  });

  it('a state older than 10 minutes is refused, with a reason', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
    const state = encodeState({ companyId: 'co_1', connectorId: 'meta', userId: 'u_1' }, 'nonce');
    vi.setSystemTime(new Date('2026-10-22T10:11:00Z'));
    expect(() => decodeState(state)).toThrow(/expired/);
    vi.useRealTimers();
  });
});

describe('provider hooks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('granted permissions are read from /me/permissions (declined ones excluded)', async () => {
    vi.stubGlobal('fetch', async (u: string) => {
      expect(String(u)).toContain('/me/permissions');
      return new Response(JSON.stringify({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'instagram_content_publish', status: 'declined' }] }), { status: 200 });
    });
    expect(await getProvider('meta')!.grantedScopes!('TOKEN')).toEqual(['pages_show_list']);
  });

  it('disconnecting revokes Aura at Meta (DELETE /me/permissions); an already-invalid token is fine', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(u).split('?')[0]}`);
      return new Response('{}', { status: 400 });
    });
    await expect(getProvider('meta')!.revoke!({ accessToken: 'TOKEN' })).resolves.toBeUndefined();
    expect(seen).toEqual([`DELETE https://graph.facebook.com/${META_GRAPH_VERSION}/me/permissions`]);
  });

  it('the short-lived token is exchanged for the long-lived one (fb_exchange_token)', async () => {
    vi.stubGlobal('fetch', async (u: string) => {
      const url = new URL(String(u));
      expect(url.searchParams.get('grant_type')).toBe('fb_exchange_token');
      expect(url.searchParams.get('fb_exchange_token')).toBe('SHORT');
      return new Response(JSON.stringify({ access_token: 'LONG', expires_in: 5_184_000 }), { status: 200 });
    });
    const t = await getProvider('meta')!.oauth!.upgradeToken!({ accessToken: 'SHORT' });
    expect(t.accessToken).toBe('LONG');
    expect(Math.round((t.expiresAt!.getTime() - Date.now()) / 86_400_000)).toBe(60);
  });
});
