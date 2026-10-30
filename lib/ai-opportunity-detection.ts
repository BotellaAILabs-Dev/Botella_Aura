import { z } from 'zod';

import type { BusinessContextSnapshot } from '@/lib/business-context-snapshot';
import {
  OPPORTUNITY_TYPE_INFO,
  type OpportunityConfidence,
  type OpportunityInput,
  type OpportunityType,
} from '@/lib/opportunities';
import {
  AI_INTERPRETED_CATEGORIES,
  confidenceFromReliability,
  type DetectableSignal,
} from '@/lib/opportunity-detection';
import { textKey, type SignalSource } from '@/lib/signals';
import { signalPosture } from '@/lib/brand-safety';

/**
 * AI-assisted opportunity detection — the categories the rules cannot judge
 * (lib/opportunity-detection.ts AI_INTERPRETED_CATEGORIES), interpreted by a
 * model and then held to the same standard as a rule.
 *
 * The model is trusted to INTERPRET, never to ASSERT. It receives:
 *   · the Business Context Snapshot (opportunity view) — the only business
 *     facts it may rely on, with unconfirmed ones labelled as assumptions;
 *   · the relevant normalised signals, each under a short reference (S1, S2…)
 *     so a citation can be checked mechanically.
 *
 * It must return structured output in which every opportunity cites the
 * signals behind it, says how each one supports it, names the business facts
 * it relies on, states its confidence and why, and declares any assumption it
 * had to make. Then validateAiOutput checks all of that deterministically.
 * An opportunity that fails any check is rejected with its reasons, never
 * stored; the rest of the run is unaffected.
 *
 * Pure and client-safe. The service is server/opportunities/ai-detection.service.ts.
 */

/** Bump when the prompt or schema changes; stored with every opportunity. */
export const AI_DETECTION_PROMPT_VERSION = 'ai-detect-v1';

/** Only what the rules cannot do. Rule categories are rejected. */
export const AI_DETECTION_TYPES = AI_INTERPRETED_CATEGORIES.map(
  (c) => c.type,
) as OpportunityType[];

export const AI_DETECTION_LIMITS = {
  /** Signals sent to the model. */
  maxSignals: 40,
  /** Opportunities accepted from one run. */
  maxOpportunities: 5,
  /** Citations per opportunity. */
  maxCitations: 8,
} as const;

/**
 * MINIMUM EVIDENCE per category — what kind of signal an interpretation has
 * to stand on, checked against the cited signals, not the model's word.
 */
export const AI_EVIDENCE_REQUIREMENTS: Record<
  string,
  { minSignals: number; sources: SignalSource[]; description: string }
> = {
  CONTENT_GAP: {
    minSignals: 1,
    sources: ['COMPETITORS', 'TRENDS'],
    description:
      'at least one competitor or market signal showing the topic is being discussed',
  },
  COMPETITIVE_GAP: {
    minSignals: 2,
    sources: ['COMPETITORS', 'TRENDS'],
    description:
      'at least two competitor or market signals — a theme, not a single move',
  },
  AUDIENCE_SEGMENT: {
    minSignals: 1,
    sources: ['ANALYTICS', 'MEMORY'],
    description:
      'at least one signal from the business’s own results or learned patterns',
  },
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const REL_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

/**
 * The signals worth interpreting: current, not already evidence in an
 * opportunity the business rejected, and — for market chatter — related to
 * the business. Most reliable and most recent first, capped.
 */
export function selectSignalsForAi(
  signals: DetectableSignal[],
  options: {
    now: Date;
    rejectedSignalIds?: Set<string>;
    max?: number;
  },
): DetectableSignal[] {
  const rejected = options.rejectedSignalIds ?? new Set<string>();
  return signals
    .filter((s) => !s.expiresAt || s.expiresAt > options.now)
    .filter((s) => !rejected.has(s.id))
    .filter((s) => s.source !== 'TRENDS' || s.contextMatches.length > 0)
    // Never hand the model a story about real harm to find an angle in.
    .filter((s) => signalPosture(s) !== 'unsuitable')
    .sort(
      (a, b) =>
        REL_RANK[b.reliability] - REL_RANK[a.reliability] ||
        b.observedAt.getTime() - a.observedAt.getTime(),
    )
    .slice(0, options.max ?? AI_DETECTION_LIMITS.maxSignals);
}

/** The business facts the model may cite, by key, and whether each is trusted. */
export function citableFacts(
  snapshot: BusinessContextSnapshot,
): Map<string, 'trusted' | 'assumption'> {
  const facts = new Map<string, 'trusted' | 'assumption'>();
  for (const key of Object.keys(snapshot.trust)) facts.set(key, 'trusted');
  for (const a of snapshot.assumptions) {
    if (!facts.has(a.field)) facts.set(a.field, 'assumption');
  }
  return facts;
}

export interface AiDetectionPrompt {
  system: string;
  prompt: string;
  /** S1 → the signal it stands for. */
  refs: Map<string, DetectableSignal>;
}

export function buildAiDetectionPrompt(args: {
  snapshot: BusinessContextSnapshot;
  /** snapshotToPrompt(snapshot) — the fact sheet. */
  snapshotText: string;
  signals: DetectableSignal[];
}): AiDetectionPrompt {
  const refs = new Map<string, DetectableSignal>();
  const lines = args.signals.map((s, i) => {
    const ref = `S${i + 1}`;
    refs.set(ref, s);
    return `[${ref}] (${s.source}, ${s.reliability} reliability, ${s.observedAt.toISOString().slice(0, 10)}) ${s.title} — ${s.summary.slice(0, 400)}`;
  });
  const facts = [...citableFacts(args.snapshot)].map(
    ([key, status]) =>
      `${key}${status === 'assumption' ? ' (ASSUMPTION — not confirmed)' : ''}`,
  );
  const categories = AI_INTERPRETED_CATEGORIES.map(
    (c) =>
      `- ${c.type}: ${c.why} Evidence needed: ${AI_EVIDENCE_REQUIREMENTS[c.type]?.description ?? 'at least one signal'}.`,
  );

  const system = [
    'You find marketing opportunities for one business that simple rules cannot detect.',
    'You interpret the SIGNALS you are given in light of the BUSINESS CONTEXT. You do not know anything else about this business.',
    '',
    'Only these categories:',
    ...categories,
    '',
    'Rules — an opportunity that breaks any of them is discarded:',
    '1. Every opportunity cites the signals it is based on by their reference (e.g. "S3"), and says for each one how it supports the opportunity.',
    '2. Use only facts that appear in the signals or the business context. Do not invent numbers, customers, products, results, prices, dates or competitor actions.',
    '3. List in businessFacts every business-context fact the opportunity relies on, by its key from FACT KEYS. Never rely on a fact that is not listed there.',
    '4. If an opportunity would need anything you were not told (an audience, a product, a result), list it in assumptions. Prefer proposing nothing over assuming.',
    '5. State your confidence (LOW, MEDIUM or HIGH) and why. HIGH needs several independent, reliable signals.',
    '6. Do not propose topics in the business’s recent content. Fewer, well-supported opportunities beat many weak ones; an empty list is a valid answer.',
    '',
    'Respond with ONLY JSON of this shape:',
    '{"opportunities":[{"type":"CONTENT_GAP|COMPETITIVE_GAP|AUDIENCE_SEGMENT","title":"…","summary":"…","reasoning":"…","angle":"…","evidence":[{"signal":"S1","supports":"…"}],"businessFacts":["identity.description"],"assumptions":[],"confidence":"LOW|MEDIUM|HIGH","confidenceReason":"…","impact":"low|medium|high","effort":"low|medium|high"}],"noOpportunityReason":"… (only when the list is empty)"}',
  ].join('\n');

  const prompt = [
    args.snapshotText,
    '',
    'FACT KEYS (the only business facts you may rely on):',
    facts.length
      ? facts.join(', ')
      : '(none — the business has confirmed nothing yet)',
    '',
    'SIGNALS:',
    lines.length ? lines.join('\n') : '(none)',
    '',
    `Return at most ${AI_DETECTION_LIMITS.maxOpportunities} opportunities.`,
  ].join('\n');

  return { system, prompt, refs };
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

/**
 * The response envelope. Items are checked one by one (aiOpportunitySchema),
 * so one malformed opportunity is rejected on its own instead of failing the
 * whole run.
 */
export const aiResponseSchema = z.object({
  opportunities: z.array(z.unknown()).max(20),
  noOpportunityReason: z.string().optional(),
});

const rating = z.enum(['low', 'medium', 'high']);

/** One opportunity, exactly as the model must return it. */
export const aiOpportunitySchema = z.object({
  type: z.string(),
  title: z.string().trim().min(3).max(160),
  summary: z.string().trim().min(10).max(1500),
  reasoning: z.string().trim().min(10).max(2000),
  angle: z.string().trim().max(600).optional(),
  evidence: z
    .array(
      z.object({
        signal: z.string().trim().min(1).max(10),
        supports: z.string().trim().min(5).max(500),
      }),
    )
    .min(1, 'cites no signals'),
  businessFacts: z.array(z.string().trim().max(60)).max(12),
  assumptions: z.array(z.string().trim()).max(10),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  confidenceReason: z.string().trim().min(5).max(500),
  impact: rating,
  effort: rating,
});
export type AiOpportunity = z.infer<typeof aiOpportunitySchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type AiRejectionCode =
  | 'invalid-shape'
  | 'type-not-allowed'
  | 'unknown-signal'
  | 'insufficient-evidence'
  | 'unknown-business-fact'
  | 'declared-assumption'
  | 'unsupported-number'
  | 'duplicate'
  | 'over-limit';

export interface AiRejection {
  index: number;
  title: string | null;
  reasons: { code: AiRejectionCode; detail: string }[];
}

export interface ValidatedAiOpportunity {
  output: AiOpportunity;
  type: OpportunityType;
  signals: DetectableSignal[];
  /** How the model said each cited signal supports it, by signal id. */
  supports: Record<string, string>;
  /** The model's claim, the evidence's ceiling, and what was kept. */
  confidence: {
    claimed: OpportunityConfidence;
    evidence: OpportunityConfidence;
    kept: OpportunityConfidence;
    reason: string;
  };
  /** Business facts relied on that are assumptions, not confirmed. */
  assumedFacts: string[];
  /** Non-fatal notes, stored with the opportunity. */
  warnings: string[];
}

export interface AiValidationResult {
  accepted: ValidatedAiOpportunity[];
  rejected: AiRejection[];
}

const CONF_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

/**
 * Numbers the model wrote that none of its sources contain.
 *
 * A figure is the commonest way an invented fact gets in ("30% of your
 * customers…"). Percentages, money and any number of 10 or more must appear
 * in a cited signal or the business context. Small counts ("3 competitors")
 * and the current or adjacent year are left alone.
 */
export function unsupportedNumbers(
  text: string,
  sources: string,
  now: Date,
): string[] {
  const norm = (n: string) => n.replace(/,/g, '').replace(/\.0+$/, '');
  const available = new Set(
    (sources.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(norm),
  );
  const year = now.getUTCFullYear();
  const out = new Set<string>();
  const re = /([$€£₹])?\s?(\d[\d,]*(?:\.\d+)?)\s?(%|percent|k\b|m\b)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[2]!;
    const value = norm(raw);
    const n = Number(value);
    const isMoneyOrPct = Boolean(m[1] || m[3]);
    if (!isMoneyOrPct && n < 10) continue;
    if (!isMoneyOrPct && Math.abs(n - year) <= 1) continue;
    if (!available.has(value)) out.add(m[0].trim());
  }
  return [...out];
}

/**
 * Check every opportunity the model returned. Deterministic: the same output
 * against the same inputs always gives the same verdict.
 *
 *   SHAPE        matches aiOpportunitySchema (structured, confidence present)
 *   CATEGORY     one the rules cannot detect
 *   CITATIONS    every cited reference is a signal we supplied
 *   EVIDENCE     enough cited signals of the kind the category needs
 *   FACTS        every business fact relied on is one the context contains
 *   ASSUMPTIONS  none declared — an opportunity that needs a guess is not one
 *   NUMBERS      every figure appears in the cited signals or the context
 *   DUPLICATES   not the same type over the same signals as one already kept
 *
 * Confidence kept = the lower of the model's claim and what the cited
 * signals' reliability supports (confidenceFromReliability).
 */
export function validateAiOutput(
  items: unknown[],
  args: {
    refs: Map<string, DetectableSignal>;
    snapshot: BusinessContextSnapshot;
    snapshotText: string;
    now: Date;
  },
): AiValidationResult {
  const facts = citableFacts(args.snapshot);
  const accepted: ValidatedAiOpportunity[] = [];
  const rejected: AiRejection[] = [];

  items.forEach((raw, index) => {
    const titleOf = (v: unknown) =>
      v &&
      typeof v === 'object' &&
      typeof (v as { title?: unknown }).title === 'string'
        ? (v as { title: string }).title.slice(0, 160) || null
        : null;
    const parsed = aiOpportunitySchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({
        index,
        title: titleOf(raw),
        reasons: parsed.error.issues.slice(0, 5).map((i) => ({
          code: 'invalid-shape' as const,
          detail: `${i.path.join('.') || 'opportunity'}: ${i.message}`,
        })),
      });
      return;
    }
    const o = parsed.data;
    const reasons: AiRejection['reasons'] = [];
    const warnings: string[] = [];

    // CATEGORY
    const type = o.type.trim().toUpperCase() as OpportunityType;
    if (!AI_DETECTION_TYPES.includes(type)) {
      reasons.push({
        code: 'type-not-allowed',
        detail: `"${o.type}" is not a category AI detection may propose (${AI_DETECTION_TYPES.join(', ')}).`,
      });
    }

    // CITATIONS
    const signals: DetectableSignal[] = [];
    const supports: Record<string, string> = {};
    const seen = new Set<string>();
    for (const e of o.evidence) {
      const ref = e.signal.toUpperCase();
      const s = args.refs.get(ref);
      if (!s) {
        reasons.push({
          code: 'unknown-signal',
          detail: `cites ${e.signal}, which is not one of the signals supplied.`,
        });
      } else if (!seen.has(s.id)) {
        seen.add(s.id);
        signals.push(s);
        supports[s.id] = e.supports;
      }
    }
    if (signals.length > AI_DETECTION_LIMITS.maxCitations) {
      warnings.push(
        `cited ${signals.length} signals; kept the first ${AI_DETECTION_LIMITS.maxCitations}`,
      );
      signals.length = AI_DETECTION_LIMITS.maxCitations;
    }

    // EVIDENCE
    const need = AI_EVIDENCE_REQUIREMENTS[type];
    if (need) {
      const qualifying = signals.filter((s) => need.sources.includes(s.source));
      if (qualifying.length < need.minSignals) {
        reasons.push({
          code: 'insufficient-evidence',
          detail: `${type} needs ${need.description}; cited ${qualifying.length}.`,
        });
      }
    }

    // FACTS
    const assumedFacts: string[] = [];
    for (const f of new Set(o.businessFacts)) {
      const status = facts.get(f);
      if (!status) {
        reasons.push({
          code: 'unknown-business-fact',
          detail: `relies on "${f}", which the business context does not contain.`,
        });
      } else if (status === 'assumption') {
        assumedFacts.push(f);
      }
    }

    // ASSUMPTIONS
    const declared = o.assumptions.filter((a) => a.length > 0);
    if (declared.length) {
      reasons.push({
        code: 'declared-assumption',
        detail: `needs information the business has not given: ${declared.join('; ').slice(0, 300)}`,
      });
    }

    // NUMBERS
    const sourceText = [
      args.snapshotText,
      ...signals.map((s) => `${s.title} ${s.summary}`),
    ].join('\n');
    const written = [o.title, o.summary, o.reasoning, o.angle ?? '']
      .concat(o.evidence.map((e) => e.supports))
      .join('\n');
    const invented = unsupportedNumbers(written, sourceText, args.now);
    if (invented.length) {
      reasons.push({
        code: 'unsupported-number',
        detail: `states ${invented.join(', ')}, which no cited signal or business fact contains.`,
      });
    }

    // DUPLICATES — same type over any of the same signals as one already kept.
    if (
      !reasons.length &&
      accepted.some(
        (a) => a.type === type && a.signals.some((s) => seen.has(s.id)),
      )
    ) {
      reasons.push({
        code: 'duplicate',
        detail:
          'same category and evidence as an opportunity already accepted in this run.',
      });
    }
    if (
      !reasons.length &&
      accepted.length >= AI_DETECTION_LIMITS.maxOpportunities
    ) {
      reasons.push({
        code: 'over-limit',
        detail: `only ${AI_DETECTION_LIMITS.maxOpportunities} opportunities are accepted per run.`,
      });
    }

    if (reasons.length) {
      rejected.push({ index, title: o.title, reasons });
      return;
    }

    // CONFIDENCE — never above what the evidence supports.
    const ev = confidenceFromReliability(signals);
    const kept =
      CONF_RANK[o.confidence] <= CONF_RANK[ev.confidence]
        ? o.confidence
        : ev.confidence;
    if (kept !== o.confidence) {
      warnings.push(
        `model rated it ${o.confidence}; lowered to ${kept} (${ev.reason})`,
      );
    }
    accepted.push({
      output: o,
      type,
      signals,
      supports,
      confidence: {
        claimed: o.confidence,
        evidence: ev.confidence,
        kept,
        reason: o.confidenceReason,
      },
      assumedFacts,
      warnings,
    });
  });

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * A validated AI opportunity as recordOpportunity input. The evidence is the
 * cited signals themselves (linked by signalId), never the model's paraphrase
 * of them; the model's reasoning and confidence are kept alongside.
 */
export function aiToOpportunityInput(
  v: ValidatedAiOpportunity,
  meta: { model: string; snapshotFingerprint: string; now: Date },
): OpportunityInput {
  const o = v.output;
  const expiries = v.signals
    .map((s) => s.expiresAt)
    .filter((d): d is Date => d !== null);
  const days = OPPORTUNITY_TYPE_INFO[v.type].relevanceDays;
  const relevantUntil = expiries.length
    ? new Date(Math.max(...expiries.map((d) => d.getTime())))
    : days === null
      ? null
      : new Date(meta.now.getTime() + days * 86_400_000);

  return {
    type: v.type,
    title: o.title.slice(0, 200),
    summary: o.summary,
    rationale: o.reasoning,
    ...(o.angle ? { angle: o.angle } : {}),
    details: {
      ai: {
        model: meta.model,
        promptVersion: AI_DETECTION_PROMPT_VERSION,
        snapshotFingerprint: meta.snapshotFingerprint,
        confidence: v.confidence,
        evidence: v.signals.map((s) => ({
          signalId: s.id,
          title: s.title,
          supports: v.supports[s.id] ?? null,
        })),
        businessFacts: o.businessFacts,
        assumedFacts: v.assumedFacts,
        warnings: v.warnings,
      },
    },
    source: 'AI_DETECTION',
    detectedBy: `ai:${meta.model}`.slice(0, 100),
    signals: v.signals.map((s) => ({
      kind: s.kind,
      refId: s.refId,
      label: s.title.slice(0, 200),
      detail: s.summary.slice(0, 2000),
      ...(s.url && /^https?:\/\//i.test(s.url) ? { url: s.url } : {}),
      observedAt: s.observedAt,
      signalId: s.id,
    })),
    impact: o.impact,
    effort: o.effort,
    confidence: v.confidence.kept,
    relevantUntil,
    dedupeKey: `ai:${v.type}:${textKey(o.title, 10)}`.slice(0, 200),
    contextFields: [...new Set(o.businessFacts)].slice(0, 20),
  };
}
