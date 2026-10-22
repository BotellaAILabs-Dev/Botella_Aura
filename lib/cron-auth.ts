import crypto from 'node:crypto';

/**
 * Scheduled-job authentication: `Authorization: Bearer <CRON_SECRET>`.
 * Vercel Cron sends it automatically when CRON_SECRET is set; an external
 * scheduler sends the same header. Compared in constant time; refused when
 * CRON_SECRET is not set (a job endpoint must never be open by accident).
 */
export function isCronAuthorized(req: Request, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
