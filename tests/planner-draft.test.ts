import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSchedule } from '@/server/planner/plan.service';
import {
  DRAFT_BUDGET_MS,
  draftCalendar,
  outlineCalendar,
  type AskModel,
} from '@/server/planner/calendar-draft';
import { stuckAfterMs } from '@/server/jobs/job.service';
import type { PlanInputs } from '@/lib/validations/planner';

/**
 * The monthly calendar is drafted as one short strategy call plus every week
 * at once, all inside a time budget. These tests drive it with a simulated
 * model — controlled delays, failures and hangs — on fake timers, so "it
 * finishes within the budget" is checked exactly rather than hoped for.
 */

const INPUTS: PlanInputs = {
  month: '2026-11',
  businessGoals: 'Grow subscriptions among home brewers this quarter.',
  campaignObjectives: 'Book 15 tasting calls; 200 newsletter signups.',
  topics: ['sourcing', 'brewing at home', 'freshness'],
  brandGuidelines: 'Plain English, no emoji.',
  audience: 'Home brewers who buy beans online',
  channels: ['LinkedIn', 'Instagram', 'Newsletter'],
  postsPerWeek: 4,
  campaignId: '',
};

const SLOT_LINE = /^(\d{4}-\d{2}-\d{2}) \(week (\d)\) — (\S+)$/gm;

/** A model that answers both stages correctly. */
function weekAnswer(prompt: string, extra: Record<string, unknown> = {}) {
  const items = [...prompt.matchAll(SLOT_LINE)].map(
    ([, date, week, channel]) => ({
      date,
      week: Number(week),
      channel,
      contentType: 'LINKEDIN_POST',
      theme: 'Model theme',
      title: `Model post for ${date}`,
      hook: 'A real hook.',
      brief: 'A specific brief.',
      cta: 'Reply with yours.',
      hashtags: ['coffee'],
      objective: 'Book 15 tasting calls',
      ...extra,
    }),
  );
  return JSON.stringify({ items });
}

function strategyAnswer(prompt: string) {
  const weeks = [...prompt.matchAll(/week (\d) \(\d+ posts\)/g)].map(
    ([, w]) => ({
      week: Number(w),
      theme: `Arc part ${w}`,
      goal: 'Move the objective.',
    }),
  );
  return JSON.stringify({ summary: 'A month that builds trust.', weeks });
}

const isStrategy = (prompt: string) => prompt.includes('STEP 1 OF 2');
const weekOf = (prompt: string) =>
  Number(/THIS WEEK: week (\d)/.exec(prompt)?.[1]);

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function httpError(status: number) {
  return Object.assign(new Error(`API error (${status})`), { status });
}

async function run(
  ask: AskModel,
  opts: { budgetMs?: number; inputs?: PlanInputs } = {},
) {
  const inputs = opts.inputs ?? INPUTS;
  const slots = buildSchedule(inputs.month, inputs.postsPerWeek);
  const progress: { message: string; percent: number }[] = [];
  const t0 = Date.now();
  const pending = draftCalendar({
    inputs,
    slots,
    system: 'system',
    brief: 'BRIEF',
    ask,
    deadline: t0 + (opts.budgetMs ?? DRAFT_BUDGET_MS),
    onProgress: (message, percent) => {
      progress.push({ message, percent });
    },
  });
  // When the draft itself resolved — not when the last abandoned call's timer
  // fires, which runAllTimersAsync also plays out.
  let doneAt = 0;
  void pending.then(() => {
    doneAt = Date.now();
  });
  await vi.runAllTimersAsync();
  const result = await pending;
  return { result, slots, progress, elapsed: doneAt - t0 };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('draftCalendar — the happy path', () => {
  it('fills every slot from the model, exactly once, on the real dates', async () => {
    const { result, slots } = await run(async (r) =>
      isStrategy(r.prompt) ? strategyAnswer(r.prompt) : weekAnswer(r.prompt),
    );
    expect(result.items.map((i) => i.date)).toEqual(slots.map((s) => s.date));
    expect(result.items.every((i) => i.title.startsWith('Model post'))).toBe(
      true,
    );
    expect(result.outlineWeeks).toEqual([]);
    expect(result.outlineSlots).toBe(0);
    expect(result.strategyFromModel).toBe(true);
    expect(result.weeks.map((w) => w.theme)).toEqual(
      [...new Set(slots.map((s) => s.week))].map((w) => `Arc part ${w}`),
    );
  });

  it('drafts the weeks at the same time, not one after another', async () => {
    let inFlight = 0;
    let peak = 0;
    const { result, elapsed } = await run(async (r) => {
      if (isStrategy(r.prompt)) return after(3_000, strategyAnswer(r.prompt));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const text = await after(10_000, weekAnswer(r.prompt));
      inFlight -= 1;
      return text;
    });
    expect(peak).toBe(result.weeks.length);
    // Strategy + ONE week's time — sequential would be 3s + 5 × 10s.
    expect(elapsed).toBeLessThan(14_000);
  });

  it('gives every chosen channel its share across the month', async () => {
    const inputs: PlanInputs = {
      ...INPUTS,
      channels: ['LinkedIn', 'Blog', 'Newsletter', 'X', 'Instagram', 'YouTube'],
      postsPerWeek: 5,
    };
    const { result } = await run(
      async (r) =>
        isStrategy(r.prompt) ? strategyAnswer(r.prompt) : weekAnswer(r.prompt),
      { inputs },
    );
    const used = new Set(result.items.map((i) => i.channel));
    expect([...used].sort()).toEqual([...inputs.channels].sort());
  });

  it('reports progress that only moves forward and stops short of done', async () => {
    const { progress } = await run(async (r) =>
      isStrategy(r.prompt)
        ? strategyAnswer(r.prompt)
        : after(1_000, weekAnswer(r.prompt)),
    );
    const percents = progress.map((p) => p.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.at(-1)).toBe(90);
    expect(
      progress.some((p) =>
        /Drafted week \d — \d+ of \d+ posts ready/.test(p.message),
      ),
    ).toBe(true);
  });
});

describe('draftCalendar — when the model misbehaves, the calendar stays whole', () => {
  it('a week that keeps failing becomes an outline; the other weeks are kept', async () => {
    const { result, slots } = await run(async (r) => {
      if (isStrategy(r.prompt)) return strategyAnswer(r.prompt);
      if (weekOf(r.prompt) === 2) throw httpError(503);
      return weekAnswer(r.prompt);
    });
    expect(result.items).toHaveLength(slots.length);
    expect(result.outlineWeeks).toEqual([2]);
    const week2 = result.items.filter((i) => i.week === 2);
    expect(week2.every((i) => i.title.includes('piece'))).toBe(true);
    // The outline still uses the model's theme for that week.
    expect(week2.every((i) => i.theme === 'Arc part 2')).toBe(true);
    expect(
      result.items
        .filter((i) => i.week !== 2)
        .every((i) => i.title.startsWith('Model')),
    ).toBe(true);
  });

  it('a week that never answers is abandoned at the deadline', async () => {
    const { result, elapsed } = await run(async (r) => {
      if (isStrategy(r.prompt)) return strategyAnswer(r.prompt);
      if (weekOf(r.prompt) === 3) return new Promise<string>(() => {}); // hangs
      return weekAnswer(r.prompt);
    });
    expect(elapsed).toBeLessThanOrEqual(DRAFT_BUDGET_MS);
    expect(result.outlineWeeks).toEqual([3]);
  });

  it('a model that is down entirely still yields a complete, dated calendar in budget', async () => {
    const { result, slots, elapsed } = await run(async () => {
      await after(20_000, null);
      throw httpError(503);
    });
    expect(elapsed).toBeLessThanOrEqual(DRAFT_BUDGET_MS);
    expect(result.items.map((i) => i.date)).toEqual(slots.map((s) => s.date));
    expect(result.strategyFromModel).toBe(false);
    expect(result.outlineSlots).toBe(slots.length);
    // Honest: the model exists, it just did not answer — not "no AI provider".
    expect(result.summary).not.toMatch(/without an AI provider/);
  });

  it('a slow strategy is cut off so the weeks still get their time', async () => {
    const { result, elapsed } = await run(async (r) => {
      if (isStrategy(r.prompt)) return new Promise<string>(() => {});
      return after(5_000, weekAnswer(r.prompt));
    });
    expect(result.strategyFromModel).toBe(false);
    expect(result.outlineWeeks).toEqual([]);
    expect(elapsed).toBeLessThan(25_000);
  });

  it('a schema slip is corrected once, with the errors echoed back', async () => {
    const prompts: string[] = [];
    const { result } = await run(async (r) => {
      if (isStrategy(r.prompt)) return strategyAnswer(r.prompt);
      prompts.push(r.prompt);
      if (weekOf(r.prompt) === 1 && !r.prompt.includes('did not match')) {
        return JSON.stringify({ items: [{ date: 'nope' }] });
      }
      return weekAnswer(r.prompt);
    });
    expect(result.outlineWeeks).toEqual([]);
    expect(
      prompts.some((p) => p.includes('did not match the required JSON schema')),
    ).toBe(true);
  });

  it('does not retry what cannot succeed (a rejected key)', async () => {
    let weekCalls = 0;
    const { result } = await run(async (r) => {
      if (isStrategy(r.prompt)) return strategyAnswer(r.prompt);
      weekCalls += 1;
      throw httpError(401);
    });
    expect(weekCalls).toBe(result.weeks.length); // one each, no second try
  });

  it('keeps the model to the schedule: no invented dates, channel as scheduled', async () => {
    const { result, slots } = await run(async (r) => {
      if (isStrategy(r.prompt)) return strategyAnswer(r.prompt);
      const real = JSON.parse(weekAnswer(r.prompt, { channel: 'TikTok' })) as {
        items: Record<string, unknown>[];
      };
      real.items.push({ ...real.items[0]!, date: '2026-11-29' }); // a Sunday
      return JSON.stringify(real);
    });
    expect(result.items.map((i) => i.date)).toEqual(slots.map((s) => s.date));
    expect(result.items.some((i) => i.channel === 'TikTok')).toBe(false);
  });
});

describe('outlineCalendar (no AI provider)', () => {
  it('covers every slot with the brief’s topics', () => {
    const slots = buildSchedule('2026-11', 4);
    const plan = outlineCalendar(INPUTS, slots);
    expect(plan.items).toHaveLength(slots.length);
    expect(plan.weeks.map((w) => w.theme)).toContain('sourcing');
  });
});

describe('stuck-job fuse', () => {
  it('treats a plan run as dead after two minutes, other kinds after ten', () => {
    expect(stuckAfterMs('MARKETING_PLAN')).toBe(2 * 60 * 1000);
    expect(stuckAfterMs('TREND_DIGEST')).toBe(10 * 60 * 1000);
  });
});
