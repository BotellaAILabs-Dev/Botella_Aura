import type { TrendSource, TrendSourceId } from '@/server/trends/types';
import { HackerNewsSource } from '@/server/trends/sources/hackernews';
import { RedditSource } from '@/server/trends/sources/reddit';
import { NewsSource } from '@/server/trends/sources/rss';
import { TwitterSource } from '@/server/trends/sources/twitter';

/** All known sources, keyed by id. Add a new connector here and nowhere else. */
export const ALL_SOURCES: Record<TrendSourceId, TrendSource> = {
  hackernews: new HackerNewsSource(),
  reddit: new RedditSource(),
  news: new NewsSource(),
  twitter: new TwitterSource(),
};

export type EnabledSourcesFlags = Partial<Record<TrendSourceId, boolean>>;

/** Sources the company has enabled in config (defaults to all-but-twitter). */
export function getEnabledSources(flags: EnabledSourcesFlags): TrendSource[] {
  return (Object.keys(ALL_SOURCES) as TrendSourceId[])
    .filter((id) => flags[id] !== false && !(id === 'twitter' && flags[id] !== true))
    .map((id) => ALL_SOURCES[id]);
}
