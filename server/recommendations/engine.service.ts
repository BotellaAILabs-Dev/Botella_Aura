import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  ENGINE_VERSION,
  aiRecommendationSchema,
  assess,
  buildWritingPrompt,
  checkSupport,
  composeRecommendation,
  engineContext,
  learnedFormatsFromSignals,
  selectActions,
  validateAiRecommendation,
  type EngineSignal,
} from '@/lib/recommendation-engine';
import {
  LIVE_RECOMMENDATION_STATUSES,
  recommendationContentSchema,
  type RecommendationContentInput,
} from '@/lib/recommendations';
import {
  completeStructured,
  getModel,
  isClaudeConfigured,
} from '@/server/ai/claude';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
import { recordAudit } from '@/server/services/audit.service';
import { OpportunityError } from '@/server/opportunities/opportunity.service';
import {
  createRecommendationFromOpportunity,
  getOpportunityHandoff,
} from './recommendation.service';

/**
 * The recommendation generation engine (rules: lib/recommendation-engine.ts).
 *
 * generateRecommendation(opportunity) reads:
 *   · the opportunity's hand-off (Sprint 7) — what it is, its evidence,
 *     assessment and the context it relied on;
 *   · the CURRENT Business Context Snapshot (recommendation view), so the
 *     action fits the business as it is now, not as it was at detection;
 *   · the relevant signals — the opportunity's own, plus current learned
 *     patterns and results movements that bear on how to act;
 * selects the action that fits, writes it (model when available, validated;
 * template otherwise), assesses confidence and priority, runs the support
 * gate, and stores the recommendation — or rejects it, saying why. Every run
 * is written to the audit log.
 */

export type GenerationStatus = 'created' | 'flagged' | 'rejected';

export interface GenerationReport {
  status: GenerationStatus;
  /** Why it was rejected, or what was flagged. */
  reasons: string[];
  flags: string[];
  recommendationId: string | null;
  writtenBy: string;
  selected: {
    id: string;
    label: string;
    score: number;
    reasons: string[];
  } | null;
  alternatives: {
    id: string;
    label: string;
    type: string;
    score: number;
    reasons: string[];
  }[];
  unsupported: { id: string; label: string; reasons: string[] }[];
  /** Why the model's version was not used, when it was tried. */
  aiRejected?: string[];
  snapshotFingerprint: string | null;
}

/** The model call, replaceable in tests and verification scripts. */
export type WriteRecommendation = (args: {
  system: string;
  prompt: string;
}) => Promise<unknown>;

const defaultWrite: WriteRecommendation = ({ system, prompt }) =>
  completeStructured({
    schema: aiRecommendationSchema,
    system,
    prompt,
    tier: 'standard',
    effort: 'medium',
    maxTokens: 2000,
  });

/** Overrides a person may make; anything else is the engine's choice. */
export type RecommendationOverrides = Partial<
  Pick<
    RecommendationContentInput,
    | 'type'
    | 'title'
    | 'summary'
    | 'action'
    | 'steps'
    | 'rationale'
    | 'expectedOutcome'
    | 'outcomeMetric'
    | 'channel'
    | 'contentType'
    | 'audience'
  >
>;

export async function generateRecommendation(args: {
  companyId: string;
  opportunityId: string;
  actorId: string | null;
  /** "user:<id>" when a person asked; the engine's own id otherwise. */
  requestedBy?: string;
  overrides?: RecommendationOverrides;
  /** Model call override; defaults to the configured provider, if any. */
  write?: WriteRecommendation;
  model?: string;
  /** Use templates only, even when a model is available. */
  templatesOnly?: boolean;
  now?: Date;
}): Promise<GenerationReport> {
  const now = args.now ?? new Date();
  const base: GenerationReport = {
    status: 'rejected',
    reasons: [],
    flags: [],
    recommendationId: null,
    writtenBy: 'template',
    selected: null,
    alternatives: [],
    unsupported: [],
    snapshotFingerprint: null,
  };
  const finish = async (report: GenerationReport) => {
    await recordAudit({
      action: 'RECOMMENDATION_GENERATED',
      userId: args.actorId,
      companyId: args.companyId,
      metadata: {
        engine: ENGINE_VERSION,
        opportunityId: args.opportunityId,
        status: report.status,
        recommendationId: report.recommendationId,
        writtenBy: report.writtenBy,
        selected: report.selected?.id ?? null,
        reasons: report.reasons.slice(0, 10),
        flags: report.flags.slice(0, 10),
        unsupported: report.unsupported
          .map((u) => `${u.id}: ${u.reasons.join('; ')}`)
          .slice(0, 10),
        ...(report.aiRejected
          ? { aiRejected: report.aiRejected.slice(0, 10) }
          : {}),
      } as Prisma.InputJsonObject,
    });
    return report;
  };

  // --- Inputs ---------------------------------------------------------------
  const found = await getOpportunityHandoff(
    args.companyId,
    args.opportunityId,
    { now },
  );
  if (!found) throw new OpportunityError('Opportunity not found.', 404);
  const { handoff: h, eligibility } = found;
  if (!eligibility.eligible) {
    return finish({ ...base, reasons: eligibility.reasons });
  }
  // Refuse before doing any work (or calling a model) if one is in play.
  const live = await db.recommendation.findFirst({
    where: {
      companyId: args.companyId,
      opportunityId: args.opportunityId,
      status: { in: LIVE_RECOMMENDATION_STATUSES },
    },
    select: { status: true },
  });
  if (live) {
    throw new OpportunityError(
      `This opportunity already has a recommendation that is ${live.status.toLowerCase().replace('_', ' ')}. Finish or withdraw it first.`,
      409,
    );
  }
  const snap = await getContextSnapshot(args.companyId, {
    view: 'recommendation',
    now,
  });
  if (!snap) throw new OpportunityError('Business not found.', 404);
  const ctx = engineContext(snap.snapshot);
  base.snapshotFingerprint = snap.snapshot.fingerprint;

  const evidenceIds = h.evidence
    .map((e) => e.signalId)
    .filter((x): x is string => Boolean(x));
  const signals: EngineSignal[] = await db.signal.findMany({
    where: {
      companyId: args.companyId,
      OR: [
        { id: { in: evidenceIds } },
        // What bears on HOW to act: learned patterns and results movements.
        {
          source: { in: ['MEMORY', 'ANALYTICS'] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      ],
    },
    select: {
      id: true,
      source: true,
      title: true,
      summary: true,
      reliability: true,
      expiresAt: true,
      metadata: true,
    },
    take: 40,
  });
  // The opportunity's own evidence decides evidence-based actions.
  const own = signals.filter((s) => evidenceIds.includes(s.id));

  // --- Select ---------------------------------------------------------------
  // Current learned patterns refine the format choice.
  ctx.learnedFormats = [
    ...new Set([...ctx.learnedFormats, ...learnedFormatsFromSignals(signals)]),
  ];
  const selection = selectActions(h, ctx, own, now);
  const report: GenerationReport = {
    ...base,
    unsupported: selection.unsupported,
    alternatives: selection.viable.slice(1).map((a) => ({
      id: a.spec.id,
      label: a.spec.label,
      type: a.spec.type,
      score: a.score,
      reasons: a.reasons,
    })),
  };
  const chosen = selection.viable[0];
  if (!chosen) {
    return finish({
      ...report,
      reasons: [
        'No action this business can take is supported by the available data.',
        ...selection.unsupported.map(
          (u) => `${u.label}: ${u.reasons.join('; ')}`,
        ),
      ],
    });
  }
  report.selected = {
    id: chosen.spec.id,
    label: chosen.spec.label,
    score: chosen.score,
    reasons: chosen.reasons,
  };

  // --- Write ----------------------------------------------------------------
  const template = composeRecommendation(h, chosen, ctx, own);
  let content = template;
  const model = args.write
    ? (args.model ?? 'custom')
    : isClaudeConfigured()
      ? getModel('standard')
      : null;
  if (model && !args.templatesOnly) {
    try {
      const raw = await (args.write ?? defaultWrite)(
        buildWritingPrompt({
          h,
          chosen,
          snapshotText: snap.prompt,
          snapshot: snap.snapshot,
          template,
        }),
      );
      const checked = validateAiRecommendation(raw, {
        h,
        snapshot: snap.snapshot,
        snapshotText: snap.prompt,
        template,
        now,
      });
      if (checked.ok) {
        content = checked.content;
        report.writtenBy = `ai:${model}`;
      } else {
        report.aiRejected = checked.reasons;
      }
    } catch (err) {
      report.aiRejected = [err instanceof Error ? err.message : String(err)];
      logger.warn('recommendation engine: model failed, using template', {
        companyId: args.companyId,
        error: report.aiRejected[0],
      });
    }
    if (report.aiRejected) {
      report.flags.push(
        'written from templates: the model’s version was not supported by the data',
      );
    }
  }

  // A person's edits, on top.
  const overridden = Object.keys(args.overrides ?? {});
  if (overridden.length) {
    content = recommendationContentSchema.parse({
      ...content,
      ...args.overrides,
    });
  }

  // --- Support gate and assessment --------------------------------------------
  const gate = checkSupport(content, {
    h,
    ctx,
    chosenFlags: chosen.flags,
    now,
  });
  if (gate.rejected.length) {
    return finish({ ...report, reasons: gate.rejected, flags: gate.flags });
  }
  const flags = [...report.flags, ...gate.flags];
  const a = assess(h, chosen, gate.flags, now);

  const rec = await createRecommendationFromOpportunity({
    companyId: args.companyId,
    opportunityId: args.opportunityId,
    createdBy: args.requestedBy ?? `${ENGINE_VERSION}:${report.writtenBy}`,
    actorId: args.actorId,
    now,
    priority: { priority: a.priority, priorityScore: a.priorityScore },
    content: {
      ...content,
      confidence: a.confidence,
      confidenceReason: a.confidenceReason,
      details: {
        ...content.details,
        engine: {
          version: ENGINE_VERSION,
          writtenBy: report.writtenBy,
          snapshotFingerprint: snap.snapshot.fingerprint,
          selected: report.selected,
          alternatives: report.alternatives,
          unsupported: report.unsupported,
          flags,
          priorityReason: a.priorityReason,
          ...(overridden.length ? { editedByPerson: overridden } : {}),
          ...(report.aiRejected ? { aiRejected: report.aiRejected } : {}),
        },
      },
    },
  });

  return finish({
    ...report,
    status: flags.length ? 'flagged' : 'created',
    flags,
    recommendationId: rec.id,
  });
}
