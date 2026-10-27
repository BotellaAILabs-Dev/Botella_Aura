import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import { isCredentialRejection } from '@/lib/connection-errors';
import { resolveCredential } from '@/server/connectors/connection.service';
import { graphUrl } from '@/lib/meta';

/**
 * Instagram publishing, via the official Instagram Graph API.
 *
 * >>> WHAT THIS NEEDS, STATED PLAINLY <<<
 * Instagram has no self-serve posting API. Publishing requires ALL of:
 *   - a Meta app with META_CLIENT_ID / META_CLIENT_SECRET set on the deployment,
 *   - an Instagram account converted to Business or Creator,
 *   - that account linked to a Facebook Page,
 *   - the app approved for `instagram_content_publish` (App Review).
 *
 * Until those exist, `getInstagramContext()` returns null and the publisher
 * routes to the manual/extension fallback with an explanation — the same
 * honesty rule the LinkedIn publisher already follows. Nothing here fakes a
 * published state.
 *
 * >>> WHY IMAGES ARE PUBLISHED BY URL <<<
 * Meta's servers fetch the image themselves; you cannot upload bytes. That is
 * why server/media/asset-url.ts exists: it mints a signed, short-lived public
 * URL for exactly this fetch, so private assets stay private the rest of the
 * time.
 *
 * Publishing is two calls: create a media container, then publish it. The
 * container can still be processing when the first call returns, so the status
 * poll between them is required, not defensive.
 *
 * >>> CAROUSELS AND REELS <<<
 * A carousel is 2–10 item containers (`is_carousel_item`, images and/or
 * videos), then a CAROUSEL container naming them as `children`, then publish.
 * A Reel is one container with `media_type=REELS` and a `video_url`.
 * Video takes Instagram minutes to process — longer than a request may run —
 * so `startInstagramPost` waits briefly and otherwise answers "processing"
 * with the container ids; `continueInstagramPost` (the publish sweep) picks
 * it up later. A container not published within 24 hours expires.
 */
const CONTAINER_TIMEOUT_MS = 60_000;
const CONTAINER_POLL_MS = 2000;

export class InstagramPublishError extends Error {
  readonly status = 502;
  /** The provider refused the stored credential (Meta 190 / HTTP 401): reconnect. */
  constructor(
    message: string,
    readonly credentialRejected = false,
  ) {
    super(message);
    this.name = 'InstagramPublishError';
  }
}

export interface InstagramContext {
  accessToken: string;
  /** The IG Business account id posts are created under. */
  igUserId: string;
}

/**
 * Resolve a usable Instagram publishing context for a company, or null.
 *
 * Reuses the existing connector plumbing (`Connection` + `resolveCredential`),
 * so the token is the encrypted one stored when the workspace connected Meta —
 * no second OAuth flow, no second token store. The IG account id is kept in the
 * connection's non-secret `metadata`, written at connect time by the provider's
 * verify().
 */
export async function getInstagramContext(
  companyId: string,
): Promise<InstagramContext | null> {
  const credential = await resolveCredential(companyId, 'meta');
  if (!credential?.accessToken) return null;

  const igUserId = credential.metadata?.igUserId;
  if (typeof igUserId !== 'string' || !igUserId) return null;

  return { accessToken: credential.accessToken, igUserId };
}

/**
 * Publish an image post to Instagram. `imageUrl` must be publicly reachable —
 * pass a signed URL from server/media/asset-url.ts.
 *
 * Returns the permalink when Instagram gives one, otherwise null; the caller
 * treats a null permalink as "published, link unknown" rather than a failure,
 * because the post genuinely did go out.
 */
export async function publishInstagramImage(args: {
  context: InstagramContext;
  imageUrl: string;
  caption: string;
}): Promise<string | null> {
  const { context, imageUrl, caption } = args;

  // --- 1. Create the media container -------------------------------------
  const containerId = await createContainer(context, imageUrl, caption);

  // --- 2. Wait until Instagram has fetched and processed the image --------
  await waitForContainer(context, containerId);

  // --- 3. Publish it -----------------------------------------------------
  const mediaId = await publishContainer(context, containerId);
  return fetchPermalink(context, mediaId);
}

async function createContainer(
  context: InstagramContext,
  imageUrl: string,
  caption: string,
): Promise<string> {
  return createMediaContainer(context, { image_url: imageUrl, caption });
}

/** Create any media container (image, Reel, carousel item, carousel). */
async function createMediaContainer(
  context: InstagramContext,
  params: Record<string, string>,
): Promise<string> {
  const res = await httpRequest(
    graphUrl(`${context.igUserId}/media`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        access_token: context.accessToken,
      }).toString(),
      timeoutMs: 30_000,
      retries: 0,
    },
  );

  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string; code?: number };
  };

  if (!res.ok || !body.id) {
    // Meta error bodies include the access token in `fbtrace` contexts on some
    // error classes, so the raw body is logged and never returned.
    logger.error('instagram: container creation failed', {
      status: res.status,
      code: body.error?.code,
    });
    throw new InstagramPublishError(describeMetaError(res.status, body.error?.code), isCredentialRejection(res.status, body.error?.code));
  }
  return body.id;
}

/**
 * Poll the container until it is FINISHED.
 *
 * The common failure here is ERROR with "media couldn't be fetched", which
 * means Meta could not reach the image URL — a signed URL that expired, or a
 * deployment that is not publicly reachable. That distinction is worth stating
 * to the user, because the fix is completely different in each case.
 */
async function waitForContainer(
  context: InstagramContext,
  containerId: string,
): Promise<void> {
  const deadline = Date.now() + CONTAINER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await httpRequest(
      graphUrl(`${containerId}?fields=status_code,status&access_token=${encodeURIComponent(
        context.accessToken,
      )}`),
      { timeoutMs: 10_000, retries: 1 },
    );
    const body = (await res.json().catch(() => ({}))) as {
      status_code?: string;
      status?: string;
    };

    if (body.status_code === 'FINISHED') return;
    if (body.status_code === 'ERROR' || body.status_code === 'EXPIRED') {
      logger.error('instagram: container did not become publishable', {
        statusCode: body.status_code,
        status: body.status,
      });
      throw new InstagramPublishError(
        'Instagram could not fetch the image. Check that this deployment is reachable from the public internet (APP_URL) and try again.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_MS));
  }

  throw new InstagramPublishError(
    'Instagram is still processing the image. The post was not published — try again in a moment.',
  );
}

async function publishContainer(
  context: InstagramContext,
  containerId: string,
): Promise<string> {
  const res = await httpRequest(
    graphUrl(`${context.igUserId}/media_publish`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        creation_id: containerId,
        access_token: context.accessToken,
      }).toString(),
      timeoutMs: 30_000,
      retries: 0,
    },
  );

  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { code?: number };
  };
  if (!res.ok || !body.id) {
    logger.error('instagram: publish failed', {
      status: res.status,
      code: body.error?.code,
    });
    throw new InstagramPublishError(describeMetaError(res.status, body.error?.code), isCredentialRejection(res.status, body.error?.code));
  }
  return body.id;
}

/** Best-effort permalink lookup — never fails the publish. */
async function fetchPermalink(
  context: InstagramContext,
  mediaId: string,
): Promise<string | null> {
  try {
    const res = await httpRequest(
      graphUrl(`${mediaId}?fields=permalink&access_token=${encodeURIComponent(
        context.accessToken,
      )}`),
      { timeoutMs: 10_000, retries: 1 },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { permalink?: string };
    return body.permalink ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Carousels and Reels
// ---------------------------------------------------------------------------

export interface InstagramItem {
  kind: 'IMAGE' | 'VIDEO';
  /** Publicly fetchable: a signed asset URL (images) or the bucket URL (videos). */
  url: string;
}

export type InstagramOutcome =
  /** `mediaId`: Instagram's id for the post (insights are read with it). */
  | { state: 'published'; url: string | null; mediaId?: string | null }
  /** Accepted, still processing: "container:<id>" or "children:<id>,<id>". */
  | { state: 'processing'; externalId: string };

type ContainerStatus = 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

async function containerStatus(
  context: InstagramContext,
  id: string,
): Promise<{ code: ContainerStatus; detail: string | null }> {
  const res = await httpRequest(
    graphUrl(`${id}?fields=status_code,status&access_token=${encodeURIComponent(
      context.accessToken,
    )}`),
    { timeoutMs: 10_000, retries: 1 },
  );
  const body = (await res.json().catch(() => ({}))) as {
    status_code?: string;
    status?: string;
    error?: { code?: number };
  };
  if (!res.ok) throw new InstagramPublishError(describeMetaError(res.status, body.error?.code), isCredentialRejection(res.status, body.error?.code));
  return { code: (body.status_code ?? 'IN_PROGRESS') as ContainerStatus, detail: body.status ?? null };
}

function failedContainer(kind: 'video' | 'item', code: ContainerStatus, detail: string | null): InstagramPublishError {
  logger.error('instagram: container failed', { code, detail });
  if (code === 'EXPIRED') {
    return new InstagramPublishError(
      'Instagram’s upload expired (it was not published within 24 hours). Publish again.',
    );
  }
  return new InstagramPublishError(
    kind === 'video'
      ? 'Instagram could not process the video. Check it is a standard MP4 (H.264, 3 s – 15 min) and that file storage is publicly reachable, then try again.'
      : 'Instagram could not fetch or accept the image. Check that this deployment is reachable from the public internet, then try again.',
  );
}

/** Wait until every container is FINISHED, or the budget runs out. Throws on ERROR/EXPIRED. */
async function waitAll(
  context: InstagramContext,
  ids: string[],
  waitMs: number,
  kind: 'video' | 'item',
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  let pending = [...ids];
  for (;;) {
    const statuses = await Promise.all(
      pending.map((id) => containerStatus(context, id).then((st) => ({ id, ...st }))),
    );
    for (const st of statuses) {
      if (st.code === 'ERROR' || st.code === 'EXPIRED') throw failedContainer(kind, st.code, st.detail);
    }
    pending = statuses.filter((st) => st.code !== 'FINISHED' && st.code !== 'PUBLISHED').map((st) => st.id);
    if (!pending.length) return true;
    if (Date.now() + CONTAINER_POLL_MS > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_MS));
  }
}

async function publishFinished(context: InstagramContext, containerId: string): Promise<InstagramOutcome> {
  const mediaId = await publishContainer(context, containerId);
  return { state: 'published', url: await fetchPermalink(context, mediaId), mediaId };
}

/** From finished children: the carousel container, then (if ready) publish. */
async function carouselFrom(
  context: InstagramContext,
  children: string[],
  caption: string,
  waitMs: number,
): Promise<InstagramOutcome> {
  const carousel = await createMediaContainer(context, {
    media_type: 'CAROUSEL',
    children: children.join(','),
    caption,
  });
  if (!(await waitAll(context, [carousel], waitMs, 'item'))) {
    return { state: 'processing', externalId: `container:${carousel}` };
  }
  return publishFinished(context, carousel);
}

/**
 * Publish a post of any shape: one image (feed post), one video (Reel), or
 * 2–10 items (carousel). Waits up to `waitMs` for Instagram's processing;
 * returns "processing" rather than holding the request longer.
 */
export async function startInstagramPost(args: {
  context: InstagramContext;
  items: InstagramItem[];
  caption: string;
  waitMs?: number;
}): Promise<InstagramOutcome> {
  const { context, items, caption } = args;
  const waitMs = args.waitMs ?? 30_000;
  if (items.length === 0) throw new InstagramPublishError('Instagram posts need an image or a video.');
  if (items.length > 10) throw new InstagramPublishError('Instagram carousels take up to 10 items.');

  if (items.length === 1 && items[0]!.kind === 'IMAGE') {
    // Waits no longer than the budget (the request is capped at 60 s); a slow
    // fetch by Meta becomes "processing", finished later, not a killed request.
    const image = await createMediaContainer(context, { image_url: items[0]!.url, caption });
    if (!(await waitAll(context, [image], waitMs, 'item'))) return { state: 'processing', externalId: `container:${image}` };
    return publishFinished(context, image);
  }
  if (items.length === 1) {
    // A Reel. share_to_feed: shown on the profile grid as well as in Reels.
    const reel = await createMediaContainer(context, {
      media_type: 'REELS',
      video_url: items[0]!.url,
      caption,
      share_to_feed: 'true',
    });
    if (!(await waitAll(context, [reel], waitMs, 'video'))) {
      return { state: 'processing', externalId: `container:${reel}` };
    }
    return publishFinished(context, reel);
  }

  // A carousel: one container per item (in order), then the carousel.
  const children: string[] = [];
  for (const item of items) {
    children.push(
      await createMediaContainer(
        context,
        item.kind === 'VIDEO'
          ? { media_type: 'VIDEO', video_url: item.url, is_carousel_item: 'true' }
          : { image_url: item.url, is_carousel_item: 'true' },
      ),
    );
  }
  const hasVideo = items.some((i) => i.kind === 'VIDEO');
  if (!(await waitAll(context, children, waitMs, hasVideo ? 'video' : 'item'))) {
    return { state: 'processing', externalId: `children:${children.join(',')}` };
  }
  return carouselFrom(context, children, caption, waitMs);
}

/**
 * Carry on with a post Instagram was still processing (from the publish
 * sweep). One status check, no long waits: still processing → the same (or
 * the next stage's) id comes back.
 */
export async function continueInstagramPost(args: {
  context: InstagramContext;
  externalId: string;
  caption: string;
}): Promise<InstagramOutcome> {
  const { context, externalId, caption } = args;
  const colon = externalId.indexOf(':');
  const stage = externalId.slice(0, colon);
  const ids = externalId
    .slice(colon + 1)
    .split(',')
    .filter((id) => /^\d+$/.test(id));
  if (colon < 0 || !ids.length || (stage !== 'container' && stage !== 'children')) {
    throw new InstagramPublishError('The pending Instagram upload could not be found. Publish again.');
  }
  if (stage === 'children') {
    if (!(await waitAll(context, ids, 0, 'video'))) return { state: 'processing', externalId };
    return carouselFrom(context, ids, caption, 0);
  }
  const { code, detail } = await containerStatus(context, ids[0]!);
  if (code === 'ERROR' || code === 'EXPIRED') throw failedContainer('video', code, detail);
  // Published by an attempt that could not record it: the post is live.
  if (code === 'PUBLISHED') return { state: 'published', url: null };
  if (code !== 'FINISHED') return { state: 'processing', externalId };
  return publishFinished(context, ids[0]!);
}

/** Meta error codes worth translating; everything else stays generic. */
function describeMetaError(status: number, code?: number): string {
  if (code === 190 || status === 401) {
    return 'Instagram rejected the stored credentials. Reconnect Meta in Settings → Connections.';
  }
  if (code === 4 || code === 17 || status === 429) {
    return 'Instagram is rate-limiting publishing right now (it allows 25 posts per 24 hours). Try again later.';
  }
  if (code === 200 || status === 403) {
    return 'This Meta app is not permitted to publish to that Instagram account. It needs the instagram_content_publish permission and an approved App Review.';
  }
  return `Instagram could not publish this post (HTTP ${status}).`;
}
