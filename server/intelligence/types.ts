/**
 * AI Marketing Intelligence — the unified health picture across campaigns,
 * leads, competitors, content, and brand.
 *
 * Every score carries `hasData` and `basis`: a 0 because nothing has been
 * published must be visually and semantically different from a 0 because the
 * work is performing badly. Scores without data are reported as unavailable,
 * never as zero.
 */
export interface ScoreBlock {
  /** 0–100, or null when there is nothing to measure. */
  score: number | null;
  /** False when the score could not be computed from real data. */
  hasData: boolean;
  /** One line explaining exactly what the number was computed from. */
  basis: string;
  /** What to do about it. */
  recommendation?: string;
  /** Supporting numbers for the UI. */
  detail?: Record<string, number | string>;
}

export interface MarketingPerformance {
  /** Setup completeness — always measurable, so a new workspace still scores. */
  foundations: ScoreBlock;
  campaign: ScoreBlock;
  leadGeneration: ScoreBlock;
  competitorVisibility: ScoreBlock;
  contentOutput: ScoreBlock;
  outreach: ScoreBlock;
}

export interface ContentPiece {
  draftId: string;
  title: string;
  type: string;
  status: string;
  publishedAt: string | null;
  qualityScore: number;
  hook: { score: number; text: string; strengths: string[]; weaknesses: string[] };
  readability: { score: number; gradeLevel: number; verdict: string };
  cta: { score: number; present: boolean; kind: string; notes: string[] };
  structure: { score: number; wordCount: number; hashtagCount: number; notes: string[] };
  prediction: { score: number; band: string; drivers: string[] };
  /** Real measured engagement when a performance snapshot exists. */
  actualEngagement: number | null;
}

export interface ContentIntelligence {
  /** Average AI content quality across analysed drafts. */
  quality: ScoreBlock;
  hookStrength: ScoreBlock;
  readability: ScoreBlock;
  ctaEffectiveness: ScoreBlock;
  engagementPrediction: ScoreBlock;
  /** Measured performance of published work. */
  performance: ScoreBlock;
  /** Per-piece breakdown, worst first — the work queue. */
  pieces: ContentPiece[];
  /** How well the prediction matched reality, when we can check. */
  predictionAccuracy: {
    checked: number;
    note: string;
  };
}

export interface ToneFinding {
  descriptor: string;
  /** Share of analysed pieces that actually read this way (0–1). */
  adherence: number;
  verdict: 'consistent' | 'drifting' | 'absent';
  note: string;
}

export interface BrandIntelligence {
  consistency: ScoreBlock;
  toneValidation: {
    hasProfile: boolean;
    findings: ToneFinding[];
    note: string;
  };
  vocabulary: {
    /** Brand vocabulary that is being used well. */
    onBrand: string[];
    /** Brand vocabulary the profile defines but content never uses. */
    underused: string[];
    /** Words appearing often in content that are not in the brand profile. */
    driftingInto: string[];
    /** Words the profile says to avoid that appear anyway. */
    violations: string[];
    recommendations: string[];
  };
}

export interface ImprovementSuggestion {
  area:
    | 'content'
    | 'brand'
    | 'leads'
    | 'competitors'
    | 'campaigns'
    | 'outreach'
    | 'setup';
  priority: 'high' | 'medium' | 'low';
  title: string;
  /** Why — referencing the specific number that triggered it. */
  rationale: string;
  action: string;
  /** Where in the app to go and do it. */
  href?: string;
  /**
   * Points the overall score would gain if this were fully fixed.
   *
   * This is what makes the ranking defensible. Priority used to be a flat
   * default, so every item read "medium" and the list could not answer its own
   * question — what to fix FIRST. Impact is weight x gap-to-target, computed
   * from the same weights that produce the headline score.
   */
  impact?: number;
  /** Plain-language version of `impact`, e.g. "+6 points on your score". */
  expectedImpact?: string;
}

/** One setup step and whether it is done — drives the first-run next action. */
export interface FoundationStepView {
  key: string;
  label: string;
  done: boolean;
  action: string;
  href: string;
}

export interface IntelligenceCoverage {
  draftsAnalysed: number;
  publishedAnalysed: number;
  performanceSnapshots: number;
  campaigns: number;
  leads: number;
  competitors: number;
  hasBrandProfile: boolean;
  /** What could not be measured, and why. */
  gaps: string[];
  /** Setup checklist, so the UI can show one concrete next step. */
  foundationSteps: FoundationStepView[];
  /** The single highest-value outstanding setup step, if any. */
  nextStep: FoundationStepView | null;
}

export interface IntelligencePayload {
  generatedAt: string;
  model: string;
  /** The headline 0–100 marketing health score, or null with no data. */
  overallScore: number | null;
  overallBasis: string;
  performance: MarketingPerformance;
  content: ContentIntelligence;
  brand: BrandIntelligence;
  suggestions: ImprovementSuggestion[];
  coverage: IntelligenceCoverage;
}
