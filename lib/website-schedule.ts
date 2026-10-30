import { zonedParts, zonedToUtc } from '@/lib/timezone';

/**
 * Recurring auto-publish slots: weekdays + a wall-clock time in the
 * workspace's timezone. Computed in that zone, so "Tuesday 09:00" stays
 * 09:00 across daylight-saving changes. Client-safe.
 */

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTimeOfDay(v: string): boolean {
  return TIME_RE.test(v);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO weekday (1 = Monday) of a calendar date. */
function isoWeekday(y: number, m: number, d: number): number {
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The first slot strictly after `after`, or null when no weekday is chosen.
 * Looks up to eight days ahead (a full week plus today).
 */
export function nextSlot(after: Date, weekdays: number[], timeOfDay: string, timeZone: string): Date | null {
  const days = new Set(weekdays.filter((d) => d >= 1 && d <= 7));
  if (!days.size || !isTimeOfDay(timeOfDay)) return null;
  const today = zonedParts(after, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!days.has(isoWeekday(y, m, d))) continue;
    const at = zonedToUtc(`${y}-${pad(m)}-${pad(d)}T${timeOfDay}`, timeZone).at;
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

/** "Mon, Wed, Fri at 09:00" */
export function describeSlots(weekdays: number[], timeOfDay: string): string {
  const sorted = [...new Set(weekdays)].filter((d) => d >= 1 && d <= 7).sort();
  if (!sorted.length) return 'No days chosen';
  const names = sorted.length === 7 ? 'Every day' : sorted.length === 5 && sorted.every((d) => d <= 5) ? 'Weekdays' : sorted.map((d) => WEEKDAY_SHORT[d - 1]).join(', ');
  return `${names} at ${timeOfDay}`;
}
