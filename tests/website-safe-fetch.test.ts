import { afterEach, describe, expect, it, vi } from 'vitest';

const dnsResult = vi.hoisted(() => ({ addresses: [{ address: '93.184.216.34', family: 4 }] as { address: string; family: number }[] }));
vi.mock('node:dns', () => {
  const lookup = (_host: string, _opts: unknown, cb: (err: Error | null, a: unknown) => void) => cb(null, dnsResult.addresses);
  return { default: { lookup }, lookup };
});

import { guardedLookup, isPrivateAddress, normaliseSiteUrl, UnsafeUrlError } from '@/server/websites/safe-fetch';

/**
 * Website integrations are the one place Aura's server calls an address a
 * person typed. These are the guarantees that it can't be pointed at itself
 * or the private network.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  dnsResult.addresses = [{ address: '93.184.216.34', family: 4 }];
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::10.0.0.1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])('allows public %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('normaliseSiteUrl', () => {
  it('adds https, keeps a subdirectory, drops query, fragment and trailing slash', () => {
    expect(normaliseSiteUrl('example.com/blog/?x=1#y')).toBe('https://example.com/blog');
    expect(normaliseSiteUrl('https://WWW.Example.com/')).toBe('https://www.example.com');
  });

  it('refuses http, credentials, private and local hosts', () => {
    expect(() => normaliseSiteUrl('http://example.com')).toThrow(UnsafeUrlError);
    expect(() => normaliseSiteUrl('https://user:pw@example.com')).toThrow(/username and password/);
    expect(() => normaliseSiteUrl('https://127.0.0.1')).toThrow(/private network/);
    expect(() => normaliseSiteUrl('https://localhost:8080')).toThrow(/public address/);
    expect(() => normaliseSiteUrl('https://intranet')).toThrow(/public address/);
    expect(() => normaliseSiteUrl('ftp://example.com')).toThrow(/https/);
  });

  it('allows a local site only in development with the explicit flag', () => {
    vi.stubEnv('WEBSITE_ALLOW_PRIVATE_HOSTS', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    expect(normaliseSiteUrl('http://localhost:8080')).toBe('http://localhost:8080');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => normaliseSiteUrl('http://localhost:8080')).toThrow();
  });
});

describe('guardedLookup — the check happens on the address actually connected to', () => {
  const run = (opts: { all?: boolean } = {}) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) => guardedLookup('site.example', opts, (err, address) => resolve({ err, address })));

  it('passes public addresses through, in both callback shapes', async () => {
    expect((await run()).address).toBe('93.184.216.34');
    expect((await run({ all: true })).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses a hostname that resolves to a private address (DNS rebinding)', async () => {
    dnsResult.addresses = [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    const { err } = await run();
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(err?.message).toMatch(/private network/);
  });
});
