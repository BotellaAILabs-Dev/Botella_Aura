import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import { resolveCredential } from '@/server/connectors/connection.service';

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
 */
const GRAPH_BASE = 'https://graph.facebook.com';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const CONTAINER_TIMEOUT_MS = 60_000;
const CONTAINER_POLL_MS = 2000;

export class InstagramPublishError extends Error {
  readonly status = 502;
  constructor(message: string) {
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
  const res = await httpRequest(
    `${GRAPH_BASE}/${GRAPH_VERSION}/${context.igUserId}/media`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        image_url: imageUrl,
        caption,
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
    throw new InstagramPublishError(describeMetaError(res.status, body.error?.code));
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
      `${GRAPH_BASE}/${GRAPH_VERSION}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(
        context.accessToken,
      )}`,
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
    `${GRAPH_BASE}/${GRAPH_VERSION}/${context.igUserId}/media_publish`,
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
    throw new InstagramPublishError(describeMetaError(res.status, body.error?.code));
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
      `${GRAPH_BASE}/${GRAPH_VERSION}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(
        context.accessToken,
      )}`,
      { timeoutMs: 10_000, retries: 1 },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { permalink?: string };
    return body.permalink ?? null;
  } catch {
    return null;
  }
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
