import { z } from 'zod';

import { requireUser } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { confirmChallenge } from '@/server/whatsapp/link.service';

/**
 * POST /api/whatsapp/link/confirm { token } — the signed-in user confirms that
 * the WhatsApp number behind a sign-in link is theirs. Returns the 6-digit
 * code to send from that number (shown once; stored only as a hash). The link
 * is single-use: a second confirm, by anyone, is refused (409).
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const user = await requireUser();
    if (!rateLimit(`whatsapp-link-confirm:${user.id}`, { limit: 10, windowMs: 10 * 60_000 }).allowed) {
      return jsonError('Too many attempts. Try again in a few minutes.', 429);
    }
    const { token } = bodySchema.parse(await req.json());
    const r = await confirmChallenge({ token, userId: user.id });
    return jsonOk({ code: r.code, last4: r.last4, expiresAt: r.expiresAt.toISOString(), waMeUrl: r.waMeUrl });
  } catch (error) {
    return handleRouteError(error);
  }
}
