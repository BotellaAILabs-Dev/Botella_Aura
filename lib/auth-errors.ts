/**
 * NextAuth sends every failed sign-in to `pages.error`, which is our own
 * /login, carrying a code in `?error=`. Nothing read it, so a failed Google or
 * LinkedIn sign-in dropped the person back on a clean login form with no
 * indication anything had gone wrong — they would try again, get the same
 * nothing, and conclude login was broken.
 *
 * These are the codes NextAuth v4 actually emits for an OAuth flow, plus
 * `EmailNotVerified`, which lib/auth.ts raises itself.
 */
export type AuthErrorCode =
  | 'Configuration'
  | 'AccessDenied'
  | 'Verification'
  | 'OAuthSignin'
  | 'OAuthCallback'
  | 'OAuthCreateAccount'
  | 'OAuthAccountNotLinked'
  | 'EmailCreateAccount'
  | 'Callback'
  | 'CredentialsSignin'
  | 'SessionRequired'
  | 'EmailNotVerified';

const MESSAGES: Record<AuthErrorCode, string> = {
  Configuration:
    'Sign-in is not finished being set up on this deployment. An administrator needs to check the provider credentials.',
  AccessDenied:
    'The sign-in was cancelled, or the provider declined to share your account.',
  Verification: 'That sign-in link has expired or has already been used.',
  OAuthSignin: 'Could not reach the provider to start sign-in. Please try again.',
  OAuthCallback:
    'The provider rejected the sign-in. This is usually a redirect URL that is not registered for this app — an administrator can check it with `npm run auth:endpoints`.',
  OAuthCreateAccount: 'Could not create an account from that provider profile.',
  OAuthAccountNotLinked:
    'That email address already has an account created a different way. Log in the way you did the first time, then link this provider from Settings.',
  EmailCreateAccount: 'Could not create an account for that email address.',
  Callback: 'Something went wrong finishing the sign-in. Please try again.',
  CredentialsSignin: 'Incorrect email or password.',
  SessionRequired: 'Please log in to continue.',
  EmailNotVerified:
    'That provider has not verified your email address, so it cannot be used to sign in here. Verify it with the provider, or log in with a password.',
};

/**
 * A sentence to show the person, or null when there is nothing to say.
 * An unrecognized code still gets a message: silence is the bug being fixed.
 */
export function authErrorMessage(code: string | undefined | null): string | null {
  if (!code) return null;
  return (
    MESSAGES[code as AuthErrorCode] ??
    'Sign-in did not complete. Please try again.'
  );
}
