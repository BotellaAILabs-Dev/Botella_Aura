import { describe, it, expect } from 'vitest';

import {
  CURATED_FEEDS,
  googleTopicUrl,
  industryFeeds,
  resolveGeo,
} from '@/server/trends/sources/rss';
import type { TrendFetchContext } from '@/server/trends/types';

/**
 * Which news a workspace is shown.
 *
 * The review found that trends "were not appropriately localized for the
 * target market" and that some sources were not verified. Both were true, and
 * both were concrete rather than vague:
 *
 *   - The two Google News headline feeds were hardcoded to hl=en-US&gl=US,
 *     so every workspace outside the United States was shown US headlines —
 *     while the per-keyword searches beside them were correctly localised.
 *   - The curated feed list was a technology reading list (TechCrunch, The
 *     Verge, Ars Technica, VentureBeat, Wired) ingested for every workspace,
 *     whatever the business sold. With no keywords configured those feeds
 *     WERE the digest, which is how a distillery ended up with items it had
 *     no use for.
 */

const ctx = (over: Partial<TrendFetchContext> = {}): TrendFetchContext => ({
  keywords: [],
  subreddits: [],
  rssFeeds: [],
  competitorNames: [],
  ...over,
});

describe('news locale', () => {
  it('follows the workspace’s configured country', () => {
    const india = googleTopicUrl('BUSINESS', resolveGeo(ctx({ country: 'IN' })));
    expect(india).toContain('gl=IN');
    expect(india).toContain('ceid=IN:en');
    expect(india).not.toContain('gl=US');

    const uk = googleTopicUrl('NATION', resolveGeo(ctx({ country: 'GB', language: 'en' })));
    expect(uk).toContain('gl=GB');
    expect(uk).toContain('hl=en-GB');
  });

  it('defaults to the US only when nothing is configured', () => {
    expect(googleTopicUrl('BUSINESS', resolveGeo(ctx()))).toContain('gl=US');
  });

  it('normalises whatever the config holds', () => {
    const geo = resolveGeo(ctx({ country: 'in', language: 'EN-GB' }));
    expect(geo.country).toBe('IN');
    expect(geo.language).toBe('en');
  });

  it('carries the city and region as a location hint', () => {
    const geo = resolveGeo(ctx({ city: 'Hyderabad', region: 'Telangana' }));
    expect(geo.location).toBe('Hyderabad Telangana');
    expect(resolveGeo(ctx()).location).toBe('');
  });
});

describe('industry press', () => {
  it('gives a drinks business drinks press, not technology press', () => {
    const feeds = industryFeeds(ctx({ industry: 'Bourbon distillery' }));
    const labels = feeds.map((f) => f.label);
    expect(labels).toContain('Food Dive');
    expect(labels).not.toContain('TechCrunch');
  });

  it('still gives a software business technology press', () => {
    const labels = industryFeeds(ctx({ industry: 'B2B SaaS' })).map((f) => f.label);
    expect(labels).toContain('TechCrunch');
  });

  it('reads the keywords when the industry is vague', () => {
    const labels = industryFeeds(
      ctx({ industry: null, keywords: ['craft whiskey', 'tasting room'] }),
    ).map((f) => f.label);
    expect(labels).toContain('Food Dive');
  });

  it('gives an unmatched business nothing rather than something irrelevant', () => {
    // This is the important one. Returning a technology feed to a florist is
    // worse than returning nothing: it fills the digest with plausible items
    // that are not about them, and those became off-topic posts.
    expect(industryFeeds(ctx({ industry: 'Artisan florist' }))).toEqual([]);
    expect(industryFeeds(ctx())).toEqual([]);
  });

  it('matches on a whole word, not a fragment', () => {
    // "aid" must not match /\bai\b/, "techie" must not be read as "tech".
    expect(industryFeeds(ctx({ industry: 'Hearing aid retailer' })).map((f) => f.label)).not.toContain(
      'TechCrunch',
    );
  });

  it('never returns more than a digest can use', () => {
    const many = industryFeeds(
      ctx({ industry: 'restaurant tech software for retail healthcare' }),
    );
    expect(many.length).toBeLessThanOrEqual(4);
  });
});

describe('the always-on feeds', () => {
  it('are about marketing, which applies to every workspace', () => {
    // Anything industry-specific belongs in industryFeeds, behind a match.
    expect(CURATED_FEEDS.length).toBeLessThanOrEqual(3);
    const urls = CURATED_FEEDS.map((f) => f.url).join(' ');
    for (const gone of ['techcrunch', 'theverge', 'arstechnica', 'venturebeat', 'wired']) {
      expect(urls).not.toContain(gone);
    }
  });

  it('are all https', () => {
    for (const f of [...CURATED_FEEDS, ...industryFeeds(ctx({ industry: 'saas food retail health' }))]) {
      expect(f.url.startsWith('https://')).toBe(true);
    }
  });
});
