import type { CompanyRole, ContentDraft, ContentPublication } from '@prisma/client';

import { db } from '@/lib/db';
import { can } from '@/lib/rbac';
import { tokenHealth } from '@/lib/meta';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import { isCopyOnlyType, type ContentTypeKey } from '@/lib/validations/content';
import { logger } from '@/lib/logger';
import { assertContentIntact, contentHash } from '@/server/approval/approval.service';
import { getDraft, markPublished } from '@/server/content/content.service';
import { canAutoPublishTo, outcomeOf, publishTo, type PublishResult } from '@/server/content/publish.service';
import { claimPublication, finishPublication, listPublications } from '@/server/content/publication-store';
import { renderForManual, renderLinkedInCommentary } from '@/server/content/render';
import { validateForPlatform, validateMediaSet } from '@/server/media/validate';
import { runReviewAction } from '@/server/review/review-actions.service';
import { getPublishContext } from '@/server/services/linkedin.service';
import { recordAudit } from '@/server/services/audit.service';

/**
 * One action, several networks: "Approve & Publish to Selected Platforms".
 *
 *   previewPublishing   what each network would receive (the exact text, the
 *                       images), and whether it can go: the format, the
 *                       connection, the image, a publication already made
 *   publishToPlatforms  approves (if needed — same approval as the review
 *                       screen, by someone allowed to), then publishes to each
 *                       chosen network independently, each claimed first
 *                       (publication-store.ts): one network failing keeps the
 *                       others' successes; nothing is ever posted twice
 *
 * Publishing is not simultaneous — each network is its own request — and a
 * failure is retried only when a person asks.
 */

export const MULTI_PLATFORMS = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'] as const satisfies readonly SocialPlatformKey[];
export type MultiPlatform = (typeof MULTI_PLATFORMS)[number];

export interface PlatformPreview {
  platform: MultiPlatform;
  label: string;
  /** Exactly what would be posted. */
  text: string;
  images: number;
  /** How many of the attached items are videos (Instagram Reels / carousel videos). */
  videos: number;
  /** Can be published now. */
  ready: boolean;
  /** Why not, in plain words. */
  blockers: string[];
  publication: { status: ContentPublication['status']; url: string | null; message: string | null; attempts: number } | null;
}

/** The text each network receives, from the approved body — deterministic. */
export function platformText(draft: ContentDraft, platform: MultiPlatform): string {
  if (platform === 'LINKEDIN') return renderLinkedInCommentary(draft) ?? renderForManual(draft);
  // Instagram captions cap at 2,200; Facebook uses the same cap so the post
  // reads the same everywhere.
  return renderForManual(draft).slice(0, 2200);
}

async function connectionBlockers(companyId: string): Promise<Record<MultiPlatform, string | null>> {
  const [linkedin, meta] = await Promise.all([
    getPublishContext(companyId),
    db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId: 'meta' } } }),
  ]);
  const scopes = (linkedin?.scope ?? '').split(/[\s,]+/);
  const metaOk = meta?.status === 'CONNECTED' && tokenHealth(meta.expiresAt) !== 'expired';
  const igLinked = Boolean((meta?.metadata as { igUserId?: string } | null)?.igUserId);
  return {
    LINKEDIN: !linkedin
      ? 'LinkedIn isn’t connected (or the connection expired).'
      : !scopes.includes('w_member_social') && !scopes.includes('w_organization_social')
        ? 'LinkedIn is connected without posting permission — reconnect and allow “Share on LinkedIn”.'
        : null,
    FACEBOOK: metaOk ? null : 'Facebook isn’t connected (or the connection expired).',
    INSTAGRAM: !metaOk
      ? 'Instagram isn’t connected (or the connection expired).'
      : !igLinked
        ? 'No Instagram Business or Creator account is linked to the chosen Facebook Page.'
        : null,
  };
}

export async function previewPublishing(companyId: string, draft: ContentDraft): Promise<PlatformPreview[]> {
  const type = draft.type as ContentTypeKey;
  const [connections, media, publications] = await Promise.all([
    connectionBlockers(companyId),
    db.contentMedia.findMany({
      where: { companyId, contentDraftId: draft.id },
      orderBy: { position: 'asc' },
      include: { asset: { select: { kind: true, mimeType: true, width: true, height: true, fileSize: true, metadata: true } } },
    }),
    listPublications(companyId, draft.id),
  ]);
  return MULTI_PLATFORMS.map((platform) => {
    const blockers: string[] = [];
    const pub = publications.find((p) => p.platform === platform) ?? null;
    if (isCopyOnlyType(type)) blockers.push('This format is copied out, not posted to social networks.');
    else if (!canAutoPublishTo(type, platform)) blockers.push(`${platformSpec(platform).label}’s API doesn’t take this format — post it by hand.`);
    if (connections[platform]) blockers.push(connections[platform]!);
    blockers.push(...validateMediaSet(media.map((m) => m.asset), platform));
    for (const m of media) blockers.push(...validateForPlatform(m.asset, platform).problems);
    if (pub?.status === 'PUBLISHED') blockers.push('Already published here.');
    if (pub?.status === 'PUBLISHING') blockers.push('Being published right now.');
    if (pub?.status === 'PROCESSING') blockers.push('Instagram is still processing it — it goes live when that finishes.');
    return {
      platform,
      label: platformSpec(platform).label,
      text: platformText(draft, platform),
      images: media.length,
      videos: media.filter((m) => m.asset.kind === 'VIDEO').length,
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)],
      publication: pub ? { status: pub.status, url: pub.url, message: pub.message, attempts: pub.attempts } : null,
    };
  });
}

export class PublishRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PublishRequestError';
  }
}

export type PlatformResult =
  | { platform: MultiPlatform; status: 'published'; url: string | null }
  /** Accepted, still processing (an Instagram Reel): not published yet. */
  | { platform: MultiPlatform; status: 'processing'; message: string }
  | { platform: MultiPlatform; status: 'manual' | 'failed'; message: string }
  | { platform: MultiPlatform; status: 'skipped'; message: string };

const SKIP_REASON = {
  already_published: 'Already published here — not posted again.',
  in_progress: 'Being published right now.',
  interrupted: 'An earlier attempt was interrupted before the network answered. Check the account for the post, then retry.',
  needs_person: 'Needs a retry by a person.',
} as const;

/**
 * Approve (when it isn't yet) and publish to the chosen networks.
 *
 * Who: publishing needs content:publish; approving as part of it needs
 * content:approve — both OWNER/ADMIN. The approval is the review screen's own
 * (runReviewAction), with its AI review, compliance and fact checks;
 * `acknowledged` is the approver vouching for flagged claims, as there.
 */
export async function publishToPlatforms(args: {
  companyId: string;
  userId: string;
  role: CompanyRole;
  draftId: string;
  platforms: MultiPlatform[];
  acknowledged?: boolean;
}): Promise<{ results: PlatformResult[]; approvedNow: boolean }> {
  const { companyId, userId, role } = args;
  if (!can(role, 'content:publish')) throw new PublishRequestError('Only owners and admins can publish.', 403);
  const platforms = [...new Set(args.platforms)].filter((p) => (MULTI_PLATFORMS as readonly string[]).includes(p));
  if (!platforms.length) throw new PublishRequestError('Choose at least one network.', 422);

  let draft = await getDraft(companyId, args.draftId);
  if (!draft) throw new PublishRequestError('Not found.', 404);
  if (isCopyOnlyType(draft.type as ContentTypeKey)) {
    throw new PublishRequestError('This format is copied out, not posted to social networks.', 409);
  }

  // 1. The explicit human approval (unless it is already approved / published).
  let approvedNow = false;
  if (draft.status !== 'APPROVED' && draft.status !== 'PUBLISHED') {
    if (!can(role, 'content:approve')) throw new PublishRequestError('Only owners and admins can approve.', 403);
    await runReviewAction({
      kind: 'content',
      id: draft.id,
      companyId,
      userId,
      role,
      input: { action: 'approve', confirmed: args.acknowledged === true },
    });
    approvedNow = true;
    draft = (await getDraft(companyId, draft.id))!;
  }
  // Exactly what was approved — not something changed since.
  if (draft.status === 'APPROVED') await assertContentIntact(draft);
  const hash = await contentHash(draft);

  // 2. Only networks that can go now; the rest say why.
  const preview = await previewPublishing(companyId, draft);
  const results: PlatformResult[] = [];
  const go: MultiPlatform[] = [];
  for (const p of platforms) {
    const pv = preview.find((x) => x.platform === p)!;
    const onlyPublished = pv.blockers.length === 1 && pv.publication?.status === 'PUBLISHED';
    if (pv.ready) go.push(p);
    else results.push({ platform: p, status: 'skipped', message: onlyPublished ? SKIP_REASON.already_published : pv.blockers.join(' ') });
  }
  await recordAudit({
    action: 'CONTENT_PUBLISH_REQUESTED',
    userId,
    companyId,
    metadata: { draftId: draft.id, platforms, approvedNow },
  });

  // 3. Each network on its own: claimed, published, recorded.
  const current = draft;
  const settled = await Promise.all(
    go.map(async (platform): Promise<PlatformResult> => {
      const claim = await claimPublication({ companyId, draftId: current.id, platform, contentHash: hash, userId });
      if (!claim.claimed) return { platform, status: 'skipped', message: SKIP_REASON[claim.reason] };
      let result: PublishResult;
      try {
        result = await publishTo({ companyId, userId, draft: current, platform });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'The network could not be reached.';
        await finishPublication(claim.publication.id, { status: 'FAILED', message });
        await recordAudit({ action: 'CONTENT_PUBLISH_FAILED', userId, companyId, metadata: { draftId: current.id, platform, message: message.slice(0, 300) } });
        logger.warn('multi-publish: network failed', { draftId: current.id, platform, error: message.slice(0, 200) });
        return { platform, status: 'failed', message };
      }
      await finishPublication(claim.publication.id, outcomeOf(result));
      if (result.mode === 'published') return { platform, status: 'published', url: result.url };
      if (result.mode === 'processing') return { platform, status: 'processing', message: result.message };
      const message = result.mode === 'reconnect' ? result.message : result.reason;
      return { platform, status: 'manual', message };
    }),
  );
  results.push(...settled);

  // 4. The piece is published once any network has it; each network is audited.
  const done = settled.filter((r): r is Extract<PlatformResult, { status: 'published' }> => r.status === 'published');
  if (done.length && current.status === 'APPROVED') {
    try {
      await markPublished({ companyId, userId, draftId: current.id, publishedUrl: done[0]!.url });
    } catch (err) {
      // Another request marked it first — the publications are what count.
      logger.warn('multi-publish: draft already marked published', { draftId: current.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const r of done.slice(current.status === 'APPROVED' ? 1 : 0)) {
    await recordAudit({ action: 'CONTENT_PUBLISHED', userId, companyId, metadata: { draftId: current.id, platform: r.platform, publishedUrl: r.url ?? undefined } });
  }
  // Order as asked.
  results.sort((a, b) => platforms.indexOf(a.platform) - platforms.indexOf(b.platform));
  return { results, approvedNow };
}
