/**
 * AI Marketing Advisor — campaign opportunities inspired by what competitors
 * and the market are actually doing.
 *
 * Every opportunity carries its `evidence`: the specific competitor move, trend
 * item, or learned insight it came from. An opportunity with no evidence is a
 * guess, and this module does not ship guesses.
 */
export type EvidenceKind =
  | 'competitor'
  | 'trend'
  | 'memory'
  | 'performance'
  | 'gap';

export interface OpportunityEvidence {
  kind: EvidenceKind;
  /** Short source label, e.g. the competitor or trend source name. */
  label: string;
  /** The specific observation. */
  detail: string;
  url?: string;
}

export type Rating = 'low' | 'medium' | 'high';

export interface CampaignOpportunity {
  id: string;
  title: string;
  /** The competitor whose activity prompted this, when applicable. */
  inspiredBy?: string;
  /** Why this is worth doing now. */
  rationale: string;
  /** The positioning angle — how to be different, not a copy. */
  angle: string;
  channels: string[];
  /** Three concrete pieces to create. */
  contentIdeas: string[];
  effort: Rating;
  impact: Rating;
  /** When to act, in plain words. */
  timing: string;
  evidence: OpportunityEvidence[];
}

/** Something competitors are consistently doing that this company is not. */
export interface CompetitiveGap {
  theme: string;
  observation: string;
  suggestion: string;
  competitors: string[];
}

export interface AdvisorCoverage {
  competitorsTracked: number;
  competitorSignals: number;
  trendItems: number;
  recentDrafts: number;
  memoryInsights: number;
  /** What we could not look at, and why. */
  skipped: string[];
}

export interface AdvisorPayload {
  generatedAt: string;
  model: string;
  summary: string;
  opportunities: CampaignOpportunity[];
  gaps: CompetitiveGap[];
  coverage: AdvisorCoverage;
}
