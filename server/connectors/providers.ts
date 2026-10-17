/**
 * Connector provider definitions — the server-side half of the Connectors
 * module.
 *
 * `lib/connectors.ts` stays the client-safe presentation registry (name,
 * category, colour). This file holds everything that must never reach the
 * browser: OAuth endpoints, which environment variables hold the app
 * credentials, and how to verify a connection actually works.
 *
 * A provider is *implemented* when it appears here. Whether it is *usable*
 * depends on credentials being present, which is a deployment question, not a
 * code question — `providerReadiness()` reports the difference honestly instead
 * of showing an eternal "Coming soon".
 */
import {
  choosePage,
  graphUrl,
  META_GRAPH_VERSION,
  META_SCOPES,
  pageLabel,
  pageMetadata,
  pagesFrom,
  grantedFrom,
} from '@/lib/meta';

export type ProviderAuth = 'oauth' | 'api_key';

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /**
   * Callback path registered with the provider, when it differs from the
   * per-connector default of `/api/connectors/<id>/callback`.
   *
   * Google is the reason this exists. GA4 and Search Console are one OAuth
   * client with two connector ids, so the default gave them two redirect URIs,
   * each needing separate registration in Google Cloud — and any that was
   * missed produced `Error 400: redirect_uri_mismatch`. Pointing both at one
   * shared path means a single URI to register and nothing to miss. Which
   * connector is being connected is read from the signed `state`, which is
   * authoritative regardless of the path.
   */
  redirectPath?: string;
  /** Extra params appended to the authorize URL (e.g. Google's offline access). */
  authorizeParams?: Record<string, string>;
  /** Env var holding the OAuth client id. */
  clientIdEnv: string;
  /** Env var holding the OAuth client secret. */
  clientSecretEnv: string;
  /** Send credentials as HTTP Basic instead of form fields (Mailchimp, X). */
  basicAuth?: boolean;
  /**
   * Swap the token the code exchange returned for a better one before it is
   * stored — Meta's short-lived (1–2 h) user token for its long-lived one
   * (about 60 days), which is what makes a Meta connection usable at all.
   */
  upgradeToken?: (token: { accessToken: string; expiresAt?: Date }) => Promise<{ accessToken: string; expiresAt?: Date }>;
  /**
   * Env flag that turns on sending PKCE (code_challenge / code_verifier) to
   * this provider — only once it is confirmed to accept PKCE for this app.
   * The browser binding (lib/pkce.ts) applies to every provider regardless.
   */
  pkceEnv?: string;
}

export interface ApiKeyConfig {
  /** Field label shown in the UI, e.g. "Crunchbase user key". */
  label: string;
  /** Where to get one. */
  helpUrl: string;
  /** Optional second field (e.g. a search-engine id alongside an API key). */
  secondaryLabel?: string;
  secondaryMetadataKey?: string;
  /**
   * Env var that provides a deployment-wide fallback. When set, the connector
   * works for every workspace without anyone pasting a key.
   */
  fallbackEnv?: string;
  fallbackSecondaryEnv?: string;
}

export interface ConnectorProvider {
  id: string;
  auth: ProviderAuth;
  /** One line on what connecting actually unlocks inside Aura. */
  unlocks: string;
  oauth?: OAuthConfig;
  apiKey?: ApiKeyConfig;
  /**
   * Verify credentials against the provider and return a display label.
   * Throws with a human-readable message when the credentials are rejected.
   *
   * May also return non-secret `metadata` to store on the connection. Meta uses
   * this to record which Instagram Business account the token can publish to,
   * discovered once at connect time rather than re-derived on every post.
   */
  verify: (creds: ProviderCredentials) => Promise<{
    accountLabel: string;
    metadata?: Record<string, unknown>;
  }>;
  /**
   * The permissions this token was actually granted, asked of the provider.
   * Only for providers whose token response does not say (Meta). Others use
   * the `scope` the token exchange returned.
   */
  grantedScopes?: (accessToken: string) => Promise<string[]>;
  /**
   * Withdraw Aura's access at the provider, so a disconnect removes it there
   * too (not only Aura's copy). Best-effort: callers never let it block.
   */
  revoke?: (creds: { accessToken?: string; refreshToken?: string }) => Promise<void>;
}

/** Google: revoking either token withdraws the whole grant. */
async function revokeGoogle({ accessToken, refreshToken }: { accessToken?: string; refreshToken?: string }) {
  const token = refreshToken ?? accessToken;
  if (!token) return;
  const res = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    cache: 'no-store',
  });
  // 400 = already invalid, which is the outcome we want.
  if (!res.ok && res.status !== 400) throw new Error(`Google revoke failed (HTTP ${res.status}).`);
}

export interface ProviderCredentials {
  accessToken?: string;
  apiKey?: string;
  metadata?: Record<string, unknown>;
}

/** The one Google redirect URI to register in Google Cloud Console. */
export const GOOGLE_REDIRECT_PATH = '/api/connectors/google/callback';

const GOOGLE_OAUTH: Omit<OAuthConfig, 'scopes'> = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  clientIdEnv: 'GOOGLE_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  redirectPath: GOOGLE_REDIRECT_PATH,
};

/** Small helper so every verify() failure reads the same way. */
async function getJsonOrThrow(
  url: string,
  init: RequestInit,
  provider: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    throw new Error(
      `Could not reach ${provider}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${provider} rejected the credentials (HTTP ${res.status}). ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${provider} returned a response we could not read.`);
  }
}

export const PROVIDERS: Record<string, ConnectorProvider> = {
  // --- Analytics (Google OAuth) -------------------------------------------
  ga4: {
    id: 'ga4',
    auth: 'oauth',
    unlocks:
      'Reads your GA4 property traffic and conversions so Analytics and the Marketing Intelligence dashboard use real site numbers instead of estimates.',
    oauth: {
      ...GOOGLE_OAUTH,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    },
    revoke: revokeGoogle,
    async verify({ accessToken }) {
      const data = await getJsonOrThrow(
        'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
        { headers: { authorization: `Bearer ${accessToken}` } },
        'Google Analytics',
      );
      const summaries = (data.accountSummaries ?? []) as {
        displayName?: string;
        propertySummaries?: { displayName?: string }[];
      }[];
      const first = summaries[0];
      const property = first?.propertySummaries?.[0]?.displayName;
      return {
        accountLabel:
          property ?? first?.displayName ?? 'Google Analytics account',
      };
    },
  },

  'search-console': {
    id: 'search-console',
    auth: 'oauth',
    unlocks:
      'Reads the search queries and pages driving traffic to your site, so content suggestions are grounded in what people actually search for.',
    oauth: {
      ...GOOGLE_OAUTH,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    },
    revoke: revokeGoogle,
    async verify({ accessToken }) {
      const data = await getJsonOrThrow(
        'https://searchconsole.googleapis.com/webmasters/v3/sites',
        { headers: { authorization: `Bearer ${accessToken}` } },
        'Google Search Console',
      );
      const sites = (data.siteEntry ?? []) as { siteUrl?: string }[];
      return {
        accountLabel: sites[0]?.siteUrl ?? 'Search Console account',
      };
    },
  },

  // --- CRM & Email ---------------------------------------------------------
  hubspot: {
    id: 'hubspot',
    auth: 'oauth',
    unlocks:
      'Reads contacts and deal stages so lead scoring and outreach can reflect what is already in your CRM.',
    oauth: {
      authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
      tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
      scopes: ['oauth', 'crm.objects.contacts.read', 'crm.objects.deals.read'],
      clientIdEnv: 'HUBSPOT_CLIENT_ID',
      clientSecretEnv: 'HUBSPOT_CLIENT_SECRET',
    },
    async verify({ accessToken }) {
      const data = await getJsonOrThrow(
        'https://api.hubapi.com/account-info/v3/details',
        { headers: { authorization: `Bearer ${accessToken}` } },
        'HubSpot',
      );
      return {
        accountLabel: String(
          data.companyName ?? data.portalId ?? 'HubSpot account',
        ),
      };
    },
  },

  mailchimp: {
    id: 'mailchimp',
    auth: 'oauth',
    unlocks:
      'Reads campaign and audience performance so email results feed the same reporting as your social content.',
    oauth: {
      authorizeUrl: 'https://login.mailchimp.com/oauth2/authorize',
      tokenUrl: 'https://login.mailchimp.com/oauth2/token',
      scopes: [],
      clientIdEnv: 'MAILCHIMP_CLIENT_ID',
      clientSecretEnv: 'MAILCHIMP_CLIENT_SECRET',
    },
    async verify({ accessToken }) {
      const data = await getJsonOrThrow(
        'https://login.mailchimp.com/oauth2/metadata',
        { headers: { authorization: `OAuth ${accessToken}` } },
        'Mailchimp',
      );
      const login = data.login as { login_email?: string } | undefined;
      return {
        accountLabel: String(
          login?.login_email ?? data.accountname ?? 'Mailchimp account',
        ),
      };
    },
  },

  // --- Social & Publishing -------------------------------------------------
  /**
   * Meta (Facebook Pages + Instagram Business).
   *
   * This is what makes Instagram publishing real rather than a stub. Instagram
   * has no self-serve posting API: the token comes from a Facebook Login flow,
   * and the account that posts is an Instagram Business account linked to a
   * Page the connected user administers.
   *
   * verify() does the discovery once, at connect time, and stores the resulting
   * Instagram account id in the connection's non-secret metadata. Doing it here
   * means the publisher needs one credential lookup instead of three Graph
   * calls per post, and — more importantly — a workspace whose Instagram is not
   * actually linked to a Page finds out while connecting rather than when a
   * scheduled post fails.
   */
  meta: {
    id: 'meta',
    auth: 'oauth',
    unlocks:
      'Publishes approved posts, with their images, to your Facebook Page and the Instagram Business or Creator account linked to it.',
    oauth: {
      authorizeUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
      tokenUrl: graphUrl('oauth/access_token'),
      scopes: [...META_SCOPES],
      clientIdEnv: 'META_CLIENT_ID',
      clientSecretEnv: 'META_CLIENT_SECRET',
      // Meta documents PKCE for its manual login flow (OIDC variant); turn on
      // once tested with this app's permissions (docs/META-INTEGRATION.md).
      pkceEnv: 'META_OAUTH_PKCE',
      // Facebook Login returns a 1–2 hour token and no refresh token: without
      // this exchange a connection silently expired the same afternoon. The
      // long-lived token lasts about 60 days, and Page tokens derived from it
      // do not expire — the publishers fetch one per post.
      async upgradeToken({ accessToken }) {
        const url = new URL(graphUrl('oauth/access_token'));
        url.searchParams.set('grant_type', 'fb_exchange_token');
        url.searchParams.set('client_id', process.env.META_CLIENT_ID ?? '');
        url.searchParams.set('client_secret', process.env.META_CLIENT_SECRET ?? '');
        url.searchParams.set('fb_exchange_token', accessToken);
        const data = await getJsonOrThrow(url.toString(), {}, 'Meta');
        const token = typeof data.access_token === 'string' ? data.access_token : '';
        if (!token) throw new Error('Meta did not return a long-lived token.');
        const expiresIn = Number(data.expires_in ?? 0);
        return {
          accessToken: token,
          // No expires_in means Meta did not set one (rare): treat as not expiring.
          ...(expiresIn > 0 ? { expiresAt: new Date(Date.now() + expiresIn * 1000) } : {}),
        };
      },
    },
    /**
     * Which Pages the person manages, and the Instagram professional account
     * linked to each. Stored as ids and names only — Page tokens are never
     * stored; the publishers derive a fresh one per post. Reconnecting keeps
     * the Page chosen before, when it is still available.
     */
    async verify({ accessToken, metadata }) {
      const token = encodeURIComponent(String(accessToken));
      const [accounts, me] = await Promise.all([
        getJsonOrThrow(graphUrl(`me/accounts?fields=id,name,instagram_business_account{id,username}&limit=50&access_token=${token}`), {}, 'Meta'),
        getJsonOrThrow(graphUrl(`me?fields=id&access_token=${token}`), {}, 'Meta').catch(() => ({}) as Record<string, unknown>),
      ]);
      const pages = pagesFrom(accounts);
      const previous = typeof metadata?.pageId === 'string' ? metadata.pageId : null;
      const page = choosePage(pages, previous);
      if (!page) {
        throw new Error(
          'This Facebook account manages no Pages. Publishing needs a Page you administer — ' +
            'create one in Meta Business Suite, then reconnect.',
        );
      }
      const fbUserId = typeof me.id === 'string' ? me.id : null;
      return { accountLabel: pageLabel(page), metadata: pageMetadata(page, pages, fbUserId) };
    },
    /** Meta's token response has no scope; /me/permissions says what was granted. */
    async grantedScopes(accessToken) {
      const data = await getJsonOrThrow(graphUrl(`me/permissions?access_token=${encodeURIComponent(accessToken)}`), {}, 'Meta');
      return grantedFrom(data);
    },
    /** Removes the app from the person's Facebook settings (all permissions). */
    async revoke({ accessToken }) {
      if (!accessToken) return;
      const res = await fetch(graphUrl(`me/permissions?access_token=${encodeURIComponent(accessToken)}`), { method: 'DELETE', cache: 'no-store' });
      // 400/401: the token is already invalid — nothing left to revoke.
      if (!res.ok && res.status !== 400 && res.status !== 401) throw new Error(`Meta revoke failed (HTTP ${res.status}).`);
    },
  },

  // --- Productivity --------------------------------------------------------
  slack: {
    id: 'slack',
    auth: 'oauth',
    unlocks:
      'Lets Aura post approval reminders and weekly summaries into a channel your team already watches.',
    oauth: {
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: ['chat:write', 'channels:read'],
      clientIdEnv: 'SLACK_CLIENT_ID',
      clientSecretEnv: 'SLACK_CLIENT_SECRET',
    },
    async verify({ accessToken }) {
      const data = await getJsonOrThrow(
        'https://slack.com/api/auth.test',
        { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
        'Slack',
      );
      if (!data.ok) {
        throw new Error(`Slack rejected the token: ${String(data.error)}`);
      }
      return { accountLabel: String(data.team ?? 'Slack workspace') };
    },
  },

  // --- API-key connectors --------------------------------------------------
  crunchbase: {
    id: 'crunchbase',
    auth: 'api_key',
    unlocks:
      'Turns on funding-stage and investor criteria in Lead Discovery and enriches outreach signals with funding news.',
    apiKey: {
      label: 'Crunchbase user key',
      helpUrl: 'https://data.crunchbase.com/docs/using-the-api',
      fallbackEnv: 'CRUNCHBASE_API_KEY',
    },
    async verify({ apiKey }) {
      const data = await getJsonOrThrow(
        'https://api.crunchbase.com/api/v4/searches/organizations',
        {
          method: 'POST',
          headers: {
            'X-cb-user-key': String(apiKey),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            field_ids: ['name'],
            query: [
              {
                type: 'predicate',
                field_id: 'name',
                operator_id: 'contains',
                values: ['a'],
              },
            ],
            limit: 1,
          }),
        },
        'Crunchbase',
      );
      const count = Number(data.count ?? 0);
      return {
        accountLabel: `Crunchbase API${count ? ` · ${count.toLocaleString()} orgs searchable` : ''}`,
      };
    },
  },

  'google-cse': {
    id: 'google-cse',
    auth: 'api_key',
    unlocks:
      'Turns on open-web people search in Lead Discovery (role-title lookups via the official Custom Search API — never scraping).',
    apiKey: {
      label: 'Google API key',
      helpUrl: 'https://developers.google.com/custom-search/v1/overview',
      secondaryLabel: 'Search engine ID (cx)',
      secondaryMetadataKey: 'cx',
      fallbackEnv: 'GOOGLE_CSE_API_KEY',
      fallbackSecondaryEnv: 'GOOGLE_CSE_CX',
    },
    async verify({ apiKey, metadata }) {
      const cx = String(metadata?.cx ?? '');
      if (!cx) throw new Error('A search engine ID (cx) is required.');
      await getJsonOrThrow(
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(
          String(apiKey),
        )}&cx=${encodeURIComponent(cx)}&num=1&q=test`,
        {},
        'Google Custom Search',
      );
      return { accountLabel: `Custom Search · ${cx}` };
    },
  },

  github: {
    id: 'github',
    auth: 'api_key',
    unlocks:
      'Raises GitHub API rate limits for competitor tracking and lead discovery (both work without it, just slower).',
    apiKey: {
      label: 'GitHub personal access token',
      helpUrl:
        'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      fallbackEnv: 'GITHUB_TOKEN',
    },
    async verify({ apiKey }) {
      const data = await getJsonOrThrow(
        'https://api.github.com/user',
        {
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'BotellaAuraBot/0.1',
          },
        },
        'GitHub',
      );
      return { accountLabel: `github.com/${String(data.login ?? 'user')}` };
    },
  },
};

export interface ProviderReadiness {
  implemented: boolean;
  auth?: ProviderAuth;
  /**
   * Can a user connect this right now? OAuth needs deployment credentials;
   * API-key connectors only need the user's own key.
   */
  connectable: boolean;
  /** What is missing when `connectable` is false. */
  blockedReason?: string;
  unlocks?: string;
}

export function getProvider(id: string): ConnectorProvider | undefined {
  return PROVIDERS[id];
}

/**
 * Whether a connector can be connected on THIS deployment, and if not, exactly
 * what's missing. This is what replaces the blanket "Coming soon" label.
 */
export function providerReadiness(id: string): ProviderReadiness {
  const provider = PROVIDERS[id];
  if (!provider) return { implemented: false, connectable: false };

  if (provider.auth === 'api_key') {
    return {
      implemented: true,
      auth: 'api_key',
      connectable: true,
      unlocks: provider.unlocks,
    };
  }

  const cfg = provider.oauth!;
  const hasId = Boolean(process.env[cfg.clientIdEnv]);
  const hasSecret = Boolean(process.env[cfg.clientSecretEnv]);
  if (hasId && hasSecret) {
    return {
      implemented: true,
      auth: 'oauth',
      connectable: true,
      unlocks: provider.unlocks,
    };
  }
  return {
    implemented: true,
    auth: 'oauth',
    connectable: false,
    unlocks: provider.unlocks,
    blockedReason: `Awaiting app credentials: set ${cfg.clientIdEnv} and ${cfg.clientSecretEnv} on the deployment (one-time registration with the provider).`,
  };
}

/** Every distinct callback URL a deployment must register, by provider group. */
export function oauthRedirectPaths(): { label: string; path: string; connectors: string[] }[] {
  const byPath = new Map<string, { clientIdEnv: string; connectors: string[] }>();
  for (const provider of Object.values(PROVIDERS)) {
    if (!provider.oauth) continue;
    const path =
      provider.oauth.redirectPath ?? `/api/connectors/${provider.id}/callback`;
    const entry = byPath.get(path) ?? {
      clientIdEnv: provider.oauth.clientIdEnv,
      connectors: [],
    };
    entry.connectors.push(provider.id);
    byPath.set(path, entry);
  }
  return [...byPath.entries()].map(([path, entry]) => ({
    label: entry.clientIdEnv.replace(/_CLIENT_ID$/, '').replace(/_/g, ' '),
    path,
    connectors: entry.connectors,
  }));
}
