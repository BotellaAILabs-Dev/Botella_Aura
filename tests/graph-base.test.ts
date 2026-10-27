import { afterEach, describe, expect, it } from 'vitest';

import {
  graphBaseFrom,
  isLoopbackBase,
  META_GRAPH_HOST,
  usingGraphStub,
} from '@/lib/graph-base';

/**
 * The boundary that makes the sandbox safe to leave configured.
 *
 * Aura sends an access token with every Graph request — WhatsApp, Facebook
 * Pages, Instagram. Pointing that host at a local stand-in is how any of it
 * can be exercised without a Meta app; pointing it anywhere else would hand
 * a business's token to whatever host was named, or post as them. So the
 * override is honoured only for this machine, and the tests below are mostly
 * about the strings that look local and are not.
 */
const ORIGINAL = {
  META_GRAPH_BASE_URL: process.env.META_GRAPH_BASE_URL,
  WHATSAPP_GRAPH_BASE_URL: process.env.WHATSAPP_GRAPH_BASE_URL,
};

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('what may replace Meta', () => {
  it.each([
    'http://localhost:4010',
    'http://127.0.0.1:4010',
    'http://[::1]:4010',
    'https://localhost:4010',
    'http://localhost',
  ])('accepts %s', (url) => {
    expect(isLoopbackBase(url)).toBe(true);
    expect(graphBaseFrom(url)).toBe(url);
  });

  /**
   * Each of these has fooled a naive check at some point: a hostname that
   * merely starts with "localhost", a subdomain that ends with it, a private
   * address that is not this machine, and an embedded credential.
   */
  it.each([
    ['https://graph.evil.example.com', 'an ordinary remote host'],
    ['http://localhost.evil.example.com', 'starts with localhost'],
    ['http://evil.example.com/localhost', 'localhost in the path'],
    ['http://notlocalhost', 'contains localhost'],
    ['http://10.0.0.5:4010', 'private, but not this machine'],
    ['http://192.168.1.9:4010', 'the LAN is not this machine'],
    ['http://user@evil.example.com', 'credential in the authority'],
    ['localhost:4010', 'no scheme, so not a URL'],
    ['not a url', 'nonsense'],
    ['', 'empty'],
  ])('refuses %s (%s)', (url) => {
    expect(isLoopbackBase(url)).toBe(false);
    expect(graphBaseFrom(url)).toBe(META_GRAPH_HOST);
  });

  it('falls back to Meta when nothing is set', () => {
    expect(graphBaseFrom(undefined)).toBe(META_GRAPH_HOST);
    expect(graphBaseFrom('   ')).toBe(META_GRAPH_HOST);
  });

  it('drops a trailing slash, because the version is appended next', () => {
    expect(graphBaseFrom('http://localhost:4010/')).toBe('http://localhost:4010');
    expect(graphBaseFrom('http://localhost:4010///')).toBe('http://localhost:4010');
  });
});

describe('saying so out loud', () => {
  it('reports a stub when either product is redirected', () => {
    delete process.env.META_GRAPH_BASE_URL;
    delete process.env.WHATSAPP_GRAPH_BASE_URL;
    expect(usingGraphStub()).toBe(false);

    expect(usingGraphStub({ META_GRAPH_BASE_URL: 'http://localhost:4010' })).toBe(true);
    expect(usingGraphStub({ WHATSAPP_GRAPH_BASE_URL: 'http://127.0.0.1:4010' })).toBe(true);
  });

  /**
   * A value that will be ignored must not be reported as a stub either —
   * otherwise the warning says traffic is local while it is going to Meta,
   * which is the one wrong way round that matters.
   */
  it('does not report a stub for an override that will be ignored', () => {
    expect(usingGraphStub({ META_GRAPH_BASE_URL: 'https://graph.evil.example.com' })).toBe(
      false,
    );
  });
});

describe('the Graph URL builder', () => {
  it('routes every Meta product through the override', async () => {
    process.env.META_GRAPH_BASE_URL = 'http://localhost:4010';
    const { graphUrl } = await import('@/lib/meta');

    // Read per call, not captured at import: a test or a script may set it late.
    expect(graphUrl('me/accounts')).toMatch(
      /^http:\/\/localhost:4010\/v\d+\.\d+\/me\/accounts$/,
    );
    expect(graphUrl('/111/feed')).toMatch(/^http:\/\/localhost:4010\/v\d+\.\d+\/111\/feed$/);
  });

  it('goes to Meta when the override is not local', async () => {
    process.env.META_GRAPH_BASE_URL = 'https://graph.evil.example.com';
    const { graphUrl } = await import('@/lib/meta');
    expect(graphUrl('me').startsWith(`${META_GRAPH_HOST}/`)).toBe(true);
  });
});
