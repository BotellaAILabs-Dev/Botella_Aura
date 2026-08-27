import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `Error 400: redirect_uri_mismatch` was the reported OAuth failure. Two things
 * prevent it now, and both are worth pinning: Google's connectors share ONE
 * registered callback (so there is a single URI to register, not one per
 * connector), and pre-flight refuses to send a user to a provider when this
 * deployment would hand it a localhost redirect.
 */
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('oauth redirect URIs', () => {
  it('points every Google connector at one shared callback', async () => {
    process.env.APP_URL = 'https://aura.example.com';
    const { redirectUri } = await import('@/server/connectors/oauth');

    const ga4 = redirectUri('ga4');
    const searchConsole = redirectUri('search-console');

    expect(ga4).toBe(searchConsole);
    expect(ga4).toBe('https://aura.example.com/api/connectors/google/callback');
  });

  it('lists each distinct URI once, naming the connectors that use it', async () => {
    process.env.APP_URL = 'https://aura.example.com';
    const { oauthRedirectPaths } = await import('@/server/connectors/providers');

    const paths = oauthRedirectPaths();
    const google = paths.find((p) => p.path.includes('/google/'));

    expect(google).toBeDefined();
    expect(google!.connectors).toContain('ga4');
    expect(google!.connectors).toContain('search-console');
    // One entry per URI — registering the same URI twice is the bug, not the fix.
    expect(new Set(paths.map((p) => p.path)).size).toBe(paths.length);
  });
});

describe('connector preflight', () => {
  it('blocks a hosted connect when the app resolves to localhost', async () => {
    process.env.APP_URL = 'http://localhost:3000';
    process.env.GOOGLE_CLIENT_ID = 'test-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    const { preflightConnector } = await import('@/server/connectors/preflight');

    const result = preflightConnector('ga4');

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.severity === 'blocker')).toBe(true);
    // The message must name the fix, not just the symptom.
    expect(result.issues[0]!.message).toMatch(/APP_URL/);
  });

  it('passes with a public HTTPS URL and app credentials present', async () => {
    process.env.APP_URL = 'https://aura.example.com';
    process.env.GOOGLE_CLIENT_ID = 'test-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    const { preflightConnector } = await import('@/server/connectors/preflight');

    const result = preflightConnector('ga4');

    expect(result.ok).toBe(true);
    expect(result.redirectUri).toBe(
      'https://aura.example.com/api/connectors/google/callback',
    );
  });

  it('reports the missing credential rather than a generic failure', async () => {
    process.env.APP_URL = 'https://aura.example.com';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const { preflightConnector } = await import('@/server/connectors/preflight');

    const result = preflightConnector('ga4');

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /GOOGLE_CLIENT_ID/.test(i.message))).toBe(true);
  });
});
