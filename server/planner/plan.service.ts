import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { complete, getModel, isClaudeConfigured } from '@/server/ai/claude';
import { getBrandVoiceProfile } from '@/server/content/brand-voice.service';
import {
  getBrandContext,
  brandContextToPrompt,
} from '@/server/brand/brand-context.service';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import { normalizeDigestPayload } from '@/server/trends/digest.service';
import {
  DRAFT_BUDGET_MS,
  draftCalendar,
  outlineCalendar,
  type AskModel,
} from '@/server/planner/calendar-draft';
import {
  type PlanInputs,
  type PlanItem,
  type PlanWeek,
} from '@/lib/validations/planner';

/**
 * AI Marketing Planner — turns an explicit brief (business goals, campaign
 * objectives, topics, brand guidelines) into a dated monthly content calendar.
 *
 * The calendar is generated against a real schedule skeleton we compute here:
 * the actual weekdays of the requested month, spread to the requested cadence.
 * The model fills those slots with themes and briefs; it never invents dates,
 * which is what keeps "a monthly calendar" from degrading into a topic list.
 */
export interface MarketingPlanPayload {
  generatedAt: string;
  model: string;
  month: string; // YYYY-MM
  summary: string;
  weeks: PlanWeek[];
  items: PlanItem[];
  /** Real-world context that shaped the plan (trends, brand voice, knowledge). */
  groundedOn: string[];
  /**
   * Parts the model did not deliver in time, filled from the brief instead.
   * Absent when the model wrote everything (and on plans saved before this).
   */
  outline?: { weeks: number[]; slots: number; strategy: boolean };
  /** How long the run took, start to saved. */
  durationMs?: number;
}

export class PlannerError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

/** First day of the plan month in UTC. */
function monthStart(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the publishing slots for a month: weekday dates, evenly spread across
 * each week to the requested cadence. Returns real dates the plan must use.
 */
export function buildSchedule(
  month: string,
  postsPerWeek: number,
): { date: string; week: number }[] {
  const start = monthStart(month);
  const daysInMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();

  // Group the month's weekdays by ISO week-of-month.
  const weeks: Date[][] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), day),
    );
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekdays only
    const weekIndex = Math.floor((day - 1) / 7);
    (weeks[weekIndex] ??= []).push(d);
  }

  const slots: { date: string; week: number }[] = [];
  weeks.forEach((days, i) => {
    if (days.length === 0) return;
    const take = Math.min(postsPerWeek, days.length);
    // Spread evenly rather than clustering on Monday/Tuesday.
    const step = days.length / take;
    for (let n = 0; n < take; n++) {
      const pick = days[Math.min(days.length - 1, Math.floor(n * step))]!;
      slots.push({ date: isoDate(pick), week: i + 1 });
    }
  });
  return slots;
}

/** Generate (or regenerate) the plan for a month. Idempotent per company/month. */
export async function generateMarketingPlan(args: {
  companyId: string;
  userId?: string | null;
  inputs: PlanInputs;
  /** Optional status line for the background-job runner. */
  onProgress?: (message: string, percent: number) => void | Promise<void>;
  /** Swap the model (tests and the speed check). Defaults to the shared AI client. */
  ask?: AskModel;
  /** Drafting time budget in ms. Defaults to DRAFT_BUDGET_MS. */
  budgetMs?: number;
}): Promise<MarketingPlanPayload> {
  const { companyId, userId, inputs, onProgress } = args;
  const startedAt = Date.now();
  const report = async (message: string, percent: number) => {
    try {
      await onProgress?.(message, percent);
    } catch {
      // Progress is cosmetic — never fail a plan because reporting failed.
    }
  };

  await report('Reading your brief…', 8);
  const slots = buildSchedule(inputs.month, inputs.postsPerWeek);
  if (slots.length === 0) {
    throw new PlannerError('That month has no publishable weekdays.');
  }

  /**
   * Everything the strategist reads, fetched once and side by side — these
   * used to run one after another before the model was even asked.
   *
   * The saved workspace profile sits behind the plan form's own fields. The
   * planner page pre-fills `audience`, `businessGoals` and `channels` from
   * settings, but what it never carried is what the company DOES — and if a
   * user clears the pre-filled audience, nothing downstream knew who to write
   * for.
   */
  const [company, brand, digest, knowledge] = await Promise.all([
    db.company.findUnique({ where: { id: companyId } }),
    getBrandContext(companyId),
    db.trendDigest.findFirst({
      where: { companyId },
      orderBy: { date: 'desc' },
      select: { payload: true },
    }),
    retrieve(companyId, [inputs.businessGoals, ...inputs.topics].join(' '), {
      limit: 6,
    })
      .then(chunksToContext)
      .catch((err: unknown) => {
        logger.warn('planner: knowledge retrieval failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
        return '';
      }),
  ]);
  if (!company) throw new Error('Company not found.');

  const groundedOn: string[] = [];
  const voice = getBrandVoiceProfile(company);
  if (voice) groundedOn.push('Your saved brand voice profile');
  // Recent market context makes the plan timely rather than evergreen filler.
  const trendTitles = digest
    ? normalizeDigestPayload(digest.payload)
        .items.slice(0, 8)
        .map((i) => i.title)
    : [];
  if (trendTitles.length) {
    groundedOn.push(`${trendTitles.length} current trend topics`);
  }
  if (knowledge) groundedOn.push('Your knowledge base');

  let body: { summary: string; weeks: PlanWeek[]; items: PlanItem[] };
  let model = 'none';
  let outline: MarketingPlanPayload['outline'];

  if (!args.ask && !isClaudeConfigured()) {
    await report(`Laying out ${slots.length} dated slots across the month…`, 60);
    body = outlineCalendar(inputs, slots);
  } else {
    const system =
      `You are the content strategist for ${company.name}` +
      `${company.industry ? ` (${company.industry})` : ''}.\n` +
      // Identity and reader from the saved profile; the brief's own fields
      // still win where the user filled them in below.
      `${brandContextToPrompt(brand, { includeVoice: false, includeWritingRules: false })}\n` +
      'You are building a MONTHLY CONTENT CALENDAR from the brief below. Hard rules: ' +
      '(1) Use ONLY the exact dates you are given — never invent or move a date. ' +
      '(2) Every item must serve one of the stated campaign objectives and say ' +
      'which in `objective`. ' +
      '(3) The weeks build one narrative arc across the month. ' +
      '(4) Respect the brand guidelines exactly; if they forbid something, ' +
      'do not do it. ' +
      'Respond with ONLY JSON matching the shape you are asked for.';
    const brief = [
      `MONTH: ${inputs.month}`,
      `CHANNELS: ${inputs.channels.join(', ')}`,
      `CADENCE: ${inputs.postsPerWeek} posts per week`,
      '',
      `BUSINESS GOALS:\n${inputs.businessGoals}`,
      '',
      `CAMPAIGN OBJECTIVES:\n${inputs.campaignObjectives}`,
      '',
      `TOPICS TO COVER:\n${inputs.topics.join(', ') || '(none specified — choose from the goals)'}`,
      '',
      // Falls back to the saved workspace audience, so clearing the
      // pre-filled field does not leave the strategist writing for nobody.
      `AUDIENCE:\n${inputs.audience || brand?.audience?.stated || '(not specified)'}`,
      '',
      `BRAND GUIDELINES:\n${
        inputs.brandGuidelines ||
        voice?.summary ||
        company.brandVoiceNotes ||
        '(none specified)'
      }`,
      voice
        ? `\nBRAND VOICE: tone ${voice.toneDescriptors.join(', ')}; ${voice.formatting.notes}`
        : '',
      trendTitles.length
        ? `\nCURRENT MARKET TOPICS (use where genuinely relevant):\n- ${trendTitles.join('\n- ')}`
        : '',
      knowledge ? `\nCOMPANY KNOWLEDGE:\n${knowledge.slice(0, 4000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const ask: AskModel =
      args.ask ??
      ((request) =>
        complete({
          system: request.system,
          prompt: request.prompt,
          maxTokens: request.maxTokens,
          effort: request.effort,
          timeoutMs: request.timeoutMs,
          // The draft decides itself whether there is time for another try.
          maxAttempts: 1,
          json: true,
        }));

    const draft = await draftCalendar({
      inputs,
      slots,
      system,
      brief,
      ask,
      // The budget counts from the start of the run, so a slow database read
      // above eats into it rather than pushing past the runner's limit.
      deadline: startedAt + (args.budgetMs ?? DRAFT_BUDGET_MS),
      onProgress: report,
    });
    if (draft.issues.length) {
      logger.warn('planner: parts of the calendar fell back to an outline', {
        companyId,
        month: inputs.month,
        outlineWeeks: draft.outlineWeeks,
        outlineSlots: draft.outlineSlots,
        issues: draft.issues,
      });
    }
    body = { summary: draft.summary, weeks: draft.weeks, items: draft.items };
    const wroteAnything =
      draft.strategyFromModel || draft.outlineSlots < slots.length;
    model = wroteAnything ? (args.ask ? 'test-model' : getModel()) : 'outline';
    if (draft.outlineSlots > 0 || !draft.strategyFromModel) {
      outline = {
        weeks: draft.outlineWeeks,
        slots: draft.outlineSlots,
        strategy: !draft.strategyFromModel,
      };
    }
  }

  const payload: MarketingPlanPayload = {
    generatedAt: new Date().toISOString(),
    model,
    month: inputs.month,
    ...body,
    groundedOn,
    ...(outline ? { outline } : {}),
    durationMs: Date.now() - startedAt,
  };

  await report('Saving your calendar…', 92);
  const month = monthStart(inputs.month);
  await db.marketingPlan.upsert({
    where: { companyId_month: { companyId, month } },
    create: {
      companyId,
      month,
      inputs: inputs as unknown as object,
      payload: payload as unknown as object,
      model,
      createdById: userId ?? null,
    },
    update: {
      inputs: inputs as unknown as object,
      payload: payload as unknown as object,
      model,
      generatedAt: new Date(),
    },
  });

  await recordAudit({
    action: 'MARKETING_PLAN_GENERATED',
    userId: userId ?? null,
    companyId,
    metadata: {
      month: inputs.month,
      items: payload.items.length,
      channels: inputs.channels,
      model,
    },
  });

  return payload;
}

export async function listPlans(companyId: string) {
  return db.marketingPlan.findMany({
    where: { companyId },
    orderBy: { month: 'desc' },
    take: 12,
  });
}

export async function getPlanForMonth(companyId: string, month: string) {
  return db.marketingPlan.findUnique({
    where: { companyId_month: { companyId, month: monthStart(month) } },
  });
}
