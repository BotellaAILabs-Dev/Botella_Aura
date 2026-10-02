import type { BusinessContextQuestion } from '@prisma/client';

import { db } from '@/lib/db';
import type { BusinessContext } from '@/lib/business-context';
import {
  answerToUpdate,
  detectGaps,
  isLinkedQuestion,
  questionFor,
  questionAnswerSchema,
  type Gap,
  type Question,
} from '@/lib/business-context-questions';
import {
  fieldsUsedBy,
  getBusinessContext,
  WORKFLOW_PRESETS,
  WORKFLOW_REQUIREMENTS,
  type ContextWorkflow,
} from './business-context.service';
import { updateBusinessContext } from './business-context-write.service';

/**
 * Which questions Aura asks, and remembering what happened to them.
 *
 * The questions are derived from the Business Context on every request — a
 * gap that has been filled in by any route simply stops producing a question.
 * The `BusinessContextQuestion` table only remembers history, so Aura does not
 * nag: see QUESTION_RULES.
 */

export const QUESTION_RULES = {
  /** Showing a question counts as asking it at most once per this window. */
  askCooldownMs: 12 * 60 * 60 * 1000,
  /** "Not now" hides a question for this long. */
  notNowDays: 7,
  /** After this many asks without an answer, a question rests automatically… */
  autoRestAfterAsks: 3,
  /** …for this long (critical questions come back sooner). */
  autoRestDays: { critical: 3, important: 14, optional: 14 },
} as const;

const DAY_MS = 86_400_000;

export class QuestionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'QuestionError';
  }
}

export interface QuestionWithState extends Question {
  timesAsked: number;
  lastAskedAt: string | null;
}

export interface QuestionsResult {
  questions: QuestionWithState[];
  /** All questions that could be asked right now, before the limit. */
  openCount: number;
  /** How many of those are critical. */
  criticalCount: number;
}

/**
 * Gaps a workflow cares about: the fields its prompt uses or requires.
 * Without a workflow, every critical and important gap — optional ones are
 * only worth asking about when something is about to use them.
 */
function relevant(gaps: Gap[], workflow?: ContextWorkflow): Gap[] {
  if (!workflow) return gaps.filter((g) => g.priority !== 'optional');
  const used = fieldsUsedBy(WORKFLOW_PRESETS[workflow]);
  for (const f of WORKFLOW_REQUIREMENTS[workflow].requires) used.add(f);
  return gaps.filter((g) => used.has(g.field));
}

/**
 * Bring stored history in line with the current gaps: close questions whose
 * gap has gone, and reopen answered ones whose gap has come back (a goal
 * confirmed in spring that is out of date again by autumn).
 */
async function sync(
  companyId: string,
  gaps: Gap[],
  rows: BusinessContextQuestion[],
) {
  const live = new Set(gaps.map((g) => g.key));
  const close = rows.filter(
    (r) =>
      (r.status === 'OPEN' || r.status === 'SNOOZED') &&
      !live.has(r.questionKey),
  );
  const reopen = rows.filter(
    (r) =>
      (r.status === 'ANSWERED' || r.status === 'RESOLVED') &&
      live.has(r.questionKey),
  );
  await Promise.all([
    close.length
      ? db.businessContextQuestion.updateMany({
          where: {
            companyId,
            questionKey: { in: close.map((r) => r.questionKey) },
          },
          data: { status: 'RESOLVED', snoozedUntil: null },
        })
      : null,
    reopen.length
      ? db.businessContextQuestion.updateMany({
          where: {
            companyId,
            questionKey: { in: reopen.map((r) => r.questionKey) },
          },
          data: {
            status: 'OPEN',
            timesAsked: 0,
            snoozedUntil: null,
            answeredAt: null,
          },
        })
      : null,
  ]);
  for (const r of close) r.status = 'RESOLVED';
  for (const r of reopen)
    Object.assign(r, { status: 'OPEN', timesAsked: 0, snoozedUntil: null });
}

/** Can this question be asked now, given its history? Pure, for testing. */
export function isAskable(
  gap: Gap,
  row:
    | Pick<
        BusinessContextQuestion,
        'status' | 'snoozedUntil' | 'timesAsked' | 'lastAskedAt'
      >
    | undefined,
  now: Date,
): boolean {
  if (!row) return true;
  if (row.status === 'DISMISSED') return false;
  if (row.snoozedUntil && row.snoozedUntil > now) return false;
  if (row.timesAsked >= QUESTION_RULES.autoRestAfterAsks && row.lastAskedAt) {
    const rest = QUESTION_RULES.autoRestDays[gap.priority] * DAY_MS;
    if (now.getTime() - row.lastAskedAt.getTime() < rest) return false;
  }
  return true;
}

export async function getQuestions(
  companyId: string,
  options: {
    workflow?: ContextWorkflow;
    limit?: number;
    /** Record these as asked (when they are actually shown to a person). */
    markAsked?: boolean;
    now?: Date;
    /** An already-loaded full context, to avoid a second read. */
    context?: BusinessContext;
  } = {},
): Promise<QuestionsResult | null> {
  const now = options.now ?? new Date();
  const [ctx, rows] = await Promise.all([
    options.context
      ? Promise.resolve(options.context)
      : getBusinessContext(companyId),
    db.businessContextQuestion.findMany({ where: { companyId } }),
  ]);
  if (!ctx) return null;

  const allGaps = detectGaps(ctx);
  await sync(companyId, allGaps, rows);

  const byKey = new Map(rows.map((r) => [r.questionKey, r]));
  const askable = relevant(allGaps, options.workflow).filter((g) =>
    isAskable(g, byKey.get(g.key), now),
  );
  const chosen = askable.slice(0, options.limit ?? 3);

  if (options.markAsked && chosen.length) {
    await Promise.all(
      chosen.map((g) => {
        const row = byKey.get(g.key);
        const counts =
          !row?.lastAskedAt ||
          now.getTime() - row.lastAskedAt.getTime() >=
            QUESTION_RULES.askCooldownMs;
        if (row && !counts) return null;
        return db.businessContextQuestion.upsert({
          where: { companyId_questionKey: { companyId, questionKey: g.key } },
          create: {
            companyId,
            questionKey: g.key,
            timesAsked: 1,
            lastAskedAt: now,
          },
          update: {
            timesAsked: { increment: 1 },
            lastAskedAt: now,
            status: 'OPEN',
          },
        });
      }),
    );
  }

  return {
    questions: chosen.map((g) => {
      const row = byKey.get(g.key);
      return {
        ...questionFor(g, ctx),
        timesAsked: row?.timesAsked ?? 0,
        lastAskedAt: row?.lastAskedAt?.toISOString() ?? null,
      };
    }),
    openCount: askable.length,
    criticalCount: askable.filter((g) => g.priority === 'critical').length,
  };
}

/**
 * Apply an answer to the Business Context.
 *
 * The question is re-derived from the current context first: if the gap is
 * already filled (answered in another tab, or edited on the page), the answer
 * is refused rather than overwriting what is there.
 */
export async function answerQuestion(args: {
  companyId: string;
  userId: string;
  key: string;
  answer: unknown;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}): Promise<{ changed: string[]; confirmed: string[] }> {
  const answer = questionAnswerSchema.parse(args.answer);
  const ctx = await getBusinessContext(args.companyId);
  if (!ctx) throw new QuestionError('Company not found.', 404);
  const gap = detectGaps(ctx).find((g) => g.key === args.key);
  if (!gap) {
    throw new QuestionError(
      'That question has already been answered. Reload to see the latest.',
      409,
    );
  }
  if (isLinkedQuestion(gap.field)) {
    throw new QuestionError(
      'This one is answered on its own page — follow the link, and the question closes by itself.',
      422,
    );
  }
  if (answer.confirm && gap.kind === 'missing') {
    throw new QuestionError(
      'There is nothing to confirm yet — please answer the question.',
      422,
    );
  }

  const update = answerToUpdate(gap, answer, ctx);
  const result = await updateBusinessContext({
    companyId: args.companyId,
    userId: args.userId,
    patch: update.patch,
    confirm: update.confirm,
    origin: 'settings',
    // Errors come back keyed by the question, so the form can show them.
    aliases: Object.fromEntries(
      [gap.field, 'voice.notes', 'voice.profile'].map((p) => [p, 'answer']),
    ),
    auditMetadata: { question: args.key },
    requestMeta: args.requestMeta,
  });

  await db.businessContextQuestion.upsert({
    where: {
      companyId_questionKey: {
        companyId: args.companyId,
        questionKey: args.key,
      },
    },
    create: {
      companyId: args.companyId,
      questionKey: args.key,
      status: 'ANSWERED',
      answeredAt: new Date(),
      answeredById: args.userId,
    },
    update: {
      status: 'ANSWERED',
      answeredAt: new Date(),
      answeredById: args.userId,
      snoozedUntil: null,
    },
  });
  return { changed: result.changed, confirmed: result.confirmed };
}

/**
 * "Not now" (snooze) or "Doesn't apply" (dismiss).
 *
 * A critical question can only be put off: Aura cannot do specific work
 * without it, and permanently silencing it would leave Aura either guessing or
 * stuck without ever saying why.
 */
export async function setQuestionAside(args: {
  companyId: string;
  key: string;
  mode: 'snooze' | 'dismiss';
  now?: Date;
}): Promise<void> {
  const ctx = await getBusinessContext(args.companyId);
  if (!ctx) throw new QuestionError('Company not found.', 404);
  const gap = detectGaps(ctx).find((g) => g.key === args.key);
  if (!gap)
    throw new QuestionError('That question no longer needs an answer.', 409);
  if (args.mode === 'dismiss' && gap.priority === 'critical') {
    throw new QuestionError(
      'Aura needs this to do work specific to your business, so it can be put off but not dismissed.',
      422,
    );
  }
  const now = args.now ?? new Date();
  const data =
    args.mode === 'snooze'
      ? {
          status: 'SNOOZED' as const,
          snoozedUntil: new Date(
            now.getTime() + QUESTION_RULES.notNowDays * DAY_MS,
          ),
        }
      : { status: 'DISMISSED' as const, snoozedUntil: null };
  await db.businessContextQuestion.upsert({
    where: {
      companyId_questionKey: {
        companyId: args.companyId,
        questionKey: args.key,
      },
    },
    create: { companyId: args.companyId, questionKey: args.key, ...data },
    update: data,
  });
}
