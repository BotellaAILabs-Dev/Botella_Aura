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
export type ProviderAuth = 'oauth' | 'api_key';

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra params appended to the authorize URL (e.g. Google's offline access). */
  authorizeParams?: Record<string, string>;
  /** Env var holding the OAuth client id. */
  clientIdEnv: string;
  /** Env var holding the OAuth client secret. */
  clientSecretEnv: string;
  /** Send credentials as HTTP Basic instead of form fields (Mailchimp, X). */
  basicAuth?: boolean;
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
   */
  verify: (creds: ProviderCredentials) => Promise<{ accountLabel: string }>;
}

export interface ProviderCredentials {
  accessToken?: string;
  apiKey?: string;
  metadata?: Record<string, unknown>;
}

const GOOGLE_OAUTH: Omit<OAuthConfig, 'scopes'> = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  clientIdEnv: 'GOOGLE_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
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
