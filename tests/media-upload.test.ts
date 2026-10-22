import { describe, it, expect, vi } from 'vitest';

// upload.service reaches the database to persist the asset. These tests cover
// the URL guard and ratio bucketing, which are pure, so the client is stubbed
// to keep the module importable without a database.
vi.mock('@/lib/db', () => ({ db: {} }));

import { fetchRemoteImage, MediaFetchError } from '@/server/media/upload.service';
import { closestRatioFor, nearestRatioTo, resolveFormat } from '@/server/media/aspect';

/**
 * User-supplied graphics (spec §16) and the Custom format (spec §7).
 *
 * The SSRF guard gets the most attention here: an "image URL" field is a
 * request the server makes to an arbitrary address on the caller's behalf, and
 * the cloud metadata endpoint is one bad regex away.
 */

describe('fetchRemoteImage — URL guard', () => {
  it('rejects a non-URL', async () => {
    await expect(fetchRemoteImage('not a url')).rejects.toBeInstanceOf(
      MediaFetchError,
    );
  });

  it('rejects non-http schemes', async () => {
    // file: would read the server's own disk; data: would bypass the fetch
    // entirely. Neither is an "image URL" in any sense the user means.
    for (const url of [
      'file:///etc/passwd',
      'data:image/png;base64,iVBORw0KGgo=',
      'ftp://example.com/a.png',
    ]) {
      await expect(fetchRemoteImage(url)).rejects.toThrow(/only http/i);
    }
  });

  it('rejects loopback and private addresses', async () => {
    for (const host of [
      'http://localhost/a.png',
      'http://127.0.0.1/a.png',
      'http://10.0.0.5/a.png',
      'http://192.168.1.10/a.png',
      'http://172.16.4.2/a.png',
      'http://[::1]/a.png',
    ]) {
      await expect(fetchRemoteImage(host)).rejects.toThrow(/not reachable/i);
    }
  });

  it('rejects the cloud metadata address specifically', async () => {
    // 169.254.169.254 is the AWS/GCP/Azure instance metadata endpoint. Reaching
    // it would hand back deployment credentials.
    await expect(fetchRemoteImage('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /not reachable/i,
    );
  });

  it('allows a public host through to the fetch', async () => {
    // Proves the guard is not simply refusing everything: this one gets past
    // the checks and fails at the network layer instead.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-length': '10' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    await expect(fetchRemoteImage('https://example.com/a.png')).resolves.toBeInstanceOf(
      Buffer,
    );
    vi.unstubAllGlobals();
  });

  it('refuses an oversized image on the declared length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }),
        arrayBuffer: async () => new Uint8Array(0).buffer,
      })),
    );
    await expect(fetchRemoteImage('https://example.com/huge.png')).rejects.toThrow(
      /too large/i,
    );
    vi.unstubAllGlobals();
  });

  it('rejects IPv4-mapped IPv6 loopback', async () => {
    await expect(fetchRemoteImage('http://[::ffff:127.0.0.1]/a.png')).rejects.toThrow(/not reachable/i);
  });

  it('refuses a redirect to a private address, without fetching it', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchRemoteImage('https://example.com/a.png')).rejects.toThrow(/not reachable/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('follows a redirect to a public host, and stops after three', async () => {
    const image = { ok: true, status: 200, headers: new Headers({ 'content-length': '3' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    const hop = { ok: false, status: 301, headers: new Headers({ location: '/next.png' }) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(hop).mockResolvedValueOnce(image));
    await expect(fetchRemoteImage('https://example.com/a.png')).resolves.toBeInstanceOf(Buffer);
    vi.stubGlobal('fetch', vi.fn(async () => hop));
    await expect(fetchRemoteImage('https://example.com/a.png')).rejects.toThrow(/redirects too many times/i);
    vi.unstubAllGlobals();
  });

  it('surfaces a non-2xx as a readable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, headers: new Headers() })),
    );
    await expect(fetchRemoteImage('https://example.com/missing.png')).rejects.toThrow(
      /404/,
    );
    vi.unstubAllGlobals();
  });
});

describe('closestRatioFor — filing a supplied image', () => {
  it('buckets an exact square', () => {
    expect(closestRatioFor(1024, 1024)).toBe('1:1');
  });

  it('buckets common real-world sizes', () => {
    expect(closestRatioFor(1080, 1350)).toBe('4:5'); // Instagram portrait
    expect(closestRatioFor(1920, 1080)).toBe('16:9'); // a screenshot
    expect(closestRatioFor(1080, 1920)).toBe('9:16'); // a phone screen
  });

  it('falls back to square for degenerate dimensions', () => {
    expect(closestRatioFor(0, 0)).toBe('1:1');
    expect(closestRatioFor(-5, 10)).toBe('1:1');
  });
});

describe('Custom format (spec §7)', () => {
  it('maps arbitrary dimensions to the closest supported shape', () => {
    const format = resolveFormat({
      custom: { width: 1080, height: 1350 },
      platform: 'INSTAGRAM',
      providerRatios: ['1:1', '4:5', '16:9'],
    });
    expect(format.ratio).toBe('4:5');
  });

  it('always reports a substitution, because the exact pixels are never used', () => {
    // Providers only draw their own fixed sizes, so "custom" is honoured in
    // shape, not in pixels — and the UI has to be able to say which was used.
    const format = resolveFormat({
      custom: { width: 1024, height: 1024 },
      platform: 'LINKEDIN',
      providerRatios: ['1:1', '4:5', '16:9'],
    });
    expect(format.substituted).toBe(true);
    expect(format.ratio).toBe('1:1');
  });

  it('respects what the chosen provider can actually draw', () => {
    // A tall custom size on a provider with no portrait option lands on the
    // nearest thing it has, rather than failing.
    const format = resolveFormat({
      custom: { width: 1080, height: 1920 },
      platform: 'INSTAGRAM',
      providerRatios: ['1:1', '16:9'],
    });
    expect(format.ratio).toBe('1:1');
  });

  it('ignores a custom box with nonsense dimensions', () => {
    const format = resolveFormat({
      custom: { width: 0, height: 0 },
      platform: 'INSTAGRAM',
      providerRatios: ['1:1', '4:5'],
    });
    // Falls back to the platform default rather than dividing by zero.
    expect(format.ratio).toBe('4:5');
  });
});

describe('nearestRatioTo', () => {
  it('defaults to the full ratio set when none is given', () => {
    expect(nearestRatioTo(16 / 9)).toBe('16:9');
    expect(nearestRatioTo(1)).toBe('1:1');
  });
});
