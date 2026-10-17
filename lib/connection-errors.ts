/**
 * Turning provider failures into something a person can act on.
 *
 *   describeAuthFailure     an OAuth round-trip that did not finish
 *   classifyProviderError   a provider call that failed: was the credential
 *                           refused, the provider unreachable, or the account gone?
 *   isCredentialRejection   a publish/API status that means "reconnect"
 */

export interface AuthFailure {
  /** Stable code for the URL and tests. */
  code: string;
  title: string;
  message: string;
  /** What to do next. */
  action: 'retry' | 'reconnect' | 'ask_admin' | 'contact_support' | 'check_account';
}

const FAILURES: Record<string, Omit<AuthFailure, 'code'>> = {
  access_denied: {
    title: 'Permission was declined',
    message: 'The request was cancelled or declined at {name}. Connect again and choose “Allow” to give Aura access.',
    action: 'retry',
  },
  denied: {
    title: 'Permission was declined',
    message: 'The request was cancelled or declined at {name}. Connect again and choose “Allow” to give Aura access.',
    action: 'retry',
  },
  redirect_uri_mismatch: {
    title: 'This deployment isn’t registered with {name}',
    message: 'The callback address registered with {name} doesn’t match this site. An administrator needs to copy the exact address from the Connectors page into the {name} app settings.',
    action: 'contact_support',
  },
  invalid_scope: {
    title: '{name} refused a requested permission',
    message: 'The {name} app isn’t approved for one of the permissions Aura asks for. An administrator needs to enable it in the {name} app settings.',
    action: 'contact_support',
  },
  missing_code: {
    title: '{name} didn’t finish signing in',
    message: '{name} returned without an authorization code. Try connecting again.',
    action: 'retry',
  },
  bad_state: {
    title: 'The sign-in link expired',
    message: 'The connection took too long or was started in another tab. Start again from this page.',
    action: 'retry',
  },
  state_mismatch: {
    title: 'Security check failed',
    message: 'The sign-in was finished in a different browser or account than the one that started it. Start again from this page, in the same browser.',
    action: 'retry',
  },
  wrong_user: {
    title: 'Signed in as someone else',
    message: 'Finish the connection in the same Aura account that started it.',
    action: 'retry',
  },
  forbidden: {
    title: 'Only owners and admins can connect accounts',
    message: 'Ask an owner or admin of this workspace to connect {name}.',
    action: 'ask_admin',
  },
  not_configured: {
    title: '{name} isn’t set up on this deployment',
    message: 'The {name} app credentials haven’t been added to this deployment yet. An administrator needs to add them.',
    action: 'contact_support',
  },
  exchange_failed: {
    title: 'Couldn’t complete the connection',
    message: '{name} accepted the sign-in but didn’t issue access. This is usually temporary; try again.',
    action: 'retry',
  },
  no_accounts: {
    title: 'No account or page to connect',
    message: 'The {name} login has no account or page Aura can use. For Facebook, you need to be an admin of a Facebook Page.',
    action: 'check_account',
  },
  missing_permissions: {
    title: 'Some permissions weren’t granted',
    message: 'Connected, but without permissions Aura needs. Reconnect and leave every permission switched on.',
    action: 'reconnect',
  },
};

/** An OAuth error code (and the provider's description) → words and a next step. */
export function describeAuthFailure(code: string | null | undefined, name: string, description?: string | null): AuthFailure {
  const raw = (code ?? '').trim();
  const key =
    raw in FAILURES
      ? raw
      : /redirect_uri/i.test(`${raw} ${description ?? ''}`)
        ? 'redirect_uri_mismatch'
        : /scope/i.test(`${raw} ${description ?? ''}`)
          ? 'invalid_scope'
          : /denied|cancel/i.test(raw)
            ? 'access_denied'
            : null;
  if (key) {
    const f = FAILURES[key]!;
    const fill = (s: string) => s.replace(/\{name\}/g, name);
    return { code: key, title: fill(f.title), message: fill(f.message), action: f.action };
  }
  return {
    code: raw || 'unknown',
    title: `${name} couldn’t be connected`,
    message: description?.trim() ? `${name} said: ${description.trim().slice(0, 200)}. Try again.` : 'Something went wrong while connecting. Try again.',
    action: 'retry',
  };
}

export type ProviderErrorKind = 'rejected' | 'unreachable' | 'account';

/** A failed provider call: what kind of problem is it? */
export function classifyProviderError(message: string): ProviderErrorKind {
  if (/manages no Pages|no longer (?:manage|available)|not one this .* manages/i.test(message)) return 'account';
  if (/HTTP 40[13]\b|OAuthException|"code":\s*190|invalid_token|invalid_grant|token (?:has )?expired|revoked|unauthori[sz]ed/i.test(message)) {
    return 'rejected';
  }
  return 'unreachable';
}

/** An HTTP status / Graph error code from a publish that means the credential is bad. */
export function isCredentialRejection(status: number | null | undefined, code?: number | null): boolean {
  return code === 190 || status === 401;
}
