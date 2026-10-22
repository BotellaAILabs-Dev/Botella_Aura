import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { metaRequestedScopes, META_SCOPES } from '@/lib/meta';
import { facebookPostMetrics, instagramMediaMetrics } from '@/server/connectors/meta-insights.service';

/**
 * Insights stay off until Meta grants the permissions: the flag defaults off,
 * and without the granted scope the /insights endpoints are never called.
 */

function graph(responses: Record<string, unknown>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(responses).find((k) => u.includes(k));
    return new Response(JSON.stringify(key ? responses[key] : {}), { status: key ? 200 : 404 });
  });
}

describe('META_REQUEST_INSIGHTS', () => {
  it('is off unless exactly "true"', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      expect(metaRequestedScopes({ META_REQUEST_INSIGHTS: value })).toEqual([...META_SCOPES]);
    }
  });
});

describe('metrics without the insights permissions', () => {
  it('Facebook: basic counts only, /insights never called', async () => {
    const fetchImpl = graph({ 'p1?fields=': { shares: { count: 2 }, reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 1 } } } });
    const out = await facebookPostMetrics({ postId: 'p1', pageToken: 't', insights: false, fetchImpl });
    expect(out).toEqual({ metrics: { likes: 5, comments: 1, reposts: 2 }, detailed: false });
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/insights'))).toBe(false);
  });

  it('Instagram: basic counts only, /insights never called', async () => {
    const fetchImpl = graph({ 'm1?fields=': { like_count: 7, comments_count: 3 } });
    const out = await instagramMediaMetrics({ mediaId: 'm1', accessToken: 't', insights: false, fetchImpl });
    expect(out).toEqual({ metrics: { likes: 7, comments: 3 }, detailed: false });
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/insights'))).toBe(false);
  });

  it('a refused /insights call (permission missing) still keeps the basic counts', async () => {
    const fetchImpl = graph({ 'm1?fields=': { like_count: 7, comments_count: 3 } }); // /insights → 404
    const out = await instagramMediaMetrics({ mediaId: 'm1', accessToken: 't', insights: true, fetchImpl });
    expect(out).toEqual({ metrics: { likes: 7, comments: 3 }, detailed: false });
  });
});
