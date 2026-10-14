import crypto from 'node:crypto';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * PKCE and browser binding for connector OAuth (lib/pkce.ts,
 * server/connectors/oauth.ts) and the LinkedIn flow.
 */

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
process.env.APP_URL = 'https://aura.example';
process.env.META_CLIENT_ID = 'meta-app';
process.env.META_CLIENT_SECRET = 'meta-secret';
process.env.LINKEDIN_CLIENT_ID = 'li-app';
process.env.LINKEDIN_CLIENT_SECRET = 'li-secret';

import { challengeFor, createVerifier, openBinding, sealBinding } from '@/lib/pkce';
import { buildAuthorizeUrl, decodeState, exchangeCode, verifyBinding } from '@/server/connectors/oauth';
import { buildAuthorizeUrl as linkedInAuthorizeUrl } from '@/server/services/linkedin.service';

beforeEach(() => {
  delete process.env.META_OAUTH_PKCE;
  delete process.env.LINKEDIN_OAUTH_PKCE;
});
afterEach(() => vi.unstubAllGlobals());

describe('PKCE primitives', () => {
  it('verifier is 43 unreserved characters; challenge is base64url(SHA-256)', () => {
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeFor(v)).toBe(crypto.createHash('sha256').update(v).digest('base64url'));
    // RFC 7636 appendix B test vector.
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('the binding opens only for its own nonce, and cannot be forged or edited', () => {
    const sealed = sealBinding('nonce-A', 'verifier-1');
    expect(openBinding(sealed, 'nonce-A')).toBe('verifier-1');
    expect(openBinding(sealed, 'nonce-B')).toBeNull();
    expect(openBinding(undefined, 'nonce-A')).toBeNull();
    expect(openBinding('not-a-binding', 'nonce-A')).toBeNull();
    const tampered = Buffer.from(sealed, 'base64url').toString('utf8').replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(openBinding(Buffer.from(tampered).toString('base64url'), 'nonce-A')).toBeNull();
    expect(sealed).not.toContain('verifier-1');
  });
});

describe('connector OAuth (Meta)', () => {
  const start = () => buildAuthorizeUrl({ connectorId: 'meta', companyId: 'co1', userId: 'u1' });

  it('every start sets a binding cookie for the state’s nonce', () => {
    const s = start();
    const url = new URL(s.url);
    const state = decodeState(url.searchParams.get('state')!);
    expect(s.cookie.name).toBe('aura_oauth_meta');
    expect(verifyBinding(state, s.cookie.value)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('the callback refuses a valid state from a browser without the cookie, or with another flow’s cookie', () => {
    const a = start();
    const b = start();
    const stateA = decodeState(new URL(a.url).searchParams.get('state')!);
    expect(() => verifyBinding(stateA, undefined)).toThrow(/same browser/);
    expect(() => verifyBinding(stateA, b.cookie.value)).toThrow(/same browser/);
  });

  it('PKCE off (default): no challenge sent, no verifier sent', async () => {
    const s = start();
    expect(new URL(s.url).searchParams.has('code_challenge')).toBe(false);
    const sent: URLSearchParams[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      sent.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    });
    await exchangeCode('meta', 'CODE', 'some-verifier');
    expect(sent[0]!.has('code_verifier')).toBe(false);
  });

  it('PKCE on (META_OAUTH_PKCE=true): S256 challenge in the URL, the matching verifier at the exchange', async () => {
    process.env.META_OAUTH_PKCE = 'true';
    const s = start();
    const url = new URL(s.url);
    const state = decodeState(url.searchParams.get('state')!);
    const verifier = verifyBinding(state, s.cookie.value);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challengeFor(verifier));

    const sent: URLSearchParams[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      sent.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    });
    await exchangeCode('meta', 'CODE', verifier);
    expect(sent[0]!.get('code_verifier')).toBe(verifier);
  });
});

describe('LinkedIn', () => {
  it('sends PKCE only when LINKEDIN_OAUTH_PKCE is on (LinkedIn enables it per app)', () => {
    const challenge = challengeFor(createVerifier());
    expect(new URL(linkedInAuthorizeUrl('state', challenge)).searchParams.has('code_challenge')).toBe(false);
    process.env.LINKEDIN_OAUTH_PKCE = '1';
    const url = new URL(linkedInAuthorizeUrl('state', challenge));
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
