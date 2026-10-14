import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { contentHash } from '@/server/approval/approval.service';
import { getDraft, markPublished } from '@/server/content/content.service';
import { renderForManual } from '@/server/content/render';
import {
  continueInstagramPost,
  getInstagramContext,
  InstagramPublishError,
} from '@/server/media/publishers/instagram';
import { recordAudit } from '@/server/services/audit.service';
import { notifyUser } from '@/server/whatsapp/notify';

/**
 * Finishing publications the network was still processing (PROCESSING —
 * today, Instagram Reels and carousels with video; see
 * server/media/publishers/instagram.ts).
 *
 * Run by the sweeps (/api/cron/publish, /api/cron/whatsapp) and by the draft
 * page while it shows one processing. Each row is leased (startedAt) so two
 * runs never advance the same post; Instagram's own 24-hour container expiry
 * ends anything that never finishes.
 *
 * Before publishing, the piece must still be exactly what was approved: an
 * edit, or an approval withdrawn, while Instagram was processing means
 * nothing is published.
 */

/** A run that held a row longer than this died; the next may take it. */
export const PROCESSING_LEASE_MS = 2 * 60_000;

export interface ProcessingRunResult {
  checked: number;
  published: number;
  stillProcessing: number;
  failed: number;
}

export async function advanceProcessing(args: {
  companyId?: string;
  draftId?: string;
  limit?: number;
  now?: Date;
} = {}): Promise<ProcessingRunResult> {
  const now = args.now ?? new Date();
  const result: ProcessingRunResult = { checked: 0, published: 0, stillProcessing: 0, failed: 0 };
  const rows = await db.contentPublication.findMany({
    where: {
      status: 'PROCESSING',
      ...(args.companyId ? { companyId: args.companyId } : {}),
      ...(args.draftId ? { contentDraftId: args.draftId } : {}),
    },
    orderBy: { updatedAt: 'asc' },
    take: args.limit ?? 20,
  });

  for (const row of rows) {
    // Lease it (compare-and-swap on startedAt).
    const lease = await db.contentPublication.updateMany({
      where: {
        id: row.id,
        status: 'PROCESSING',
        OR: [{ startedAt: null }, { startedAt: { lt: new Date(now.getTime() - PROCESSING_LEASE_MS) } }],
      },
      data: { startedAt: now },
    });
    if (lease.count !== 1) continue;
    result.checked++;
    const outcome = await advanceOne(row, now);
    result[outcome]++;
  }
  return result;
}

type Row = Awaited<ReturnType<typeof db.contentPublication.findMany>>[number];

async function advanceOne(row: Row, now: Date): Promise<'published' | 'stillProcessing' | 'failed'> {
  const { companyId, contentDraftId: draftId } = row;
  const fail = async (message: string) => {
    await db.contentPublication.updateMany({
      where: { id: row.id, status: 'PROCESSING' },
      data: { status: 'FAILED', message: message.slice(0, 2000), externalId: null, startedAt: null },
    });
    await recordAudit({
      action: 'CONTENT_PUBLISH_FAILED',
      userId: row.requestedById,
      companyId,
      metadata: { draftId, platform: row.platform, message: message.slice(0, 300) },
    });
    if (row.requestedById) {
      await notifyUser({ userId: row.requestedById, companyId, text: `❌ Instagram didn’t publish your post: ${message}` });
    }
    return 'failed' as const;
  };

  const draft = await getDraft(companyId, draftId);
  if (!draft) return fail('The post was deleted while Instagram was processing it. Nothing was published.');
  if ((draft.status !== 'APPROVED' && draft.status !== 'PUBLISHED') || (await contentHash(draft)) !== row.contentHash) {
    return fail('The post changed (or its approval was withdrawn) while Instagram was processing it, so it was not published. Approve it again and publish.');
  }
  const context = await getInstagramContext(companyId);
  if (!context) return fail('Instagram was disconnected before the post finished processing. Reconnect Meta and publish again.');
  if (!row.externalId) return fail('The pending Instagram upload could not be found. Publish again.');

  let outcome;
  try {
    outcome = await continueInstagramPost({
      context,
      externalId: row.externalId,
      caption: renderForManual(draft).slice(0, 2200),
    });
  } catch (err) {
    if (err instanceof InstagramPublishError) return fail(err.message);
    // A network blip: keep it processing; the next run tries again.
    logger.warn('publishing: could not check a processing post', {
      publicationId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await db.contentPublication.updateMany({ where: { id: row.id, status: 'PROCESSING' }, data: { startedAt: null } });
    return 'stillProcessing';
  }

  if (outcome.state === 'processing') {
    await db.contentPublication.updateMany({
      where: { id: row.id, status: 'PROCESSING' },
      data: { externalId: outcome.externalId, startedAt: null },
    });
    return 'stillProcessing';
  }

  await db.contentPublication.updateMany({
    where: { id: row.id, status: 'PROCESSING' },
    data: { status: 'PUBLISHED', url: outcome.url, publishedAt: now, message: null, externalId: null, startedAt: null },
  });
  if (draft.status === 'APPROVED') {
    try {
      await markPublished({ companyId, userId: row.requestedById, draftId, publishedUrl: outcome.url });
    } catch (err) {
      logger.warn('publishing: draft already marked published', { draftId, error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    await recordAudit({
      action: 'CONTENT_PUBLISHED',
      userId: row.requestedById,
      companyId,
      metadata: { draftId, platform: row.platform, publishedUrl: outcome.url ?? undefined },
    });
  }
  if (row.requestedById) {
    await notifyUser({
      userId: row.requestedById,
      companyId,
      text: `✅ Your post is live on Instagram${outcome.url ? `: ${outcome.url}` : '.'}`,
    });
  }
  return 'published';
}
