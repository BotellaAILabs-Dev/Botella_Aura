import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { graphUrl } from '@/lib/meta';
import { parseScopes } from '@/lib/connection-manager';
import { getFacebookContext } from '@/server/media/publishers/facebook';
import { getInstagramContext } from '@/server/media/publishers/instagram';

/**
 * Organic analytics for Meta V1 — "where supported":
 *
 *   always (permissions Aura already has)
 *     Facebook  reactions, comments, shares        pages_read_engagement
 *     Instagram likes, comments                    instagram_basic
 *   once the insights permissions are granted (App Review)
 *     Facebook  impressions, unique impressions, clicks   read_insights
 *     Instagram reach, views, shares, saves               instagram_manage_insights
 *
 * Read per published post (by the network's post id, stored at publish) and
 * saved as a PerformanceSnapshot (source META_API) — the same store every
 * other analytics source feeds, so reports and learning use it unchanged.
 * Posts are re-read for 30 days, at most every 6 hours.
 */

export const INSIGHTS_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const INSIGHTS_REFRESH_MS = 6 * 60 * 60_000;

export interface MetaPostMetrics {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  reposts?: number;
  clicks?: number;
  saves?: number;
  views?: number;
}

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const summaryCount = (v: unknown): number | undefined => num((v as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count);

/** Insights `data: [{ name, values: [{ value }] }]` → name → number. */
export function insightValues(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of ((data as { data?: unknown[] } | null)?.data ?? []) as { name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[]) {
    const v = num(row.values?.[0]?.value) ?? num(row.total_value?.value);
    if (row.name && v !== undefined) out[row.name] = v;
  }
  return out;
}

export async function facebookPostMetrics(args: { postId: string; pageToken: string; insights: boolean; fetchImpl?: Fetch }): Promise<{ metrics: MetaPostMetrics; detailed: boolean } | null> {
  const f = args.fetchImpl ?? fetch;
  const t = encodeURIComponent(args.pageToken);
  const base = await getJson(f, graphUrl(`${args.postId}?fields=shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)&access_token=${t}`));
  if (!base) return null;
  const metrics: MetaPostMetrics = {
    likes: summaryCount(base.reactions),
    comments: summaryCount(base.comments),
    reposts: num((base.shares as { count?: unknown } | undefined)?.count) ?? 0,
  };
  let detailed = false;
  if (args.insights) {
    const ins = insightValues(await getJson(f, graphUrl(`${args.postId}/insights?metric=post_impressions,post_impressions_unique,post_clicks&access_token=${t}`)));
    if (Object.keys(ins).length) {
      detailed = true;
      metrics.impressions = ins.post_impressions;
      metrics.reach = ins.post_impressions_unique;
      metrics.clicks = ins.post_clicks;
    }
  }
  return { metrics, detailed };
}

export async function instagramMediaMetrics(args: { mediaId: string; accessToken: string; insights: boolean; fetchImpl?: Fetch }): Promise<{ metrics: MetaPostMetrics; detailed: boolean } | null> {
  const f = args.fetchImpl ?? fetch;
  const t = encodeURIComponent(args.accessToken);
  const base = await getJson(f, graphUrl(`${args.mediaId}?fields=like_count,comments_count&access_token=${t}`));
  if (!base) return null;
  const metrics: MetaPostMetrics = { likes: num(base.like_count), comments: num(base.comments_count) };
  let detailed = false;
  if (args.insights) {
    const ins = insightValues(await getJson(f, graphUrl(`${args.mediaId}/insights?metric=reach,views,shares,saved&access_token=${t}`)));
    if (Object.keys(ins).length) {
      detailed = true;
      metrics.reach = ins.reach;
      metrics.views = ins.views;
      metrics.impressions = ins.views;
      metrics.reposts = ins.shares;
      metrics.saves = ins.saved;
    }
  }
  return { metrics, detailed };
}

export interface InsightsRunResult {
  checked: number;
  saved: number;
  /** Saved with impressions/reach (insights permissions granted). */
  detailed: number;
  /** No post id (published before ids were stored) or the network didn't answer. */
  skipped: number;
}

/** Read metrics for recent Facebook/Instagram posts and store them. */
export async function collectMetaInsights(args: { companyId?: string; now?: Date; limit?: number; fetchImpl?: Fetch } = {}): Promise<InsightsRunResult> {
  const now = args.now ?? new Date();
  const result: InsightsRunResult = { checked: 0, saved: 0, detailed: 0, skipped: 0 };
  const rows = await db.contentPublication.findMany({
    where: {
      status: 'PUBLISHED',
      platform: { in: ['FACEBOOK', 'INSTAGRAM'] },
      publishedAt: { gte: new Date(now.getTime() - INSIGHTS_WINDOW_MS) },
      ...(args.companyId ? { companyId: args.companyId } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: args.limit ?? 50,
  });
  const contexts = new Map<string, { fb: Awaited<ReturnType<typeof getFacebookContext>>; ig: Awaited<ReturnType<typeof getInstagramContext>>; scopes: string[] }>();

  for (const row of rows) {
    result.checked++;
    if (!row.externalId) {
      result.skipped++;
      continue;
    }
    const recent = await db.performanceSnapshot.findFirst({
      where: { contentDraftId: row.contentDraftId, source: 'META_API', capturedAt: { gte: new Date(now.getTime() - INSIGHTS_REFRESH_MS) }, metrics: { path: ['platform'], equals: row.platform } },
      select: { id: true },
    });
    if (recent) continue;
    let ctx = contexts.get(row.companyId);
    if (!ctx) {
      const conn = await db.connection.findUnique({ where: { companyId_connectorId: { companyId: row.companyId, connectorId: 'meta' } }, select: { scopes: true, scope: true } });
      ctx = {
        fb: await getFacebookContext(row.companyId).catch(() => null),
        ig: await getInstagramContext(row.companyId).catch(() => null),
        scopes: conn ? (conn.scopes.length ? conn.scopes : parseScopes(conn.scope)) : [],
      };
      contexts.set(row.companyId, ctx);
    }
    const read =
      row.platform === 'FACEBOOK'
        ? ctx.fb && (await facebookPostMetrics({ postId: row.externalId, pageToken: ctx.fb.pageAccessToken, insights: ctx.scopes.includes('read_insights'), fetchImpl: args.fetchImpl }))
        : ctx.ig && (await instagramMediaMetrics({ mediaId: row.externalId, accessToken: ctx.ig.accessToken, insights: ctx.scopes.includes('instagram_manage_insights'), fetchImpl: args.fetchImpl }));
    if (!read) {
      result.skipped++;
      continue;
    }
    await db.performanceSnapshot.create({
      data: {
        companyId: row.companyId,
        contentDraftId: row.contentDraftId,
        source: 'META_API',
        metrics: { ...read.metrics, platform: row.platform, postId: row.externalId, detailed: read.detailed } as Prisma.InputJsonObject,
        capturedAt: now,
      },
    });
    result.saved++;
    if (read.detailed) result.detailed++;
  }
  if (result.checked) logger.info('meta insights collected', { ...result });
  return result;
}
