import crypto from 'node:crypto';

import { absoluteUrl } from '@/lib/app-url';
import { getProvider, type OAuthConfig } from '@/server/connectors/providers';

/**
 * Generic OAuth 2.0 authorization-code helper shared by every OAuth connector.
 *
 * State is a signed, self-describing token rather than a database row: it
 * carries the company id, connector id and a nonce, HMAC'd with NEXTAUTH_SECRET
 * and time-limited. That makes the callback stateless and immune to CSRF
 * without another table to keep clean.
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
): string {
  const payload: OAuthState = {
    ...input,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(12).toString('base64url'),
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

/** Redirect URI registered with each provider. One per connector. */
export function redirectUri(connectorId: string): string {
  return absoluteUrl(`/api/connectors/${connectorId}/callback`);
}

export function buildAuthorizeUrl(args: {
  connectorId: string;
  companyId: string;
  userId: string;
}): string {
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

  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(args.connectorId));
  url.searchParams.set('response_type', 'code');
  if (cfg.scopes.length > 0) {
    url.searchParams.set('scope', cfg.scopes.join(' '));
  }
  url.searchParams.set(
    'state',
    encodeState({
      companyId: args.companyId,
      connectorId: args.connectorId,
      userId: args.userId,
    }),
  );
  for (const [k, v] of Object.entries(cfg.authorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
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
): Promise<TokenResponse> {
  const cfg = getProvider(connectorId)?.oauth;
  if (!cfg) throw new Error(`No OAuth configuration for "${connectorId}".`);
  return requestToken(cfg, connectorId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(connectorId),
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
