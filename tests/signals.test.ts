import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  canonicalUrl,
  corroborate,
  matchContext,
  signalToEvidence,
  textKey,
  type NormalizedSignal,
} from '@/lib/signals';
import { signalInputSchema } from '@/lib/opportunities';
import {
  normalizeAnalytics,
  normalizeBusinessContext,
  normalizeCompetitors,
  normalizeMemory,
  normalizeTrends,
} from '@/server/signals/normalize';
import { mergeBatch } from '@/server/signals/signal.service';
import { buildBusinessContext } from '@/server/business-context/build';

/**
 * The signal aggregation layer: every source normalised to one shape, each
 * signal keeping its source and record, associated with the business, and
 * de-duplicated. The database round trip is `pnpm verify:signals`.
 */

const NOW = new Date('2026-10-02T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const digest = (
  id: string,
  items: Record<string, unknown>[],
  date = daysAgo(2),
) => ({
  id,
  date,
  payload: {
    items,
    summary: '',
    recommendations: [],
    hashtags: [],
    seasonal: [],
    competitorMentions: [],
  },
});
const trendItem = (o: Record<string, unknown> = {}) => ({
  id: 'news:1',
  title: 'SaaS pricing proves marketing needs a seat at the table',
  url: 'https://www.thedrum.com/news/saas-pricing?utm_source=feed',
  source: 'news',
  sourceLabel: 'The Drum',
  score: 42,
  publishedAt: daysAgo(3).toISOString(),
  aiSummary: 'Why pricing is now a marketing problem.',
  suggestedAngle: 'Own the pricing narrative.',
  ...o,
});

describe('dedupe keys', () => {
  it('treats the same story at a different URL spelling as one', () => {
    expect(
      canonicalUrl(
        'https://www.thedrum.com/news/saas-pricing/?utm_source=x&utm_medium=y',
      ),
    ).toBe(canonicalUrl('http://thedrum.com/news/saas-pricing'));
    expect(canonicalUrl('not a url')).toBeNull();
  });

  it('ignores case and punctuation in text keys', () => {
    expect(textKey('Acme cut prices — again!')).toBe(
      textKey('acme CUT prices again'),
    );
  });
});

describe('trends', () => {
  it('normalises a digest item with its source, record, time and reliability', () => {
    const [s] = normalizeTrends([digest('d1', [trendItem()])]);
    expect(s).toMatchObject({
      source: 'TRENDS',
      kind: 'TREND_ITEM',
      refId: 'd1:news:1',
      reliability: 'MEDIUM',
      reliabilityReason: 'Reported by a news outlet',
      strength: 42,
      metadata: { trendSource: 'news', sourceLabel: 'The Drum' },
    });
    expect(s?.observedAt).toEqual(daysAgo(3));
    expect(s?.expiresAt).toEqual(new Date(daysAgo(3).getTime() + 14 * 86_400_000));
  });

  it('copes with an older digest that lacks newer fields', () => {
    const [s] = normalizeTrends([
      digest('old', [
        {
          id: 'r:1',
          title: 'Old item',
          url: '',
          source: 'reddit',
          score: 1,
          aiSummary: '',
        },
      ]),
    ]);
    expect(s).toMatchObject({
      title: 'Old item',
      summary: 'Old item',
      reliability: 'LOW',
    });
    expect(s?.observedAt).toEqual(daysAgo(2)); // falls back to the digest date
  });

  it('makes the same story in two digests one signal with two sightings', () => {
    const merged = mergeBatch(
      normalizeTrends([
        digest('d1', [trendItem()]),
        digest(
          'd2',
          [
            trendItem({
              id: 'news:9',
              url: 'https://thedrum.com/news/saas-pricing',
            }),
          ],
          daysAgo(1),
        ),
      ]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sightings).toEqual(['d1:news:1', 'd2:news:9']);
  });
});

describe('competitors', () => {
  const competitor = (summary: Record<string, unknown>) => ({
    id: 'comp1',
    name: 'Acme Coffee',
    snapshots: [
      {
        id: 'snap1',
        capturedAt: daysAgo(4),
        changesSummary: {
          hasChanges: true,
          news: [],
          skipped: [],
          model: 'x',
          capturedAt: '',
          ...summary,
        },
      },
    ],
  });

  it('turns each observed change into its own signal, linked to the snapshot', () => {
    const out = normalizeCompetitors([
      competitor({
        pricing: 'Cut the starter plan from $20 to $15',
        homepage: 'Now leads with “cheapest beans in town”',
        news: [
          {
            title: 'Acme raises Series A',
            url: 'https://news.example/acme-a',
            source: 'TechNews',
          },
        ],
      }),
    ]);
    expect(out.map((s) => s.title)).toEqual([
      'Acme Coffee changed its homepage',
      'Acme Coffee changed its pricing',
      'Acme Coffee in the news: Acme raises Series A',
    ]);
    expect(
      out.every((s) => s.refId === 'snap1' && s.source === 'COMPETITORS'),
    ).toBe(true);
    expect(out[1]).toMatchObject({
      reliability: 'HIGH',
      reliabilityReason: 'Observed directly on their pricing page',
    });
    expect(out[2]).toMatchObject({
      reliability: 'MEDIUM',
      reliabilityReason: 'Reported by TechNews',
    });
    expect(out[0]?.contextMatches).toEqual(['competitor:Acme Coffee']);
  });

  it('ignores a snapshot with nothing in it', () => {
    expect(normalizeCompetitors([competitor({ hasChanges: false })])).toEqual(
      [],
    );
  });
});

describe('analytics', () => {
  const report = (
    id: string,
    start: number,
    metrics: Record<string, unknown>,
  ) => ({
    id,
    periodStart: daysAgo(start),
    periodEnd: daysAgo(start - 7),
    summary: `Report ${id}`,
    metrics,
  });

  it('signals real movement between periods, and ignores noise', () => {
    const out = normalizeAnalytics([
      report('r2', 7, {
        totalEngagement: 361,
        postsPublished: 3,
        outreachSent: 10,
      }),
      report('r1', 14, {
        totalEngagement: 258,
        postsPublished: 2,
        outreachSent: 4,
      }),
    ]);
    expect(out.map((s) => s.title)).toEqual([
      'Total engagement up 40%',
      'Outreach sent up 150%',
    ]);
    expect(out[0]).toMatchObject({
      refId: 'r2',
      reliability: 'HIGH',
      metadata: { metric: 'totalEngagement', from: 258, to: 361 },
    });
  });

  it('does not invent a trend from a single period', () => {
    const out = normalizeAnalytics([report('r1', 7, { totalEngagement: 361 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'Your latest results',
      reliability: 'MEDIUM',
    });
    expect(out[0]?.reliabilityReason).toContain('no earlier period');
  });
});

describe('marketing memory', () => {
  const row = (o: Record<string, unknown>) => ({
    id: 'm1',
    insightType: 'CONTENT_FORMAT',
    insight: 'Carousels outperform text posts',
    confidence: 'MEDIUM',
    sampleSize: 24,
    supportingDataSummary: {},
    generatedAt: daysAgo(5),
    ...o,
  });

  it('carries the insight’s own confidence, and trusts what the user confirmed', () => {
    expect(normalizeMemory([row({})])[0]).toMatchObject({
      reliability: 'MEDIUM',
      strength: 24,
      refId: 'm1',
    });
    expect(
      normalizeMemory([
        row({
          confidence: 'LOW',
          supportingDataSummary: { editedByUser: true },
        }),
      ])[0],
    ).toMatchObject({
      reliability: 'HIGH',
      reliabilityReason: 'Learned from your results and confirmed by you',
    });
  });

  it('leaves out the "not enough data yet" note', () => {
    expect(
      normalizeMemory([
        row({ supportingDataSummary: { status: 'insufficient' } }),
      ]),
    ).toEqual([]);
  });
});

describe('business context', () => {
  const ctx = (goalsAgeDays: number) =>
    buildBusinessContext(
      {
        company: {
          id: 'c1',
          name: 'Verdant',
          website: null,
          industry: 'Coffee',
          brandVoiceNotes: null,
          brandVoiceProfile: null,
          preferences: {
            business: {
              description: 'We roast single-origin coffee in small batches.',
            },
            marketingProfile: {
              marketMode: 'B2C',
              audience: 'Home brewers',
              goals: '200 subscribers',
              channels: ['Instagram'],
            },
            factMeta: {
              'objectives.goals': {
                sourceType: 'user_provided',
                capturedAt: daysAgo(goalsAgeDays).toISOString(),
              },
            },
          },
        },
        campaigns: [
          {
            name: 'Holiday boxes',
            status: 'ACTIVE',
            goal: 'Sell 300 boxes',
            targetAudience: 'Gift buyers',
            themes: ['gifting'],
            endDate: new Date('2026-12-20'),
            updatedAt: daysAgo(2),
          },
        ],
        connections: {
          connectorIds: [],
          linkedInConnected: false,
          lastSyncedAt: null,
        },
        market: {
          competitors: [
            { name: 'Acme Coffee', url: null, trackingEnabled: true },
          ],
          trendConfig: {
            keywords: ['specialty coffee'],
            competitorNames: [],
            geoCountry: null,
            geoRegion: null,
            geoCity: null,
            language: 'en',
          },
        },
      },
      NOW,
    );

  it('turns running campaigns, the goal and unconnected channels into signals', () => {
    const out = normalizeBusinessContext(ctx(5), NOW);
    expect(out.map((s) => s.title)).toEqual([
      'Campaign running: Holiday boxes',
      'Current goal',
      'Instagram is not connected',
    ]);
    expect(out[0]?.expiresAt).toEqual(new Date('2026-12-20'));
    expect(out[1]).toMatchObject({
      reliability: 'HIGH',
      reliabilityReason: 'Stated by the business',
    });
  });

  it('marks an out-of-date goal as a weak signal', () => {
    expect(normalizeBusinessContext(ctx(120), NOW)[1]).toMatchObject({
      reliability: 'LOW',
      reliabilityReason: 'Stated, but out of date',
    });
  });

  it('associates a signal with the parts of the business it relates to', () => {
    const c = ctx(5);
    expect(
      matchContext(
        { title: 'Acme Coffee drops prices on specialty coffee', summary: '' },
        c,
      ).sort(),
    ).toEqual([
      'competitor:Acme Coffee',
      'industry:Coffee',
      'keyword:specialty coffee',
    ]);
    expect(
      matchContext(
        { title: 'Interest rates rise', summary: 'Markets react' },
        c,
      ),
    ).toEqual([]);
  });
});

describe('corroboration and consumption', () => {
  it('raises reliability one step for each extra independent sighting', () => {
    expect(corroborate('LOW', 1)).toEqual({ reliability: 'LOW', note: null });
    expect(corroborate('LOW', 2)).toEqual({
      reliability: 'MEDIUM',
      note: 'seen 2 times',
    });
    expect(corroborate('HIGH', 5).reliability).toBe('HIGH');
  });

  it('does not count the same record twice', () => {
    const s = normalizeTrends([
      digest('d1', [trendItem()]),
    ])[0] as NormalizedSignal;
    expect(mergeBatch([s, s])[0]?.sightings).toEqual(['d1:news:1']);
  });

  it('hands opportunity detection valid evidence that keeps its signal link', () => {
    const ev = signalToEvidence({
      id: 'sig_1',
      source: 'TRENDS',
      kind: 'TREND_ITEM',
      title: 'SaaS pricing',
      summary: 'Why pricing matters',
      url: 'https://thedrum.com/x',
      refId: 'd1:news:1',
      observedAt: NOW,
      reliability: 'MEDIUM',
    });
    expect(signalInputSchema.safeParse(ev).success).toBe(true);
    expect(ev).toMatchObject({
      kind: 'TREND_ITEM',
      refId: 'd1:news:1',
      signalId: 'sig_1',
    });
  });
});
