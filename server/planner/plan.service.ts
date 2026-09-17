import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  getModel,
  isClaudeConfigured,
} from '@/server/ai/claude';
import { getBrandVoiceProfile } from '@/server/content/brand-voice.service';
import {
  getBrandContext,
  brandContextToPrompt,
} from '@/server/brand/brand-context.service';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import { normalizeDigestPayload } from '@/server/trends/digest.service';
import {
  planPayloadSchema,
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

/** Cycle content types sensibly per channel when we have no model. */
function defaultTypeFor(channel: string, index: number): PlanItem['contentType'] {
  if (channel === 'Blog' || channel === 'Newsletter') return 'BLOG';
  if (channel === 'X') return 'TWEET_THREAD';
  return index % 4 === 3 ? 'CAROUSEL' : 'LINKEDIN_POST';
}

/** A usable calendar without any AI provider — real dates, real structure. */
function deterministicPlan(
  inputs: PlanInputs,
  slots: { date: string; week: number }[],
): { summary: string; weeks: PlanWeek[]; items: PlanItem[] } {
  const topics = inputs.topics.length
    ? inputs.topics
    : ['Customer problem', 'How we solve it', 'Proof', 'Point of view'];

  const weekNumbers = [...new Set(slots.map((s) => s.week))];
  const weeks: PlanWeek[] = weekNumbers.map((w, i) => ({
    week: w,
    theme: topics[i % topics.length]!,
    goal: inputs.campaignObjectives.slice(0, 280),
  }));

  const items: PlanItem[] = slots.map((slot, i) => {
    const channel = inputs.channels[i % inputs.channels.length]!;
    const theme = topics[(slot.week - 1) % topics.length]!;
    return {
      date: slot.date,
      week: slot.week,
      channel,
      contentType: defaultTypeFor(channel, i),
      theme,
      title: `${theme} — piece ${i + 1}`,
      hook: `Open with a concrete example of "${theme}" from your own work.`,
      brief: `Write about ${theme} for ${inputs.audience || 'your target audience'}. Tie it back to the objective: ${inputs.campaignObjectives}.`,
      cta: 'Invite a reply with the reader’s own experience.',
      hashtags: [],
      objective: inputs.campaignObjectives.slice(0, 180),
    };
  });

  return {
    summary: `A ${slots.length}-piece calendar across ${inputs.channels.join(', ')} at ${inputs.postsPerWeek}/week. Generated without an AI provider, so themes cycle through your stated topics — connect a provider for a strategy-led plan.`,
    weeks,
    items,
  };
}

/** Generate (or regenerate) the plan for a month. Idempotent per company/month. */
export async function generateMarketingPlan(args: {
  companyId: string;
  userId?: string | null;
  inputs: PlanInputs;
  /** Optional status line for the background-job runner. */
  onProgress?: (message: string, percent: number) => void | Promise<void>;
}): Promise<MarketingPlanPayload> {
  const { companyId, userId, inputs, onProgress } = args;
  const report = async (message: string, percent: number) => {
    try {
      await onProgress?.(message, percent);
    } catch {
      // Progress is cosmetic — never fail a plan because reporting failed.
    }
  };

  await report('Reading your brief…', 8);
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found.');

  const slots = buildSchedule(inputs.month, inputs.postsPerWeek);
  if (slots.length === 0) {
    throw new PlannerError('That month has no publishable weekdays.');
  }

  const groundedOn: string[] = [];
  const voice = getBrandVoiceProfile(company);
  /**
   * The saved workspace profile, behind the plan form's own fields.
   *
   * The planner page already pre-fills `audience`, `businessGoals` and
   * `channels` from settings, so those are usually populated. What it never
   * carried is what the company DOES — the strategist was asked to build a
   * month of content for a name and an industry label. And if a user clears
   * the pre-filled audience, nothing downstream knew who to write for.
   */
  const brand = await getBrandContext(companyId);
  if (voice) groundedOn.push('Your saved brand voice profile');

  // Recent market context makes the plan timely rather than evergreen filler.
  const digest = await db.trendDigest.findFirst({
    where: { companyId },
    orderBy: { date: 'desc' },
    select: { payload: true },
  });
  const trendTitles = digest
    ? normalizeDigestPayload(digest.payload)
        .items.slice(0, 8)
        .map((i) => i.title)
    : [];
  if (trendTitles.length) {
    groundedOn.push(`${trendTitles.length} current trend topics`);
  }

  let knowledge = '';
  try {
    const chunks = await retrieve(
      companyId,
      [inputs.businessGoals, ...inputs.topics].join(' '),
      { limit: 6 },
    );
    knowledge = chunksToContext(chunks);
    if (knowledge) groundedOn.push('Your knowledge base');
  } catch (err) {
    logger.warn('planner: knowledge retrieval failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await report(
    `Drafting ${slots.length} dated slots across the month…`,
    35,
  );

  let body: { summary: string; weeks: PlanWeek[]; items: PlanItem[] };
  let model = 'none';

  if (!isClaudeConfigured()) {
    body = deterministicPlan(inputs, slots);
  } else {
    try {
      const ai = await completeStructured({
        schema: planPayloadSchema,
        system:
          `You are the content strategist for ${company.name}` +
          `${company.industry ? ` (${company.industry})` : ''}.
` +
          // Identity and reader from the saved profile; the brief's own fields
          // still win where the user filled them in below.
          `${brandContextToPrompt(brand, { includeVoice: false, includeWritingRules: false })}
` +
          'Build a MONTHLY CONTENT CALENDAR from the brief below. Hard rules: ' +
          '(1) Use ONLY the exact dates in the SCHEDULE list — one item per slot, ' +
          'same date and week number, no extra or missing slots. ' +
          '(2) Every item must serve one of the stated campaign objectives and say ' +
          'which in `objective`. ' +
          '(3) Give each week a single theme that builds a narrative arc across ' +
          'the month — not four unrelated topics. ' +
          '(4) Respect the brand guidelines exactly; if they forbid something, ' +
          'do not do it. ' +
          '(5) `brief` must be specific enough that a writer needs no further ' +
          'instructions. Invent no statistics or customer names. ' +
          'Respond with ONLY JSON matching the schema.',
        prompt: [
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
          '',
          `SCHEDULE (${slots.length} slots — use these exact dates):`,
          slots.map((s) => `${s.date} (week ${s.week})`).join('\n'),
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 8000,
        effort: 'high',
      });

      // Enforce the schedule: keep only items on real slots, and fill any the
      // model dropped, so the calendar always matches the requested cadence.
      const bySlot = new Map(ai.items.map((i) => [i.date, i]));
      const items: PlanItem[] = slots.map((slot, index) => {
        const match = bySlot.get(slot.date);
        if (match) return { ...match, week: slot.week, date: slot.date };
        const fallback = deterministicPlan(inputs, [slot]).items[0]!;
        return { ...fallback, week: slot.week };
      });

      body = { summary: ai.summary, weeks: ai.weeks, items };
      model = getModel();
    } catch (err) {
      logger.warn('planner: AI plan failed, using deterministic calendar', {
        error: err instanceof Error ? err.message : String(err),
      });
      body = deterministicPlan(inputs, slots);
    }
  }

  const payload: MarketingPlanPayload = {
    generatedAt: new Date().toISOString(),
    model,
    month: inputs.month,
    ...body,
    groundedOn,
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
