import type { OAuthConfig, OAuthUserConfig } from 'next-auth/providers/index';

/**
 * "Sign in with LinkedIn" for NextAuth, defined here rather than imported from
 * `next-auth/providers/linkedin`.
 *
 * The bundled provider is written against LinkedIn's retired v2 REST profile
 * API: it asks `/v2/me` for a `localizedFirstName` projection and `/v2/emailAddress`
 * for the address. Both need the `r_liteprofile` and `r_emailaddress` scopes,
 * which LinkedIn no longer grants — an app created today gets "Sign In with
 * LinkedIn using OpenID Connect" (`openid profile email`) instead. Pairing
 * those scopes with those endpoints fails at the last step of the flow, after
 * the user has already consented, and surfaces as NextAuth's generic
 * `OAuthProfile` error with the real 403 only in the server log.
 *
 * So: OIDC scopes, and `/v2/userinfo` to read them back.
 *
 * Deliberately typed `oauth` and not `oidc`. LinkedIn does return an id_token,
 * but declaring this an OIDC provider makes next-auth verify it against
 * LinkedIn's JWKS and discovery document, which has broken repeatedly on
 * LinkedIn's side. The access token against `/v2/userinfo` asks LinkedIn the
 * same question over a path LinkedIn keeps working, and the authorization-code
 * exchange is itself the proof of identity here.
 */
export interface LinkedInOidcProfile extends Record<string, unknown> {
  /** LinkedIn's stable member id — the OAuth account id we store. */
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  /** Present on LinkedIn's userinfo; consulted before any account linking. */
  email_verified?: boolean;
  picture?: string;
}

export const LINKEDIN_AUTHORIZATION_URL =
  'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

/**
 * Sign-in asks for identity only. Posting rights (`w_member_social`) belong to
 * the separate connection flow in server/services/linkedin.service.ts, which a
 * workspace owner grants on purpose — logging in is not the moment to ask
 * someone for permission to publish as them.
 */
export const LINKEDIN_SIGNIN_SCOPES = 'openid profile email';

export function LinkedInSignIn(
  options: OAuthUserConfig<LinkedInOidcProfile>,
): OAuthConfig<LinkedInOidcProfile> {
  return {
    id: 'linkedin',
    name: 'LinkedIn',
    type: 'oauth',
    authorization: {
      url: LINKEDIN_AUTHORIZATION_URL,
      params: { scope: LINKEDIN_SIGNIN_SCOPES },
    },
    token: LINKEDIN_TOKEN_URL,
    userinfo: LINKEDIN_USERINFO_URL,
    // LinkedIn reads the client secret from the form body, not Basic auth.
    client: { token_endpoint_auth_method: 'client_secret_post' },
    /**
     * State only. LinkedIn enables PKCE per app on request, so sending a
     * code_challenge to an app without it rejects the exchange. CSRF is
     * covered by the state cookie either way.
     */
    checks: ['state'],
    profile(profile) {
      const name =
        profile.name ||
        [profile.given_name, profile.family_name].filter(Boolean).join(' ') ||
        null;
      return {
        id: profile.sub,
        name,
        email: profile.email ?? null,
        image: profile.picture ?? null,
      };
    },
    options,
  };
}

/**
 * Whether an OAuth profile's email is good enough to attach to an account that
 * already exists under that address.
 *
 * `allowDangerousEmailAccountLinking` is what makes "log in with LinkedIn" find
 * the workspace someone signed up for with a password, instead of silently
 * creating a second empty one. The danger in its name is real though: a
 * provider that hands out an address it never confirmed would let anyone
 * register that address there and walk into the matching Aura account. Google
 * and LinkedIn both confirm, and both say so in `email_verified`.
 *
 * Only an explicit `false` refuses. A missing claim is treated as acceptable on
 * purpose: both providers document sending it, so its absence means the
 * response shape changed, and locking every user out of sign-in is the worse
 * failure of the two.
 */
export function oauthEmailLinkable(profile: unknown): boolean {
  if (!profile || typeof profile !== 'object') return true;
  const verified = (profile as { email_verified?: unknown }).email_verified;
  if (verified === false || verified === 'false') return false;
  return true;
}
