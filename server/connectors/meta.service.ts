import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { graphUrl, pageLabel, pageMetadata, pagesFrom, tokenHealth, type MetaPage } from '@/lib/meta';
import { resolveCredential } from '@/server/connectors/connection.service';
import { recordAudit } from '@/server/services/audit.service';
import { discoverAccounts } from '@/lib/connection-manager';
import { recordDiscoveredAccounts } from '@/server/connections/accounts';
import { markRevoked } from '@/server/connections/health.service';

/**
 * The Meta connection beyond connect/disconnect (server/connectors/
 * connection.service.ts handles those):
 *
 *   getMetaStatus     which Pages, which one is chosen, whether the token is
 *                     about to expire
 *   selectMetaPage    choose the Page (and so the Instagram account) to publish
 *                     to — only one the person still manages, checked live
 *   deauthorize       Meta's callback when someone removes Aura in their
 *                     Facebook settings: the connection stops working at once
 *   deleteMetaData    Meta's data-deletion callback: the connection data goes
 */

export class MetaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MetaError';
  }
}

export interface MetaStatus {
  connected: boolean;
  pages: MetaPage[];
  selectedPageId: string | null;
  health: ReturnType<typeof tokenHealth>;
  expiresAt: string | null;
}

export async function getMetaStatus(companyId: string): Promise<MetaStatus> {
  const row = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId: 'meta' } } });
  const meta = (row?.metadata ?? {}) as { pages?: MetaPage[]; pageId?: string };
  return {
    connected: row?.status === 'CONNECTED',
    pages: Array.isArray(meta.pages) ? meta.pages : [],
    selectedPageId: typeof meta.pageId === 'string' ? meta.pageId : null,
    health: tokenHealth(row?.expiresAt ?? null),
    expiresAt: row?.expiresAt?.toISOString() ?? null,
  };
}

/**
 * Publish to this Page from now on. It must be one the connected Facebook
 * account manages RIGHT NOW (asked of Meta, not read from what was stored),
 * so a Page someone lost access to cannot be chosen.
 */
export async function selectMetaPage(args: {
  companyId: string;
  userId: string;
  pageId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accountLabel: string; page: MetaPage }> {
  const row = await db.connection.findUnique({ where: { companyId_connectorId: { companyId: args.companyId, connectorId: 'meta' } } });
  if (!row || row.status !== 'CONNECTED') throw new MetaError('Facebook & Instagram isn’t connected.', 409);
  const credential = await resolveCredential(args.companyId, 'meta');
  if (!credential?.accessToken) throw new MetaError('The Facebook connection has expired — reconnect it.', 409);

  const res = await (args.fetchImpl ?? fetch)(
    graphUrl(`me/accounts?fields=id,name,instagram_business_account{id,username}&limit=50&access_token=${encodeURIComponent(credential.accessToken)}`),
    { cache: 'no-store' },
  );
  if (!res.ok) throw new MetaError('Facebook didn’t answer — try again, or reconnect.', 502);
  const pages = pagesFrom(await res.json());
  const page = pages.find((p) => p.id === args.pageId);
  // Not managed by this account: the same answer as "no such Page".
  if (!page) throw new MetaError('That Page isn’t one this Facebook account manages.', 404);

  const previous = (row.metadata ?? {}) as { fbUserId?: string };
  const accountLabel = pageLabel(page);
  await db.connection.update({
    where: { id: row.id },
    data: {
      accountLabel,
      metadata: pageMetadata(page, pages, previous.fbUserId ?? null) as unknown as Prisma.InputJsonObject,
      lastSyncedAt: new Date(),
    },
  });
  // Keep the Connection Manager's account tree in step with the choice.
  await recordDiscoveredAccounts({
    connectionId: row.id,
    companyId: args.companyId,
    accounts: discoverAccounts({
      connectorId: 'meta',
      accountLabel,
      providerAccountId: previous.fbUserId ?? null,
      metadata: pageMetadata(page, pages, previous.fbUserId ?? null) as unknown as Record<string, unknown>,
    }),
  });
  await recordAudit({
    action: 'CONNECTOR_SYNCED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { connectorId: 'meta', pageId: page.id, instagram: Boolean(page.ig) },
  });
  return { accountLabel, page };
}

/** Connections made by this Facebook user (any workspace). */
function byFacebookUser(fbUserId: string) {
  return db.connection.findMany({
    where: { connectorId: 'meta', metadata: { path: ['fbUserId'], equals: fbUserId } },
    select: { id: true, companyId: true },
  });
}

/**
 * Someone removed Aura in their Facebook settings. Their token no longer
 * works anyway; this makes Aura say so at once (rather than when a post
 * fails) and forgets the token.
 */
export async function deauthorize(fbUserId: string): Promise<number> {
  const rows = await byFacebookUser(fbUserId);
  // Marked REVOKED (tokens cleared), not deleted: the workspace sees that
  // access was withdrawn and is asked to reconnect.
  await markRevoked(
    rows.map((r) => r.id),
    'Access was removed in Facebook settings — reconnect to publish again.',
    'deauthorized_on_facebook',
  );
  for (const r of rows) {
    await recordAudit({
      action: 'CONNECTOR_DISCONNECTED',
      companyId: r.companyId,
      metadata: { connectorId: 'meta', reason: 'deauthorized_on_facebook' },
    });
  }
  return rows.length;
}

/**
 * Meta's data-deletion request: every Meta connection this Facebook user
 * made — tokens, Page and Instagram ids — is deleted. Content the workspace
 * wrote itself stays (it is the business's, not data from Facebook).
 * Returns a confirmation code the person can check.
 */
export async function deleteMetaData(fbUserId: string): Promise<{ code: string; deleted: number }> {
  const code = crypto.randomBytes(8).toString('hex');
  const rows = await byFacebookUser(fbUserId);
  if (rows.length) await db.connection.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  for (const r of rows) {
    await recordAudit({
      action: 'CONNECTOR_DISCONNECTED',
      companyId: r.companyId,
      metadata: { connectorId: 'meta', reason: 'data_deletion_request', confirmationCode: code },
    });
  }
  if (!rows.length) {
    // Recorded even when there was nothing to delete, so the status page can answer.
    await recordAudit({ action: 'CONNECTOR_DISCONNECTED', metadata: { connectorId: 'meta', reason: 'data_deletion_request', confirmationCode: code, deleted: 0 } });
  }
  return { code, deleted: rows.length };
}

/** Whether a data-deletion request with this code was processed. */
export async function deletionProcessed(code: string): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(code)) return false;
  const row = await db.auditLog.findFirst({
    where: { action: 'CONNECTOR_DISCONNECTED', metadata: { path: ['confirmationCode'], equals: code } },
    select: { id: true },
  });
  return Boolean(row);
}
