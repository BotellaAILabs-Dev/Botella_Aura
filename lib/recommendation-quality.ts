import { unsupportedNumbers } from '@/lib/ai-opportunity-detection';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import {
  LOW_CONFIDENCE_BLOCKER,
  MIN_EVIDENCE,
  integrationAvailable,
} from '@/lib/recommendation-rules';
import {
  OPEN_RECOMMENDATION_STATUSES,
  recommendationContentSchema,
  type RecommendationStatus,
  type RecommendationType,
} from '@/lib/recommendations';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';

/**
 * RECOMMENDATION QUALITY — the check every recommendation passes right before
 * it is shown, however it was written (engine template, AI model, or a
 * person's edits) and however things have changed since (its opportunity
 * rejected, its evidence expired, the business profile edited).
 *
 * Eight checks, each pass / warn / fail with its reason:
 *
 *   schema            the defined Recommendation schema
 *   business_context  what the business does is known; no topic it avoids;
 *                     no figure that no source contains; no competitor it
 *                     does not track
 *   evidence          present, traceable to a signal or source, current,
 *                     enough of the right kind (MIN_EVIDENCE)
 *   opportunity       linked to a real opportunity of this business that is
 *                     still open (or accepted), sharing its evidence
 *   actionability     a concrete action — not "consider…" — that can be
 *                     carried out
 *   expected_outcome  stated, specific, no promised results
 *   channel           one Aura supports, that the business uses
 *   confidence        stated honestly: low confidence, or confidence higher
 *                     than its evidence's reliability, is not "trusted"
 *
 * VERDICT
 *   trusted       every check passes
 *   needs_review  shown, clearly marked, with what to check — never as trusted
 *   blocked       not shown: unsupported, invented or contradicted
 *
 * Pure and client-safe; loaded by server/recommendations/quality.service.ts.
 */

export const QUALITY_CHECKS = [
  'schema',
  'business_context',
  'evidence',
  'opportunity',
  'actionability',
  'expected_outcome',
  'channel',
  'confidence',
] as const;
export type QualityCheck = (typeof QUALITY_CHECKS)[number];

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type QualityVerdict = 'trusted' | 'needs_review' | 'blocked';

export interface QualityInput {
  rec: {
    id: string;
    type: RecommendationType;
    status: RecommendationStatus;
    title: string;
    summary: string;
    action: string;
    steps: string[];
    rationale: string;
    expectedOutcome: string;
    outcomeMetric: string | null;
    channel: string | null;
    contentType: string | null;
    audience: string | null;
    details: unknown;
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    blockers: string[];
  };
  evidence: {
    label: string;
    detail: string;
    url: string | null;
    refId: string | null;
    signalId: string | null;
    opportunitySignalId: string | null;
    /** The signal's source, when it came through one. */
    source: string | null;
    reliability: 'LOW' | 'MEDIUM' | 'HIGH' | null;
    current: boolean;
  }[];
  /** Null when no opportunity of this business is linked. */
  opportunity: {
    id: string;
    status: string;
    title: string;
    summary: string;
    rationale: string | null;
    /** Signals the opportunity was built from. */
    signalIds: string[];
    /** Its evidence rows (OpportunitySignal ids). */
    evidenceIds: string[];
  } | null;
  business: {
    name: string;
    description: string | null;
    offerings: string | null;
    goals: string | null;
    audience: string | null;
    /** Where it publishes. */
    channels: string[];
    /** Topics its brand voice says to avoid. */
    avoid: string[];
    /** Competitors it tracks or names. */
    competitors: string[];
  };
  now?: Date;
}

export interface QualityReport {
  verdict: QualityVerdict;
  checks: { check: QualityCheck; status: CheckStatus; reasons: string[] }[];
  /** Why it is blocked (failures), in words. */
  problems: string[];
  /** What to check before trusting it (warnings), in words. */
  warnings: string[];
  checkedAt: string;
}

const VAGUE_ACTION =
  /^\s*(consider|think about|explore|look into|leverage|try to|maybe|perhaps|focus on improving|work on)\b|\bsynerg|\bas appropriate\b|\bif possible\b/i;
const PROMISED_RESULT =
  /\bguarantee(d|s)?\b|\bdefinitely\b|\bcertainly will\b|\bwill (double|triple|10x)\b|\b100% (sure|certain|success)\b|\bovernight\b|\bgo(es)? viral\b|\bskyrocket/i;
const GENERIC_OUTCOMES = [
  /^progress on this opportunity\.?$/i,
  /^results recover\.?$/i,
];
const MEASURABLE =
  /\d|engagement|comments?|saves?|shares?|clicks?|sign-?ups?|subscri|bookings?|leads?|sales|orders|visits|traffic|replies|reach|followers|conversions?|revenue|enquir|inquir|position|hear|recover/i;
const NEEDS_CHANNEL: RecommendationType[] = [
  'CONTENT',
  'CAMPAIGN',
  'COMPETITIVE_RESPONSE',
];

const has = (v: string | null | undefined) => Boolean(v && v.trim());

export function validateRecommendation(input: QualityInput): QualityReport {
  const { rec: r, evidence, opportunity: o, business: b } = input;
  const now = input.now ?? new Date();
  const out: Record<QualityCheck, { status: CheckStatus; reasons: string[] }> =
    Object.fromEntries(
      QUALITY_CHECKS.map((c) => [
        c,
        { status: 'pass' as CheckStatus, reasons: [] as string[] },
      ]),
    ) as never;
  const fail = (c: QualityCheck, why: string) => {
    out[c].status = 'fail';
    out[c].reasons.push(why);
  };
  const warn = (c: QualityCheck, why: string) => {
    if (out[c].status === 'pass') out[c].status = 'warn';
    out[c].reasons.push(why);
  };
  const details =
    r.details && typeof r.details === 'object'
      ? (r.details as Record<string, unknown>)
      : {};
  const written = [
    r.title,
    r.summary,
    r.action,
    ...r.steps,
    r.rationale,
    r.expectedOutcome,
  ].join('\n');

  // --- schema --------------------------------------------------------------
  const parsed = recommendationContentSchema.safeParse({
    type: r.type,
    title: r.title,
    summary: r.summary,
    action: r.action,
    steps: r.steps,
    rationale: r.rationale,
    expectedOutcome: r.expectedOutcome,
    outcomeMetric: r.outcomeMetric,
    channel: r.channel,
    contentType: r.contentType,
    audience: r.audience,
    details,
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 4)) {
      fail('schema', plainSchemaIssue(i));
    }
  }

  // --- business context ----------------------------------------------------
  if (!has(b.description) && !has(b.offerings)) {
    fail(
      'business_context',
      'Aura does not know what the business does or sells, so it cannot vouch for any suggestion',
    );
  }
  const lower = written.toLowerCase();
  for (const topic of b.avoid) {
    const t = topic.trim().toLowerCase();
    if (t.length >= 3 && lower.includes(t)) {
      fail(
        'business_context',
        `mentions “${topic}”, a topic the business avoids`,
      );
    }
  }
  const sources = [
    b.description ?? '',
    b.offerings ?? '',
    b.goals ?? '',
    b.audience ?? '',
    o?.title ?? '',
    o?.summary ?? '',
    o?.rationale ?? '',
    ...evidence.map((e) => `${e.label} ${e.detail}`),
  ].join('\n');
  const invented = unsupportedNumbers(written, sources, now);
  if (invented.length) {
    fail(
      'business_context',
      `states ${invented.join(', ')}, which none of its evidence or the business profile contains`,
    );
  }
  const competitor =
    typeof details.competitor === 'string' ? details.competitor : null;
  if (
    competitor &&
    !b.competitors.some((c) => c.toLowerCase() === competitor.toLowerCase()) &&
    !sources.toLowerCase().includes(competitor.toLowerCase())
  ) {
    fail(
      'business_context',
      `names ${competitor}, a competitor the business does not track`,
    );
  }

  // --- evidence ------------------------------------------------------------
  if (evidence.length === 0) {
    fail('evidence', 'it has no evidence');
  } else {
    const traceable = evidence.filter(
      (e) => e.signalId || e.opportunitySignalId || e.refId || e.url,
    );
    if (traceable.length === 0) {
      fail(
        'evidence',
        'none of its evidence can be traced to a signal or a source',
      );
    } else if (traceable.length < evidence.length) {
      warn(
        'evidence',
        `${evidence.length - traceable.length} piece(s) of evidence cannot be traced to a source`,
      );
    }
    const current = evidence.filter((e) => e.current);
    if (current.length === 0) {
      warn('evidence', 'none of its evidence is current any more');
    }
    const need = MIN_EVIDENCE[r.type];
    const usable = current.filter(
      (e) =>
        !need.sources ||
        (e.source !== null && (need.sources as string[]).includes(e.source)),
    );
    if (current.length > 0 && usable.length < need.count) {
      warn('evidence', `needs ${need.description}; has ${usable.length}`);
    }
  }

  // --- opportunity ---------------------------------------------------------
  const open = OPEN_RECOMMENDATION_STATUSES.includes(r.status);
  if (!o) {
    fail('opportunity', 'it is not linked to an opportunity of this business');
  } else {
    if (open && !ACTIVE_STATUSES.includes(o.status as never)) {
      fail(
        'opportunity',
        `its opportunity is ${o.status.toLowerCase()} — the business has already answered it`,
      );
    }
    const shared = evidence.some(
      (e) =>
        (e.opportunitySignalId &&
          o.evidenceIds.includes(e.opportunitySignalId)) ||
        (e.signalId && o.signalIds.includes(e.signalId)),
    );
    if (evidence.length > 0 && !shared) {
      warn('opportunity', 'none of its evidence comes from its opportunity');
    }
  }

  // --- actionability -------------------------------------------------------
  if (r.action.trim().length < 15) {
    fail('actionability', 'it does not say what to do');
  } else if (VAGUE_ACTION.test(r.action)) {
    warn('actionability', `“${r.action.slice(0, 60)}” is too vague to act on`);
  }
  if (NEEDS_CHANNEL.includes(r.type) && !r.channel) {
    fail(
      'actionability',
      'it asks for content but names nowhere to publish it',
    );
  }
  const otherBlockers = r.blockers.filter((x) => x !== LOW_CONFIDENCE_BLOCKER);
  for (const x of otherBlockers) warn('actionability', x.replace(/\.$/, ''));

  // --- expected outcome ----------------------------------------------------
  const outcome = r.expectedOutcome.trim();
  if (outcome.length < 10) {
    fail('expected_outcome', 'it does not say what it should achieve');
  } else if (PROMISED_RESULT.test(outcome) || PROMISED_RESULT.test(r.title)) {
    fail('expected_outcome', 'it promises a result no one can guarantee');
  } else if (GENERIC_OUTCOMES.some((g) => g.test(outcome))) {
    warn('expected_outcome', 'its expected outcome is generic');
  } else if (!r.outcomeMetric && !MEASURABLE.test(outcome)) {
    warn('expected_outcome', 'its expected outcome cannot be measured');
  }

  // --- channel -------------------------------------------------------------
  if (r.channel) {
    if (!(CONTENT_CHANNELS as readonly string[]).includes(r.channel)) {
      fail('channel', `${r.channel} is not a channel Aura supports`);
    } else if (r.type === 'CHANNEL') {
      if (!integrationAvailable(r.channel)) {
        warn('channel', `Aura cannot connect ${r.channel} yet`);
      }
    } else if (!b.channels.includes(r.channel)) {
      warn('channel', `the business has not said it publishes on ${r.channel}`);
    }
  }

  // --- confidence ----------------------------------------------------------
  if (r.confidence === 'LOW') {
    warn('confidence', 'Aura is not confident in it');
  }
  const reliabilities = evidence.map((e) => e.reliability).filter(Boolean);
  if (
    r.confidence === 'HIGH' &&
    reliabilities.length > 0 &&
    reliabilities.every((x) => x === 'LOW')
  ) {
    warn(
      'confidence',
      'it claims high confidence, but all its evidence is of low reliability',
    );
  }

  const checks = QUALITY_CHECKS.map((check) => ({ check, ...out[check] }));
  const problems = checks
    .filter((c) => c.status === 'fail')
    .flatMap((c) => c.reasons);
  const warnings = checks
    .filter((c) => c.status === 'warn')
    .flatMap((c) => c.reasons);
  return {
    verdict: problems.length
      ? 'blocked'
      : warnings.length
        ? 'needs_review'
        : 'trusted',
    checks,
    problems,
    warnings,
    checkedAt: now.toISOString(),
  };
}

const FIELD_WORDS: Record<string, string> = {
  title: 'headline',
  summary: 'summary',
  action: 'action',
  steps: 'steps',
  rationale: 'reasoning',
  expectedOutcome: 'expected outcome',
  outcomeMetric: 'metric',
  channel: 'channel',
  contentType: 'format',
  audience: 'audience',
  type: 'kind of recommendation',
};

/** A schema problem in words a person can read — never the validator's own. */
function plainSchemaIssue(i: {
  path: (string | number)[];
  code: string;
  type?: string;
}): string {
  const field = FIELD_WORDS[String(i.path[0] ?? '')] ?? 'content';
  switch (i.code) {
    case 'too_small':
      return i.type === 'array'
        ? `it has no ${field}`
        : `its ${field} is empty`;
    case 'too_big':
      return i.type === 'array'
        ? `it has too many ${field}`
        : `its ${field} is too long`;
    case 'invalid_enum_value':
      return `its ${field} is not one Aura recognises`;
    case 'invalid_type':
      return `its ${field} is missing or malformed`;
    default:
      return `its ${field} does not follow the recommendation format`;
  }
}

/** One line on why a blocked recommendation was held back. */
export function heldBackReason(report: QualityReport): string {
  // The most specific explanation first; a format problem only if that is all.
  const specific = report.checks
    .filter((c) => c.status === 'fail' && c.check !== 'schema')
    .flatMap((c) => c.reasons);
  const first =
    specific[0] ?? report.problems[0] ?? 'it failed a quality check';
  return first.charAt(0).toUpperCase() + first.slice(1) + '.';
}
