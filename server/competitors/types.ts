/**
 * Shared types for Competitor Intelligence (Sprint 4, Module 1).
 * All signal is gathered from LEGITIMATE PUBLIC sources only:
 *   - website change detection (robots-respecting fetch + diff)
 *   - public news / RSS (keyless)
 *   - GitHub public API
 * The public LinkedIn Company Page feed is intentionally NOT read — no official
 * API scope exists for it, and scraping is forbidden (see sources/linkedin.ts).
 */

/** A public news / RSS item mentioning a competitor. */
export interface CompetitorNewsItem {
  title: string;
  url: string;
  source?: string;
  publishedAt?: string; // ISO
}

/** Public GitHub activity as a proxy for product movement. */
export interface GitHubSignal {
  org: string;
  publicRepos?: number;
  followers?: number;
  latestRelease?: {
    repo: string;
    name: string;
    tagName: string;
    url: string;
    publishedAt: string;
  } | null;
  recentlyPushed: {
    repo: string;
    url: string;
    pushedAt: string;
    stars: number;
  }[];
}

/**
 * Structured, human-readable change summary stored on each CompetitorSnapshot.
 * `model` is 'claude-opus-4-8' when Claude summarized the diff, or 'none' when
 * we fell back to a deterministic description (no API key / no textual change).
 */
export interface ChangesSummary {
  hasChanges: boolean;
  /** Human-readable summary of what changed on the homepage, if anything. */
  homepage?: string;
  /** Human-readable summary of pricing-page changes, if anything. */
  pricing?: string;
  news: CompetitorNewsItem[];
  github?: GitHubSignal | null;
  /** Which public sources were skipped this run and why (transparency). */
  skipped: string[];
  model: string;
  capturedAt: string; // ISO
}

/** One competitor's section within a weekly report. */
export interface CompetitorReportEntry {
  competitorId: string;
  competitor: string;
  newLaunches: string[];
  pricingChanges: string[];
  notableActivity: string[];
  strategicTakeaway: string;
}

/** The full weekly report payload persisted on CompetitorReport.payload. */
export interface CompetitorReportPayload {
  competitors: CompetitorReportEntry[];
  /** Overall "what this means for you" synthesis across all competitors. */
  synthesis: string;
  weekStart: string; // ISO date
  weekEnd: string; // ISO date
  generatedAt: string; // ISO
  model: string; // 'claude-opus-4-8' | 'none'
}
