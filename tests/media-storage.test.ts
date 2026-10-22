import { afterEach, describe, expect, it, vi } from 'vitest';

import { presignGet, readableUrl, type S3Config } from '@/server/media/storage';

/**
 * Presigned reads (server/media/storage.ts): what lets the bucket stay
 * private while Instagram, the browser and this server read from it.
 */

const S3_ENV = {
  ASSET_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  ASSET_S3_BUCKET: 'aura',
  ASSET_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  ASSET_S3_SECRET_ACCESS_KEY: 'secret',
};

afterEach(() => vi.unstubAllEnvs());

describe('presignGet', () => {
  it("matches AWS's published presigned-URL example", () => {
    // docs.aws.amazon.com — "Authenticating Requests: Using Query Parameters"
    const config: S3Config = {
      endpoint: 'https://examplebucket.s3.amazonaws.com',
      bucket: 'unused',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    };
    const url = presignGet(config, 'https://examplebucket.s3.amazonaws.com/test.txt', 86400, new Date('2013-05-24T00:00:00Z'));
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('caps the lifetime at the 7 days S3 allows', () => {
    const config: S3Config = { endpoint: 'https://s3.example.com', bucket: 'b', region: 'auto', accessKeyId: 'a', secretAccessKey: 's' };
    expect(presignGet(config, 'https://s3.example.com/b/k.mp4', 30 * 86400)).toContain('X-Amz-Expires=604800');
  });
});

describe('readableUrl', () => {
  it('presigns an object in the configured bucket, without exposing the secret', () => {
    for (const [k, v] of Object.entries(S3_ENV)) vi.stubEnv(k, v);
    const url = readableUrl('https://acct.r2.cloudflarestorage.com/aura/videos/c1/a1.mp4', 3600);
    expect(url.startsWith('https://acct.r2.cloudflarestorage.com/aura/videos/c1/a1.mp4?')).toBe(true);
    expect(url).toContain('X-Amz-Expires=3600');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    expect(url).not.toContain('secret');
  });

  it('leaves a public CDN URL, a foreign URL, or no bucket config unchanged', () => {
    const cdn = 'https://cdn.example.com/videos/c1/a1.mp4';
    expect(readableUrl(cdn)).toBe(cdn); // no bucket configured
    for (const [k, v] of Object.entries(S3_ENV)) vi.stubEnv(k, v);
    vi.stubEnv('ASSET_S3_PUBLIC_BASE_URL', 'https://cdn.example.com');
    expect(readableUrl(cdn)).toBe(cdn);
    expect(readableUrl('https://elsewhere.example.com/aura/x.png')).toBe('https://elsewhere.example.com/aura/x.png');
  });
});
