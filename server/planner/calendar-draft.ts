import { z, type ZodTypeAny } from 'zod';

import { isRetryable, parseJson } from '@/server/ai/claude';
import {
  planItemSchema,
  planWeekSchema,
  type PlanInputs,
  type PlanItem,
  type PlanWeek,
} from '@/lib/validations/planner';

/**
 * Drafting the monthly calendar, inside a time budget.
 *
 * This used to be ONE high-effort model call that wrote every slot of the
 * month in a single response. It was slow by construction: the whole month
 * waited on the longest answer the model could give, thinking shared the same
 * output budget (so a long answer could be cut off mid-JSON and redone from
 * scratch), and retries stacked — up to six attempts of two minutes each. The
 * job runner is killed at 60 seconds, so a slow month never finished at all: it
 * sat at "Drafting 17 dated slots…" until the stuck-job sweep noticed, ten
 * minutes later, and tried the same thing again.
 *
 * Now it is two short stages:
 *
 *   1. Strategy — one small call for the month's summary and a theme per week,
 *      so the weeks still build one narrative arc.
 *   2. Weeks — every week drafted at the same time, each a small call that
 *      knows the whole month's arc but writes only its own slots.
 *
 * Everything runs against one deadline. A call that cannot finish in the time
 * left is not started; one that overruns is abandoned. Whatever the model did
 * not deliver is filled from the brief (the same rule-based outline used when
 * no AI provider is configured), so the calendar always comes back complete,
 * on time, and says which weeks are outlines.
 */

export interface Slot {
  date: string;
  week: number;
}

/** One model request. Returns the raw text; parsing happens here. */
export type AskModel = (request: {
  system: string;
  prompt: string;
  maxTokens: number;
  effort: 'low' | 'medium';
  timeoutMs: number;
}) => Promise<string>;

export interface DraftResult {
  summary: string;
  weeks: PlanWeek[];
  items: PlanItem[];
  /** Did the model write the summary and weekly themes? */
  strategyFromModel: boolean;
  /** Weeks the model did not deliver in time — filled with an outline. */
  outlineWeeks: number[];
  /** Individual slots filled with an outline (includes every slot of outlineWeeks). */
  outlineSlots: number;
  /** Plain reasons, for the log — never shown raw to the user. */
  issues: string[];
}

/**
 * The whole drafting stage must leave room, inside the runner's 60-second
 * limit, for reading the brief before and saving the calendar after.
 */
export const DRAFT_BUDGET_MS = 45_000;
/** The strategy call gets at most this much of it; the weeks need the rest. */
export const STRATEGY_BUDGET_MS = 15_000;
/** Not worth starting a model call with less time than this left. */
export const MIN_ATTEMPT_MS = 5_000;

const strategySchema = z.object({
  summary: z.string().max(1500),
  weeks: z.array(planWeekSchema).max(6),
});

const weekSchema = z.object({
  items: z.array(planItemSchema).max(14),
});

/** Cycle content types sensibly per channel when we have no model. */
export function defaultTypeFor(
  channel: string,
  index: number,
): PlanItem['contentType'] {
  if (channel === 'Blog' || channel === 'Newsletter') return 'BLOG';
  if (channel === 'X') return 'TWEET_THREAD';
  return index % 4 === 3 ? 'CAROUSEL' : 'LINKEDIN_POST';
}

function fallbackTopics(inputs: PlanInputs): string[] {
  return inputs.topics.length
    ? inputs.topics
    : ['Customer problem', 'How we solve it', 'Proof', 'Point of view'];
}

/**
 * Which channel each slot goes to: a steady rotation through the chosen
 * channels across the month, so a multi-channel brief gets every channel —
 * not whichever one a model happens to favour week after week.
 */
export function assignChannels(inputs: PlanInputs, slots: Slot[]): string[] {
  return slots.map((_, i) => inputs.channels[i % inputs.channels.length]!);
}

/** Weekly themes and a summary straight from the brief. */
export function outlineStrategy(
  inputs: PlanInputs,
  slots: Slot[],
): { summary: string; weeks: PlanWeek[] } {
  const topics = fallbackTopics(inputs);
  const weekNumbers = [...new Set(slots.map((s) => s.week))];
  return {
    summary: `A ${slots.length}-piece calendar across ${inputs.channels.join(', ')} at ${inputs.postsPerWeek}/week. Generated without an AI provider, so themes cycle through your stated topics — connect a provider for a strategy-led plan.`,
    weeks: weekNumbers.map((w, i) => ({
      week: w,
      theme: topics[i % topics.length]!,
      goal: inputs.campaignObjectives.slice(0, 280),
    })),
  };
}

/** One slot written from the brief alone. */
export function outlineItem(
  inputs: PlanInputs,
  slot: Slot,
  index: number,
  channel: string,
  theme: string,
): PlanItem {
  return {
    date: slot.date,
    week: slot.week,
    channel,
    contentType: defaultTypeFor(channel, index),
    theme,
    title: `${theme} — piece ${index + 1}`,
    hook: `Open with a concrete example of "${theme}" from your own work.`,
    brief: `Write about ${theme} for ${inputs.audience || 'your target audience'}. Tie it back to the objective: ${inputs.campaignObjectives}.`,
    cta: 'Invite a reply with the reader’s own experience.',
    hashtags: [],
    objective: inputs.campaignObjectives.slice(0, 180),
  };
}

/** A full calendar without any model — real dates, real structure. */
export function outlineCalendar(
  inputs: PlanInputs,
  slots: Slot[],
): { summary: string; weeks: PlanWeek[]; items: PlanItem[] } {
  const { summary, weeks } = outlineStrategy(inputs, slots);
  const channels = assignChannels(inputs, slots);
  const themeFor = new Map(weeks.map((w) => [w.week, w.theme]));
  return {
    summary,
    weeks,
    items: slots.map((slot, i) =>
      outlineItem(inputs, slot, i, channels[i]!, themeFor.get(slot.week) ?? ''),
    ),
  };
}

class DeadlineError extends Error {
  constructor() {
    super('Ran out of time.');
    this.name = 'DeadlineError';
  }
}

/** Resolve with the promise, or reject once `ms` has passed — whichever first. */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Ask for JSON matching `schema`, before `until`. Two tries at most, and the
 * second only if there is still time for it: a schema slip gets the errors
 * echoed back; a rate limit or outage just tries again. A rejected key or a
 * malformed request stops immediately — trying again cannot fix those.
 */
async function askStructured<S extends ZodTypeAny>(
  ask: AskModel,
  schema: S,
  request: {
    system: string;
    prompt: string;
    maxTokens: number;
    effort: 'low' | 'medium';
  },
  until: number,
  now: () => number,
): Promise<{ ok: true; value: z.infer<S> } | { ok: false; reason: string }> {
  let correction = '';
  let reason = 'Not enough time left to ask.';
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = until - now();
    if (left < MIN_ATTEMPT_MS) break;
    try {
      const text = await withinMs(
        ask({
          ...request,
          prompt: request.prompt + correction,
          timeoutMs: left,
        }),
        left,
      );
      const parsed = schema.safeParse(parseJson<unknown>(text));
      if (parsed.success) return { ok: true, value: parsed.data };
      reason = `Did not match the schema: ${parsed.error.message.slice(0, 200)}`;
      correction =
        '\n\nYour previous response did not match the required JSON schema. ' +
        `Validation errors: ${parsed.error.message.slice(0, 400)}. ` +
        'Respond again with ONLY valid JSON in the exact shape described.';
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      if (err instanceof DeadlineError || !isRetryable(err)) break;
    }
  }
  return { ok: false, reason: reason.slice(0, 300) };
}

const ITEM_SHAPE =
  '{"date":"YYYY-MM-DD","week":n,"channel":"…","contentType":"LINKEDIN_POST|CAROUSEL|TWEET_THREAD|BLOG",' +
  '"theme":"…","title":"…","hook":"…","brief":"…","cta":"…","hashtags":["…"],"objective":"…"}';

function strategyPrompt(brief: string, slots: Slot[]): string {
  const perWeek = new Map<number, number>();
  for (const s of slots) perWeek.set(s.week, (perWeek.get(s.week) ?? 0) + 1);
  return [
    brief,
    '',
    'STEP 1 OF 2 — THE MONTH’S STRATEGY. Do not write the individual posts yet.',
    'Give the month a short summary of the strategy, and ONE theme per week that',
    'builds a narrative arc across the month (not unrelated topics). Each week’s',
    '`goal` says what that week moves, tied to the campaign objectives.',
    '',
    `WEEKS: ${[...perWeek.entries()].map(([w, n]) => `week ${w} (${n} posts)`).join(', ')}`,
    '',
    'Respond with ONLY JSON: {"summary":"…","weeks":[{"week":n,"theme":"…","goal":"…"}]}',
  ].join('\n');
}

function weekPrompt(args: {
  brief: string;
  summary: string;
  weeks: PlanWeek[];
  week: PlanWeek;
  slots: { slot: Slot; channel: string }[];
}): string {
  const { brief, summary, weeks, week, slots } = args;
  return [
    brief,
    '',
    'STEP 2 OF 2 — WRITE ONE WEEK OF THE CALENDAR.',
    `THE MONTH: ${summary}`,
    `THE ARC: ${weeks.map((w) => `week ${w.week}: ${w.theme}`).join(' → ')}`,
    `THIS WEEK: week ${week.week} — ${week.theme}. Goal: ${week.goal}`,
    '',
    'Write exactly one item per slot below — same date, same channel, no extra',
    'or missing slots. Pick the content type that suits the channel. Every item',
    'serves one of the stated campaign objectives and names it in `objective`.',
    '`brief` must be specific enough that a writer needs no further',
    'instructions. Invent no statistics or customer names.',
    '',
    `SLOTS (${slots.length}):`,
    ...slots.map(
      ({ slot, channel }) => `${slot.date} (week ${slot.week}) — ${channel}`,
    ),
    '',
    `Respond with ONLY JSON: {"items":[${ITEM_SHAPE}]}`,
  ].join('\n');
}

/**
 * Draft the calendar for `slots` before `deadline` (epoch ms).
 *
 * `brief` is the shared context every call sees — the user's answers, the
 * brand profile, current trends, company knowledge — built once by the caller.
 */
export async function draftCalendar(args: {
  inputs: PlanInputs;
  slots: Slot[];
  system: string;
  brief: string;
  ask: AskModel;
  deadline: number;
  now?: () => number;
  onProgress?: (message: string, percent: number) => Promise<void> | void;
}): Promise<DraftResult> {
  const { inputs, slots, system, brief, ask, deadline } = args;
  const now = args.now ?? Date.now;
  const report = async (message: string, percent: number) => {
    try {
      await args.onProgress?.(message, percent);
    } catch {
      // Progress is cosmetic.
    }
  };
  const issues: string[] = [];
  const channels = assignChannels(inputs, slots);
  const outline = outlineStrategy(inputs, slots);
  const weekNumbers = [...new Set(slots.map((s) => s.week))];

  // Stage 1 — the month's strategy.
  await report('Planning the month’s weekly themes…', 38);
  const strategy = await askStructured(
    ask,
    strategySchema,
    {
      system,
      prompt: strategyPrompt(brief, slots),
      maxTokens: 1500,
      effort: 'low',
    },
    Math.min(deadline, now() + STRATEGY_BUDGET_MS),
    now,
  );
  if (!strategy.ok) issues.push(`strategy: ${strategy.reason}`);
  const modelWeeks = new Map(
    (strategy.ok ? strategy.value.weeks : []).map((w) => [w.week, w]),
  );
  const outlineWeekMeta = new Map(outline.weeks.map((w) => [w.week, w]));
  // Every scheduled week gets a theme, whatever the model returned.
  const weeks: PlanWeek[] = weekNumbers.map(
    (w) => modelWeeks.get(w) ?? outlineWeekMeta.get(w)!,
  );
  // Without the model's strategy, say plainly what the calendar is built from —
  // not "no AI provider", which would be untrue here.
  const summary = strategy.ok
    ? strategy.value.summary
    : `A ${slots.length}-piece calendar across ${inputs.channels.join(', ')} at ${inputs.postsPerWeek}/week, themed week by week on your stated topics.`;

  // Stage 2 — every week at once.
  const total = slots.length;
  let drafted = 0;
  await report(
    `Drafting ${total} posts — all ${weeks.length} weeks at once…`,
    45,
  );

  const indexed = slots.map((slot, i) => ({
    slot,
    channel: channels[i]!,
    index: i,
  }));
  const results = await Promise.all(
    weeks.map(async (week) => {
      const mine = indexed.filter((s) => s.slot.week === week.week);
      const answer = await askStructured(
        ask,
        weekSchema,
        {
          system,
          prompt: weekPrompt({ brief, summary, weeks, week, slots: mine }),
          // Room for the items plus light thinking; small enough to come back fast.
          maxTokens: Math.min(6000, 800 + 500 * mine.length),
          effort: 'medium',
        },
        deadline,
        now,
      );
      drafted += mine.length;
      await report(
        `Drafted week ${week.week} — ${drafted} of ${total} posts ready…`,
        45 + Math.round((45 * drafted) / total),
      );
      if (!answer.ok) issues.push(`week ${week.week}: ${answer.reason}`);
      return { week, mine, items: answer.ok ? answer.value.items : null };
    }),
  );

  // Hold the model to the schedule: one item per real slot, nothing invented.
  const outlineWeeks: number[] = [];
  let outlineSlots = 0;
  const items: PlanItem[] = [];
  for (const { week, mine, items: written } of results) {
    if (!written) outlineWeeks.push(week.week);
    const byDate = new Map((written ?? []).map((it) => [it.date, it]));
    for (const { slot, channel, index } of mine) {
      const match = byDate.get(slot.date);
      if (match) {
        // Date, week and channel are the schedule's, not the model's to change.
        items.push({ ...match, date: slot.date, week: slot.week, channel });
      } else {
        outlineSlots += 1;
        items.push(outlineItem(inputs, slot, index, channel, week.theme));
      }
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));

  return {
    summary,
    weeks,
    items,
    strategyFromModel: strategy.ok,
    outlineWeeks: outlineWeeks.sort((a, b) => a - b),
    outlineSlots,
    issues,
  };
}
