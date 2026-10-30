import { normaliseSiteUrl, safeFetch } from '@/server/websites/safe-fetch';
import {
  networkError,
  readJson,
  WebsitePublishError,
  type Checkpoint,
  type Choice,
  type PublishPayload,
  type RemoteState,
  type SeoReport,
  type SiteContext,
  type WebsiteAdapter,
} from '@/server/websites/types';

/**
 * WordPress, through the core REST API (/wp/v2) with an Application Password
 * — WordPress's own mechanism for API access (5.6+): a revocable, per-app
 * password, separate from the person's login. Sent as HTTP Basic over https.
 *
 * Two URL styles exist: /wp-json/... (pretty permalinks) and
 * /?rest_route=/... (plain permalinks). Which one works is found when
 * connecting and stored, so every later call uses it.
 *
 * SEO: core WordPress has a slug, an excerpt and image alt text. Yoast SEO
 * and Rank Math hold the rest in post meta, which the REST API only accepts
 * when the plugin (or a snippet) exposes those keys. Aura sends them when the
 * plugin is detected, then reads the post back and reports which the site
 * actually kept — never assumes.
 */

type RestStyle = 'pretty' | 'plain';

const YOAST_META = {
  seoTitle: '_yoast_wpseo_title',
  metaDescription: '_yoast_wpseo_metadesc',
  focusKeyword: '_yoast_wpseo_focuskw',
  canonicalUrl: '_yoast_wpseo_canonical',
  ogImage: '_yoast_wpseo_opengraph-image',
} as const;

const RANKMATH_META = {
  seoTitle: 'rank_math_title',
  metaDescription: 'rank_math_description',
  focusKeyword: 'rank_math_focus_keyword',
  canonicalUrl: 'rank_math_canonical_url',
  ogImage: 'rank_math_facebook_image',
} as const;

type SeoKey = keyof typeof YOAST_META;

function host(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

export function endpoint(siteUrl: string, style: RestStyle, route: string, params: Record<string, string | number> = {}): string {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  if (style === 'plain') {
    const qs = query.toString();
    return `${siteUrl}/?rest_route=${encodeURIComponent(route).replace(/%2F/g, '/')}${qs ? `&${qs}` : ''}`;
  }
  const qs = query.toString();
  return `${siteUrl}/wp-json${route}${qs ? `?${qs}` : ''}`;
}

function basicAuth(username: string, appPassword: string): string {
  // WordPress shows Application Passwords in groups of four; it accepts them with or without spaces.
  return `Basic ${Buffer.from(`${username}:${appPassword.replace(/\s+/g, '')}`).toString('base64')}`;
}

interface WpError {
  code?: string;
  message?: string;
  data?: { status?: number; params?: Record<string, string> };
}

/** A WordPress error response, in words the person can act on. */
export function wpError(status: number, body: unknown, site: string): WebsitePublishError {
  const e = (body ?? {}) as WpError;
  const detail = (e.message ?? '').replace(/<[^>]+>/g, '').trim();
  if (status === 401 || e.code === 'rest_not_logged_in' || e.code === 'invalid_username' || e.code === 'incorrect_password') {
    return new WebsitePublishError(
      'auth',
      e.code === 'rest_not_logged_in'
        ? `${site} did not receive Aura’s credentials. Some hosts strip the Authorization header — ask your host to allow it, or check that a security plugin isn’t blocking Application Passwords.`
        : `${site} rejected the username or Application Password${detail ? ` (${detail})` : ''}. The password may have been revoked — create a new one and reconnect.`,
      status,
    );
  }
  if (status === 403) {
    return new WebsitePublishError(
      'permission',
      `${site} refused: ${detail || 'this user is not allowed to do that'}. The WordPress user needs the Author role or higher (Editor to create categories).`,
      status,
    );
  }
  if (status === 404) return new WebsitePublishError('not_found', `${site}: ${detail || 'not found'}.`, status);
  if (status === 429) return new WebsitePublishError('rate_limit', `${site} is limiting requests right now (HTTP 429). Retry in a few minutes.`, status);
  if (status >= 500) return new WebsitePublishError('network', `${site} had a server error (HTTP ${status})${detail ? `: ${detail}` : ''}. Retry once the site is back.`, status);
  const params = e.data?.params ? ` ${Object.values(e.data.params).join(' ')}` : '';
  return new WebsitePublishError('validation', `${site} rejected the post: ${detail || `HTTP ${status}`}.${params}`, status);
}

interface Client {
  call: <T = Record<string, unknown>>(method: string, route: string, init?: { params?: Record<string, string | number>; json?: unknown; raw?: { body: Buffer; headers: Record<string, string> } }) => Promise<T>;
}

function client(ctx: SiteContext): Client {
  const style = (ctx.capabilities.restStyle as RestStyle) ?? 'pretty';
  const auth = basicAuth(ctx.credentials.username ?? '', ctx.credentials.appPassword ?? '');
  const site = host(ctx.siteUrl);
  return {
    async call(method, route, init = {}) {
      const headers: Record<string, string> = { authorization: auth, accept: 'application/json' };
      let body: string | Buffer | undefined;
      if (init.raw) {
        Object.assign(headers, init.raw.headers);
        body = init.raw.body;
      } else if (init.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.json);
      }
      let res: Response;
      try {
        res = await safeFetch(endpoint(ctx.siteUrl, style, route, init.params), { method, headers, body, timeoutMs: init.raw ? 60_000 : 20_000 });
      } catch (err) {
        throw networkError(site, err);
      }
      const { data, text } = await readJson(res);
      if (!res.ok) throw wpError(res.status, data, site);
      if (data === null) {
        throw new WebsitePublishError('network', `${site} answered with something other than the WordPress API (${text.slice(0, 80).replace(/\s+/g, ' ')}…). A caching or security plugin may be intercepting /wp-json.`);
      }
      return data as never;
    },
  };
}

/** Find the REST API: /wp-json first, then ?rest_route= (plain permalinks). */
async function discover(siteUrl: string): Promise<{ style: RestStyle; namespaces: string[]; name: string }> {
  const site = host(siteUrl);
  for (const style of ['pretty', 'plain'] as RestStyle[]) {
    let res: Response;
    try {
      res = await safeFetch(endpoint(siteUrl, style, '/'), { headers: { accept: 'application/json' }, timeoutMs: 15_000 });
    } catch (err) {
      throw networkError(site, err);
    }
    if (!res.ok) continue;
    const { data } = await readJson(res);
    const root = data as { namespaces?: string[]; name?: string } | null;
    if (root && Array.isArray(root.namespaces) && root.namespaces.includes('wp/v2')) {
      return { style, namespaces: root.namespaces, name: root.name ?? site };
    }
  }
  throw new WebsitePublishError(
    'not_found',
    `No WordPress REST API found at ${site}. Check the address (include a subdirectory like /blog if WordPress lives there) and that the REST API isn’t disabled by a plugin.`,
  );
}

function seoPluginFrom(namespaces: string[]): 'yoast' | 'rankmath' | null {
  if (namespaces.some((n) => n.startsWith('yoast/'))) return 'yoast';
  if (namespaces.some((n) => n.startsWith('rankmath/'))) return 'rankmath';
  return null;
}

interface WpUser {
  id: number;
  name?: string;
  slug?: string;
  capabilities?: Record<string, boolean>;
}

async function verifyUser(ctx: SiteContext): Promise<WpUser> {
  const me = await client(ctx).call<WpUser>('GET', '/wp/v2/users/me', { params: { context: 'edit' } });
  const caps = me.capabilities ?? {};
  if (caps.publish_posts === false || (Object.keys(caps).length > 0 && !caps.publish_posts && !caps.edit_posts)) {
    throw new WebsitePublishError(
      'permission',
      `The WordPress user “${me.name ?? me.slug}” can’t publish posts. Use a user with the Author role or higher.`,
    );
  }
  return me;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').trim();
}

async function ensureTerm(c: Client, taxonomy: 'categories' | 'tags', name: string, state: RemoteState): Promise<number | null> {
  const key = `${taxonomy}:${name.toLowerCase()}`;
  state.terms ??= {};
  if (state.terms[key]) return Number(state.terms[key]);
  const found = await c.call<{ id: number; name: string }[]>('GET', `/wp/v2/${taxonomy}`, { params: { search: name, per_page: 100, _fields: 'id,name' } });
  const match = found.find((t) => stripTags(t.name).toLowerCase() === name.toLowerCase());
  let id = match?.id ?? null;
  if (!id) {
    try {
      id = (await c.call<{ id: number }>('POST', `/wp/v2/${taxonomy}`, { json: { name } })).id;
    } catch (err) {
      // WordPress answers "term_exists" with the existing id when two
      // requests race; an Author may not create categories — skip it.
      const e = err as WebsitePublishError;
      if (e.code === 'permission') return null;
      throw err;
    }
  }
  state.terms[key] = String(id);
  return id;
}

function guessFilename(img: { filename: string; mimeType: string }): string {
  const ext = img.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  const base = img.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9-]+/gi, '-').slice(0, 60) || 'image';
  return `${base}.${ext}`;
}

export const wordpressAdapter: WebsiteAdapter = {
  id: 'wordpress',

  async connect(input) {
    const siteUrl = normaliseSiteUrl(input.siteUrl ?? '');
    const username = (input.username ?? '').trim();
    const appPassword = (input.appPassword ?? '').trim();
    if (!username || !appPassword) throw new WebsitePublishError('validation', 'Enter the WordPress username and an Application Password.');
    const found = await discover(siteUrl);
    const capabilities = { restStyle: found.style, seoPlugin: seoPluginFrom(found.namespaces), siteName: found.name };
    const ctx: SiteContext = { siteUrl, credentials: { username, appPassword }, settings: {}, capabilities };
    const me = await verifyUser(ctx);
    return {
      siteUrl,
      authKind: 'app_password',
      accountLabel: `${me.name ?? username} · ${found.name}`,
      credentials: { username, appPassword },
      capabilities,
      settings: { author: String(me.id) },
    };
  },

  async verify(ctx) {
    const found = await discover(ctx.siteUrl);
    const capabilities = { ...ctx.capabilities, restStyle: found.style, seoPlugin: seoPluginFrom(found.namespaces), siteName: found.name };
    const me = await verifyUser({ ...ctx, capabilities });
    return { accountLabel: `${me.name ?? ctx.credentials.username} · ${found.name}`, capabilities };
  },

  async listOptions(ctx) {
    const c = client(ctx);
    const [categories, authors, recent] = await Promise.all([
      c.call<{ id: number; name: string }[]>('GET', '/wp/v2/categories', { params: { per_page: 100, _fields: 'id,name', orderby: 'count', order: 'desc' } }),
      // Listing other users needs list_users; an Author sees only themself.
      c
        .call<WpUser[]>('GET', '/wp/v2/users', { params: { per_page: 100, context: 'edit', capabilities: 'edit_posts', _fields: 'id,name' } })
        .catch(() => c.call<WpUser>('GET', '/wp/v2/users/me', { params: { _fields: 'id,name' } }).then((u) => [u])),
      c.call<{ title: { rendered: string }; link: string }[]>('GET', '/wp/v2/posts', { params: { per_page: 20, status: 'publish', _fields: 'title,link' } }).catch(() => []),
    ]);
    const choice = (x: { id: number; name?: string }): Choice => ({ id: String(x.id), name: stripTags(x.name ?? String(x.id)) });
    return {
      categories: categories.map(choice),
      authors: authors.map(choice),
      recentPosts: recent.map((p) => ({ title: stripTags(p.title.rendered), url: p.link })),
    };
  },

  async findExisting(ctx, marker) {
    const c = client(ctx);
    const since = new Date(marker.since.getTime() - 60_000).toISOString();
    const posts = await c.call<{ id: number; slug: string; title: { raw?: string; rendered: string } }[]>('GET', '/wp/v2/posts', {
      params: { context: 'edit', status: 'publish,future,draft,pending,private', modified_after: since, orderby: 'modified', per_page: 20, _fields: 'id,slug,title' },
    });
    const title = marker.title.trim().toLowerCase();
    // WordPress makes a taken slug unique by appending -2, -3…
    const ours = posts.find(
      (p) => (p.title.raw ?? stripTags(p.title.rendered)).trim().toLowerCase() === title || p.slug === marker.slug || new RegExp(`^${marker.slug}-\\d+$`).test(p.slug),
    );
    return ours ? { externalId: String(ours.id) } : null;
  },

  async publish(ctx, payload, existing, state, checkpoint: Checkpoint) {
    const c = client(ctx);
    const plugin = (ctx.capabilities.seoPlugin as 'yoast' | 'rankmath' | null) ?? null;
    const { options } = payload;
    state.media ??= {};

    // 1. Images, each once (a retry reuses what was uploaded).
    const upload = async (img: NonNullable<PublishPayload['featured']>) => {
      const known = state.media![img.assetId];
      if (known) return known;
      const bytes = await img.bytes();
      if (!bytes) throw new WebsitePublishError('validation', 'An attached image could not be read. Regenerate or re-attach it, then retry.');
      const media = await c.call<{ id: number; source_url: string }>('POST', '/wp/v2/media', {
        raw: {
          body: bytes,
          headers: { 'content-type': img.mimeType, 'content-disposition': `attachment; filename="${guessFilename(img)}"` },
        },
      });
      const saved = { id: String(media.id), url: media.source_url };
      state.media![img.assetId] = saved;
      await checkpoint({ remoteState: state });
      await c.call('POST', `/wp/v2/media/${media.id}`, { json: { alt_text: img.alt } }).catch(() => undefined);
      return saved;
    };
    const featured = payload.featured ? await upload({ ...payload.featured, alt: options.featuredImageAlt || payload.featured.alt }) : null;
    const inline = [];
    for (const img of payload.inline) inline.push({ url: (await upload(img)).url, alt: img.alt });

    // 2. Categories and tags by name (created when missing).
    const categories = (await Promise.all(options.categories.map((n) => ensureTerm(c, 'categories', n, state)))).filter((x): x is number => x !== null);
    const tags = (await Promise.all(options.tags.map((n) => ensureTerm(c, 'tags', n, state)))).filter((x): x is number => x !== null);
    await checkpoint({ remoteState: state });

    // 3. The post.
    const metaKeys = plugin === 'yoast' ? YOAST_META : plugin === 'rankmath' ? RANKMATH_META : null;
    const seoValues: Record<SeoKey, string> = {
      seoTitle: options.seoTitle,
      metaDescription: options.metaDescription,
      focusKeyword: options.focusKeyword,
      canonicalUrl: options.canonicalUrl,
      ogImage: featured?.url ?? '',
    };
    const meta = metaKeys
      ? Object.fromEntries((Object.keys(metaKeys) as SeoKey[]).filter((k) => seoValues[k]).map((k) => [metaKeys[k], seoValues[k]]))
      : null;
    const author = /^\d+$/.test(options.author) ? Number(options.author) : undefined;
    const post: Record<string, unknown> = {
      title: options.title,
      content: payload.html(inline),
      // Core's own summary field; themes and SEO plugins fall back to it.
      excerpt: options.metaDescription,
      slug: options.slug,
      status: payload.mode === 'draft' ? 'draft' : 'publish',
      categories,
      tags,
      featured_media: featured ? Number(featured.id) : 0,
      ...(author ? { author } : {}),
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    };

    type WpPost = { id: number; link: string; status: string; slug: string; meta?: Record<string, unknown> };
    const save = async (body: Record<string, unknown>): Promise<WpPost> => {
      if (existing) {
        try {
          return await c.call<WpPost>('POST', `/wp/v2/posts/${existing.externalId}`, { json: body });
        } catch (err) {
          // Deleted on the site since: publishing again means creating it again.
          if ((err as WebsitePublishError).code !== 'not_found') throw err;
        }
      }
      const created = await c.call<WpPost>('POST', '/wp/v2/posts', { json: body });
      await checkpoint({ externalId: String(created.id) });
      existing = { externalId: String(created.id) };
      return created;
    };

    let saved: WpPost;
    let metaRefused = false;
    try {
      saved = await save(post);
    } catch (err) {
      // A site that validates meta strictly refuses unknown keys: send the
      // post without them rather than fail it.
      const e = err as WebsitePublishError;
      if (!meta || e.code !== 'validation' || !/meta/i.test(e.message)) throw err;
      metaRefused = true;
      const { meta: _m, ...rest } = post;
      saved = await save(rest);
    }

    // 4. What the site actually kept.
    const kept = (k: SeoKey) => Boolean(metaKeys && !metaRefused && saved.meta && saved.meta[metaKeys[k]] === seoValues[k]);
    const pluginName = plugin === 'yoast' ? 'Yoast SEO' : plugin === 'rankmath' ? 'Rank Math' : null;
    const notExposed = pluginName ? `${pluginName} is installed but does not expose this field to the REST API.` : 'Needs Yoast SEO or Rank Math.';
    const pluginField = (k: SeoKey, fallback?: { outcome: 'fallback'; note: string }) =>
      !seoValues[k]
        ? { outcome: 'empty' as const }
        : kept(k)
          ? { outcome: 'applied' as const, note: pluginName ?? undefined }
          : fallback ?? { outcome: 'unsupported' as const, note: notExposed };
    const seoReport: SeoReport = {
      seoTitle: pluginField('seoTitle', { outcome: 'fallback', note: `${notExposed} The post title is used.` }),
      metaDescription: pluginField('metaDescription', { outcome: 'fallback', note: `${notExposed} Written as the post excerpt instead.` }),
      slug: saved.slug === options.slug ? { outcome: 'applied' } : { outcome: 'fallback', note: `WordPress used “${saved.slug}” (the slug was taken).` },
      canonicalUrl: pluginField('canonicalUrl'),
      focusKeyword: pluginField('focusKeyword'),
      ogImage: featured ? pluginField('ogImage', { outcome: 'fallback', note: 'Themes and plugins use the featured image.' }) : { outcome: 'empty' },
      imageAlt: featured || inline.length ? { outcome: 'applied' } : { outcome: 'empty' },
      schema: pluginName ? { outcome: 'applied', note: `${pluginName} generates it from the post.` } : { outcome: 'unsupported', note: 'Needs an SEO plugin.' },
    };

    return {
      externalId: String(saved.id),
      url: saved.link ?? null,
      status: saved.status === 'publish' ? 'published' : 'drafted',
      seoReport,
      remoteState: { ...state, slug: saved.slug },
    };
  },

  /**
   * Revoke the Application Password itself, so disconnecting removes Aura's
   * access on the site too: `introspect` (WordPress 5.7+) names the password
   * this request authenticated with, which is then deleted.
   */
  async revoke(ctx) {
    const c = client(ctx);
    const me = await c.call<{ uuid?: string }>('GET', '/wp/v2/users/me/application-passwords/introspect');
    if (me.uuid) await c.call('DELETE', `/wp/v2/users/me/application-passwords/${me.uuid}`);
  },
};
