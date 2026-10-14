import crypto from 'node:crypto';

/**
 * Meta (Facebook Pages + Instagram) — the pure rules shared by the connector,
 * the publishers and Meta's callbacks. No network, no database.
 *
 * LOGIN MODEL: "Instagram API with Facebook Login". One Facebook Login grants
 * both the Facebook Page and the Instagram professional account linked to it,
 * which is what Aura publishes to. The alternative ("Instagram API with
 * Instagram Login", instagram_business_* scopes) cannot post to Facebook
 * Pages, so it would mean a second login and a second permission model for
 * the same Page — and mixing the two is exactly what Meta warns against.
 * Consequence, stated to users: Instagram must be a Business or Creator
 * account linked to the Facebook Page; personal accounts cannot be linked to
 * a Page and so are never offered.
 */

/** Graph API version — one place. Meta retires each version about two years after release. */
export const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || 'v23.0';
export const GRAPH_BASE = 'https://graph.facebook.com';
export const graphUrl = (path: string) => `${GRAPH_BASE}/${META_GRAPH_VERSION}/${path.replace(/^\//, '')}`;

/**
 * The permissions requested — the minimum for what Aura does, each one
 * justified in docs/META-INTEGRATION.md for App Review.
 */
export const META_SCOPES = [
  // List the Pages the person manages, to choose one.
  'pages_show_list',
  // Read the Page (and, for Instagram publishing, Meta requires it too).
  'pages_read_engagement',
  // Publish posts and photos to the chosen Facebook Page.
  'pages_manage_posts',
  // Read the Instagram professional account linked to the Page.
  'instagram_basic',
  // Publish to that Instagram account.
  'instagram_content_publish',
  // Pages owned through a Business Portfolio only appear with this.
  'business_management',
] as const;

/** A Page the person administers, as stored on the connection (no tokens). */
export interface MetaPage {
  id: string;
  name: string;
  /** The linked Instagram professional account, if any. */
  ig: { id: string; username: string | null } | null;
}

/** Normalise /me/accounts into what is stored — ids and names only. */
export function pagesFrom(data: unknown): MetaPage[] {
  const rows = (data as { data?: unknown[] } | null)?.data ?? [];
  return rows
    .map((r) => r as { id?: unknown; name?: unknown; instagram_business_account?: { id?: unknown; username?: unknown } })
    .filter((r) => typeof r.id === 'string' && r.id)
    .slice(0, 50)
    .map((r) => ({
      id: r.id as string,
      name: typeof r.name === 'string' && r.name ? r.name : 'Facebook Page',
      ig:
        typeof r.instagram_business_account?.id === 'string'
          ? {
              id: r.instagram_business_account.id,
              username: typeof r.instagram_business_account.username === 'string' ? r.instagram_business_account.username : null,
            }
          : null,
    }));
}

/**
 * Which Page to use: the one chosen before, if still available; otherwise a
 * Page with Instagram linked (it covers both networks); otherwise the first.
 */
export function choosePage(pages: MetaPage[], previousPageId?: string | null): MetaPage | null {
  return (previousPageId && pages.find((p) => p.id === previousPageId)) || pages.find((p) => p.ig) || pages[0] || null;
}

/** Non-secret connection metadata for a chosen Page. */
export function pageMetadata(page: MetaPage, pages: MetaPage[], fbUserId: string | null) {
  return {
    pageId: page.id,
    pageName: page.name,
    ...(page.ig ? { igUserId: page.ig.id, ...(page.ig.username ? { igUsername: page.ig.username } : {}) } : {}),
    pages,
    ...(fbUserId ? { fbUserId } : {}),
  };
}

export function pageLabel(page: MetaPage): string {
  return page.ig?.username ? `@${page.ig.username} (${page.name})` : page.name;
}

/** Long-lived user tokens last about 60 days; warn this far ahead. */
export const RECONNECT_WARNING_MS = 10 * 24 * 60 * 60_000;

export function tokenHealth(expiresAt: Date | null, now: Date = new Date()): 'ok' | 'expiring' | 'expired' {
  if (!expiresAt) return 'ok';
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  return left < RECONNECT_WARNING_MS ? 'expiring' : 'ok';
}

/** How old a signed_request may be (seconds). */
export const SIGNED_REQUEST_MAX_AGE_S = 15 * 60;

/**
 * Meta's `signed_request` (deauthorize and data-deletion callbacks):
 * base64url(HMAC-SHA256(payload, app secret)) "." base64url(JSON payload).
 * Returns the payload only when the signature is ours.
 */
export function parseSignedRequest(
  signed: string | null | undefined,
  appSecret: string,
  now: Date = new Date(),
): { user_id?: string; algorithm?: string; issued_at?: number } | null {
  if (!signed || !appSecret) return null;
  const [sig, payload] = signed.split('.');
  if (!sig || !payload) return null;
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { user_id?: string; algorithm?: string; issued_at?: number };
    if (data.algorithm && data.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
    // A replayed old request is refused (Meta sends it at once).
    if (typeof data.issued_at !== 'number' || Math.abs(now.getTime() / 1000 - data.issued_at) > SIGNED_REQUEST_MAX_AGE_S) return null;
    return data;
  } catch {
    return null;
  }
}

/** For tests and tooling: sign a payload the way Meta does. */
export function signRequest(payload: Record<string, unknown>, appSecret: string): string {
  // Meta always includes issued_at (seconds); parseSignedRequest requires it.
  const body = Buffer.from(JSON.stringify({ issued_at: Math.floor(Date.now() / 1000), ...payload })).toString('base64url');
  const sig = crypto.createHmac('sha256', appSecret).update(body).digest('base64url');
  return `${sig}.${body}`;
}
