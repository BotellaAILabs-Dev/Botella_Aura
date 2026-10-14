import crypto from 'node:crypto';

import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { missingConfig, whatsAppConfig } from '@/lib/whatsapp';
import { sweepQueue } from '@/server/whatsapp/queue';

/**
 * GET|POST /api/cron/whatsapp — the WhatsApp sweep (server/whatsapp/queue.ts):
 * messages no kick handled (a lost kick, an expired back-off, a worker that
 * died), then outgoing messages whose send retry is due. Messages whose
 * 24-hour window has closed are failed rather than sent.
 *
 * Authorised with CRON_SECRET like every cron route. GET too, because that is
 * what Vercel Cron sends. Schedule it every 1–5 minutes (Vercel Pro cron, or a
 * free external scheduler such as GitHub Actions or cron-job.org):
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/whatsapp
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) return jsonError('Unauthorized', 401);
    const config = whatsAppConfig();
    if (!config) return jsonError(`WhatsApp is not configured (missing ${missingConfig().join(', ')}).`, 503);
    return jsonOk(await sweepQueue({ config }));
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = POST;
