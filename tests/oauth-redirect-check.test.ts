import { describe, expect, it, vi } from 'vitest';

import { oauthRedirectUris } from '@/server/oauth/endpoints';
import { checkRedirects, classifyProbe, providerOf } from '@/server/oauth/redirect-check';

/**
 * Reading what LinkedIn, Google and Meta's authorization pages say, so a
 * redirect URL missing from the provider's app is found before anyone clicks
 * "Sign in" and lands on an error page.
 */

const googleError = (reason: string) =>
  `https://accounts.google.com/signin/oauth/error?authError=${encodeURIComponent(Buffer.from(reason).toString('base64'))}`;

describe('classifyProbe', () => {
  it('LinkedIn: an unregistered redirect URL', () => {
    expect(classifyProbe('linkedin', { status: 200, location: '', body: '<p>The redirect_uri does not match the registered value</p>' }).verdict).toBe(
      'redirect_not_registered',
    );
  });

  it('LinkedIn: accepted when it sends the browser to log in', () => {
    expect(classifyProbe('linkedin', { status: 303, location: 'https://www.linkedin.com/uas/login?session_redirect=x', body: '' }).verdict).toBe('accepted');
  });

  it('LinkedIn: a scope the app has no product for', () => {
    expect(classifyProbe('linkedin', { status: 302, location: 'https://app/cb?error=unauthorized_scope_error', body: '' }).verdict).toBe('scope_not_allowed');
  });

  it('Google: a redirect to its own error page is not an acceptance', () => {
    expect(classifyProbe('google', { status: 302, location: googleError('Error 400: redirect_uri_mismatch'), body: '' }).verdict).toBe(
      'redirect_not_registered',
    );
    expect(classifyProbe('google', { status: 302, location: googleError('invalid_client'), body: '' }).verdict).toBe('unknown_client');
  });

  it('Google: accepted when it sends the browser to sign in', () => {
    expect(classifyProbe('google', { status: 302, location: 'https://accounts.google.com/v3/signin/identifier?x=1', body: '' }).verdict).toBe('accepted');
  });

  it('Meta: an unregistered redirect URL', () => {
    expect(classifyProbe('meta', { status: 200, location: '', body: 'URL blocked: This redirect failed because the redirect URI is not whitelisted' }).verdict).toBe(
      'redirect_not_registered',
    );
  });

  it('says so when the answer is unclear, rather than guessing', () => {
    expect(classifyProbe('linkedin', { status: 500, location: '', body: '' }).verdict).toBe('unchecked');
  });
});

describe('checkRedirects', () => {
  const entries = oauthRedirectUris('http://localhost:3001');

  it('maps each redirect URL to its provider', () => {
    const linkedin = entries.filter((e) => providerOf(e) === 'linkedin').map((e) => e.url);
    expect(linkedin).toEqual(['http://localhost:3001/api/auth/callback/linkedin', 'http://localhost:3001/api/linkedin/callback']);
  });

  it('asks only providers that have a client id, and never sends a secret', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 303, headers: { location: 'https://www.linkedin.com/uas/login' } }));
    const results = await checkRedirects(
      entries.filter((e) => ['linkedin', 'meta'].includes(providerOf(e))),
      { LINKEDIN_CLIENT_ID: 'li-id', LINKEDIN_CLIENT_SECRET: 'never-sent' },
      fetchMock as unknown as typeof fetch,
    );
    expect(results.find((r) => r.provider === 'meta')?.verdict).toBe('no_credentials');
    expect(results.filter((r) => r.provider === 'linkedin').every((r) => r.verdict === 'accepted')).toBe(true);
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([u]) => u);
    expect(urls.every((u) => u.includes('client_id=li-id') && !u.includes('never-sent'))).toBe(true);
    // Publishing asks for posting rights; sign-in does not.
    expect(urls.some((u) => u.includes('w_member_social'))).toBe(true);
  });
});
