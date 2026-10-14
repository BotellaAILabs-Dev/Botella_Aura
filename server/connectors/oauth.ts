import crypto from 'node:crypto';

import { absoluteUrl } from '@/lib/app-url';
import { challengeFor, createVerifier, openBinding, pkceEnabled, sealBinding } from '@/lib/pkce';
import { getProvider, type OAuthConfig } from '@/server/connectors/providers';

/**
 * Generic OAuth 2.0 authorization-code helper shared by every OAuth connector.
 *
 * State is a signed, self-describing token rather than a database row: it
 * carries the company id, connector id and a nonce, HMAC'd with NEXTAUTH_SECRET
 * and time-limited. That makes the callback stateless and immune to CSRF
 * without another table to keep clean.
 *
 * The flow is also bound to the browser that started it (lib/pkce.ts): an
 * encrypted cookie carries the state's nonce and a PKCE code verifier, and
 * the callback refuses a code without it. Providers that accept PKCE are also
 * sent the S256 challenge and, at the token exchange, the verifier.
 */
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY;
  if (!s) {
    throw new Error(
      'NEXTAUTH_SECRET is required to sign connector OAuth state.',
    );
  }
  return s;
}

export interface OAuthState {
  companyId: string;
  connectorId: string;
  userId: string;
  issuedAt: number;
  nonce: string;
}

export function encodeState(
  input: Omit<OAuthState, 'issuedAt' | 'nonce'>,
  nonce: string = crypto.randomBytes(12).toString('base64url'),
): string {
  const payload: OAuthState = {
    ...input,
    issuedAt: Date.now(),
    nonce,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export class InvalidOAuthStateError extends Error {
  readonly status = 400;
  constructor(message = 'This connection link is invalid or has expired. Start again from Connectors.') {
    super(message);
    this.name = 'InvalidOAuthStateError';
  }
}

export function decodeState(raw: string): OAuthState {
  const [body, sig] = raw.split('.');
  if (!body || !sig) throw new InvalidOAuthStateError();

  const expected = crypto
    .createHmac('sha256', secret())
    .update(body)
    .digest('base64url');
  // Constant-time compare — a length mismatch alone means it's forged.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new InvalidOAuthStateError();
  }

  let parsed: OAuthState;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidOAuthStateError();
  }
  if (Date.now() - parsed.issuedAt > STATE_TTL_MS) {
    throw new InvalidOAuthStateError(
      'This connection link expired. Start again from Connectors.',
    );
  }
  return parsed;
}

/**
 * The redirect URI this connector uses.
 *
 * Defaults to a per-connector path, but a provider may share one across
 * several connectors (see `redirectPath` in providers.ts) so a deployment
 * registers a single URI rather than one per connector. The value returned
 * here MUST match what is registered with the provider exactly — including
 * scheme, host and trailing path — or the provider rejects the handshake
 * before the user ever reaches us.
 */
export function redirectUri(connectorId: string): string {
  const cfg = getProvider(connectorId)?.oauth;
  return absoluteUrl(cfg?.redirectPath ?? `/api/connectors/${connectorId}/callback`);
}

/** The cookie that binds an OAuth flow to its browser (one per connector). */
export const bindingCookieName = (connectorId: string) => `aura_oauth_${connectorId.replace(/[^a-z0-9_-]/gi, '')}`;

export interface AuthorizeStart {
  url: string;
  /** Set on the response that sends the browser to the provider. */
  cookie: { name: string; value: string };
}

/**
 * The provider's consent URL, and the cookie to set with it. The callback
 * (`verifyBinding`) refuses a code from a browser without that cookie.
 */
export function buildAuthorizeUrl(args: {
  connectorId: string;
  companyId: string;
  userId: string;
}): AuthorizeStart {
  const provider = getProvider(args.connectorId);
  if (!provider?.oauth) {
    throw new Error(`No OAuth configuration for connector "${args.connectorId}".`);
  }
  const cfg = provider.oauth;
  const clientId = process.env[cfg.clientIdEnv];
  if (!clientId) {
    throw new Error(
      `${cfg.clientIdEnv} is not set on this deployment, so ${args.connectorId} cannot be connected yet.`,
    );
  }

  const nonce = crypto.randomBytes(12).toString('base64url');
  const verifier = createVerifier();
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(args.connectorId));
  url.searchParams.set('response_type', 'code');
  if (cfg.scopes.length > 0) {
    url.searchParams.set('scope', cfg.scopes.join(' '));
  }
  url.searchParams.set(
    'state',
    encodeState(
      {
        companyId: args.companyId,
        connectorId: args.connectorId,
        userId: args.userId,
      },
      nonce,
    ),
  );
  for (const [k, v] of Object.entries(cfg.authorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  if (pkceEnabled(cfg.pkceEnv)) {
    url.searchParams.set('code_challenge', challengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return {
    url: url.toString(),
    cookie: { name: bindingCookieName(args.connectorId), value: sealBinding(nonce, verifier) },
  };
}

/**
 * The callback's check that this browser started the flow. Returns the PKCE
 * verifier; throws when the cookie is missing or made for another flow.
 */
export function verifyBinding(state: OAuthState, cookieValue: string | null | undefined): string {
  const verifier = openBinding(cookieValue, state.nonce);
  if (!verifier) {
    throw new InvalidOAuthStateError(
      'Finish the connection in the same browser that started it (or start again from Connectors).',
    );
  }
  return verifier;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
}

async function requestToken(
  cfg: OAuthConfig,
  connectorId: string,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const clientId = process.env[cfg.clientIdEnv]!;
  const clientSecret = process.env[cfg.clientSecretEnv]!;

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const params = new URLSearchParams(body);
  if (cfg.basicAuth) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${connectorId} token exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Slack and a few others can answer form-encoded.
    data = Object.fromEntries(new URLSearchParams(text));
  }

  // Slack nests the bot token; every other provider uses the flat field.
  const nested = data.authed_user as { access_token?: string } | undefined;
  const accessToken = String(
    data.access_token ?? nested?.access_token ?? '',
  );
  if (!accessToken) {
    throw new Error(
      `${connectorId} did not return an access token: ${text.slice(0, 200)}`,
    );
  }

  const expiresIn = Number(data.expires_in ?? 0);
  return {
    accessToken,
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : undefined,
    scope: data.scope ? String(data.scope) : undefined,
  };
}

export async function exchangeCode(
  connectorId: string,
  code: string,
  /** The PKCE verifier from the browser binding; sent when the provider uses PKCE. */
  verifier?: string,
): Promise<TokenResponse> {
  const cfg = getProvider(connectorId)?.oauth;
  if (!cfg) throw new Error(`No OAuth configuration for "${connectorId}".`);
  return requestToken(cfg, connectorId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(connectorId),
    ...(verifier && pkceEnabled(cfg.pkceEnv) ? { code_verifier: verifier } : {}),
  });
}

export async function refreshAccessToken(
  connectorId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const cfg = getProvider(connectorId)?.oauth;
  if (!cfg) throw new Error(`No OAuth configuration for "${connectorId}".`);
  const refreshed = await requestToken(cfg, connectorId, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  // Most providers omit the refresh token on refresh — keep the original.
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken };
}
