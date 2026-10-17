import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  connectorChannels,
  discoverAccounts,
  LINKEDIN_CONNECTOR_ID,
  parseScopes,
  toConnectionRecord,
  type ConnectionRecord,
  type SetupStage,
} from '@/lib/connection-manager';
import { capabilityMatrix, capabilitySnapshot, missingRequiredScopes, providerCapabilities, requiredScopes, type CapabilityRow } from '@/lib/capabilities';
import { recordDiscoveredAccounts, selectDiscoveredAccount } from '@/server/connections/accounts';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Connection Manager — one record per integration per workspace
 * (lib/connection-manager.ts describes the model).
 *
 *   listConnectionRecords   every connection, browser-safe (no secrets)
 *   getSetup                the connect → select → confirm view for one
 *   selectAccount           step 4: choose the account/page Aura uses
 *   confirmConnection       step 5: confirm; only then can it execute
 *   syncLinkedInMirror      keep LinkedIn's record in step with its own table
 */

export class ConnectionManagerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ConnectionManagerError';
  }
}

export interface ConnectionEntry extends ConnectionRecord {
  capabilityRows: CapabilityRow[];
  capabilityVersion: string | null;
  /** Core permissions not granted. */
  missingScopes: string[];
}

function entry(row: Parameters<typeof toConnectionRecord>[0]): ConnectionEntry {
  const record = toConnectionRecord(row);
  const granted = record.scopes.length ? record.scopes : null;
  return {
    ...record,
    capabilityRows: capabilityMatrix(record.connectorId, granted, record.channels),
    capabilityVersion: providerCapabilities(record.connectorId)?.version ?? null,
    missingScopes: missingRequiredScopes(record.connectorId, granted, record.channels),
  };
}

const withAccounts = { accounts: { orderBy: [{ kind: 'asc' }, { name: 'asc' }] } } satisfies Prisma.ConnectionInclude;

export async function listConnectionRecords(companyId: string): Promise<ConnectionEntry[]> {
  const rows = await db.connection.findMany({ where: { companyId }, include: withAccounts, orderBy: { createdAt: 'asc' } });
  return rows.map(entry);
}

export async function getConnectionRecord(companyId: string, connectorId: string): Promise<ConnectionEntry | null> {
  const row = await db.connection.findUnique({
    where: { companyId_connectorId: { companyId, connectorId } },
    include: withAccounts,
  });
  return row ? entry(row) : null;
}

export interface SetupStep {
  key: 'connect' | 'authenticate' | 'authorize' | 'select' | 'confirm';
  label: string;
  state: 'done' | 'current' | 'todo';
}

export interface SetupView {
  connection: ConnectionEntry;
  steps: SetupStep[];
  /** Permissions the core capabilities need, and whether each was granted. */
  permissions: { scope: string; granted: boolean }[];
  /** Accounts the person can choose between. */
  choices: ConnectionEntry['accounts'];
  needsChoice: boolean;
  canConfirm: boolean;
  /** Why confirming is not possible yet. */
  blockedReason: string | null;
}

const STEP_LABEL: Record<SetupStep['key'], string> = {
  connect: 'Connect',
  authenticate: 'Authenticate',
  authorize: 'Authorize',
  select: 'Select account/page',
  confirm: 'Confirm connection',
};

export function setupSteps(stage: SetupStage, hasCredential: boolean): SetupStep[] {
  const order: SetupStep['key'][] = ['connect', 'authenticate', 'authorize', 'select', 'confirm'];
  const doneThrough = !hasCredential ? -1 : stage === 'AUTHORIZED' ? 2 : stage === 'ACCOUNT_SELECTED' ? 3 : 4;
  return order.map((key, i) => ({
    key,
    label: STEP_LABEL[key],
    state: i <= doneThrough ? 'done' : i === doneThrough + 1 ? 'current' : 'todo',
  }));
}

export async function getSetup(companyId: string, connectorId: string): Promise<SetupView | null> {
  const connection = await getConnectionRecord(companyId, connectorId);
  if (!connection) return null;
  const granted = new Set(connection.scopes);
  const req = requiredScopes(connectorId, connection.channels);
  const permissions = [
    ...req.all.map((scope) => ({ scope, granted: granted.has(scope) })),
    ...req.anyOf.map((group) => ({ scope: group.join(' or '), granted: group.some((s) => granted.has(s)) })),
  ];
  const choices = connection.accounts.filter((a) => a.selectable);
  const selected = choices.find((a) => a.selected) ?? null;
  const needsChoice = choices.length > 0;
  const blockedReason = !connection.hasCredential
    ? 'Connect the account first.'
    : connection.status === 'REVOKED' || connection.status === 'DISCONNECTED'
      ? 'Access was removed. Connect again.'
      : needsChoice && !selected
        ? 'Choose the account or page Aura should use.'
        : connection.missingScopes.length
          ? `Permissions not granted: ${connection.missingScopes.join(', ')}. Reconnect and allow them.`
          : null;
  return {
    connection,
    steps: setupSteps(connection.setupStage, connection.hasCredential),
    permissions,
    choices,
    needsChoice,
    canConfirm: blockedReason === null,
    blockedReason,
  };
}

/**
 * Step 4. The account must be one this connection reaches. Meta Pages are
 * re-checked live by `liveSelect` (server/connectors/meta.service.ts), so a
 * Page the person lost access to cannot be chosen.
 */
export async function selectAccount(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  accountId: string;
  liveSelect?: (externalId: string) => Promise<void>;
}): Promise<SetupView> {
  const row = await db.connection.findUnique({
    where: { companyId_connectorId: { companyId: args.companyId, connectorId: args.connectorId } },
    include: { accounts: true },
  });
  if (!row) throw new ConnectionManagerError('That connection doesn’t exist.', 404);
  const account = row.accounts.find((a) => a.id === args.accountId);
  if (!account || !account.selectable) {
    throw new ConnectionManagerError('That account isn’t one this connection can use.', 404);
  }
  if (args.liveSelect) await args.liveSelect(account.externalId);
  await selectDiscoveredAccount(row.id, account.id);
  if (row.setupStage === 'AUTHORIZED') {
    await db.connection.update({ where: { id: row.id }, data: { setupStage: 'ACCOUNT_SELECTED' } });
  }
  await recordAudit({
    action: 'CONNECTOR_SYNCED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { connectorId: args.connectorId, selectedAccount: account.externalId, kind: account.kind },
  });
  return (await getSetup(args.companyId, args.connectorId))!;
}

/** Step 5. Confirmed connections are the only ones execution may use. */
export async function confirmConnection(args: { companyId: string; userId: string; connectorId: string }): Promise<SetupView> {
  const setup = await getSetup(args.companyId, args.connectorId);
  if (!setup) throw new ConnectionManagerError('That connection doesn’t exist.', 404);
  if (!setup.canConfirm) throw new ConnectionManagerError(setup.blockedReason ?? 'This connection can’t be confirmed yet.', 409, 'not_ready');
  if (setup.connection.setupStage !== 'CONFIRMED') {
    const now = new Date();
    await db.connection.update({
      where: { id: setup.connection.id },
      data: {
        setupStage: 'CONFIRMED',
        confirmedAt: now,
        // Re-checked by the caller; until then it is set up but unchecked.
        health: 'CONNECTED',
        healthReason: null,
      },
    });
    await recordAudit({
      action: 'CONNECTION_CONFIRMED',
      userId: args.userId,
      companyId: args.companyId,
      metadata: {
        connectorId: args.connectorId,
        accounts: setup.connection.accounts.filter((a) => a.selected).map((a) => ({ kind: a.kind, id: a.externalId })),
      },
    });
  }
  return (await getSetup(args.companyId, args.connectorId))!;
}

/**
 * LinkedIn keeps its tokens in `LinkedInConnection`; its Connection Manager
 * record mirrors it (no secret copied: credentialRef points there). Called
 * after every LinkedIn connect, status change and disconnect. Never throws —
 * a mirror that lags is corrected by the next sync or health check.
 */
export async function syncLinkedInMirror(companyId: string, opts: { userId?: string | null } = {}): Promise<void> {
  try {
    const li = await db.linkedInConnection.findUnique({ where: { companyId } });
    if (!li) {
      await db.connection.deleteMany({ where: { companyId, connectorId: LINKEDIN_CONNECTOR_ID } });
      return;
    }
    const existing = await db.connection.findUnique({
      where: { companyId_connectorId: { companyId, connectorId: LINKEDIN_CONNECTOR_ID } },
      select: { id: true, setupStage: true, providerAccountId: true },
    });
    const status =
      li.status === 'ACTIVE' ? 'CONNECTED' : li.status === 'EXPIRED' ? 'EXPIRED' : li.status === 'ERROR' ? 'ERROR' : li.status === 'REVOKED' ? 'REVOKED' : 'DISCONNECTED';
    const scopes = parseScopes(li.scope);
    const channels = connectorChannels(LINKEDIN_CONNECTOR_ID);
    // The same member reconnecting keeps their confirmation; anyone else confirms afresh.
    const setupStage: SetupStage =
      li.status === 'PENDING'
        ? 'AUTHORIZED'
        : existing?.setupStage === 'CONFIRMED' && existing.providerAccountId === li.linkedInUserId
          ? 'CONFIRMED'
          : 'ACCOUNT_SELECTED';
    const missing = missingRequiredScopes(LINKEDIN_CONNECTOR_ID, scopes, channels);
    const expired = status === 'EXPIRED' || Boolean(li.expiresAt && li.expiresAt < new Date());
    const health =
      status === 'REVOKED' || status === 'DISCONNECTED'
        ? 'DISCONNECTED'
        : expired
          ? 'EXPIRED'
          : status === 'ERROR' || missing.length || setupStage !== 'CONFIRMED'
            ? 'ACTION_REQUIRED'
            : 'CONNECTED';
    const healthReason =
      health === 'DISCONNECTED'
        ? 'Access to LinkedIn was removed. Reconnect to publish again.'
        : health === 'EXPIRED'
          ? 'The LinkedIn connection expired. Reconnect to keep publishing.'
          : status === 'ERROR'
            ? (li.errorMessage ?? 'LinkedIn reported a problem. Reconnect it.')
            : missing.length
              ? `LinkedIn wasn’t granted posting permission (${missing.join(', ')}). Reconnect and allow “Share on LinkedIn”.`
              : setupStage !== 'CONFIRMED'
                ? 'Confirm the LinkedIn connection to finish setup.'
                : null;
    const data = {
      kind: 'OAUTH' as const,
      status,
      accountLabel: li.displayName,
      scope: li.scope,
      expiresAt: li.expiresAt,
      errorMessage: li.errorMessage,
      provider: LINKEDIN_CONNECTOR_ID,
      channels,
      providerAccountId: li.linkedInUserId,
      scopes,
      credentialRef: 'linkedin_connection',
      setupStage,
      ...(setupStage === 'CONFIRMED' ? {} : { confirmedAt: null }),
      health,
      healthReason,
      capabilities: capabilitySnapshot(LINKEDIN_CONNECTOR_ID, scopes, channels) as object,
      ...(status === 'REVOKED' ? { revokedAt: new Date() } : { revokedAt: null }),
    } satisfies Prisma.ConnectionUpdateInput;
    const row = await db.connection.upsert({
      where: { companyId_connectorId: { companyId, connectorId: LINKEDIN_CONNECTOR_ID } },
      create: {
        companyId,
        connectorId: LINKEDIN_CONNECTOR_ID,
        connectedById: opts.userId ?? null,
        createdAt: li.connectedAt ?? li.createdAt,
        ...data,
      },
      update: { ...data, ...(opts.userId ? { connectedById: opts.userId } : {}) },
      select: { id: true },
    });
    await recordDiscoveredAccounts({
      connectionId: row.id,
      companyId,
      accounts: discoverAccounts({
        connectorId: LINKEDIN_CONNECTOR_ID,
        accountLabel: li.displayName,
        providerAccountId: li.linkedInUserId,
        metadata: {},
        orgUrn: scopes.includes('w_organization_social') ? process.env.LINKEDIN_ORG_URN?.trim() || null : null,
      }),
    });
  } catch (err) {
    logger.error('connections: LinkedIn mirror sync failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
