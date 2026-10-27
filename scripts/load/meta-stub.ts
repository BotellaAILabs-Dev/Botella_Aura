/**
 * A stand-in for Meta's Graph API: WhatsApp Cloud API, Facebook Pages and
 * Instagram. The app is pointed at it with WHATSAPP_GRAPH_BASE_URL and
 * META_GRAPH_BASE_URL, both of which only accept a loopback address
 * (lib/graph-base.ts) so no token can reach another host by mistake.
 *
 * Two jobs:
 *
 *   Load tests (scripts/load/whatsapp-load.ts) — thousands of test replies
 *   must not go to Meta, and STUB_ERROR_RATE of sends return Meta's
 *   throughput error so the retry path is exercised.
 *
 *   The sandbox (`npm run sandbox`) — Facebook and Instagram publishing has
 *   no other way to be exercised at all: it needs a Meta app, an approved
 *   Page, a linked professional account and a token that expires. Everything
 *   on Aura's side of that boundary is real here; only Meta is not.
 *
 * WhatsApp
 *   POST /:v/:phoneNumberId/messages    a send or a read receipt, after
 *        80–200 ms; STUB_ERROR_RATE (default 2%) answer 130429
 *
 * Facebook Pages
 *   GET  /:v/me?fields=id               the connected user
 *   GET  /:v/me/accounts                the Pages, with a page token and the
 *        linked Instagram account
 *   GET  /:v/me/permissions             what was granted
 *   POST /:v/oauth/access_token         code exchange, and the long-lived swap
 *   POST /:v/:pageId/feed               a text post      -> { id }
 *   POST /:v/:pageId/photos             a photo post     -> { id, post_id }
 *
 * Instagram
 *   POST /:v/:igUserId/media            a container      -> { id }
 *   POST /:v/:igUserId/media_publish    publish it       -> { id }
 *
 * Both
 *   GET  /:v/:objectId?fields=…         permalink_url / permalink /
 *        status_code (a container is FINISHED once STUB_IG_PROCESSING_MS has
 *        passed, so the real polling path runs), like_count, insights
 *
 * Its own, not Meta's
 *   GET  /stats                         counters
 *   GET  /sent?to=<number>              recent WhatsApp sends to a number
 *   GET  /published                     every Page post and Instagram media
 *   POST /reset                         clear all of it
 *
 * Run: npx tsx scripts/load/meta-stub.ts   (port STUB_PORT, default 4010)
 */
import http from 'node:http';

/** Recent sends, for the verify suites (bounded). */
const sent: { to: string; body: unknown; at: number }[] = [];
const PORT = Number(process.env.STUB_PORT ?? 4010);
const ERROR_RATE = Number(process.env.STUB_ERROR_RATE ?? 0.02);
/**
 * Publishing failures are opt-in and default to none. A load test wants the
 * retry path; someone showing the product a post going out does not.
 */
const META_ERROR_RATE = Number(process.env.STUB_META_ERROR_RATE ?? 0);
/** How long an Instagram container stays IN_PROGRESS, so polling is real. */
const IG_PROCESSING_MS = Number(process.env.STUB_IG_PROCESSING_MS ?? 1200);

const PAGE_ID = process.env.STUB_PAGE_ID ?? '111111111111111';
const PAGE_NAME = process.env.STUB_PAGE_NAME ?? 'Sandbox Page';
const IG_USER_ID = process.env.STUB_IG_USER_ID ?? '222222222222222';
const IG_USERNAME = process.env.STUB_IG_USERNAME ?? 'sandbox.ig';

let stats = {
  sends: 0,
  reads: 0,
  rateLimited: 0,
  unauthorised: 0,
  inFlight: 0,
  maxInFlight: 0,
  byContext: {} as Record<string, number>,
  fbPosts: 0,
  igContainers: 0,
  igPublished: 0,
  tokenExchanges: 0,
};
let seq = 0;

/** What was published, so a check can assert the post rather than the reply. */
interface Published {
  kind: 'facebook' | 'instagram';
  id: string;
  /** The Page or Instagram user it went to. */
  target: string;
  /** The caption or message exactly as the app sent it. */
  message: string | null;
  imageUrl: string | null;
  permalink: string;
  at: number;
}
const published: Published[] = [];
/** Instagram containers awaiting publish, by id. */
const containers = new Map<
  string,
  { igUserId: string; caption: string | null; imageUrl: string | null; createdAt: number; publishedAs?: string }
>();

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const notFound = (res: http.ServerResponse) =>
  json(res, 404, { error: { message: 'Unsupported get request.', code: 100 } });

/** Meta's shape for a refusal, so the app's own classification is exercised. */
const metaError = (
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
) => json(res, status, { error: { message, code, type: 'OAuthException' } });

/** A Graph path with the version stripped, or null if it is not one. */
function graphPath(url: string): string | null {
  const path = url.split('?')[0] ?? '';
  const m = /^\/v\d+\.\d+\/(.*)$/.exec(path);
  return m ? (m[1] ?? '') : null;
}

const params = (url: string) => new URL(url, 'http://stub').searchParams;

/**
 * Meta rejects a Graph call with no token, and so does this — a sandbox that
 * accepts anything would hide the app forgetting to send one.
 */
function hasToken(req: http.IncomingMessage, url: string, body: URLSearchParams): boolean {
  if (req.headers.authorization?.startsWith('Bearer ')) return true;
  return Boolean(params(url).get('access_token') || body.get('access_token'));
}

const permalinkFor = (kind: Published['kind'], id: string) =>
  kind === 'facebook'
    ? `https://www.facebook.com/${id}`
    : `https://www.instagram.com/p/${id}/`;

function handleGraphGet(res: http.ServerResponse, path: string, url: string): void {
  // --- the connected user -------------------------------------------------
  if (path === 'me') return json(res, 200, { id: 'stub-fb-user' });

  if (path === 'me/accounts') {
    return json(res, 200, {
      data: [
        {
          id: PAGE_ID,
          name: PAGE_NAME,
          access_token: 'stub-page-token',
          instagram_business_account: { id: IG_USER_ID, username: IG_USERNAME },
        },
      ],
      paging: {},
    });
  }

  if (path === 'me/permissions') {
    const granted = (
      process.env.STUB_GRANTED_SCOPES ??
      'pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,business_management'
    )
      .split(',')
      .map((p) => ({ permission: p.trim(), status: 'granted' }));
    return json(res, 200, { data: granted });
  }

  // --- one object, by id --------------------------------------------------
  const fields = params(url).get('fields') ?? '';
  const id = path;

  // An Instagram container being polled for readiness.
  const container = containers.get(id);
  if (container && fields.includes('status_code')) {
    const ready = Date.now() - container.createdAt >= IG_PROCESSING_MS;
    return json(res, 200, {
      status_code: ready ? 'FINISHED' : 'IN_PROGRESS',
      status: ready ? 'Finished: ready to publish.' : 'In progress.',
      id,
    });
  }

  const post = published.find((p) => p.id === id);
  if (fields.includes('permalink_url')) {
    return json(res, 200, { permalink_url: post?.permalink ?? permalinkFor('facebook', id), id });
  }
  if (fields.includes('permalink')) {
    return json(res, 200, { permalink: post?.permalink ?? permalinkFor('instagram', id), id });
  }

  // Engagement, so the insights path has something to read.
  if (fields.includes('shares') || fields.includes('reactions')) {
    return json(res, 200, {
      id,
      shares: { count: 2 },
      reactions: { summary: { total_count: 11 } },
    });
  }
  if (fields.includes('like_count')) {
    return json(res, 200, { id, like_count: 9, comments_count: 3 });
  }

  if (path.endsWith('/insights')) {
    const metrics = (params(url).get('metric') ?? '').split(',').filter(Boolean);
    return json(res, 200, {
      data: metrics.map((name, i) => ({
        name,
        period: 'lifetime',
        values: [{ value: 100 + i * 7 }],
      })),
    });
  }

  return json(res, 200, { id });
}

function handleGraphPost(
  res: http.ServerResponse,
  path: string,
  body: URLSearchParams,
): void {
  if (path === 'oauth/access_token') {
    stats.tokenExchanges++;
    return json(res, 200, {
      access_token: `stub-token-${++seq}`,
      token_type: 'bearer',
      // Meta's long-lived user token is about 60 days.
      expires_in: 60 * 24 * 60 * 60,
    });
  }

  if (META_ERROR_RATE > 0 && Math.random() < META_ERROR_RATE) {
    return metaError(res, 500, 1, 'An unknown error occurred (stub).');
  }

  const [target, action] = path.split('/');

  // --- Facebook Page ------------------------------------------------------
  if (action === 'feed' || action === 'photos') {
    const id = `${target}_${++seq}`;
    const message = body.get('message') ?? body.get('caption');
    const imageUrl = body.get('url');
    stats.fbPosts++;
    published.push({
      kind: 'facebook',
      id,
      target: target!,
      message,
      imageUrl,
      permalink: permalinkFor('facebook', id),
      at: Date.now(),
    });
    // A photo post returns the photo id and the story's post_id; a feed post
    // returns only an id. The app prefers post_id, so both are answered as
    // Meta answers them.
    return json(
      res,
      200,
      action === 'photos' ? { id: `photo_${seq}`, post_id: id } : { id },
    );
  }

  // --- Instagram ----------------------------------------------------------
  if (action === 'media') {
    const id = `container_${++seq}`;
    stats.igContainers++;
    containers.set(id, {
      igUserId: target!,
      caption: body.get('caption'),
      imageUrl: body.get('image_url') ?? body.get('video_url'),
      createdAt: Date.now(),
    });
    return json(res, 200, { id });
  }

  if (action === 'media_publish') {
    const creationId = body.get('creation_id') ?? '';
    const container = containers.get(creationId);
    if (!container) {
      return metaError(res, 400, 9007, 'Media ID is not available (stub: no such container).');
    }
    if (Date.now() - container.createdAt < IG_PROCESSING_MS) {
      return metaError(res, 400, 9007, 'Media is not ready to be published (stub).');
    }
    if (container.publishedAs) {
      // Publishing one container twice is a mistake Meta also refuses.
      return metaError(res, 400, 9007, 'This container was already published (stub).');
    }
    const id = `ig_media_${++seq}`;
    container.publishedAs = id;
    stats.igPublished++;
    published.push({
      kind: 'instagram',
      id,
      target: container.igUserId,
      message: container.caption,
      imageUrl: container.imageUrl,
      permalink: permalinkFor('instagram', id),
      at: Date.now(),
    });
    return json(res, 200, { id });
  }

  return notFound(res);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';

  // --- the stub's own endpoints ------------------------------------------
  if (req.method === 'GET' && url === '/stats') {
    const dupes = Object.values(stats.byContext).filter((n) => n > 1).length;
    return json(res, 200, {
      ...stats,
      byContext: undefined,
      threadedReplies: Object.keys(stats.byContext).length,
      inboundAnsweredMoreThanOnce: dupes,
      published: published.length,
    });
  }
  if (req.method === 'GET' && url.startsWith('/sent')) {
    const to = params(url).get('to')?.replace(/\D/g, '') ?? '';
    return json(res, 200, { messages: sent.filter((m) => m.to === to).slice(-20) });
  }
  if (req.method === 'GET' && url.startsWith('/published')) {
    const kind = params(url).get('kind');
    return json(res, 200, {
      posts: published.filter((p) => !kind || p.kind === kind).slice(-50),
    });
  }
  if (req.method === 'POST' && url === '/reset') {
    stats = {
      sends: 0, reads: 0, rateLimited: 0, unauthorised: 0, inFlight: 0,
      maxInFlight: 0, byContext: {}, fbPosts: 0, igContainers: 0,
      igPublished: 0, tokenExchanges: 0,
    };
    sent.length = 0;
    published.length = 0;
    containers.clear();
    return json(res, 200, { ok: true });
  }

  const path = graphPath(url);
  if (path === null) return notFound(res);

  // --- WhatsApp: unchanged, and timed as the Cloud API is ----------------
  const isWhatsAppSend = req.method === 'POST' && /^[^/]+\/messages$/.test(path);

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const form = new URLSearchParams(
      req.headers['content-type']?.includes('x-www-form-urlencoded') ? raw : '',
    );

    if (!hasToken(req, url, form)) {
      stats.unauthorised++;
      return metaError(res, 401, 190, 'Invalid OAuth access token');
    }

    if (isWhatsAppSend) {
      const body = JSON.parse(raw || '{}') as {
        status?: string;
        to?: string;
        context?: { message_id?: string };
      };
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      setTimeout(
        () => {
          stats.inFlight--;
          if (body.status === 'read') {
            stats.reads++;
            return json(res, 200, { success: true });
          }
          if (Math.random() < ERROR_RATE) {
            stats.rateLimited++;
            return json(res, 400, { error: { code: 130429, message: '(#130429) Rate limit hit' } });
          }
          stats.sends++;
          if (body.to) {
            sent.push({ to: String(body.to).replace(/\D/g, ''), body, at: Date.now() });
            if (sent.length > 500) sent.shift();
          }
          const ctx = body.context?.message_id;
          if (ctx) stats.byContext[ctx] = (stats.byContext[ctx] ?? 0) + 1;
          json(res, 200, {
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: 'x' }],
            messages: [{ id: `wamid.STUB${++seq}` }],
          });
        },
        80 + Math.random() * 120,
      );
      return;
    }

    if (req.method === 'GET') return handleGraphGet(res, path, url);
    if (req.method === 'POST') return handleGraphPost(res, path, form);
    return notFound(res);
  });
});

server.listen(PORT, () =>
  console.log(
    `meta-stub listening on ${PORT} — WhatsApp, Facebook Pages, Instagram ` +
      `(whatsapp error rate ${ERROR_RATE}, publish error rate ${META_ERROR_RATE})`,
  ),
);
