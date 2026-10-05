import { z } from 'zod';

import {
  ACTIVE_STATUSES,
  OPPORTUNITY_CONFIDENCES,
  OPPORTUNITY_PRIORITIES,
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_TYPES,
  SIGNAL_KINDS,
  type OpportunityConfidence,
  type OpportunityPriority,
  type OpportunitySource,
  type OpportunityStatus,
  type OpportunityType,
  type SignalKind,
} from '@/lib/opportunities';
import {
  SIGNAL_RELIABILITIES,
  SIGNAL_SOURCES,
  type SignalReliability,
  type SignalSource,
} from '@/lib/signals';

/**
 * Opportunity → Recommendation: the hand-off.
 *
 * An opportunity is something Aura noticed; a recommendation is what Aura
 * proposes the business DO about it. The recommendation engine (Sprint 8)
 * builds recommendations from opportunities, and this module fixes the
 * contract between the two so that engine can consume opportunities without
 * the opportunity model changing underneath it:
 *
 *   · WHAT IS PASSED — OpportunityHandoff: the opportunity itself, its
 *     assessment (confidence, priority, impact, effort), its evidence, the
 *     business context it relies on, and how it was detected. Versioned.
 *   · WHEN IT MAY BE PASSED — handoffEligibility: open, still relevant, and
 *     backed by evidence.
 *   · WHAT CARRIES FORWARD — every piece of evidence, copied into the
 *     recommendation with its links to the opportunity's evidence row and the
 *     normalised signal, and marked if it is no longer current.
 *   · HOW THE TWO STAY IN STEP — lib/recommendations.ts STATUS SYNC.
 *
 * Pure and client-safe. The service is server/recommendations.
 */

/** Bump when the hand-off shape changes; stored with every recommendation. */
export const HANDOFF_VERSION = 1;

/** The snapshot view a recommendation is written against. */
export const RECOMMENDATION_SNAPSHOT_VIEW = 'recommendation' as const;

const iso = z.string().datetime();

export const handoffEvidenceSchema = z.object({
  /** The opportunity's evidence row this was copied from. */
  opportunitySignalId: z.string(),
  /** The normalised signal behind it, when it came through the signal store. */
  signalId: z.string().nullable(),
  kind: z.enum(SIGNAL_KINDS),
  refId: z.string().nullable(),
  label: z.string(),
  detail: z.string(),
  url: z.string().nullable(),
  observedAt: iso.nullable(),
  /** From the normalised signal; null when there is none (or it was pruned). */
  source: z.enum(SIGNAL_SOURCES).nullable(),
  reliability: z.enum(SIGNAL_RELIABILITIES).nullable(),
  /** False when the signal has expired or been pruned since detection. */
  current: z.boolean(),
  /** How the detector said it supports the opportunity (AI detection). */
  supports: z.string().nullable(),
});
export type HandoffEvidence = z.infer<typeof handoffEvidenceSchema>;

const rating = z.enum(['low', 'medium', 'high']).nullable();

export const opportunityHandoffSchema = z.object({
  version: z.literal(HANDOFF_VERSION),
  generatedAt: iso,
  opportunity: z.object({
    id: z.string(),
    type: z.enum(OPPORTUNITY_TYPES),
    status: z.enum(OPPORTUNITY_STATUSES),
    title: z.string(),
    summary: z.string(),
    rationale: z.string().nullable(),
    angle: z.string().nullable(),
    /** Detector-specific detail: channels, content ideas, timing, criteria… */
    details: z.record(z.unknown()),
    detectedAt: iso,
    lastSeenAt: iso,
    /** The recommendation is pointless after this; null = no natural expiry. */
    relevantUntil: iso.nullable(),
  }),
  assessment: z.object({
    confidence: z.enum(OPPORTUNITY_CONFIDENCES),
    confidenceReason: z.string().nullable(),
    priority: z.enum(OPPORTUNITY_PRIORITIES),
    priorityScore: z.number().int(),
    /** Null on opportunities stored before these were recorded. */
    impact: rating,
    effort: rating,
  }),
  evidence: z.array(handoffEvidenceSchema).min(1),
  context: z.object({
    /** What the recommendation engine should read: getContextSnapshot(view). */
    snapshotView: z.literal(RECOMMENDATION_SNAPSHOT_VIEW),
    /** The context the opportunity was detected against. */
    revision: z.string().nullable(),
    fingerprint: z.string().nullable(),
    /** Business Context fields the opportunity relies on. */
    fields: z.array(z.string()),
    /** Of those, the ones that are now unconfirmed or out of date. */
    shakyFields: z.array(z.string()),
    /**
     * Has the business context changed since detection? Null when the
     * opportunity did not record its revision.
     */
    changedSinceDetection: z.boolean().nullable(),
  }),
  provenance: z.object({
    source: z.enum(OPPORTUNITY_SOURCES),
    detectedBy: z.string(),
    /** The rule id, for rule-detected opportunities. */
    rule: z.string().nullable(),
    /** The model and prompt version, for AI-detected ones. */
    ai: z
      .object({ model: z.string(), promptVersion: z.string().nullable() })
      .nullable(),
  }),
});
export type OpportunityHandoff = z.infer<typeof opportunityHandoffSchema>;

/** A stored opportunity as the hand-off reads it (Prisma row, structurally). */
export interface HandoffSource {
  id: string;
  type: OpportunityType;
  status: OpportunityStatus;
  title: string;
  summary: string;
  rationale: string | null;
  angle: string | null;
  details: unknown;
  source: OpportunitySource;
  detectedBy: string;
  priority: OpportunityPriority;
  priorityScore: number;
  confidence: OpportunityConfidence;
  confidenceReason: string | null;
  impact: string | null;
  effort: string | null;
  detectedAt: Date;
  lastSeenAt: Date;
  relevantUntil: Date | null;
  contextRevision: string | null;
  contextFingerprint: string | null;
  contextFields: string[];
  signals: {
    id: string;
    kind: SignalKind;
    refId: string | null;
    label: string;
    detail: string;
    url: string | null;
    observedAt: Date | null;
    signalId: string | null;
    signal: {
      source: SignalSource;
      reliability: SignalReliability;
      expiresAt: Date | null;
    } | null;
  }[];
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const asRating = (v: string | null) =>
  v === 'low' || v === 'medium' || v === 'high' ? v : null;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface HandoffEligibility {
  eligible: boolean;
  /** Why not, in plain words; empty when eligible. */
  reasons: string[];
}

/**
 * Can this opportunity become a recommendation now?
 *
 *   · it is still open (detected, reviewed or already recommended) — a
 *     decided or expired opportunity has nothing left to recommend;
 *   · its relevance window has not passed;
 *   · it has at least one piece of CURRENT evidence — a recommendation built
 *     only on stale signals would be recommending yesterday's opening.
 */
export function handoffEligibility(
  o: Pick<HandoffSource, 'status' | 'relevantUntil'>,
  evidence: Pick<HandoffEvidence, 'current'>[],
  now: Date,
): HandoffEligibility {
  const reasons: string[] = [];
  if (!ACTIVE_STATUSES.includes(o.status)) {
    reasons.push(
      `It is ${o.status.toLowerCase()}; only open opportunities can be recommended.`,
    );
  }
  if (o.relevantUntil && o.relevantUntil <= now) {
    reasons.push('Its relevance window has passed.');
  }
  if (evidence.length === 0) {
    reasons.push('It has no evidence.');
  } else if (!evidence.some((e) => e.current)) {
    reasons.push('None of its evidence is current any more.');
  }
  return { eligible: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Building the hand-off
// ---------------------------------------------------------------------------

/**
 * The opportunity as a recommendation receives it.
 *
 * `shakyFields` and `currentRevision` come from the live Business Context
 * (the service reads them), so the hand-off says whether what the opportunity
 * relied on still holds — the engine should not recommend acting on an
 * audience the business has since changed.
 */
export function buildHandoff(
  o: HandoffSource,
  args: { now: Date; shakyFields: string[]; currentRevision: string | null },
): OpportunityHandoff {
  const details = record(o.details);
  const ai = record(details.ai);
  const supports = new Map<string, string>();
  for (const e of Array.isArray(ai.evidence) ? ai.evidence : []) {
    const r = record(e);
    if (typeof r.signalId === 'string' && typeof r.supports === 'string') {
      supports.set(r.signalId, r.supports);
    }
  }

  return {
    version: HANDOFF_VERSION,
    generatedAt: args.now.toISOString(),
    opportunity: {
      id: o.id,
      type: o.type,
      status: o.status,
      title: o.title,
      summary: o.summary,
      rationale: o.rationale,
      angle: o.angle,
      details,
      detectedAt: o.detectedAt.toISOString(),
      lastSeenAt: o.lastSeenAt.toISOString(),
      relevantUntil: o.relevantUntil?.toISOString() ?? null,
    },
    assessment: {
      confidence: o.confidence,
      confidenceReason: o.confidenceReason,
      priority: o.priority,
      priorityScore: o.priorityScore,
      impact: asRating(o.impact),
      effort: asRating(o.effort),
    },
    evidence: o.signals.map((s) => ({
      opportunitySignalId: s.id,
      signalId: s.signalId,
      kind: s.kind,
      refId: s.refId,
      label: s.label,
      detail: s.detail,
      url: s.url,
      observedAt: s.observedAt?.toISOString() ?? null,
      source: s.signal?.source ?? null,
      reliability: s.signal?.reliability ?? null,
      // Evidence without a normalised signal (e.g. older advisor evidence)
      // is as current as the opportunity; a linked signal that has expired
      // or been pruned is not.
      current: s.signalId
        ? Boolean(
            s.signal &&
            (s.signal.expiresAt === null || s.signal.expiresAt > args.now),
          )
        : true,
      supports: (s.signalId && supports.get(s.signalId)) || null,
    })),
    context: {
      snapshotView: RECOMMENDATION_SNAPSHOT_VIEW,
      revision: o.contextRevision,
      fingerprint: o.contextFingerprint,
      fields: o.contextFields,
      shakyFields: args.shakyFields,
      changedSinceDetection:
        o.contextRevision && args.currentRevision
          ? o.contextRevision !== args.currentRevision
          : null,
    },
    provenance: {
      source: o.source,
      detectedBy: o.detectedBy,
      rule: o.detectedBy.startsWith('rule:') ? o.detectedBy.slice(5) : null,
      ai:
        typeof ai.model === 'string'
          ? {
              model: ai.model,
              promptVersion:
                typeof ai.promptVersion === 'string' ? ai.promptVersion : null,
            }
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// What a new recommendation starts from
// ---------------------------------------------------------------------------

/**
 * What a recommendation inherits from the hand-off: the link to its
 * opportunity, its assessment, the context it was detected against, and a
 * copy of every piece of evidence. The recommendation's own content (what,
 * why, action…) comes from lib/recommendations.ts.
 */
export function recommendationSeed(h: OpportunityHandoff) {
  return {
    opportunityId: h.opportunity.id,
    confidence: h.assessment.confidence,
    confidenceReason: h.assessment.confidenceReason,
    priority: h.assessment.priority,
    priorityScore: h.assessment.priorityScore,
    handoffVersion: h.version,
    contextRevision: h.context.revision,
    contextFingerprint: h.context.fingerprint,
    contextFields: h.context.fields,
    evidence: h.evidence.map((e) => ({
      opportunitySignalId: e.opportunitySignalId,
      signalId: e.signalId,
      kind: e.kind,
      refId: e.refId,
      label: e.label,
      detail: e.detail,
      url: e.url,
      observedAt: e.observedAt ? new Date(e.observedAt) : null,
      reliability: e.reliability,
    })),
  };
}
