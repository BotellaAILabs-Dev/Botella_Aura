import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { signedAssetUrl, verifyAssetSignature, assetFileUrl } from '@/server/media/asset-url';

/**
 * Signed asset URLs.
 *
 * These are the only way a generated graphic can be read without a session —
 * they exist because Instagram publishes by URL and Meta's servers fetch the
 * image themselves. That makes them a real access-control boundary, so the
 * forgery and expiry cases are pinned here.
 */
const ORIGINAL_SECRET = process.env.NEXTAUTH_SECRET;
const ORIGINAL_APP_URL = process.env.APP_URL;

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-asset-url-signing';
  process.env.APP_URL = 'https://aura.example.com';
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
});

/** Pull the query parameters back out of a minted URL. */
function parts(url: string): { exp: string | null; sig: string | null } {
  const parsed = new URL(url);
  return {
    exp: parsed.searchParams.get('exp'),
    sig: parsed.searchParams.get('sig'),
  };
}

describe('signedAssetUrl', () => {
  it('mints an absolute URL carrying an expiry and a signature', () => {
    const { url, expiresAt } = signedAssetUrl('asset_123');
    expect(url.startsWith('https://aura.example.com/api/content/graphics/asset_123/file')).toBe(
      true,
    );
    const { exp, sig } = parts(url);
    expect(Number(exp)).toBe(expiresAt);
    expect(sig).toBeTruthy();
  });

  it('verifies a signature it just produced', () => {
    const { url } = signedAssetUrl('asset_123');
    const { exp, sig } = parts(url);
    expect(verifyAssetSignature('asset_123', exp, sig)).toBe(true);
  });
});

describe('verifyAssetSignature', () => {
  it('rejects a signature minted for a different asset', () => {
    // The whole point: a valid link must not be editable into a link for
    // somebody else's graphic.
    const { url } = signedAssetUrl('asset_123');
    const { exp, sig } = parts(url);
    expect(verifyAssetSignature('asset_456', exp, sig)).toBe(false);
  });

  it('rejects an extended expiry', () => {
    // Moving the deadline invalidates the signature, because the deadline is
    // part of what was signed.
    const { url } = signedAssetUrl('asset_123');
    const { exp, sig } = parts(url);
    const later = String(Number(exp) + 86_400_000);
    expect(verifyAssetSignature('asset_123', later, sig)).toBe(false);
  });

  it('rejects an expired link even with a genuine signature', () => {
    const { url } = signedAssetUrl('asset_123', -1000);
    const { exp, sig } = parts(url);
    expect(verifyAssetSignature('asset_123', exp, sig)).toBe(false);
  });

  it('rejects missing parameters', () => {
    expect(verifyAssetSignature('asset_123', null, null)).toBe(false);
    expect(verifyAssetSignature('asset_123', String(Date.now() + 10_000), null)).toBe(
      false,
    );
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so this path has to be handled
    // before the comparison — a forged short signature must be a false, not a
    // 500.
    const exp = String(Date.now() + 60_000);
    expect(() => verifyAssetSignature('asset_123', exp, 'short')).not.toThrow();
    expect(verifyAssetSignature('asset_123', exp, 'short')).toBe(false);
  });

  it('rejects a non-numeric expiry', () => {
    const { url } = signedAssetUrl('asset_123');
    const { sig } = parts(url);
    expect(verifyAssetSignature('asset_123', 'not-a-number', sig)).toBe(false);
  });
});

describe('assetFileUrl', () => {
  it('is relative and unsigned — the in-app, session-gated path', () => {
    const url = assetFileUrl('asset_123');
    expect(url).toBe('/api/content/graphics/asset_123/file');
    expect(url).not.toContain('sig=');
  });
});
