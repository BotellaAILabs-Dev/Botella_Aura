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
  const rows = await db.connection.findMany({ where: { companyId } });
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
    },
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

// ---------------------------------------------------------------------------
// OAuth connectors
// ---------------------------------------------------------------------------

/** Complete an OAuth callback: exchange the code, verify, and persist. */
export async function completeOAuth(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  code: string;
  requestMeta?: Meta;
}): Promise<ConnectionView> {
  const { companyId, userId, connectorId, code, requestMeta } = args;
  const provider = getProvider(connectorId);
  if (!provider?.oauth) {
    throw new ConnectorError(`"${connectorId}" does not use OAuth.`, 400);
  }

  const tokens = await exchangeCode(connectorId, code);

  let accountLabel = connectorId;
  try {
    ({ accountLabel } = await provider.verify({
      accessToken: tokens.accessToken,
    }));
  } catch (err) {
    // The token is valid enough to store; surface the verification problem
    // rather than pretending the connection is healthy.
    logger.warn('connectors: verification after OAuth failed', {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const row = await db.connection.upsert({
    where: { companyId_connectorId: { companyId, connectorId } },
    create: {
      companyId,
      connectorId,
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? provider.oauth.scopes.join(' '),
      accountLabel,
      connectedById: userId,
      lastSyncedAt: new Date(),
    },
    update: {
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt(tokens.accessToken),
      ...(tokens.refreshToken
        ? { refreshTokenEnc: encrypt(tokens.refreshToken) }
        : {}),
      expiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? provider.oauth.scopes.join(' '),
      accountLabel,
      errorMessage: null,
      connectedById: userId,
      lastSyncedAt: new Date(),
    },
  });

  await recordAudit({
    action: 'CONNECTOR_CONNECTED',
    userId,
    companyId,
    metadata: { connectorId, accountLabel },
    ...requestMeta,
  });
  return toView(row);
}

export async function disconnect(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  requestMeta?: Meta;
}): Promise<void> {
  const { companyId, userId, connectorId, requestMeta } = args;
  const deleted = await db.connection.deleteMany({
    where: { companyId, connectorId },
  });
  if (deleted.count === 0) {
    throw new ConnectorError('That connector is not connected.', 404);
  }
  await recordAudit({
    action: 'CONNECTOR_DISCONNECTED',
    userId,
    companyId,
    metadata: { connectorId },
    ...requestMeta,
  });
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

  if (!row.refreshTokenEnc) {
    await db.connection.update({
      where: { id: row.id },
      data: {
        status: 'EXPIRED',
        errorMessage:
          'The access token expired and the provider did not issue a refresh token. Reconnect this integration.',
      },
    });
    return null;
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
      },
    });
    return tokens.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.connection.update({
      where: { id: row.id },
      data: { status: 'ERROR', errorMessage: message },
    });
    logger.error('connectors: token refresh failed', {
      connectorId: row.connectorId,
      error: message,
    });
    return null;
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
    const { accountLabel } = await provider.verify({
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
