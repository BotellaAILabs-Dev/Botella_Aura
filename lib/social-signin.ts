/**
 * Which social sign-in buttons to offer, decided from the same credentials that
 * decide whether the provider exists at all.
 *
 * Those two decisions used to live apart: the login page tested the env vars
 * itself, while lib/auth.ts built its provider list from its own copy of the
 * same test. A button rendered without its provider behind it sends people to
 * NextAuth's generic "Try signing in with a different account" error, which
 * names nothing and points nowhere — the actual cause being one credential
 * missing on the deployment. One predicate, used by both, cannot drift.
 */
export type SocialProviderId = 'google' | 'linkedin';

export interface SocialProvider {
  id: SocialProviderId;
  /** Shown on the button, as the provider's own brand guidelines require. */
  label: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Where the deployment registers the callback URL. */
  console: string;
}

export const SOCIAL_PROVIDERS: readonly SocialProvider[] = [
  {
    id: 'google',
    label: 'Google',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    console: 'Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client ID → Authorised redirect URIs',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
    console: 'LinkedIn Developers → your app → Auth → OAuth 2.0 settings → Authorized redirect URLs',
  },
] as const;

type Env = Record<string, string | undefined>;

const isSet = (env: Env, key: string) => Boolean(env[key]?.trim());

/** Both halves of the credential pair present. One alone is a paste mistake. */
export function socialProviderConfigured(
  id: SocialProviderId,
  env: Env = process.env,
): boolean {
  const provider = SOCIAL_PROVIDERS.find((p) => p.id === id);
  if (!provider) return false;
  return isSet(env, provider.clientIdEnv) && isSet(env, provider.clientSecretEnv);
}

/** The providers a visitor can actually use, in display order. */
export function enabledSocialProviders(env: Env = process.env): SocialProviderId[] {
  return SOCIAL_PROVIDERS.filter((p) => socialProviderConfigured(p.id, env)).map(
    (p) => p.id,
  );
}

/**
 * A provider with exactly one of its two variables set — worth saying out loud,
 * because the symptom is a button that silently never appears.
 */
export function partiallyConfiguredSocialProviders(
  env: Env = process.env,
): { id: SocialProviderId; missing: string[] }[] {
  return SOCIAL_PROVIDERS.flatMap((p) => {
    const vars = [p.clientIdEnv, p.clientSecretEnv];
    const missing = vars.filter((v) => !isSet(env, v));
    return missing.length === 1 ? [{ id: p.id, missing }] : [];
  });
}
