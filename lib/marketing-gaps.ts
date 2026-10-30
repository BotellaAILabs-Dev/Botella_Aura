import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { productScore, type Product } from '@/lib/products';
import type { ContentTypeKey } from '@/lib/validations/content';
import type { CONTENT_CHANNELS } from '@/lib/validations/planner';

/**
 * Marketing gaps — specific things the business has stopped doing, or never
 * did, named in its own terms.
 *
 * The intelligence score says marketing health is 54; a business owner cannot
 * act on that. "You haven't posted about the Gift box in 4 months" they can.
 * Every gap here is plain logic over the business's own published posts and
 * its own Business Context (products, channels, formats), so each one can be
 * checked against the posts it cites, and comes with the post that closes it.
 *
 * Pure and client-safe; the service (server/intelligence/marketing-gaps.service.ts)
 * only loads the inputs.
 */

type Channel = (typeof CONTENT_CHANNELS)[number];

export interface GapPost {
  id: string;
  title: string | null;
  /** The post's full text, for spotting which products it is about. */
  text: string;
  type: ContentTypeKey;
  channel: Channel | null;
  publishedAt: Date;
  /** Latest engagement score, when the platform reported one. */
  engagement: number | null;
}

export interface GapInput {
  now: Date;
  products: readonly Product[];
  /** Where the business says it publishes. */
  preferredChannels: readonly Channel[];
  /** Formats it has enabled; empty means all. */
  enabledFormats: readonly ContentTypeKey[];
  /** Published posts, any order. */
  posts: readonly GapPost[];
}

export type GapKind =
  | 'no_posts'
  | 'product_never'
  | 'product_silent'
  | 'channel_silent'
  | 'cadence_drop'
  | 'format_rut'
  | 'format_underused';

export interface MarketingGap {
  /** Stable for the same gap, so it can be tracked and dismissed. */
  key: string;
  kind: GapKind;
  severity: 'high' | 'medium' | 'low';
  /** The gap, in one sentence a business owner would say. */
  title: string;
  /** What it is based on, checkable against the posts. */
  evidence: string;
  /** The post that closes it. */
  action: { label: string; brief: string; type: ContentTypeKey | null };
}

export const GAP_RULES = {
  /** A product unmentioned for this long is a gap. */
  productSilentDays: 60,
  /** A channel the business publishes on, silent for this long. */
  channelSilentDays: 30,
  /** Cadence: compare the last window with the one before. */
  cadenceWindowDays: 30,
  cadenceMinPrior: 4,
  /** Format rut: share of the recent posts in one format. */
  rutSample: 10,
  rutMinPosts: 8,
  rutShare: 0.8,
  /** Underused format: needs this many posts with engagement data. */
  perfMinPosts: 6,
  perfMinPerType: 2,
  perfLift: 1.5,
  perfMaxShare: 0.25,
  max: 6,
} as const;

const DAY = 86_400_000;

/** "9 days", "5 weeks", "4 months" — how a person would say it. */
export function sinceWords(days: number): string {
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  const months = Math.round(days / 30);
  return months >= 12 ? 'over a year' : `${months} months`;
}

/** The format that publishes to a channel, when Aura can write one. */
export const CHANNEL_FORMAT: Record<Channel, ContentTypeKey | null> = {
  LinkedIn: 'LINKEDIN_POST',
  Instagram: 'IMAGE_POST',
  X: 'TWEET_THREAD',
  Blog: 'BLOG',
  Newsletter: 'EMAIL',
  YouTube: null,
};

const RANK = { high: 0, medium: 1, low: 2 } as const;

/** A format's name mid-sentence: lower case, except names like LinkedIn. */
const lc = (t: ContentTypeKey) => {
  const label = CONTENT_TYPE_LABELS[t];
  return /^(LinkedIn|X )/.test(label) ? label : label.toLowerCase();
};

/** True when a post is about this product: it names it, or closely matches. */
export function mentions(post: GapPost, product: Product): boolean {
  const text = `${post.title ?? ''}\n${post.text}`;
  return productScore(product, text) >= 10;
}

export function findMarketingGaps(input: GapInput): MarketingGap[] {
  const { now } = input;
  const ageDays = (d: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY));
  const posts = [...input.posts].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  const gaps: MarketingGap[] = [];
  const formatOk = (t: ContentTypeKey | null) =>
    t !== null && (input.enabledFormats.length === 0 || input.enabledFormats.includes(t));

  if (posts.length === 0) {
    return [
      {
        key: 'no_posts',
        kind: 'no_posts',
        severity: 'high',
        title: 'Nothing has been published through Aura yet.',
        evidence: 'No published posts found, so Aura cannot tell what is working.',
        action: {
          label: 'Write your first post',
          brief: input.products[0]
            ? `An introduction to ${input.products[0].name}${input.products[0].audience ? ` for ${input.products[0].audience}` : ''}`
            : 'An introduction to what we do and who it is for',
          type: null,
        },
      },
    ];
  }

  // --- Products: never posted about, or not for a while --------------------
  for (const p of input.products) {
    const last = posts.find((post) => mentions(post, p));
    const brief = [
      `A post about ${p.name}`,
      p.audience && `for ${p.audience}`,
      p.benefit && `— why people choose it: ${p.benefit}`,
    ]
      .filter(Boolean)
      .join(' ');
    if (!last) {
      gaps.push({
        key: `product_never:${p.id}`,
        kind: 'product_never',
        severity: p.featured ? 'high' : 'medium',
        title: `You haven't posted about ${p.name} yet.`,
        evidence: `None of your ${posts.length} published posts mention ${p.name}.`,
        action: { label: `Write about ${p.name}`, brief, type: null },
      });
      continue;
    }
    const days = ageDays(last.publishedAt);
    if (days >= GAP_RULES.productSilentDays) {
      gaps.push({
        key: `product_silent:${p.id}`,
        kind: 'product_silent',
        severity: p.featured ? 'high' : 'medium',
        title: `You haven't posted about ${p.name} in ${sinceWords(days)}.`,
        evidence: `Last mentioned in “${last.title ?? 'a post'}” on ${last.publishedAt.toISOString().slice(0, 10)}.`,
        action: { label: `Write about ${p.name}`, brief, type: null },
      });
    }
  }

  // --- Channels the business publishes on, gone quiet ------------------------
  for (const channel of input.preferredChannels) {
    const type = CHANNEL_FORMAT[channel];
    const last = posts.find((post) => post.channel === channel);
    const days = last ? ageDays(last.publishedAt) : null;
    if (days !== null && days < GAP_RULES.channelSilentDays) continue;
    gaps.push({
      key: `channel_silent:${channel}`,
      kind: 'channel_silent',
      severity: 'medium',
      title:
        days === null
          ? `You publish on ${channel}, but nothing has gone out there through Aura.`
          : `Nothing on ${channel} in ${sinceWords(days)}.`,
      evidence:
        days === null
          ? `${channel} is one of the channels you publish on, with no published post.`
          : `Last ${channel} post: “${last!.title ?? 'untitled'}” on ${last!.publishedAt.toISOString().slice(0, 10)}.`,
      action: {
        label: `Write a ${channel} post`,
        brief: `A ${channel} post on what's new with us this month`,
        type: formatOk(type) ? type : null,
      },
    });
  }

  // --- Posting less than before ------------------------------------------------
  const w = GAP_RULES.cadenceWindowDays;
  const recent = posts.filter((p) => ageDays(p.publishedAt) < w).length;
  const prior = posts.filter((p) => {
    const d = ageDays(p.publishedAt);
    return d >= w && d < 2 * w;
  }).length;
  if (prior >= GAP_RULES.cadenceMinPrior && recent <= prior / 2) {
    gaps.push({
      key: 'cadence_drop',
      kind: 'cadence_drop',
      severity: recent === 0 ? 'high' : 'medium',
      title: `You posted ${recent} time${recent === 1 ? '' : 's'} in the last ${w} days, down from ${prior}.`,
      evidence: `${prior} posts between ${2 * w} and ${w} days ago; ${recent} since.`,
      action: { label: 'Plan the next two weeks', brief: 'Two weeks of posts to get back to our usual rhythm', type: null },
    });
  }

  // --- Stuck in one format --------------------------------------------------------
  const sample = posts.slice(0, GAP_RULES.rutSample);
  if (sample.length >= GAP_RULES.rutMinPosts) {
    const counts = new Map<ContentTypeKey, number>();
    for (const p of sample) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const alternative = (['CAROUSEL', 'IMAGE_POST', 'LINKEDIN_POST', 'BLOG'] as const).find(
      (t) => t !== top && formatOk(t),
    );
    if (n / sample.length >= GAP_RULES.rutShare && alternative) {
      gaps.push({
        key: `format_rut:${top}`,
        kind: 'format_rut',
        severity: 'low',
        title: `${n} of your last ${sample.length} posts were ${lc(top)}s.`,
        evidence: `Formats in your last ${sample.length} posts: ${[...counts.entries()]
          .map(([t, c]) => `${CONTENT_TYPE_LABELS[t]} ${c}`)
          .join(', ')}.`,
        action: {
          label: `Try a ${lc(alternative)}`,
          brief: `A ${lc(alternative)} on a topic that did well for us recently`,
          type: alternative,
        },
      });
    }
  }

  // --- A format that performs better but is rarely used ---------------------------
  const measured = posts.filter((p) => p.engagement !== null);
  if (measured.length >= GAP_RULES.perfMinPosts) {
    const avg = (xs: GapPost[]) => xs.reduce((s, p) => s + (p.engagement ?? 0), 0) / xs.length;
    const byType = new Map<ContentTypeKey, GapPost[]>();
    for (const p of measured) byType.set(p.type, [...(byType.get(p.type) ?? []), p]);
    let best: { type: ContentTypeKey; lift: number; share: number; n: number } | null = null;
    for (const [type, list] of byType) {
      if (list.length < GAP_RULES.perfMinPerType) continue;
      const others = measured.filter((p) => p.type !== type);
      if (!others.length) continue;
      const base = avg(others);
      if (base <= 0) continue;
      const lift = avg(list) / base;
      const share = list.length / measured.length;
      if (lift >= GAP_RULES.perfLift && share <= GAP_RULES.perfMaxShare && (!best || lift > best.lift)) {
        best = { type, lift, share, n: list.length };
      }
    }
    if (best && formatOk(best.type)) {
      const label = CONTENT_TYPE_LABELS[best.type];
      gaps.push({
        key: `format_underused:${best.type}`,
        kind: 'format_underused',
        severity: 'medium',
        title: `${label}s get ${best.lift.toFixed(1)}× the engagement of your other posts, but are only ${Math.round(best.share * 100)}% of what you publish.`,
        evidence: `Average engagement over ${measured.length} measured posts; ${best.n} were ${lc(best.type)}s.`,
        action: {
          label: `Write a ${lc(best.type)}`,
          brief: `A ${lc(best.type)} on a topic our audience responded to recently`,
          type: best.type,
        },
      });
    }
  }

  return gaps.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, GAP_RULES.max);
}

/** Where a gap's action opens Content Studio, with the brief filled in. */
export function gapHref(gap: MarketingGap): string {
  const q = new URLSearchParams({ brief: gap.action.brief });
  if (gap.action.type) q.set('type', gap.action.type);
  return `/dashboard/content/new?${q.toString()}`;
}
