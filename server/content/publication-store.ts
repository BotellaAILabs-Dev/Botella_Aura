import { Prisma, type ContentPublication, type SocialPlatform } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { syncFromPublication } from '@/server/execution/engine.service';

/**
 * Publication records (ContentPublication): one per (piece, network). The
 * claim below is what makes publishing impossible to duplicate:
 *
 *   - no record yet          → create it, PUBLISHING (the unique key means
 *                              only one of two simultaneous creates wins)
 *   - PUBLISHED              → never again ("already published")
 *   - PUBLISHING, recent     → someone else is publishing it right now
 *   - PUBLISHING, stale      → an attempt that never finished: we cannot know
 *                              whether the network got it, so it becomes FAILED
 *                              with that said, for a PERSON to check and retry —
 *                              never re-posted automatically
 *   - FAILED / MANUAL        → a person's retry claims it (compare-and-swap);
 *                              the scheduler (`automatic`) never does
 *   - PROCESSING             → the network accepted it and is still processing
 *                              (an Instagram Reel); only the publish sweep moves
 *                              it on (server/content/processing.service.ts)
 */

/** An attempt older than this did not finish (the slowest network takes about a minute). */
export const PUBLISH_LEASE_MS = 3 * 60_000;

export type ClaimResult =
  | { claimed: true; publication: ContentPublication }
  | { claimed: false; reason: 'already_published' | 'in_progress' | 'interrupted' | 'needs_person'; publication: ContentPublication };

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export async function claimPublication(args: {
  companyId: string;
  draftId: string;
  platform: SocialPlatform;
  contentHash: string;
  userId: string | null;
  /** The scheduler: may start a first attempt, never retry one. */
  automatic?: boolean;
  /**
   * The scheduler retrying an attempt the provider refused with "slow down"
   * (rate limit) — the only automatic retry: the provider answered, so the
   * post certainly did not go out (server/execution/execution-actions.service.ts).
   */
  retry?: boolean;
  now?: Date;
}): Promise<ClaimResult> {
  const result = await claim(args);
  // The execution lifecycle follows; bookkeeping never blocks the claim.
  await followExecution(async () => {
    if (result.claimed) await syncFromPublication(result.publication, { automatic: args.automatic, event: 'claimed' });
    else if (result.reason === 'interrupted' || result.reason === 'already_published') {
      await syncFromPublication(result.publication, { automatic: args.automatic, event: 'refused' });
    }
  });
  return result;
}

async function claim(args: Parameters<typeof claimPublication>[0]): Promise<ClaimResult> {
  const now = args.now ?? new Date();
  const key = { contentDraftId_platform: { contentDraftId: args.draftId, platform: args.platform } };
  const attempt = { status: 'PUBLISHING' as const, startedAt: now, contentHash: args.contentHash, message: null, requestedById: args.userId };

  for (let round = 0; round < 3; round++) {
    const existing = await db.contentPublication.findUnique({ where: key });
    if (!existing) {
      try {
        const publication = await db.contentPublication.create({
          data: { companyId: args.companyId, contentDraftId: args.draftId, platform: args.platform, attempts: 1, ...attempt },
        });
        return { claimed: true, publication };
      } catch (e) {
        if (isUnique(e)) continue; // created by a concurrent attempt — look again
        throw e;
      }
    }
    if (existing.status === 'PUBLISHED') return { claimed: false, reason: 'already_published', publication: existing };
    if (existing.status === 'PROCESSING') return { claimed: false, reason: 'in_progress', publication: existing };
    if (existing.status === 'PUBLISHING') {
      const fresh = existing.startedAt && now.getTime() - existing.startedAt.getTime() < PUBLISH_LEASE_MS;
      if (fresh) return { claimed: false, reason: 'in_progress', publication: existing };
      const interrupted = await db.contentPublication.updateMany({
        where: { id: existing.id, status: 'PUBLISHING', updatedAt: existing.updatedAt },
        data: {
          status: 'FAILED',
          message: 'An earlier attempt was interrupted before the network answered. Check the account for the post before retrying, so it is not posted twice.',
        },
      });
      const after = (await db.contentPublication.findUnique({ where: key }))!;
      if (interrupted.count === 1) return { claimed: false, reason: 'interrupted', publication: after };
      continue;
    }
    // FAILED or MANUAL: only a person retries (or the scheduler's rate-limit retry).
    if (args.automatic && !args.retry) return { claimed: false, reason: 'needs_person', publication: existing };
    const won = await db.contentPublication.updateMany({
      where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
      data: { ...attempt, attempts: existing.attempts + 1 },
    });
    if (won.count === 1) return { claimed: true, publication: (await db.contentPublication.findUnique({ where: key }))! };
  }
  const publication = (await db.contentPublication.findUnique({ where: key }))!;
  return { claimed: false, reason: 'in_progress', publication };
}

export type Outcome =
  | { status: 'PUBLISHED'; url: string | null; externalId?: string | null }
  | { status: 'PROCESSING'; externalId: string; message: string }
  | { status: 'MANUAL'; message: string }
  | { status: 'FAILED'; message: string };

/** Record what the network said. Only the attempt that holds the claim writes. */
export async function finishPublication(id: string, outcome: Outcome, now: Date = new Date()): Promise<void> {
  const written = await db.contentPublication.updateMany({
    where: { id, status: 'PUBLISHING' },
    data:
      outcome.status === 'PUBLISHED'
        ? // The network's id for the post (insights are read with it).
          { status: 'PUBLISHED', url: outcome.url, publishedAt: now, message: null, externalId: outcome.externalId ?? null }
        : outcome.status === 'PROCESSING'
          ? // Released at once (startedAt null): the sweep may check it next.
            { status: 'PROCESSING', externalId: outcome.externalId, message: outcome.message.slice(0, 2000), startedAt: null }
          : { status: outcome.status, message: outcome.message.slice(0, 2000), externalId: null },
  });
  if (written.count === 1) {
    await followExecution(async () => {
      const row = await db.contentPublication.findUnique({ where: { id } });
      // FAILED comes from a thrown error (the outcome may be unknown); MANUAL from an answer.
      if (row) await syncFromPublication(row, { thrown: outcome.status === 'FAILED', providerExternalId: outcome.status === 'PUBLISHED' ? (outcome.externalId ?? null) : null, event: 'finished' });
    });
  }
}

/** The execution record follows a publication; never at the publication's expense. */
async function followExecution(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn('publication: execution record not updated', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function listPublications(companyId: string, draftId: string) {
  return db.contentPublication.findMany({
    where: { companyId, contentDraftId: draftId },
    orderBy: { createdAt: 'asc' },
  });
}
