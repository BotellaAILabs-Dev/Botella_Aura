import type { SocialPlatformKey } from '@/lib/platforms';
import { getContentPerformance, type ContentPerf } from '@/server/memory/performance.service';

/**
 * When to publish.
 *
 * Aura could write a week of posts and then leave every one of them with no
 * date on it — which put the whole scheduling decision back on the user, for
 * work they had asked Aura to take off their hands.
 *
 * Two sources, and the difference between them is stated rather than hidden:
 *
 *   LEARNED  The workspace's own published posts, bucketed by weekday and hour
 *            and scored on real engagement. Only used once there is enough of
 *            a sample to mean anything.
 *   DEFAULT  A common posting window for the platform. This is a starting
 *            point, not a finding, and it says so — presenting a convention as
 *            if it were learned from the account would be a lie the user has
 *            no way to catch.
 *
 * The distinction is carried all the way to the UI. "Tuesday 09:00, because
 * your Tuesday posts average 2.4x your other days" earns trust; the same slot
 * with no reason attached is indistinguishable from a guess.
 */
export type SlotConfidence = 'learned' | 'default';

export interface RecommendedSlot {
  /** When to publish, in UTC. */
  at: Date;
  /** Why this slot, in one sentence the user can check. */
  reason: string;
  confidence: SlotConfidence;
}

/**
 * How many published-with-metrics posts a weekday needs before its average
 * means anything.
 *
 * Three is low, but this is a scheduling nudge the user can override, not a
 * claim about their business — and the alternative is never learning anything
 * for a workspace that posts twice a week.
 */
const MIN_POSTS_PER_DAY = 3;
/** Total sample before any learned recommendation is offered at all. */
const MIN_TOTAL_POSTS = 8;
/** How much better a day must be than average before it is worth naming. */
const MEANINGFUL_LIFT = 1.2;

/**
 * Common posting windows, used only until a workspace has its own data.
 *
 * Weekday is 1-7 (Monday-Sunday, ISO). Hours are UTC, which is a real
 * limitation: without a workspace timezone these are only right for European
 * and UK-ish audiences. Stated here rather than papered over.
 */
const DEFAULT_WINDOWS: Record<string, { weekday: number; hour: number; note: string }> = {
  LINKEDIN: {
    weekday: 2,
    hour: 9,
    note: 'Tuesday mornings are when most people check LinkedIn before their week fills up',
  },
  INSTAGRAM: {
    weekday: 4,
    hour: 18,
    note: 'Thursday evenings are when people browse rather than work',
  },
  X: { weekday: 3, hour: 12, note: 'Midweek lunchtime is when X is busiest' },
  FACEBOOK: { weekday: 4, hour: 19, note: 'Weekday evenings are when Facebook engagement peaks' },
};

const FALLBACK_WINDOW = {
  weekday: 2,
  hour: 10,
  note: 'Tuesday mid-morning is a safe default for business audiences',
};

const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

function weekdayName(isoWeekday: number): string {
  return WEEKDAY_NAMES[isoWeekday - 1] ?? 'Tuesday';
}

/** ISO weekday (1 = Monday) from a Date, in UTC. */
function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

interface DayStat {
  weekday: number;
  hour: number;
  average: number;
  count: number;
}

/**
 * What this workspace's own results say about timing.
 *
 * Returns null when the sample is too thin to support a claim — which is the
 * common case for a new workspace, and the honest answer.
 */
export function learnTiming(perf: ContentPerf[]): DayStat | null {
  const published = perf.filter((p) => p.publishedAt);
  if (published.length < MIN_TOTAL_POSTS) return null;

  const byDay = new Map<number, number[]>();
  const hoursByDay = new Map<number, number[]>();
  for (const post of published) {
    const at = new Date(post.publishedAt!);
    if (Number.isNaN(at.getTime())) continue;
    const day = isoWeekday(at);
    if (!byDay.has(day)) {
      byDay.set(day, []);
      hoursByDay.set(day, []);
    }
    byDay.get(day)!.push(post.engagement);
    hoursByDay.get(day)!.push(at.getUTCHours());
  }

  const overall =
    published.reduce((sum, p) => sum + p.engagement, 0) / Math.max(1, published.length);
  if (overall <= 0) return null;

  const candidates = [...byDay.entries()]
    .filter(([, scores]) => scores.length >= MIN_POSTS_PER_DAY)
    .map(([weekday, scores]) => {
      const average = scores.reduce((a, b) => a + b, 0) / scores.length;
      const hours = hoursByDay.get(weekday) ?? [];
      // Median hour rather than mean: one post at 3am should not drag the
      // recommendation into the middle of the night.
      const sorted = [...hours].sort((a, b) => a - b);
      const hour = sorted[Math.floor(sorted.length / 2)] ?? 10;
      return { weekday, hour, average, count: scores.length };
    })
    .sort((a, b) => b.average - a.average);

  const best = candidates[0];
  if (!best) return null;
  // A day that is merely first is not a finding. It has to actually be better.
  if (best.average < overall * MEANINGFUL_LIFT) return null;
  return best;
}

/** The next occurrence of a weekday/hour at or after `after`. */
function nextOccurrence(after: Date, weekday: number, hour: number): Date {
  const at = new Date(after);
  at.setUTCHours(hour, 0, 0, 0);
  const daysAhead = (weekday - isoWeekday(at) + 7) % 7;
  at.setUTCDate(at.getUTCDate() + daysAhead);
  // Same weekday but the hour has already passed today — go to next week.
  if (at.getTime() <= after.getTime()) at.setUTCDate(at.getUTCDate() + 7);
  return at;
}

/**
 * Recommend when to publish one post.
 *
 * `taken` lets a caller schedule a whole week without stacking every post on
 * the same slot — each subsequent call pushes to the next free day rather than
 * publishing three posts within a minute of each other, which is the fastest
 * way to look like a bot.
 */
export async function recommendSlot(args: {
  companyId: string;
  platform?: SocialPlatformKey | null;
  /** Do not schedule before this. Defaults to now. */
  after?: Date;
  /** Slots already assigned in this batch, so posts spread out. */
  taken?: Date[];
}): Promise<RecommendedSlot> {
  const after = args.after ?? new Date();
  const perf = await getContentPerformance(args.companyId);
  const learned = learnTiming(perf);

  let weekday: number;
  let hour: number;
  let reason: string;
  let confidence: SlotConfidence;

  if (learned) {
    weekday = learned.weekday;
    hour = learned.hour;
    reason = `Your ${weekdayName(learned.weekday)} posts have done best (${learned.count} posts, averaging ${learned.average.toFixed(0)} engagement).`;
    confidence = 'learned';
  } else {
    const window = (args.platform && DEFAULT_WINDOWS[args.platform]) || FALLBACK_WINDOW;
    weekday = window.weekday;
    hour = window.hour;
    // Named as a convention, not a finding. The user should know Aura has not
    // learned this from them yet.
    reason = `${window.note}. Aura has not seen enough of your own results yet to know better.`;
    confidence = 'default';
  }

  let at = nextOccurrence(after, weekday, hour);

  // Spread a batch out. Each collision moves on by a day rather than an hour,
  // because two posts on the same day compete with each other.
  const taken = (args.taken ?? []).map((d) => d.getTime());
  let guard = 0;
  while (taken.some((t) => Math.abs(t - at.getTime()) < 20 * 3_600_000) && guard < 14) {
    at = new Date(at.getTime() + 86_400_000);
    guard += 1;
  }

  return { at, reason, confidence };
}

/**
 * Recommend a slot for each of several posts, spread across the coming weeks.
 *
 * Sequential rather than parallel on purpose: each call needs to see the slots
 * the previous ones took.
 */
export async function recommendSlots(args: {
  companyId: string;
  count: number;
  platform?: SocialPlatformKey | null;
  after?: Date;
}): Promise<RecommendedSlot[]> {
  const slots: RecommendedSlot[] = [];
  for (let i = 0; i < args.count; i += 1) {
    slots.push(
      await recommendSlot({
        companyId: args.companyId,
        ...(args.platform ? { platform: args.platform } : {}),
        ...(args.after ? { after: args.after } : {}),
        taken: slots.map((s) => s.at),
      }),
    );
  }
  return slots;
}
