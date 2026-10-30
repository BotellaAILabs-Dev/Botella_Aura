import type { ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import { findMarketingGaps, type GapPost, type MarketingGap } from '@/lib/marketing-gaps';
import type { ContentTypeKey } from '@/lib/validations/content';
import type { CONTENT_CHANNELS } from '@/lib/validations/planner';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { renderForManual } from '@/server/content/render';
import { engagementScore, type PerfMetrics } from '@/server/memory/metrics';

/**
 * Loads what lib/marketing-gaps.ts needs: the business's products, channels
 * and formats, and its published posts from the last year with their latest
 * engagement. Computed on request — it is one query and plain arithmetic, so
 * the gaps are never staler than the posts.
 */

type Channel = (typeof CONTENT_CHANNELS)[number];

const LOOKBACK_DAYS = 365;
const MAX_POSTS = 400;

const PLATFORM_CHANNEL: Record<string, Channel | null> = {
  LINKEDIN: 'LinkedIn',
  INSTAGRAM: 'Instagram',
  X: 'X',
  FACEBOOK: null,
};

/** Where a published post went, from its platform or else its format. */
export function postChannel(platform: string | null, type: ContentTypeKey): Channel | null {
  if (platform) return PLATFORM_CHANNEL[platform] ?? null;
  if (type === 'BLOG') return 'Blog';
  if (type === 'EMAIL') return 'Newsletter';
  if (type === 'TWEET_THREAD') return 'X';
  if (type === 'LINKEDIN_POST') return 'LinkedIn';
  return null;
}

export async function getMarketingGaps(
  companyId: string,
  now: Date = new Date(),
): Promise<MarketingGap[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const [ctx, drafts] = await Promise.all([
    getBusinessContext(companyId, { sections: [] }),
    db.contentDraft.findMany({
      where: { companyId, status: 'PUBLISHED', publishedAt: { gte: since, lte: now } },
      orderBy: { publishedAt: 'desc' },
      take: MAX_POSTS,
      select: {
        id: true,
        title: true,
        type: true,
        body: true,
        platform: true,
        publishedAt: true,
        performanceSnapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 1,
          select: { metrics: true },
        },
      },
    }),
  ]);
  if (!ctx) return [];

  const posts: GapPost[] = drafts.map((d) => {
    const type = d.type as ContentTypeKey;
    const snap = d.performanceSnapshots[0];
    return {
      id: d.id,
      title: d.title,
      text: renderForManual({ type: d.type, body: d.body } as ContentDraft),
      type,
      channel: postChannel(d.platform, type),
      publishedAt: d.publishedAt!,
      engagement: snap ? engagementScore((snap.metrics ?? {}) as PerfMetrics) : null,
    };
  });

  return findMarketingGaps({
    now,
    products: ctx.identity.products,
    preferredChannels: ctx.channels.preferred,
    enabledFormats: ctx.objectives.contentFormats,
    posts,
  });
}
