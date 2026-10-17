import type { Connection } from '@prisma/client';

import { db } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  getProvider,
  providerReadiness,
  type ProviderReadiness,
} from '@/server/connectors/providers';
import { exchangeCode, refreshAccessToken } from '@/server/connectors/oauth';
import {
  connectorChannels,
  discoverAccounts,
  hasAccountChoice,
  LINKEDIN_CONNECTOR_ID,
  NOT_MIRRORED,
  parseScopes,
  providerFamily,
  type SetupStage,
} from '@/lib/connection-manager';
import { capabilitySnapshot, missingRequiredScopes, providerCapabilities } from '@/lib/capabilities';
import { recordDiscoveredAccounts } from '@/server/connections/accounts';

/**
 * Company-scoped connector connections.
 *
 * Secrets are encrypted at rest with AES-256-GCM (lib/crypto.ts) and are never
 * returned to the browser — the API only ever exposes status, a display label,
 * and non-secret metadata.
 */
interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export interface ConnectionView {
  connectorId: string;
  status: Connection['status'];
  /** Connection Manager setup stage; only CONFIRMED connections execute. */
  setupStage: SetupStage;
  health: Connection['health'];
  healthReason: string | null;
  /** Core permissions the provider did not grant. */
  missingScopes: string[];
  kind: Connection['kind'];
  accountLabel: string | null;
  metadata: Record<string, unknown>;
  connectedAt: string;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  expiresAt: string | null;
}

function toView(c: Connection): ConnectionView {
  return {
    connectorId: c.connectorId,
    status: c.status,
    setupStage: c.setupStage,
    health: c.health,
    healthReason: c.healthReason,
    missingScopes: missingRequiredScopes(c.connectorId, c.scopes.length ? c.scopes : null, c.channels),
    kind: c.kind,
    accountLabel: c.accountLabel,
    metadata: (c.metadata ?? {}) as Record<string, unknown>,
    connectedAt: c.createdAt.toISOString(),
    lastSyncedAt: c.lastSyncedAt ? c.lastSyncedAt.toISOString() : null,
    errorMessage: c.errorMessage,
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
  };
}

export async function listConnections(
  companyId: string,
): Promise<ConnectionView[]> {
  // LinkedIn's mirror row is reported by the LinkedIn service, not here.
  const rows = await db.connection.findMany({ where: { companyId, ...NOT_MIRRORED } });
  return rows.map(toView);
}

export async function getConnection(
  companyId: string,
  connectorId: string,
): Promise<ConnectionView | null> {
  const row = await db.connection.findUnique({
    where: { companyId_connectorId: { companyId, connectorId } },
  });
  return row ? toView(row) : null;
}

// ---------------------------------------------------------------------------
// API-key connectors
// ---------------------------------------------------------------------------

/**
 * Save (and verify) an API key. We never store a key we could not authenticate
 * with — a silently-broken connector is worse than an unconnected one.
 */
export async function saveApiKey(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  apiKey: string;
  metadata?: Record<string, unknown>;
  requestMeta?: Meta;
}): Promise<ConnectionView> {
  const { companyId, userId, connectorId, apiKey, metadata, requestMeta } = args;
  const provider = getProvider(connectorId);
  if (!provider || provider.auth !== 'api_key') {
    throw new ConnectorError(`"${connectorId}" does not use an API key.`, 400);
  }

  let accountLabel: string;
  try {
    ({ accountLabel } = await provider.verify({ apiKey, metadata }));
  } catch (err) {
    throw new ConnectorError(
      err instanceof Error ? err.message : String(err),
      400,
    );
  }

  const row = await db.connection.upsert({
    where: { companyId_connectorId: { companyId, connectorId } },
    create: {
      companyId,
      connectorId,
      kind: 'API_KEY',
      status: 'CONNECTED',
      apiKeyEnc: encrypt(apiKey),
      accountLabel,
      metadata: (metadata ?? {}) as object,
      connectedById: userId,
      lastSyncedAt: new Date(),
      ...apiKeyManagerFields(connectorId),
    },
    update: {
      kind: 'API_KEY',
      status: 'CONNECTED',
      apiKeyEnc: encrypt(apiKey),
      accountLabel,
      metadata: (metadata ?? {}) as object,
      errorMessage: null,
      connectedById: userId,
      lastSyncedAt: new Date(),
      ...apiKeyManagerFields(connectorId),
    },
  });
  await recordDiscoveredAccounts({
    connectionId: row.id,
    companyId,
    accounts: discoverAccounts({ connectorId, accountLabel, metadata: metadata ?? {} }),
  });

  await recordAudit({
    action: 'CONNECTOR_CREDENTIALS_SAVED',
    userId,
    companyId,
    metadata: { connectorId, accountLabel },
    ...requestMeta,
  });
  return toView(row);
}

/**
 * An API key is entered, checked and confirmed in one step: there is no
 * account to choose, so it is CONFIRMED (and verified, so healthy) at once.
 */
function apiKeyManagerFields(connectorId: string) {
  const now = new Date();
  return {
    provider: providerFamily(connectorId),
    channels: connectorChannels(connectorId),
    credentialRef: 'self',
    setupStage: 'CONFIRMED' as const,
    confirmedAt: now,
    revokedAt: null,
    health: 'HEALTHY' as const,
    healthReason: null,
    healthCheckedAt: now,
    lastHealthyAt: now,
    consecutiveFailures: 0,
    capabilities: capabilitySnapshot(connectorId, null) as object,
  };
}

/**
 * Where a newly authorised connection starts in the setup flow
 * (Connect -> Authenticate -> Authorize -> Select account/page -> Confirm).
 *
 *   - Reconnecting a confirmed connection whose chosen account is still
 *     there stays CONFIRMED: re-authorising is not re-choosing.
 *   - A connector that acts on an account (publishes) needs the person to
 *     confirm it: AUTHORIZED when there is a choice to make, else
 *     ACCOUNT_SELECTED (the only account is pre-selected).
 *   - A connector that only reads data into Aura has nothing to act on and
 *     no choice: CONFIRMED.
 */
export function initialSetupStage(args: {
  connectorId: string;
  previous: { setupStage: SetupStage; selectedStillAvailable: boolean } | null;
  accounts: { selectable?: boolean }[];
}): SetupStage {
  if (args.previous?.setupStage === 'CONFIRMED' && args.previous.selectedStillAvailable) return 'CONFIRMED';
  const caps = providerCapabilities(args.connectorId);
  const executes = Boolean(caps && !caps.core.includes('data_read'));
  if (!executes && !hasAccountChoice(args.accounts)) return 'CONFIRMED';
  return hasAccountChoice(args.accounts) ? 'AUTHORIZED' : 'ACCOUNT_SELECTED';
}

/** Granted scopes: asked of the provider when it can say, else the token's scope. */
async function grantedScopesFor(
  connectorId: string,
  accessToken: string,
  tokenScope: string | undefined,
): Promise<{ scopes: string[]; known: boolean }> {
  const provider = getProvider(connectorId);
  if (provider?.grantedScopes) {
    try {
      return { scopes: await provider.grantedScopes(accessToken), known: true };
    } catch (err) {
      logger.warn('connectors: could not read granted permissions', {
        connectorId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      return { scopes: [], known: false };
    }
  }
  // A token response with a scope says what was granted; without one, the
  // provider granted what was asked (OAuth 2.0 section 5.1).
  return { scopes: parseScopes(tokenScope ?? provider?.oauth?.scopes.join(' ')), known: true };
}

// ---------------------------------------------------------------------------
// OAuth connectors
// ---------------------------------------------------------------------------

/** Complete an OAuth callback: exchange the code, verify, and persist. */
export async function completeOAuth(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  code: string;
  /** PKCE verifier from the browser binding (server/connectors/oauth.ts). */
  verifier?: string;
  requestMeta?: Meta;
}): Promise<ConnectionView> {
  const { companyId, userId, connectorId, code, requestMeta } = args;
  const provider = getProvider(connectorId);
  if (!provider?.oauth) {
    throw new ConnectorError(`"${connectorId}" does not use OAuth.`, 400);
  }

  let tokens = await exchangeCode(connectorId, code, args.verifier);
  // A provider whose first token is short-lived swaps it for a long-lived one
  // (Meta). If that fails the short token still works for now — stored, and
  // the person is told to reconnect, rather than the connection failing.
  let upgradeWarning: string | null = null;
  if (provider.oauth.upgradeToken) {
    try {
      tokens = { ...tokens, ...(await provider.oauth.upgradeToken(tokens)) };
    } catch (err) {
      upgradeWarning = 'Connected, but only for a short time — reconnect if publishing stops working.';
      logger.warn('connectors: token upgrade failed', {
        connectorId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }
  // What the last connection chose (e.g. which Facebook Page), so reconnecting keeps it.
  const previous = await db.connection.findUnique({
    where: { companyId_connectorId: { companyId, connectorId } },
    select: { metadata: true, setupStage: true, status: true },
  });

  let accountLabel = connectorId;
  // Non-secret provider details discovered during verification (e.g. which
  // Instagram account this token may publish to). Stored so downstream features
  // read one connection row instead of re-deriving it per call.
  let verifiedMetadata: Record<string, unknown> = {};
  let verifyError: string | null = null;
  try {
    const verified = await provider.verify({
      accessToken: tokens.accessToken,
      metadata: (previous?.metadata ?? {}) as Record<string, unknown>,
    });
    accountLabel = verified.accountLabel;
    verifiedMetadata = verified.metadata ?? {};
  } catch (err) {
    // The token is valid enough to store; surface the verification problem
    // rather than pretending the connection is healthy.
    verifyError = err instanceof Error ? err.message : String(err);
    logger.warn('connectors: verification after OAuth failed', {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // --- Connection Manager: who authorised, what was granted, what it reaches.
  const granted = await grantedScopesFor(connectorId, tokens.accessToken, tokens.scope);
  const metadataNow = Object.keys(verifiedMetadata).length > 0 ? verifiedMetadata : ((previous?.metadata ?? {}) as Record<string, unknown>);
  const providerAccountId = typeof metadataNow.fbUserId === 'string' ? metadataNow.fbUserId : null;
  const accounts = discoverAccounts({ connectorId, accountLabel, providerAccountId, metadata: metadataNow });
  const previousPageId = (previous?.metadata as { pageId?: unknown } | null)?.pageId;
  const setupStage = initialSetupStage({
    connectorId,
    previous:
      previous && previous.status !== 'REVOKED' && previous.status !== 'DISCONNECTED'
        ? {
            setupStage: previous.setupStage,
            selectedStillAvailable: typeof previousPageId !== 'string' || metadataNow.pageId === previousPageId,
          }
        : null,
    accounts,
  });
  const channels = connectorChannels(connectorId);
  const missing = granted.known ? missingRequiredScopes(connectorId, granted.scopes, channels) : [];
  const now = new Date();
  const managerFields = {
    provider: providerFamily(connectorId),
    channels,
    providerAccountId,
    scopes: granted.scopes,
    credentialRef: 'self',
    setupStage,
    confirmedAt: setupStage === 'CONFIRMED' ? now : null,
    revokedAt: null,
    // Not usable until the person grants what is missing / finishes setup.
    health: (missing.length || setupStage !== 'CONFIRMED' || verifyError ? 'ACTION_REQUIRED' : 'HEALTHY') as Connection['health'],
    healthReason: missing.length
      ? `Permissions not granted: ${missing.join(', ')}. Reconnect and allow them.`
      : verifyError
        ? verifyError.slice(0, 300)
        : setupStage !== 'CONFIRMED'
          ? 'Choose and confirm the account Aura should use.'
          : null,
    healthCheckedAt: now,
    ...(missing.length || verifyError ? {} : { lastHealthyAt: now }),
    consecutiveFailures: 0,
    capabilities: capabilitySnapshot(connectorId, granted.known ? granted.scopes : null, channels) as object,
  };

  const row = await db.connection.upsert({
    where: { companyId_connectorId: { companyId, connectorId } },
    create: {
      ...managerFields,
      companyId,
      connectorId,
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? provider.oauth.scopes.join(' '),
      accountLabel,
      metadata: verifiedMetadata as object,
      errorMessage: upgradeWarning,
      connectedById: userId,
      lastSyncedAt: new Date(),
    },
    update: {
      ...managerFields,
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt(tokens.accessToken),
      ...(tokens.refreshToken
        ? { refreshTokenEnc: encrypt(tokens.refreshToken) }
        : {}),
      expiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? provider.oauth.scopes.join(' '),
      accountLabel,
      // Only overwrite when verification actually produced something, so a
      // reconnect whose verify() call failed does not wipe working metadata.
      ...(Object.keys(verifiedMetadata).length > 0
        ? { metadata: verifiedMetadata as object }
        : {}),
      errorMessage: upgradeWarning,
      connectedById: userId,
      lastSyncedAt: new Date(),
    },
  });

  await recordDiscoveredAccounts({ connectionId: row.id, companyId, accounts, keepSelection: true });

  await recordAudit({
    action: 'CONNECTOR_CONNECTED',
    userId,
    companyId,
    metadata: { connectorId, accountLabel, setupStage, missingScopes: missing },
    ...requestMeta,
  });
  if (setupStage === 'CONFIRMED') {
    await recordAudit({ action: 'CONNECTION_CONFIRMED', userId, companyId, metadata: { connectorId, automatic: true } });
  }
  return toView(row);
}

export async function disconnect(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  requestMeta?: Meta;
}): Promise<void> {
  const { companyId, userId, connectorId, requestMeta } = args;
  if (connectorId === LINKEDIN_CONNECTOR_ID) {
    throw new ConnectorError('Disconnect LinkedIn from Settings -> Connections.', 400);
  }
  const row = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId } } });
  if (!row) throw new ConnectorError('That connector is not connected.', 404);

  // Withdraw access at the provider too (best-effort), so disconnecting
  // removes Aura there, not just Aura's copy of the token.
  const revokedAtProvider = await revokeAtProvider(row);

  await db.connection.deleteMany({ where: { companyId, connectorId } });
  await recordAudit({
    action: 'CONNECTOR_DISCONNECTED',
    userId,
    companyId,
    metadata: { connectorId, revokedAtProvider },
    ...requestMeta,
  });
}

/** Ask the provider to withdraw this token. Never throws. */
export async function revokeAtProvider(row: Connection): Promise<boolean> {
  const provider = getProvider(row.connectorId);
  if (!provider?.revoke || (!row.accessTokenEnc && !row.refreshTokenEnc)) return false;
  try {
    await provider.revoke({
      accessToken: row.accessTokenEnc ? decrypt(row.accessTokenEnc) : undefined,
      refreshToken: row.refreshTokenEnc ? decrypt(row.refreshTokenEnc) : undefined,
    });
    return true;
  } catch (err) {
    logger.warn('connectors: revoke at provider failed (continuing)', {
      connectorId: row.connectorId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Credential access (server-side consumers)
// ---------------------------------------------------------------------------

export interface ResolvedCredential {
  connectorId: string;
  /** 'workspace' = a connection this company made; 'env' = deployment-wide. */
  origin: 'workspace' | 'env';
  apiKey?: string;
  accessToken?: string;
  metadata: Record<string, unknown>;
}

/**
 * Resolve usable credentials for a connector, preferring the workspace's own
 * connection and falling back to a deployment-wide environment variable.
 *
 * This is the single accessor every feature uses (lead discovery, competitor
 * tracking, analytics), so connecting Crunchbase in the UI has exactly the same
 * effect as setting CRUNCHBASE_API_KEY on the deployment — which is what makes
 * the connector genuinely useful rather than decorative.
 */
export async function resolveCredential(
  companyId: string,
  connectorId: string,
): Promise<ResolvedCredential | null> {
  const provider = getProvider(connectorId);
  if (!provider) return null;

  const row = await db.connection.findUnique({
    where: { companyId_connectorId: { companyId, connectorId } },
  });

  if (row && row.status === 'CONNECTED') {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    try {
      if (row.kind === 'API_KEY' && row.apiKeyEnc) {
        return {
          connectorId,
          origin: 'workspace',
          apiKey: decrypt(row.apiKeyEnc),
          metadata,
        };
      }
      if (row.kind === 'OAUTH' && row.accessTokenEnc) {
        const accessToken = await freshAccessToken(row);
        if (accessToken) {
          return { connectorId, origin: 'workspace', accessToken, metadata };
        }
      }
    } catch (err) {
      // A key we can no longer decrypt (rotated ENCRYPTION_KEY) must not take
      // the caller down — fall through to the env fallback.
      logger.error('connectors: could not read stored credential', {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Deployment-wide fallback for API-key connectors.
  const fallbackEnv = provider.apiKey?.fallbackEnv;
  const fallback = fallbackEnv ? process.env[fallbackEnv] : undefined;
  if (fallback) {
    const metadata: Record<string, unknown> = {};
    const secondaryEnv = provider.apiKey?.fallbackSecondaryEnv;
    const key = provider.apiKey?.secondaryMetadataKey;
    if (secondaryEnv && key && process.env[secondaryEnv]) {
      metadata[key] = process.env[secondaryEnv];
    }
    return { connectorId, origin: 'env', apiKey: fallback, metadata };
  }

  return null;
}

/** Refresh an expiring OAuth access token in place; returns a usable token. */
async function freshAccessToken(row: Connection): Promise<string | null> {
  if (!row.accessTokenEnc) return null;
  const stillValid =
    !row.expiresAt || row.expiresAt.getTime() - Date.now() > 60_000;
  if (stillValid) return decrypt(row.accessTokenEnc);
  return (await refreshStoredToken(row)).accessToken;
}

export type RefreshOutcome =
  | { outcome: 'refreshed'; accessToken: string; expiresAt: Date | null }
  | { outcome: 'not_refreshable' | 'revoked' | 'failed'; accessToken: null; message: string };

/**
 * Get a new access token with the stored refresh token, and record the
 * result on the connection:
 *   refreshed        new token stored (status CONNECTED)
 *   not_refreshable  no refresh token (Meta, LinkedIn self-serve): EXPIRED,
 *                    the person has to reconnect
 *   revoked          the provider says the grant is gone (invalid_grant):
 *                    REVOKED, tokens cleared
 *   failed           anything else (provider down...): ERROR, retried later
 */
export async function refreshStoredToken(row: Connection): Promise<RefreshOutcome> {
  if (!row.refreshTokenEnc) {
    const message =
      'The access token expired and the provider did not issue a refresh token. Reconnect this integration.';
    await db.connection.update({
      where: { id: row.id },
      data: {
        status: 'EXPIRED',
        errorMessage: message,
        health: 'EXPIRED',
        healthReason: message,
        healthCheckedAt: new Date(),
      },
    });
    return { outcome: 'not_refreshable', accessToken: null, message };
  }

  try {
    const tokens = await refreshAccessToken(
      row.connectorId,
      decrypt(row.refreshTokenEnc),
    );
    await db.connection.update({
      where: { id: row.id },
      data: {
        accessTokenEnc: encrypt(tokens.accessToken),
        ...(tokens.refreshToken
          ? { refreshTokenEnc: encrypt(tokens.refreshToken) }
          : {}),
        expiresAt: tokens.expiresAt ?? null,
        status: 'CONNECTED',
        errorMessage: null,
        ...(tokens.scope ? { scope: tokens.scope, scopes: parseScopes(tokens.scope) } : {}),
      },
    });
    await recordAudit({
      action: 'CONNECTION_TOKEN_REFRESHED',
      companyId: row.companyId,
      metadata: { connectorId: row.connectorId, expiresAt: tokens.expiresAt?.toISOString() ?? null },
    });
    return { outcome: 'refreshed', accessToken: tokens.accessToken, expiresAt: tokens.expiresAt ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // invalid_grant: the refresh token was revoked or expired. The grant is
    // gone at the provider, so the tokens are useless and are cleared.
    if (/invalid_grant/i.test(message)) {
      const reason = 'Access was withdrawn at the provider. Reconnect this integration.';
      await db.connection.update({
        where: { id: row.id },
        data: {
          status: 'REVOKED',
          accessTokenEnc: null,
          refreshTokenEnc: null,
          revokedAt: new Date(),
          errorMessage: reason,
          health: 'DISCONNECTED',
          healthReason: reason,
          healthCheckedAt: new Date(),
        },
      });
      await recordAudit({
        action: 'CONNECTION_REVOKED',
        companyId: row.companyId,
        metadata: { connectorId: row.connectorId, reason: 'invalid_grant' },
      });
      return { outcome: 'revoked', accessToken: null, message: reason };
    }
    await db.connection.update({
      where: { id: row.id },
      data: { status: 'ERROR', errorMessage: message },
    });
    logger.error('connectors: token refresh failed', {
      connectorId: row.connectorId,
      error: message,
    });
    return { outcome: 'failed', accessToken: null, message };
  }
}

/**
 * Re-verify a stored connection against the provider and record the outcome.
 * Powers the "Test connection" button.
 */
export async function testConnection(args: {
  companyId: string;
  userId: string;
  connectorId: string;
}): Promise<{ ok: boolean; accountLabel?: string; error?: string }> {
  const { companyId, userId, connectorId } = args;
  const provider = getProvider(connectorId);
  if (!provider) throw new ConnectorError('Unknown connector.', 404);

  const cred = await resolveCredential(companyId, connectorId);
  if (!cred) {
    return { ok: false, error: 'This connector is not connected yet.' };
  }

  try {
    const { accountLabel, metadata } = await provider.verify({
      apiKey: cred.apiKey,
      accessToken: cred.accessToken,
      metadata: cred.metadata,
    });
    if (cred.origin === 'workspace') {
      await db.connection.update({
        where: { companyId_connectorId: { companyId, connectorId } },
        data: {
          status: 'CONNECTED',
          accountLabel,
          // "Test connection" doubles as a repair: re-running discovery here is
          // how a connection whose metadata is stale or missing gets fixed
          // without disconnecting and starting the OAuth flow again.
          ...(metadata && Object.keys(metadata).length > 0
            ? { metadata: { ...cred.metadata, ...metadata } as object }
            : {}),
          errorMessage: null,
          lastSyncedAt: new Date(),
        },
      });
    }
    await recordAudit({
      action: 'CONNECTOR_SYNCED',
      userId,
      companyId,
      metadata: { connectorId, ok: true },
    });
    return { ok: true, accountLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cred.origin === 'workspace') {
      await db.connection
        .update({
          where: { companyId_connectorId: { companyId, connectorId } },
          data: { status: 'ERROR', errorMessage: message },
        })
        .catch(() => undefined);
    }
    await recordAudit({
      action: 'CONNECTOR_SYNCED',
      userId,
      companyId,
      metadata: { connectorId, ok: false, error: message },
    });
    return { ok: false, error: message };
  }
}

export function readiness(connectorId: string): ProviderReadiness {
  return providerReadiness(connectorId);
}
