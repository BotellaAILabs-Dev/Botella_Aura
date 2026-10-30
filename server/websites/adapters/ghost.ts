import crypto from 'node:crypto';

import { clip } from '@/lib/blog-html';
import { normaliseSiteUrl, safeFetch } from '@/server/websites/safe-fetch';
import {
  networkError,
  readJson,
  WebsitePublishError,
  type SeoReport,
  type SiteContext,
  type WebsiteAdapter,
} from '@/server/websites/types';

/**
 * Ghost, through the Admin API with a custom integration's Admin API key
 * ("id:secret"). Each request carries a short-lived JWT signed with the
 * secret, as Ghost documents — the key itself never goes over the wire.
 *
 * Ghost holds every SEO field natively (meta title/description, canonical,
 * Open Graph image, feature-image alt), so the report is mostly "applied".
 * It has tags, not categories: the first category becomes the primary tag.
 */

export function ghostToken(adminApiKey: string, now = Date.now()): string {
  const [id, secret] = adminApiKey.split(':');
  if (!id || !secret || !/^[0-9a-f]+$/i.test(secret)) {
    throw new WebsitePublishError('validation', 'That isn’t a Ghost Admin API key (it looks like 64f…:a1b2…, with a colon).');
  }
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT', kid: id })}.${b64({ iat, exp: iat + 5 * 60, aud: '/admin/' })}`;
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

function host(siteUrl: string) {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

interface GhostErr {
  errors?: { message?: string; context?: string | null; type?: string }[];
}

async function call<T>(ctx: { siteUrl: string; credentials: Record<string, string> }, method: string, path: string, init: { json?: unknown; raw?: { body: Buffer; contentType: string } } = {}): Promise<T> {
  const site = host(ctx.siteUrl);
  const headers: Record<string, string> = {
    authorization: `Ghost ${ghostToken(ctx.credentials.adminApiKey ?? '')}`,
    'accept-version': 'v5.0',
    accept: 'application/json',
  };
  let body: string | Buffer | undefined;
  if (init.raw) {
    headers['content-type'] = init.raw.contentType;
    body = init.raw.body;
  } else if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await safeFetch(`${ctx.siteUrl}/ghost/api/admin${path}`, { method, headers, body, timeoutMs: init.raw ? 60_000 : 20_000 });
  } catch (err) {
    throw networkError(site, err);
  }
  const { data, text } = await readJson(res);
  if (res.ok && data) return data as T;
  const e = ((data ?? {}) as GhostErr).errors?.[0];
  const detail = [e?.message, e?.context].filter(Boolean).join(' — ');
  if (res.status === 401 || res.status === 403) {
    throw new WebsitePublishError('auth', `${site} rejected the Admin API key${detail ? ` (${detail})` : ''}. The integration may have been deleted or its key regenerated — reconnect with the current key.`, res.status);
  }
  if (res.status === 404) throw new WebsitePublishError('not_found', `${site}: no Ghost Admin API here (${detail || 'HTTP 404'}). Check the address.`, 404);
  if (res.status === 429) throw new WebsitePublishError('rate_limit', `${site} is limiting requests. Retry in a few minutes.`, 429);
  if (res.status >= 500) throw new WebsitePublishError('network', `${site} had a server error (HTTP ${res.status}). Retry shortly.`, res.status);
  throw new WebsitePublishError('validation', `${site} rejected the post: ${detail || text.slice(0, 200)}`, res.status);
}

function multipart(fields: Record<string, string>, file: { name: string; filename: string; contentType: string; data: Buffer }) {
  const boundary = `----aura${crypto.randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

interface GhostPost {
  id: string;
  url: string;
  slug: string;
  status: string;
  updated_at: string;
  title: string;
}

async function describe(ctx: { siteUrl: string; credentials: Record<string, string> }) {
  const site = await call<{ site: { title: string; url: string } }>(ctx, 'GET', '/site/');
  // /site is public: an authenticated call proves the key works.
  await call(ctx, 'GET', '/posts/?limit=1&fields=id');
  return { accountLabel: site.site.title, capabilities: { siteName: site.site.title } };
}

export const ghostAdapter: WebsiteAdapter = {
  id: 'ghost',

  async connect(input) {
    const siteUrl = normaliseSiteUrl(input.siteUrl ?? '');
    const adminApiKey = (input.adminApiKey ?? '').trim();
    ghostToken(adminApiKey); // shape check before any request
    const ctx = { siteUrl, credentials: { adminApiKey } };
    const d = await describe(ctx);
    return { siteUrl, authKind: 'admin_api_key', accountLabel: d.accountLabel, credentials: { adminApiKey }, capabilities: d.capabilities };
  },

  async verify(ctx) {
    const d = await describe(ctx);
    return { accountLabel: d.accountLabel, capabilities: { ...ctx.capabilities, ...d.capabilities } };
  },

  async listOptions(ctx) {
    const [tags, users, posts] = await Promise.all([
      call<{ tags: { name: string }[] }>(ctx, 'GET', '/tags/?limit=100&fields=name&filter=visibility:public'),
      call<{ users: { email: string; name: string }[] }>(ctx, 'GET', '/users/?limit=100&fields=email,name'),
      call<{ posts: { title: string; url: string }[] }>(ctx, 'GET', '/posts/?limit=20&fields=title,url&filter=status:published').catch(() => ({ posts: [] })),
    ]);
    return {
      categories: tags.tags.map((t) => ({ id: t.name, name: t.name })),
      authors: users.users.map((u) => ({ id: u.email, name: u.name })),
      recentPosts: posts.posts,
    };
  },

  async findExisting(ctx, marker) {
    const since = new Date(marker.since.getTime() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    const found = await call<{ posts: GhostPost[] }>(ctx, 'GET', `/posts/?limit=20&fields=id,title,slug&filter=${encodeURIComponent(`updated_at:>'${since}'`)}`);
    const title = marker.title.trim().toLowerCase();
    const ours = found.posts.find((p) => p.title.trim().toLowerCase() === title || p.slug === marker.slug || new RegExp(`^${marker.slug}-\\d+$`).test(p.slug));
    return ours ? { externalId: ours.id } : null;
  },

  async publish(ctx: SiteContext, payload, existing, state, checkpoint) {
    const { options } = payload;
    state.media ??= {};
    const upload = async (img: NonNullable<typeof payload.featured>) => {
      if (state.media![img.assetId]) return state.media![img.assetId]!;
      const bytes = await img.bytes();
      if (!bytes) throw new WebsitePublishError('validation', 'An attached image could not be read. Regenerate or re-attach it, then retry.');
      const form = multipart({ purpose: 'image', ref: img.assetId }, { name: 'file', filename: img.filename, contentType: img.mimeType, data: bytes });
      const r = await call<{ images: { url: string }[] }>(ctx, 'POST', '/images/upload/', { raw: form });
      const saved = { id: r.images[0]!.url, url: r.images[0]!.url };
      state.media![img.assetId] = saved;
      await checkpoint({ remoteState: state });
      return saved;
    };
    const featured = payload.featured ? await upload(payload.featured) : null;
    const inline = [];
    for (const img of payload.inline) inline.push({ url: (await upload(img)).url, alt: img.alt });

    // Primary tag (the first category), then tags; the focus keyphrase as an internal tag.
    const tagNames = [...new Set([...options.categories, ...options.tags])];
    const tags = [...tagNames.map((name) => ({ name })), ...(options.focusKeyword ? [{ name: `#${options.focusKeyword}` }] : [])];
    const post: Record<string, unknown> = {
      title: options.title,
      html: payload.html(inline),
      slug: options.slug,
      status: payload.mode === 'draft' ? 'draft' : 'published',
      custom_excerpt: clip(options.metaDescription, 300),
      meta_title: options.seoTitle ? clip(options.seoTitle, 300) : null,
      meta_description: options.metaDescription ? clip(options.metaDescription, 500) : null,
      canonical_url: options.canonicalUrl || null,
      feature_image: featured?.url ?? null,
      feature_image_alt: featured ? clip(options.featuredImageAlt || payload.featured!.alt, 191) : null,
      og_image: featured?.url ?? null,
      twitter_image: featured?.url ?? null,
      tags,
      ...(options.author.includes('@') ? { authors: [{ email: options.author }] } : {}),
    };

    let saved: GhostPost | null = null;
    if (existing) {
      // Ghost's collision check: an update must name the version it replaces.
      const current = await call<{ posts: GhostPost[] }>(ctx, 'GET', `/posts/${existing.externalId}/?fields=id,updated_at`).catch((err) => {
        if ((err as WebsitePublishError).code === 'not_found') return null;
        throw err;
      });
      if (current?.posts[0]) {
        const r = await call<{ posts: GhostPost[] }>(ctx, 'PUT', `/posts/${existing.externalId}/?source=html`, {
          json: { posts: [{ ...post, updated_at: current.posts[0].updated_at }] },
        });
        saved = r.posts[0]!;
      }
    }
    if (!saved) {
      const r = await call<{ posts: GhostPost[] }>(ctx, 'POST', '/posts/?source=html', { json: { posts: [post] } });
      saved = r.posts[0]!;
      await checkpoint({ externalId: saved.id });
    }

    const has = (v: unknown) => (v ? { outcome: 'applied' as const } : { outcome: 'empty' as const });
    const seoReport: SeoReport = {
      seoTitle: has(options.seoTitle),
      metaDescription: has(options.metaDescription),
      slug: saved.slug === options.slug ? { outcome: 'applied' } : { outcome: 'fallback', note: `Ghost used “${saved.slug}”.` },
      canonicalUrl: has(options.canonicalUrl),
      focusKeyword: options.focusKeyword ? { outcome: 'fallback', note: `Added as the internal tag #${options.focusKeyword}.` } : { outcome: 'empty' },
      ogImage: has(featured),
      imageAlt: has(featured || inline.length),
      schema: { outcome: 'applied', note: 'Ghost generates Article schema.' },
    };
    return {
      externalId: saved.id,
      url: saved.status === 'published' ? saved.url : `${ctx.siteUrl}/ghost/#/editor/post/${saved.id}`,
      status: saved.status === 'published' ? 'published' : 'drafted',
      seoReport,
      remoteState: state,
    };
  },
};
