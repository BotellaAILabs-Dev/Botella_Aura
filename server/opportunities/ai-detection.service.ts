import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  AI_DETECTION_PROMPT_VERSION,
  aiResponseSchema,
  aiToOpportunityInput,
  buildAiDetectionPrompt,
  selectSignalsForAi,
  validateAiOutput,
  type AiRejection,
} from '@/lib/ai-opportunity-detection';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import {
  completeStructured,
  getModel,
  isClaudeConfigured,
} from '@/server/ai/claude';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
import { recordAudit } from '@/server/services/audit.service';
import { listSignals } from '@/server/signals/signal.service';
import { recordOpportunity, type RecordOutcome } from './opportunity.service';

/**
 * Running AI-assisted opportunity detection (lib/ai-opportunity-detection.ts)
 * for a workspace: snapshot + relevant signals in, validated opportunities
 * stored, everything rejected flagged with its reasons.
 *
 * FALLBACK. AI detection only ever adds to what the rules found; it never
 * replaces or edits them, and it never stores anything it could not validate.
 *
 *   skipped   no AI provider, or too little signal to interpret — no call made
 *   failed    the call failed, or the response was not valid JSON of the
 *             required shape even after completeStructured's one retry —
 *             nothing stored
 *   rejected  the response parsed, but every opportunity failed validation —
 *             nothing stored
 *   partial   some opportunities stored, the rest rejected
 *   ok        everything returned was valid (including "nothing to propose")
 *
 * Every run that calls the model is written to the audit log with its status,
 * model, snapshot fingerprint and each rejection, so invalid output is
 * reviewable rather than silently dropped.
 */

/** Below this many relevant signals there is nothing to interpret. */
const MIN_SIGNALS = 2;

export type AiDetectionStatus =
  'ok' | 'partial' | 'rejected' | 'failed' | 'skipped';

export interface AiDetectionRun {
  status: AiDetectionStatus;
  /** Why it was skipped or failed, in plain words. */
  reason?: string;
  model: string | null;
  promptVersion: string;
  snapshotFingerprint: string | null;
  signalsSent: number;
  /** The model's own explanation when it proposed nothing. */
  noOpportunityReason?: string;
  outcomes: {
    title: string;
    type: string;
    outcome: RecordOutcome;
    opportunityId: string;
    confidence: string;
    mergedInto?: string;
  }[];
  rejected: AiRejection[];
}

/** The model call, replaceable in tests and verification scripts. */
export type AiComplete = (args: {
  system: string;
  prompt: string;
}) => Promise<unknown>;

const defaultComplete: AiComplete = ({ system, prompt }) =>
  completeStructured({
    schema: aiResponseSchema,
    system,
    prompt,
    tier: 'standard',
    effort: 'medium',
    maxTokens: 4000,
  });

export async function runAiDetection(
  companyId: string,
  options: {
    now?: Date;
    /** Model call override; defaults to the configured provider. */
    complete?: AiComplete;
    /** Model name to record when `complete` is overridden. */
    model?: string;
    userId?: string | null;
  } = {},
): Promise<AiDetectionRun | null> {
  const now = options.now ?? new Date();
  const model = options.complete
    ? (options.model ?? 'custom')
    : isClaudeConfigured()
      ? getModel('standard')
      : null;
  const base = {
    model,
    promptVersion: AI_DETECTION_PROMPT_VERSION,
    outcomes: [],
    rejected: [],
  };

  const snap = await getContextSnapshot(companyId, {
    view: 'opportunity',
    now,
  });
  if (!snap) return null;
  const fingerprint = snap.snapshot.fingerprint;

  if (!model) {
    return {
      ...base,
      status: 'skipped',
      reason: 'No AI provider is configured; rule-based detection still ran.',
      snapshotFingerprint: fingerprint,
      signalsSent: 0,
    };
  }

  const [stored, rejectedEvidence] = await Promise.all([
    listSignals(companyId, { now, limit: 500 }),
    db.opportunitySignal.findMany({
      where: {
        opportunity: { companyId, status: 'REJECTED' },
        signalId: { not: null },
      },
      select: { signalId: true },
    }),
  ]);
  const signals = selectSignalsForAi(stored, {
    now,
    rejectedSignalIds: new Set(rejectedEvidence.map((r) => r.signalId!)),
  });
  if (signals.length < MIN_SIGNALS) {
    return {
      ...base,
      status: 'skipped',
      reason: `Only ${signals.length} relevant signal(s) — not enough to interpret. Track competitors or refresh trends.`,
      snapshotFingerprint: fingerprint,
      signalsSent: signals.length,
    };
  }

  const { system, prompt, refs } = buildAiDetectionPrompt({
    snapshot: snap.snapshot,
    snapshotText: snap.prompt,
    signals,
  });

  let run: AiDetectionRun;
  try {
    const raw = await (options.complete ?? defaultComplete)({ system, prompt });
    const envelope = aiResponseSchema.safeParse(raw);
    if (!envelope.success) {
      throw new Error(
        `response is not in the required shape: ${envelope.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    const { accepted, rejected } = validateAiOutput(
      envelope.data.opportunities,
      { refs, snapshot: snap.snapshot, snapshotText: snap.prompt, now },
    );

    run = {
      ...base,
      status: 'ok',
      snapshotFingerprint: fingerprint,
      signalsSent: signals.length,
      rejected,
      ...(envelope.data.noOpportunityReason && accepted.length === 0
        ? { noOpportunityReason: envelope.data.noOpportunityReason }
        : {}),
      outcomes: [],
    };

    for (const v of accepted) {
      const input = aiToOpportunityInput(v, {
        model,
        snapshotFingerprint: fingerprint,
        now,
      });
      try {
        // Same opening already open — found by a rule, the advisor or an
        // earlier AI run, citing any of the same records: add to it.
        const existing = await db.opportunity.findFirst({
          where: {
            companyId,
            type: input.type,
            status: { in: ACTIVE_STATUSES },
            dedupeKey: { not: input.dedupeKey },
            signals: {
              some: {
                OR: v.signals
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
          { now, contextFingerprint: fingerprint },
        );
        run.outcomes.push({
          title: opportunity.title,
          type: opportunity.type,
          outcome,
          opportunityId: opportunity.id,
          confidence: opportunity.confidence,
          ...(existing ? { mergedInto: existing.id } : {}),
        });
      } catch (err) {
        logger.warn('ai-detection: could not record opportunity', {
          companyId,
          title: v.output.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (rejected.length) {
      run.status = run.outcomes.length ? 'partial' : 'rejected';
    }
  } catch (err) {
    run = {
      ...base,
      status: 'failed',
      reason: `AI output could not be used (${err instanceof Error ? err.message : String(err)}). Nothing was stored; rule-based detection is unaffected.`,
      snapshotFingerprint: fingerprint,
      signalsSent: signals.length,
    };
    logger.warn('ai-detection: run failed', { companyId, reason: run.reason });
  }

  await recordAudit({
    action: 'OPPORTUNITY_AI_DETECTION_RUN',
    userId: options.userId ?? null,
    companyId,
    metadata: {
      status: run.status,
      model,
      promptVersion: AI_DETECTION_PROMPT_VERSION,
      snapshotFingerprint: fingerprint,
      signalsSent: run.signalsSent,
      stored: run.outcomes.length,
      ...(run.reason ? { reason: run.reason.slice(0, 500) } : {}),
      rejected: run.rejected.slice(0, 20).map((r) => ({
        title: r.title,
        reasons: r.reasons.map((x) => `${x.code}: ${x.detail}`.slice(0, 300)),
      })),
    },
  });

  return run;
}
