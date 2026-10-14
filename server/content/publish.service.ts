import type { ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import { assertContentIntact, contentHash } from '@/server/approval/approval.service';
import { claimPublication, finishPublication, type Outcome } from '@/server/content/publication-store';
import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getPublishContext } from '@/server/services/linkedin.service';
import {
  assertPublishable,
  DraftNotFoundError,
  getDraft,
  markPublished,
} from '@/server/content/content.service';
import { renderForManual, renderLinkedInCommentary } from '@/server/content/render';
import { isCopyOnlyType, type ContentTypeKey } from '@/lib/validations/content';
import { resolvePlatform, platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import { getAsset, readAssetBytes } from '@/server/media/asset.service';
import { validateForPlatform, validateMediaSet } from '@/server/media/validate';
import { signedAssetUrl } from '@/server/media/asset-url';
import {
  buildMediaContent,
  uploadLinkedInImage,
  LinkedInMediaError,
} from '@/server/media/publishers/linkedin-image';
import {
  getFacebookContext,
  publishFacebookPost,
  FacebookPublishError,
} from '@/server/media/publishers/facebook';
import {
  getInstagramContext,
  startInstagramPost,
  InstagramPublishError,
  type InstagramItem,
} from '@/server/media/publishers/instagram';

/**
 * Publishing. HONESTY FIRST (NON-NEGOTIABLE / product principle): we only claim
 * "published" when a real official-API post succeeds. Everything else routes to
 * an explicit "copy for manual posting" fallback — never a fake published state.
 *
 * Publishing is now platform-routed. `resolvePlatform()` decides where a draft
 * goes (its explicit target, else the default for its content type), and each
 * platform has its own publisher. A platform with no API path available falls
 * back to manual/extension with a reason — it never silently succeeds.
 *
 * >>> LinkedIn API reality <<<
 * Auto-publishing to a Company Page requires LinkedIn's **Community Management
 * API** — product approval + the `w_organization_social` scope + an
 * organization URN (`LINKEDIN_ORG_URN`, urn:li:organization:XXXX) the connected
 * user administers. Sprint 2 connected via self-serve OIDC (`openid profile
 * email`), which CANNOT post; adding the self-serve "Share on LinkedIn" product
 * grants `w_member_social`, which posts to the connected member's own profile.
 * Attached graphics are uploaded through the official Images API first — see
 * server/media/publishers/linkedin-image.ts.
 *
 * >>> Instagram API reality <<<
 * Instagram publishing needs a Meta app (META_CLIENT_ID/SECRET), an Instagram
 * Business account linked to a Facebook Page, and `instagram_content_publish`
 * App Review approval. When those are present a post publishes for real; when
 * they are not, this returns the manual fallback saying exactly what is missing.
 */
const ORG_POSTING_SCOPE = 'w_organization_social'; // Company Page (needs approval)
const MEMBER_POSTING_SCOPE = 'w_member_social'; // personal profile (self-serve "Share on LinkedIn")
// LinkedIn versions the /rest/posts endpoint (YYYYMM) and rejects out-of-window
// versions with HTTP 426. Override via LINKEDIN_API_VERSION when this ages out.
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || '202503';

/**
 * Instagram fetches the image from the URL we hand it, and does so while
 * building the media container — a little after this request. Fifteen minutes
 * is generous cover for that without leaving a long-lived public link.
 */
const INSTAGRAM_ASSET_URL_TTL_MS = 15 * 60 * 1000;

export type PublishResult =
  | { mode: 'published'; url: string | null }
  | { mode: 'manual'; text: string; reason: string }
  | { mode: 'reconnect'; message: string }
  /**
   * Accepted by the network, which is still processing it (an Instagram Reel
   * or video carousel). The publish sweep finishes it
   * (server/content/processing.service.ts) — it is NOT published yet.
   */
  | { mode: 'processing'; externalId: string; message: string };

export const PROCESSING_MESSAGE =
  'Instagram is processing the video. It goes live once processing finishes, usually within a few minutes.';

/** Which types can auto-publish through an official API at all. */
export function canAutoPublish(type: ContentTypeKey): boolean {
  return type === 'LINKEDIN_POST' || type === 'IMAGE_POST';
}

/**
 * Whether a draft, as targeted, has an API path to publish through.
 *
 * Type alone is no longer the whole answer: a CAROUSEL aimed at Instagram
 * publishes through the Graph API as a single image, while the same carousel
 * aimed at LinkedIn does not. The detail view uses this to say the right thing.
 */
export function canAutoPublishTo(
  type: ContentTypeKey,
  platform: SocialPlatformKey,
): boolean {
  if (isCopyOnlyType(type)) return false; // copied out, never posted
  if (platform === 'INSTAGRAM') return true; // needs media; checked at publish
  // A Page post is a message plus an optional photo, so anything that renders
  // to text qualifies — including a carousel, which posts as its first image.
  if (platform === 'FACEBOOK') return true;
  if (platform === 'LINKEDIN')
    return type === 'LINKEDIN_POST' || type === 'IMAGE_POST';
  return false;
}

interface PublishArgs {
  companyId: string;
  /** Null for the system-triggered scheduled job. */
  userId: string | null;
  draftId: string;
}

/** Media attached to a draft, resolved for publishing. */
interface ResolvedMedia {
  assetId: string;
  altText: string | null;
  kind: 'IMAGE' | 'VIDEO';
  mimeType: string;
  width: number;
  height: number;
  fileSize: number;
  metadata: unknown;
  /** The bucket URL (videos are fetched from there by the network). */
  storageUrl: string | null;
}

async function loadMedia(
  companyId: string,
  draftId: string,
): Promise<ResolvedMedia[]> {
  const rows = await db.contentMedia.findMany({
    where: { companyId, contentDraftId: draftId },
    orderBy: { position: 'asc' },
    include: {
      asset: {
        select: {
          id: true,
          kind: true,
          mimeType: true,
          width: true,
          height: true,
          fileSize: true,
          metadata: true,
          storageUrl: true,
        },
      },
    },
  });
  return rows.map((row) => ({
    assetId: row.assetId,
    altText: row.altText,
    kind: row.asset.kind,
    mimeType: row.asset.mimeType,
    width: row.asset.width,
    height: row.asset.height,
    fileSize: row.asset.fileSize,
    metadata: row.asset.metadata,
    storageUrl: row.asset.storageUrl,
  }));
}

/**
 * Publish approved content to ONE network, through its official API, and say
 * what happened. Does not change the draft or any record — the callers
 * (publishDraft, the multi-network publish) claim the publication first and
 * record the outcome, so the same network can never be posted to twice.
 */
export async function publishTo(args: {
  companyId: string;
  userId: string | null;
  draft: ContentDraft;
  platform: SocialPlatformKey;
}): Promise<PublishResult> {
  const { companyId, userId, draft, platform } = args;
  const draftId = draft.id;
  const type = draft.type as ContentTypeKey;
  const media = await loadMedia(companyId, draftId);

  // Every attached image is checked against the destination BEFORE anything is
  // uploaded, so a size mismatch is an explanation rather than a half-finished
  // publish with an image the platform rejected.
  const problems = [
    ...new Set(media.flatMap((item) => validateForPlatform(item, platform).problems)),
  ];
  if (problems.length > 0) {
    return {
      mode: 'manual',
      text: renderForManual(draft),
      reason: media.some((m) => m.kind === 'VIDEO')
        ? `The attached media isn't valid for ${platformSpec(platform).label}: ${problems.join(' ')}`
        : `The attached graphic isn't valid for ${platformSpec(platform).label}: ${problems.join(' ')} Regenerate it at a supported format, then publish.`,
    };
  }
  // Too many items for a carousel is caught here too (no media is the
  // Instagram publisher's own explanation, below).
  const setProblems = validateMediaSet(media, platform).filter(() => media.length > 0);
  if (setProblems.length > 0) {
    return { mode: 'manual', text: renderForManual(draft), reason: setProblems.join(' ') };
  }

  if (platform === 'INSTAGRAM') {
    return publishToInstagram({ companyId, userId, draftId, draft, media });
  }
  if (platform === 'FACEBOOK') {
    return publishToFacebook({ companyId, userId, draftId, draft, media });
  }
  if (platform === 'LINKEDIN') {
    return publishToLinkedIn({ companyId, userId, draftId, draft, type, media });
  }

  // X has no publishing integration in this codebase. Saying so is the honest
  // outcome; the extension/manual path still gets the post out.
  return {
    mode: 'manual',
    text: renderForManual(draft),
    reason: `${platformSpec(platform).label} publishing isn't connected in this workspace. The formatted text is copied — paste it there, or use the extension${
      media.length > 0 ? ' (which carries the graphic too)' : ''
    }.`,
  };
}

/** A publish result as a publication record's outcome. */
export function outcomeOf(result: PublishResult): Outcome {
  if (result.mode === 'published') return { status: 'PUBLISHED', url: result.url };
  if (result.mode === 'processing') return { status: 'PROCESSING', externalId: result.externalId, message: result.message };
  if (result.mode === 'reconnect') return { status: 'MANUAL', message: result.message };
  return { status: 'MANUAL', message: result.reason };
}

const CLAIM_REFUSED: Record<'in_progress' | 'interrupted' | 'needs_person', string> = {
  in_progress: 'This is being published right now — refresh in a moment.',
  interrupted:
    'An earlier attempt was interrupted before the network answered. Check the account for the post before retrying, so it is not posted twice.',
  needs_person: 'An earlier attempt did not go through; a person needs to retry it.',
};

export async function publishDraft({
  companyId,
  userId,
  draftId,
  automatic = false,
}: PublishArgs & {
  /** The scheduler: starts a first attempt, never retries a failed one. */
  automatic?: boolean;
}): Promise<PublishResult> {
  const draft = await getDraft(companyId, draftId);
  if (!draft) throw new DraftNotFoundError();
  assertPublishable(draft); // hard gate — must be APPROVED
  // …and exactly what was approved: text, network and images.
  await assertContentIntact(draft);

  const type = draft.type as ContentTypeKey;
  // Email and ad copy never go to a social network — an ad aimed at Facebook
  // would otherwise be posted as an ordinary Facebook post.
  if (isCopyOnlyType(type)) {
    return {
      mode: 'manual',
      text: renderForManual(draft),
      reason:
        type === 'EMAIL'
          ? 'Emails are sent from your email tool. The email is copied — paste it there.'
          : 'Ads are set up in the ad manager. The ad copy is copied — paste it there.',
    };
  }
  const platform = resolvePlatform(type, draft.platform);

  // Claimed before the network is called: two clicks, two tabs, or a click
  // racing the scheduler can no longer post it twice.
  const claim = await claimPublication({
    companyId,
    draftId,
    platform,
    contentHash: await contentHash(draft),
    userId,
    automatic,
  });
  if (!claim.claimed) {
    if (claim.reason === 'already_published') return { mode: 'published', url: claim.publication.url };
    return { mode: 'manual', text: renderForManual(draft), reason: CLAIM_REFUSED[claim.reason] };
  }

  let result: PublishResult;
  try {
    result = await publishTo({ companyId, userId, draft, platform });
  } catch (err) {
    await finishPublication(claim.publication.id, {
      status: 'FAILED',
      message: err instanceof Error ? err.message : 'The network could not be reached.',
    });
    throw err;
  }
  await finishPublication(claim.publication.id, outcomeOf(result));
  if (result.mode === 'published') {
    await markPublished({ companyId, userId, draftId, publishedUrl: result.url });
  }
  return result;
}

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

async function publishToLinkedIn(args: {
  companyId: string;
  userId: string | null;
  draftId: string;
  draft: ContentDraft;
  type: ContentTypeKey;
  media: ResolvedMedia[];
}): Promise<PublishResult> {
  const { companyId, userId, draftId, draft, type, media } = args;

  if (!canAutoPublish(type)) {
    return {
      mode: 'manual',
      text: renderForManual(draft),
      reason:
        'Carousels, threads, and blogs can’t be auto-published through LinkedIn’s ' +
        'API — only single LinkedIn posts can. The formatted text is copied; paste ' +
        'it into a new LinkedIn post (or use the extension). Tip: generate a ' +
        '“LinkedIn post” type for one-click API publishing.',
    };
  }

  const ctx = await getPublishContext(companyId);
  if (!ctx) {
    return {
      mode: 'reconnect',
      message:
        "LinkedIn isn't connected, or the session expired. Reconnect it in " +
        'Settings → Connections to publish.',
    };
  }

  const commentary = renderLinkedInCommentary(draft);
  if (!commentary) {
    return { mode: 'manual', text: renderForManual(draft), reason: 'Draft body was invalid.' };
  }
  const scopes = (ctx.scope ?? '').split(/[\s,]+/);

  // Decide the author first: LinkedIn registers an uploaded image against an
  // owner, and rejects a post that references an image owned by anyone else.
  const orgUrn = process.env.LINKEDIN_ORG_URN;
  let author: string | null = null;
  if (scopes.includes(ORG_POSTING_SCOPE) && orgUrn) {
    author = orgUrn;
  } else if (scopes.includes(MEMBER_POSTING_SCOPE) && ctx.linkedInUserId) {
    author = `urn:li:person:${ctx.linkedInUserId}`;
  }

  if (!author) {
    // No posting scope granted → manual / extension fallback.
    return {
      mode: 'manual',
      text: renderForManual(draft),
      reason:
        "LinkedIn is connected but wasn't granted posting permission. Reconnect and " +
        'approve "Share on LinkedIn", or post via the extension. (Company Page ' +
        'publishing additionally needs Marketing API approval.)',
    };
  }

  let mediaContent: Record<string, unknown> | undefined;
  try {
    mediaContent = await uploadAttachedImages(companyId, ctx.token, author, media);
  } catch (err) {
    // The draft stays APPROVED so the user can retry or publish without the
    // image — losing an approved post to a media failure would be the worse bug.
    logger.error('LinkedIn publish: media upload failed', {
      draftId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      mode: 'manual',
      text: renderForManual(draft),
      reason:
        err instanceof LinkedInMediaError
          ? `${err.message} The post text is copied so you can publish it by hand.`
          : 'The graphic could not be uploaded to LinkedIn. The post text is copied so you can publish it by hand.',
    };
  }

  const url = await postToLinkedIn(ctx.token, author, commentary, mediaContent);
  return { mode: 'published', url };
}

/** Upload every attached image and build the post's media content block. */
async function uploadAttachedImages(
  companyId: string,
  token: string,
  ownerUrn: string,
  media: ResolvedMedia[],
): Promise<Record<string, unknown> | undefined> {
  if (media.length === 0) return undefined;

  const uploaded: Array<{ urn: string; altText?: string | null }> = [];
  for (const item of media) {
    const asset = await getAsset(companyId, item.assetId);
    const bytes = await readAssetBytes(asset);
    if (!bytes) {
      throw new LinkedInMediaError(
        'The stored graphic could not be read. Regenerate it and try again.',
      );
    }
    const urn = await uploadLinkedInImage({
      token,
      ownerUrn,
      data: bytes,
      mimeType: asset.mimeType,
    });
    uploaded.push({ urn, altText: item.altText });
  }
  return buildMediaContent(uploaded);
}

/**
 * POST to LinkedIn via the official /rest/posts endpoint. `authorUrn` is either
 * an organization URN (Company Page) or a person URN (personal profile). Throws
 * on failure so the caller keeps the draft APPROVED for retry.
 */
async function postToLinkedIn(
  token: string,
  authorUrn: string,
  commentary: string,
  content?: Record<string, unknown>,
): Promise<string | null> {
  const res = await httpRequest('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'linkedin-version': LINKEDIN_API_VERSION,
      'x-restli-protocol-version': '2.0.0',
    },
    body: JSON.stringify({
      author: authorUrn,
      commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      // Omitted entirely for a text-only post — LinkedIn rejects an empty
      // content object rather than treating it as "no media".
      ...(content ? { content } : {}),
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
    timeoutMs: 12_000,
    retries: 0,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error('LinkedIn publish failed', { status: res.status, detail: detail.slice(0, 300) });
    throw Object.assign(
      new Error(`LinkedIn publish failed (${res.status}).`),
      { status: 502 },
    );
  }
  const urn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
  return urn ? `https://www.linkedin.com/feed/update/${urn}` : null;
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

/**
 * Publish to a Facebook Page.
 *
 * The shape differs from Instagram in the one way that matters: a Page post
 * with no image is a normal post, not an error, so there is no media guard
 * here. When a graphic IS attached it publishes as a photo post, and a
 * carousel publishes as its first image — the same reduction Instagram makes.
 */
async function publishToFacebook(args: {
  companyId: string;
  userId: string | null;
  draftId: string;
  draft: ContentDraft;
  media: ResolvedMedia[];
}): Promise<PublishResult> {
  const { companyId, userId, draftId, draft, media } = args;
  const message = renderForManual(draft);

  const context = await getFacebookContext(companyId);
  if (!context) {
    return {
      mode: 'manual',
      text: message,
      reason:
        'Facebook isn’t connected for this workspace. Connect Meta in Settings → Connectors ' +
        '(it needs a Facebook Page you administer). Until then the post is copied — publish it by hand.',
    };
  }

  const first = media[0];
  const imageUrl = first
    ? signedAssetUrl(first.assetId, INSTAGRAM_ASSET_URL_TTL_MS).url
    : null;

  try {
    const permalink = await publishFacebookPost({
      context,
      // Facebook truncates far later than this, but the same cap keeps a post
      // identical across networks rather than subtly longer on one of them.
      message: message.slice(0, 2200),
      imageUrl,
    });
    return { mode: 'published', url: permalink };
  } catch (err) {
    if (err instanceof FacebookPublishError) {
      logger.error('Facebook publish failed', { draftId, error: err.message });
      return { mode: 'manual', text: message, reason: err.message };
    }
    throw err;
  }
}

async function publishToInstagram(args: {
  companyId: string;
  userId: string | null;
  draftId: string;
  draft: ContentDraft;
  media: ResolvedMedia[];
}): Promise<PublishResult> {
  const { companyId, userId, draftId, draft, media } = args;
  const caption = renderForManual(draft);

  // Instagram has no text-only feed post. This is a product-level fact, not an
  // API error, so it is caught before any call is made.
  if (media.length === 0) {
    return {
      mode: 'manual',
      text: caption,
      reason:
        'Instagram posts must have an image or a video. Generate a graphic in Content Studio (or add a video) and attach it, then publish.',
    };
  }

  const context = await getInstagramContext(companyId);
  if (!context) {
    return {
      mode: 'manual',
      text: caption,
      reason:
        'Instagram isn’t connected for this workspace. Connect Meta in Settings → Connectors ' +
        '(it needs an Instagram Business account linked to a Facebook Page). Until then the ' +
        'caption is copied — post it with the downloaded graphic by hand.',
    };
  }

  // Meta fetches the media itself, so it needs URLs it can reach: a signed,
  // short-lived link for an image (server/media/asset-url.ts); the bucket URL
  // for a video (too large to serve through a function).
  // One image → a feed post; one video → a Reel; 2–10 items → a carousel.
  const items: InstagramItem[] = [];
  for (const m of media) {
    if (m.kind === 'VIDEO') {
      if (!m.storageUrl) {
        return { mode: 'manual', text: caption, reason: 'The video’s stored file is missing. Add the video again, then publish.' };
      }
      items.push({ kind: 'VIDEO', url: m.storageUrl });
    } else {
      // Instagram takes JPEG only: a PNG/WebP is served re-encoded (the
      // stored image is unchanged).
      items.push({
        kind: 'IMAGE',
        url: signedAssetUrl(m.assetId, INSTAGRAM_ASSET_URL_TTL_MS, m.mimeType === 'image/jpeg' ? {} : { format: 'jpeg' }).url,
      });
    }
  }

  try {
    const outcome = await startInstagramPost({
      context,
      items,
      // Instagram captions cap at 2,200 characters.
      caption: caption.slice(0, 2200),
    });
    if (outcome.state === 'processing') {
      return { mode: 'processing', externalId: outcome.externalId, message: PROCESSING_MESSAGE };
    }
    return { mode: 'published', url: outcome.url };
  } catch (err) {
    if (err instanceof InstagramPublishError) {
      logger.error('Instagram publish failed', { draftId, error: err.message });
      return { mode: 'manual', text: caption, reason: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Scheduled publishing
// ---------------------------------------------------------------------------

/**
 * Scheduled-publish job. Processes APPROVED drafts whose `scheduledFor` is due.
 * Idempotent: a successful publish flips status to PUBLISHED so it's never
 * picked again; drafts that can't auto-publish (wrong type / pending platform
 * approval / missing media) are counted as skipped and left as calendar markers.
 */
export async function runScheduledPublishes(now: Date = new Date()): Promise<{
  attempted: number;
  published: number;
  skipped: number;
}> {
  const due = await db.contentDraft.findMany({
    where: {
      status: 'APPROVED',
      scheduledFor: { lte: now },
      publishedAt: null,
    },
    select: { id: true, companyId: true },
    take: 200,
  });

  let published = 0;
  let skipped = 0;
  for (const d of due) {
    try {
      const result = await publishDraft({
        companyId: d.companyId,
        userId: null, // system-triggered; audit userId null
        draftId: d.id,
        // A failed or manual attempt waits for a person: the scheduler never
        // retries it (it used to, every day, for ever).
        automatic: true,
      });
      if (result.mode === 'published') published++;
      else skipped++;
    } catch (err) {
      skipped++;
      logger.error('scheduled publish failed', {
        draftId: d.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { attempted: due.length, published, skipped };
}
