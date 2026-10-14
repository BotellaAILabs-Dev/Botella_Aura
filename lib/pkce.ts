import crypto from 'node:crypto';

import { decrypt, encrypt } from '@/lib/crypto';

/**
 * PKCE (RFC 7636) and browser binding for OAuth flows.
 *
 * Every OAuth start makes a random code verifier and keeps it in an
 * encrypted, httpOnly cookie in the browser that started — together with the
 * nonce from the signed `state`. The callback needs both:
 *
 *   - the cookie must be there and match the state's nonce, so an
 *     authorization code cannot be completed in another browser (a forwarded
 *     callback link, or an attacker injecting their own code — "login CSRF");
 *   - where the provider supports PKCE, the S256 challenge goes in the
 *     authorization URL and the verifier in the token exchange, so an
 *     intercepted code is useless without it.
 *
 * Whether the provider is SENT the challenge is per provider (it must support
 * PKCE for this kind of app — see docs/META-INTEGRATION.md); the binding
 * above always applies.
 */

export const PKCE_COOKIE_TTL_S = 10 * 60;

/** 43–128 characters from the unreserved set: 32 random bytes → 43 base64url characters. */
export function createVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** The S256 challenge: base64url(SHA-256(verifier)). */
export function challengeFor(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** The cookie value: the verifier and the state's nonce, encrypted. */
export function sealBinding(nonce: string, verifier: string): string {
  return Buffer.from(encrypt(JSON.stringify({ n: nonce, v: verifier }))).toString('base64url');
}

/** The verifier, when the cookie is present, intact and made for this state. */
export function openBinding(cookie: string | null | undefined, nonce: string): string | null {
  if (!cookie) return null;
  try {
    const data = JSON.parse(decrypt(Buffer.from(cookie, 'base64url').toString('utf8'))) as { n?: string; v?: string };
    if (typeof data.n !== 'string' || typeof data.v !== 'string') return null;
    const a = Buffer.from(data.n);
    const b = Buffer.from(nonce);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return data.v;
  } catch {
    return null;
  }
}

export const bindingCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  // Lax: sent on the provider's top-level redirect back to us.
  sameSite: 'lax' as const,
  path: '/',
  maxAge: PKCE_COOKIE_TTL_S,
};

/** Whether this provider is sent PKCE parameters (env flag, e.g. META_OAUTH_PKCE=true). */
export function pkceEnabled(flagEnv: string | undefined): boolean {
  return Boolean(flagEnv) && ['1', 'true', 'yes'].includes((process.env[flagEnv!] ?? '').trim().toLowerCase());
}
