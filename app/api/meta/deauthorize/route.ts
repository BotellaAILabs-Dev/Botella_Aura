import { NextResponse } from 'next/server';

import { logger } from '@/lib/logger';
import { parseSignedRequest } from '@/lib/meta';
import { deauthorize } from '@/server/connectors/meta.service';

/**
 * POST /api/meta/deauthorize — Meta's "Deauthorize callback URL" (App
 * settings → Facebook Login → Settings). Called when someone removes Aura in
 * their Facebook settings. Unauthenticated by design — Meta's signed_request,
 * HMAC-signed with the app secret, is the authentication.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const secret = process.env.META_CLIENT_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured.' }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const signed = form?.get('signed_request');
  const data = parseSignedRequest(typeof signed === 'string' ? signed : null, secret);
  if (!data?.user_id) {
    logger.warn('meta: deauthorize with an invalid signed_request');
    return NextResponse.json({ error: 'Invalid signed_request.' }, { status: 400 });
  }
  const count = await deauthorize(String(data.user_id));
  logger.info('meta: deauthorized', { connections: count });
  return NextResponse.json({ ok: true });
}
