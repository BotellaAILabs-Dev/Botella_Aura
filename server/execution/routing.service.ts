import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { Capability } from '@/lib/capabilities';
import { executorFor } from '@/lib/capabilities';
import { discoverAccounts, parseScopes, type ConnectionHealthStatus } from '@/lib/connection-manager';
import { decideRoute, type RouteDecision, type RouteFacts } from '@/lib/execution-routing';
import { recordDiscoveredAccounts } from '@/server/connections/accounts';
import { syncLinkedInMirror } from '@/server/connections/manager.service';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Provider routing on the server: gathers the connection, its accounts and
 * the content type, and lets lib/execution-routing.ts decide. A refusal is
 * logged and audited (EXECUTION_ROUTING_FAILED) when `record` is set — the
 * execution engine sets it; previews don't, so they don't flood the log.
 */
export async function routeExecution(args: {
  companyId: string;
  platform: string;
  contentType: string;
  capability?: Capability;
  record?: { draftId: string; executionId?: string | null; userId?: string | null };
}): Promise<RouteDecision> {
  const facts = await gatherRouteFacts(args.companyId, args.platform, args.contentType);
  const decision = decideRoute(facts, args.capability);
  if (!decision.ok && args.record) {
    logger.warn('execution routing refused', {
      companyId: args.companyId,
      draftId: args.record.draftId,
      platform: args.platform,
      code: decision.code,
      reason: decision.message,
    });
    await recordAudit({
      action: 'EXECUTION_ROUTING_FAILED',
      userId: args.record.userId ?? null,
      companyId: args.companyId,
      metadata: {
        draftId: args.record.draftId,
        executionId: args.record.executionId ?? null,
        platform: args.platform,
        code: decision.code,
        reason: decision.message,
        checks: decision.checks.map((c) => `${c.key}:${c.ok ? 'ok' : 'failed'}`),
      },
    });
  }
  return decision;
}

async function gatherRouteFacts(companyId: string, platform: string, contentType: string): Promise<RouteFacts> {
  const exec = executorFor(platform);
  if (!exec) return { platform, contentType, connection: null, accounts: [] };

  const where = { companyId_connectorId: { companyId, connectorId: exec.connectorId } };
  let row = await db.connection.findUnique({ where, include: { accounts: true } });

  // LinkedIn connected before the Connection Manager existed: build its record.
  if (!row && exec.connectorId === 'linkedin' && (await db.linkedInConnection.findUnique({ where: { companyId }, select: { id: true } }))) {
    await syncLinkedInMirror(companyId);
    row = await db.connection.findUnique({ where, include: { accounts: true } });
  }
  if (!row) return { platform, contentType, connection: null, accounts: [] };

  const metadata = (row.metadata ?? {}) as { pageId?: string; igUserId?: string; pages?: unknown };
  // Accounts not recorded yet (connected before the Connection Manager): from what verify() stored.
  if (row.accounts.length === 0 && exec.connectorId === 'meta' && metadata.pageId) {
    await recordDiscoveredAccounts({
      connectionId: row.id,
      companyId,
      accounts: discoverAccounts({ connectorId: 'meta', accountLabel: row.accountLabel, providerAccountId: row.providerAccountId, metadata: metadata as Record<string, unknown> }),
    });
    row = (await db.connection.findUnique({ where, include: { accounts: true } }))!;
  }

  return {
    platform,
    contentType,
    connection: {
      id: row.id,
      connectorId: row.connectorId,
      provider: row.provider,
      status: row.status,
      health: row.health as ConnectionHealthStatus,
      healthReason: row.healthReason,
      scopes: row.scopes.length ? row.scopes : parseScopes(row.scope),
      pageId: typeof metadata.pageId === 'string' ? metadata.pageId : null,
      igUserId: typeof metadata.igUserId === 'string' ? metadata.igUserId : null,
      linkedInOrgUrn: process.env.LINKEDIN_ORG_URN?.trim() || null,
    },
    accounts: row.accounts.map((a) => ({ id: a.id, kind: a.kind, externalId: a.externalId, name: a.name, parentId: a.parentId, selected: a.selected })),
  };
}
