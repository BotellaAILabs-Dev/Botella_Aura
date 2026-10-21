/**
 * Timezones for scheduling (Scheduling & Timezone Handling).
 *
 *   Stored    every scheduled time is a UTC instant (ContentDraft.scheduledFor,
 *             Execution.scheduledFor); the zone and wall time a person chose
 *             are kept alongside (Execution.scheduledTimeZone / scheduledLocal)
 *   Entered   as a wall time ("2026-11-02T09:00") in the workspace's timezone
 *             (Company.timezone), converted here — never in the browser's zone,
 *             so a manager abroad schedules in the business's local time
 *   Shown     in the workspace's timezone, with its offset ("09:00 GMT")
 *
 * Daylight saving is handled per date, from the IANA database (Intl):
 *   - a wall time that does not exist (the hour skipped when clocks go
 *     forward) moves forward by the gap, and says so
 *   - a wall time that happens twice (clocks go back) takes the first, and
 *     says so
 *
 * Pure and client-safe.
 */

export const DEFAULT_TIMEZONE = 'UTC';

/** A real IANA zone this runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function safeTimeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock parts of an instant in a zone. */
export function zonedParts(at: Date, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! };
}

/** Minutes the zone is ahead of UTC at that instant (London summer = 60). */
export function offsetMinutes(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** "GMT+5:30", "GMT-4", "GMT". */
export function offsetLabel(at: Date, tz: string): string {
  const m = offsetMinutes(at, tz);
  if (m === 0) return 'GMT';
  const sign = m > 0 ? '+' : '-';
  const h = Math.floor(Math.abs(m) / 60);
  const mm = Math.abs(m) % 60;
  return `GMT${sign}${h}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export interface ZonedConversion {
  /** The UTC instant. */
  at: Date;
  /** The wall time actually used, "YYYY-MM-DDTHH:mm" (differs when adjusted). */
  local: string;
  timeZone: string;
  /** Daylight saving adjustment, if any. */
  adjustment: 'none' | 'skipped_forward' | 'ambiguous_first';
  /** One sentence for the person when adjusted. */
  note: string | null;
}

export class TimezoneError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'TimezoneError';
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** Format an instant as the zone's wall time "YYYY-MM-DDTHH:mm" (for <input type="datetime-local">). */
export function toLocalInput(at: Date | string | null | undefined, tz: string): string {
  if (!at) return '';
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return '';
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * A wall time in a zone → the UTC instant. Handles daylight saving: a time in
 * the spring-forward gap moves forward by the gap; a time in the fall-back
 * overlap takes the earlier of the two.
 */
export function zonedToUtc(local: string, timeZone: string): ZonedConversion {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) throw new TimezoneError('Enter a date and time like 2026-11-02T09:00.');
  if (!isValidTimeZone(timeZone)) throw new TimezoneError(`“${timeZone}” isn’t a timezone Aura recognises.`);
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) {
    throw new TimezoneError('That date doesn’t exist.');
  }

  // Candidate instants: the wall time minus each offset in force around it.
  const offsets = new Set([offsetMinutes(new Date(wall - 36 * 3600_000), timeZone), offsetMinutes(new Date(wall + 36 * 3600_000), timeZone), offsetMinutes(new Date(wall), timeZone)]);
  const matches = [...offsets]
    .map((o) => wall - o * 60_000)
    .filter((t) => toLocalInput(new Date(t), timeZone) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`)
    .sort((a, b) => a - b);
  const wanted = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;

  if (matches.length >= 1) {
    const at = new Date(matches[0]!);
    const ambiguous = matches.length > 1;
    return {
      at,
      local: wanted,
      timeZone,
      adjustment: ambiguous ? 'ambiguous_first' : 'none',
      note: ambiguous
        ? `${wanted.slice(11)} happens twice that day (clocks go back) — Aura uses the first, ${offsetLabel(at, timeZone)}.`
        : null,
    };
  }
  // In the gap: the clock skipped this time. Use the offset before the change
  // (moves the time forward by the gap, as a person would read the clock).
  const before = offsetMinutes(new Date(wall - 36 * 3600_000), timeZone);
  const at = new Date(wall - before * 60_000);
  const used = toLocalInput(at, timeZone);
  return {
    at,
    local: used,
    timeZone,
    adjustment: 'skipped_forward',
    note: `${wanted.slice(11)} doesn’t exist that day (clocks go forward) — scheduled for ${used.slice(11)} instead.`,
  };
}

/** "Mon 2 Nov 2026, 09:00 GMT" in the zone. */
export function formatInZone(at: Date | string, tz: string, opts: { withZone?: boolean } = {}): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return opts.withZone === false ? text : `${text} ${offsetLabel(d, tz)}`;
}

/** Earliest a schedule may be set ahead of now (time for the job to pick it up). */
export const MIN_LEAD_MS = 60_000;
/** Furthest ahead a post may be scheduled. */
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;

export type ScheduleProblem = 'past' | 'too_soon' | 'too_far' | 'invalid';

/** Is this a time a post can be scheduled for? */
export function validateScheduleTime(at: Date, now: Date = new Date()): { ok: true } | { ok: false; problem: ScheduleProblem; message: string } {
  if (Number.isNaN(at.getTime())) return { ok: false, problem: 'invalid', message: 'That isn’t a valid date and time.' };
  const ahead = at.getTime() - now.getTime();
  if (ahead <= 0) return { ok: false, problem: 'past', message: 'That time has already passed — pick a time in the future.' };
  if (ahead < MIN_LEAD_MS) return { ok: false, problem: 'too_soon', message: 'Pick a time at least a minute from now, or publish now instead.' };
  if (ahead > MAX_AHEAD_MS) return { ok: false, problem: 'too_far', message: 'Posts can be scheduled up to a year ahead.' };
  return { ok: true };
}

/** A short list of zones for the settings picker (any valid IANA zone is accepted). */
export function commonTimeZones(): string[] {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
  return all && all.length ? ['UTC', ...all.filter((z) => z !== 'UTC')] : ['UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney'];
}
