import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sign-in with Google and with LinkedIn.
 *
 * Three things here have each been a real failure:
 *
 *  1. A button drawn for a provider that was never built. The login page used
 *     to test the env vars itself, so the two tests could disagree, and the
 *     result was the unexplained "Try signing in with a different account".
 *  2. The retired LinkedIn profile API. `next-auth/providers/linkedin` still
 *     calls /v2/me with an `r_liteprofile` projection, which an app created
 *     today is not granted — it fails after consent, which is the most
 *     expensive moment to fail.
 *  3. Email-based account linking with an address the provider never verified.
 */
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: async () => null } } }));
vi.mock('@/server/services/audit.service', () => ({ recordAudit: async () => {} }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function withCredentials(which: 'none' | 'google' | 'linkedin' | 'both') {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.LINKEDIN_CLIENT_ID;
  delete process.env.LINKEDIN_CLIENT_SECRET;
  if (which === 'google' || which === 'both') {
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
  }
  if (which === 'linkedin' || which === 'both') {
    process.env.LINKEDIN_CLIENT_ID = 'li-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'li-secret';
  }
}

async function providerIds(): Promise<string[]> {
  const { authOptions } = await import('@/lib/auth');
  return authOptions.providers.map((p) => (p as { id: string }).id);
}

describe('provider list', () => {
  it('always offers email and password', async () => {
    withCredentials('none');
    expect(await providerIds()).toEqual(['credentials']);
  });

  it('adds each social provider when its credentials are present', async () => {
    withCredentials('both');
    const ids = await providerIds();
    expect(ids).toContain('google');
    expect(ids).toContain('linkedin');
  });

  it('leaves out a provider with only half its credentials', async () => {
    withCredentials('none');
    process.env.LINKEDIN_CLIENT_ID = 'li-id'; // secret missing
    expect(await providerIds()).not.toContain('linkedin');
  });

  /**
   * The parity check. The page asks lib/social-signin which buttons to draw;
   * lib/auth asks the same module which providers to build. If those ever
   * diverge someone meets a dead button, so assert they agree for every
   * combination rather than for the one we happen to run locally.
   */
  it.each(['none', 'google', 'linkedin', 'both'] as const)(
    'draws exactly the buttons that have a provider behind them (%s)',
    async (which) => {
      withCredentials(which);
      const { enabledSocialProviders } = await import('@/lib/social-signin');
      const buttons = enabledSocialProviders();
      const built = (await providerIds()).filter((id) => id !== 'credentials');
      expect([...buttons].sort()).toEqual([...built].sort());
    },
  );
});

describe('linkedin provider', () => {
  it('reads the profile from the OpenID Connect userinfo endpoint', async () => {
    const { LinkedInSignIn } = await import('@/lib/auth-linkedin');
    const provider = LinkedInSignIn({ clientId: 'a', clientSecret: 'b' });

    expect(provider.userinfo).toBe('https://api.linkedin.com/v2/userinfo');
    // The retired API, and the scopes that went with it, must not come back.
    const serialized = JSON.stringify(provider);
    expect(serialized).not.toContain('/v2/me');
    expect(serialized).not.toContain('r_liteprofile');
    expect(serialized).not.toContain('r_emailaddress');
  });

  it('asks only for identity, not for permission to post', async () => {
    const { LinkedInSignIn } = await import('@/lib/auth-linkedin');
    const provider = LinkedInSignIn({ clientId: 'a', clientSecret: 'b' });
    const scope = (provider.authorization as { params: { scope: string } }).params
      .scope;

    expect(scope.split(' ').sort()).toEqual(['email', 'openid', 'profile']);
    expect(scope).not.toContain('w_member_social');
  });

  /**
   * PKCE is turned on per app at the provider. Sending a code_challenge to an
   * app without it makes the token exchange fail, so the default must stay
   * state-only — next-auth sends PKCE only when `checks` lists it.
   */
  it('does not send PKCE', async () => {
    const { LinkedInSignIn } = await import('@/lib/auth-linkedin');
    const provider = LinkedInSignIn({ clientId: 'a', clientSecret: 'b' });
    expect(provider.checks).toEqual(['state']);
  });

  it('maps a userinfo payload onto a user', async () => {
    const { LinkedInSignIn } = await import('@/lib/auth-linkedin');
    const provider = LinkedInSignIn({ clientId: 'a', clientSecret: 'b' });

    const user = await provider.profile!(
      {
        sub: 'Abc123',
        name: 'Praneeth Reddy',
        email: 'p@example.com',
        email_verified: true,
        picture: 'https://media.example.com/p.jpg',
      },
      {} as never,
    );

    expect(user).toEqual({
      id: 'Abc123',
      name: 'Praneeth Reddy',
      email: 'p@example.com',
      image: 'https://media.example.com/p.jpg',
    });
  });

  it('falls back to the name parts when no full name is sent', async () => {
    const { LinkedInSignIn } = await import('@/lib/auth-linkedin');
    const provider = LinkedInSignIn({ clientId: 'a', clientSecret: 'b' });

    const user = await provider.profile!(
      { sub: 'x', given_name: 'Ada', family_name: 'Lovelace' },
      {} as never,
    );

    expect(user.name).toBe('Ada Lovelace');
    expect(user.email).toBeNull();
  });
});

describe('email account linking', () => {
  it('refuses an address the provider says it has not verified', async () => {
    const { oauthEmailLinkable } = await import('@/lib/auth-linkedin');
    expect(oauthEmailLinkable({ email_verified: false })).toBe(false);
  });

  it('accepts a verified address', async () => {
    const { oauthEmailLinkable } = await import('@/lib/auth-linkedin');
    expect(oauthEmailLinkable({ email_verified: true })).toBe(true);
  });

  /**
   * A missing claim is allowed on purpose. Both providers document sending it,
   * so its absence means the response changed shape — and locking everyone out
   * of sign-in is a worse outcome than the risk it would avert.
   */
  it('allows a profile that does not mention verification', async () => {
    const { oauthEmailLinkable } = await import('@/lib/auth-linkedin');
    expect(oauthEmailLinkable({ email: 'a@b.com' })).toBe(true);
    expect(oauthEmailLinkable(undefined)).toBe(true);
  });

  it('turns away an unverified OAuth sign-in at the callback', async () => {
    withCredentials('both');
    const { authOptions } = await import('@/lib/auth');

    const refused = await authOptions.callbacks!.signIn!({
      user: { id: 'u1' } as never,
      account: { provider: 'linkedin', type: 'oauth' } as never,
      profile: { email_verified: false } as never,
    });
    expect(refused).toBe('/login?error=EmailNotVerified');

    const allowed = await authOptions.callbacks!.signIn!({
      user: { id: 'u1' } as never,
      account: { provider: 'linkedin', type: 'oauth' } as never,
      profile: { email_verified: true } as never,
    });
    expect(allowed).toBe(true);
  });

  it('never blocks a password sign-in', async () => {
    withCredentials('both');
    const { authOptions } = await import('@/lib/auth');
    const ok = await authOptions.callbacks!.signIn!({
      user: { id: 'u1' } as never,
      account: { provider: 'credentials', type: 'credentials' } as never,
    });
    expect(ok).toBe(true);
  });
});

describe('sign-in error messages', () => {
  it('explains a rejected redirect URI, and says how to find the right one', async () => {
    const { authErrorMessage } = await import('@/lib/auth-errors');
    const message = authErrorMessage('OAuthCallback')!;
    expect(message).toMatch(/redirect/i);
    expect(message).toMatch(/auth:endpoints/);
  });

  it('says something for a code it does not know, rather than nothing', async () => {
    const { authErrorMessage } = await import('@/lib/auth-errors');
    expect(authErrorMessage('SomethingNew')).toBeTruthy();
    expect(authErrorMessage(undefined)).toBeNull();
  });
});
