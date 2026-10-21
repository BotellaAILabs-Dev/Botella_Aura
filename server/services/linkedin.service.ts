import type { LinkedInConnection } from '@prisma/client';
import { pkceEnabled } from '@/lib/pkce';
import { db } from '@/lib/db';
import { syncLinkedInMirror } from '@/server/connections/manager.service';
import { decrypt, encrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { httpRequest } from '@/lib/http';
import { recordAudit } from '@/server/services/audit.service';

/**
 * LinkedIn integration — OFFICIAL OAuth 2.0 / OpenID Connect only.
 *
 * >>> SCOPE REALITY (Sprint 2) <<<
 * We integrate against "Sign In with LinkedIn using OpenID Connect" (scopes
 * `openid profile email`), the self-serve product. That grants the connected
 * user's basic profile (id/name/photo/email) — which is what we use to
 * personalize content. It does NOT grant the public feed, other users' posts,
 * or posting. Company-page reads and publishing require the Community
 * Management API / Marketing Developer Platform, which is a separate approval —
 * those features are clearly STUBBED and flagged as "pending approval", never
 * faked. No scraping, no unofficial endpoints, no browser automation. Ever.
 */
const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const REVOKE_URL = 'https://www.linkedin.com/oauth/v2/revoke';

/**
 * Requested scopes. `openid profile email` (self-serve "Sign In with LinkedIn")
 * gives basic profile. `w_member_social` (self-serve "Share on LinkedIn" product)
 * grants posting to the connected member's OWN personal profile via the official
 * API — that's what enables one-click publishing of APPROVED posts. It's only
 * granted if the LinkedIn app has the "Share on LinkedIn" product added; if not,
 * LinkedIn simply omits it from the granted scope and we fall back to the manual
 * / extension flow. Still human-approved per post — nothing auto-posts.
 */
const SCOPES = 'openid profile email w_member_social';

export function isLinkedInConfigured(): boolean {
  return Boolean(
    process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET,
  );
}

export function getRedirectUri(): string {
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  return `${base}/api/linkedin/callback`;
}

/**
 * PKCE is sent to LinkedIn only when LINKEDIN_OAUTH_PKCE is on: LinkedIn
 * enables PKCE per app on request (its docs describe it for native apps), so
 * sending it to an app without it would break the connection.
 */
export const linkedInPkce = () => pkceEnabled('LINKEDIN_OAUTH_PKCE');

/** Build the LinkedIn consent URL. `state` carries CSRF protection (see routes). */
export function buildAuthorizeUrl(state: string, codeChallenge?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    redirect_uri: getRedirectUri(),
    state,
    scope: SCOPES,
    ...(codeChallenge && linkedInPkce() ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

async function exchangeCodeForTokens(code: string, verifier?: string): Promise<TokenResponse> {
  const res = await httpRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri(),
      client_id: process.env.LINKEDIN_CLIENT_ID!,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
      ...(verifier && linkedInPkce() ? { code_verifier: verifier } : {}),
    }).toString(),
    timeoutMs: 10_000,
  });
  if (!res.ok) {
    throw new Error(`LinkedIn token exchange failed (${res.status})`);
  }
  return (await res.json()) as TokenResponse;
}

interface UserInfo {
  sub: string;
  name?: string;
  picture?: string;
  email?: string;
}

async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const res = await httpRequest(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error(`LinkedIn userinfo failed (${res.status})`);
  return (await res.json()) as UserInfo;
}

interface ConnectArgs {
  companyId: string;
  userId: string;
  code: string;
  /** PKCE verifier from the browser that started (sent when LINKEDIN_OAUTH_PKCE is on). */
  verifier?: string;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

/**
 * Complete the OAuth code exchange, fetch the profile, and persist an encrypted
 * connection for the company. Tokens are AES-256-GCM encrypted at rest — a DB
 * leak never exposes a usable LinkedIn token.
 */
export async function connectCompany({
  companyId,
  userId,
  code,
  verifier,
  requestMeta,
}: ConnectArgs): Promise<LinkedInConnection> {
  const tokens = await exchangeCodeForTokens(code, verifier);
  const profile = await fetchUserInfo(tokens.access_token);

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const data = {
    linkedInUserId: profile.sub,
    displayName: profile.name ?? null,
    avatarUrl: profile.picture ?? null,
    accessTokenEnc: encrypt(tokens.access_token),
    refreshTokenEnc: tokens.refresh_token
      ? encrypt(tokens.refresh_token)
      : null,
    scope: tokens.scope ?? SCOPES,
    expiresAt,
    status: 'ACTIVE' as const,
    errorMessage: null,
    connectedAt: new Date(),
  };

  const connection = await db.linkedInConnection.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
  await syncLinkedInMirror(companyId, { userId, fresh: true });

  await recordAudit({
    action: 'LINKEDIN_CONNECTED',
    userId,
    companyId,
    metadata: { linkedInUserId: profile.sub, scope: data.scope },
    ...requestMeta,
  });

  return connection;
}

interface DisconnectArgs {
  companyId: string;
  userId: string;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

/**
 * Revoke the token with LinkedIn (best-effort) and delete stored credentials.
 * We remove the row entirely so no ciphertext lingers after disconnect.
 */
export async function disconnectCompany({
  companyId,
  userId,
  requestMeta,
}: DisconnectArgs): Promise<void> {
  const connection = await db.linkedInConnection.findUnique({
    where: { companyId },
  });
  if (!connection) return;

  // Best-effort token revoke — never let a revoke failure block local cleanup.
  if (connection.accessTokenEnc && isLinkedInConfigured()) {
    try {
      const token = decrypt(connection.accessTokenEnc);
      await httpRequest(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.LINKEDIN_CLIENT_ID!,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
          token,
        }).toString(),
        timeoutMs: 6000,
        retries: 0,
      });
    } catch (err) {
      logger.warn('LinkedIn: token revoke failed (continuing with cleanup)', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await db.linkedInConnection.delete({ where: { companyId } });
  await syncLinkedInMirror(companyId);

  await recordAudit({
    action: 'LINKEDIN_DISCONNECTED',
    userId,
    companyId,
    metadata: {},
    ...requestMeta,
  });
}

/** Safe, non-secret view of a company's connection for the Connections UI. */
export interface LinkedInStatus {
  connected: boolean;
  configured: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  status: string | null;
  scope: string | null;
  connectedAt: Date | null;
  expiresAt: Date | null;
  needsReconnect: boolean;
}

/**
 * Decrypted access token for an ACTIVE, non-expired connection, or null.
 * Used by the publishing service. Never returns tokens for expired/revoked
 * connections (caller must prompt reconnect).
 */
export async function getPublishContext(companyId: string): Promise<{
  token: string;
  scope: string | null;
  linkedInUserId: string | null;
} | null> {
  const conn = await db.linkedInConnection.findUnique({ where: { companyId } });
  if (!conn?.accessTokenEnc || conn.status !== 'ACTIVE') return null;
  if (conn.expiresAt && conn.expiresAt < new Date()) return null;
  return {
    token: decrypt(conn.accessTokenEnc),
    scope: conn.scope,
    linkedInUserId: conn.linkedInUserId,
  };
}

export async function getLinkedInStatus(
  companyId: string,
): Promise<LinkedInStatus> {
  const connection = await db.linkedInConnection.findUnique({
    where: { companyId },
  });
  const configured = isLinkedInConfigured();
  if (!connection) {
    return {
      connected: false,
      configured,
      displayName: null,
      avatarUrl: null,
      status: null,
      scope: null,
      connectedAt: null,
      expiresAt: null,
      needsReconnect: false,
    };
  }
  const expired =
    connection.expiresAt !== null && connection.expiresAt < new Date();
  return {
    connected: connection.status === 'ACTIVE' && !expired,
    configured,
    displayName: connection.displayName,
    avatarUrl: connection.avatarUrl,
    status: connection.status,
    scope: connection.scope,
    connectedAt: connection.connectedAt,
    expiresAt: connection.expiresAt,
    needsReconnect:
      expired ||
      connection.status === 'EXPIRED' ||
      connection.status === 'ERROR',
  };
}

/**
 * Live token check for the Connection Manager's health check: does LinkedIn
 * still accept the stored token? Never throws.
 */
export async function checkLinkedInToken(companyId: string): Promise<'ok' | 'rejected' | 'unreachable' | 'none'> {
  const conn = await db.linkedInConnection.findUnique({ where: { companyId } });
  if (!conn?.accessTokenEnc) return 'none';
  let token: string;
  try {
    token = decrypt(conn.accessTokenEnc);
  } catch {
    return 'rejected';
  }
  try {
    const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.ok) return 'ok';
    return res.status === 401 || res.status === 403 ? 'rejected' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * LinkedIn refused the stored token (a 401 while publishing or checking):
 * mark it so Aura asks for a reconnect instead of failing again.
 */
export async function markLinkedInCredentialInvalid(companyId: string, reason: string): Promise<void> {
  const conn = await db.linkedInConnection.findUnique({ where: { companyId }, select: { expiresAt: true } });
  if (!conn) return;
  const expired = Boolean(conn.expiresAt && conn.expiresAt < new Date());
  await db.linkedInConnection.update({
    where: { companyId },
    data: { status: expired ? 'EXPIRED' : 'ERROR', errorMessage: reason.slice(0, 300) },
  });
  await syncLinkedInMirror(companyId);
}
