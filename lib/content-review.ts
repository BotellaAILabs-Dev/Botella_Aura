import { z } from 'zod';

import type { QualityIssue } from '@/lib/content-quality';
import type { FactCheckReport } from '@/lib/fact-check';
import type {
  ComplianceCategory,
  ComplianceReport,
} from '@/lib/compliance-policy';

/**
 * The AI Reviewer: a separate review step that evaluates generated content
 * before it enters the approval workflow. Pure and client-safe — the service
 * (server/content/review.service.ts) gathers the inputs and stores the result.
 *
 * Independent from generation:
 *   - the reviewer has its own instructions, not the writer's; it sees the
 *     finished piece and what it was meant to achieve, never the writing
 *     prompt;
 *   - it returns scores and issues only — its output has no place for copy,
 *     so it cannot rewrite the piece, and nothing it says is applied to the
 *     body. Regeneration is a separate, explicit step a person asks for.
 *
 * Every dimension is judged by the reviewer model, the deterministic rules
 * (lib/content-quality.ts), the fact check (lib/fact-check.ts), or several of
 * them. A rule breach always fails; an AI opinion alone never fails a piece on
 * legal or factual grounds — it sends it to a person.
 */

export const REVIEW_VERSION = 1;

export const REVIEW_DIMENSIONS = [
  'relevance',
  'accuracy',
  'brand_voice',
  'audience_fit',
  'channel_fit',
  'clarity',
  'cta',
  'completeness',
  'recommendation_alignment',
  'compliance',
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const DIMENSION_INFO: Record<
  ReviewDimension,
  {
    label: string;
    /** What the reviewer is asked. */
    question: string;
    /** Weight in the overall score. */
    weight: number;
    /**
     * Legal or factual: the reviewer model can flag it for a person, but only
     * the rules and the fact check can fail it.
     */
    critical: boolean;
  }
> = {
  relevance: {
    label: 'Relevance',
    question:
      'Is it about the topic and opportunity it was written for, and useful to this business now?',
    weight: 1,
    critical: false,
  },
  accuracy: {
    label: 'Accuracy',
    question:
      'Are its facts, figures, names and dates consistent with the business details and evidence given? Does it invent anything?',
    weight: 1.5,
    critical: true,
  },
  brand_voice: {
    label: 'Brand voice',
    question:
      'Does it sound like this brand — its tone, vocabulary and formatting — and avoid what the brand avoids?',
    weight: 1,
    critical: false,
  },
  audience_fit: {
    label: 'Audience fit',
    question:
      'Is it written for the stated audience, at the right level, about what they care about?',
    weight: 1,
    critical: false,
  },
  channel_fit: {
    label: 'Channel fit',
    question:
      'Does it follow the format and channel conventions (length, structure, hashtags, line breaks)?',
    weight: 0.75,
    critical: false,
  },
  clarity: {
    label: 'Clarity',
    question:
      'Is it clear, specific and easy to read, without filler, repetition or machine-sounding phrases?',
    weight: 1,
    critical: false,
  },
  cta: {
    label: 'Call to action',
    question:
      'Is there a clear, concrete next step that matches the brief (or, if none is expected, does it end well)?',
    weight: 0.75,
    critical: false,
  },
  completeness: {
    label: 'Completeness',
    question:
      'Does it have every part the format needs and cover the key message, with nothing left as a placeholder?',
    weight: 0.75,
    critical: false,
  },
  recommendation_alignment: {
    label: 'Recommendation alignment',
    question:
      'Does it carry out the recommended action and key message, and serve the expected outcome?',
    weight: 1,
    critical: false,
  },
  compliance: {
    label: 'Compliance',
    question:
      'Could anything be a compliance problem — alcohol marketing rules, misleading or unsubstantiated claims, topics the brand avoids, regulated promises?',
    weight: 1.5,
    critical: true,
  },
};

/**
 * Quality thresholds. Dimensions are scored 1–5 by the reviewer and shown as
 * 0–100 (1 = 0, 3 = 50, 5 = 100).
 */
export const REVIEW_THRESHOLDS = {
  /** A dimension at or above this passes. */
  dimensionPass: 75,
  /** A dimension below this fails (at or above it, it needs review). */
  dimensionFail: 50,
  /** The weighted overall score needed to pass. */
  overallPass: 70,
  /** Below this the piece fails, whatever its dimensions say. */
  overallFail: 50,
} as const;

/** pass — ready for approval · review_required — a person must look · fail — must be fixed or regenerated. */
export type ReviewStatus = 'pass' | 'review_required' | 'fail';
export type DimensionVerdict = 'pass' | 'review' | 'fail' | 'not_assessed';
export type IssueSeverity = 'blocker' | 'major' | 'minor';
export type ReviewSource = 'reviewer' | 'rules' | 'fact_check' | 'policy';

export interface ReviewIssue {
  dimension: ReviewDimension;
  severity: IssueSeverity;
  message: string;
  /** The words in the piece it is about — only kept when they really appear. */
  quote: string | null;
  /** What would fix it. A suggestion only: never applied automatically. */
  suggestion: string | null;
  source: ReviewSource;
}

export interface DimensionResult {
  dimension: ReviewDimension;
  label: string;
  /** 0–100; null when nothing could assess it. */
  score: number | null;
  verdict: DimensionVerdict;
  /** One line on why. */
  summary: string;
  assessedBy: ReviewSource[];
}

export interface ContentReview {
  version: typeof REVIEW_VERSION;
  status: ReviewStatus;
  /** Weighted 0–100 over the assessed dimensions; null if none was. */
  score: number | null;
  dimensions: DimensionResult[];
  issues: ReviewIssue[];
  /** The dimensions that failed — what must change. */
  failed: ReviewDimension[];
  /** Why a person must look before it is approved (empty when it passed). */
  humanReviewReasons: string[];
  /** The reviewer's one-paragraph verdict, when it ran. */
  summary: string | null;
  reviewer: {
    /** The independent model review ran. */
    ran: boolean;
    model: string | null;
    /** Why it did not run, in words a person can act on. */
    unavailable: string | null;
  };
  /** The body this review is of — a different body means it is out of date. */
  bodyHash: string;
  reviewedAt: string;
  durationMs: number;
  trigger: ReviewTrigger;
  thresholds: typeof REVIEW_THRESHOLDS;
  /** Set when an approver confirmed they looked at what needed review. */
  acknowledgedBy?: string | null;
  /**
   * The compliance & policy checks (lib/compliance-policy.ts), and the
   * fingerprint of the rules they ran under — a review made under other rules
   * is out of date.
   */
  compliance?: ComplianceReport | null;
  policyHash?: string | null;
}

export type ReviewTrigger =
  'generated' | 'regenerated' | 'manual' | 'submitted' | 'approval';

// ---------------------------------------------------------------------------
// Reviewer input and output
// ---------------------------------------------------------------------------

/** What the reviewer is given: the finished piece, and what it was for. */
export interface ReviewerInput {
  format: string;
  channel: string | null;
  /** The piece as a reader sees it. */
  text: string;
  cta: string;
  hashtags: string[];
  limits: { maxChars: number; idealMaxChars: number } | null;
  business: {
    name: string;
    industry: string | null;
    description: string | null;
    offerings: string | null;
  };
  audience: string | null;
  goal: string | null;
  brandVoice: {
    summary: string | null;
    tone: string[];
    phrases: string[];
    avoid: string[];
  } | null;
  /** The recommendation and brief, when it was made from one. */
  recommendation: {
    title: string;
    action: string | null;
    keyMessage: string | null;
    reason: string | null;
    expectedOutcome: string | null;
    ctaExpected: boolean | null;
    ctaGuidance: string | null;
    ctaDestination: string | null;
    evidence: string[];
  } | null;
  /** The person's own request, when not from a recommendation. */
  request: string | null;
  /** Business facts the piece may draw on. */
  facts: string;
  alcohol: boolean;
}

const score15 = z.coerce.number().int().min(1).max(5);

/** What the reviewer model must return. No field carries copy. */
export const reviewerOutputSchema = z.object({
  dimensions: z
    .array(
      z.object({
        dimension: z.enum(REVIEW_DIMENSIONS),
        score: score15,
        reason: z.string().max(600).default(''),
      }),
    )
    .max(REVIEW_DIMENSIONS.length * 2),
  issues: z
    .array(
      z.object({
        dimension: z.enum(REVIEW_DIMENSIONS),
        severity: z.enum(['blocker', 'major', 'minor']).catch('minor'),
        problem: z.string().min(1).max(500),
        quote: z.string().max(500).nullish(),
        fix: z.string().max(500).nullish(),
      }),
    )
    .max(20)
    .default([]),
  summary: z.string().max(800).default(''),
});
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

/** The reviewer's own instructions — not the writer's. */
export const REVIEWER_SYSTEM = [
  'You are an independent content reviewer for a marketing team. You did not write this piece and you do not rewrite it.',
  'Judge the finished piece against what it was meant to achieve, strictly and fairly, as an experienced editor would before it goes to the business owner for approval.',
  'Score each dimension from 1 to 5: 5 = ready to publish, 4 = good with small nits, 3 = needs a person to look, 2 = clearly falls short, 1 = wrong or unusable.',
  'Report concrete issues. Quote the exact words from the piece an issue is about. Suggest a fix in a sentence, but never write replacement copy.',
  'Only judge accuracy against the business details and evidence given: anything not in them that a reader would take as fact is an issue.',
  'For compliance, flag anything that could breach advertising or alcohol marketing rules, or that makes misleading, health or guaranteed claims. You flag; a person decides.',
  'Respond with ONLY valid JSON matching the requested shape. No markdown, no prose.',
].join('\n');

const OUTPUT_SHAPE = `{"dimensions":[{"dimension":"${REVIEW_DIMENSIONS.join('"|"')}","score":1-5,"reason":"one sentence"}],"issues":[{"dimension":"...","severity":"blocker"|"major"|"minor","problem":"what is wrong","quote":"exact words from the piece or null","fix":"how to fix it, one sentence"}],"summary":"two sentences at most"}`;

export function buildReviewerPrompt(input: ReviewerInput): string {
  const r = input.recommendation;
  const v = input.brandVoice;
  const lines = [
    `TASK: Review this ${input.format}${input.channel ? ` for ${input.channel}` : ''} on every dimension below.`,
    '',
    'DIMENSIONS:',
    ...REVIEW_DIMENSIONS.map((d) => `- ${d}: ${DIMENSION_INFO[d].question}`),
    '',
    `BUSINESS: ${input.business.name}${input.business.industry ? ` (${input.business.industry})` : ''}`,
    input.business.description
      ? `What it does: ${input.business.description}`
      : '',
    input.business.offerings
      ? `What it sells: ${input.business.offerings}`
      : '',
    input.audience ? `AUDIENCE: ${input.audience}` : '',
    input.goal ? `GOAL: ${input.goal}` : '',
    v
      ? [
          'BRAND VOICE:',
          v.summary ? `- ${v.summary}` : '',
          v.tone.length ? `- Tone: ${v.tone.join(', ')}` : '',
          v.phrases.length ? `- Phrases it uses: ${v.phrases.join('; ')}` : '',
          v.avoid.length ? `- Never mentions: ${v.avoid.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    r
      ? [
          `WRITTEN FOR THE RECOMMENDATION: ${r.title}`,
          r.action ? `- Recommended action: ${r.action}` : '',
          r.keyMessage ? `- Key message: ${r.keyMessage}` : '',
          r.reason ? `- Why: ${r.reason}` : '',
          r.expectedOutcome ? `- Expected outcome: ${r.expectedOutcome}` : '',
          r.ctaExpected === false
            ? '- Call to action: not required'
            : `- Call to action: expected${r.ctaGuidance ? ` — ${r.ctaGuidance}` : ''}${r.ctaDestination ? ` (to ${r.ctaDestination})` : ''}`,
          r.evidence.length
            ? `- Evidence:\n${r.evidence.map((e) => `  · ${e}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : input.request
        ? `WRITTEN FOR THIS REQUEST: ${input.request}`
        : '',
    input.facts ? `BUSINESS FACTS THE PIECE MAY USE:\n${input.facts}` : '',
    input.limits
      ? `FORMAT LIMITS: up to ${input.limits.maxChars} characters (ideally under ${input.limits.idealMaxChars}).`
      : '',
    input.alcohol
      ? 'THIS IS AN ALCOHOL BUSINESS: apply responsible alcohol marketing rules (adults only, no excess, no health or social-success claims, no driving).'
      : '',
    '',
    `THE PIECE:\n"""\n${input.text}\n"""`,
    input.cta
      ? `Its call to action: ${input.cta}`
      : 'It has no separate call to action.',
    input.hashtags.length ? `Its hashtags: ${input.hashtags.join(' ')}` : '',
    '',
    `Return JSON of this exact shape (one entry per dimension, all ${REVIEW_DIMENSIONS.length}): ${OUTPUT_SHAPE}`,
  ];
  return lines.filter((l) => l !== '').join('\n');
}

// ---------------------------------------------------------------------------
// Combining the signals
// ---------------------------------------------------------------------------

/** Which dimension each deterministic rule speaks to. */
const RULE_DIMENSION: Record<QualityIssue['code'], ReviewDimension> = {
  'alcohol-minors': 'compliance',
  'alcohol-excess': 'compliance',
  'alcohol-health': 'compliance',
  'alcohol-social': 'compliance',
  'alcohol-driving': 'compliance',
  'avoid-topic': 'compliance',
  'too-long': 'channel_fit',
  long: 'channel_fit',
  hashtags: 'channel_fit',
  'unsupported-claim': 'accuracy',
  'unsupported-number': 'accuracy',
  'facts-changed': 'accuracy',
  'robotic-phrase': 'clarity',
  repetition: 'clarity',
  'no-cta': 'cta',
};

/** Dimensions the rules and fact check cover even without the reviewer model. */
const RULE_COVERED: ReviewDimension[] = [
  'accuracy',
  'compliance',
  'channel_fit',
  'cta',
  'completeness',
];

export interface ReviewSignals {
  /** The deterministic checks on the body as it stands (no fixes applied). */
  rules: QualityIssue[];
  /** The rules' CTA check applies to this format/brief. */
  ctaChecked: boolean;
  factCheck: Pick<FactCheckReport, 'status' | 'claims'> | null;
  /** Parts the format requires that are missing or empty. */
  missing: string[];
  /** The reviewer model's answer, or null when it did not run. */
  ai: ReviewerOutput | null;
  aiModel: string | null;
  aiUnavailable: string | null;
  /** The piece's text — a reviewer quote must appear in it to be kept. */
  text: string;
  bodyHash: string;
  trigger: ReviewTrigger;
  /** The compliance & policy checks; their rules and fact-check findings come in above. */
  compliance?: ComplianceReport | null;
  now?: Date;
  durationMs?: number;
}

/** Which review dimension each compliance category speaks to. */
const COMPLIANCE_DIMENSION: Record<ComplianceCategory, ReviewDimension> = {
  prohibited_claim: 'compliance',
  disclaimer: 'compliance',
  business: 'compliance',
  manual_review: 'compliance',
  channel: 'channel_fit',
  cta: 'cta',
  factual: 'accuracy',
};

const toScore = (s: number) => Math.round(((s - 1) / 4) * 100);
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”"'’‘]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function verdictFor(score: number): DimensionVerdict {
  if (score >= REVIEW_THRESHOLDS.dimensionPass) return 'pass';
  if (score >= REVIEW_THRESHOLDS.dimensionFail) return 'review';
  return 'fail';
}

const RANK: Record<DimensionVerdict, number> = {
  not_assessed: -1,
  pass: 0,
  review: 1,
  fail: 2,
};
const worse = (a: DimensionVerdict, b: DimensionVerdict) =>
  RANK[a] >= RANK[b] ? a : b;

export function combineReview(s: ReviewSignals): ContentReview {
  const issues: ReviewIssue[] = [];
  const text = norm(s.text);

  type Acc = {
    score: number | null;
    verdict: DimensionVerdict;
    summary: string;
    by: Set<ReviewSource>;
    /** The worst a rule or the fact check allows. */
    ruleVerdict: DimensionVerdict;
    ruleNote: string | null;
  };
  const acc = Object.fromEntries(
    REVIEW_DIMENSIONS.map((d) => [
      d,
      {
        score: null,
        verdict: 'not_assessed',
        summary: '',
        by: new Set(),
        ruleVerdict: 'not_assessed',
        ruleNote: null,
      } as Acc,
    ]),
  ) as Record<ReviewDimension, Acc>;

  // 1. The deterministic rules.
  for (const d of RULE_COVERED) {
    if (d === 'cta' && !s.ctaChecked) continue;
    acc[d].by.add('rules');
    acc[d].ruleVerdict = 'pass';
  }
  for (const i of s.rules) {
    const d = RULE_DIMENSION[i.code];
    if (!d) continue;
    acc[d].by.add('rules');
    const v: DimensionVerdict = i.severity === 'block' ? 'fail' : 'pass';
    acc[d].ruleVerdict = worse(acc[d].ruleVerdict, v);
    if (i.severity === 'block') acc[d].ruleNote ??= i.message;
    issues.push({
      dimension: d,
      severity: i.severity === 'block' ? 'blocker' : 'minor',
      message: i.message,
      quote: null,
      suggestion: null,
      source: 'rules',
    });
  }
  if (s.missing.length) {
    acc.completeness.ruleVerdict = 'fail';
    acc.completeness.ruleNote = `Missing: ${s.missing.join(', ')}.`;
    issues.push({
      dimension: 'completeness',
      severity: 'blocker',
      message: `The piece is missing ${s.missing.join(', ')}.`,
      quote: null,
      suggestion: 'Regenerate it, or add the missing parts.',
      source: 'rules',
    });
  }

  // 2. The fact check.
  if (s.factCheck) {
    acc.accuracy.by.add('fact_check');
    for (const c of s.factCheck.claims) {
      if (c.status === 'supported') continue;
      const blocker = c.mustFix;
      acc.accuracy.ruleVerdict = worse(
        acc.accuracy.ruleVerdict,
        blocker ? 'fail' : 'review',
      );
      if (blocker) acc.accuracy.ruleNote ??= `“${c.text}” ${c.reason}`;
      else acc.accuracy.ruleNote ??= 'Some claims could not be verified.';
      issues.push({
        dimension: 'accuracy',
        severity: blocker ? 'blocker' : 'major',
        message: c.reason,
        quote: c.text,
        suggestion: blocker
          ? 'Correct it to match the business details or evidence, or remove it.'
          : 'Check it is true before approving.',
        source: 'fact_check',
      });
    }
    if (acc.accuracy.ruleVerdict === 'not_assessed')
      acc.accuracy.ruleVerdict = 'pass';
  }

  // 2b. The workspace's compliance policy and the built-in packs. (Its
  // findings from the rules and the fact check arrived above.)
  if (s.compliance) {
    acc.compliance.by.add('policy');
    if (acc.compliance.ruleVerdict === 'not_assessed')
      acc.compliance.ruleVerdict = 'pass';
    for (const f of s.compliance.findings) {
      if (f.source !== 'built_in' && f.source !== 'workspace') continue;
      const d = COMPLIANCE_DIMENSION[f.category];
      acc[d].by.add('policy');
      if (acc[d].ruleVerdict === 'not_assessed') acc[d].ruleVerdict = 'pass';
      if (f.outcome !== 'warn') {
        acc[d].ruleVerdict = worse(
          acc[d].ruleVerdict,
          f.outcome === 'fail' ? 'fail' : 'review',
        );
        acc[d].ruleNote ??= f.message;
      }
      issues.push({
        dimension: d,
        severity:
          f.outcome === 'fail'
            ? 'blocker'
            : f.outcome === 'review'
              ? 'major'
              : 'minor',
        message: f.message,
        quote: f.quote,
        suggestion: f.fix,
        source: 'policy',
      });
    }
  }

  // 3. The independent reviewer.
  if (s.ai) {
    const seen = new Set<ReviewDimension>();
    for (const d of s.ai.dimensions) {
      if (seen.has(d.dimension)) continue;
      seen.add(d.dimension);
      const a = acc[d.dimension];
      a.by.add('reviewer');
      a.score = toScore(d.score);
      a.summary = d.reason;
      let v = verdictFor(a.score);
      // The model alone never fails a piece on legal or factual grounds.
      if (v === 'fail' && DIMENSION_INFO[d.dimension].critical) v = 'review';
      a.verdict = v;
    }
    for (const i of s.ai.issues) {
      const quote =
        i.quote && text.includes(norm(i.quote)) ? i.quote.trim() : null;
      const critical = DIMENSION_INFO[i.dimension].critical;
      issues.push({
        dimension: i.dimension,
        // A reviewer "blocker" on a legal/factual point goes to a person.
        severity: i.severity === 'blocker' && critical ? 'major' : i.severity,
        message: i.problem.trim(),
        quote,
        suggestion: i.fix?.trim() || null,
        source: 'reviewer',
      });
      // A blocker the reviewer found where it scored the dimension well still counts.
      if (i.severity === 'blocker') {
        acc[i.dimension].by.add('reviewer');
        acc[i.dimension].verdict = worse(
          acc[i.dimension].verdict,
          critical ? 'review' : 'fail',
        );
      }
    }
  }

  // 4. One verdict per dimension: the worst of the reviewer and the rules.
  const dimensions: DimensionResult[] = REVIEW_DIMENSIONS.map((d) => {
    const a = acc[d];
    let verdict = a.verdict;
    let score = a.score;
    let summary = a.summary;
    if (a.ruleVerdict !== 'not_assessed') {
      if (verdict === 'not_assessed') {
        verdict = a.ruleVerdict;
        score =
          a.ruleVerdict === 'pass' ? 100 : a.ruleVerdict === 'review' ? 50 : 0;
        summary =
          a.ruleNote ??
          (d === 'accuracy'
            ? 'Every checked claim matches the business details or evidence.'
            : 'Passes Aura’s rules.');
      } else if (RANK[a.ruleVerdict] > RANK[verdict]) {
        verdict = a.ruleVerdict;
        summary = a.ruleNote ?? summary;
      }
      if (a.ruleVerdict === 'fail') score = Math.min(score ?? 0, 25);
      else if (a.ruleVerdict === 'review') score = Math.min(score ?? 50, 50);
    }
    if (verdict === 'not_assessed')
      summary = 'Not assessed — the reviewer did not run.';
    return {
      dimension: d,
      label: DIMENSION_INFO[d].label,
      score,
      verdict,
      summary,
      assessedBy: [...a.by],
    };
  });

  // 5. The overall score and status.
  const assessed = dimensions.filter((d) => d.score !== null);
  const weight = assessed.reduce(
    (n, d) => n + DIMENSION_INFO[d.dimension].weight,
    0,
  );
  const score = weight
    ? Math.round(
        assessed.reduce(
          (n, d) => n + d.score! * DIMENSION_INFO[d.dimension].weight,
          0,
        ) / weight,
      )
    : null;

  const failed = dimensions
    .filter((d) => d.verdict === 'fail')
    .map((d) => d.dimension);
  const reasons: string[] = [];
  for (const d of dimensions) {
    if (d.verdict !== 'review') continue;
    // The dimension's main issue says more than the score's one-line reason.
    const issue = issues.find(
      (i) => i.dimension === d.dimension && i.severity !== 'minor',
    );
    reasons.push(
      `${d.label}: ${issue?.message ?? (d.summary || 'needs a person to check')}`,
    );
  }
  if (!s.ai) {
    reasons.push(
      `The independent reviewer did not run${s.aiUnavailable ? ` (${s.aiUnavailable})` : ''} — relevance, voice, audience and alignment were not assessed.`,
    );
  }
  const ai = s.ai;
  if (ai && dimensions.some((d) => d.verdict === 'not_assessed')) {
    reasons.push(
      `The reviewer did not score ${dimensions
        .filter((d) => d.verdict === 'not_assessed')
        .map((d) => d.label.toLowerCase())
        .join(', ')}.`,
    );
  }

  let status: ReviewStatus;
  if (
    failed.length ||
    (score !== null && score < REVIEW_THRESHOLDS.overallFail)
  ) {
    status = 'fail';
  } else if (
    reasons.length ||
    score === null ||
    score < REVIEW_THRESHOLDS.overallPass
  ) {
    status = 'review_required';
    if (
      score !== null &&
      score < REVIEW_THRESHOLDS.overallPass &&
      !reasons.length
    ) {
      reasons.push(
        `Overall score ${score} is under the ${REVIEW_THRESHOLDS.overallPass} needed to pass.`,
      );
    }
  } else {
    status = 'pass';
  }
  if (status === 'fail' && !failed.length && score !== null) {
    reasons.unshift(
      `Overall score ${score} is under the ${REVIEW_THRESHOLDS.overallFail} minimum.`,
    );
  }

  const order: Record<IssueSeverity, number> = {
    blocker: 0,
    major: 1,
    minor: 2,
  };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    version: REVIEW_VERSION,
    status,
    score,
    dimensions,
    issues,
    failed,
    humanReviewReasons: status === 'pass' ? [] : reasons,
    summary: s.ai?.summary?.trim() || null,
    reviewer: {
      ran: Boolean(s.ai),
      model: s.ai ? s.aiModel : null,
      unavailable: s.ai ? null : s.aiUnavailable,
    },
    bodyHash: s.bodyHash,
    reviewedAt: (s.now ?? new Date()).toISOString(),
    durationMs: s.durationMs ?? 0,
    trigger: s.trigger,
    thresholds: REVIEW_THRESHOLDS,
    compliance: s.compliance ?? null,
    policyHash: s.compliance?.policyHash ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stable fingerprint of a body (FNV-1a over canonical JSON). Client-safe. */
export function bodyHash(body: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  const str = JSON.stringify(canon(body ?? null));
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The review still describes this body — and, when the rules in force are
 * given, was made under them (a policy change makes every review out of date).
 */
export function isReviewCurrent(
  review:
    | Pick<ContentReview, 'bodyHash' | 'version' | 'policyHash'>
    | null
    | undefined,
  body: unknown,
  policyHash?: string,
): boolean {
  return Boolean(
    review &&
    review.version === REVIEW_VERSION &&
    review.bodyHash === bodyHash(body) &&
    (policyHash === undefined || review.policyHash === policyHash),
  );
}

/** The issues as feedback for a regeneration the person asked for. */
export function reviewAsFeedback(review: ContentReview): string {
  const relevant = review.issues.filter((i) => i.severity !== 'minor');
  const list = (relevant.length ? relevant : review.issues).slice(0, 10);
  return [
    'An independent review found these problems. Fix every one; keep what works, the facts and the voice.',
    ...list.map(
      (i) =>
        `- [${DIMENSION_INFO[i.dimension].label}] ${i.message}${i.quote ? ` (“${i.quote}”)` : ''}${i.suggestion ? ` — ${i.suggestion}` : ''}`,
    ),
  ].join('\n');
}

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pass: 'Review passed',
  review_required: 'Needs human review',
  fail: 'Review failed',
};
