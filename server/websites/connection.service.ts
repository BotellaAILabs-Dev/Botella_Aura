import { Prisma, type WebsiteConnection } from '@prisma/client';

import { db } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/crypto';
import { absoluteUrl } from '@/lib/app-url';
import { sendEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
import { connectionState, websitePlatform, type WebsiteConnectionState } from '@/lib/website-platforms';
import { recordAudit } from '@/server/services/audit.service';
import { notifyUser } from '@/server/whatsapp/notify';
import { getAdapter } from '@/server/websites/registry';
import { WebsitePublishError, type SiteContext } from '@/server/websites/types';

/**
 * Connected websites (WebsiteConnection). Several per workspace — and per
 * platform — each with its own encrypted credentials.
 *
 * Secrets are stored as one AES-256-GCM encrypted JSON blob (lib/crypto.ts)
 * and never leave the server: the API returns status, a display label, the
 * site address and non-secret settings. Disconnecting withdraws access at
 * the platform where it allows (WordPress, Shopify OAuth), wipes the stored
 * credentials, and keeps the publishing history.
 */

export class WebsiteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'WebsiteError';
  }
}

interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface WebsiteView {
  id: string;
  platform: string;
  platformName: string;
  name: string;
  siteUrl: string;
  status: WebsiteConnection['status'];
  state: WebsiteConnectionState;
  authKind: string;
  accountLabel: string | null;
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  lastError: string | null;
  lastCheckedAt: string | null;
  connectedAt: string;
}

export function toWebsiteView(c: WebsiteConnection): WebsiteView {
  return {
    id: c.id,
    platform: c.platform,
    platformName: websitePlatform(c.platform)?.name ?? c.platform,
    name: c.name,
    siteUrl: c.siteUrl,
    status: c.status,
    state: connectionState(c.status),
    authKind: c.authKind,
    accountLabel: c.accountLabel,
    settings: (c.settings ?? {}) as Record<string, unknown>,
    capabilities: (c.capabilities ?? {}) as Record<string, unknown>,
    lastError: c.lastError,
    lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
    connectedAt: c.createdAt.toISOString(),
  };
}

export async function listWebsites(companyId: string, opts: { includeDisconnected?: boolean } = {}): Promise<WebsiteView[]> {
  const rows = await db.websiteConnection.findMany({
    where: { companyId, ...(opts.includeDisconnected ? {} : { status: { not: 'DISCONNECTED' } }) },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toWebsiteView);
}

export async function getWebsiteRow(companyId: string, id: string): Promise<WebsiteConnection> {
  const row = await db.websiteConnection.findFirst({ where: { id, companyId } });
  if (!row) throw new WebsiteError('That website isn’t connected to this workspace.', 404);
  return row;
}

/** Decrypted credentials for the adapter. Throws a reconnect error when unreadable. */
export function siteContext(row: WebsiteConnection): SiteContext {
  if (!row.credentialsEnc) {
    throw new WebsitePublishError('auth', `${row.name} is disconnected. Connect it again to publish.`);
  }
  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(decrypt(row.credentialsEnc)) as Record<string, string>;
  } catch {
    // ENCRYPTION_KEY rotated: the stored secret is gone for good.
    throw new WebsitePublishError('auth', `Aura can no longer read the stored credentials for ${row.name}. Reconnect it.`);
  }
  return {
    siteUrl: row.siteUrl,
    authKind: row.authKind,
    credentials,
    settings: (row.settings ?? {}) as Record<string, unknown>,
    capabilities: (row.capabilities ?? {}) as Record<string, unknown>,
  };
}

function adapterFor(platform: string) {
  const adapter = getAdapter(platform);
  if (!adapter) {
    const meta = websitePlatform(platform);
    throw new WebsiteError(
      meta?.status === 'no_api'
        ? `${meta.name} has no API for publishing blog posts. ${meta.limitations[1] ?? ''}`
        : meta
          ? `${meta.name} publishing isn’t available yet.`
          : 'Unknown website platform.',
      409,
    );
  }
  return adapter;
}

const asWebsiteError = (err: unknown) =>
  err instanceof WebsitePublishError || (err as Error)?.name === 'UnsafeUrlError'
    ? new WebsiteError((err as Error).message, 400)
    : err;

/**
 * Verify what the person entered with the platform, then store it. A
 * credential that does not work is never stored. Reconnecting the same site
 * (same platform and address) updates that connection — history continues.
 */
export async function connectWebsite(args: {
  companyId: string;
  userId: string;
  platform: string;
  name?: string;
  input: Record<string, string>;
  requestMeta?: RequestMeta;
}): Promise<WebsiteView> {
  const adapter = adapterFor(args.platform);
  let result;
  try {
    result = await adapter.connect(args.input);
  } catch (err) {
    throw asWebsiteError(err);
  }
  const name = (args.name?.trim() || result.accountLabel.split(' · ').pop() || result.siteUrl).slice(0, 80);
  const credentialsEnc = encrypt(JSON.stringify(result.credentials));
  const key = { companyId_platform_siteUrl: { companyId: args.companyId, platform: args.platform, siteUrl: result.siteUrl } };
  const previous = await db.websiteConnection.findUnique({ where: key });
  const data = {
    status: 'CONNECTED' as const,
    authKind: result.authKind,
    credentialsEnc,
    accountLabel: result.accountLabel,
    capabilities: result.capabilities as Prisma.InputJsonValue,
    lastError: null,
    lastCheckedAt: new Date(),
    connectedById: args.userId,
  };
  const row = previous
    ? await db.websiteConnection.update({
        where: { id: previous.id },
        data: {
          ...data,
          ...(args.name?.trim() ? { name } : {}),
          // Keep the person's chosen defaults; fill in any the site now offers.
          settings: { ...(result.settings ?? {}), ...((previous.settings ?? {}) as object) } as Prisma.InputJsonValue,
        },
      })
    : await db.websiteConnection.create({
        data: {
          ...data,
          companyId: args.companyId,
          platform: args.platform,
          siteUrl: result.siteUrl,
          name,
          settings: (result.settings ?? {}) as Prisma.InputJsonValue,
        },
      });
  await recordAudit({
    action: 'WEBSITE_CONNECTED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { websiteId: row.id, platform: args.platform, siteUrl: result.siteUrl, reconnect: Boolean(previous) },
    ...args.requestMeta,
  });
  return toWebsiteView(row);
}

/** "Test connection": re-verify and record the outcome. */
export async function testWebsite(companyId: string, id: string): Promise<{ ok: boolean; error?: string; website: WebsiteView }> {
  const row = await getWebsiteRow(companyId, id);
  const adapter = adapterFor(row.platform);
  try {
    const verified = await adapter.verify(siteContext(row));
    const updated = await db.websiteConnection.update({
      where: { id: row.id },
      data: {
        status: 'CONNECTED',
        accountLabel: verified.accountLabel,
        capabilities: verified.capabilities as Prisma.InputJsonValue,
        lastError: null,
        lastCheckedAt: new Date(),
      },
    });
    return { ok: true, website: toWebsiteView(updated) };
  } catch (err) {
    const e = err instanceof WebsitePublishError ? err : new WebsitePublishError('unknown', err instanceof Error ? err.message : String(err));
    const updated = await recordSiteFailure(row, e);
    return { ok: false, error: e.message, website: toWebsiteView(updated) };
  }
}

/**
 * What a failure means for the connection: refused credentials → the site
 * needs reconnecting (people are told, once); anything else → an error the
 * next success clears.
 */
export async function recordSiteFailure(row: WebsiteConnection, err: WebsitePublishError): Promise<WebsiteConnection> {
  if (err.code === 'auth') {
    const updated = await db.websiteConnection.update({
      where: { id: row.id },
      data: { status: 'REAUTH_REQUIRED', lastError: err.message.slice(0, 2000), lastCheckedAt: new Date() },
    });
    if (row.status !== 'REAUTH_REQUIRED') {
      await recordAudit({ action: 'WEBSITE_REAUTH_REQUIRED', companyId: row.companyId, metadata: { websiteId: row.id, platform: row.platform, reason: err.message.slice(0, 300) } });
      await notifyReauth(updated);
    }
    return updated;
  }
  // Only a problem with the site itself marks the connection; a rejected
  // field or a rate limit says nothing about whether it is connected.
  if (err.code === 'network' || err.code === 'unknown' || err.code === 'permission' || err.code === 'not_found') {
    return db.websiteConnection.update({
      where: { id: row.id },
      data: { status: row.status === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'ERROR', lastError: err.message.slice(0, 2000), lastCheckedAt: new Date() },
    });
  }
  return row;
}

/** A healthy round-trip clears an earlier error. */
export async function recordSiteSuccess(row: WebsiteConnection): Promise<void> {
  await db.websiteConnection.update({
    where: { id: row.id },
    data: { status: 'CONNECTED', lastError: null, lastCheckedAt: new Date() },
  });
}

/** Tell the people who can reconnect it: email, and WhatsApp when linked. Never throws. */
async function notifyReauth(row: WebsiteConnection): Promise<void> {
  try {
    const admins = await db.companyMember.findMany({
      where: { companyId: row.companyId, role: { in: ['OWNER', 'ADMIN'] } },
      include: { user: { select: { id: true, email: true } } },
    });
    const link = absoluteUrl('/dashboard/settings/websites');
    const text =
      `Aura can no longer publish to ${row.name} (${row.siteUrl}): ${row.lastError ?? 'the site refused the stored credentials.'}\n\n` +
      `Scheduled blogs for this site will wait until it is reconnected. Reconnect it here: ${link}`;
    for (const m of admins) {
      if (m.user.email) {
        await sendEmail({ to: m.user.email, subject: `Reconnect ${row.name} to keep publishing`, text }).catch(() => undefined);
      }
      await notifyUser({ userId: m.user.id, companyId: row.companyId, text: `Reconnect ${row.name} — Aura can’t publish to it until you do: ${link}` });
    }
  } catch (err) {
    logger.warn('websites: reauth notification not sent', { websiteId: row.id, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function updateWebsite(companyId: string, id: string, patch: { name?: string; settings?: Record<string, unknown> }): Promise<WebsiteView> {
  const row = await getWebsiteRow(companyId, id);
  const updated = await db.websiteConnection.update({
    where: { id: row.id },
    data: {
      ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 80) } : {}),
      ...(patch.settings ? { settings: { ...((row.settings ?? {}) as object), ...patch.settings } as Prisma.InputJsonValue } : {}),
    },
  });
  return toWebsiteView(updated);
}

export async function disconnectWebsite(args: { companyId: string; userId: string; id: string; requestMeta?: RequestMeta }): Promise<{ revokedAtPlatform: boolean; cancelled: number }> {
  const row = await getWebsiteRow(args.companyId, args.id);
  let revokedAtPlatform = false;
  const adapter = getAdapter(row.platform);
  if (adapter?.revoke && row.credentialsEnc) {
    try {
      await adapter.revoke(siteContext(row));
      revokedAtPlatform = true;
    } catch (err) {
      logger.warn('websites: revoke at platform failed (continuing)', { websiteId: row.id, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  const [, cancelled] = await db.$transaction([
    db.websiteConnection.update({
      where: { id: row.id },
      data: { status: 'DISCONNECTED', credentialsEnc: null, lastError: null },
    }),
    db.websitePublication.updateMany({
      where: { websiteConnectionId: row.id, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', errorMessage: 'The website was disconnected.' },
    }),
    db.websitePublishSchedule.updateMany({ where: { websiteConnectionId: row.id }, data: { enabled: false, nextRunAt: null } }),
  ]);
  await recordAudit({
    action: 'WEBSITE_DISCONNECTED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { websiteId: row.id, platform: row.platform, revokedAtPlatform, cancelledScheduled: cancelled.count },
    ...args.requestMeta,
  });
  return { revokedAtPlatform, cancelled: cancelled.count };
}

export async function websiteOptions(companyId: string, id: string) {
  const row = await getWebsiteRow(companyId, id);
  try {
    return await adapterFor(row.platform).listOptions(siteContext(row));
  } catch (err) {
    if (err instanceof WebsitePublishError) {
      await recordSiteFailure(row, err);
      throw new WebsiteError(err.message, err.code === 'auth' ? 401 : 502);
    }
    throw err;
  }
}
