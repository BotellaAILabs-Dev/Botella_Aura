import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The redirect-URI printout.
 *
 * `redirect_uri_mismatch` is the failure this guards: it happens after consent,
 * names no URL, and looks the same whether the registered value has the wrong
 * port, the wrong scheme or a trailing slash. So the list has to be right, and
 * it has to normalize what a person types the way the provider will compare it.
 */
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('normalizeBaseUrl', () => {
  it.each([
    ['8081', 'http://localhost:8081'],
    ['3000', 'http://localhost:3000'],
    ['localhost:8081', 'http://localhost:8081'],
    ['127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ['aura.example.com', 'https://aura.example.com'],
    ['https://aura.example.com', 'https://aura.example.com'],
    ['https://aura.example.com/', 'https://aura.example.com'],
    ['http://localhost:3000/', 'http://localhost:3000'],
  ])('reads %s as %s', async (input, expected) => {
    const { normalizeBaseUrl } = await import('@/server/oauth/endpoints');
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  /**
   * A trailing slash is the quiet one: it looks identical in a dashboard field
   * and is a different string to every provider.
   */
  it('never produces a trailing slash', async () => {
    const { oauthRedirectUris } = await import('@/server/oauth/endpoints');
    for (const entry of oauthRedirectUris('https://aura.example.com/')) {
      expect(entry.url).not.toMatch(/\/$/);
      expect(entry.url.startsWith('https://aura.example.com/api/')).toBe(true);
    }
  });

  it('rejects an empty base', async () => {
    const { normalizeBaseUrl } = await import('@/server/oauth/endpoints');
    expect(() => normalizeBaseUrl('   ')).toThrow(/required/i);
  });
});

describe('oauthRedirectUris', () => {
  it('lists the sign-in callback for every social provider', async () => {
    const { oauthRedirectUris } = await import('@/server/oauth/endpoints');
    const { SOCIAL_PROVIDERS } = await import('@/lib/social-signin');
    const urls = oauthRedirectUris('8081').map((e) => e.url);

    for (const provider of SOCIAL_PROVIDERS) {
      expect(urls).toContain(
        `http://localhost:8081/api/auth/callback/${provider.id}`,
      );
    }
  });

  /**
   * Sign-in and publishing are two flows with different scopes on one LinkedIn
   * app, so the app needs both URLs registered. Registering only the one you
   * were thinking about is how half the feature ends up broken.
   */
  it('lists both LinkedIn callbacks, sign-in and publishing', async () => {
    const { oauthRedirectUris } = await import('@/server/oauth/endpoints');
    const urls = oauthRedirectUris('8081').map((e) => e.url);

    expect(urls).toContain('http://localhost:8081/api/auth/callback/linkedin');
    expect(urls).toContain('http://localhost:8081/api/linkedin/callback');
  });

  it('matches the path the LinkedIn service actually sends', async () => {
    process.env.APP_URL = 'https://aura.example.com';
    const { oauthRedirectUris } = await import('@/server/oauth/endpoints');
    const { getRedirectUri } = await import('@/server/services/linkedin.service');

    const printed = oauthRedirectUris('https://aura.example.com').map((e) => e.url);
    // What we tell someone to register has to be what the code requests.
    expect(printed).toContain(getRedirectUri());
  });

  it('names each URL once', async () => {
    const { oauthRedirectUris } = await import('@/server/oauth/endpoints');
    const urls = oauthRedirectUris('8081').map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('says which env vars each URL needs, so a blank one is explainable', async () => {
    const { oauthRedirectUris } = await import('@/server/oauth/endpoints');
    for (const entry of oauthRedirectUris('8081')) {
      expect(entry.credentials.length).toBeGreaterThan(0);
      expect(entry.register).toBeTruthy();
      expect(entry.purpose).toBeTruthy();
    }
  });
});

describe('nextAuthUrlMismatch', () => {
  /**
   * The trap behind "I registered the URL and it still fails": NextAuth builds
   * its callback from NEXTAUTH_URL, not from the port the server happens to be
   * listening on. Running on 8081 with NEXTAUTH_URL on 3000 sends the provider
   * a URL nobody registered.
   */
  it('catches a port that disagrees with NEXTAUTH_URL', async () => {
    const { nextAuthUrlMismatch } = await import('@/server/oauth/endpoints');
    const message = nextAuthUrlMismatch('8081', {
      NEXTAUTH_URL: 'http://localhost:3000',
    });
    expect(message).toMatch(/8081/);
    expect(message).toMatch(/NEXTAUTH_URL=http:\/\/localhost:8081/);
  });

  it('is quiet when they agree, slash or no slash', async () => {
    const { nextAuthUrlMismatch } = await import('@/server/oauth/endpoints');
    expect(
      nextAuthUrlMismatch('8081', { NEXTAUTH_URL: 'http://localhost:8081/' }),
    ).toBeNull();
  });

  it('says so when NEXTAUTH_URL is missing entirely', async () => {
    const { nextAuthUrlMismatch } = await import('@/server/oauth/endpoints');
    expect(nextAuthUrlMismatch('8081', {})).toMatch(/NEXTAUTH_URL/);
  });
});

describe('webhookEndpoints', () => {
  it('gives the WhatsApp callback URL and the variables Meta checks it with', async () => {
    const { webhookEndpoints } = await import('@/server/oauth/endpoints');
    const whatsapp = webhookEndpoints('https://aura.example.com').find((e) =>
      e.url.endsWith('/api/webhooks/whatsapp'),
    );

    expect(whatsapp).toBeDefined();
    expect(whatsapp!.credentials).toContain('WHATSAPP_VERIFY_TOKEN');
    // Says out loud that localhost cannot work here, unlike sign-in.
    expect(whatsapp!.purpose).toMatch(/localhost/);
  });
});
