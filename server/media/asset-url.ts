import crypto from 'node:crypto';

import { absoluteUrl } from '@/lib/app-url';

/**
 * Signed, expiring URLs for a stored graphic.
 *
 * Assets are private: reading one normally requires a session and company
 * membership. But the Instagram Graph API publishes by URL — you hand Meta a
 * link and its servers fetch the image — so publishing genuinely needs an
 * address that works with no session at all.
 *
 * The answer is a signed grant rather than a public route: an HMAC over the
 * asset id and an expiry, keyed on NEXTAUTH_SECRET. It is unguessable, it
 * cannot be edited to point at another asset, and it stops working shortly
 * after the publish that needed it. This mirrors how connector OAuth state is
 * handled in server/connectors/oauth.ts — a signed self-describing token in
 * place of another table to keep clean.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function secret(): string {
  const value = process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY;
  if (!value) {
    throw new Error('NEXTAUTH_SECRET is required to sign asset URLs.');
  }
  return value;
}

function sign(assetId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${assetId}.${expiresAt}`)
    .digest('base64url');
}

export interface SignedAssetUrl {
  url: string;
  expiresAt: number;
}

/**
 * A publicly fetchable, time-limited URL for one asset.
 *
 * `ttlMs` should cover the whole publish, not just the request that mints it:
 * Instagram fetches the image while building the media container, which can be
 * a little after we hand over the link.
 */
export function signedAssetUrl(
  assetId: string,
  ttlMs = DEFAULT_TTL_MS,
): SignedAssetUrl {
  const expiresAt = Date.now() + ttlMs;
  const token = sign(assetId, expiresAt);
  const path = `/api/content/graphics/${assetId}/file?exp=${expiresAt}&sig=${token}`;
  return { url: absoluteUrl(path), expiresAt };
}

/**
 * Verify a signature. Constant-time, and checks expiry before anything else so
 * a stale link is rejected the same way regardless of whether it was ever valid.
 */
export function verifyAssetSignature(
  assetId: string,
  exp: string | null,
  sig: string | null,
): boolean {
  if (!exp || !sig) return false;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const expected = sign(assetId, expiresAt);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // A length mismatch alone means it was forged, and timingSafeEqual throws on
  // unequal lengths, so it has to be checked first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The in-app (session-authenticated) URL used by the dashboard UI. */
export function assetFileUrl(assetId: string): string {
  return `/api/content/graphics/${assetId}/file`;
}
