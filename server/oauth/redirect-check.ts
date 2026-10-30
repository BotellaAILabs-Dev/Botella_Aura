import type { RedirectUri } from '@/server/oauth/endpoints';

/**
 * Asks each OAuth provider whether it would accept this app's sign-in and
 * connect requests — before anyone tries to log in.
 *
 * A redirect URL missing from the provider's dashboard is the most common
 * reason "Sign in with LinkedIn" or "Connect" fails, and the failure is a
 * provider error page after the person has clicked, which names nothing. The
 * provider's authorization page answers the same question for anyone: it
 * either sends the browser on to its login page (app, redirect URL and scopes
 * accepted) or shows the error. Only the public client id is sent; no secret,
 * no account.
 *
 * Found this way, October 2026: the LinkedIn app had only
 * http://localhost:3000/api/linkedin/callback registered, while the app ran on
 * :3001 and the sign-in callback and the live site were not registered at all.
 */

export type RedirectVerdict =
  | 'accepted'
  | 'redirect_not_registered'
  | 'scope_not_allowed'
  | 'unknown_client'
  | 'no_credentials'
  | 'unchecked';

export interface RedirectCheck {
  label: string;
  url: string;
  provider: 'linkedin' | 'google' | 'meta' | 'other';
  verdict: RedirectVerdict;
  detail: string;
}

interface Probe {
  status: number;
  location: string;
  body: string;
}

/** What a provider's authorization page said, in one verdict. */
export function classifyProbe(provider: RedirectCheck['provider'], p: Probe): { verdict: RedirectVerdict; detail: string } {
  const text = `${p.location}\n${p.body}`;
  if (provider === 'linkedin') {
    if (/redirect_uri does not match the registered value/i.test(text)) return { verdict: 'redirect_not_registered', detail: 'LinkedIn: redirect_uri does not match the registered value' };
    if (/unauthorized_scope_error|not authorized for the requested scope/i.test(text)) return { verdict: 'scope_not_allowed', detail: 'LinkedIn: the app is not authorized for a requested scope (add the product in the LinkedIn app)' };
    if (/invalid_client|client_id.{0,40}invalid|application with client id/i.test(text)) return { verdict: 'unknown_client', detail: 'LinkedIn does not recognise LINKEDIN_CLIENT_ID' };
    if (p.status >= 300 && p.status < 400 && /linkedin\.com\/(uas\/login|login|checkpoint|oauth\/v2\/login)/.test(p.location)) return { verdict: 'accepted', detail: 'LinkedIn sends the browser to its login page' };
  }
  if (provider === 'google') {
    // Google sends errors to an error page on its own domain, with the reason
    // base64-encoded in `authError` — a redirect to accounts.google.com is not
    // on its own an acceptance.
    const authError = /[?&]authError=([^&]+)/.exec(p.location)?.[1];
    const decoded = authError ? Buffer.from(decodeURIComponent(authError), 'base64').toString('utf8') : '';
    if (/redirect_uri_mismatch/i.test(decoded)) return { verdict: 'redirect_not_registered', detail: 'Google: redirect_uri_mismatch' };
    if (/invalid_client|deleted_client/i.test(decoded)) return { verdict: 'unknown_client', detail: 'Google does not recognise GOOGLE_CLIENT_ID' };
    if (/oauth\/error|authError=/.test(p.location)) return { verdict: 'unchecked', detail: `Google showed an error page: ${decoded.slice(0, 120) || 'no reason given'}` };
    if (/redirect_uri_mismatch/i.test(text)) return { verdict: 'redirect_not_registered', detail: 'Google: redirect_uri_mismatch' };
    if (/invalid_client|OAuth client was not found/i.test(text)) return { verdict: 'unknown_client', detail: 'Google does not recognise GOOGLE_CLIENT_ID' };
    if (p.status >= 300 && p.status < 400 && /accounts\.google\.com/.test(p.location)) return { verdict: 'accepted', detail: 'Google sends the browser to its sign-in page' };
  }
  if (provider === 'meta') {
    if (/URL blocked|redirect_uri is not whitelisted|Can't load URL|isn't included in the app's domains/i.test(text)) return { verdict: 'redirect_not_registered', detail: 'Meta: the redirect URL is not in Valid OAuth Redirect URIs' };
    if (/Invalid App ID|app ID .{0,30}(invalid|does not exist)/i.test(text)) return { verdict: 'unknown_client', detail: 'Meta does not recognise META_CLIENT_ID' };
    if (p.status >= 300 && p.status < 400 && /facebook\.com\/(login|v\d)/.test(p.location)) return { verdict: 'accepted', detail: 'Meta sends the browser to its login page' };
  }
  return { verdict: 'unchecked', detail: `No clear answer (HTTP ${p.status}); try it in a browser` };
}

const PROVIDERS: Record<
  Exclude<RedirectCheck['provider'], 'other'>,
  { clientIdVar: string; url: (clientId: string, redirect: string, scope: string) => string; scope: (r: RedirectUri) => string }
> = {
  linkedin: {
    clientIdVar: 'LINKEDIN_CLIENT_ID',
    url: (id, redirect, scope) =>
      `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: redirect, scope, state: 'aura-check' })}`,
    // Publishing asks for posting rights as well; the scope check matters there.
    scope: (r) => (/callback\/linkedin$/.test(r.url) ? 'openid profile email' : 'openid profile email w_member_social'),
  },
  google: {
    clientIdVar: 'GOOGLE_CLIENT_ID',
    url: (id, redirect, scope) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: redirect, scope, state: 'aura-check' })}`,
    scope: () => 'openid email',
  },
  meta: {
    clientIdVar: 'META_CLIENT_ID',
    url: (id, redirect, scope) =>
      `https://www.facebook.com/v21.0/dialog/oauth?${new URLSearchParams({ client_id: id, redirect_uri: redirect, scope, state: 'aura-check' })}`,
    scope: () => 'public_profile',
  },
};

export function providerOf(entry: RedirectUri): RedirectCheck['provider'] {
  if (entry.credentials.includes('LINKEDIN_CLIENT_ID')) return 'linkedin';
  if (entry.credentials.includes('GOOGLE_CLIENT_ID')) return 'google';
  if (entry.credentials.includes('META_CLIENT_ID')) return 'meta';
  return 'other';
}

export async function checkRedirects(
  entries: RedirectUri[],
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<RedirectCheck[]> {
  const out: RedirectCheck[] = [];
  for (const entry of entries) {
    const provider = providerOf(entry);
    const base = { label: entry.label, url: entry.url, provider };
    if (provider === 'other') {
      out.push({ ...base, verdict: 'unchecked', detail: 'No automatic check for this provider' });
      continue;
    }
    const spec = PROVIDERS[provider];
    const clientId = env[spec.clientIdVar]?.trim();
    if (!clientId) {
      out.push({ ...base, verdict: 'no_credentials', detail: `${spec.clientIdVar} is not set` });
      continue;
    }
    try {
      const res = await fetchImpl(spec.url(clientId, entry.url, spec.scope(entry)), {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (Aura OAuth check)' },
        signal: AbortSignal.timeout(15_000),
      });
      const body = res.status === 200 || res.status >= 400 ? (await res.text()).slice(0, 200_000) : '';
      out.push({ ...base, ...classifyProbe(provider, { status: res.status, location: res.headers.get('location') ?? '', body }) });
    } catch (err) {
      out.push({ ...base, verdict: 'unchecked', detail: `Could not reach the provider: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}
