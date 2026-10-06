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
  CONFIDENCE_RULES,
  applyGuardrails,
  capRelevance,
  executability,
  findConflicts,
  findDuplicate,
  frequencyBreach,
  mutedActions,
  type RecentRecommendation,
} from '@/lib/recommendation-rules';
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

const DAY = 86_400_000;

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
  /** Whether the stored recommendation may be acted on, and why not. */
  executable?: boolean;
  blockers?: string[];
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

  // --- Guardrails: frequency (lib/recommendation-rules.ts) --------------------
  const recent = await loadRecent(args.companyId, now);
  const breach = frequencyBreach({
    createdLastDay: recent.filter(
      (r) => now.getTime() - r.createdAt.getTime() < DAY,
    ).length,
    open: recent.filter((r) => r.status === 'PROPOSED').length,
  });
  if (breach)
    return finish({ ...base, reasons: [`Frequency limit: ${breach}`] });

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
  const selection = applyGuardrails(selectActions(h, ctx, own, now), {
    h,
    muted: mutedActions(recent, now),
  });
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
  const channelBreach = frequencyBreach({
    createdLastDay: 0,
    open: 0,
    channel: chosen.spec.needsChannel ? chosen.channel : null,
    sameChannelLastWeek: recent.filter(
      (r) =>
        r.channel === chosen.channel &&
        now.getTime() - r.createdAt.getTime() < 7 * DAY,
    ).length,
  });
  if (channelBreach) {
    return finish({
      ...report,
      reasons: [`Frequency limit: ${channelBreach}`],
    });
  }

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
  const duplicate = findDuplicate(
    {
      opportunityId: args.opportunityId,
      title: content.title,
      type: content.type,
      channel: content.channel,
    },
    recent,
    now,
  );
  if (duplicate) {
    return finish({
      ...report,
      reasons: [`Duplicate: it ${duplicate.reason}.`],
      flags: gate.flags,
    });
  }
  const a = assess(h, chosen, gate.flags, now);
  const competitor =
    own
      .map((x) => (x.metadata as { competitor?: unknown } | null)?.competitor)
      .find((c): c is string => typeof c === 'string') ?? null;
  const conflicts = findConflicts(
    {
      opportunityId: args.opportunityId,
      actionId: chosen.spec.id,
      signalIds: evidenceIds,
      competitor,
      priorityScore: a.priorityScore,
    },
    recent,
  );
  const guard = executability({
    type: content.type,
    channel: content.channel,
    confidence: a.confidence,
    ctx,
  });
  const flags = [
    ...new Set([
      ...report.flags,
      ...gate.flags,
      ...(CONFIDENCE_RULES[a.confidence].flag
        ? [CONFIDENCE_RULES[a.confidence].flag!]
        : []),
      ...conflicts.map(
        (c) =>
          `conflicts with “${c.title}” (${c.why}): ${c.precedence === 'this' ? 'this one goes first' : 'do that one first'}`,
      ),
    ]),
  ];

  const rec = await createRecommendationFromOpportunity({
    companyId: args.companyId,
    opportunityId: args.opportunityId,
    createdBy: args.requestedBy ?? `${ENGINE_VERSION}:${report.writtenBy}`,
    actorId: args.actorId,
    now,
    priority: { priority: a.priority, priorityScore: a.priorityScore },
    guardrails: {
      executable: guard.executable,
      blockers: guard.blockers,
      flags,
    },
    content: {
      ...content,
      // EXPIRATION: the opportunity's window, at most 30 days.
      relevantUntil: capRelevance(
        h.opportunity.relevantUntil
          ? new Date(h.opportunity.relevantUntil)
          : null,
        now,
      ),
      confidence: a.confidence,
      confidenceReason: a.confidenceReason,
      details: {
        ...content.details,
        ...(competitor ? { competitor } : {}),
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

  // The other side of each conflict hears about it too.
  for (const c of conflicts) {
    const other = recent.find((r) => r.id === c.id);
    if (!other) continue;
    const note = `conflicts with “${content.title}” (${c.why}): ${c.precedence === 'this' ? 'do that one first' : 'this one goes first'}`;
    await db.recommendation.update({
      where: { id: c.id },
      data: { flags: { push: note } },
    });
  }

  return finish({
    ...report,
    status: flags.length ? 'flagged' : 'created',
    flags,
    recommendationId: rec.id,
    executable: guard.executable,
    blockers: guard.blockers,
  });
}

/**
 * The workspace's recommendations that the frequency, duplicate, muting and
 * conflict rules look at: everything in play, and anything made or decided
 * in the last 30 days.
 */
async function loadRecent(
  companyId: string,
  now: Date,
): Promise<RecentRecommendation[]> {
  const since = new Date(now.getTime() - 30 * DAY);
  const rows = await db.recommendation.findMany({
    where: {
      companyId,
      OR: [
        { status: { in: LIVE_RECOMMENDATION_STATUSES } },
        { createdAt: { gte: since } },
        { decidedAt: { gte: since } },
      ],
    },
    select: {
      id: true,
      opportunityId: true,
      title: true,
      type: true,
      channel: true,
      status: true,
      priorityScore: true,
      createdAt: true,
      decidedAt: true,
      details: true,
      evidence: { select: { signalId: true } },
    },
    take: 500,
  });
  return rows.map((r) => {
    const d = (r.details ?? {}) as { action?: unknown; competitor?: unknown };
    return {
      id: r.id,
      opportunityId: r.opportunityId,
      title: r.title,
      type: r.type,
      actionId: typeof d.action === 'string' ? d.action : null,
      channel: r.channel,
      status: r.status,
      priorityScore: r.priorityScore,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      signalIds: r.evidence
        .map((e) => e.signalId)
        .filter((x): x is string => Boolean(x)),
      competitor: typeof d.competitor === 'string' ? d.competitor : null,
    };
  });
}
