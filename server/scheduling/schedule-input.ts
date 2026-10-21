import { z } from 'zod';

import { db } from '@/lib/db';
import { safeTimeZone, validateScheduleTime, zonedToUtc, TimezoneError, toLocalInput, isValidTimeZone } from '@/lib/timezone';

/**
 * Turning what a person picked into the instant a post runs.
 *
 *   { localTime: "2026-11-02T09:00" }               wall time in the workspace's timezone
 *   { localTime, timeZone: "America/New_York" }     wall time in a named zone
 *   { scheduledFor: "2026-11-02T09:00:00.000Z" }    an absolute instant (API clients)
 *
 * Always validated: in the future, at least a minute ahead, at most a year
 * ahead; a daylight-saving gap or overlap is resolved and explained.
 */
export const scheduleInputSchema = z
  .object({
    localTime: z.string().trim().max(32).optional(),
    timeZone: z.string().trim().max(64).optional(),
    scheduledFor: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => Boolean(v.localTime) !== Boolean(v.scheduledFor), { message: 'Give a local time or an exact time, not both.' });

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export interface ResolvedSchedule {
  at: Date;
  timeZone: string;
  /** The wall time in `timeZone` ("YYYY-MM-DDTHH:mm"). */
  local: string;
  /** A daylight-saving adjustment, explained. */
  note: string | null;
}

export class ScheduleError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly problem: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export async function workspaceTimeZone(companyId: string): Promise<string> {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
  return safeTimeZone(c?.timezone);
}

export async function resolveSchedule(companyId: string, input: ScheduleInput, now: Date = new Date()): Promise<ResolvedSchedule> {
  const zone = input.timeZone ? input.timeZone : await workspaceTimeZone(companyId);
  if (!isValidTimeZone(zone)) throw new ScheduleError(`“${zone}” isn’t a timezone Aura recognises.`, 'invalid');
  let at: Date;
  let local: string;
  let note: string | null = null;
  if (input.localTime) {
    try {
      const c = zonedToUtc(input.localTime, zone);
      at = c.at;
      local = c.local;
      note = c.note;
    } catch (err) {
      if (err instanceof TimezoneError) throw new ScheduleError(err.message, 'invalid');
      throw err;
    }
  } else {
    at = new Date(input.scheduledFor!);
    local = toLocalInput(at, zone);
  }
  const valid = validateScheduleTime(at, now);
  if (!valid.ok) throw new ScheduleError(valid.message, valid.problem);
  return { at, timeZone: zone, local, note };
}
