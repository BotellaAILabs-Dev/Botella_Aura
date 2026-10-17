import type { Connection, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { LINKEDIN_CONNECTOR_ID, connectorChannels, discoverAccounts, parseScopes, type ConnectionHealthStatus } from '@/lib/connection-manager';
import { evaluateHealth, healthBlocksExecution, HEALTH_LABEL, type HealthResult } from '@/lib/connection-health';
import { capabilitySnapshot, checkCapability, executorFor, missingRequiredScopes, type Capability } from '@/lib/capabilities';
import { classifyProviderError } from '@/lib/connection-errors';
import { getProvider } from '@/server/connectors/providers';
import { refreshStoredToken, resolveCredential } from '@/server/connectors/connection.service';
import { recordDiscoveredAccounts } from '@/server/connections/accounts';
import { checkLinkedInToken, markLinkedInCredentialInvalid } from '@/server/services/linkedin.service';
import { recordAudit } from '@/server/services/audit.service';
import { notifyUser } from '@/server/whatsapp/notify';

/**
 * Connection health (statuses and rules in lib/connection-health.ts) and the
 * token lifecycle around it.
 *
 *   checkConnectionHealth    live check of one connection, stored on it
 *   refreshWorkspaceHealth   every connection in a workspace
 *   connectionGate           may this platform execute through its connection now?
 *   recordExecutionResult    each execution's outcome feeds health
 *   markCredentialInvalid    a provider refused the token mid-use
 *   markRevoked              the provider says access was withdrawn
 *   runConnectionSweep       cron: refresh expiring tokens, re-check stale health
 */

const LABEL: Record<string, string> = {
  meta: 'Facebook & Instagram',
  linkedin: 'LinkedIn',
  ga4: 'Google Analytics',
  'search-console': 'Search Console',
  hubspot: 'HubSpot',
  mailchimp: 'Mailchimp',
  slack: 'Slack',
  crunchbase: 'Crunchbase',
  'google-cse': 'Google Custom Search',
  github: 'GitHub',
};
export const connectionLabel = (connectorId: string) => LABEL[connectorId] ?? connectorId;

export interface HealthCheckOutcome {
  connectorId: string;
  health: ConnectionHealthStatus;
  previous: ConnectionHealthStatus;
  result: HealthResult;
}

type Live = Pick<HealthResult, never> & {
  providerCheck: 'ok' | 'rejected' | 'unreachable' | null;
  providerMessage: string | null;
  accountAvailable: boolean | null;
  grantedScopes: string[] | null;
};

/** Ask the provider about a stored (non-LinkedIn) connection. */
async function liveCheck(row: Connection): Promise<Live> {
  const none: Live = { providerCheck: null, providerMessage: null, accountAvailable: null, grantedScopes: null };
  const provider = getProvider(row.connectorId);
  if (!provider) return none;
  if (row.status === 'REVOKED' || row.status === 'DISCONNECTED') return none;

  const cred = await resolveCredential(row.companyId, row.connectorId);
  if (!cred || cred.origin !== 'workspace') {
    // resolveCredential refreshes or marks an expired token; the row now says which.
    return { ...none, providerCheck: null };
  }
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  try {
    const verified = await provider.verify({ apiKey: cred.apiKey, accessToken: cred.accessToken, metadata });
    const fresh = verified.metadata ?? {};
    const chosen = typeof metadata.pageId === 'string' ? metadata.pageId : null;
    // Meta picks another Page when the chosen one is gone; never switch silently.
    const accountAvailable = chosen ? fresh.pageId === undefined || fresh.pageId === chosen : true;
    if (accountAvailable && Object.keys(fresh).length) {
      await db.connection.update({
        where: { id: row.id },
        data: { metadata: { ...metadata, ...fresh } as Prisma.InputJsonObject, accountLabel: verified.accountLabel, lastSyncedAt: new Date() },
      });
    }
    await recordDiscoveredAccounts({
      connectionId: row.id,
      companyId: row.companyId,
      accounts: discoverAccounts({
        connectorId: row.connectorId,
        accountLabel: verified.accountLabel,
        providerAccountId: row.providerAccountId,
        metadata: accountAvailable ? { ...metadata, ...fresh } : { ...metadata, pages: fresh.pages ?? metadata.pages },
      }),
      keepSelection: true,
    });
    let grantedScopes: string[] | null = null;
    if (provider.grantedScopes && cred.accessToken) {
      grantedScopes = await provider.grantedScopes(cred.accessToken).catch(() => null);
    }
    return { providerCheck: 'ok', providerMessage: null, accountAvailable, grantedScopes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyProviderError(message);
    if (kind === 'account') return { providerCheck: 'ok', providerMessage: message, accountAvailable: false, grantedScopes: null };
    return { providerCheck: kind, providerMessage: message.slice(0, 200), accountAvailable: null, grantedScopes: null };
  }
}

/** Live check for LinkedIn's mirror (its token lives in LinkedInConnection). */
async function liveCheckLinkedIn(row: Connection): Promise<Live> {
  const r = await checkLinkedInToken(row.companyId);
  return {
    providerCheck: r === 'none' ? null : r,
    providerMessage: r === 'unreachable' ? 'LinkedIn did not answer' : null,
    accountAvailable: r === 'ok' ? true : null,
    grantedScopes: null,
  };
}

function factsFrom(row: Connection, live: Live | null, grantedScopes: string[]) {
  const hasCredential = row.credentialRef !== 'self' ? row.status !== 'REVOKED' && row.status !== 'DISCONNECTED' : Boolean(row.accessTokenEnc || row.apiKeyEnc);
  // Without a live answer, a connection last found healthy stays so.
  const providerCheck = live?.providerCheck ?? (row.health === 'HEALTHY' || row.health === 'WARNING' ? 'ok' : null);
  return {
    status: row.status,
    setupStage: row.setupStage,
    hasCredential,
    expiresAt: row.expiresAt,
    refreshable: Boolean(row.refreshTokenEnc),
    missingScopes: missingRequiredScopes(row.connectorId, grantedScopes.length ? grantedScopes : null, row.channels.length ? row.channels : connectorChannels(row.connectorId)),
    providerCheck,
    providerMessage: live?.providerMessage ?? null,
    accountAvailable: live?.accountAvailable ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastExecutionFailedAt: row.lastExecutionFailedAt,
    lastExecutionError: row.lastExecutionError,
    label: connectionLabel(row.connectorId),
  } as const;
}

async function persist(row: Connection, result: HealthResult, grantedScopes: string[], opts: { checked: boolean; actorUserId?: string | null }): Promise<void> {
  const now = new Date();
  await db.connection.update({
    where: { id: row.id },
    data: {
      health: result.health,
      healthReason: result.reason,
      ...(opts.checked ? { healthCheckedAt: now } : {}),
      ...(result.health === 'HEALTHY' ? { lastHealthyAt: now } : {}),
      ...(grantedScopes.length ? { scopes: grantedScopes } : {}),
      capabilities: capabilitySnapshot(row.connectorId, grantedScopes.length ? grantedScopes : null, row.channels) as object,
    },
  });
  if (result.health === row.health) return;
  await recordAudit({
    action: 'CONNECTION_HEALTH_CHANGED',
    userId: opts.actorUserId ?? undefined,
    companyId: row.companyId,
    metadata: { connectorId: row.connectorId, from: row.health, to: result.health, reason: result.reason },
  });
  // Ask for reauthorization once, when it becomes needed.
  const needsPerson = result.action === 'reconnect' || result.action === 'grant_permissions';
  if (needsPerson && (healthBlocksExecution(result.health) || result.health === 'WARNING')) {
    await recordAudit({
      action: 'CONNECTION_REAUTH_REQUIRED',
      companyId: row.companyId,
      metadata: { connectorId: row.connectorId, health: result.health, reason: result.reason },
    });
    if (row.connectedById) {
      await notifyUser({
        userId: row.connectedById,
        companyId: row.companyId,
        text: `⚠️ ${connectionLabel(row.connectorId)}: ${result.reason ?? HEALTH_LABEL[result.health]} Reconnect in Aura → Connections.`,
      }).catch(() => 0);
    }
  }
}

/** Live health check of one connection. Null when there is no such connection. */
export async function checkConnectionHealth(
  companyId: string,
  connectorId: string,
  opts: { live?: boolean; actorUserId?: string | null } = {},
): Promise<HealthCheckOutcome | null> {
  const live = opts.live ?? true;
  let row = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId } } });
  if (!row) return null;
  let answer: Live | null = null;
  if (live) {
    try {
      answer = connectorId === LINKEDIN_CONNECTOR_ID ? await liveCheckLinkedIn(row) : await liveCheck(row);
    } catch (err) {
      answer = { providerCheck: 'unreachable', providerMessage: err instanceof Error ? err.message.slice(0, 200) : 'check failed', accountAvailable: null, grantedScopes: null };
    }
    // The check may have refreshed or expired the token: judge the row as it is now.
    row = (await db.connection.findUnique({ where: { id: row.id } })) ?? row;
    if (answer.providerCheck === 'rejected' && connectorId === LINKEDIN_CONNECTOR_ID) {
      await markLinkedInCredentialInvalid(companyId, 'LinkedIn no longer accepts Aura’s access. Reconnect it.');
      row = (await db.connection.findUnique({ where: { id: row.id } })) ?? row;
    }
  }
  const granted = answer?.grantedScopes ?? (row.scopes.length ? row.scopes : parseScopes(row.scope));
  const result = evaluateHealth(factsFrom(row, answer, granted));
  // Only a live answer (or reconnecting) clears a blocking state; an offline
  // re-evaluation may make things worse, never better.
  if (!live && healthBlocksExecution(row.health) && !healthBlocksExecution(result.health)) {
    return { connectorId, health: row.health, previous: row.health, result: { ...result, health: row.health, reason: row.healthReason } };
  }
  await persist(row, result, answer?.grantedScopes ?? [], { checked: live, actorUserId: opts.actorUserId });
  return { connectorId, health: result.health, previous: row.health, result };
}

export async function refreshWorkspaceHealth(companyId: string, actorUserId?: string | null): Promise<HealthCheckOutcome[]> {
  const rows = await db.connection.findMany({ where: { companyId }, select: { connectorId: true } });
  const out: HealthCheckOutcome[] = [];
  for (const r of rows) {
    const o = await checkConnectionHealth(companyId, r.connectorId, { live: true, actorUserId });
    if (o) out.push(o);
  }
  return out;
}

export interface GateResult {
  allowed: boolean;
  /** No Connection Manager record — the publisher's own "not connected" path decides. */
  noRecord: boolean;
  connectorId: string | null;
  health: ConnectionHealthStatus | null;
  reason: string | null;
  fix: { label: string; href: string } | null;
}

/**
 * May this platform execute `capability` through its connection right now?
 * Checks the capability registry (supported, permitted) and the stored
 * health. A platform with no connector (X) or no record yet is left to the
 * publisher, which already explains "not connected".
 */
export async function connectionGate(companyId: string, platform: string, capability: Capability = 'organic_publishing'): Promise<GateResult> {
  const exec = executorFor(platform);
  if (!exec) return { allowed: true, noRecord: true, connectorId: null, health: null, reason: null, fix: null };
  const row = await db.connection.findUnique({
    where: { companyId_connectorId: { companyId, connectorId: exec.connectorId } },
    select: { health: true, healthReason: true, scopes: true, scope: true, setupStage: true, status: true },
  });
  if (!row) return { allowed: true, noRecord: true, connectorId: exec.connectorId, health: null, reason: null, fix: null };
  const granted = row.scopes.length ? row.scopes : parseScopes(row.scope);
  const check = checkCapability({
    connectorId: exec.connectorId,
    channel: exec.channel,
    capability,
    grantedScopes: granted.length ? granted : null,
    health: row.health,
    healthReason: row.healthReason,
  });
  return {
    allowed: check.allowed,
    noRecord: false,
    connectorId: exec.connectorId,
    health: row.health,
    reason: check.reason,
    fix: check.allowed ? null : (check.fix ?? { label: 'Open Connections', href: '/dashboard/connections' }),
  };
}

/**
 * One execution's outcome through a connection. Success clears the failure
 * streak; failures count toward WARNING / ACTION_REQUIRED; a refused
 * credential marks the connection for reauthorization at once.
 */
export async function recordExecutionResult(args: {
  companyId: string;
  platform?: string;
  connectorId?: string;
  ok: boolean;
  error?: string | null;
  credentialRejected?: boolean;
}): Promise<void> {
  try {
    const connectorId = args.connectorId ?? (args.platform ? executorFor(args.platform)?.connectorId : null);
    if (!connectorId) return;
    const row = await db.connection.findUnique({ where: { companyId_connectorId: { companyId: args.companyId, connectorId } } });
    if (!row) return;
    const now = new Date();
    if (args.ok) {
      await db.connection.update({
        where: { id: row.id },
        data: { lastExecutionAt: now, consecutiveFailures: 0, lastExecutionError: null },
      });
    } else {
      await db.connection.update({
        where: { id: row.id },
        data: {
          consecutiveFailures: { increment: 1 },
          lastExecutionError: (args.error ?? 'Execution failed.').slice(0, 300),
          lastExecutionFailedAt: now,
        },
      });
      if (args.credentialRejected) {
        await markCredentialInvalid(args.companyId, connectorId, args.error ?? 'The provider refused the stored credential.');
        return;
      }
    }
    await checkConnectionHealth(args.companyId, connectorId, { live: false });
  } catch (err) {
    logger.error('connections: could not record execution result', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** A provider refused the token mid-use (Meta 190, HTTP 401). */
export async function markCredentialInvalid(companyId: string, connectorId: string, reason: string): Promise<void> {
  if (connectorId === LINKEDIN_CONNECTOR_ID) {
    await markLinkedInCredentialInvalid(companyId, reason);
  } else {
    const row = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId } }, select: { expiresAt: true } });
    if (!row) return;
    const expired = Boolean(row.expiresAt && row.expiresAt < new Date());
    await db.connection.update({
      where: { companyId_connectorId: { companyId, connectorId } },
      data: { status: expired ? 'EXPIRED' : 'ERROR', errorMessage: reason.slice(0, 300) },
    });
  }
  const row = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId } } });
  if (!row) return;
  const result = evaluateHealth({ ...factsFrom(row, null, row.scopes), providerCheck: row.status === 'EXPIRED' ? null : 'rejected' });
  await persist(row, result, [], { checked: true });
}

/** The provider says access was withdrawn: tokens cleared, kept visible as revoked. */
export async function markRevoked(connectionIds: string[], reason: string, source: string): Promise<number> {
  let n = 0;
  for (const id of connectionIds) {
    const row = await db.connection.update({
      where: { id },
      data: {
        status: 'REVOKED',
        accessTokenEnc: null,
        refreshTokenEnc: null,
        revokedAt: new Date(),
        errorMessage: reason,
      },
    });
    const result = evaluateHealth(factsFrom(row, null, row.scopes));
    await persist(row, result, [], { checked: true });
    await recordAudit({ action: 'CONNECTION_REVOKED', companyId: row.companyId, metadata: { connectorId: row.connectorId, source } });
    n += 1;
  }
  return n;
}

/** Refresh tokens this close to expiry, ahead of use. */
export const PROACTIVE_REFRESH_MS = 24 * 60 * 60_000;
/** Re-check health this often. */
export const HEALTH_STALE_MS = 6 * 60 * 60_000;

/**
 * The scheduled pass (POST /api/cron/connections):
 *   1. refresh every refreshable token expiring within a day
 *   2. live-check every connection whose health is older than six hours —
 *      which also catches tokens that are expiring and cannot be refreshed
 *      (WARNING, reauthorization requested) or already expired (EXPIRED)
 */
export async function runConnectionSweep(opts: { now?: Date; limit?: number } = {}): Promise<{
  refreshed: number;
  refreshFailed: number;
  checked: number;
  changed: number;
}> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;
  let refreshed = 0;
  let refreshFailed = 0;
  const expiring = await db.connection.findMany({
    where: { status: 'CONNECTED', refreshTokenEnc: { not: null }, expiresAt: { lt: new Date(now.getTime() + PROACTIVE_REFRESH_MS) } },
    take: limit,
  });
  for (const row of expiring) {
    const r = await refreshStoredToken(row);
    if (r.outcome === 'refreshed') refreshed += 1;
    else refreshFailed += 1;
  }
  const stale = await db.connection.findMany({
    where: {
      status: { notIn: ['DISCONNECTED', 'REVOKED'] },
      OR: [{ healthCheckedAt: null }, { healthCheckedAt: { lt: new Date(now.getTime() - HEALTH_STALE_MS) } }],
    },
    orderBy: { healthCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: limit,
    select: { companyId: true, connectorId: true },
  });
  let changed = 0;
  for (const r of stale) {
    const o = await checkConnectionHealth(r.companyId, r.connectorId, { live: true });
    if (o && o.health !== o.previous) changed += 1;
  }
  return { refreshed, refreshFailed, checked: stale.length, changed };
}
