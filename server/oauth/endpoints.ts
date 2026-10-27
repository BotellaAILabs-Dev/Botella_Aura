/**
 * Every URL a provider's dashboard has to know about, for one base URL.
 *
 * This exists because the list was previously spread across four files and a
 * person's memory, and the cost of getting one wrong is `redirect_uri_mismatch`
 * — a failure that happens after consent, names no URL, and looks identical
 * whether the registered value has the wrong port, the wrong scheme, or a
 * trailing slash. The base URL is a parameter rather than read from the
 * environment so the same list can be printed for a laptop, a tunnel and
 * production without deploying anything.
 */
import { SOCIAL_PROVIDERS } from '@/lib/social-signin';
import { oauthRedirectPaths } from '@/server/connectors/providers';

export interface RedirectUri {
  /** Human name for this entry. */
  label: string;
  /** The exact string to paste into the provider's dashboard. */
  url: string;
  /** Where in that dashboard it goes. */
  register: string;
  /** Env vars that must hold this app's credentials. */
  credentials: string[];
  /** What this URL is for, so an unused one can be recognised as unused. */
  purpose: string;
}

/**
 * Accept what someone is likely to type: a port on its own, a host:port, a
 * bare domain, or a full URL. A port alone means this machine, so http;
 * a hostname means the internet, so https. Trailing slashes go — providers
 * compare redirect URIs as exact strings, and `…/callback/` is not `…/callback`.
 */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, '');
  if (!raw) throw new Error('A base URL, host:port or port is required.');

  if (/^\d{2,5}$/.test(raw)) return `http://localhost:${raw}`;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw);
  return `${local ? 'http' : 'https'}://${raw}`;
}

/** Nicer names than the env var can give us. */
const CONNECTOR_GROUPS: Record<string, string> = {
  GOOGLE: 'Google (Analytics + Search Console)',
  META: 'Meta (Facebook & Instagram)',
  HUBSPOT: 'HubSpot',
  MAILCHIMP: 'Mailchimp',
  SLACK: 'Slack',
};

export function oauthRedirectUris(baseUrl: string): RedirectUri[] {
  const base = normalizeBaseUrl(baseUrl);
  const uris: RedirectUri[] = [];

  // 1. Logging in. NextAuth owns these paths; the provider id is the last
  //    segment and is not ours to choose.
  for (const provider of SOCIAL_PROVIDERS) {
    uris.push({
      label: `Log in with ${provider.label}`,
      url: `${base}/api/auth/callback/${provider.id}`,
      register: provider.console,
      credentials: [provider.clientIdEnv, provider.clientSecretEnv],
      purpose: `The "Continue with ${provider.label}" button on /login and /signup.`,
    });
  }

  // 2. LinkedIn again, for the publishing connection — a different flow with
  //    different scopes and therefore a second registered URL on the same app.
  uris.push({
    label: 'Connect LinkedIn (publishing)',
    url: `${base}/api/linkedin/callback`,
    register:
      'LinkedIn Developers → your app → Auth → OAuth 2.0 settings → Authorized redirect URLs',
    credentials: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    purpose:
      'Settings → Connections → LinkedIn. Asks for w_member_social as well, so approved posts can be published.',
  });

  // 3. The data connectors.
  for (const group of oauthRedirectPaths()) {
    const key = group.label.replace(/ /g, '_').toUpperCase();
    uris.push({
      label: CONNECTOR_GROUPS[key] ?? group.label,
      url: `${base}${group.path}`,
      register: `${CONNECTOR_GROUPS[key] ?? group.label} developer dashboard → OAuth redirect URIs`,
      credentials: [`${key}_CLIENT_ID`, `${key}_CLIENT_SECRET`],
      purpose: `Settings → Connections: ${group.connectors.join(', ')}.`,
    });
  }

  return uris;
}

/**
 * Not redirect URIs — these are URLs a provider calls on its own schedule, and
 * they are registered somewhere else in the same dashboards, so they belong in
 * the same printout.
 */
export function webhookEndpoints(baseUrl: string): RedirectUri[] {
  const base = normalizeBaseUrl(baseUrl);
  return [
    {
      label: 'WhatsApp webhook',
      url: `${base}/api/webhooks/whatsapp`,
      register:
        'Meta app → WhatsApp → Configuration → Webhook (Callback URL + Verify token), subscribed to `messages`',
      credentials: ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'],
      purpose:
        'Inbound WhatsApp messages. Must be public HTTPS — Meta will not call a localhost address.',
    },
    {
      label: 'Stripe webhook',
      url: `${base}/api/webhooks/stripe`,
      register: 'Stripe Dashboard → Developers → Webhooks → Add endpoint',
      credentials: ['STRIPE_WEBHOOK_SECRET'],
      purpose: 'Subscription and payment state.',
    },
  ];
}

/**
 * `NEXTAUTH_URL` has to agree with the base URL being registered. When it does
 * not, NextAuth builds its callback from NEXTAUTH_URL, sends the provider a URL
 * nobody registered, and the mismatch is reported by the provider rather than
 * by us — so check it here, where the port is already in hand.
 */
export function nextAuthUrlMismatch(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const base = normalizeBaseUrl(baseUrl);
  const configured = env.NEXTAUTH_URL?.trim();
  if (!configured) {
    return 'NEXTAUTH_URL is not set. NextAuth needs it to build these callback URLs — set it to ' + base + '.';
  }
  const normalized = normalizeBaseUrl(configured);
  if (normalized !== base) {
    return `NEXTAUTH_URL is ${normalized}, but these URLs are for ${base}. Sign-in will send the provider ${normalized}/api/auth/callback/… and the provider will reject it. Set NEXTAUTH_URL=${base}.`;
  }
  return null;
}
