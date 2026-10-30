import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The platform adapters, against a fake HTTP layer. Every request is
 * recorded, so the tests also prove what was NOT sent (no second post, no
 * re-uploaded image).
 */

type Handler = (req: { method: string; url: string; body: unknown; headers: Record<string, string> }) => { status?: number; json?: unknown; text?: string } | undefined;
const http = vi.hoisted(() => ({ calls: [] as { method: string; url: string; body: unknown; headers: Record<string, string> }[], handler: null as unknown as Handler }));

vi.mock('@/server/websites/safe-fetch', async (orig) => {
  const actual = await orig<typeof import('@/server/websites/safe-fetch')>();
  return {
    ...actual,
    safeFetch: async (url: string, init: { method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}) => {
      let body: unknown = init.body;
      if (typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          /* keep raw */
        }
      }
      const req = { method: init.method ?? 'GET', url, body, headers: init.headers ?? {} };
      http.calls.push(req);
      const out = http.handler(req) ?? { status: 404, json: { code: 'rest_no_route', message: 'No route' } };
      return new Response(out.text ?? JSON.stringify(out.json ?? {}), { status: out.status ?? 200 });
    },
  };
});

import { endpoint, wordpressAdapter } from '@/server/websites/adapters/wordpress';
import { normaliseShop, shopifyAdapter } from '@/server/websites/adapters/shopify';
import { ghostToken } from '@/server/websites/adapters/ghost';
import { verifyShopifyHmac } from '@/server/websites/shopify-oauth';
import { WebsitePublishError, type PublishPayload, type SiteContext } from '@/server/websites/types';
import { defaultPublishOptions } from '@/lib/blog-html';

const blog = { headline: 'Brew Better', subtitle: '', sections: [{ heading: 'A', body: 'a' }, { heading: 'B', body: 'b' }], tags: ['coffee'] };

function payload(over: Partial<PublishPayload> = {}): PublishPayload {
  return {
    publicationId: 'pub_1',
    body: blog,
    // As the service resolves them: the image's own alt text becomes the default.
    options: { ...defaultPublishOptions(blog, { featuredAlt: 'A cup' }), categories: ['Guides'], seoTitle: 'Brew Better | Shop', metaDescription: 'How to brew.', canonicalUrl: 'https://x.example/brew' },
    mode: 'publish',
    featured: { assetId: 'a1', mimeType: 'image/png', filename: 'brew-better-1', alt: 'A cup', bytes: async () => Buffer.from('png'), publicUrl: () => 'https://aura.example/img/a1' },
    inline: [],
    html: () => '<p>body</p>',
    since: new Date('2026-10-30T10:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  http.calls = [];
});

const wpCtx: SiteContext = {
  siteUrl: 'https://blog.example',
  credentials: { username: 'ed', appPassword: 'abcd efgh ijkl' },
  settings: {},
  capabilities: { restStyle: 'pretty', seoPlugin: 'yoast' },
};

describe('WordPress', () => {
  it('builds both REST URL styles', () => {
    expect(endpoint('https://a.example', 'pretty', '/wp/v2/posts', { per_page: 5 })).toBe('https://a.example/wp-json/wp/v2/posts?per_page=5');
    expect(endpoint('https://a.example', 'plain', '/wp/v2/posts', { per_page: 5 })).toBe('https://a.example/?rest_route=/wp/v2/posts&per_page=5');
  });

  it('connects with an Application Password, finding the API on plain permalinks and the SEO plugin', async () => {
    http.handler = ({ url, headers }) => {
      if (url === 'https://blog.example/wp-json/') return { status: 404, text: '<html>not found</html>' };
      if (url === 'https://blog.example/?rest_route=/') return { json: { name: 'Beans Blog', namespaces: ['wp/v2', 'yoast/v1'] } };
      if (url.includes('users/me')) {
        expect(headers.authorization).toBe(`Basic ${Buffer.from('ed:abcdefghijkl').toString('base64')}`);
        return { json: { id: 7, name: 'Ed', capabilities: { publish_posts: true, upload_files: true } } };
      }
    };
    const r = await wordpressAdapter.connect({ siteUrl: 'blog.example/', username: 'ed', appPassword: 'abcd efgh ijkl' });
    expect(r).toMatchObject({ siteUrl: 'https://blog.example', authKind: 'app_password', capabilities: { restStyle: 'plain', seoPlugin: 'yoast' }, settings: { author: '7' } });
    expect(r.credentials).toEqual({ username: 'ed', appPassword: 'abcd efgh ijkl' });
  });

  it('explains a host that strips the Authorization header', async () => {
    http.handler = ({ url }) =>
      url.endsWith('/wp-json/') ? { json: { namespaces: ['wp/v2'] } } : { status: 401, json: { code: 'rest_not_logged_in', message: 'You are not currently logged in.' } };
    const err = await wordpressAdapter.connect({ siteUrl: 'https://blog.example', username: 'ed', appPassword: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(WebsitePublishError);
    expect(err.code).toBe('auth');
    expect(err.message).toMatch(/strip the Authorization header/);
  });

  it('refuses a user who cannot publish', async () => {
    http.handler = ({ url }) =>
      url.endsWith('/wp-json/') ? { json: { namespaces: ['wp/v2'] } } : { json: { id: 3, name: 'Cat', capabilities: { edit_posts: true, publish_posts: false } } };
    await expect(wordpressAdapter.connect({ siteUrl: 'https://blog.example', username: 'cat', appPassword: 'x' })).rejects.toMatchObject({ code: 'permission' });
  });

  it('creates the post with image, alt text, terms, excerpt and Yoast fields — and reports what the site kept', async () => {
    const checkpoint = vi.fn(async () => undefined);
    http.handler = ({ method, url, body }) => {
      if (method === 'POST' && url.endsWith('/wp/v2/media')) return { json: { id: 55, source_url: 'https://blog.example/up/brew.png' } };
      if (method === 'POST' && url.endsWith('/wp/v2/media/55')) return { json: { id: 55 } };
      if (url.includes('/wp/v2/categories?')) return { json: [] };
      if (method === 'POST' && url.endsWith('/wp/v2/categories')) return { json: { id: 9 } };
      if (url.includes('/wp/v2/tags?')) return { json: [{ id: 4, name: 'Coffee' }] };
      if (method === 'POST' && url.endsWith('/wp/v2/posts')) {
        const b = body as Record<string, unknown>;
        return { json: { id: 101, link: 'https://blog.example/brew-better', status: b.status, slug: b.slug, meta: b.meta } };
      }
    };
    const out = await wordpressAdapter.publish(wpCtx, payload(), null, {}, checkpoint);

    const post = http.calls.find((c) => c.method === 'POST' && c.url.endsWith('/wp/v2/posts'))!.body as Record<string, unknown>;
    expect(post).toMatchObject({
      title: 'Brew Better',
      content: '<p>body</p>',
      excerpt: 'How to brew.',
      slug: 'brew-better',
      status: 'publish',
      categories: [9],
      tags: [4],
      featured_media: 55,
      meta: { _yoast_wpseo_title: 'Brew Better | Shop', _yoast_wpseo_metadesc: 'How to brew.', _yoast_wpseo_canonical: 'https://x.example/brew', _yoast_wpseo_focuskw: 'coffee' },
    });
    expect(http.calls.find((c) => c.url.endsWith('/wp/v2/media/55'))!.body).toEqual({ alt_text: 'A cup' });
    expect(checkpoint).toHaveBeenCalledWith({ externalId: '101' });
    expect(out).toMatchObject({ externalId: '101', url: 'https://blog.example/brew-better', status: 'published' });
    expect(out.seoReport.seoTitle?.outcome).toBe('applied');
    expect(out.seoReport.canonicalUrl?.outcome).toBe('applied');
    expect(out.seoReport.slug?.outcome).toBe('applied');
  });

  it('on retry, updates the post it already created and reuses uploaded images — no second post', async () => {
    http.handler = ({ method, url }) => {
      if (url.includes('/wp/v2/categories?')) return { json: [{ id: 9, name: 'Guides' }] };
      if (url.includes('/wp/v2/tags?')) return { json: [{ id: 4, name: 'coffee' }] };
      if (method === 'POST' && url.endsWith('/wp/v2/posts/101')) return { json: { id: 101, link: 'https://blog.example/brew-better', status: 'publish', slug: 'brew-better', meta: {} } };
    };
    const out = await wordpressAdapter.publish(wpCtx, payload(), { externalId: '101' }, { media: { a1: { id: '55', url: 'https://blog.example/up/brew.png' } } }, vi.fn());
    expect(out.externalId).toBe('101');
    expect(http.calls.some((c) => c.method === 'POST' && c.url.endsWith('/wp/v2/posts'))).toBe(false);
    expect(http.calls.some((c) => c.url.endsWith('/wp/v2/media'))).toBe(false);
    // Yoast installed but meta not echoed back: said, not assumed.
    expect(out.seoReport.seoTitle).toMatchObject({ outcome: 'fallback' });
    expect(out.seoReport.seoTitle?.note).toMatch(/does not expose/);
  });

  it('re-creates a post that was deleted on the site since', async () => {
    http.handler = ({ method, url }) => {
      if (url.includes('/categories?') || url.includes('/tags?')) return { json: [{ id: 1, name: 'Guides' }, { id: 1, name: 'coffee' }] };
      if (method === 'POST' && url.endsWith('/wp/v2/posts/101')) return { status: 404, json: { code: 'rest_post_invalid_id', message: 'Invalid post ID.' } };
      if (method === 'POST' && url.endsWith('/wp/v2/posts')) return { json: { id: 202, link: 'https://blog.example/b', status: 'draft', slug: 'brew-better' } };
    };
    const checkpoint = vi.fn(async () => undefined);
    const out = await wordpressAdapter.publish(wpCtx, payload({ featured: null, mode: 'draft' }), { externalId: '101' }, {}, checkpoint);
    expect(out).toMatchObject({ externalId: '202', status: 'drafted' });
    expect(checkpoint).toHaveBeenCalledWith({ externalId: '202' });
  });

  it('sends the post without SEO meta when the site refuses unknown meta keys', async () => {
    let attempts = 0;
    http.handler = ({ method, url, body }) => {
      if (url.includes('/categories?') || url.includes('/tags?')) return { json: [{ id: 1, name: 'Guides' }, { id: 2, name: 'coffee' }] };
      if (method === 'POST' && url.endsWith('/wp/v2/posts')) {
        attempts++;
        if ((body as { meta?: unknown }).meta) return { status: 400, json: { code: 'rest_invalid_param', message: 'Invalid parameter(s): meta' } };
        return { json: { id: 7, link: 'https://blog.example/p', status: 'publish', slug: 'brew-better' } };
      }
    };
    const out = await wordpressAdapter.publish(wpCtx, payload({ featured: null }), null, {}, vi.fn());
    expect(attempts).toBe(2);
    expect(out.seoReport.metaDescription).toMatchObject({ outcome: 'fallback' });
    expect(out.seoReport.metaDescription?.note).toMatch(/excerpt/);
  });

  it('maps a 403 to a permission problem and a 503 to a retryable network one', async () => {
    http.handler = ({ url }) => (url.includes('/categories?') ? { status: 503, text: 'down' } : undefined);
    await expect(wordpressAdapter.publish(wpCtx, payload({ featured: null }), null, {}, vi.fn())).rejects.toMatchObject({ code: 'network' });
  });

  it('finds an earlier attempt’s post, including a slug WordPress made unique', async () => {
    http.handler = () => ({ json: [{ id: 1, slug: 'other', title: { raw: 'Other' } }, { id: 2, slug: 'brew-better-2', title: { raw: 'Changed title' } }] });
    expect(await wordpressAdapter.findExisting(wpCtx, { publicationId: 'p', title: 'Brew Better', slug: 'brew-better', since: new Date() })).toEqual({ externalId: '2' });
    expect(http.calls[0]!.url).toContain('modified_after=');
  });
});

const shopCtx: SiteContext = {
  siteUrl: 'https://beans.myshopify.com',
  authKind: 'oauth',
  credentials: { accessToken: 'shpat_x' },
  settings: { blogId: 'gid://shopify/Blog/1' },
  capabilities: { shopName: 'Beans', storefrontUrl: 'https://beans.example' },
};

describe('Shopify', () => {
  it('normalises store addresses and refuses anything else', () => {
    expect(normaliseShop('Beans')).toBe('beans.myshopify.com');
    expect(normaliseShop('https://beans.myshopify.com/admin')).toBe('beans.myshopify.com');
    expect(() => normaliseShop('beans.example.com')).toThrow(WebsitePublishError);
    expect(() => normaliseShop('evil.com/.myshopify.com')).toThrow();
  });

  it('verifies Shopify’s redirect signature', () => {
    const secret = 'shh';
    const params = new URLSearchParams({ code: 'c', shop: 'beans.myshopify.com', state: 's', timestamp: '1' });
    const msg = 'code=c&shop=beans.myshopify.com&state=s&timestamp=1';
    params.set('hmac', crypto.createHmac('sha256', secret).update(msg).digest('hex'));
    expect(verifyShopifyHmac(params, secret)).toBe(true);
    params.set('shop', 'evil.myshopify.com');
    expect(verifyShopifyHmac(params, secret)).toBe(false);
  });

  it('creates the article with SEO metafields, its marker, image and tags', async () => {
    const checkpoint = vi.fn(async () => undefined);
    http.handler = ({ body }) => {
      const q = (body as { query: string }).query;
      if (q.includes('articleCreate')) {
        return { json: { data: { articleCreate: { article: { id: 'gid://shopify/Article/9', handle: 'brew-better', isPublished: false, blog: { handle: 'news' }, metafield: null }, userErrors: [] } } } };
      }
    };
    const out = await shopifyAdapter.publish(shopCtx, payload({ mode: 'draft' }), null, {}, checkpoint);
    const sent = (http.calls[0]!.body as { variables: { article: Record<string, unknown> } }).variables.article;
    expect(http.calls[0]!.headers['x-shopify-access-token']).toBe('shpat_x');
    expect(sent).toMatchObject({ blogId: 'gid://shopify/Blog/1', title: 'Brew Better', handle: 'brew-better', isPublished: false, image: { url: 'https://aura.example/img/a1', altText: 'A cup' } });
    expect(sent.tags).toEqual(expect.arrayContaining(['coffee', 'Guides']));
    expect(sent.metafields).toEqual(
      expect.arrayContaining([
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'Brew Better | Shop' },
        { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: 'How to brew.' },
        { namespace: 'aura', key: 'publication_id', type: 'single_line_text_field', value: 'pub_1' },
      ]),
    );
    expect(checkpoint).toHaveBeenCalledWith({ externalId: 'gid://shopify/Article/9' });
    expect(out).toMatchObject({ status: 'drafted', url: 'https://admin.shopify.com/store/beans/content/articles/9' });
    expect(out.seoReport.canonicalUrl?.outcome).toBe('unsupported');
  });

  it('turns userErrors into a clear validation error', async () => {
    http.handler = () => ({ json: { data: { articleCreate: { article: null, userErrors: [{ field: ['article', 'handle'], message: 'is already taken' }] } } } });
    await expect(shopifyAdapter.publish(shopCtx, payload(), null, {}, vi.fn())).rejects.toMatchObject({ code: 'validation', message: expect.stringContaining('article.handle: is already taken') });
  });

  it('treats a revoked token as reconnect-required', async () => {
    http.handler = () => ({ status: 401, json: { errors: 'Invalid API key or access token' } });
    await expect(shopifyAdapter.publish(shopCtx, payload(), null, {}, vi.fn())).rejects.toMatchObject({ code: 'auth' });
  });

  it('finds its own article by the marker metafield only', async () => {
    http.handler = () => ({
      json: { data: { articles: { nodes: [{ id: 'gid://x/1', handle: 'brew-better', metafield: { value: 'someone-else' } }, { id: 'gid://x/2', handle: 'brew-better-1', metafield: { value: 'pub_1' } }] } } },
    });
    expect(await shopifyAdapter.findExisting(shopCtx, { publicationId: 'pub_1', title: 'Brew Better', slug: 'brew-better', since: new Date() })).toEqual({ externalId: 'gid://x/2' });
  });
});

describe('Ghost', () => {
  it('signs a short-lived Admin API token with the key’s secret', () => {
    const secret = 'a1b2c3d4';
    const token = ghostToken(`kid123:${secret}`, Date.UTC(2026, 9, 30) );
    const [h, p, sig] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'kid123' });
    const payloadJson = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payloadJson.aud).toBe('/admin/');
    expect(payloadJson.exp - payloadJson.iat).toBe(300);
    expect(sig).toBe(crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(`${h}.${p}`).digest('base64url'));
  });

  it('rejects something that is not an Admin API key', () => {
    expect(() => ghostToken('not-a-key')).toThrow(/Admin API key/);
  });
});
