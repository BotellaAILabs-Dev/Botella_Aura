import { escapeHtml } from '@/lib/blog-html';
import { safeFetch } from '@/server/websites/safe-fetch';
import {
  networkError,
  readJson,
  WebsitePublishError,
  type PostImage,
  type SeoReport,
  type SiteContext,
  type WebsiteAdapter,
} from '@/server/websites/types';

/**
 * Shopify blog articles, through the GraphQL Admin API (REST is legacy for
 * new apps). Authentication is Shopify OAuth (server/websites/shopify-oauth.ts)
 * with the content scopes; an existing custom app's Admin API token is also
 * accepted.
 *
 * SEO: an article's SEO title and description are the `global.title_tag` and
 * `global.description_tag` metafields — what the Shopify admin's "Search
 * engine listing" edits. The handle is the slug. Canonical URL and schema are
 * set by the theme; there is no per-article field, and the report says so.
 *
 * Duplicates: every article Aura creates carries an `aura.publication_id`
 * metafield, so a retry after an interrupted attempt finds its own article
 * for certain instead of guessing by title.
 */

export const SHOPIFY_SCOPES = ['read_content', 'write_content', 'read_files', 'write_files'];

export function shopifyApiVersion(): string {
  return process.env.SHOPIFY_API_VERSION?.trim() || '2026-07';
}

/** "Your-Store", "your-store.myshopify.com", "https://your-store.myshopify.com/admin" → "your-store.myshopify.com". */
export function normaliseShop(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) {
    throw new WebsitePublishError(
      'validation',
      'Enter the store’s myshopify.com address (Shopify admin → Settings → Domains), like your-store.myshopify.com.',
    );
  }
  return s;
}

const shopOf = (siteUrl: string) => siteUrl.replace(/^https?:\/\//, '');

interface GqlError {
  message: string;
  extensions?: { code?: string };
}

async function gql<T>(ctx: { siteUrl: string; credentials: Record<string, string> }, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const shop = shopOf(ctx.siteUrl);
  let res: Response;
  try {
    res = await safeFetch(`https://${shop}/admin/api/${shopifyApiVersion()}/graphql.json`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-shopify-access-token': ctx.credentials.accessToken ?? '',
      },
      body: JSON.stringify({ query, variables }),
      timeoutMs: 30_000,
    });
  } catch (err) {
    throw networkError(shop, err);
  }
  const { data, text } = await readJson(res);
  if (res.status === 401) {
    throw new WebsitePublishError('auth', `${shop} refused Aura’s access token — the app may have been uninstalled. Reconnect the store.`, 401);
  }
  if (res.status === 403) {
    throw new WebsitePublishError('auth', `${shop} did not grant Aura permission to manage blog content. Reconnect the store and approve the requested access.`, 403);
  }
  if (res.status === 402) throw new WebsitePublishError('permission', `${shop} is frozen or unpaid (HTTP 402) — Shopify blocks changes until the plan is active.`, 402);
  if (res.status === 423) throw new WebsitePublishError('permission', `${shop} is locked by Shopify (HTTP 423).`, 423);
  if (res.status === 429) throw new WebsitePublishError('rate_limit', `${shop} is limiting requests (HTTP 429). Retry in a minute.`, 429);
  if (res.status >= 500) throw new WebsitePublishError('network', `Shopify had a server error (HTTP ${res.status}). Retry shortly.`, res.status);
  if (!res.ok || !data) throw new WebsitePublishError('unknown', `Shopify answered HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  const body = data as { data?: T; errors?: GqlError[] };
  if (body.errors?.length) {
    const throttled = body.errors.find((e) => e.extensions?.code === 'THROTTLED');
    if (throttled) throw new WebsitePublishError('rate_limit', 'Shopify is throttling API calls for this store. Retry in a minute.');
    const denied = body.errors.find((e) => e.extensions?.code === 'ACCESS_DENIED');
    if (denied) throw new WebsitePublishError('auth', `Shopify denied access: ${denied.message} Reconnect the store and approve blog-content access.`);
    throw new WebsitePublishError('validation', `Shopify: ${body.errors.map((e) => e.message).join(' ')}`);
  }
  return body.data as T;
}

interface UserError {
  field?: string[] | null;
  message: string;
}

function assertNoUserErrors(errors: UserError[] | undefined, what: string) {
  if (errors?.length) {
    throw new WebsitePublishError('validation', `Shopify rejected the ${what}: ${errors.map((e) => `${e.field?.join('.') ? `${e.field!.join('.')}: ` : ''}${e.message}`).join('; ')}`);
  }
}

const SHOP_QUERY = `query AuraShop {
  shop { name myshopifyDomain primaryDomain { url } }
  blogs(first: 50) { nodes { id title handle } }
}`;

interface ShopInfo {
  shop: { name: string; myshopifyDomain: string; primaryDomain: { url: string } };
  blogs: { nodes: { id: string; title: string; handle: string }[] };
}

async function describeShop(ctx: { siteUrl: string; credentials: Record<string, string> }) {
  const info = await gql<ShopInfo>(ctx, SHOP_QUERY);
  if (info.blogs.nodes.length === 0) {
    throw new WebsitePublishError(
      'not_found',
      `${info.shop.name} has no blog yet. In Shopify admin, go to Online Store → Blog posts → Manage blogs → Add blog, then connect again.`,
    );
  }
  return {
    accountLabel: info.shop.name,
    capabilities: {
      shopName: info.shop.name,
      storefrontUrl: info.shop.primaryDomain.url.replace(/\/+$/, ''),
      blogs: info.blogs.nodes.map((b) => ({ id: b.id, name: b.title, handle: b.handle })),
    },
    defaultBlogId: info.blogs.nodes[0]!.id,
  };
}

/** Upload an inline image to Shopify Files and wait for its CDN URL. */
async function uploadFile(ctx: SiteContext, img: PostImage): Promise<{ id: string; url: string } | null> {
  const created = await gql<{ fileCreate: { files: { id: string }[]; userErrors: UserError[] } }>(
    ctx,
    `mutation AuraFile($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id } userErrors { field message } } }`,
    { files: [{ originalSource: img.publicUrl(), contentType: 'IMAGE', alt: img.alt }] },
  );
  assertNoUserErrors(created.fileCreate.userErrors, 'image');
  const id = created.fileCreate.files[0]?.id;
  if (!id) return null;
  // Shopify fetches and processes the image asynchronously: poll briefly.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const node = await gql<{ node: { fileStatus?: string; image?: { url: string } | null } | null }>(
      ctx,
      `query AuraFileStatus($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`,
      { id },
    );
    if (node.node?.fileStatus === 'READY' && node.node.image?.url) return { id, url: node.node.image.url };
    if (node.node?.fileStatus === 'FAILED') return null;
  }
  return null;
}

const ARTICLE_FIELDS = 'id handle isPublished blog { handle } metafield(namespace: "aura", key: "publication_id") { value }';

interface Article {
  id: string;
  handle: string;
  isPublished: boolean;
  blog: { handle: string };
  metafield?: { value: string } | null;
}

export const shopifyAdapter: WebsiteAdapter = {
  id: 'shopify',

  /** Admin-API-token path (an existing custom app). OAuth arrives with its token too. */
  async connect(input) {
    const shop = normaliseShop(input.shop ?? '');
    const accessToken = (input.accessToken ?? '').trim();
    if (!accessToken) throw new WebsitePublishError('validation', 'Connect with Shopify, or paste an Admin API access token.');
    const siteUrl = `https://${shop}`;
    const ctx = { siteUrl, credentials: { accessToken } };
    const d = await describeShop(ctx);
    return {
      siteUrl,
      authKind: input.authKind === 'oauth' ? 'oauth' : 'access_token',
      accountLabel: d.accountLabel,
      credentials: { accessToken },
      capabilities: d.capabilities,
      settings: { blogId: d.defaultBlogId, author: d.accountLabel },
    };
  },

  async verify(ctx) {
    const d = await describeShop(ctx);
    return { accountLabel: d.accountLabel, capabilities: { ...ctx.capabilities, ...d.capabilities } };
  },

  async listOptions(ctx) {
    const d = await describeShop(ctx);
    const recent = await gql<{ articles: { nodes: { title: string; handle: string; blog: { handle: string } }[] } }>(
      ctx,
      `query AuraRecent { articles(first: 20, sortKey: PUBLISHED_AT, reverse: true, query: "published_status:published") { nodes { title handle blog { handle } } } }`,
    ).catch(() => ({ articles: { nodes: [] } }));
    const storefront = d.capabilities.storefrontUrl;
    return {
      blogs: d.capabilities.blogs.map((b) => ({ id: b.id, name: b.name })),
      recentPosts: recent.articles.nodes.map((a) => ({ title: a.title, url: `${storefront}/blogs/${a.blog.handle}/${a.handle}` })),
    };
  },

  async findExisting(ctx, marker) {
    const since = new Date(marker.since.getTime() - 60_000).toISOString();
    const found = await gql<{ articles: { nodes: Article[] } }>(
      ctx,
      `query AuraFind($q: String!) { articles(first: 25, query: $q) { nodes { ${ARTICLE_FIELDS} } } }`,
      { q: `created_at:>='${since}'` },
    );
    const ours = found.articles.nodes.find((a) => a.metafield?.value === marker.publicationId);
    return ours ? { externalId: ours.id } : null;
  },

  async publish(ctx, payload, existing, state, checkpoint) {
    const { options } = payload;
    const blogId = options.blogId || String(ctx.settings.blogId ?? '');
    if (!blogId) throw new WebsitePublishError('validation', 'Choose which Shopify blog this article goes to.');
    state.media ??= {};

    // Inline images live in Shopify Files (the article body needs permanent URLs).
    const inline: { url: string; alt: string }[] = [];
    let inlineSkipped = 0;
    for (const img of payload.inline) {
      let saved = state.media[img.assetId] ?? null;
      if (!saved) {
        saved = await uploadFile(ctx, img).catch(() => null);
        if (saved) {
          state.media[img.assetId] = saved;
          await checkpoint({ remoteState: state });
        }
      }
      if (saved) inline.push({ url: saved.url, alt: img.alt });
      else inlineSkipped++;
    }

    const tags = [...new Set([...options.tags, ...options.categories, ...(options.focusKeyword ? [options.focusKeyword] : [])])];
    const metafields = [
      ...(options.seoTitle ? [{ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: options.seoTitle }] : []),
      ...(options.metaDescription ? [{ namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: options.metaDescription }] : []),
      { namespace: 'aura', key: 'publication_id', type: 'single_line_text_field', value: payload.publicationId },
    ];
    const article: Record<string, unknown> = {
      blogId,
      title: options.title,
      body: payload.html(inline),
      summary: options.metaDescription ? `<p>${escapeHtml(options.metaDescription)}</p>` : '',
      handle: options.slug,
      tags,
      isPublished: payload.mode === 'publish',
      author: { name: options.author || String(ctx.capabilities.shopName ?? 'Staff') },
      metafields,
      ...(payload.featured ? { image: { url: payload.featured.publicUrl(), altText: options.featuredImageAlt || payload.featured.alt } } : {}),
    };

    let saved: Article | null = null;
    if (existing) {
      const r = await gql<{ articleUpdate: { article: Article | null; userErrors: UserError[] } }>(
        ctx,
        `mutation AuraUpdate($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { ${ARTICLE_FIELDS} } userErrors { field message } } }`,
        { id: existing.externalId, article },
      );
      // Deleted in Shopify since: create it again.
      const gone = r.articleUpdate.userErrors.some((e) => /not exist|not found/i.test(e.message));
      if (!gone) {
        assertNoUserErrors(r.articleUpdate.userErrors, 'article');
        saved = r.articleUpdate.article;
      }
    }
    if (!saved) {
      const r = await gql<{ articleCreate: { article: Article | null; userErrors: UserError[] } }>(
        ctx,
        `mutation AuraCreate($article: ArticleCreateInput!) { articleCreate(article: $article) { article { ${ARTICLE_FIELDS} } userErrors { field message } } }`,
        { article },
      );
      assertNoUserErrors(r.articleCreate.userErrors, 'article');
      saved = r.articleCreate.article;
      if (!saved) throw new WebsitePublishError('unknown', 'Shopify did not return the article it created.');
      await checkpoint({ externalId: saved.id });
    }

    const storefront = String(ctx.capabilities.storefrontUrl ?? ctx.siteUrl);
    const numericId = saved.id.split('/').pop();
    const storeHandle = shopOf(ctx.siteUrl).replace(/\.myshopify\.com$/, '');
    const url = saved.isPublished
      ? `${storefront}/blogs/${saved.blog.handle}/${saved.handle}`
      : `https://admin.shopify.com/store/${storeHandle}/content/articles/${numericId}`;

    const seoReport: SeoReport = {
      seoTitle: options.seoTitle ? { outcome: 'applied' } : { outcome: 'empty' },
      metaDescription: options.metaDescription ? { outcome: 'applied', note: 'SEO description and article summary.' } : { outcome: 'empty' },
      slug: saved.handle === options.slug ? { outcome: 'applied' } : { outcome: 'fallback', note: `Shopify used “${saved.handle}”.` },
      canonicalUrl: options.canonicalUrl ? { outcome: 'unsupported', note: 'Shopify sets canonical URLs itself.' } : { outcome: 'empty' },
      focusKeyword: options.focusKeyword ? { outcome: 'fallback', note: 'Added as a tag (Shopify has no focus keyphrase).' } : { outcome: 'empty' },
      ogImage: payload.featured ? { outcome: 'fallback', note: 'Shopify shares the article image.' } : { outcome: 'empty' },
      imageAlt: payload.featured || inline.length ? { outcome: 'applied' } : { outcome: 'empty' },
      schema: { outcome: 'unsupported', note: 'Comes from your theme.' },
    };
    if (inlineSkipped) {
      seoReport.imageAlt = { outcome: 'fallback', note: `${inlineSkipped} inline image(s) could not be stored in Shopify Files and were left out.` };
    }
    return { externalId: saved.id, url, status: saved.isPublished ? 'published' : 'drafted', seoReport, remoteState: state };
  },

  /**
   * Revoke the OAuth grant (Shopify's documented token revocation), which
   * uninstalls Aura from the store. A custom app's token belongs to that app
   * and is revoked in Shopify admin instead.
   */
  async revoke(ctx) {
    if (ctx.authKind !== 'oauth') return;
    const shop = shopOf(ctx.siteUrl);
    const res = await safeFetch(`https://${shop}/admin/api_permissions/current.json`, {
      method: 'DELETE',
      headers: { 'x-shopify-access-token': ctx.credentials.accessToken ?? '' },
    });
    if (!res.ok && res.status !== 401) throw new Error(`Shopify revoke failed (HTTP ${res.status}).`);
  },
};
