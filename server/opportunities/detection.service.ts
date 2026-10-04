import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { BusinessContext } from '@/lib/business-context';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import {
  candidateToInput,
  detectOpportunities,
  mutedRules,
  type DetectionResult,
} from '@/lib/opportunity-detection';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { collectSignals, listSignals } from '@/server/signals/signal.service';
import { recordOpportunity, type RecordOutcome } from './opportunity.service';

/**
 * Running the detection rules (lib/opportunity-detection.ts) against a
 * workspace's signal store, and recording what they find.
 *
 * Everything the rules need from history is read here: which rules have been
 * producing rejected opportunities (muted), and which signals were evidence in
 * an opportunity the business rejected (not proposed again).
 */

export interface DetectionRun {
  outcomes: {
    title: string;
    rule: string;
    outcome: RecordOutcome;
    opportunityId: string;
    mergedInto?: string;
  }[];
  suppressed: DetectionResult['suppressed'];
  mutedRules: string[];
  signalsRead: number;
}

export async function runDetection(
  companyId: string,
  options: {
    now?: Date;
    context?: BusinessContext | null;
    collect?: boolean;
  } = {},
): Promise<DetectionRun | null> {
  const now = options.now ?? new Date();
  const context =
    options.context !== undefined
      ? options.context
      : await getBusinessContext(companyId);
  if (!context) return null;
  if (options.collect) await collectSignals(companyId, { now, context });

  const [signals, history, rejectedEvidence] = await Promise.all([
    listSignals(companyId, { now, limit: 500 }),
    db.opportunity.findMany({
      where: {
        companyId,
        detectedBy: { startsWith: 'rule:' },
        status: { in: ['ACCEPTED', 'REJECTED'] },
      },
      select: { detectedBy: true, status: true, decidedAt: true },
    }),
    db.opportunitySignal.findMany({
      where: {
        opportunity: { companyId, status: 'REJECTED' },
        signalId: { not: null },
      },
      select: { signalId: true },
    }),
  ]);

  const muted = mutedRules(
    history.map((h) => ({
      rule: h.detectedBy.replace(/^rule:/, ''),
      status: h.status,
      decidedAt: h.decidedAt,
    })),
    now,
  );
  const result = detectOpportunities(signals, context, {
    now,
    mutedRules: muted,
    rejectedSignalIds: new Set(rejectedEvidence.map((r) => r.signalId!)),
  });

  const run: DetectionRun = {
    outcomes: [],
    suppressed: result.suppressed,
    mutedRules: [...muted],
    signalsRead: signals.length,
  };

  for (const candidate of result.accepted) {
    const input = candidateToInput(candidate);
    try {
      // DUPLICATES ACROSS DETECTORS — an open opportunity of the same type
      // that already cites one of these records (found by the advisor, or by
      // this rule in an earlier period) is the same opportunity: merge into it.
      const existing = await db.opportunity.findFirst({
        where: {
          companyId,
          type: input.type,
          status: { in: ACTIVE_STATUSES },
          dedupeKey: { not: input.dedupeKey },
          signals: {
            some: {
              OR: candidate.signals
                .filter((s) => s.refId)
                .map((s) => ({ kind: s.kind, refId: s.refId })),
            },
          },
        },
        select: { id: true, dedupeKey: true },
      });
      const { opportunity, outcome } = await recordOpportunity(
        companyId,
        existing ? { ...input, dedupeKey: existing.dedupeKey } : input,
        { now, context },
      );
      run.outcomes.push({
        title: candidate.title,
        rule: candidate.rule,
        outcome,
        opportunityId: opportunity.id,
        ...(existing ? { mergedInto: existing.id } : {}),
      });
    } catch (err) {
      logger.warn('detection: could not record candidate', {
        companyId,
        rule: candidate.rule,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return run;
}
