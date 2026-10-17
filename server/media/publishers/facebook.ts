import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import { isCredentialRejection } from '@/lib/connection-errors';
import { resolveCredential } from '@/server/connectors/connection.service';
import { META_GRAPH_VERSION } from '@/lib/meta';

/**
 * Facebook Page publishing, via the official Graph API.
 *
 * >>> WHAT THIS NEEDS, STATED PLAINLY <<<
 * Posting to a Page requires ALL of:
 *   - a Meta app with META_CLIENT_ID / META_CLIENT_SECRET on the deployment,
 *   - a Facebook Page the connecting user administers,
 *   - the app approved for `pages_manage_posts` (App Review).
 *
 * Until those exist, `getFacebookContext()` returns null and the caller routes
 * to the manual fallback with an explanation. Nothing here fakes a published
 * state — the same rule the LinkedIn and Instagram publishers follow.
 *
 * >>> WHY THIS IS SHORTER THAN THE INSTAGRAM PUBLISHER <<<
 * Instagram has no direct post endpoint: you create a media container, poll
 * until Meta has fetched the image, then publish the container. A Page photo
 * is one call that both uploads and publishes, so there is no container and
 * nothing to poll. Text-only posts go to /feed instead, which Instagram has no
 * equivalent of at all.
 *
 * >>> WHY THE PAGE TOKEN IS FETCHED, NOT STORED <<<
 * Page publishing needs a PAGE access token, which is a different secret from
 * the user token the connector stored at OAuth time. Rather than add a second
 * encrypted column and a second thing that can silently go stale, the page
 * token is exchanged on demand from /me/accounts using the stored user token.
 * That costs one extra request per publish and means a rotated page token
 * repairs itself, instead of failing until someone reconnects.
 */
// One Graph API version for every Meta call (lib/meta.ts).
const GRAPH_VERSION = META_GRAPH_VERSION;

export class FacebookPublishError extends Error {
  readonly status = 502;
  /** The provider refused the stored credential (Meta 190 / HTTP 401): reconnect. */
  constructor(
    message: string,
    readonly credentialRejected = false,
  ) {
    super(message);
    this.name = 'FacebookPublishError';
  }
}

export interface FacebookContext {
  /** Short-lived token scoped to the Page, not the user. */
  pageAccessToken: string;
  pageId: string;
  pageName: string | null;
}

interface AccountsPage {
  id?: string;
  name?: string;
  access_token?: string;
}

/**
 * Resolve a usable Facebook Page publishing context for a company, or null.
 *
 * Reuses the existing `meta` connection — Facebook and Instagram are the same
 * Meta app and the same OAuth grant, so connecting once covers both. When the
 * connection recorded which Page was chosen, that Page is used; otherwise the
 * first Page the token can post as, which is the only Page for the ordinary
 * single-Page account.
 */
export async function getFacebookContext(
  companyId: string,
): Promise<FacebookContext | null> {
  const credential = await resolveCredential(companyId, 'meta');
  if (!credential?.accessToken) return null;

  const preferredPageId =
    typeof credential.metadata?.pageId === 'string'
      ? credential.metadata.pageId
      : null;

  let pages: AccountsPage[];
  try {
    const res = await httpRequest(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(
        credential.accessToken,
      )}`,
      { method: 'GET', timeoutMs: 20_000, retries: 1 },
    );
    if (!res.ok) {
      logger.error('facebook: could not list pages', { status: res.status });
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: AccountsPage[];
    };
    pages = body.data ?? [];
  } catch (err) {
    logger.error('facebook: /me/accounts failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // The Page the workspace chose — and only that one. If it is no longer
  // available (the person lost admin rights, the Page was removed), nothing is
  // published: it used to fall back to the first other Page and post there.
  const page = preferredPageId
    ? pages.find((p) => p.id === preferredPageId)
    : pages.find((p) => p.id && p.access_token);
  if (preferredPageId && !page) {
    logger.warn('facebook: the chosen Page is no longer available to this connection', { pageId: preferredPageId });
  }

  if (!page?.id || !page.access_token) return null;

  return {
    pageAccessToken: page.access_token,
    pageId: page.id,
    pageName: page.name ?? null,
  };
}

/**
 * Publish to a Facebook Page. `imageUrl` must be publicly reachable — pass a
 * signed URL from server/media/asset-url.ts — and may be omitted, because
 * unlike Instagram a Page post is perfectly valid with no image.
 *
 * Returns the permalink when Facebook gives one, otherwise null; a null
 * permalink means "published, link unknown", not a failure.
 */
export async function publishFacebookPost(args: {
  context: FacebookContext;
  message: string;
  imageUrl?: string | null;
}): Promise<string | null> {
  const { context, message, imageUrl } = args;

  // /photos both uploads and publishes; /feed is the text-only equivalent.
  const endpoint = imageUrl ? 'photos' : 'feed';
  const params = new URLSearchParams({
    access_token: context.pageAccessToken,
    ...(imageUrl ? { url: imageUrl, caption: message } : { message }),
  });

  const res = await httpRequest(
    `https://graph.facebook.com/${GRAPH_VERSION}/${context.pageId}/${endpoint}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      timeoutMs: 60_000,
      retries: 0,
    },
  );

  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    post_id?: string;
    error?: { message?: string; code?: number };
  };

  if (!res.ok) {
    logger.error('facebook publish failed', {
      status: res.status,
      code: body.error?.code,
    });
    throw new FacebookPublishError(describeMetaError(res.status, body.error?.code), isCredentialRejection(res.status, body.error?.code));
  }

  // A photo post returns both the photo id and the story's post_id; the story
  // is the thing a human can open, so prefer it.
  const postId = body.post_id ?? body.id;
  if (!postId) return null;

  return fetchPermalink(context, postId);
}

async function fetchPermalink(
  context: FacebookContext,
  postId: string,
): Promise<string | null> {
  try {
    const res = await httpRequest(
      `https://graph.facebook.com/${GRAPH_VERSION}/${postId}?fields=permalink_url&access_token=${encodeURIComponent(
        context.pageAccessToken,
      )}`,
      { method: 'GET', timeoutMs: 15_000, retries: 1 },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      permalink_url?: string;
    };
    if (!body.permalink_url) return null;
    // Graph returns a site-relative path for some post types.
    return body.permalink_url.startsWith('http')
      ? body.permalink_url
      : `https://www.facebook.com${body.permalink_url}`;
  } catch {
    // The post is already live; not knowing its URL is not a publish failure.
    return null;
  }
}

function describeMetaError(status: number, code?: number): string {
  if (code === 190 || status === 401) {
    return 'Facebook rejected the stored credentials. Reconnect Meta in Settings → Connections.';
  }
  if (code === 4 || code === 17 || status === 429) {
    return 'Facebook is rate-limiting publishing right now. Try again later.';
  }
  if (code === 200 || code === 10 || status === 403) {
    return 'This Meta app is not permitted to post to that Page. It needs the pages_manage_posts permission and an approved App Review.';
  }
  return `Facebook could not publish this post (HTTP ${status}).`;
}
