/**
 * End-to-end check of a website adapter against a REAL site.
 *
 *   pnpm verify:websites
 *
 * The unit tests (tests/website-*.test.ts) prove the adapters against recorded
 * API shapes. This proves them against the platform itself: credentials are
 * accepted, a blog arrives with its SEO fields, and — the part that matters
 * most — an interrupted publish is found again and retried as an UPDATE, not
 * a second post.
 *
 * Safe to run against a live site: everything is created as a DRAFT (never
 * public), titled "[Aura check] …", and the script prints where it is so you
 * can delete it. Use a staging site if you have one. No database is used.
 *
 * Configure with environment variables (never commit them):
 *   VERIFY_SITE_PLATFORM   wordpress | shopify | ghost
 *   WordPress: VERIFY_SITE_URL, VERIFY_WP_USERNAME, VERIFY_WP_APP_PASSWORD
 *   Shopify:   VERIFY_SHOPIFY_SHOP (store.myshopify.com), VERIFY_SHOPIFY_TOKEN (shpat_…)
 *   Ghost:     VERIFY_SITE_URL, VERIFY_GHOST_ADMIN_KEY (id:secret)
 *   Local WordPress over http: also WEBSITE_ALLOW_PRIVATE_HOSTS=true
 */
import { randomUUID } from 'node:crypto';

import { blogToHtml, defaultPublishOptions } from '@/lib/blog-html';
import type { BlogBody } from '@/lib/validations/content';
import { getAdapter } from '@/server/websites/registry';
import type { RemoteState, SiteContext } from '@/server/websites/types';

const env = (k: string) => process.env[k]?.trim() ?? '';

function inputFor(platform: string): Record<string, string> {
  if (platform === 'wordpress')
    return { siteUrl: env('VERIFY_SITE_URL'), username: env('VERIFY_WP_USERNAME'), appPassword: env('VERIFY_WP_APP_PASSWORD') };
  if (platform === 'shopify') return { shop: env('VERIFY_SHOPIFY_SHOP'), accessToken: env('VERIFY_SHOPIFY_TOKEN') };
  if (platform === 'ghost') return { siteUrl: env('VERIFY_SITE_URL'), adminApiKey: env('VERIFY_GHOST_ADMIN_KEY') };
  return {};
}

let failures = 0;
function check(ok: boolean, what: string, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const platform = env('VERIFY_SITE_PLATFORM');
  const adapter = getAdapter(platform);
  if (!adapter) {
    console.error('Set VERIFY_SITE_PLATFORM to wordpress, shopify or ghost (see the top of this file).');
    process.exit(2);
  }
  const input = inputFor(platform);
  const missing = Object.entries(input).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing settings for ${platform}: ${missing.join(', ')} (see the top of this file).`);
    process.exit(2);
  }

  console.log(`\n${platform}: connecting`);
  const conn = await adapter.connect(input);
  check(true, 'credentials accepted', conn.accountLabel);
  const ctx: SiteContext = {
    siteUrl: conn.siteUrl,
    authKind: conn.authKind,
    credentials: conn.credentials,
    settings: conn.settings ?? {},
    capabilities: conn.capabilities,
  };
  const verified = await adapter.verify(ctx);
  check(Boolean(verified.accountLabel), 'connection test passes', verified.accountLabel);

  const options = await adapter.listOptions(ctx);
  console.log(
    `  · site has ${options.categories?.length ?? 0} categories, ${options.authors?.length ?? 0} authors, ${options.blogs?.length ?? 0} blogs, ${options.recentPosts?.length ?? 0} recent posts`,
  );

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const body: BlogBody = {
    headline: `[Aura check] Publishing test ${stamp}`,
    subtitle: 'A draft created by Aura’s publishing check. Safe to delete.',
    sections: [
      { heading: 'Why this post exists', body: 'Aura created this **draft** to confirm it can publish to this site.\n\n- It is not public.\n- It can be deleted.' },
      { heading: 'Links and formatting', body: 'A [relative link](/about) becomes absolute, and <script>alert(1)</script> stays plain text.' },
    ],
    tags: ['aura-check'],
  };
  const opts = defaultPublishOptions(body, { site: { blogId: options.blogs?.[0]?.id ?? '' } });
  opts.metaDescription = 'Aura publishing check: a draft that confirms posts, SEO fields and duplicate prevention work.';
  opts.focusKeyword = 'aura publishing check';

  const publicationId = `verify_${randomUUID()}`;
  const since = new Date(Date.now() - 60_000);
  const payload = {
    publicationId,
    body,
    options: opts,
    mode: 'draft' as const,
    featured: null,
    inline: [],
    html: () => blogToHtml({ body, siteUrl: conn.siteUrl }),
    since,
  };
  let checkpointed: string | undefined;
  const checkpoint = async (patch: { externalId?: string; remoteState?: RemoteState }) => {
    if (patch.externalId) checkpointed = patch.externalId;
  };

  console.log('\nPublishing as a draft');
  const first = await adapter.publish(ctx, payload, null, {}, checkpoint);
  check(first.status === 'drafted', 'created as a draft, not public', first.status);
  check(Boolean(first.externalId), 'site returned a post id', first.externalId);
  check(checkpointed === first.externalId, 'post id saved as soon as it existed (checkpoint)');
  console.log(`  · ${first.url ?? '(no public URL for a draft)'}`);
  for (const [field, r] of Object.entries(first.seoReport)) console.log(`  · SEO ${field}: ${r?.outcome}${r?.note ? ` (${r.note})` : ''}`);

  console.log('\nDuplicate prevention: an interrupted attempt is looked up first');
  const found = await adapter.findExisting(ctx, { publicationId, title: opts.title, slug: opts.slug, since });
  check(found?.externalId === first.externalId, 'the earlier post is found on the site', found?.externalId ?? 'not found');

  console.log('\nRetry updates the same post');
  const second = await adapter.publish(ctx, payload, { externalId: first.externalId }, first.remoteState ?? {}, checkpoint);
  check(second.externalId === first.externalId, 'same post id, so no second post', second.externalId);

  console.log(
    failures
      ? `\n${failures} check(s) failed.`
      : `\nAll checks passed. Delete the "[Aura check]" draft (id ${first.externalId}) from the site when done.`,
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exit(1);
});
