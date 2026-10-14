import { NextResponse } from 'next/server';

import { absoluteUrl } from '@/lib/app-url';
import { logger } from '@/lib/logger';
import { parseSignedRequest } from '@/lib/meta';
import { deleteMetaData } from '@/server/connectors/meta.service';

/**
 * POST /api/meta/data-deletion — Meta's "Data deletion request callback URL"
 * (App settings → Basic), required for App Review. Deletes the Meta
 * connection data for that Facebook user and answers, as Meta specifies,
 * with a status URL and a confirmation code. Authenticated by the
 * signed_request (HMAC with the app secret).
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const secret = process.env.META_CLIENT_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured.' }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const signed = form?.get('signed_request');
  const data = parseSignedRequest(typeof signed === 'string' ? signed : null, secret);
  if (!data?.user_id) {
    logger.warn('meta: data deletion with an invalid signed_request');
    return NextResponse.json({ error: 'Invalid signed_request.' }, { status: 400 });
  }
  const { code, deleted } = await deleteMetaData(String(data.user_id));
  logger.info('meta: data deletion processed', { deleted });
  return NextResponse.json({ url: absoluteUrl(`/meta/data-deletion?code=${code}`), confirmation_code: code });
}
