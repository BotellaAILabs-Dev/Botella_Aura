import { GoogleButton } from '@/components/auth/google-button';
import { LinkedInButton } from '@/components/auth/linkedin-button';
import type { SocialProviderId } from '@/lib/social-signin';

/**
 * The social sign-in buttons this deployment can offer.
 *
 * `providers` comes from enabledSocialProviders() on the server, so the set of
 * buttons is the set of providers NextAuth actually built. The login and signup
 * pages render this one component rather than each listing the providers again,
 * which is how one of them would come to be missing a provider the other had.
 */
export function SocialButtons({
  providers,
  callbackUrl,
  mode = 'login',
}: {
  providers: SocialProviderId[];
  callbackUrl: string;
  mode?: 'login' | 'signup';
}) {
  const verb = mode === 'signup' ? 'Sign up with' : 'Continue with';
  return (
    <div className="space-y-2">
      {providers.includes('google') && (
        <GoogleButton callbackUrl={callbackUrl} label={`${verb} Google`} />
      )}
      {providers.includes('linkedin') && (
        <LinkedInButton callbackUrl={callbackUrl} label={`${verb} LinkedIn`} />
      )}
    </div>
  );
}
