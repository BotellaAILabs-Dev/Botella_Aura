/**
 * Shared contracts for the Trend Intelligence pipeline.
 *
 * Every data source implements `TrendSource` and returns a normalized
 * `TrendItem[]`, so scoring, deduping, and the AI digest step are all
 * source-agnostic. Adding a new source (e.g. YouTube, Mastodon) later means
 * dropping one file in server/trends/sources/ that implements this interface —
 * nothing downstream changes.
 */

export type TrendSourceId = 'reddit' | 'hackernews' | 'news' | 'twitter';

/** A single normalized item from any source, before scoring. */
export interface TrendItem {
  /** Stable dedupe key, `${source}:${externalId}`. */
  id: string;
  source: TrendSourceId;
  /** Human label, e.g. "r/SaaS", "Hacker News", "Google News". */
  sourceLabel: string;
  title: string;
  url: string;
  /** Optional excerpt/selftext, trimmed. */
  summary?: string;
  author?: string;
  /** ISO 8601. Used for recency/time-decay scoring. */
  publishedAt: string;
  /** Normalized engagement signals (absent where a source doesn't expose them). */
  engagement: {
    points?: number;
    comments?: number;
  };
  /** Which configured keywords this item matched (populated during scoring). */
  matchedKeywords: string[];
}

/** Per-company configuration passed to every source on fetch. */
export interface TrendFetchContext {
  keywords: string[];
  subreddits: string[];
  rssFeeds: string[];
  competitorNames: string[];
  // --- Geo & scope (AI Trend Insights) ---
  /** ISO country code for news locale (e.g. "US"); null/empty = global. */
  country?: string | null;
  /** Region/state and city — appended to news queries as location hints. */
  region?: string | null;
  city?: string | null;
  /** UI language code (e.g. "en"). Defaults to English. */
  language?: string | null;
  /** Only surface items newer than this many days. */
  timeRangeDays?: number | null;
}

/** Contract every trend source implements. */
export interface TrendSource {
  readonly id: TrendSourceId;
  readonly label: string;
  /**
   * Whether this source can actually run (required env vars present, enabled
   * in the company's config). If false, the orchestrator skips it and the UI
   * shows a clear "not connected" state — we NEVER fabricate data for a source
   * that isn't configured (NON-NEGOTIABLE #5).
   */
  isConfigured(ctx: TrendFetchContext): boolean;
  fetchTrendItems(ctx: TrendFetchContext): Promise<TrendItem[]>;
}

/** A TrendItem after scoring, with the score breakdown for transparency. */
export interface ScoredTrendItem extends TrendItem {
  score: number;
  scoreBreakdown: {
    recency: number;
    engagement: number;
    relevance: number;
  };
}

/** The AI-enriched item stored in a digest. */
export interface DigestItem {
  id: string;
  title: string;
  url: string;
  source: TrendSourceId;
  sourceLabel: string;
  score: number;
  publishedAt: string;
  /** "Why this matters to you" — from Claude, or a deterministic fallback. */
  aiSummary: string;
  /** A suggested post angle/hook — from Claude, or a fallback. */
  suggestedAngle: string;
}

/** A relevant upcoming seasonal / event-based marketing moment. */
export interface SeasonalEvent {
  /** ISO date (YYYY-MM-DD) of the event this year. */
  date: string;
  /** Human label, e.g. "Black Friday", "World Environment Day". */
  name: string;
  /** Days from "now" until the event (>= 0). */
  daysUntil: number;
  /** A short, brand-neutral content angle for the moment. */
  angle: string;
}

/** A trend item that references one of the company's tracked competitors. */
export interface CompetitorMention {
  competitor: string;
  itemId: string;
  title: string;
  url: string;
  sourceLabel: string;
}

/** Full digest payload persisted to TrendDigest.payload (JSON). */
export interface DigestPayload {
  items: DigestItem[];
  generatedAt: string;
  /** The model used, or "fallback" when no ANTHROPIC_API_KEY is configured. */
  model: string;
  /** Per-source item counts that fed this digest (transparency + debugging). */
  sourceCounts: Partial<Record<TrendSourceId, number>>;
  /** Sources that were skipped because they weren't configured. */
  skippedSources: TrendSourceId[];
  // --- AI Trend Insights enhancements (all optional; older digests omit them) ---
  /** One-paragraph AI synthesis of today's themes ("what to pay attention to"). */
  summary?: string;
  /** A few concrete, prioritized recommendations for the week. */
  recommendations?: string[];
  /** Trending hashtags distilled from the items (without the leading #). */
  hashtags?: string[];
  /** Upcoming seasonal/event moments relevant to the company. */
  seasonal?: SeasonalEvent[];
  /** Trend items that mention a tracked competitor (lightweight comparison). */
  competitorMentions?: CompetitorMention[];
}
