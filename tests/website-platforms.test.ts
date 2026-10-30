import { describe, expect, it } from 'vitest';

import { CHANNEL_CONNECTORS } from '@/lib/business-context';
import { SEO_FIELD_LABELS, WEBSITE_PLATFORMS } from '@/lib/website-platforms';
import { getAdapter } from '@/server/websites/registry';

/**
 * The platform registry and the adapters stay in step. Adding a platform is
 * meant to be one registry entry plus one adapter: these catch the half-done
 * version of that.
 */
describe('website platform registry', () => {
  const available = WEBSITE_PLATFORMS.filter((p) => p.status === 'available');

  it('has WordPress and Shopify available (phase 1)', () => {
    expect(available.map((p) => p.id)).toEqual(expect.arrayContaining(['wordpress', 'shopify']));
  });

  it.each(available.map((p) => [p.id]))('%s has an adapter', (id) => {
    expect(getAdapter(id)?.id).toBe(id);
  });

  it('never hands out an adapter for a platform that is not available', () => {
    for (const p of WEBSITE_PLATFORMS.filter((x) => x.status !== 'available')) expect(getAdapter(p.id)).toBeNull();
    expect(getAdapter('nope')).toBeNull();
  });

  it.each(available.map((p) => [p.id]))('a connected %s site counts as the Blog channel', (id) => {
    expect(CHANNEL_CONNECTORS.Blog).toContain(id);
  });

  it('states SEO support for every field on every platform, with a reason where it is not native', () => {
    for (const p of WEBSITE_PLATFORMS) {
      expect(Object.keys(p.seo).sort()).toEqual(Object.keys(SEO_FIELD_LABELS).sort());
      if (p.status === 'available') {
        for (const [field, s] of Object.entries(p.seo)) {
          if (s.support === 'plugin' || s.support === 'fallback') expect(s.note, `${p.id}.${field}`).toBeTruthy();
        }
      }
    }
  });

  it('explains a platform with no API instead of calling it "coming soon"', () => {
    const sq = WEBSITE_PLATFORMS.find((p) => p.id === 'squarespace')!;
    expect(sq.status).toBe('no_api');
    expect(sq.limitations.join(' ')).toMatch(/no way to create a blog post/);
  });
});
